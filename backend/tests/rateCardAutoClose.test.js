import fs from 'node:fs';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Records every statement the rate-card routes send.
let statements;
let updateRows;

function recorder(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  statements.push({ sql, params });
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

describe('save-period — auto-close the current active rate', () => {
  it('ends every earlier period still running on the new start date, the day before, inside the save transaction', async () => {
    const response = await post('/config/commission/save-period', { ...newPeriod, auto_close: true });
    const body = await response.json();

    expect(response.status).toBe(200);
    const close = statements.find(s => s.sql.startsWith('UPDATE rc_commission'));
    expect(close.sql).toContain('(start_date IS NULL OR start_date < $4::date)');
    expect(close.sql).toContain('(end_date IS NULL OR end_date >= $4::date)');
    expect(close.params).toEqual(['kurta', 'flipkart', 'default', '2026-10-01', '2026-09-30']);
    const order = statements.map(s => s.sql.split(' ')[0]);
    expect(order.indexOf('UPDATE')).toBeGreaterThan(order.indexOf('BEGIN'));
    expect(order.indexOf('UPDATE')).toBeLessThan(order.indexOf('INSERT'));
    expect(order.at(-1)).toBe('COMMIT');
    expect(body.closed).toEqual({ rows: 2, end_date: '2026-09-30', period_starts: ['2026-04-01'] });
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
    expect(update.sql).toContain('start_date IS NOT DISTINCT FROM $4::date AND end_date IS NOT DISTINCT FROM $5::date');
    expect(update.params).toEqual(['kurta', 'flipkart', 'default', '2026-04-01', null, '2026-08-31']);
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
});
