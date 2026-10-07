import { forEachDbBatch } from '../utils/dbBatch.js';

/**
 * SOR Level Payment Reconciliation — AJIO invoice mirror.
 *
 * The SOR ledger for Reliance Retail Ltd (AJIO) is a derived read model of
 * the persisted `mp_invoices` rows for `marketplace = 'ajio'`. Every sync
 * re-reads the stored rows for the affected invoices, so the ledger always
 * reflects the full database state for an invoice — not just the rows of the
 * file that triggered the sync — and a historical backfill is the same code
 * path with no key filter.
 *
 * Line breakdown per stored AJIO row:
 *   'sale'       gross_amount = invoice_amount        (forward rows)
 *   'return'     gross_amount = |invoice_amount|      (reverse rows: negative
 *                                                      amount, a Return ID, or
 *                                                      order_type reverse/return;
 *                                                      a positive-amount reverse
 *                                                      row has every money field
 *                                                      sign-flipped)
 *   'deduction'  gross_amount = commission_amount     fee_type 'commission'
 *   'deduction'  gross_amount = other_deductions      fee_type 'other_deductions'
 *   'deduction'  gross_amount = tcs_amount            fee_type 'tcs'
 *   'deduction'  gross_amount = tds_amount            fee_type 'tds'
 *   'payment'    gross_amount = amount_received       (with payment date / ref)
 * Deduction and payment lines are emitted for any non-zero value, negative
 * reversals included, so the ledger nets them the same way the header does.
 *
 * Header: gross / fee / tds are sums of the stored rows; `net_payable` is the
 * net AJIO itself declared (sum of `mp_invoices.net_payable`), which lets the
 * `sor_outstanding` variance flag rows where AJIO's net disagrees with the
 * components.
 *
 * Ownership: every line written here carries `source = 'mp_invoices:ajio'`.
 * A sync replaces only those lines, so payment / return / deduction lines
 * from other SOR upload streams on the same invoice are never touched. An
 * invoice whose AJIO rows were all deleted loses its mirror-owned lines, and
 * its header is dropped once no lines from any source remain.
 *
 * Transactions: one dedicated client for the whole sync and one
 * BEGIN/COMMIT per invoice on that client (bare `pool.query` may route each
 * statement to a different connection). A failing invoice rolls back alone
 * and is reported in `errors`; the rest of the batch still syncs. Syncs run
 * one at a time within the API process.
 */

export const SOR_AJIO_PORTAL = 'reliance-ajio';
export const SOR_AJIO_LINE_SOURCE = 'mp_invoices:ajio';
const SOR_INVOICE_TYPE = 'sale';
const KEY_CHUNK_SIZE = 500;
const LINE_COLUMN_COUNT = 16;

const DEDUCTION_FIELDS = [
  ['commission_amount', 'commission', 'Commission'],
  ['other_deductions', 'other_deductions', 'Other deductions'],
  ['tcs_amount', 'tcs', 'TCS'],
  ['tds_amount', 'tds', 'TDS'],
];

// Payment lines are keyed by the payment reference (UTR) per invoice — the
// same key services/sorUpload.js uses — so a payment that also arrives in an
// AJIO payment-advice upload is counted once.
const paymentKey = reference => `pay:${String(reference).toUpperCase().replace(/\s+/g, '')}`;

/**
 * Sync the SOR ledger for specific AJIO invoices.
 *
 * @param {import('pg').Pool} pool
 * @param {Array<{ seller_account: string, invoice_no: string }>} invoiceKeys
 * @param {{ uploadedBy?: string|null }} [options]
 * @returns {Promise<{ mirrored: number, removed: number, errors: string[] }>}
 */
export function mirrorAjioInvoicesToSor(pool, invoiceKeys, options = {}) {
  // Syncs read the stored rows and then write; two overlapping syncs of the
  // same invoice (concurrent uploads, upload + delete) must not interleave.
  const run = syncQueue.then(() => syncAjioKeys(pool, invoiceKeys, options));
  syncQueue = run.catch(() => {});
  return run;
}

let syncQueue = Promise.resolve();

async function syncAjioKeys(pool, invoiceKeys, options) {
  const keys = uniqueKeys(invoiceKeys);
  const result = { mirrored: 0, removed: 0, errors: [] };
  for (let start = 0; start < keys.length; start += KEY_CHUNK_SIZE) {
    const chunk = await syncAjioInvoiceKeys(pool, keys.slice(start, start + KEY_CHUNK_SIZE), options);
    result.mirrored += chunk.mirrored;
    result.removed += chunk.removed;
    result.errors.push(...chunk.errors);
  }
  return result;
}

/**
 * Rebuild the whole AJIO SOR ledger from `mp_invoices`: every stored AJIO
 * invoice plus every existing mirrored header (so headers whose source rows
 * were cleared are cleaned up). Used by the schema migration backfill and
 * after a scoped AJIO clear.
 */
export async function rebuildAjioSorLedger(pool, options = {}) {
  const { rows } = await pool.query(
    `
      SELECT seller_account, invoice_number AS invoice_no
      FROM mp_invoices
      WHERE marketplace = 'ajio' AND COALESCE(invoice_number, '') <> ''
      GROUP BY seller_account, invoice_number
      UNION
      SELECT portal_account AS seller_account, invoice_no
      FROM sor_invoice
      WHERE portal = $1 AND invoice_type = $2
    `,
    [SOR_AJIO_PORTAL, SOR_INVOICE_TYPE],
  );
  return mirrorAjioInvoicesToSor(pool, rows, options);
}

async function syncAjioInvoiceKeys(pool, keys, { uploadedBy = null } = {}) {
  const result = { mirrored: 0, removed: 0, errors: [] };
  if (keys.length === 0) return result;
  const accounts = keys.map(key => key.seller_account);
  const invoiceNos = keys.map(key => key.invoice_no);

  const { rows: storedRows } = await pool.query(
    `
      SELECT m.id, m.seller_account, m.invoice_number, m.invoice_date, m.sku, m.quantity,
             m.invoice_amount, m.commission_amount, m.other_deductions, m.tcs_amount,
             m.tds_amount, m.net_payable, m.amount_received, m.payment_date,
             m.payment_reference, m.order_release_id, m.order_line_id, m.return_id, m.order_type
      FROM mp_invoices m
      JOIN unnest($1::text[], $2::text[]) AS k(seller_account, invoice_no)
        ON m.seller_account = k.seller_account AND m.invoice_number = k.invoice_no
      WHERE m.marketplace = 'ajio'
      ORDER BY m.seller_account, m.invoice_number, m.id
    `,
    [accounts, invoiceNos],
  );

  const orderRowIds = await resolveAjioOrderRows(pool, storedRows);
  const invoices = buildAjioSorInvoices(storedRows, orderRowIds);

  const client = await pool.connect();
  try {
    for (const key of keys) {
      const invoice = invoices.get(invoiceKey(key.seller_account, key.invoice_no));
      try {
        await client.query('BEGIN');
        if (invoice) {
          await writeInvoice(client, invoice, uploadedBy);
          result.mirrored++;
        } else if (await removeInvoice(client, key)) {
          result.removed++;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        result.errors.push(`SOR sync failed for AJIO invoice ${key.invoice_no}: ${err.message}`);
      }
    }
  } finally {
    client.release();
  }
  return result;
}

/**
 * Pure aggregation: stored mp_invoices rows → SOR header + lines per invoice.
 * Exported for unit tests.
 */
export function buildAjioSorInvoices(storedRows, orderRowIds = new Map()) {
  const invoices = new Map();
  for (const row of storedRows) {
    const key = invoiceKey(row.seller_account, row.invoice_number);
    let invoice = invoices.get(key);
    if (!invoice) {
      invoice = {
        portal_account: row.seller_account,
        invoice_no: row.invoice_number,
        invoice_date: null,
        period_from: null,
        period_to: null,
        gross_amount: 0,
        fee_amount: 0,
        tds_amount: 0,
        net_payable: 0,
        mp_invoice_ids: [],
        lines: [],
      };
      invoices.set(key, invoice);
    }
    const date = isoDate(row.invoice_date);
    if (date) {
      if (!invoice.period_from || date < invoice.period_from) invoice.period_from = date;
      if (!invoice.period_to || date > invoice.period_to) invoice.period_to = date;
      invoice.invoice_date = invoice.period_from;
    }

    // A reverse row flagged by Return ID / order type but written with
    // positive amounts reverses the whole row: flip every money field so the
    // fee refunds and the declared net net off the return, as they do when
    // the portal already writes the row negative.
    const isReturn = isReverseRow(row);
    const sign = isReturn && toNum(row.invoice_amount) > 0 ? -1 : 1;
    const money = field => sign * toNum(row[field]);
    const amount = money('invoice_amount');
    invoice.gross_amount += amount;
    invoice.fee_amount += money('commission_amount') + money('other_deductions') + money('tcs_amount');
    invoice.tds_amount += money('tds_amount');
    invoice.net_payable += money('net_payable');
    invoice.mp_invoice_ids.push(row.id);

    const orderId = row.order_line_id || row.order_release_id || null;
    const orderRowId = orderId ? orderRowIds.get(orderId) ?? null : null;
    const base = { mp_invoice_id: row.id };
    const rowDate = isoDate(row.invoice_date);
    invoice.lines.push({
      line_type: isReturn ? 'return' : 'sale',
      order_id: orderId,
      sku: row.sku || null,
      quantity: row.quantity ?? null,
      gross_amount: isReturn ? Math.abs(amount) : amount,
      order_row_id: orderRowId,
      source_key: `mp:${row.id}`,
      line_date: rowDate,
      reference_no: isReturn ? (row.return_id || row.invoice_number) : row.invoice_number,
      description: isReturn ? 'Return' : 'Invoice',
      raw_payload: {
        ...base,
        return_id: row.return_id || undefined,
        order_type: row.order_type || undefined,
        sign_flipped: sign < 0 || undefined,
      },
    });
    for (const [field, feeType, label] of DEDUCTION_FIELDS) {
      const value = money(field);
      if (value === 0) continue;
      invoice.lines.push({
        line_type: 'deduction',
        order_id: orderId,
        sku: row.sku || null,
        quantity: null,
        gross_amount: value,
        order_row_id: orderRowId,
        source_key: `mp:${row.id}:${feeType}`,
        line_date: rowDate,
        reference_no: row.invoice_number,
        description: label,
        raw_payload: { ...base, fee_type: feeType },
      });
    }
    const received = money('amount_received');
    if (received !== 0) {
      const reference = row.payment_reference ? String(row.payment_reference).trim() : '';
      const key = reference ? paymentKey(reference) : `mp:${row.id}:payment`;
      // One UTR usually pays every SKU row of the invoice: one payment line.
      const existing = reference ? invoice.lines.find(line => line.line_type === 'payment' && line.source_key === key) : null;
      if (existing) {
        existing.gross_amount = round2(existing.gross_amount + received);
        existing.raw_payload.mp_invoice_ids.push(row.id);
      } else {
        invoice.lines.push({
          line_type: 'payment',
          order_id: orderId,
          sku: row.sku || null,
          quantity: null,
          gross_amount: received,
          order_row_id: orderRowId,
          source_key: key,
          line_date: isoDate(row.payment_date) || rowDate,
          reference_no: reference || null,
          description: 'Payment',
          raw_payload: {
            ...base,
            mp_invoice_ids: [row.id],
            payment_date: isoDate(row.payment_date) || undefined,
            payment_reference: reference || undefined,
          },
        });
      }
    }
  }
  for (const invoice of invoices.values()) {
    for (const field of ['gross_amount', 'fee_amount', 'tds_amount', 'net_payable']) {
      invoice[field] = round2(invoice[field]);
    }
  }
  return invoices;
}

async function writeInvoice(client, invoice, uploadedBy) {
  const { rows } = await client.query(
    `
      INSERT INTO sor_invoice (
        portal, portal_account, invoice_no, invoice_date,
        period_from, period_to, invoice_type,
        gross_amount, fee_amount, tds_amount, net_payable,
        raw_payload, uploaded_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
      ON CONFLICT (portal, portal_account, invoice_no, invoice_type)
      DO UPDATE SET
        invoice_date = EXCLUDED.invoice_date,
        period_from  = EXCLUDED.period_from,
        period_to    = EXCLUDED.period_to,
        gross_amount = EXCLUDED.gross_amount,
        fee_amount   = EXCLUDED.fee_amount,
        tds_amount   = EXCLUDED.tds_amount,
        net_payable  = EXCLUDED.net_payable,
        raw_payload  = EXCLUDED.raw_payload,
        uploaded_by  = COALESCE(EXCLUDED.uploaded_by, sor_invoice.uploaded_by),
        uploaded_at  = NOW()
      RETURNING id
    `,
    [
      SOR_AJIO_PORTAL, invoice.portal_account, invoice.invoice_no, invoice.invoice_date,
      invoice.period_from, invoice.period_to, SOR_INVOICE_TYPE,
      invoice.gross_amount, invoice.fee_amount, invoice.tds_amount, invoice.net_payable,
      JSON.stringify({
        source: SOR_AJIO_LINE_SOURCE,
        mp_invoice_ids: invoice.mp_invoice_ids,
        row_count: invoice.mp_invoice_ids.length,
      }),
      uploadedBy,
    ],
  );
  const headerId = rows[0]?.id;
  if (!headerId) throw new Error('sor_invoice upsert returned no id');

  await client.query(
    `DELETE FROM sor_invoice_line WHERE invoice_id = $1 AND source = $2`,
    [headerId, SOR_AJIO_LINE_SOURCE],
  );
  await forEachDbBatch(invoice.lines, LINE_COLUMN_COUNT, async batch => {
    const values = [];
    const groups = batch.map(line => {
      const start = values.length;
      values.push(
        headerId,
        line.line_type,
        line.order_id,
        line.sku,
        null, // vb_export_sku — populated by the catalog merge pass
        line.quantity,
        line.gross_amount,
        0,    // fee_amount — the amount of a deduction line lives in gross_amount
        null, // settlement_id
        line.order_row_id,
        JSON.stringify(line.raw_payload),
        SOR_AJIO_LINE_SOURCE,
        line.source_key,
        line.line_date ?? null,
        line.reference_no ?? null,
        line.description ?? null,
      );
      const params = Array.from({ length: LINE_COLUMN_COUNT }, (_, i) => `$${start + i + 1}`);
      params[10] += '::jsonb';
      params[13] += '::date';
      return `(${params.join(',')})`;
    });
    // A payment already recorded by a SOR payment / payment-advice upload
    // (same invoice, same UTR) is kept rather than counted twice.
    await client.query(
      `INSERT INTO sor_invoice_line (
         invoice_id, line_type, order_id, sku, vb_export_sku,
         quantity, gross_amount, fee_amount, settlement_id, order_row_id,
         raw_payload, source, source_key, line_date, reference_no, description
       ) VALUES ${groups.join(',')}
       ON CONFLICT (invoice_id, line_type, source_key) DO NOTHING`,
      values,
    );
  });
  return headerId;
}

// Drop the mirror-owned lines of an invoice whose AJIO rows no longer exist,
// and the header itself once nothing else references it.
async function removeInvoice(client, key) {
  const { rows } = await client.query(
    `SELECT id FROM sor_invoice WHERE portal = $1 AND portal_account = $2 AND invoice_no = $3 AND invoice_type = $4`,
    [SOR_AJIO_PORTAL, key.seller_account, key.invoice_no, SOR_INVOICE_TYPE],
  );
  const headerId = rows[0]?.id;
  if (!headerId) return false;
  await client.query(
    `DELETE FROM sor_invoice_line WHERE invoice_id = $1 AND source = $2`,
    [headerId, SOR_AJIO_LINE_SOURCE],
  );
  await client.query(
    `DELETE FROM sor_invoice i WHERE i.id = $1
       AND NOT EXISTS (SELECT 1 FROM sor_invoice_line l WHERE l.invoice_id = i.id)`,
    [headerId],
  );
  return true;
}

// AJIO invoice rows identify the order by order line / release id. Resolve
// them against AJIO orders only so an id collision with another marketplace
// can never link the wrong order.
async function resolveAjioOrderRows(pool, storedRows) {
  const ids = [...new Set(
    storedRows.flatMap(row => [row.order_line_id, row.order_release_id]).filter(Boolean),
  )];
  const map = new Map();
  if (ids.length === 0) return map;
  try {
    const { rows } = await pool.query(
      `
        SELECT id, order_item_id, order_id
        FROM orders
        WHERE marketplace = 'ajio'
          AND (order_item_id = ANY($1::text[]) OR order_id = ANY($1::text[]))
      `,
      [ids],
    );
    for (const row of rows) {
      if (row.order_item_id) map.set(row.order_item_id, row.id);
      if (row.order_id && !map.has(row.order_id)) map.set(row.order_id, row.id);
    }
  } catch (err) {
    // Order linkage enriches the ledger but is not required for the totals.
    console.warn('[sorMirror] AJIO order linkage skipped:', err.message);
  }
  return map;
}

function isReverseRow(row) {
  const type = String(row.order_type || '').toLowerCase();
  return toNum(row.invoice_amount) < 0 || Boolean(row.return_id) || type === 'reverse' || type === 'return';
}

function uniqueKeys(keys) {
  const seen = new Map();
  for (const key of keys || []) {
    const account = String(key?.seller_account ?? '').trim();
    const invoiceNo = String(key?.invoice_no ?? '').trim();
    if (!account || !invoiceNo) continue;
    seen.set(invoiceKey(account, invoiceNo), { seller_account: account, invoice_no: invoiceNo });
  }
  return [...seen.values()];
}

function invoiceKey(account, invoiceNo) {
  return `${account}\u0000${invoiceNo}`;
}

// backend/db/index.js keeps DATE columns as 'YYYY-MM-DD' strings.
function isoDate(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
