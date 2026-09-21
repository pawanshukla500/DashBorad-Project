import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { createSpreadsheetParser, parseSpreadsheet } from '../services/spreadsheetWorker.js';
import { buildHeaderIndex, parseAmazonSettlementLine } from '../routes/amazonUpload.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

// The XLSX.read and sheet_to_json options the upload handlers used in-thread.
const HANDLER_OPTIONS = [
  ['flipkart settlement', { raw: false }, { header: 1, defval: '', blankrows: false, raw: false }],
  ['amazon reports', { cellDates: true, cellNF: false, raw: false }, { header: 1, defval: '', raw: false }],
  ['generic uploads and myntra', { cellDates: true }, { header: 1, defval: '', raw: false }],
  ['meesho payments', { cellDates: true }, { range: 1 }],
  ['invoice and ledger uploads', { cellDates: true }, { defval: '' }],
  ['vb export catalog', {}, {}],
  ['returns uploads', {}, { header: 1, defval: '' }],
];

// Title row, blank rows (inside and at the end of the range), duplicate
// headers, dates, booleans, empty cells and an error cell.
function sampleWorkbook() {
  const payments = XLSX.utils.aoa_to_sheet([
    ['Payment report', '', 'Grouped columns'],
    ['Sub Order No', 'Amount', 'Payment Date', 'Amount', 'Paid'],
    ['SO-1', 10.5, new Date(Date.UTC(2026, 3, 5)), 'x', true],
    [],
    ['SO-2', null, null, 'y', false],
    ['  SO-3 ', -3, new Date(Date.UTC(2026, 3, 7)), '', null],
  ], { cellDates: true });
  payments.F3 = { t: 'e', v: 0x2A };
  payments['!ref'] = 'A1:F7';
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Read me first'], [], ['Terms']]), 'Disclaimer');
  XLSX.utils.book_append_sheet(workbook, payments, 'Order Payments');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['id', 'qty'], ['A', 1], ['B', 2]]), 'Sale Orders');
  return workbook;
}

function sampleFile(format) {
  const workbook = sampleWorkbook();
  if (format === 'csv' || format === 'tsv') {
    const text = XLSX.utils.sheet_to_csv(workbook.Sheets['Order Payments'], { FS: format === 'tsv' ? '\t' : ',' });
    return Buffer.from(text);
  }
  if (format === 'html') {
    const single = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(single, workbook.Sheets['Order Payments'], 'Order Payments');
    return XLSX.write(single, { type: 'buffer', bookType: 'html' });
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: format });
}

// A Buffer that owns its whole ArrayBuffer, like multer's upload buffers.
function ownedBuffer(bytes) {
  const owned = Buffer.alloc(bytes.length);
  bytes.copy(owned);
  return owned;
}

function inThreadError(buffer) {
  try {
    XLSX.read(buffer, { type: 'buffer' });
  } catch (error) {
    return error.message;
  }
  throw new Error('expected XLSX.read to fail');
}

describe('spreadsheet worker: sheet_to_json output', () => {
  const parser = createSpreadsheetParser({ maxWorkers: 2 });

  it.each(['xlsx', 'biff8', 'xlsb', 'ods', 'xlml', 'html', 'csv', 'tsv'])(
    'matches the in-thread parse for every handler option set (%s)',
    async (format) => {
      const buffer = sampleFile(format);
      await Promise.all(HANDLER_OPTIONS.map(async ([, read, json]) => {
        const legacy = XLSX.read(buffer, { type: 'buffer', ...read });
        const book = await parser.parse(buffer, { read, json });
        expect(book.SheetNames).toEqual(legacy.SheetNames);
        expect(Object.keys(book.Sheets)).toEqual(legacy.SheetNames);
        for (const name of legacy.SheetNames) {
          expect(book.Sheets[name]).toStrictEqual(XLSX.utils.sheet_to_json(legacy.Sheets[name], json));
        }
      }));
    },
    30_000,
  );

  it('returns Date objects for date cells read with cellDates', async () => {
    const book = await parseSpreadsheet(sampleFile('xlsx'), { read: { cellDates: true }, sheets: 1, json: { range: 1 } });
    expect(book.Sheets['Order Payments'][0]['Payment Date']).toBeInstanceOf(Date);
  });
});

describe('spreadsheet worker: values mode', () => {
  const SETTLEMENT_READ = { cellDates: false, cellNF: false, cellStyles: false };
  const SETTLEMENT_HEADERS = [
    'settlement-id', 'total-amount', 'transaction-type', 'amount-type', 'amount-description', 'amount',
    'posted-date', 'quantity-purchased', 'currency', 'order-item-code', 'sku', 'Unknown',
  ];

  // Settlement-shaped sheet with a blank row, a repeated header, error cells
  // and (patched into the XML) error codes SheetJS does not know, which leave
  // a cell with `v: undefined`.
  function settlementXlsx() {
    const sheet = XLSX.utils.aoa_to_sheet([
      SETTLEMENT_HEADERS,
      ['S-1', 1250.75, '', '', '', '', '', '', 'INR'],
      ['S-1', '', 'Order', 'ItemPrice', 'Principal', 899, '05.04.2026', 1, 'INR', 12345678901234, 'SKU-1'],
      [],
      ['', '', 'Order', 'ItemFees', 'Commission', -45.5, '05.04.2026', '', '', '1.2345678901234E+13', 'SKU-1'],
      SETTLEMENT_HEADERS,
      ['S-1', '', 'Refund', 'ItemPrice', 'Principal', 'oops', '06.04.2026', 2, 'inr', '', 'SKU-2'],
    ]);
    sheet.L1 = { t: 'e', v: 0x2A };
    sheet.K7 = { t: 'e', v: 0x2A };
    sheet.J7 = { t: 'e', v: 0x07 };
    sheet['!ref'] = 'A1:L8';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Settlement');
    const zip = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
    const entry = zip.FileIndex[zip.FullPaths.findIndex(path => /worksheets\/sheet1\.xml$/.test(path))];
    entry.content = Buffer.from(Buffer.from(entry.content).toString('utf8').replaceAll('<v>#N/A</v>', '<v>#SPILL!</v>'));
    return Buffer.from(XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' }));
  }

  function settlementTsv() {
    return Buffer.from([
      SETTLEMENT_HEADERS.join('\t'),
      ['S-2', '99.5', '', '', '', '', '', '', 'INR'].join('\t'),
      ['S-2', '', 'Order', 'ItemPrice', 'Principal', '899.00', '05.04.2026', '1', 'INR', '12345678901234', 'SKU-1'].join('\t'),
      '',
      ['', '', 'ServiceFee', 'other-transaction', 'Storage Fee', '-12.5', '07.04.2026', '', 'INR', '', ''].join('\t'),
    ].join('\n'));
  }

  // How processAmazonSettlementWorkbook reads a header row.
  const headersOf = row => row.map(c => ((c && c.v !== undefined ? c.v : c) ?? '').toString().trim());

  it.each([['xlsx', settlementXlsx], ['tsv', settlementTsv]])(
    'gives the settlement reader exactly what the dense worksheet gave it (%s)',
    async (_format, makeFile) => {
      const buffer = makeFile();
      const legacy = XLSX.read(buffer, { type: 'buffer', dense: true, ...SETTLEMENT_READ });
      const book = await parseSpreadsheet(buffer, { read: SETTLEMENT_READ, values: true });

      for (const name of legacy.SheetNames) {
        const ws = legacy.Sheets[name];
        const rows = book.Sheets[name];
        const expected = [];
        expected.length = Math.min(ws.length, XLSX.utils.decode_range(ws['!ref']).e.r + 1);
        for (let r = 0; r < expected.length; r++) {
          if (ws[r]) expected[r] = ws[r].map(cell => (cell.v !== undefined && cell.v !== null ? cell.v : { ...cell }));
        }
        expected['!ref'] = ws['!ref'];
        expect(rows).toStrictEqual(expected);

        const headers = headersOf(rows[0]);
        expect(headers).toStrictEqual(headersOf(ws[0]));
        const idx = buildHeaderIndex(headers);
        for (let r = 1; r < expected.length; r++) {
          if (!ws[r]) continue;
          expect(parseAmazonSettlementLine(rows[r], idx, { fallbackSettlementId: 'S-0' }))
            .toStrictEqual(parseAmazonSettlementLine(ws[r], idx, { fallbackSettlementId: 'S-0' }));
        }
      }
    },
  );

  it('keeps cells without a value as objects', async () => {
    const book = await parseSpreadsheet(settlementXlsx(), { read: SETTLEMENT_READ, values: true });
    const rows = book.Sheets.Settlement;
    expect(rows[0][11]).toMatchObject({ t: 'e', w: '#SPILL!' });
    expect('v' in rows[0][11]).toBe(true);
    expect(rows[6][9]).toBe(0x07);
    expect(3 in rows).toBe(false);
  });
});

describe('spreadsheet worker: sheet selection', () => {
  const buffer = sampleFile('xlsx');

  it('parses only the sheets in `sheets` but lists every sheet name', async () => {
    // Names match case-insensitively, as in XLSX.read.
    const book = await parseSpreadsheet(buffer, { sheets: ['order payments'], json: { header: 1 } });
    expect(book.SheetNames).toEqual(['Disclaimer', 'Order Payments', 'Sale Orders']);
    expect(Object.keys(book.Sheets)).toEqual(['Order Payments']);
  });

  it('applies `sheets` to formats that XLSX.read does not filter', async () => {
    const book = await parseSpreadsheet(sampleFile('biff8'), { sheets: 0, json: {} });
    expect(Object.keys(book.Sheets)).toEqual(['Disclaimer']);
    const csv = await parseSpreadsheet(sampleFile('csv'), { sheets: ['Orders'], json: {} });
    expect(csv.SheetNames).toEqual(['Sheet1']);
    expect(Object.keys(csv.Sheets)).toEqual([]);
  });

  it('lets select choose from all sheet names on the calling thread', async () => {
    const seen = [];
    const book = await parseSpreadsheet(buffer, {
      select: (names) => {
        seen.push(...names);
        return ['Sale Orders', 'Missing', 'Sale Orders'];
      },
      json: { header: 1 },
    });
    expect(seen).toEqual(['Disclaimer', 'Order Payments', 'Sale Orders']);
    expect(Object.keys(book.Sheets)).toEqual(['Sale Orders']);
    expect(book.Sheets['Sale Orders']).toStrictEqual([['id', 'qty'], ['A', 1], ['B', 2]]);
  });

  it('rejects when select throws or does not return an array', async () => {
    await expect(parseSpreadsheet(buffer, { select: () => { throw new Error('no order sheet'); } }))
      .rejects.toThrow('no order sheet');
    await expect(parseSpreadsheet(buffer, { select: () => 'Sale Orders' })).rejects.toThrow(TypeError);
  });
});

describe('spreadsheet worker: input buffer', () => {
  it('moves an owned buffer into the worker when transfer is set', async () => {
    const buffer = ownedBuffer(sampleFile('xlsx'));
    const book = await parseSpreadsheet(buffer, { transfer: true, sheets: 2, json: { header: 1 } });
    expect(buffer.byteLength).toBe(0);
    expect(book.Sheets['Sale Orders']).toStrictEqual([['id', 'qty'], ['A', 1], ['B', 2]]);
  });

  it('copies by default and leaves the caller\'s buffer untouched', async () => {
    const buffer = ownedBuffer(sampleFile('xlsx'));
    const original = Buffer.from(buffer);
    await parseSpreadsheet(buffer, { json: {} });
    expect(buffer.equals(original)).toBe(true);
  });

  it('copies a buffer that shares its memory even when transfer is set', async () => {
    const bytes = sampleFile('xlsx');
    const backing = Buffer.alloc(bytes.length + 16);
    bytes.copy(backing, 8);
    const view = backing.subarray(8, 8 + bytes.length);
    await parseSpreadsheet(view, { transfer: true, json: {} });
    expect(backing.byteLength).toBe(bytes.length + 16);
    expect(view.equals(bytes)).toBe(true);
  });

  it('accepts an ArrayBuffer and rejects other input', async () => {
    const bytes = sampleFile('xlsx');
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    await expect(parseSpreadsheet(arrayBuffer, { sheets: 2 })).resolves.toMatchObject({
      Sheets: { 'Sale Orders': [{ id: 'A', qty: 1 }, { id: 'B', qty: 2 }] },
    });
    await expect(parseSpreadsheet('orders.xlsx')).rejects.toThrow(TypeError);
    await expect(parseSpreadsheet(bytes, { values: true, json: {} })).rejects.toThrow(TypeError);
    await expect(parseSpreadsheet(bytes, { select: 'Sale Orders' })).rejects.toThrow(TypeError);
  });
});

describe('spreadsheet worker: worker limit', () => {
  const buffer = sampleFile('xlsx');

  it('runs one parse at a time by default and queues the rest in order', async () => {
    const parser = createSpreadsheetParser();
    const finished = [];
    const jobs = [1, 2, 3].map(n => parser.parse(buffer, { json: {} }).then(() => finished.push(n)));
    expect(parser.running).toBe(1);
    expect(parser.queued).toBe(2);
    await Promise.all(jobs);
    expect(finished).toEqual([1, 2, 3]);
    await vi.waitFor(() => expect(parser.running).toBe(0));
  });

  it('runs up to maxWorkers parses at once', async () => {
    const parser = createSpreadsheetParser({ maxWorkers: 2 });
    const jobs = [1, 2, 3].map(() => parser.parse(buffer, { json: {} }));
    expect(parser.running).toBe(2);
    expect(parser.queued).toBe(1);
    await Promise.all(jobs);
    await vi.waitFor(() => expect(parser.running).toBe(0));
  });

  it('starts a queued parse, and takes its file, only after the previous parse has returned every row', async () => {
    const parser = createSpreadsheetParser();
    // Several chunks, so the first parse's rows arrive over several event-loop turns.
    const first = Buffer.from(Array.from({ length: 60_000 }, (_, i) => `OD-${i},${i},SKU-${i % 50}`).join('\n'));
    const second = ownedBuffer(buffer);
    const size = second.byteLength;
    let firstDone = false;
    let overlapped = false;
    let sampling = true;
    const sample = () => {
      if (!firstDone && (parser.queued === 0 || second.byteLength !== size)) overlapped = true;
      if (sampling) setImmediate(sample);
    };
    setImmediate(sample);

    const jobs = [
      parser.parse(first, { json: { header: 1 } }).then((book) => {
        firstDone = true;
        return book;
      }),
      parser.parse(second, { transfer: true, json: {} }),
    ];
    const [book] = await Promise.all(jobs);
    sampling = false;

    expect(book.Sheets.Sheet1).toHaveLength(60_000);
    expect(overlapped).toBe(false);
    expect(second.byteLength).toBe(0);
  }, 30_000);
});

describe('spreadsheet worker: failures', () => {
  it('rejects with the error XLSX.read throws and keeps working', async () => {
    const corrupt = Buffer.from('PK not really a zip archive');
    await expect(parseSpreadsheet(corrupt)).rejects.toThrow(inThreadError(corrupt));
    await expect(parseSpreadsheet(sampleFile('xlsx'), { sheets: 2 })).resolves.toMatchObject({
      Sheets: { 'Sale Orders': [{ id: 'A', qty: 1 }, { id: 'B', qty: 2 }] },
    });
  });

  it('fails only the parse when the worker runs out of memory', async () => {
    const parser = createSpreadsheetParser({ resourceLimits: { maxOldGenerationSizeMb: 32 } });
    const csv = Buffer.from(Array.from({ length: 200_000 }, (_, i) => `row-${i},${i},value-${i}-${i * 7}`).join('\n'));
    await expect(parser.parse(csv)).rejects.toMatchObject({ code: 'ERR_WORKER_OUT_OF_MEMORY', status: 413 });
    await expect(parser.parse(sampleFile('xlsx'), { sheets: 2 })).resolves.toMatchObject({
      Sheets: { 'Sale Orders': [{ id: 'A', qty: 1 }, { id: 'B', qty: 2 }] },
    });
  }, 30_000);

  it('stops a parse that runs past the time limit', async () => {
    const parser = createSpreadsheetParser({ timeoutMs: 1 });
    await expect(parser.parse(sampleFile('xlsx'))).rejects.toThrow(/took longer than/);
    await vi.waitFor(() => expect(parser.running).toBe(0));
  });
});

describe('spreadsheet worker: event loop', () => {
  // Longest gap between 1 ms timer ticks while `work` runs.
  async function longestStall(work) {
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 1);
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      await work();
    } finally {
      clearInterval(timer);
    }
    return Math.max(longest, performance.now() - last);
  }

  it('keeps timers running while a large workbook is parsed', async () => {
    const rows = Array.from({ length: 30_000 }, (_, r) => [
      `OD-${r}`, r, r * 1.5, `SKU-${r % 97}`, new Date(Date.UTC(2026, 0, 1 + (r % 300))), 'Delivered', r % 3 === 0, `note ${r}`,
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Order', 'Qty', 'Amount', 'SKU', 'Date', 'Status', 'Flag', 'Note'], ...rows]), 'Orders');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const read = { cellDates: true };
    const json = { header: 1, defval: '', raw: false };

    const inThread = await longestStall(async () => {
      XLSX.utils.sheet_to_json(XLSX.read(buffer, { type: 'buffer', ...read }).Sheets.Orders, json);
    });
    let book;
    const inWorker = await longestStall(async () => {
      book = await parseSpreadsheet(buffer, { read, json });
    });

    expect(book.Sheets.Orders).toHaveLength(30_001);
    expect(inWorker).toBeLessThan(inThread / 3);
  }, 60_000);
});
