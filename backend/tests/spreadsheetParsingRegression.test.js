import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { parseSpreadsheet } from '../services/spreadsheetWorker.js';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { optionalNumber } from '../utils/valueParsers.js';
import { buildHeaderIndex, parseAmazonSettlementLine } from '../routes/amazonUpload.js';
import { parseLedgerUploadRow } from '../routes/mpSettlement.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

// Pins the dates and numbers the upload handlers get from a workbook, so a
// SheetJS upgrade that changes date, number or header handling fails here
// instead of in a finance report. Read options are the handlers' own.
const GENERIC_UPLOAD = { read: { cellDates: true }, sheets: 0, json: { header: 1, defval: '', raw: false } }; // upload.js, myntraUpload.js
const LEDGER_UPLOAD = { read: { cellDates: true }, sheets: 0, json: { defval: '' } }; // mpSettlement.js
const RETURNS_UPLOAD = { sheets: 0, json: { header: 1, defval: '' } }; // upload.js returns, returnTracking.js
const AMAZON_SETTLEMENT = { read: { cellDates: false, cellNF: false, cellStyles: false }, values: true };

// Dates are written as serial numbers with a number format, not Date objects,
// so the file is byte-for-byte the same in every time zone.
// 46117 = 2026-04-05, 46387 = 2026-12-31, 46137 = 2026-04-25.
function workbookFile(rows, sheetName = 'Orders') {
  const sheet = {};
  rows.forEach((row, r) => row.forEach((value, c) => {
    sheet[XLSX.utils.encode_cell({ r, c })] = typeof value === 'object' ? value : { t: typeof value === 'number' ? 'n' : 's', v: value };
  }));
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

const ORDERS = [
  ['Order Date', 'Settled At', 'Invoice Amount', 'Commission', 'Qty', 'GST Rate', 'Order Item ID', 'SKU', 'Bank Amount'],
  [
    { t: 'n', v: 46117, z: 'dd-mm-yyyy' }, { t: 'n', v: 46117.510416666664, z: 'yyyy-mm-dd hh:mm:ss' },
    { t: 'n', v: 1250.75, z: '#,##0.00' }, -45.5, 3, { t: 'n', v: 0.18, z: '0%' },
    '123456789012345678', '00123', '₹1,234.50',
  ],
  [
    { t: 'n', v: 46387, z: 'dd-mm-yyyy' }, { t: 'n', v: 46137.99998842593, z: 'yyyy-mm-dd hh:mm:ss' },
    { t: 'n', v: 12345678.9, z: '#,##0.00' }, -0.01, 1, { t: 'n', v: 0.125, z: '0.0%' },
    '987654321098765', 'SKU-1', '(1,00,000.00)',
  ],
];

const wallClock = date => [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];

describe('upload parsing: XLSX dates and numbers', () => {
  it('gives text-reading handlers the cell text, which normalizes to the right dates and amounts', async () => {
    const book = await parseSpreadsheet(workbookFile(ORDERS), GENERIC_UPLOAD);
    const [headers, ...rows] = book.Sheets.Orders;

    expect(headers).toStrictEqual(ORDERS[0]);
    expect(rows).toStrictEqual([
      ['05-04-2026', '2026-04-05 12:15:00', '1,250.75', '-45.5', '3', '18%', '123456789012345678', '00123', '₹1,234.50'],
      ['31-12-2026', '2026-04-25 23:59:59', '12,345,678.90', '-0.01', '1', '12.5%', '987654321098765', 'SKU-1', '(1,00,000.00)'],
    ]);
    expect(rows.map(row => [normalizeSqlDate(row[0]), normalizeSqlDate(row[1])])).toStrictEqual([
      ['2026-04-05', '2026-04-05'],
      ['2026-12-31', '2026-04-25'],
    ]);
    expect(rows.map(row => [row[2], row[3], row[4], row[8]].map(optionalNumber))).toStrictEqual([
      [1250.75, -45.5, 3, 1234.5],
      [12345678.9, -0.01, 1, -100000],
    ]);
  });

  it('gives value-reading handlers Date objects at the cell\'s wall-clock time and exact numbers', async () => {
    const book = await parseSpreadsheet(workbookFile(ORDERS), LEDGER_UPLOAD);
    const [first, second] = book.Sheets.Orders;

    expect(first['Order Date']).toBeInstanceOf(Date);
    expect(wallClock(first['Order Date'])).toStrictEqual([2026, 4, 5, 0, 0, 0]);
    expect(wallClock(first['Settled At'])).toStrictEqual([2026, 4, 5, 12, 15, 0]);
    expect(wallClock(second['Order Date'])).toStrictEqual([2026, 12, 31, 0, 0, 0]);
    expect(wallClock(second['Settled At'])).toStrictEqual([2026, 4, 25, 23, 59, 59]);
    expect(first).toMatchObject({
      'Invoice Amount': 1250.75, Commission: -45.5, Qty: 3, 'GST Rate': 0.18,
      'Order Item ID': '123456789012345678', SKU: '00123', 'Bank Amount': '₹1,234.50',
    });
    expect(second).toMatchObject({ 'Invoice Amount': 12345678.9, Commission: -0.01, Qty: 1, 'GST Rate': 0.125 });
  });

  it('gives handlers without cellDates the Excel serials, which normalize to the same dates', async () => {
    const book = await parseSpreadsheet(workbookFile(ORDERS), RETURNS_UPLOAD);
    const [, first, second] = book.Sheets.Orders;

    expect(first.slice(0, 6)).toStrictEqual([46117, 46117.510416666664, 1250.75, -45.5, 3, 0.18]);
    expect(second.slice(0, 2)).toStrictEqual([46387, 46137.99998842593]);
    expect([first[0], first[1], second[0], second[1]].map(value => normalizeSqlDate(value)))
      .toStrictEqual(['2026-04-05', '2026-04-05', '2026-12-31', '2026-04-25']);
  });

  it('reads Amazon settlement amounts and posted dates through the settlement line parser', async () => {
    const headers = ['settlement-id', 'transaction-type', 'amount-type', 'amount-description', 'amount', 'posted-date', 'quantity-purchased', 'currency'];
    const file = workbookFile([
      headers,
      ['S-1', 'Order', 'ItemPrice', 'Principal', 899, '05.04.2026', 1, 'INR'],
      ['S-1', 'Order', 'ItemFees', 'Commission', -45.5, { t: 'n', v: 46137, z: 'dd.mm.yyyy' }, '', 'INR'],
      ['S-1', 'Refund', 'ItemPrice', 'Principal', { t: 'n', v: -1250.75, z: '#,##0.00' }, '31.12.2026', 2, 'INR'],
    ], 'Settlement');
    const book = await parseSpreadsheet(file, AMAZON_SETTLEMENT);
    const rows = book.Sheets.Settlement;
    const idx = buildHeaderIndex(rows[0].map(cell => String(cell ?? '').trim()));

    const lines = rows.slice(1).map(row => parseAmazonSettlementLine(row, idx).values);
    expect(lines.map(line => [line.amount, line.posted_date, line.quantity])).toStrictEqual([
      [899, '2026-04-05', 1],
      [-45.5, '2026-04-25', null],
      [-1250.75, '2026-12-31', 2],
    ]);
  });
});

describe('upload parsing: CSV and HTML-table ".xls" files', () => {
  it('keeps CSV ISO dates as the file wrote them for text-reading handlers', async () => {
    // SheetJS 0.18 re-formatted these as "4/5/26" and "4/25/26", which the
    // day-first normalizer stored as 2026-05-04 and null.
    const csv = Buffer.from('Order Date,Order Item ID,Invoice Amount\n2026-04-05,OI-1,"1,234.50"\n2026-04-25,OI-2,899\n');
    const book = await parseSpreadsheet(csv, GENERIC_UPLOAD);
    const [, ...rows] = book.Sheets.Sheet1;

    expect(rows).toStrictEqual([['2026-04-05', 'OI-1', '1,234.50'], ['2026-04-25', 'OI-2', '899']]);
    expect(rows.map(row => [normalizeSqlDate(row[0]), optionalNumber(row[2])]))
      .toStrictEqual([['2026-04-05', 1234.5], ['2026-04-25', 899]]);
  });

  it('never turns day-first date text in an HTML table into a 1900s date', async () => {
    // SheetJS 0.20 reads "05-04-2026" in an HTML table as year 5 + 2026 days
    // (1910-10-17); the worker hands the text on instead.
    const html = Buffer.from(`<html><body><table>
      <tr><td>Date</td><td>Type</td><td>Amount</td><td>Reference</td></tr>
      <tr><td>05-04-2026</td><td>Payment</td><td>1,250.50</td><td>NEFT-1</td></tr>
      <tr><td>01-12-2026 10:30:00</td><td>Commission</td><td>-45.50</td><td>REF-2</td></tr>
      <tr><td>26-04-26</td><td>Payment</td><td>899</td><td>NEFT-3</td></tr>
    </table></body></html>`);
    const book = await parseSpreadsheet(html, LEDGER_UPLOAD);
    const rows = book.Sheets.Sheet1;

    expect(rows.map(row => row.Date)).toStrictEqual(['05-04-2026', '01-12-2026 10:30:00', '26-04-26']);
    expect(rows.map(row => row.Amount)).toStrictEqual([1250.5, -45.5, 899]);
    const entries = rows.map(row => parseLedgerUploadRow(row, { marketplace: 'zepto', batch: 'b' }).values);
    expect(entries.map(values => values.slice(1, 8))).toStrictEqual([
      ['2026-04-05', 'NEFT-1', '', '', 'Payment', 0, 1250.5],
      ['2026-12-01', 'REF-2', '', '', 'Commission', 45.5, 0],
      ['2026-04-26', 'NEFT-3', '', '', 'Payment', 0, 899],
    ]);

    const text = await parseSpreadsheet(html, GENERIC_UPLOAD);
    expect(text.Sheets.Sheet1.slice(1).map(row => row[0])).toStrictEqual(['05-04-2026', '01-12-2026 10:30:00', '26-04-26']);
    const values = await parseSpreadsheet(html, { read: { cellDates: false }, values: true });
    expect(values.Sheets.Sheet1.slice(1).map(row => row[0])).toStrictEqual(['05-04-2026', '01-12-2026 10:30:00', '26-04-26']);
  });
});
