import fs from 'node:fs';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SOR (invoice-level payment reconciliation) REST routes.
 *
 * The router is mounted on a real Express app against a stub pool that
 * records every statement, so the tests pin the HTTP contract (validation,
 * pagination, portal isolation, error shape) and the SQL each request sends.
 */

let statements;
let respond;

vi.mock('../db/index.js', () => ({
  getPool: () => ({
    query: vi.fn(async (text, params) => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      statements.push({ sql, params });
      return respond(sql, params);
    }),
  }),
}));

const { default: sorRouter } = await import('../routes/sor.js');
const initDbSource = fs.readFileSync(new URL('../db/initDb.js', import.meta.url), 'utf8');

let server;
let baseUrl;

beforeEach(async () => {
  statements = [];
  respond = () => ({ rows: [] });
  const app = express();
  app.use('/api/sor', sorRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise(resolve => server.close(resolve)));

const get = path => fetch(`${baseUrl}/api/sor${path}`);

describe('SOR routes — portal isolation', () => {
  it('returns 404 for a portal outside the four SOR sub-tabs without touching the DB', async () => {
    const response = await get('/flipkart/outstanding');
    expect(response.status).toBe(404);
    expect(statements).toHaveLength(0);
  });

  it('anchors every outstanding query on portal = $1', async () => {
    await get('/zepto/outstanding');
    expect(statements).toHaveLength(3);
    for (const { sql, params } of statements) {
      expect(sql).toContain('portal = $1');
      expect(params[0]).toBe('zepto');
    }
  });

  it('does not declare any write handlers (read-only API)', () => {
    const source = fs.readFileSync(new URL('../routes/sor.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/router\.(post|put|patch|delete)\(/);
  });
});

describe('SOR routes — outstanding ledger', () => {
  it('pages the ledger and reports the total of the filtered set', async () => {
    respond = sql => (sql.includes('COUNT(*) OVER ()')
      ? { rows: [{ invoice_id: 9, invoice_no: 'AJ-9', total_count: '137' }] }
      : sql.includes('GREATEST')
        ? { rows: [{ lastUploadAt: '2026-10-05T10:00:00.000Z' }] }
        : { rows: [{ invoiceCount: 137, totalOutstanding: '5000.00' }] });
    const response = await get('/reliance-ajio/outstanding?page=3&pageSize=25');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ page: 3, pageSize: 25, total: 137 });
    expect(body.rows).toEqual([{ invoice_id: 9, invoice_no: 'AJ-9' }]);
    expect(body.kpis).toMatchObject({ invoiceCount: 137, lastUploadAt: '2026-10-05T10:00:00.000Z' });
    const page = statements.find(s => s.sql.includes('COUNT(*) OVER ()'));
    expect(page.params.slice(-2)).toEqual([25, 50]);
  });

  it('caps pageSize at 500', async () => {
    await get('/zepto/outstanding?pageSize=100000');
    const page = statements.find(s => s.sql.includes('COUNT(*) OVER ()'));
    expect(page.params.slice(-2)).toEqual([500, 0]);
  });

  it('searches invoice numbers server-side with LIKE wildcards escaped', async () => {
    await get(`/zepto/outstanding?invoice_no=${encodeURIComponent('INV_10%')}`);
    const page = statements.find(s => s.sql.includes('COUNT(*) OVER ()'));
    expect(page.sql).toContain('invoice_no ILIKE $2');
    expect(page.params[1]).toBe('%INV\\_10\\%%');
  });

  it('filters the table by ledger status but keeps the KPI tiles portal-wide', async () => {
    await get('/zepto/outstanding?status=open');
    const page = statements.find(s => s.sql.includes('COUNT(*) OVER ()'));
    const kpi = statements.find(s => s.sql.includes('"invoiceCount"'));
    expect(page.sql).toContain('ledger_status = $2');
    expect(kpi.sql).not.toContain('ledger_status = $');
  });

  it('sorts only by allow-listed columns', async () => {
    await get('/zepto/outstanding?sort=outstanding&dir=asc');
    const page = statements.find(s => s.sql.includes('COUNT(*) OVER ()'));
    expect(page.sql).toContain('ORDER BY outstanding ASC NULLS LAST');

    const rejected = await get(`/zepto/outstanding?sort=${encodeURIComponent('invoice_no; DROP TABLE orders')}`);
    expect(rejected.status).toBe(400);
  });

  it.each([
    ['from=2026-13-45', 'from'],
    ['to=yesterday', 'to'],
    ['status=paid', 'status'],
  ])('rejects an invalid filter (%s) with a 400 before querying', async (query, label) => {
    const response = await get(`/zepto/outstanding?${query}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(label);
    expect(statements).toHaveLength(0);
  });

  it('reports aging buckets and the last upload time in the KPIs', async () => {
    await get('/zepto/outstanding');
    const kpi = statements.find(s => s.sql.includes('"invoiceCount"'));
    for (const bucket of ['aging0to30', 'aging31to60', 'aging61to90', 'aging90plus', 'varianceInvoices']) {
      expect(kpi.sql).toContain(`"${bucket}"`);
    }
    expect(statements.some(s => s.sql.includes('FROM sor_upload_log'))).toBe(true);
  });

  it('does not leak database error text to the client', async () => {
    respond = () => { throw new Error('relation "sor_outstanding" does not exist'); };
    const response = await get('/zepto/outstanding');
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('relation');
    expect(body.error).toBe('Failed to load outstanding ledger');
  });
});

describe('SOR routes — invoice detail', () => {
  it.each(['abc', '1.5', '-3', '0', '99999999999999999999'])('rejects invoice id %s', async id => {
    const response = await get(`/zepto/invoice/${id}`);
    expect(response.status).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it('reads the header from sor_outstanding pinned to the portal and groups lines by line_type', async () => {
    respond = sql => (sql.includes('FROM sor_outstanding')
      ? { rows: [{ invoice_id: 5, invoice_no: 'Z-5' }] }
      : {
        rows: [
          { id: 1, line_type: 'sale' },
          { id: 2, line_type: 'deduction' },
          { id: 3, line_type: 'payment' },
        ],
      });
    const response = await get('/zepto/invoice/5');
    const body = await response.json();
    expect(statements[0].sql).toContain('WHERE invoice_id = $1 AND portal = $2');
    expect(statements[0].params).toEqual(['5', 'zepto']);
    expect(body.invoice.invoice_no).toBe('Z-5');
    expect(body.lines.sale).toHaveLength(1);
    expect(body.lines.deduction).toHaveLength(1);
    expect(body.lines.payment).toHaveLength(1);
    expect(body.lines.return).toEqual([]);
  });

  it('returns 404 for an invoice of another portal', async () => {
    const response = await get('/zepto/invoice/5');
    expect(response.status).toBe(404);
  });
});

describe('SOR accounting ledger — schema contract', () => {
  it('replaces the sor_outstanding view on every start', () => {
    expect(initDbSource).toContain('CREATE OR REPLACE VIEW sor_outstanding AS');
  });

  it('computes outstanding as sale − payment − return − deduction', () => {
    expect(initDbSource).toContain('const outstanding = `(${sale} - ${payment} - ${returned} - ${deduction})`');
  });

  it('excludes payments from variance (a fully paid invoice has no variance)', () => {
    expect(initDbSource).toContain('const expected = `(${sale} - ${returned} - ${deduction})`');
    expect(initDbSource).toContain('(i.net_payable - ${expected})            AS variance');
  });

  it('enforces the line_type CHECK constraint on sor_invoice_line', () => {
    expect(initDbSource).toContain("CHECK (line_type IN ('sale', 'payment', 'return', 'deduction'))");
  });

  it('runs SOR migrations transactionally and does not bump the full-pass schema version', () => {
    expect(initDbSource).toContain("const CURRENT_SCHEMA_VERSION = '2026.10.sor-invoice-1';");
    expect(initDbSource).toContain('runVersionedMigration(pool, SOR_LEDGER_SCHEMA_VERSION');
    expect(initDbSource).toContain('runVersionedMigration(pool, SOR_INVOICE_SCHEMA_VERSION');
    const ledger = initDbSource.slice(initDbSource.indexOf('async function ensureSorLedgerSchema'), initDbSource.indexOf('async function ensureSorForeignKeyDedupe'));
    expect(ledger).not.toContain('.catch(');
  });

  it('indexes the FK columns that ON DELETE SET NULL scans', () => {
    expect(initDbSource).toContain('ON sor_invoice_line(order_row_id) WHERE order_row_id IS NOT NULL');
    expect(initDbSource).toContain('ON sor_invoice_line(settlement_id) WHERE settlement_id IS NOT NULL');
  });
});
