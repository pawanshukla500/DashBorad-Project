import fs from 'node:fs';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Records every statement the rate-card routes send.
let statements;
let updateRows;

function recorder(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  statements.push({ sql, params });
  if (/^SELECT id, category, TO_CHAR\(start_date/i.test(sql)) {
    return { rows: [{ id: 17, category: 'salwar suit', marketplace: 'flipkart', seller_account: 'seller_ej' }], rowCount: 1 };
  }
  if (/^WITH ranked AS/i.test(sql)) {
    return { rows: [{ marketplace: 'flipkart', category: 'salwar suit', brand: 'Youthnic', sample_fsn: 'ABCDEFGHIJKLMNOP', sample_sku: 'SKU-EJ', order_count: 4 }], rowCount: 1 };
  }
  if (/SELECT DISTINCT TO_CHAR\(start_date/i.test(sql)) {
    return { rows: [{ start_date: '2026-04-01' }], rowCount: 1 };
  }
  if (/^UPDATE/i.test(sql)) return { rows: updateRows, rowCount: updateRows.length };
  return { rows: [], rowCount: 0 };
}

vi.mock('../db/index.js', () => ({
  isDbConfigured: async () => true,
  getPool: () => ({
    query: vi.fn(async (text, params) => recorder(text, params)),
    connect: vi.fn(async () => ({ query: vi.fn(async (text, params) => recorder(text, params)), release: vi.fn() })),
  }),
}));

const { default: rateCardRouter, dayBefore } = await import('../routes/rateCard.js');
const { calculateFees } = await import('../services/rateCard.js');

let server;
let baseUrl;
beforeEach(async () => {
  statements = [];
  updateRows = [{ start_date: '2026-04-01' }, { start_date: '2026-04-01' }];
  const app = express();
  app.use(express.json());
  app.use('/api/rate-card', rateCardRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/rate-card`;
});
afterEach(() => new Promise(resolve => server.close(resolve)));

const post = (path, body) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const newPeriod = {
  category: 'kurta',
  marketplace: 'flipkart',
  seller_account: 'default',
  start_date: '2026-10-01',
  end_date: null,
  rows: [{ brand_name: '', price_min: 0, price_max: 500, rate: 0.12 }],
};

describe('desktop category discovery API', () => {
  it('normalizes legacy category aliases and reads configured rows for the requested seller account', async () => {
    const response = await fetch(`${baseUrl}/config/commission?marketplace=flipkart&seller_account=seller_ej`);
    const body = await response.json();
    const read = statements.find(statement => statement.sql.startsWith('SELECT id, category, TO_CHAR'));

    expect(response.status).toBe(200);
    expect(read.params).toEqual(['flipkart', 'seller_ej']);
    expect(body.rows[0].category).toBe('salwar_kurta_dupatta');
    expect(read.sql).toContain("COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2");
  });

  it('normalizes an empty seller account to default and includes legacy default rows', async () => {
    const response = await fetch(`${baseUrl}/config/commission?marketplace=flipkart&seller_account=`);
    const read = statements.find(statement => statement.sql.startsWith('SELECT id, category, TO_CHAR'));
    expect(response.status).toBe(200);
    expect(read.params).toEqual(['flipkart', 'default']);
    expect(read.sql).toContain("COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2");
  });

  it('includes inherited default rows only when the worker requests them for an account', async () => {
    const response = await fetch(`${baseUrl}/config/commission?marketplace=flipkart&seller_account=seller_ej&active_only=true&active_date=2026-10-30&include_defaults=true`);
    const read = statements.find(statement => statement.sql.startsWith('SELECT id, category, TO_CHAR'));
    expect(response.status).toBe(200);
    expect(read.params).toEqual(['flipkart', 'seller_ej', '2026-10-30']);
    expect(read.sql).toContain("COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2 OR COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = 'default'");
    expect(read.sql).toContain('start_date <= $3::date');
    expect(read.sql).toContain('end_date >= $3::date');
  });

  it('returns an account-scoped FSN catalog with canonical category keys', async () => {
    const response = await fetch(`${baseUrl}/brand-fsn-catalog?marketplace=flipkart&seller_account=seller_ej`);
    const body = await response.json();
    const read = statements.find(statement => statement.sql.startsWith('WITH ranked AS'));

    expect(response.status).toBe(200);
    expect(read.params).toEqual(['flipkart', 'seller_ej']);
    expect(body.catalog[0].category).toBe('salwar_kurta_dupatta');
  });

  it('retires the legacy static-rate sync without reading or writing PostgreSQL', async () => {
    const response = await post('/sync-brand-rates', { forceUpdate: true });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'RATE_CARD_ENDPOINT_RETIRED',
    });
    expect(statements).toEqual([]);
  });

  it('filters active-only discovery to the supplied UTC extraction date', async () => {
    const response = await fetch(`${baseUrl}/config/commission?marketplace=flipkart&seller_account=seller_ej&active_only=true&active_date=2026-10-30`);
    expect(response.status).toBe(200);
    const read = statements.find(statement => statement.sql.startsWith('SELECT id, category, TO_CHAR'));
    expect(read.params).toEqual(['flipkart', 'seller_ej', '2026-10-30']);
    expect(read.sql).toContain('start_date <= $3::date');
    expect(read.sql).toContain('end_date >= $3::date');
  });

  it('rejects invalid active dates before reading rate-card tables', async () => {
    const response = await fetch(`${baseUrl}/config/commission?marketplace=flipkart&seller_account=seller_ej&active_only=true&active_date=2026-02-30`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/real date/);
    expect(statements).toEqual([]);
  });
});

describe('save-period — auto-close the current active rate', () => {
  it('ends every earlier period still running on the new start date, the day before, inside the save transaction', async () => {
    const response = await post('/config/commission/save-period', { ...newPeriod, auto_close: true });
    const body = await response.json();

    expect(response.status).toBe(200);
    const close = statements.find(s => s.sql.startsWith('UPDATE rc_commission'));
    expect(close.sql).toContain('start_date = $4::date');
    expect(close.sql).toContain('(end_date IS NULL OR end_date >= $5::date)');
    expect(close.params).toEqual(['kurta', 'flipkart', 'default', '2026-04-01', '2026-09-30', 'kurta']);
    const order = statements.map(s => s.sql.split(' ')[0]);
    expect(order.indexOf('UPDATE')).toBeGreaterThan(order.indexOf('BEGIN'));
    expect(order.indexOf('UPDATE')).toBeLessThan(order.indexOf('INSERT'));
    expect(order.at(-1)).toBe('COMMIT');
    expect(body.closed).toEqual({ rows: 2, end_date: '2026-09-30', period_starts: ['2026-04-01'] });
  });

  it('matches category case-insensitively and with normalized key', async () => {
    const response = await post('/config/commission/save-period', {
      ...newPeriod,
      category: 'Kurta',
      auto_close: true,
    });
    expect(response.status).toBe(200);
    const close = statements.find(s => s.sql.startsWith('UPDATE rc_commission'));
    expect(close.sql).toContain('LOWER(TRIM(category)) = LOWER(TRIM($1))');
    expect(close.params[0]).toBe('Kurta');
    expect(close.params[5]).toBe('kurta');
  });

  it('does not close anything for a bounded (historical) period or when auto-close is off', async () => {
    await post('/config/commission/save-period', { ...newPeriod, end_date: '2026-10-15', auto_close: true });
    await post('/config/commission/save-period', { ...newPeriod, auto_close: false });
    await post('/config/commission/save-period', newPeriod);
    expect(statements.some(s => s.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('rejects a malformed date with a 400 before touching the database', async () => {
    const response = await post('/config/commission/save-period', { ...newPeriod, start_date: '2026-02-30' });
    expect(response.status).toBe(400);
    expect(statements).toHaveLength(0);
  });
});

describe('close-period — resolve an overlap left by earlier saves', () => {
  const period = { category: 'kurta', marketplace: 'flipkart', seller_account: 'default', start_date: '2026-04-01', end_date: null };

  it('ends exactly the requested period', async () => {
    const response = await post('/config/fixed_fee/close-period', { ...period, close_on: '2026-08-31' });
    expect(response.status).toBe(200);
    const update = statements.find(s => s.sql.startsWith('UPDATE rc_fixed_fee'));
    const lock = statements.findIndex(s => s.sql.includes("hashtext('rate_card_publish_lock')"));
    expect(update.sql).toContain('start_date IS NOT DISTINCT FROM $4::date AND end_date IS NOT DISTINCT FROM $5::date');
    expect(update.params).toEqual(['kurta', 'flipkart', 'default', '2026-04-01', null, '2026-08-31', 'kurta']);
    expect(lock).toBeGreaterThan(statements.findIndex(s => s.sql === 'BEGIN'));
    expect(lock).toBeLessThan(statements.indexOf(update));
  });

  it.each([
    [{ close_on: '2026-03-31' }, 'before the period start'],
    [{ end_date: '2026-08-31', close_on: '2026-09-15' }, 'earlier than the current end date'],
    [{ close_on: undefined }, 'close_on is required'],
  ])('rejects an invalid close date (%o)', async (change, message) => {
    const response = await post('/config/fixed_fee/close-period', { ...period, ...change });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(message);
    expect(statements).toHaveLength(0);
  });

  it('returns 404 when the period does not exist', async () => {
    updateRows = [];
    const response = await post('/config/fixed_fee/close-period', { ...period, close_on: '2026-08-31' });
    expect(response.status).toBe(404);
  });
});

describe('rate-card mutation serialization', () => {
  it('takes the publication lock before single-row insert, update, and delete writes', async () => {
    const operations = [
      { method: 'POST', path: '/config/commission', sql: 'INSERT INTO rc_commission', body: {
        category: 'kurta', marketplace: 'flipkart', seller_account: 'default', start_date: '2026-10-01',
        price_min: 0, price_max: 500, brand_name: '', rate: 0.12,
      } },
      { method: 'PUT', path: '/config/commission/17', sql: 'UPDATE rc_commission', body: { rate: 0.12 } },
      { method: 'DELETE', path: '/config/commission/17', sql: 'DELETE FROM rc_commission' },
    ];
    for (const operation of operations) {
      statements = [];
      const response = await fetch(`${baseUrl}${operation.path}`, {
        method: operation.method,
        headers: { 'Content-Type': 'application/json' },
        ...(operation.body ? { body: JSON.stringify(operation.body) } : {}),
      });
      expect(response.status, operation.method).toBe(200);
      const mutationIndex = statements.findIndex(s => s.sql.startsWith(operation.sql));
      const lockIndex = statements.findIndex(s => s.sql.includes("hashtext('rate_card_publish_lock')"));
      expect(statements[0].sql).toBe('BEGIN');
      expect(lockIndex).toBeGreaterThan(0);
      expect(lockIndex).toBeLessThan(mutationIndex);
      expect(statements.at(-1).sql).toBe('COMMIT');
    }
  });

  it('locks before reading periods for auto-close-superseded', async () => {
    const response = await post('/config/fixed_fee/auto-close-superseded', {
      marketplace: 'flipkart', seller_account: 'default',
    });
    expect(response.status).toBe(200);
    const lockIndex = statements.findIndex(s => s.sql.includes("hashtext('rate_card_publish_lock')"));
    const readIndex = statements.findIndex(s => s.sql.startsWith('SELECT category, TO_CHAR'));
    expect(statements[0].sql).toBe('BEGIN');
    expect(lockIndex).toBeGreaterThan(0);
    expect(lockIndex).toBeLessThan(readIndex);
    expect(statements.at(-1).sql).toBe('COMMIT');
  });

  it('locks before loading the rollback snapshot and does not mutate when it is missing', async () => {
    const response = await post('/versions/999/rollback', {});
    expect(response.status).toBe(404);
    const lockIndex = statements.findIndex(s => s.sql.includes("hashtext('rate_card_publish_lock')"));
    const versionReadIndex = statements.findIndex(s => s.sql === 'SELECT * FROM rate_card_versions WHERE id = $1');
    expect(statements[0].sql).toBe('BEGIN');
    expect(lockIndex).toBeGreaterThan(0);
    expect(lockIndex).toBeLessThan(versionReadIndex);
    expect(statements.at(-1).sql).toBe('ROLLBACK');
  });
});

describe('dayBefore', () => {
  it.each([
    ['2026-10-01', '2026-09-30'],
    ['2026-03-01', '2026-02-28'],
    ['2024-03-01', '2024-02-29'],
    ['2026-01-01', '2025-12-31'],
  ])('%s → %s', (input, expected) => {
    expect(dayBefore(input)).toBe(expected);
  });
});

describe('fee lookups on overlapping periods', () => {
  it('loads rate rows latest-period-first, the same rule as the SQL report paths', () => {
    const source = fs.readFileSync(new URL('../services/rateCard.js', import.meta.url), 'utf8');
    expect(source).toContain('start_date DESC NULLS LAST, id DESC');
  });

  it('reverse shipping uses only the latest effective period even if an older one has a smaller slab', () => {
    const rc = {
      commission: [], fixedFee: [], collectionFee: [], pickAndPack: [], franchiseFee: [],
      reverseShipping: [
        // newer period (rows arrive latest-first from the loader)
        { category: 'kurta', startDate: '2026-09-01', endDate: null, priceMin: 0, priceMax: 999999, weightSlab: '0-1 kg', local: 90, zonal: 90, national: 90 },
        // older period that was never closed, with a finer slab
        { category: 'kurta', startDate: '2026-04-01', endDate: null, priceMin: 0, priceMax: 999999, weightSlab: '0-0.5 kg', local: 60, zonal: 60, national: 60 },
      ],
    };
    const fees = calculateFees(rc, { category: 'kurta', price: 400, weight: 0.4, zone: 'local', isReturn: true, orderDate: '2026-10-05' });
    expect(fees.reverseShipping).toBe(90);
    const before = calculateFees(rc, { category: 'kurta', price: 400, weight: 0.4, zone: 'local', isReturn: true, orderDate: '2026-05-05' });
    expect(before.reverseShipping).toBe(60);
  });

  it('reverse shipping keeps a seller-account rate ahead of a newer default-account period', () => {
    const rc = {
      commission: [], fixedFee: [], collectionFee: [], pickAndPack: [], franchiseFee: [],
      reverseShipping: [
        // the loader returns the account's own rows first
        { category: 'kurta', sellerAccount: 'myntra_vb', startDate: '2026-04-01', endDate: null, priceMin: 0, priceMax: 999999, weightSlab: '0-1 kg', local: 70, zonal: 70, national: 70 },
        { category: 'kurta', sellerAccount: 'default', startDate: '2026-09-01', endDate: null, priceMin: 0, priceMax: 999999, weightSlab: '0-1 kg', local: 95, zonal: 95, national: 95 },
      ],
    };
    const fees = calculateFees(rc, { category: 'kurta', price: 400, weight: 0.4, zone: 'local', isReturn: true, orderDate: '2026-10-05' });
    expect(fees.reverseShipping).toBe(70);
  });

  it('serializes concurrent saves of the same category with a transaction lock', async () => {
    await post('/config/commission/save-period', { ...newPeriod, auto_close: true });
    const locks = statements.filter(s => s.sql.includes('pg_advisory_xact_lock'));
    expect(locks[0].sql).toContain("hashtext('rate_card_publish_lock')");
    expect(locks[1].params).toEqual(['rate-period:rc_commission:flipkart:default:kurta']);
    const order = statements.map(s => s.sql.split(' ')[0]);
    expect(order.indexOf('SELECT')).toBe(order.indexOf('BEGIN') + 1);
    expect(order.indexOf('SELECT', order.indexOf('SELECT') + 1)).toBe(order.indexOf('BEGIN') + 2);
  });
});
