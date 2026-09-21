import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

// Records every statement the save-period transaction sends.
let statements;

vi.mock('../db/index.js', () => ({
  isDbConfigured: async () => true,
  getPool: () => ({
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(async () => ({
      query: vi.fn(async (text, params) => {
        statements.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
        return { rows: [], rowCount: /^DELETE/i.test(String(text).trim()) ? (params?.[0]?.length || 0) : 0 };
      }),
      release: vi.fn(),
    })),
  }),
}));

const { default: rateCardRouter } = await import('../routes/rateCard.js');

let server;
let baseUrl;

beforeEach(async () => {
  statements = [];
  const app = express();
  app.use(express.json());
  app.use('/api/rate-card', rateCardRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise(resolve => server.close(resolve)));

function savePeriod(body) {
  return fetch(`${baseUrl}/api/rate-card/config/commission/save-period`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const period = {
  marketplace: 'flipkart',
  seller_account: 'default',
  category: 'kurta',
  start_date: '2026-09-01',
  end_date: null,
};

describe('rate-card save-period', () => {
  it('replaces rows by their exact BIGINT ids (ids above 2^53 were rounded and the int[] cast overflowed)', async () => {
    const bigId = '1200529523772653768'; // real production id shape
    const response = await savePeriod({
      ...period,
      replaceIds: [bigId],
      rows: [{ brand_name: '', price_min: 0, price_max: 500, rate: 0.12 }],
    });

    expect(response.status).toBe(200);
    const remove = statements.find(statement => statement.text.startsWith('DELETE'));
    expect(remove.text).toContain('ANY($1::bigint[])');
    expect(remove.params).toEqual([[bigId]]); // not 1200529523772653800
    expect(statements.at(-1).text).toBe('COMMIT');
  });

  it('rejects a blank rate with a 400 instead of sending an empty string to a NUMERIC column', async () => {
    const response = await savePeriod({
      ...period,
      rows: [
        { brand_name: '', price_min: 0, price_max: 500, rate: 0.12 },
        { brand_name: '', price_min: 501, price_max: 1000, rate: '' },
      ],
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Row 2: rate is required');
    expect(statements).toHaveLength(0);
  });

  it('gives blank numeric cells their column default and leaves text cells unchanged', async () => {
    const response = await savePeriod({
      ...period,
      rows: [{ brand_name: '', price_min: '', price_max: ' ', rate: 0.1 }],
    });

    expect(response.status).toBe(200);
    const insert = statements.find(statement => statement.text.startsWith('INSERT INTO rc_commission'));
    // category, start_date, end_date, marketplace, seller_account, brand_name, price_min, price_max, rate
    expect(insert.params).toEqual(['kurta', '2026-09-01', null, 'flipkart', 'default', '', 0, 999999, 0.1]);
  });

  it('refuses malformed replacement ids before touching the database', async () => {
    const response = await savePeriod({
      ...period,
      replaceIds: ['12', 'drop table'],
      rows: [{ brand_name: '', price_min: 0, price_max: 500, rate: 0.1 }],
    });

    expect(response.status).toBe(400);
    expect(statements).toHaveLength(0);
  });
});
