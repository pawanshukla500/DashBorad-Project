import express from 'express';
import { getPool } from '../db/index.js';
import { pagination, optionalQueryText } from '../utils/requestParams.js';

const router = express.Router();

// Allowed SOR portal slugs. Single source of truth for the four sub-tabs.
const ALLOWED_PORTALS = new Set([
  'myntra-jabong',
  'zepto',
  'reliance-ajio',
  'cocoblu',
]);

// Sortable ledger columns. The value is the SQL expression, so a request can
// only ever choose between these fixed identifiers.
const OUTSTANDING_SORTS = Object.freeze({
  invoice_date: 'invoice_date',
  invoice_no: 'invoice_no',
  outstanding: 'outstanding',
  age_days: 'age_days',
  variance: 'ABS(COALESCE(variance, 0))',
  sale_total: 'sale_total',
});

const LEDGER_STATUSES = new Set(['open', 'settled', 'overpaid']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isAllowedPortal(portal) {
  return ALLOWED_PORTALS.has(portal);
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function optionalIsoDate(value, label) {
  const text = optionalQueryText(value, label, { maxLength: 10 });
  if (text == null) return null;
  if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw badRequest(`${label} must be a date in YYYY-MM-DD format`);
  }
  return text;
}

// ILIKE treats % and _ as wildcards; a search for an invoice number must
// match those characters literally.
function escapeLike(text) {
  return text.replace(/[\\%_]/g, char => `\\${char}`);
}

/**
 * Build a `WHERE` clause for sor_invoice-style queries. Always pins the
 * portal so cross-portal data cannot leak between sub-tabs.
 */
function buildSorInvoiceWhere(req, portal, { withStatus = false } = {}) {
  const clauses = ['portal = $1'];
  const values = [portal];
  let n = 2;
  const portalAccount = optionalQueryText(req.query.portal_account, 'portal_account', { maxLength: 100 });
  const from = optionalIsoDate(req.query.from, 'from');
  const to = optionalIsoDate(req.query.to, 'to');
  const invoiceNo = optionalQueryText(req.query.invoice_no, 'invoice_no', { maxLength: 100 });
  if (portalAccount) {
    clauses.push(`portal_account = $${n++}`);
    values.push(portalAccount);
  }
  if (from) {
    clauses.push(`invoice_date >= $${n++}`);
    values.push(from);
  }
  if (to) {
    clauses.push(`invoice_date <= $${n++}`);
    values.push(to);
  }
  if (invoiceNo) {
    clauses.push(`invoice_no ILIKE $${n++}`);
    values.push(`%${escapeLike(invoiceNo)}%`);
  }
  if (withStatus) {
    const status = optionalQueryText(req.query.status, 'status', { maxLength: 20 });
    if (status) {
      if (!LEDGER_STATUSES.has(status)) throw badRequest('status must be open, settled or overpaid');
      clauses.push(`ledger_status = $${n++}`);
      values.push(status);
    }
  }
  return { whereSql: clauses.join(' AND '), values };
}

function sortClause(query) {
  const key = optionalQueryText(query.sort, 'sort', { maxLength: 40 }) || 'invoice_date';
  const expression = OUTSTANDING_SORTS[key];
  if (!expression) throw badRequest(`sort must be one of: ${Object.keys(OUTSTANDING_SORTS).join(', ')}`);
  const direction = String(query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `${expression} ${direction} NULLS LAST, invoice_id DESC`;
}

function sendError(res, req, err, message) {
  if (err?.status === 400) return res.status(400).json({ error: err.message });
  console.error(`[sor] ${req.method} ${req.baseUrl}${req.path} error:`, err?.message);
  return res.status(500).json({ error: message });
}

/**
 * GET /api/sor/:portal/outstanding
 *
 * Outstanding Ledger for the given portal. Returns one page of invoices
 * (`page`, `pageSize` ≤ 500) with the per-stream totals, outstanding, age
 * (days), and variance vs the invoice's declared net_payable, plus KPI
 * totals for the whole filtered set (not just the page). Reads from the
 * `sor_outstanding` view (see `ensureSorOutstandingView` in
 * `backend/db/initDb.js`).
 */
router.get('/:portal/outstanding', async (req, res) => {
  try {
    const { portal } = req.params;
    if (!isAllowedPortal(portal)) {
      return res.status(404).json({ error: 'Unknown SOR portal', portal });
    }
    const pool = getPool();
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 500 });
    const order = sortClause(req.query);
    const { whereSql, values } = buildSorInvoiceWhere(req, portal, { withStatus: true });
    const kpiFilter = buildSorInvoiceWhere(req, portal);
    const [{ rows }, kpiRows, lastUpload] = await Promise.all([
      pool.query(
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
            expected_net_payable,
            variance,
            ledger_status,
            last_activity_at,
            COUNT(*) OVER () AS total_count
          FROM sor_outstanding
          WHERE ${whereSql}
          ORDER BY ${order}
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}
        `,
        [...values, pageSize, offset],
      ),
      // KPI summary for the page header — ignores the status filter so the
      // tiles keep describing the whole portal while the table is narrowed.
      pool.query(
        `
          SELECT
            COUNT(*)::int                                                       AS "invoiceCount",
            COALESCE(SUM(outstanding), 0)                                       AS "totalOutstanding",
            COUNT(*) FILTER (WHERE ledger_status = 'open')::int                 AS "invoicesWithOutstanding",
            COUNT(*) FILTER (WHERE ledger_status = 'overpaid')::int             AS "overpaidInvoices",
            COUNT(*) FILTER (WHERE ABS(COALESCE(variance, 0)) >= 1)::int        AS "varianceInvoices",
            COALESCE(SUM(sale_total), 0)                                        AS "totalSale",
            COALESCE(SUM(payment_total), 0)                                     AS "totalPayment",
            COALESCE(SUM(return_total), 0)                                      AS "totalReturn",
            COALESCE(SUM(deduction_total), 0)                                   AS "totalDeduction",
            COALESCE(SUM(outstanding) FILTER (WHERE ledger_status = 'open' AND age_days <= 30), 0)                   AS "aging0to30",
            COALESCE(SUM(outstanding) FILTER (WHERE ledger_status = 'open' AND age_days BETWEEN 31 AND 60), 0)       AS "aging31to60",
            COALESCE(SUM(outstanding) FILTER (WHERE ledger_status = 'open' AND age_days BETWEEN 61 AND 90), 0)       AS "aging61to90",
            COALESCE(SUM(outstanding) FILTER (WHERE ledger_status = 'open' AND (age_days > 90 OR age_days IS NULL)), 0) AS "aging90plus"
          FROM sor_outstanding
          WHERE ${kpiFilter.whereSql}
        `,
        kpiFilter.values,
      ),
      // Latest ledger write for this portal: a direct SOR upload
      // (sor_upload_log) or a mirrored invoice (sor_invoice.uploaded_at).
      pool.query(
        `
          SELECT GREATEST(
            (SELECT MAX(uploaded_at) FROM sor_invoice    WHERE portal = $1),
            (SELECT MAX(uploaded_at) FROM sor_upload_log WHERE portal = $1)
          ) AS "lastUploadAt"
        `,
        [portal],
      ),
    ]);
    const total = rows.length ? Number(rows[0].total_count) : 0;
    res.json({
      rows: rows.map(({ total_count: _totalCount, ...row }) => row),
      page,
      pageSize,
      total,
      kpis: { ...kpiRows.rows[0], lastUploadAt: lastUpload.rows[0]?.lastUploadAt || null },
    });
  } catch (err) {
    sendError(res, req, err, 'Failed to load outstanding ledger');
  }
});

/**
 * GET /api/sor/:portal/invoices
 *
 * Bare invoice header list (no outstanding math), paginated. Useful for the
 * invoice picker in the upload cards and for cross-portal admin views.
 */
router.get('/:portal/invoices', async (req, res) => {
  try {
    const { portal } = req.params;
    if (!isAllowedPortal(portal)) {
      return res.status(404).json({ error: 'Unknown SOR portal', portal });
    }
    const pool = getPool();
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 500 });
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
          uploaded_at,
          COUNT(*) OVER () AS total_count
        FROM sor_invoice
        WHERE ${whereSql}
        ORDER BY invoice_date DESC NULLS LAST, invoice_no
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `,
      [...values, pageSize, offset],
    );
    const total = rows.length ? Number(rows[0].total_count) : 0;
    res.json({ rows: rows.map(({ total_count: _totalCount, ...row }) => row), page, pageSize, total });
  } catch (err) {
    sendError(res, req, err, 'Failed to load invoices');
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
    if (!/^\d{1,18}$/.test(id) || Number(id) < 1) {
      return res.status(400).json({ error: 'Invalid invoice id' });
    }
    const pool = getPool();
    const { rows: invoiceRows } = await pool.query(
      `SELECT * FROM sor_outstanding WHERE invoice_id = $1 AND portal = $2 LIMIT 1`,
      [id, portal],
    );
    if (invoiceRows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found', id: Number(id), portal });
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
          source,
          raw_payload
        FROM sor_invoice_line
        WHERE invoice_id = $1
        ORDER BY line_type, id
      `,
      [id],
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
    sendError(res, req, err, 'Failed to load invoice detail');
  }
});

export default router;
