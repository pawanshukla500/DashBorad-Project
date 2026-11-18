import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { mutationChangesReportData } from '../routes/index.js';
import { VERSION_IGNORED_TABLES } from '../services/reportCache.js';
import { mergeVbMasterRows, parseSkuMasterInput, RETURN_UPSERT_CONDITION, upsertSkuMasterRows } from '../routes/upload.js';
import { createHeaderIndex } from '../utils/headerIndex.js';
import { optionalNumber } from '../utils/valueParsers.js';
import { buildDateFormatMap, normalizeSqlDate } from '../utils/dateNormalizer.js';
import { transactionIdleTimeoutMs, transactionSessionLimitsSql } from '../db/index.js';
import { healAmazonOrderItemIds, refreshOrderSettlementTotals } from '../services/orderSettlementTotals.js';
import { MEESHO_SETTLEMENT_LOCK_KEY } from '../routes/meeshoUpload.js';
import { ORDER_SETTLEMENT_TOTALS_LOCK_KEY } from '../services/orderSettlementTotals.js';
import { parseSpreadsheet } from '../services/spreadsheetWorker.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const source = file => fs.readFileSync(path.resolve(file), 'utf-8');

describe('report cache is not wiped by desktop-worker control traffic', () => {
  it('keeps the cache across worker heartbeats, claims and job bookkeeping', () => {
    for (const workerPath of [
      '/workers/heartbeat', '/workers/register', '/workers/jobs/claim', '/workers/jobs/release',
      '/worker-jobs', '/worker-jobs/42/progress', '/worker-jobs/42/fail', '/worker-jobs/42/results',
      '/worker-jobs/42/discard-results', '/worker-jobs/42/cancel',
    ]) {
      expect(mutationChangesReportData('POST', workerPath), workerPath).toBe(false);
    }
  });

  it('still invalidates for data writes and rate-card publishing', () => {
    for (const dataPath of ['/upload/orders', '/upload/myntra/orders', '/mp-settlement/invoices/7', '/worker-jobs/42/publish', '/rate-card/save']) {
      expect(mutationChangesReportData('POST', dataPath), dataPath).toBe(true);
    }
    expect(mutationChangesReportData('DELETE', '/mp-settlement/invoices')).toBe(true);
    expect(mutationChangesReportData('GET', '/summary')).toBe(false);
  });

  it('ignores worker bookkeeping tables in the PostgreSQL write-counter version', () => {
    expect(VERSION_IGNORED_TABLES).toEqual(expect.arrayContaining(['workers', 'worker_jobs']));
  });
});

describe('SKU master upload with listings that share a VB EXPORT SKU', () => {
  const listing = (listingSku, marketplace, extra = {}) => parseSkuMasterInput({
    listing_sku: listingSku, master_sku: 'EJ1201-16001', marketplace, cogs: 0, category: '', ...extra,
  });

  it('collapses listings to one vb_sku_master row per master, keeping the last non-blank values', () => {
    const rows = mergeVbMasterRows([
      listing('FK-1', 'flipkart', { category: 'Kurta Set', cogs: 450, weight_slab: '0.5' }),
      listing('MY-1', 'myntra_vb', { product_name: 'Printed Kurta' }),
      listing('AMZ-1', 'amazon', { cogs: 475 }),
      { masterSku: 'EJ9999-1', category: null, cogs: 0, weightSlab: null, productName: null },
    ]);
    expect(rows).toHaveLength(2);
    const [master, other] = rows;
    expect(master[0]).toBe('EJ1201-16001');
    expect(master[1]).toBe('Kurta Set');
    expect(master[2]).toBe(475);
    expect(master[3]).toBeTruthy();
    expect(master[4]).toBe('Printed Kurta');
    expect(other).toEqual(['EJ9999-1', null, 0, null, null]);
  });

  it('never sends the same vb_export_sku twice in one upsert statement', async () => {
    const statements = [];
    const pool = {
      query: vi.fn(async (sql, params = []) => {
        statements.push({ sql, params });
        if (sql.includes('RETURNING')) return { rows: params.length ? [{ inserted: true }] : [] };
        return { rows: [], rowCount: 0 };
      }),
    };
    await upsertSkuMasterRows(pool, [listing('FK-1', 'flipkart'), listing('MY-1', 'myntra_vb'), listing('AMZ-1', 'amazon')]);
    const vbInsert = statements.find(statement => statement.sql.includes('INSERT INTO vb_sku_master'));
    expect(vbInsert).toBeDefined();
    const masters = vbInsert.params.filter((_, index) => index % 5 === 0);
    expect(masters).toEqual(['EJ1201-16001']);
  });
});

describe('Flipkart returns re-upload', () => {
  it('lets the same return take its new (cancelled) status on the same request date', () => {
    expect(RETURN_UPSERT_CONDITION).toContain('EXCLUDED.return_id IS NOT DISTINCT FROM returns.return_id');
    expect(RETURN_UPSERT_CONDITION).toContain("EXCLUDED.return_status IS DISTINCT FROM 'cancelled'");
    expect(RETURN_UPSERT_CONDITION).toContain('returns.return_requested_date IS NULL');
    expect(source('routes/upload.js')).toContain('RETURN_UPSERT_CONDITION,');
  });
});

describe('shared spreadsheet header index', () => {
  const normalize = text => text.toLowerCase().replace(/[\s_-]+/g, '');

  it('matches aliases by normalized name and keeps the first column per name', () => {
    const headers = createHeaderIndex(normalize);
    const row = { 'Order Line ID': '', order_line_id: 'L-2', 'Seller-ID': '10708' };
    expect(headers.column(row, 'order_line_id')).toBe('Order Line ID');
    expect(headers.column(row, 'seller id')).toBe('Seller-ID');
    expect(headers.column(row, 'missing')).toBeUndefined();
  });

  it('builds one index per column layout, shared by every row', () => {
    const normalizeSpy = vi.fn(normalize);
    const headers = createHeaderIndex(normalizeSpy);
    const rows = Array.from({ length: 1_000 }, (_, index) => ({ 'Order ID': `O-${index}`, Amount: index }));
    for (const row of rows) headers.column(row, 'order_id');
    expect(headers.indexFor(rows[0])).toBe(headers.indexFor(rows[999]));
    // Two headers plus one alias: normalized once each, not once per row.
    expect(normalizeSpy).toHaveBeenCalledTimes(3);
  });

  it('is used by the Myntra and payment/ledger importers instead of per-row scans', () => {
    const myntra = source('routes/myntraUpload.js');
    expect(myntra).toContain('createHeaderIndex(');
    expect(myntra).not.toContain('rowHeaderIndexes');
    const payments = source('routes/mpSettlement.js');
    expect(payments).toContain('createHeaderIndex(');
    expect(payments).not.toContain('Object.keys(row).find(');
  });
});

describe('negative currency text from Excel display formats', () => {
  it.each([
    ['-₹1,234', -1234], ['₹-1,234', -1234], ['(₹1,234.00)', -1234], ['₹(1,234.00)', -1234],
    ['  -₹ 1,234.56  ', -1234.56], ['Rs.-10', -10], ['INR 2,500/-', 2500], ['(250.00)', -250], ['+5', 5],
  ])('%s -> %s', (text, expected) => {
    expect(optionalNumber(text)).toBe(expected);
  });

  it.each(['12oops', '--5', '(-5)', '-(5)', '₹', '-', '1,2,3x'])('rejects %s', text => {
    expect(optionalNumber(text)).toBeNull();
  });
});

describe('date-column format detection', () => {
  it('settles day/month order from any decisive value, not only the first', async () => {
    const rows = [{ d: '4/5/26' }, { d: '' }, { d: '4/25/26' }, { d: '5/1/26' }];
    const formats = await buildDateFormatMap({ rows, dateFields: ['d'], valueFor: (row, key) => row[key] });
    expect(formats.d.format).toBe('MDY');
    expect(rows.map(row => row.d && normalizeSqlDate(row.d, formats.d))).toEqual(['2026-04-05', '', '2026-04-25', '2026-05-01']);
  });

  it('does not let a stray ISO value re-type an ambiguous d/m/y column', async () => {
    const rows = [{ d: '05/04/2026' }, { d: '2026-04-01' }, { d: '13/04/2026' }];
    const formats = await buildDateFormatMap({ rows, dateFields: ['d'], valueFor: (row, key) => row[key] });
    expect(formats.d.format).toBe('DMY');
  });

  it('renders default-format XLSX date cells as ISO text for text-reading uploads', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([['Order Date'], [{ t: 'n', v: 46117, z: XLSX.SSF.get_table()[14] }], [{ t: 'n', v: 46137, z: XLSX.SSF.get_table()[14] }]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Orders');
    const file = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const book = await parseSpreadsheet(file, { read: { cellDates: true, dateNF: 'yyyy-mm-dd' }, sheets: 0, json: { header: 1, defval: '', raw: false } });
    expect(book.Sheets.Orders.slice(1)).toStrictEqual([['2026-04-05'], ['2026-04-25']]);
    expect(source('routes/upload.js')).toContain("read: { cellDates: true, dateNF: 'yyyy-mm-dd' }");
    expect(source('routes/flipkartSettlement.js')).toContain("read: { raw: false, dateNF: 'yyyy-mm-dd' }");
  });

  it('keeps CSV dates and long IDs as text for invoice, ledger and SOR uploads', async () => {
    const csv = Buffer.from('Invoice Date,Order Line ID,Amount\n05/04/2026,132509375680735653501,"1,234.50"\n13/04/2026,1,(50)\n');
    const book = await parseSpreadsheet(csv, { read: { cellDates: true, raw: true }, sheets: 0, json: { defval: '' } });
    expect(book.Sheets.Sheet1).toStrictEqual([
      { 'Invoice Date': '05/04/2026', 'Order Line ID': '132509375680735653501', Amount: '1,234.50' },
      { 'Invoice Date': '13/04/2026', 'Order Line ID': '1', Amount: '(50)' },
    ]);
    expect(source('routes/mpSettlement.js')).toContain('read: { cellDates: true, raw: true }');
    expect(source('routes/sorUpload.js')).toContain('read: { cellDates: true, raw: true }');
  });
});

describe('transaction session limits', () => {
  it('clears the statement timeout but keeps a finite idle-in-transaction limit', () => {
    const previous = process.env.PG_TX_IDLE_TIMEOUT_MS;
    try {
      delete process.env.PG_TX_IDLE_TIMEOUT_MS;
      expect(transactionIdleTimeoutMs()).toBe(900_000);
      expect(transactionSessionLimitsSql()).toBe('SET statement_timeout = 0; SET idle_in_transaction_session_timeout = 900000;');
      process.env.PG_TX_IDLE_TIMEOUT_MS = '0';
      expect(transactionIdleTimeoutMs()).toBe(0);
      process.env.PG_TX_IDLE_TIMEOUT_MS = 'nonsense';
      expect(transactionIdleTimeoutMs()).toBe(900_000);
    } finally {
      if (previous === undefined) delete process.env.PG_TX_IDLE_TIMEOUT_MS;
      else process.env.PG_TX_IDLE_TIMEOUT_MS = previous;
    }
  });
});

describe('order settlement totals maintenance', () => {
  it('only sends changed or new rows to the upsert, so unchanged rows are never locked', async () => {
    const statements = [];
    const query = vi.fn(async sql => {
      statements.push(String(sql).replace(/\s+/g, ' ').trim());
      return { rowCount: 0, rows: [] };
    });
    await refreshOrderSettlementTotals({ query });
    const upsert = statements.find(text => text.startsWith('INSERT INTO order_settlement_totals'));
    expect(upsert).toContain('LEFT JOIN order_settlement_totals existing ON existing.order_item_id = fresh.order_item_id');
    expect(upsert).toContain('WHERE existing.order_item_id IS NULL OR');
    expect(upsert).toContain('fresh.net_bank::NUMERIC(14,2)');
    expect(upsert).toContain('fresh.row_count::BIGINT');
    expect(upsert).toContain('fresh.payment_date::DATE');
    // No DO UPDATE ... WHERE: that form still locks every conflicting row.
    expect(upsert).not.toMatch(/DO UPDATE SET[\s\S]*\bWHERE\b/);
  });

  it('never lets the startup Amazon heal block readiness', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failing = { query: vi.fn(async () => { throw new Error('canceling statement due to statement timeout'); }) };
      await expect(healAmazonOrderItemIds(failing)).resolves.toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    const healing = { query: vi.fn(async () => ({ rows: [{ healed_count: '3' }] })) };
    await expect(healAmazonOrderItemIds(healing)).resolves.toBe(3);
    const [sql] = healing.query.mock.calls[0];
    // Starts from orders that lack an id instead of sorting the whole ledger.
    expect(sql).toMatch(/WITH missing AS/);
    expect(sql).toMatch(/JOIN \(SELECT DISTINCT order_id, sku FROM missing\) m/);
  });
});

describe('concurrent upload and maintenance safety', () => {
  it('serializes Meesho settlement replacement before its DELETE', () => {
    expect(MEESHO_SETTLEMENT_LOCK_KEY).not.toBe(ORDER_SETTLEMENT_TOTALS_LOCK_KEY);
    const meesho = source('routes/meeshoUpload.js');
    const lock = meesho.indexOf('pg_advisory_xact_lock($1)\', [MEESHO_SETTLEMENT_LOCK_KEY]');
    const remove = meesho.indexOf('DELETE FROM meesho_settlement_items');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(remove);
  });

  it('refreshes settlement totals after Myntra payment edits, deletes and clears', () => {
    const payments = source('routes/mpSettlement.js');
    expect(payments.match(/await refreshMyntraSettlementModels\(/g)).toHaveLength(3);
  });

  it('runs VACUUM ANALYZE without the API read timeout and continues past a failing table', () => {
    const script = source('scripts/analyze-postgres.js');
    expect(script).toContain('statement_timeout: 0');
    expect(script).toMatch(/catch \(error\) \{[\s\S]*failed \+= 1/);
  });

  it('gives production shutdown time to drain uploads inside Docker\'s grace period', () => {
    expect(source('server.js')).toContain("process.env.NODE_ENV === 'production' ? 60_000 : 5_000");
    expect(source('../docker-compose.production.yml')).toContain('stop_grace_period: 75s');
  });
});
