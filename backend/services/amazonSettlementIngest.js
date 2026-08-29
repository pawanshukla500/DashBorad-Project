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

function buildInsertBatch(rows) {
  const values = [];
  const groups = rows.map(row => {
    const start = values.length;
    for (const field of SETTLEMENT_LINE_FIELDS) values.push(row[field] ?? null);
    return `(${SETTLEMENT_LINE_FIELDS.map((_, column) => `$${start + column + 1}`).join(',')})`;
  });
  return { values, groups };
}

export async function replaceAmazonSettlement({
  pool,
  settlementId,
  envelope,
  filename,
  lines,
  batchSize = UPLOAD_BATCH_SIZE,
}) {
  const affectedOrderIds = new Set(lines.map(line => line.order_id).filter(Boolean));
  const client = await pool.connect();
  let linesInserted = 0;
  let replacedLines = 0;

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

    // The envelope row acts as the per-settlement mutex for concurrent imports.
    await client.query(
      'SELECT settlement_id FROM amazon_settlements WHERE settlement_id = $1 FOR UPDATE',
      [settlementId],
    );
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

    const brandedLines = lines.map(line => ({ ...line, brand_name: AMAZON_BRAND }));
    await forEachDbBatch(brandedLines, SETTLEMENT_LINE_FIELDS.length, async batch => {
      const { values, groups } = buildInsertBatch(batch);
      const inserted = await client.query(
        `INSERT INTO amazon_settlement_lines (${SETTLEMENT_LINE_FIELDS.join(',')}) VALUES ${groups.join(',')}`,
        values,
      );
      linesInserted += inserted.rowCount;
    }, { preferredSize: batchSize });

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
      affectedOrderIds: [...affectedOrderIds],
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
