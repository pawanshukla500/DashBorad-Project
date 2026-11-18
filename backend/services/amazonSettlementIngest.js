import { forEachDbBatch, UPLOAD_BATCH_SIZE } from '../utils/dbBatch.js';
import { AMAZON_BRAND, refreshAmazonSettlementRollups } from './amazonSettlementRollups.js';
import { refreshAmazonSettlementReportingRollups } from './amazonSettlementReportingRollups.js';
import { invalidateAmazonReconciliationCache } from './amazonReconciliationCache.js';

const SETTLEMENT_LINE_FIELDS = Object.freeze([
  'settlement_id',
  'posted_date',
  'posted_at',
  'transaction_type',
  'amount_type',
  'amount_description',
  'amount',
  'order_id',
  'merchant_order_id',
  'shipment_id',
  'adjustment_id',
  'order_item_code',
  'merchant_order_item_id',
  'sku',
  'quantity',
  'fulfillment_id',
  'promotion_id',
  'marketplace_name',
  'currency',
  'marketplace',
  'brand_name',
]);

// Every stored line carries the Amazon brand. It is set here, while the batch
// is built, instead of copying every parsed line ({ ...line, brand_name }),
// which held a second full copy of a large settlement in memory.
function buildInsertBatch(rows) {
  const values = [];
  const groups = rows.map(row => {
    const start = values.length;
    for (const field of SETTLEMENT_LINE_FIELDS) {
      values.push(field === 'brand_name' ? AMAZON_BRAND : (row[field] ?? null));
    }
    return `(${SETTLEMENT_LINE_FIELDS.map((_, column) => `$${start + column + 1}`).join(',')})`;
  });
  return { values, groups };
}

// Taken before any settlement write; never while holding the totals lock.
export const AMAZON_SETTLEMENT_INGEST_LOCK_KEY = 7_140_231_120;

const CONTINUATION_TABLE = 'amazon_settlement_lines_incoming';
// A line's identity for continuation replays, as one equality-comparable key:
// ROW(...)::text tells NULL from '' and is identical for identical lines, so the
// dedupe is a hash join on the key instead of comparing every column of every
// stored line with every incoming line. Fee-refund rows are keyed without
// sku / order_item_code: the orphan resolver fills those in after insert, and a
// replay of the same file (blank SKU) must still match its resolved copy.
const RESOLVED_LATER = new Set(['sku', 'order_item_code']);
const lineKeySql = alias => `md5(ROW(${SETTLEMENT_LINE_FIELDS.map(field => (RESOLVED_LATER.has(field)
  ? `CASE WHEN ${alias}.transaction_type = 'Fulfillment Fee Refund' THEN NULL ELSE ${alias}.${field} END`
  : `${alias}.${field}`)).join(', ')})::text)`;

// Remove, per distinct incoming line, at most as many identical stored copies
// as the continuation file holds.
export const CONTINUATION_DEDUPE_SQL = `
  WITH incoming AS (
    SELECT ${lineKeySql('n')} AS line_key, COUNT(*) AS copies
    FROM ${CONTINUATION_TABLE} n
    GROUP BY 1
  ),
  stored AS (
    SELECT s.id, ROW_NUMBER() OVER (PARTITION BY ${lineKeySql('s')} ORDER BY s.id) AS copy_no,
           ${lineKeySql('s')} AS line_key
    FROM amazon_settlement_lines s
    WHERE s.settlement_id = $1
  )
  DELETE FROM amazon_settlement_lines target
  USING stored s
  JOIN incoming i ON i.line_key = s.line_key
  WHERE target.id = s.id AND s.copy_no <= i.copies
`;

/**
 * Atomically replace one settlement's lines and rebuild its read models.
 * `beforeRollups(client)` runs inside the transaction after the new lines are
 * written and before the rollups are built (the upload job resolves orphan
 * refund SKUs there), so both rollups are built once from final data.
 * `appendOnly` keeps the settlement's existing lines: used when one workbook
 * carries the same settlement on several sheets, so a later sheet does not
 * delete the lines an earlier sheet of the same upload just wrote.
 *
 * A file without the settlement's envelope row (settlement-id + total-amount)
 * for a settlement that already has stored lines is a continuation part: an
 * oversized export split into several files. It used to replace the
 * settlement, so file B deleted everything file A wrote. It now appends; to
 * keep re-uploads idempotent it first removes, for each distinct line, at most
 * as many identical stored copies as the file itself contains (re-uploading
 * part B replaces part B's lines and leaves part A's alone). A file WITH the
 * envelope is the complete settlement and still replaces it.
 */
export async function replaceAmazonSettlement({
  pool,
  settlementId,
  envelope,
  filename,
  lines,
  batchSize = UPLOAD_BATCH_SIZE,
  beforeRollups = null,
  appendOnly = false,
}) {
  const affectedOrderIds = new Set(lines.map(line => line.order_id).filter(Boolean));
  const client = await pool.connect();
  let linesInserted = 0;
  let replacedLines = 0;
  let continuation = false;

  try {
    await client.query('BEGIN');

    if (envelope) {
      await client.query(`
        INSERT INTO amazon_settlements (
          settlement_id, settlement_start_date, settlement_end_date,
          deposit_date, total_amount, currency, filename, marketplace
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'amazon')
        ON CONFLICT (settlement_id) DO UPDATE SET
          settlement_start_date = COALESCE(EXCLUDED.settlement_start_date, amazon_settlements.settlement_start_date),
          settlement_end_date   = COALESCE(EXCLUDED.settlement_end_date, amazon_settlements.settlement_end_date),
          deposit_date          = COALESCE(EXCLUDED.deposit_date, amazon_settlements.deposit_date),
          total_amount          = COALESCE(EXCLUDED.total_amount, amazon_settlements.total_amount),
          currency              = EXCLUDED.currency,
          filename              = EXCLUDED.filename,
          uploaded_at           = NOW()
      `, [
        envelope.sid,
        envelope.startDt,
        envelope.endDt,
        envelope.depDt,
        envelope.totalAmt,
        'INR',
        filename,
      ]);
    } else {
      await client.query(`
        INSERT INTO amazon_settlements (settlement_id, currency, filename, marketplace)
        VALUES ($1, 'INR', $2, 'amazon')
        ON CONFLICT (settlement_id) DO UPDATE SET
          filename = EXCLUDED.filename,
          uploaded_at = NOW()
      `, [settlementId, filename]);
    }

    // Amazon settlement ingests are serialized: the orphan-refund resolver now
    // reads and updates lines of other settlements for the same orders, so two
    // overlapping imports could deadlock, or each miss the other's uncommitted
    // charge/refund and leave a refund unresolved for good. With this lock the
    // later import resolves against the earlier one's committed lines.
    await client.query('SELECT pg_advisory_xact_lock($1)', [AMAZON_SETTLEMENT_INGEST_LOCK_KEY]);
    // The envelope row acts as the per-settlement mutex for concurrent imports.
    await client.query(
      'SELECT settlement_id FROM amazon_settlements WHERE settlement_id = $1 FOR UPDATE',
      [settlementId],
    );
    if (!appendOnly && !envelope) {
      const stored = await client.query(
        'SELECT EXISTS (SELECT 1 FROM amazon_settlement_lines WHERE settlement_id = $1) AS has_lines',
        [settlementId],
      );
      continuation = Boolean(stored.rows[0]?.has_lines);
    }

    if (!appendOnly && !continuation) {
      const oldOrders = await client.query(`
        SELECT DISTINCT order_id
        FROM amazon_settlement_lines
        WHERE settlement_id = $1 AND order_id IS NOT NULL
      `, [settlementId]);
      oldOrders.rows.forEach(row => affectedOrderIds.add(row.order_id));

      const deleted = await client.query(
        'DELETE FROM amazon_settlement_lines WHERE settlement_id = $1',
        [settlementId],
      );
      replacedLines = deleted.rowCount;
    }

    const target = continuation ? CONTINUATION_TABLE : 'amazon_settlement_lines';
    if (continuation) {
      await client.query(`DROP TABLE IF EXISTS pg_temp.${CONTINUATION_TABLE}`);
      await client.query(`
        CREATE TEMP TABLE ${CONTINUATION_TABLE} ON COMMIT DROP AS
        SELECT ${SETTLEMENT_LINE_FIELDS.join(', ')} FROM amazon_settlement_lines WITH NO DATA
      `);
    }
    await forEachDbBatch(lines, SETTLEMENT_LINE_FIELDS.length, async batch => {
      const { values, groups } = buildInsertBatch(batch);
      const inserted = await client.query(
        `INSERT INTO ${target} (${SETTLEMENT_LINE_FIELDS.join(',')}) VALUES ${groups.join(',')}`,
        values,
      );
      linesInserted += inserted.rowCount;
    }, { preferredSize: batchSize });

    if (continuation) {
      const removed = await client.query(CONTINUATION_DEDUPE_SQL, [settlementId]);
      replacedLines = removed.rowCount;
      const appended = await client.query(`
        INSERT INTO amazon_settlement_lines (${SETTLEMENT_LINE_FIELDS.join(', ')})
        SELECT ${SETTLEMENT_LINE_FIELDS.join(', ')} FROM ${CONTINUATION_TABLE}
      `);
      linesInserted = appended.rowCount;
    }

    const beforeRollupsResult = typeof beforeRollups === 'function'
      ? await beforeRollups(client)
      : null;

    // beforeRollups may also fix lines of other settlements (orphan refund
    // SKUs of the same orders); rebuild their read models in this transaction,
    // and backfill every order whose refund SKU changed.
    (beforeRollupsResult?.orderIds || []).forEach(orderId => affectedOrderIds.add(orderId));
    const relatedSettlementIds = [...new Set(beforeRollupsResult?.settlementIds || [])]
      .filter(id => id && id !== settlementId);
    for (const relatedId of relatedSettlementIds) {
      await refreshAmazonSettlementRollups(client, relatedId);
      await refreshAmazonSettlementReportingRollups(client, relatedId);
    }

    // Rebuild only this settlement's compact read model while the replacement
    // transaction is still open, so reports never see mismatched line/rollup data.
    await refreshAmazonSettlementRollups(client, settlementId);
    await refreshAmazonSettlementReportingRollups(client, settlementId);

    await client.query('COMMIT');
    invalidateAmazonReconciliationCache();
    return {
      envelopeInserted: 1,
      linesInserted,
      replacedLines,
      continuation,
      affectedOrderIds: [...affectedOrderIds],
      beforeRollupsResult,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
