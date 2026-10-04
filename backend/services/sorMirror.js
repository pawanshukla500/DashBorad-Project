import { forEachDbBatch } from '../utils/dbBatch.js';

/**
 * SOR Level Payment Reconciliation — AJIO invoice mirror.
 *
 * After a successful `mp_invoices` upsert for `marketplace='ajio'`,
 * mirror the parsed rows into `sor_invoice` + `sor_invoice_line` so
 * the SOR sub-tab for Reliance Retail Ltd (AJIO) lights up without
 * a separate upload route.
 *
 * Idempotency:
 * - sor_invoice has UNIQUE (portal, portal_account, invoice_no, invoice_type)
 *   so re-imports upsert by header key.
 * - sor_invoice_line has no UNIQUE; we replace all lines for the
 *   invoice in a single transaction (DELETE then INSERT) so the line
 *   table mirrors the latest mp_invoices state for that invoice.
 *
 * Transaction safety:
 * - We use `pool.connect()` (NOT bare `pool.query`) to acquire a
 *   single client, then issue BEGIN / INSERT / DELETE / INSERT /
 *   COMMIT on that same connection. Bare `pool.query` can route
 *   each statement to a different connection from the pool, which
 *   would silently break the BEGIN/COMMIT pair.
 *
 * Line breakdown per AJIO row:
 *   line_type = 'sale'        gross_amount = invoice_amount,
 *                                       sku, quantity, fee_amount = 0
 *   line_type = 'deduction'   gross_amount = commission_amount
 *                                       (one row, fee_type='commission')
 *   line_type = 'deduction'   gross_amount = other_deductions
 *                                       (one row, fee_type='other_deductions')
 *   line_type = 'deduction'   gross_amount = tds_amount
 *                                       (one row, fee_type='tds')
 *
 * Note: deduction lines are emitted for ANY non-zero value (not just
 * positive). AJIO reverses can produce negative commission / TDS
 * values that still need to be tracked in the SOR ledger so the
 * per-invoice outstanding reflects the reversal.
 *
 * Aggregates commission / other_deductions / tds across all rows
 * of the same invoice into a single header-level sor_invoice record.
 *
 * Errors are swallowed (logged via console.warn) so a mirror
 * failure cannot block the upstream AJIO upload.
 */

const SOR_PORTAL = 'reliance-ajio';
const SOR_INVOICE_TYPE = 'sale';

/**
 * Mirror an array of parsed AJIO mp_invoices rows into sor_invoice + sor_invoice_line.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} pool
 * @param {Array<{ invoice_no: string, invoice_date: string, seller_account: string,
 *                 sku: string, quantity: number|null,
 *                 invoice_amount: number|null, commission: number|null,
 *                 tds: number|null, other_deductions: number|null,
 *                 net_payable: number|null, order_item_id: string|null,
 *                 source_fingerprint: string|null,
 *                 raw: object }>} rows
 *   Parsed AJIO mp_invoices rows. Must already be validated by
 *   `parseInvoiceUploadRow()`.
 * @returns {Promise<{ mirrored: number, errors: string[] }>}
 */
export async function mirrorAjioInvoicesToSor(pool, rows) {
  const errors = [];
  if (!rows || rows.length === 0) return { mirrored: 0, errors };

  // 0. Filter out rows that lack the keys we need to aggregate on.
  // The upstream `parseInvoiceUploadRow` already rejects these at the
  // route layer, but a defensive filter here keeps the mirror robust
  // when invoked directly from a future job / migration path.
  const validRows = (rows || []).filter(
    r => r && r.invoice_no && String(r.invoice_no).trim() !== ''
      && r.seller_account && String(r.seller_account).trim() !== '',
  );
  if (validRows.length === 0) return { mirrored: 0, errors };

  // 1. Aggregate per-invoice totals from the parsed mp_invoices rows.
  const byInvoiceNo = new Map();
  for (const row of validRows) {
    const key = `${row.seller_account}::${row.invoice_no}`;
    if (!byInvoiceNo.has(key)) {
      byInvoiceNo.set(key, {
        portal: SOR_PORTAL,
        portal_account: row.seller_account || 'default',
        invoice_no: row.invoice_no,
        invoice_date: row.invoice_date,
        period_from: null,
        period_to: null,
        invoice_type: SOR_INVOICE_TYPE,
        gross_amount: 0,
        fee_amount: 0,
        tds_amount: 0,
        net_payable: 0,
        raw_payload: {
          source: 'mp_invoices',
          marketplace: 'ajio',
          seller_account: row.seller_account,
          invoice_no: row.invoice_no,
        },
        lines: [],
      });
    }
    const agg = byInvoiceNo.get(key);
    agg.gross_amount += toNum(row.invoice_amount);
    agg.fee_amount   += toNum(row.commission) + toNum(row.other_deductions);
    agg.tds_amount   += toNum(row.tds);
    // Per-line breakdown — one sale line per SKU + three deduction lines.
    agg.lines.push({
      line_type: 'sale',
      order_id: row.order_item_id || null,
      sku: row.sku || null,
      quantity: row.quantity ?? null,
      gross_amount: toNum(row.invoice_amount),
      fee_amount: 0,
      order_row_id: null, // resolved lazily by a follow-up query
      raw_payload: { source: 'mp_invoices', row },
    });
    if (toNum(row.commission) !== 0) {
      agg.lines.push({
        line_type: 'deduction',
        sku: null,
        gross_amount: toNum(row.commission),
        fee_amount: 0,
        raw_payload: { source: 'mp_invoices', fee_type: 'commission', row },
      });
    }
    if (toNum(row.other_deductions) !== 0) {
      agg.lines.push({
        line_type: 'deduction',
        sku: null,
        gross_amount: toNum(row.other_deductions),
        fee_amount: 0,
        raw_payload: { source: 'mp_invoices', fee_type: 'other_deductions', row },
      });
    }
    if (toNum(row.tds) !== 0) {
      agg.lines.push({
        line_type: 'deduction',
        sku: null,
        gross_amount: toNum(row.tds),
        fee_amount: 0,
        raw_payload: { source: 'mp_invoices', fee_type: 'tds', row },
      });
    }
  }

  // 2. Resolve order_row_id by joining on order_item_id.
  try {
    const orderItemIds = [
      ...new Set(
        rows
          .map(r => r.order_item_id)
          .filter(Boolean),
      ),
    ];
    if (orderItemIds.length > 0) {
      const { rows: orderRows } = await pool.query(
        `SELECT id, order_item_id FROM orders WHERE order_item_id = ANY($1::text[])`,
        [orderItemIds],
      );
      const orderIdMap = new Map(orderRows.map(r => [r.order_item_id, r.id]));
      for (const agg of byInvoiceNo.values()) {
        for (const line of agg.lines) {
          if (line.line_type === 'sale' && line.order_id) {
            line.order_row_id = orderIdMap.get(line.order_id) || null;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[sorMirror] order_row_id resolution failed (non-fatal):', err.message);
  }

  // 3. Upsert sor_invoice headers + replace line rows for each invoice.
  // Acquire a dedicated client so BEGIN/COMMIT stay on one connection —
  // bare pool.query routes each statement to a different connection from
  // the pool, which would silently break the transaction.
  let mirrored = 0;
  for (const agg of byInvoiceNo.values()) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: insertedHeaderRows } = await client.query(
        `
          INSERT INTO sor_invoice (
            portal, portal_account, invoice_no, invoice_date,
            period_from, period_to, invoice_type,
            gross_amount, fee_amount, tds_amount, net_payable,
            raw_payload
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
          ON CONFLICT (portal, portal_account, invoice_no, invoice_type)
          DO UPDATE SET
            invoice_date = EXCLUDED.invoice_date,
            gross_amount = EXCLUDED.gross_amount,
            fee_amount   = EXCLUDED.fee_amount,
            tds_amount   = EXCLUDED.tds_amount,
            net_payable  = EXCLUDED.net_payable,
            raw_payload  = EXCLUDED.raw_payload,
            uploaded_at  = NOW()
          RETURNING id
        `,
        [
          agg.portal, agg.portal_account, agg.invoice_no, agg.invoice_date,
          agg.period_from, agg.period_to, agg.invoice_type,
          agg.gross_amount, agg.fee_amount, agg.tds_amount, agg.gross_amount - agg.fee_amount - agg.tds_amount,
          JSON.stringify(agg.raw_payload),
        ],
      );
      const headerId = insertedHeaderRows[0]?.id;
      if (!headerId) {
        await client.query('ROLLBACK');
        errors.push(`sor_invoice upsert returned no id for ${agg.invoice_no}`);
        continue;
      }
      // Replace all existing lines for this invoice.
      await client.query(`DELETE FROM sor_invoice_line WHERE invoice_id = $1`, [headerId]);
      // Insert lines in batches.
      await forEachDbBatch(agg.lines, 9, async (batch) => {
        const values = [];
        const groups = batch.map(line => {
          const start = values.length;
          values.push(
            headerId,
            line.line_type,
            line.order_id,
            line.sku,
            null, // vb_export_sku — populated by a separate pass
            line.quantity,
            line.gross_amount,
            line.fee_amount,
            null, // settlement_id
            line.order_row_id,
            JSON.stringify(line.raw_payload),
          );
          return `($${start+1},$${start+2},$${start+3},$${start+4},$${start+5},$${start+6},$${start+7},$${start+8},$${start+9},$${start+10},$${start+11}::jsonb)`;
        });
        await client.query(
          `INSERT INTO sor_invoice_line (
             invoice_id, line_type, order_id, sku, vb_export_sku,
             quantity, gross_amount, fee_amount, settlement_id, order_row_id,
             raw_payload
           ) VALUES ${groups.join(',')}`,
          values,
        );
      });
      await client.query('COMMIT');
      mirrored++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      errors.push(`sor_invoice upsert failed for ${agg.invoice_no}: ${err.message}`);
      console.warn(`[sorMirror] ${err.message}`);
    } finally {
      // Release the client back to the pool in all paths.
      client.release();
    }
  }

  return { mirrored, errors };
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}