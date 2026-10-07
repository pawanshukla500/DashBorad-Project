import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSorLines, parseSorUploadRows, sorTemplateHeaders } from '../services/sorUpload.js';

describe('parseSorUploadRows — column mapping and validation', () => {
  it('maps template headers and portal-export aliases (case / punctuation insensitive)', () => {
    const { records, skipped } = parseSorUploadRows('payment', [
      { 'INVOICE NUMBER': 'INV-1', 'Value Date': '05-10-2026', 'UTR No.': 'UTR 99', 'Net Paid': '₹7,404.00' },
    ]);
    expect(skipped).toEqual([]);
    expect(records).toEqual([{ rowNum: 2, invoice_no: 'INV-1', payment_date: '2026-10-05', reference: 'UTR 99', paid_amount: 7404 }]);
  });

  it('names the missing required columns and points at the template', () => {
    expect(() => parseSorUploadRows('invoice', [{ 'Invoice No': 'A', Amount: 10 }]))
      .toThrow(/Missing column: Invoice Date\. Download the Invoice template/);
  });

  it('skips rows with a bad value and says why, keeping the spreadsheet row number', () => {
    const { records, skipped } = parseSorUploadRows('invoice', [
      { 'Invoice No': 'INV-1', 'Invoice Date': '2026-09-01', 'Invoice Amount': '1000' },
      { 'Invoice No': 'INV-2', 'Invoice Date': 'yesterday', 'Invoice Amount': 'abc' },
      { 'Invoice No': '', 'Invoice Date': '2026-09-02', 'Invoice Amount': '50', Quantity: '1.5' },
      { 'Invoice No': '', 'Invoice Date': '', 'Invoice Amount': '' },
    ]);
    expect(records.map(r => r.invoice_no)).toEqual(['INV-1']);
    expect(skipped).toEqual([
      { rowNum: 3, reason: 'Invoice Date "yesterday" is not a valid date; Invoice Amount "abc" is not a number' },
      { rowNum: 4, reason: 'Invoice No is empty; Quantity must be a whole number' },
    ]);
  });

  it('accepts a payment advice that only carries deductions', () => {
    const { records, skipped } = parseSorUploadRows('payment_advice', [
      { 'Invoice No': 'INV-1', 'Advice Date': '2026-10-05', TDS: '78' },
      { 'Invoice No': 'INV-2', 'Advice Date': '2026-10-05' },
    ]);
    expect(records).toHaveLength(1);
    expect(skipped[0].reason).toBe('Amount Paid and every deduction are empty');
  });

  it('refuses an unknown stream and oversized files', () => {
    expect(() => parseSorUploadRows('bogus', [{}])).toThrow(/Unknown SOR upload stream/);
    expect(() => parseSorUploadRows('payment', Array.from({ length: 50_001 }, () => ({})))).toThrow(/at most 50000 rows/);
  });

  it('templates start with the required columns of each stream', () => {
    expect(sorTemplateHeaders('payment_advice').slice(0, 4)).toEqual(['Invoice No', 'Advice Date', 'Payment Reference', 'Amount Paid']);
  });
});

describe('buildSorLines — ledger lines and idempotency keys', () => {
  it('keys payments by UTR so a payment file and a payment advice for the same UTR collapse', () => {
    const [fromPayment] = buildSorLines('payment', [{ rowNum: 2, invoice_no: 'INV-1', payment_date: '2026-10-05', reference: 'utr 99', paid_amount: 100 }]);
    const fromAdvice = buildSorLines('payment_advice', [{ rowNum: 2, invoice_no: 'INV-1', advice_date: '2026-10-05', reference: 'UTR99', paid_amount: 100, tds: 2, commission: null, discount: null, penalty: 5, other_deduction: null }]);
    expect(fromPayment.source_key).toBe('pay:UTR99');
    expect(fromAdvice.map(line => [line.line_type, line.source_key, line.gross_amount, line.description])).toEqual([
      ['payment', 'pay:UTR99', 100, 'Payment (advice)'],
      ['deduction', 'adv:UTR99:tds', 2, 'TDS'],
      ['deduction', 'adv:UTR99:penalty', 5, 'Penalty / Claims'],
    ]);
  });

  it('sums rows of one document within a file instead of rejecting them', () => {
    const lines = buildSorLines('return', [
      { rowNum: 2, invoice_no: 'INV-1', return_date: '2026-09-20', note_no: 'CN-1', sku: 'A', quantity: 1, return_amount: 100 },
      { rowNum: 3, invoice_no: 'INV-1', return_date: '2026-09-20', note_no: 'cn-1', sku: 'A', quantity: 2, return_amount: 200 },
      { rowNum: 4, invoice_no: 'INV-1', return_date: '2026-09-20', note_no: 'CN-1', sku: 'B', quantity: 1, return_amount: 50 },
    ]);
    expect(lines.map(line => [line.source_key, line.gross_amount, line.quantity, line.rows])).toEqual([
      ['ret:CN-1:A', 300, 3, [2, 3]],
      ['ret:CN-1:B', 50, 1, [4]],
    ]);
  });

  it('keys deductions by reference and type', () => {
    const [line] = buildSorLines('deduction', [{ rowNum: 2, invoice_no: 'INV-1', deduction_date: '2026-09-25', reference: 'DN-7', deduction_type: 'Late delivery', deduction_amount: 150 }]);
    expect(line).toMatchObject({ line_type: 'deduction', source_key: 'ded:DN-7:LATEDELIVERY', gross_amount: 150, description: 'Late delivery', reference_no: 'DN-7' });
  });
});

// ── HTTP contract ──
let sheetRows;
let statements;
vi.mock('../services/spreadsheetWorker.js', () => ({
  parseSpreadsheet: async () => ({ SheetNames: ['Upload'], Sheets: { Upload: sheetRows } }),
}));
vi.mock('../db/index.js', () => {
  const run = async (text, params) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    statements.push({ sql, params });
    if (sql.startsWith('SELECT id, invoice_no FROM sor_invoice')) {
      return { rows: params[3].filter(no => no !== 'MISSING').map((invoice_no, i) => ({ id: 10 + i, invoice_no })) };
    }
    if (sql.startsWith('INSERT INTO sor_invoice ')) return { rows: [{ id: 77 }] };
    if (sql.startsWith('INSERT INTO sor_invoice_line')) return { rows: Array.from({ length: (params.length / 15) }, () => ({ inserted: true })) };
    if (sql.startsWith('DELETE')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  return {
    isDbConfigured: async () => true,
    getPool: () => ({ query: vi.fn(run), connect: vi.fn(async () => ({ query: vi.fn(run), release: vi.fn() })) }),
  };
});

const { default: sorUploadRouter } = await import('../routes/sorUpload.js');

let server;
let baseUrl;
beforeEach(async () => {
  statements = [];
  sheetRows = [];
  const app = express();
  app.use((req, _res, next) => { req.user = { email: 'ops@example.com', role: 'operator' }; next(); });
  app.use('/api/sor', sorUploadRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/sor`;
});
afterEach(() => new Promise(resolve => server.close(resolve)));

function uploadFile(path, filename = 'payments.xlsx', account) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array([1, 2, 3])]), filename);
  if (account) form.append('account', account);
  return fetch(`${baseUrl}${path}`, { method: 'POST', body: form });
}

describe('POST /api/sor/:portal/upload/:stream', () => {
  it('saves matched rows, reports rows whose invoice is not in the ledger, and audits the upload', async () => {
    sheetRows = [
      { 'Invoice No': 'INV-1', 'Payment Date': '2026-10-05', 'Payment Reference': 'UTR1', 'Amount Paid': '500' },
      { 'Invoice No': 'MISSING', 'Payment Date': '2026-10-05', 'Payment Reference': 'UTR2', 'Amount Paid': '20' },
    ];
    const response = await uploadFile('/zepto/upload/payment');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, portal: 'zepto', account: 'default', stream: 'payment', inserted: 1, skipped: 1 });
    expect(body.skippedRows).toEqual([{ rowNum: 3, reason: 'Invoice MISSING is not in the Zepto ledger — upload the invoice file first' }]);
    const lookup = statements.find(s => s.sql.startsWith('SELECT id, invoice_no FROM sor_invoice'));
    expect(lookup.params.slice(0, 3)).toEqual(['zepto', 'default', 'sale']);
    const insert = statements.find(s => s.sql.startsWith('INSERT INTO sor_invoice_line'));
    expect(insert.sql).toContain('ON CONFLICT (invoice_id, line_type, source_key) DO UPDATE');
    const audit = statements.find(s => s.sql.startsWith('INSERT INTO sor_upload_log'));
    expect(audit.params).toEqual(['zepto', 'default', 'payments.xlsx', 1, 0, 1, 'partial', null, 'Payment', 'ops@example.com']);
  });

  it('uses the AJIO importer account and refuses AJIO invoice uploads here', async () => {
    sheetRows = [{ 'Invoice No': 'AJ-1', 'Return Date': '2026-10-01', 'Return Amount': '99' }];
    const ajio = await (await uploadFile('/reliance-ajio/upload/return')).json();
    expect(ajio.account).toBe('ajio_main');
    const refused = await uploadFile('/reliance-ajio/upload/invoice');
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain('AJIO invoice importer');
  });

  it('rejects unknown portals / streams, bad accounts and non-spreadsheet files', async () => {
    expect((await uploadFile('/flipkart/upload/payment')).status).toBe(404);
    expect((await uploadFile('/zepto/upload/salary')).status).toBe(404);
    sheetRows = [{ 'Invoice No': 'INV-1', 'Payment Date': '2026-10-05', 'Amount Paid': '1' }];
    const badAccount = await uploadFile('/zepto/upload/payment', 'p.xlsx', "x'; DROP TABLE orders;--");
    expect(badAccount.status).toBe(400);
    const exe = await uploadFile('/zepto/upload/payment', 'payload.exe');
    expect(exe.status).toBe(400);
  });

  it('returns the column problem as a 400 without saving anything', async () => {
    sheetRows = [{ Foo: 'bar' }];
    const response = await uploadFile('/cocoblu/upload/deduction');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Missing columns: Invoice No, Deduction Date, Deduction Amount');
    expect(statements.some(s => s.sql.startsWith('INSERT INTO sor_invoice_line'))).toBe(false);
  });

  it("replaces an uploaded invoice's own sale lines and upserts its header", async () => {
    sheetRows = [
      { 'Invoice No': 'INV-9', 'Invoice Date': '2026-09-01', SKU: 'A', Quantity: '2', 'Invoice Amount': '1000', 'Net Payable': '950' },
      { 'Invoice No': 'INV-9', 'Invoice Date': '2026-09-01', SKU: 'B', Quantity: '1', 'Invoice Amount': '500', 'Net Payable': '480' },
    ];
    const body = await (await uploadFile('/myntra-jabong/upload/invoice', 'inv.xlsx')).json();
    expect(body).toMatchObject({ invoices: 1, inserted: 2, skipped: 0 });
    const header = statements.find(s => s.sql.startsWith('INSERT INTO sor_invoice '));
    expect(header.params.slice(0, 3)).toEqual(['myntra-jabong', 'default', 'INV-9']);
    expect(header.params[7]).toBe(1500); // gross
    expect(header.params[8]).toBe(1430); // declared net
    const remove = statements.find(s => s.sql.startsWith('DELETE FROM sor_invoice_line'));
    expect(remove.params).toEqual([77, 'sor_upload:invoice']);
  });
});

describe('GET /api/sor/:portal/template/:stream', () => {
  it('serves an XLSX template', async () => {
    const response = await fetch(`${baseUrl}/zepto/template/payment_advice`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('spreadsheetml');
    expect(response.headers.get('content-disposition')).toContain('SOR_zepto_payment_advice_template.xlsx');
  });
});
