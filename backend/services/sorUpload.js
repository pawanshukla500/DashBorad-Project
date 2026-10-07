import { forEachDbBatch } from '../utils/dbBatch.js';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { optionalNumber } from '../utils/valueParsers.js';

/**
 * SOR Level Payment Reco — direct uploads for every portal.
 *
 * Five streams feed the per-invoice accounting ledger (sor_invoice +
 * sor_invoice_line, see docs/SOR_LEVEL_PAYMENT_RECO.md §6a):
 *
 *   invoice         → sor_invoice header + 'sale' lines (authoritative per
 *                     invoice: a re-upload replaces that invoice's lines)
 *   payment         → 'payment' lines (bank receipts per invoice)
 *   payment_advice  → 'payment' line (amount paid) + 'deduction' lines (TDS,
 *                     commission, discount, penalty, other) per invoice
 *   return          → 'return' lines (credit / debit notes for returned goods)
 *   deduction       → 'deduction' lines (debit notes, claims, other charges)
 *
 * Parsing is deterministic: each stream has a fixed column set with header
 * aliases (the downloadable template uses the first alias). No value is ever
 * guessed; a row that misses a required value is skipped with its reason.
 *
 * Idempotency: every line carries `source_key`. Re-uploading the same file
 * updates the same lines instead of adding new ones (UNIQUE (invoice_id,
 * line_type, source_key)). Payment lines are keyed by the payment reference
 * (UTR) per invoice, so the same payment arriving in a bank payment file and
 * in a payment advice is counted once.
 */

export const SOR_DEFAULT_ACCOUNTS = Object.freeze({
  'myntra-jabong': 'default',
  zepto: 'default',
  'reliance-ajio': 'ajio_main', // matches the AJIO mp_invoices importer
  cocoblu: 'default',
});

const PORTAL_LABELS = Object.freeze({
  'myntra-jabong': 'Myntra Jabong',
  zepto: 'Zepto',
  'reliance-ajio': 'AJIO',
  cocoblu: 'Cocoblu',
});
const SOR_INVOICE_TYPE = 'sale';
const MAX_ROWS = 50_000;
const LINE_COLUMN_COUNT = 15;

// Column definitions. The first alias is the template header.
const COLUMNS = {
  invoice_no: ['Invoice No', 'invoice number', 'invoice no.', 'inv no', 'invoice', 'bill no', 'document no', 'tax invoice no', 'vendor invoice no'],
  invoice_date: ['Invoice Date', 'inv date', 'bill date', 'document date', 'date'],
  sku: ['SKU', 'article no', 'article code', 'style code', 'item code', 'ean', 'product code', 'vb export sku', 'seller sku'],
  quantity: ['Quantity', 'qty', 'units', 'invoice qty'],
  amount: ['Invoice Amount', 'invoice value', 'line amount', 'total amount', 'gross amount', 'amount', 'total value', 'value incl gst'],
  net_payable: ['Net Payable', 'net amount', 'net receivable', 'payable amount'],
  order_id: ['PO / Order No', 'po number', 'po no', 'purchase order', 'order id', 'order no'],
  payment_date: ['Payment Date', 'paid date', 'value date', 'credit date', 'utr date', 'date'],
  reference: ['Payment Reference', 'utr', 'utr no', 'utr number', 'neft ref', 'reference no', 'reference', 'transaction id', 'cheque no', 'payment ref'],
  paid_amount: ['Amount Paid', 'paid amount', 'net paid', 'payment amount', 'amount received', 'net amount paid', 'amount'],
  tds: ['TDS', 'tds amount', 'tds deducted', 'tds 194o', 'tds 194q'],
  commission: ['Commission', 'commission amount', 'margin', 'marketplace fee'],
  discount: ['Discount', 'discount amount', 'trade discount', 'cash discount'],
  penalty: ['Penalty / Claims', 'penalty', 'claims', 'claim amount', 'shortage', 'damage'],
  other_deduction: ['Other Deductions', 'other deduction', 'deduction amount', 'deductions'],
  return_date: ['Return Date', 'credit note date', 'debit note date', 'rtv date', 'date'],
  note_no: ['Credit / Debit Note No', 'credit note no', 'debit note no', 'return no', 'rtv no', 'note no', 'reference no'],
  return_amount: ['Return Amount', 'credit note amount', 'debit note amount', 'return value', 'amount'],
  deduction_date: ['Deduction Date', 'debit note date', 'date'],
  deduction_type: ['Deduction Type', 'type', 'reason', 'description', 'remarks', 'nature'],
  deduction_amount: ['Deduction Amount', 'debit note amount', 'amount'],
  advice_date: ['Advice Date', 'payment date', 'paid date', 'value date', 'date'],
};

const ADVICE_DEDUCTIONS = [
  ['tds', 'TDS'],
  ['commission', 'Commission'],
  ['discount', 'Discount'],
  ['penalty', 'Penalty / Claims'],
  ['other_deduction', 'Other deductions'],
];

export const SOR_STREAMS = Object.freeze({
  invoice: {
    label: 'Invoice',
    columns: ['invoice_no', 'invoice_date', 'sku', 'quantity', 'amount', 'net_payable', 'order_id'],
    required: ['invoice_no', 'invoice_date', 'amount'],
    sample: [
      ['INV/25-26/0001', '2026-09-01', 'EJ1201-16001', 4, 5196, 5040, 'PO-77810'],
      ['INV/25-26/0001', '2026-09-01', 'EJ1188-14002', 2, 2598, 2520, 'PO-77810'],
    ],
  },
  payment: {
    label: 'Payment',
    columns: ['invoice_no', 'payment_date', 'reference', 'paid_amount'],
    required: ['invoice_no', 'payment_date', 'paid_amount'],
    sample: [['INV/25-26/0001', '2026-10-05', 'UTR4471882019', 7404]],
  },
  payment_advice: {
    label: 'Payment advice',
    columns: ['invoice_no', 'advice_date', 'reference', 'paid_amount', 'tds', 'commission', 'discount', 'penalty', 'other_deduction'],
    required: ['invoice_no', 'advice_date'],
    sample: [['INV/25-26/0001', '2026-10-05', 'UTR4471882019', 7404, 78, 0, 0, 312, 0]],
  },
  return: {
    label: 'Return',
    columns: ['invoice_no', 'return_date', 'note_no', 'sku', 'quantity', 'return_amount'],
    required: ['invoice_no', 'return_date', 'return_amount'],
    sample: [['INV/25-26/0001', '2026-09-20', 'CN-2026-0042', 'EJ1188-14002', 1, 1299]],
  },
  deduction: {
    label: 'Deductions',
    columns: ['invoice_no', 'deduction_date', 'reference', 'deduction_type', 'deduction_amount'],
    required: ['invoice_no', 'deduction_date', 'deduction_amount'],
    sample: [['INV/25-26/0001', '2026-09-25', 'DN-2026-0007', 'Late delivery penalty', 150]],
  },
});

const LABELS = {
  invoice_no: 'Invoice No', invoice_date: 'Invoice Date', amount: 'Invoice Amount', payment_date: 'Payment Date',
  paid_amount: 'Amount Paid', advice_date: 'Advice Date', return_date: 'Return Date', return_amount: 'Return Amount',
  deduction_date: 'Deduction Date', deduction_amount: 'Deduction Amount', quantity: 'Quantity', net_payable: 'Net Payable',
};
const DATE_FIELDS = new Set(['invoice_date', 'payment_date', 'advice_date', 'return_date', 'deduction_date']);
const MONEY_FIELDS = new Set(['amount', 'net_payable', 'paid_amount', 'tds', 'commission', 'discount', 'penalty', 'other_deduction', 'return_amount', 'deduction_amount']);

export function sorTemplateHeaders(stream) {
  return SOR_STREAMS[stream].columns.map(column => COLUMNS[column][0]);
}

export function sorTemplateAliases(stream) {
  return SOR_STREAMS[stream].columns.map(column => [COLUMNS[column][0], COLUMNS[column].slice(1).join(', ')]);
}

const normalizeHeader = header => String(header ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Map each column of a stream to the sheet header that carries it. Exact
// template headers win over aliases; an alias already used by another column
// of the same stream is not reused (e.g. a generic "Date").
function resolveColumns(stream, headers) {
  const byNormalized = new Map(headers.map(header => [normalizeHeader(header), header]));
  const used = new Set();
  const resolved = {};
  const columns = SOR_STREAMS[stream].columns;
  for (const pass of ['template', 'alias']) {
    for (const column of columns) {
      if (resolved[column]) continue;
      const candidates = pass === 'template' ? [COLUMNS[column][0]] : COLUMNS[column].slice(1);
      for (const alias of candidates) {
        const header = byNormalized.get(normalizeHeader(alias));
        if (header !== undefined && !used.has(header)) {
          resolved[column] = header;
          used.add(header);
          break;
        }
      }
    }
  }
  return resolved;
}

const text = value => (value === null || value === undefined ? '' : String(value).trim());
const blank = value => text(value) === '';
const round2 = value => Math.round(value * 100) / 100;
const NUMERIC_DATE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T].*)?$/;

// One day/month order per date column, decided from all of its values (a
// part above 12 settles it) — never cell by cell, which would read 10/05 and
// 10/25 in different orders. An undecided column is DD-MM, the Indian
// convention; a column that proves both orders is refused.
function columnDateOrder(values) {
  let dayFirst = false;
  let monthFirst = false;
  for (const value of values) {
    const match = typeof value === 'string' ? value.trim().match(NUMERIC_DATE) : null;
    if (!match) continue;
    if (Number(match[1]) > 12) dayFirst = true;
    if (Number(match[2]) > 12) monthFirst = true;
  }
  if (dayFirst && monthFirst) return 'MIXED';
  return monthFirst ? 'MDY' : 'DMY';
}

function parseDateCell(value, order) {
  if (typeof value === 'string' && NUMERIC_DATE.test(value.trim())) {
    return normalizeSqlDate(value.trim(), { format: order });
  }
  return normalizeSqlDate(value); // Excel dates, ISO, month names
}

/**
 * Pure: sheet rows → normalized records + skipped rows (with reasons).
 * Row numbers are spreadsheet rows (header = row 1).
 */
export function parseSorUploadRows(stream, rows) {
  const config = SOR_STREAMS[stream];
  if (!config) throw Object.assign(new Error(`Unknown SOR upload stream: ${stream}`), { status: 400 });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw Object.assign(new Error('The file has no data rows.'), { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    throw Object.assign(new Error(`The file has ${rows.length} rows; upload at most ${MAX_ROWS} rows at a time.`), { status: 400 });
  }
  const headers = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
  const columns = resolveColumns(stream, headers);
  const missing = config.required.filter(column => !columns[column]);
  if (missing.length) {
    throw Object.assign(new Error(
      `Missing column${missing.length > 1 ? 's' : ''}: ${missing.map(column => COLUMNS[column][0]).join(', ')}. Download the ${config.label} template for the expected layout.`,
    ), { status: 400 });
  }
  if (stream === 'payment_advice' && !columns.paid_amount && !ADVICE_DEDUCTIONS.some(([column]) => columns[column])) {
    throw Object.assign(new Error('A payment advice needs an Amount Paid column or at least one deduction column (TDS, Commission, Discount, Penalty / Claims, Other Deductions).'), { status: 400 });
  }

  const dateOrders = {};
  for (const column of config.columns) {
    if (!DATE_FIELDS.has(column) || !columns[column]) continue;
    dateOrders[column] = columnDateOrder(rows.map(row => row?.[columns[column]]));
    if (dateOrders[column] === 'MIXED') {
      throw Object.assign(new Error(
        `The ${columns[column]} column mixes day-month and month-day dates. Export it in one date format and upload again.`,
      ), { status: 400 });
    }
  }

  const records = [];
  const skipped = [];
  rows.forEach((row, index) => {
    const rowNum = index + 2;
    const values = {};
    const problems = [];
    let empty = true;
    for (const column of config.columns) {
      const header = columns[column];
      const raw = header === undefined ? '' : row[header];
      if (!blank(raw)) empty = false;
      if (DATE_FIELDS.has(column)) {
        values[column] = blank(raw) ? null : parseDateCell(raw, dateOrders[column]);
        if (!blank(raw) && !values[column]) problems.push(`${LABELS[column] || column} "${text(raw)}" is not a valid date`);
      } else if (MONEY_FIELDS.has(column) || column === 'quantity') {
        values[column] = blank(raw) ? null : optionalNumber(raw);
        if (!blank(raw) && values[column] === null) problems.push(`${LABELS[column] || COLUMNS[column][0]} "${text(raw)}" is not a number`);
      } else {
        values[column] = text(raw).replace(/^'+/, '') || null;
      }
    }
    if (empty) return; // trailing blank rows
    for (const column of config.required) {
      if (values[column] === null && !problems.some(p => p.startsWith(LABELS[column] || column))) {
        problems.push(`${LABELS[column] || COLUMNS[column][0]} is empty`);
      }
    }
    if (values.quantity !== null && values.quantity !== undefined && (!Number.isInteger(values.quantity) || values.quantity < 0)) {
      problems.push('Quantity must be a whole number');
    }
    if (stream === 'payment_advice' && values.paid_amount === null && ADVICE_DEDUCTIONS.every(([column]) => values[column] === null || values[column] === undefined)) {
      problems.push('Nothing to post: Amount Paid and every deduction are empty');
    }
    if (problems.length) {
      skipped.push({ rowNum, reason: problems.join('; ') });
      return;
    }
    records.push({ rowNum, ...values });
  });
  return { records, skipped, columns };
}

const normRef = value => text(value).toUpperCase().replace(/\s+/g, '');

// Records → ledger lines (keyed). Lines with the same key in one file are
// summed (e.g. a payment split over two rows).
export function buildSorLines(stream, records) {
  const lines = new Map();
  const add = (record, line) => {
    const id = `${record.invoice_no}\u0000${line.line_type}\u0000${line.source_key}`;
    const existing = lines.get(id);
    if (existing) {
      existing.gross_amount = round2(existing.gross_amount + line.gross_amount);
      existing.rows.push(record.rowNum);
      if (line.quantity != null) existing.quantity = (existing.quantity || 0) + line.quantity;
      return;
    }
    lines.set(id, { invoice_no: record.invoice_no, rows: [record.rowNum], ...line });
  };
  for (const record of records) {
    if (stream === 'payment') {
      const ref = normRef(record.reference);
      add(record, {
        line_type: 'payment',
        source_key: ref ? `pay:${ref}` : `pay:${record.payment_date}`,
        gross_amount: round2(record.paid_amount),
        line_date: record.payment_date,
        reference_no: record.reference,
        description: 'Payment',
      });
    } else if (stream === 'payment_advice') {
      const ref = normRef(record.reference) || `${record.advice_date}`;
      // An explicit 0 is kept: it removes a previously posted amount (below).
      if (record.paid_amount !== null) {
        add(record, {
          line_type: 'payment',
          source_key: `pay:${ref}`,
          gross_amount: round2(record.paid_amount),
          line_date: record.advice_date,
          reference_no: record.reference,
          description: 'Payment (advice)',
        });
      }
      for (const [column, label] of ADVICE_DEDUCTIONS) {
        if (record[column] === null || record[column] === undefined) continue;
        add(record, {
          line_type: 'deduction',
          source_key: `adv:${ref}:${column}`,
          gross_amount: round2(record[column]),
          line_date: record.advice_date,
          reference_no: record.reference,
          description: label,
        });
      }
    } else if (stream === 'return') {
      const note = normRef(record.note_no);
      add(record, {
        line_type: 'return',
        source_key: note ? `ret:${note}:${normRef(record.sku)}` : `ret:${record.return_date}:${normRef(record.sku)}`,
        gross_amount: round2(record.return_amount),
        line_date: record.return_date,
        reference_no: record.note_no,
        sku: record.sku,
        quantity: record.quantity,
        description: 'Return',
      });
    } else if (stream === 'deduction') {
      const ref = normRef(record.reference);
      const type = text(record.deduction_type) || 'Deduction';
      add(record, {
        line_type: 'deduction',
        source_key: ref ? `ded:${ref}:${normRef(type)}` : `ded:${record.deduction_date}:${normRef(type)}`,
        gross_amount: round2(record.deduction_amount),
        line_date: record.deduction_date,
        reference_no: record.reference,
        description: type,
      });
    }
  }
  // A line that nets to zero (a corrected amount of 0) removes the line this
  // key posted earlier instead of writing a zero entry.
  return [...lines.values()].map(line => (line.gross_amount === 0 ? { ...line, remove: true } : line));
}

/**
 * The money component a ledger line stands for. On AJIO two sources can
 * carry the same component of an invoice — the AJIO invoice file (mirrored by
 * services/sorMirror.js) and the SOR uploads — under different keys. Each
 * component of an invoice is owned by the source that recorded it first; the
 * other source skips it, so a payment, return or fee is never counted twice.
 */
const ADVICE_COMPONENTS = Object.freeze({
  tds: 'tds', commission: 'commission', other_deduction: 'other_deductions', discount: 'discount', penalty: 'penalty',
});
const COMPONENT_LABELS = Object.freeze({
  payment: 'payment', return: 'return', 'deduction:tds': 'TDS', 'deduction:tcs': 'TCS', 'deduction:commission': 'commission',
  'deduction:other_deductions': 'other deductions', 'deduction:discount': 'discount', 'deduction:penalty': 'penalty',
});
export const SOR_MIRROR_SOURCE = 'mp_invoices:ajio';

export function lineComponent({ line_type: lineType, source_key: sourceKey, fee_type: feeType }) {
  if (lineType !== 'deduction') return lineType;
  if (feeType) return `deduction:${feeType}`;
  const key = String(sourceKey || '');
  const mirrorFee = key.match(/^mp:\d+:([a-z_]+)$/);
  if (mirrorFee) return `deduction:${mirrorFee[1]}`;
  const advice = key.match(/^adv:.*:([a-z_]+)$/);
  if (advice) return `deduction:${ADVICE_COMPONENTS[advice[1]] || advice[1]}`;
  return 'deduction:debit_note'; // a standalone debit note never collides
}

// Components of each invoice already recorded by sources matching `where`.
export async function ownedComponents(client, headerIds, sourceCondition, params = []) {
  const owned = new Map();
  if (headerIds.length === 0) return owned;
  const { rows } = await client.query(
    `SELECT invoice_id, line_type, source_key, raw_payload->>'fee_type' AS fee_type
     FROM sor_invoice_line
     WHERE invoice_id = ANY($1::bigint[]) AND ${sourceCondition}`,
    [headerIds, ...params],
  );
  for (const row of rows) {
    if (!owned.has(String(row.invoice_id))) owned.set(String(row.invoice_id), new Set());
    owned.get(String(row.invoice_id)).add(lineComponent(row));
  }
  return owned;
}

/**
 * Write a parsed upload to the ledger. One dedicated client; one transaction
 * per invoice so a bad invoice cannot block the rest of the file.
 */
export async function applySorUpload(pool, { portal, account, stream, records, uploadedBy = null }) {
  const source = `sor_upload:${stream}`;
  const result = { invoices: 0, inserted: 0, updated: 0, removed: 0, skipped: [], errors: [] };
  if (records.length === 0) return result;
  const skipLine = (line, reason) => {
    for (const rowNum of line.rows) result.skipped.push({ rowNum, reason });
  };

  const client = await pool.connect();
  try {
    if (stream === 'invoice') {
      const byInvoice = new Map();
      for (const record of records) {
        if (!byInvoice.has(record.invoice_no)) byInvoice.set(record.invoice_no, []);
        byInvoice.get(record.invoice_no).push(record);
      }
      for (const [invoiceNo, rows] of byInvoice) {
        try {
          await client.query('BEGIN');
          const outcome = await writeInvoice(client, { portal, account, invoiceNo, rows, source, uploadedBy });
          await client.query('COMMIT');
          result.invoices++;
          // A re-uploaded invoice replaces its lines: count them as updated.
          if (outcome.created) result.inserted += outcome.lines;
          else result.updated += outcome.lines;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          result.errors.push(`Invoice ${invoiceNo}: ${err.message}`);
          for (const row of rows) result.skipped.push({ rowNum: row.rowNum, reason: 'Could not be saved; retry the upload' });
        }
      }
      return result;
    }

    const lines = buildSorLines(stream, records);
    const invoiceNos = [...new Set(lines.map(line => line.invoice_no))];
    const { rows: headers } = await client.query(
      `SELECT id, invoice_no FROM sor_invoice
       WHERE portal = $1 AND portal_account = $2 AND invoice_type = $3 AND invoice_no = ANY($4::text[])`,
      [portal, account, SOR_INVOICE_TYPE, invoiceNos],
    );
    const headerIds = new Map(headers.map(row => [row.invoice_no, String(row.id)]));
    const mirrorOwned = await ownedComponents(client, [...headerIds.values()], 'source = $2', [SOR_MIRROR_SOURCE]);
    const byInvoice = new Map();
    for (const line of lines) {
      const headerId = headerIds.get(line.invoice_no);
      if (!headerId) {
        skipLine(line, `Invoice ${line.invoice_no} is not in the ${PORTAL_LABELS[portal] || portal} ledger — upload the invoice file first`);
        continue;
      }
      const component = lineComponent(line);
      if (!line.remove && mirrorOwned.get(headerId)?.has(component)) {
        skipLine(line, `Already recorded from the AJIO invoice file (${COMPONENT_LABELS[component] || component}) — not posted twice`);
        continue;
      }
      if (!byInvoice.has(headerId)) byInvoice.set(headerId, []);
      byInvoice.get(headerId).push(line);
    }
    for (const [headerId, invoiceLines] of byInvoice) {
      try {
        await client.query('BEGIN');
        const removals = invoiceLines.filter(line => line.remove);
        const outcome = await upsertLines(client, headerId, invoiceLines.filter(line => !line.remove), source);
        for (const line of removals) {
          // Only an upload's own line is removed, never one the AJIO file owns.
          const { rowCount } = await client.query(
            `DELETE FROM sor_invoice_line
             WHERE invoice_id = $1 AND line_type = $2 AND source_key = $3 AND source LIKE 'sor_upload:%'`,
            [headerId, line.line_type, line.source_key],
          );
          result.removed += rowCount;
        }
        await client.query(`UPDATE sor_invoice SET uploaded_at = NOW() WHERE id = $1`, [headerId]);
        await client.query('COMMIT');
        result.invoices++;
        result.inserted += outcome.inserted;
        result.updated += outcome.updated;
        for (const line of outcome.blocked) skipLine(line, 'Already recorded from the AJIO invoice file — not posted twice');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        result.errors.push(`Invoice ${invoiceLines[0].invoice_no}: ${err.message}`);
        for (const line of invoiceLines) skipLine(line, 'Could not be saved; retry the upload');
      }
    }
    return result;
  } finally {
    client.release();
  }
}

async function writeInvoice(client, { portal, account, invoiceNo, rows, source, uploadedBy }) {
  const dates = rows.map(row => row.invoice_date).filter(Boolean).sort();
  const gross = round2(rows.reduce((sum, row) => sum + row.amount, 0));
  const hasNet = rows.some(row => row.net_payable !== null);
  const net = hasNet ? round2(rows.reduce((sum, row) => sum + (row.net_payable ?? row.amount), 0)) : null;
  const { rows: headerRows } = await client.query(
    `
      INSERT INTO sor_invoice (
        portal, portal_account, invoice_no, invoice_date, period_from, period_to, invoice_type,
        gross_amount, fee_amount, tds_amount, net_payable, raw_payload, uploaded_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9,$10::jsonb,$11)
      ON CONFLICT (portal, portal_account, invoice_no, invoice_type)
      DO UPDATE SET
        invoice_date = EXCLUDED.invoice_date,
        period_from  = EXCLUDED.period_from,
        period_to    = EXCLUDED.period_to,
        gross_amount = EXCLUDED.gross_amount,
        net_payable  = EXCLUDED.net_payable,
        raw_payload  = EXCLUDED.raw_payload,
        uploaded_by  = COALESCE(EXCLUDED.uploaded_by, sor_invoice.uploaded_by),
        uploaded_at  = NOW()
      RETURNING id, (xmax = 0) AS created
    `,
    [
      portal, account, invoiceNo, dates[0], dates[0], dates[dates.length - 1], SOR_INVOICE_TYPE,
      gross, net, JSON.stringify({ source, rows: rows.length }), uploadedBy,
    ],
  );
  const headerId = headerRows[0]?.id;
  if (!headerId) throw new Error('invoice header was not saved');
  await client.query(
    `DELETE FROM sor_invoice_line WHERE invoice_id = $1 AND source = $2`,
    [headerId, source],
  );
  const lines = rows.map((row, index) => ({
    line_type: 'sale',
    source_key: `inv:${index + 1}`,
    gross_amount: round2(row.amount),
    line_date: row.invoice_date,
    reference_no: invoiceNo,
    order_id: row.order_id,
    sku: row.sku,
    quantity: row.quantity,
    description: 'Invoice',
    rows: [row.rowNum],
  }));
  await upsertLines(client, headerId, lines, source);
  return { lines: lines.length, created: headerRows[0].created !== false };
}

// Insert / update keyed lines. A conflicting line owned by another source
// (the AJIO mirror) is never taken over: it is left as is and reported back
// in `blocked`.
async function upsertLines(client, headerId, lines, source) {
  let inserted = 0;
  let updated = 0;
  const written = new Set();
  await forEachDbBatch(lines, LINE_COLUMN_COUNT, async batch => {
    const values = [];
    const groups = batch.map(line => {
      const start = values.length;
      values.push(
        headerId, line.line_type, line.order_id ?? null, line.sku ?? null, line.quantity ?? null,
        line.gross_amount, 0, null, null,
        JSON.stringify({ source, rows: line.rows }), source, line.source_key,
        line.line_date ?? null, line.reference_no ?? null, line.description ?? null,
      );
      const params = Array.from({ length: LINE_COLUMN_COUNT }, (_, i) => `$${start + i + 1}`);
      params[9] += '::jsonb';
      params[12] += '::date';
      return `(${params.join(',')})`;
    });
    const { rows } = await client.query(
      `INSERT INTO sor_invoice_line (
         invoice_id, line_type, order_id, sku, quantity,
         gross_amount, fee_amount, settlement_id, order_row_id,
         raw_payload, source, source_key, line_date, reference_no, description
       ) VALUES ${groups.join(',')}
       ON CONFLICT (invoice_id, line_type, source_key) DO UPDATE SET
         gross_amount = EXCLUDED.gross_amount,
         quantity     = EXCLUDED.quantity,
         sku          = EXCLUDED.sku,
         raw_payload  = EXCLUDED.raw_payload,
         source       = EXCLUDED.source,
         line_date    = EXCLUDED.line_date,
         reference_no = EXCLUDED.reference_no,
         description  = EXCLUDED.description
       WHERE sor_invoice_line.source LIKE 'sor_upload:%'
       RETURNING line_type, source_key, (xmax = 0) AS inserted`,
      values,
    );
    for (const row of rows) {
      written.add(`${row.line_type}\u0000${row.source_key}`);
      if (row.inserted) inserted++;
      else updated++;
    }
  });
  const blocked = lines.filter(line => !written.has(`${line.line_type}\u0000${line.source_key}`));
  return { inserted, updated, blocked };
}
