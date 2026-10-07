import express from 'express';
import { createRequire } from 'node:module';
import { getPool } from '../db/index.js';
import { pagination, optionalQueryText } from '../utils/requestParams.js';

const XLSX = createRequire(import.meta.url)('xlsx');
const router = express.Router();

const PORTAL_NAMES = Object.freeze({
  'myntra-jabong': 'Myntra Jabong India Private Limited',
  zepto: 'Zepto Limited',
  'reliance-ajio': 'Reliance Retail Ltd (AJIO)',
  cocoblu: 'Cocoblu Retails',
});
const MAX_REPORT_ENTRIES = 100_000;

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
            -- Future-dated invoices (negative age) are current and belong here;
            -- undated invoices (NULL age) go to 90+ only.
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

/**
 * Ledger entries for a portal: one entry per document (an invoice's sale
 * lines, one payment, one return note, one deduction), debit = sale,
 * credit = payment / return / deduction, with a running balance over the
 * whole ledger so a date-filtered page still shows the true balance.
 */
function statementQuery(req, portal) {
  const values = [portal];
  const accountFilter = optionalQueryText(req.query.portal_account, 'portal_account', { maxLength: 100 });
  let accountSql = '';
  if (accountFilter) {
    values.push(accountFilter);
    accountSql = `AND i.portal_account = $${values.length}`;
  }
  const from = optionalIsoDate(req.query.from, 'from');
  const to = optionalIsoDate(req.query.to, 'to');
  values.push(from, to);
  const fromParam = `$${values.length - 1}::date`;
  const toParam = `$${values.length}::date`;
  const cte = `
    WITH entries AS (
      SELECT
        COALESCE(l.line_date, i.invoice_date)                                              AS entry_date,
        l.line_type,
        i.invoice_no,
        i.portal_account,
        COALESCE(l.reference_no, CASE WHEN l.line_type = 'sale' THEN i.invoice_no END)     AS reference_no,
        COALESCE(l.description, l.raw_payload->>'fee_type', INITCAP(l.line_type))         AS description,
        SUM(CASE WHEN l.line_type = 'sale' THEN l.gross_amount ELSE 0 END)                 AS debit,
        SUM(CASE WHEN l.line_type <> 'sale' THEN l.gross_amount ELSE 0 END)                AS credit,
        MIN(l.id)                                                                          AS first_line_id
      FROM sor_invoice_line l
      JOIN sor_invoice i ON i.id = l.invoice_id
      WHERE i.portal = $1 ${accountSql}
      GROUP BY 1, 2, 3, 4, 5, 6
    ),
    ordered AS (
      SELECT e.*,
             SUM(e.debit - e.credit) OVER w AS balance,
             ROW_NUMBER() OVER w            AS seq
      FROM entries e
      WINDOW w AS (
        ORDER BY e.entry_date NULLS FIRST,
                 CASE e.line_type WHEN 'sale' THEN 0 WHEN 'return' THEN 1 WHEN 'deduction' THEN 2 ELSE 3 END,
                 e.first_line_id
        ROWS UNBOUNDED PRECEDING
      )
    )`;
  // Undated entries sort first in the running balance, so whenever a date
  // filter is set they belong to the opening balance — never to the range —
  // and the closing balance equals the last entry's running balance.
  const filtered = `(${fromParam} IS NOT NULL OR ${toParam} IS NOT NULL)`;
  const inRange = `(${fromParam} IS NULL OR entry_date >= ${fromParam}) AND (${toParam} IS NULL OR entry_date <= ${toParam})
    AND (entry_date IS NOT NULL OR NOT ${filtered})`;
  const beforeRange = `((${fromParam} IS NOT NULL AND entry_date < ${fromParam}) OR (entry_date IS NULL AND ${filtered}))`;
  return { cte, values, inRange, beforeRange, from, to, account: accountFilter };
}

// Statement entries, totals and the outstanding sheet are read from one
// snapshot, so an upload landing in between cannot make them disagree.
async function withReadSnapshot(pool, read) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await read(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function statementTotals(db, query) {
  const { rows } = await db.query(
    `${query.cte}
     SELECT
       COALESCE(SUM(debit - credit) FILTER (WHERE ${query.beforeRange}), 0)                      AS opening_balance,
       COALESCE(SUM(debit)  FILTER (WHERE ${query.inRange}), 0)                                  AS debits,
       COALESCE(SUM(credit) FILTER (WHERE ${query.inRange}), 0)                                  AS credits,
       COALESCE(SUM(credit) FILTER (WHERE ${query.inRange} AND line_type = 'payment'), 0)        AS payments,
       COALESCE(SUM(credit) FILTER (WHERE ${query.inRange} AND line_type = 'return'), 0)         AS returns,
       COALESCE(SUM(credit) FILTER (WHERE ${query.inRange} AND line_type = 'deduction'), 0)      AS deductions,
       COUNT(*) FILTER (WHERE ${query.inRange})::int                                             AS entries
     FROM ordered`,
    query.values,
  );
  const totals = rows[0];
  const closing = Number(totals.opening_balance) + Number(totals.debits) - Number(totals.credits);
  return { ...totals, closing_balance: closing.toFixed(2) };
}

/**
 * GET /api/sor/:portal/statement — paginated ledger statement with opening
 * balance, running balance and closing balance for the date range.
 */
router.get('/:portal/statement', async (req, res) => {
  try {
    const { portal } = req.params;
    if (!isAllowedPortal(portal)) return res.status(404).json({ error: 'Unknown SOR portal', portal });
    const pool = getPool();
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 500 });
    const query = statementQuery(req, portal);
    const { entries, totals } = await withReadSnapshot(pool, async client => ({
      entries: await client.query(
        `${query.cte}
         SELECT seq, entry_date, line_type, invoice_no, portal_account, reference_no, description,
                debit, credit, balance
         FROM ordered
         WHERE ${query.inRange}
         ORDER BY seq
         LIMIT $${query.values.length + 1} OFFSET $${query.values.length + 2}`,
        [...query.values, pageSize, offset],
      ),
      totals: await statementTotals(client, query),
    }));
    res.json({ rows: entries.rows, page, pageSize, total: totals.entries, totals });
  } catch (err) {
    sendError(res, req, err, 'Failed to load ledger statement');
  }
});

/**
 * GET /api/sor/:portal/ledger-report — XLSX ledger report: summary, the
 * dated statement with running balance, and outstanding per invoice.
 */
router.get('/:portal/ledger-report', async (req, res) => {
  try {
    const { portal } = req.params;
    if (!isAllowedPortal(portal)) return res.status(404).json({ error: 'Unknown SOR portal', portal });
    const pool = getPool();
    const query = statementQuery(req, portal);
    const outstandingFilter = buildSorInvoiceWhere(req, portal);
    const { totals, entries, outstanding } = await withReadSnapshot(pool, async client => {
      const snapshotTotals = await statementTotals(client, query);
      if (snapshotTotals.entries > MAX_REPORT_ENTRIES) {
        throw badRequest(`The report would have ${snapshotTotals.entries} entries; narrow the date range to ${MAX_REPORT_ENTRIES} or fewer.`);
      }
      return {
        totals: snapshotTotals,
        entries: await client.query(
          `${query.cte}
           SELECT entry_date, line_type, invoice_no, portal_account, reference_no, description, debit, credit, balance
           FROM ordered WHERE ${query.inRange} ORDER BY seq`,
          query.values,
        ),
        outstanding: await client.query(
          `SELECT invoice_no, portal_account, invoice_date, sale_total, payment_total, return_total, deduction_total,
                  outstanding, age_days, declared_net_payable, variance, ledger_status
           FROM sor_outstanding WHERE ${outstandingFilter.whereSql}
           ORDER BY invoice_date NULLS LAST, invoice_no`,
          outstandingFilter.values,
        ),
      };
    });

    const money = value => (value === null || value === undefined ? null : Math.round(Number(value) * 100) / 100);
    // Without an end date the report runs to the latest entry, which can be
    // a future-dated invoice — not "today".
    const period = `${query.from || 'Beginning'} to ${query.to || 'latest entry'}`;
    const typeLabel = { sale: 'Invoice', payment: 'Payment', return: 'Return', deduction: 'Deduction' };
    const open = outstanding.rows.filter(row => row.ledger_status === 'open');
    const overdue = open.filter(row => Number(row.age_days) > 60);

    const workbook = XLSX.utils.book_new();
    const summary = XLSX.utils.aoa_to_sheet([
      ['SOR ledger report'],
      ['Portal', PORTAL_NAMES[portal]],
      ['Account', query.account || 'All accounts'],
      ['Period', period],
      ['Generated', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
      [],
      ['Opening balance', money(totals.opening_balance)],
      ['Invoiced (debit)', money(totals.debits)],
      ['Payments received', money(totals.payments)],
      ['Returns', money(totals.returns)],
      ['Deductions', money(totals.deductions)],
      ['Closing balance', money(totals.closing_balance)],
      [],
      ['Invoices with outstanding', open.length],
      ['Outstanding on those invoices', money(open.reduce((sum, row) => sum + Number(row.outstanding), 0))],
      ['Overdue > 60 days', money(overdue.reduce((sum, row) => sum + Number(row.outstanding), 0))],
    ]);
    summary['!cols'] = [{ wch: 30 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(workbook, summary, 'Summary');

    const ledger = XLSX.utils.aoa_to_sheet([
      ['Date', 'Type', 'Invoice No', 'Account', 'Reference', 'Description', 'Debit', 'Credit', 'Balance'],
      [query.from || '', 'Opening balance', '', '', '', '', null, null, money(totals.opening_balance)],
      ...entries.rows.map(row => [
        row.entry_date || '', typeLabel[row.line_type] || row.line_type, row.invoice_no, row.portal_account,
        row.reference_no || '', row.description || '',
        Number(row.debit) ? money(row.debit) : null, Number(row.credit) ? money(row.credit) : null, money(row.balance),
      ]),
      [query.to || '', 'Closing balance', '', '', '', '', money(totals.debits), money(totals.credits), money(totals.closing_balance)],
    ]);
    ledger['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 22 }, { wch: 14 }, { wch: 22 }, { wch: 26 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(workbook, ledger, 'Ledger');

    const byInvoice = XLSX.utils.aoa_to_sheet([
      ['Invoice No', 'Account', 'Invoice Date', 'Sale', 'Payment', 'Return', 'Deduction', 'Outstanding', 'Age (days)', 'Declared net payable', 'Variance', 'Status'],
      ...outstanding.rows.map(row => [
        row.invoice_no, row.portal_account, row.invoice_date || '', money(row.sale_total), money(row.payment_total),
        money(row.return_total), money(row.deduction_total), money(row.outstanding), row.age_days ?? '',
        money(row.declared_net_payable), money(row.variance), row.ledger_status,
      ]),
    ]);
    byInvoice['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 12 }, ...Array(9).fill({ wch: 14 })];
    XLSX.utils.book_append_sheet(workbook, byInvoice, 'Outstanding by invoice');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const stamp = [query.from, query.to].filter(Boolean).join('_to_') || 'all';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="SOR_ledger_${portal}_${stamp}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    sendError(res, req, err, 'Failed to build the ledger report');
  }
});

export default router;
