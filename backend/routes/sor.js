import express from 'express';
import { getPool } from '../db/index.js';
import { optionalNumber, optionalString } from '../utils/valueParsers.js';

const router = express.Router();

// Allowed SOR portal slugs. Single source of truth for the four sub-tabs.
const ALLOWED_PORTALS = new Set([
  'myntra-jabong',
  'zepto',
  'reliance-ajio',
  'cocoblu',
]);

function isAllowedPortal(portal) {
  return ALLOWED_PORTALS.has(portal);
}

/**
 * Build a `WHERE` clause for sor_invoice-style queries. Always pins the
 * portal so cross-portal data cannot leak between sub-tabs.
 */
function buildSorInvoiceWhere(req, portal) {
  const clauses = ['portal = $1'];
  const values = [portal];
  let n = 2;
  if (req.query.portal_account) {
    clauses.push(`portal_account = $${n++}`);
    values.push(req.query.portal_account);
  }
  if (req.query.from) {
    clauses.push(`invoice_date >= $${n++}`);
    values.push(req.query.from);
  }
  if (req.query.to) {
    clauses.push(`invoice_date <= $${n++}`);
    values.push(req.query.to);
  }
  if (req.query.invoice_no) {
    clauses.push(`invoice_no ILIKE $${n++}`);
    values.push(`%${req.query.invoice_no}%`);
  }
  return { whereSql: clauses.join(' AND '), values };
}

/**
 * GET /api/sor/:portal/outstanding
 *
 * Outstanding Ledger for the given portal. Returns one row per invoice
 * with the per-stream totals, outstanding, age (days), and variance vs
 * the invoice's declared net_payable. Reads from the `sor_outstanding`
 * view (see `ensureSorInvoiceSchema` in `backend/db/initDb.js`).
 */
router.get('/:portal/outstanding', async (req, res) => {
  try {
    const { portal } = req.params;
    if (!isAllowedPortal(portal)) {
      return res.status(404).json({ error: 'Unknown SOR portal', portal });
    }
    const pool = getPool();
    const { whereSql, values } = buildSorInvoiceWhere(req, portal);
    const { rows } = await pool.query(
      `
        SELECT
          invoice_id,
          portal,
          portal_account,
          invoice_no,
          invoice_date,
          period_from,
          period_to,
          invoice_type,
          sale_total,
          payment_total,
          return_total,
          deduction_total,
          outstanding,
          age_days,
          declared_net_payable,
          variance
        FROM sor_outstanding
        WHERE ${whereSql}
        ORDER BY invoice_date DESC NULLS LAST, invoice_no
        LIMIT 24
      `,
      values,
    );
    // Aggregated KPI summary for the page header.
    const kpiRows = await pool.query(
      `
        SELECT
          COUNT(*)                                                              AS "invoiceCount",
          COALESCE(SUM(outstanding), 0)                                        AS "totalOutstanding",
          COUNT(*) FILTER (WHERE outstanding > 0)                              AS "invoicesWithOutstanding",
          COUNT(*) FILTER (WHERE outstanding < 0)                             AS "overpaidInvoices",
          COALESCE(SUM(sale_total), 0)                                         AS "totalSale",
          COALESCE(SUM(payment_total), 0)                                      AS "totalPayment",
          COALESCE(SUM(return_total), 0)                                       AS "totalReturn",
          COALESCE(SUM(deduction_total), 0)                                    AS "totalDeduction"
        FROM sor_outstanding
        WHERE ${whereSql}
      `,
      values,
    );
    res.json({ rows, kpis: kpiRows.rows[0] });
  } catch (err) {
    console.error(`[sor] /${req.params.portal}/outstanding error:`, err.message);
    res.status(500).json({ error: 'Failed to load outstanding ledger', detail: err.message });
  }
});

/**
 * GET /api/sor/:portal/invoices
 *
 * Bare invoice header list (no outstanding math). Useful for the invoice
 * picker in the upload cards and for cross-portal admin views.
 */
router.get('/:portal/invoices', async (req, res) => {
  try {
    const { portal } = req.params;
    if (!isAllowedPortal(portal)) {
      return res.status(404).json({ error: 'Unknown SOR portal', portal });
    }
    const pool = getPool();
    const { whereSql, values } = buildSorInvoiceWhere(req, portal);
    const { rows } = await pool.query(
      `
        SELECT
          id,
          portal,
          portal_account,
          invoice_no,
          invoice_date,
          period_from,
          period_to,
          invoice_type,
          gross_amount,
          fee_amount,
          tds_amount,
          net_payable,
          uploaded_by,
          uploaded_at
        FROM sor_invoice
        WHERE ${whereSql}
        ORDER BY invoice_date DESC NULLS LAST, invoice_no
      `,
      values,
    );
    res.json({ rows });
  } catch (err) {
    console.error(`[sor] /${req.params.portal}/invoices error:`, err.message);
    res.status(500).json({ error: 'Failed to load invoices', detail: err.message });
  }
});

/**
 * GET /api/sor/:portal/invoice/:id
 *
 * Invoice header + all lines grouped by line_type. Used by the
 * drilldown drawer on every SOR sub-tab.
 */
router.get('/:portal/invoice/:id', async (req, res) => {
  try {
    const { portal, id } = req.params;
    if (!isAllowedPortal(portal)) {
      return res.status(404).json({ error: 'Unknown SOR portal', portal });
    }
    const pool = getPool();
    const invoiceId = optionalNumber(id, { min: 1 });
    if (!invoiceId) {
      return res.status(400).json({ error: 'Invalid invoice id' });
    }
    const { rows: invoiceRows } = await pool.query(
      `SELECT * FROM sor_invoice WHERE id = $1 AND portal = $2 LIMIT 1`,
      [invoiceId, portal],
    );
    if (invoiceRows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found', id: invoiceId, portal });
    }
    const { rows: lines } = await pool.query(
      `
        SELECT
          id,
          line_type,
          order_id,
          sku,
          vb_export_sku,
          quantity,
          gross_amount,
          fee_amount,
          settlement_id,
          order_row_id,
          raw_payload
        FROM sor_invoice_line
        WHERE invoice_id = $1
        ORDER BY line_type, id
      `,
      [invoiceId],
    );
    // Group lines by line_type for the drawer UI.
    const grouped = { sale: [], payment: [], return: [], deduction: [] };
    for (const ln of lines) {
      const bucket = grouped[ln.line_type];
      if (bucket) bucket.push(ln);
      else (grouped.other ||= []).push(ln);
    }
    res.json({ invoice: invoiceRows[0], lines: grouped });
  } catch (err) {
    console.error(`[sor] /${req.params.portal}/invoice/:id error:`, err.message);
    res.status(500).json({ error: 'Failed to load invoice detail', detail: err.message });
  }
});

export default router;