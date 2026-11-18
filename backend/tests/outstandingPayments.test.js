import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// These routes run against a mocked db/index.js and outstandingPaymentsService,
// so they never reach a real database, whatever the environment holds. (They
// used to call the live endpoints: with backend/.env and the SSH tunnel up that
// read production and PUT grace_period_days on its Myntra config.)
const mocks = vi.hoisted(() => {
  const pool = { query: vi.fn(async () => ({ rows: [] })) };
  return {
    state: { dbConfigured: false },
    pool,
    getPool: vi.fn(() => pool),
    computeOutstandingMatrix: vi.fn(),
    getOutstandingConfig: vi.fn(),
    updateOutstandingConfig: vi.fn(),
  };
});

vi.mock('../db/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isDbConfigured: async () => mocks.state.dbConfigured,
  getPool: (...args) => mocks.getPool(...args),
}));
vi.mock('../services/outstandingPaymentsService.js', async (importOriginal) => ({
  ...(await importOriginal()),
  computeOutstandingMatrix: (...args) => mocks.computeOutstandingMatrix(...args),
  getOutstandingConfig: (...args) => mocks.getOutstandingConfig(...args),
  updateOutstandingConfig: (...args) => mocks.updateOutstandingConfig(...args),
}));

const { default: reconcileRouter } = await import('../routes/reconcile.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/reconcile', reconcileRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/reconcile`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pool.query.mockImplementation(async () => ({ rows: [] }));
  mocks.state.dbConfigured = false;
});

const getJson = async (path) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
};

const putJson = async (path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

describe('Outstanding Payments endpoints without a configured database', () => {
  it('GET /outstanding/summary reports configured: false', async () => {
    expect(await getJson('/outstanding/summary')).toEqual({ status: 200, body: { configured: false } });
  });

  it('GET /outstanding/orders returns an empty page that echoes the pagination', async () => {
    expect(await getJson('/outstanding/orders?pageSize=10&page=2')).toEqual({
      status: 200,
      body: { configured: false, data: [], total: 0, total_amount: 0, page: 2, pageSize: 10 },
    });
  });

  it('GET /outstanding/invoices returns an empty page that echoes the pagination', async () => {
    expect(await getJson('/outstanding/invoices?pageSize=10')).toEqual({
      status: 200,
      body: {
        configured: false, data: [], total: 0, total_pending: 0, total_net_payable: 0, total_received: 0,
        page: 1, pageSize: 10,
      },
    });
  });

  it('GET and PUT /outstanding/config neither read nor write', async () => {
    expect(await getJson('/outstanding/config')).toEqual({ status: 200, body: { configured: false, data: [] } });
    expect(await putJson('/outstanding/config/myntra', { grace_period_days: 16 }))
      .toEqual({ status: 200, body: { configured: false } });

    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.getOutstandingConfig).not.toHaveBeenCalled();
    expect(mocks.updateOutstandingConfig).not.toHaveBeenCalled();
  });
});

describe('Outstanding Payments endpoints with a (mocked) database', () => {
  beforeEach(() => {
    mocks.state.dbConfigured = true;
  });

  it('GET /outstanding/summary returns the computed matrix for the request filters', async () => {
    const matrix = {
      configured: true,
      kpis: { unsettled: 1200, settled_not_paid: 300, settled_adjusted: 0, cashback: 0, total_outstanding: 1500 },
      b2c: { channels: [{ channel_key: 'myntra', has_accounts: true, accounts: [{ account_key: 'myntra_ej' }, { account_key: 'myntra_vb' }] }] },
      d2c: { vendors: [{ vendor_key: 'phonepe', vendor_name: 'PhonePe' }] },
    };
    mocks.computeOutstandingMatrix.mockResolvedValueOnce(matrix);

    expect(await getJson('/outstanding/summary?marketplace=myntra')).toEqual({ status: 200, body: matrix });
    expect(mocks.computeOutstandingMatrix).toHaveBeenCalledWith(mocks.pool, { marketplace: 'myntra' });
  });

  it('GET /outstanding/orders scopes the query to the requested marketplace', async () => {
    // The route runs a page query and a count query together.
    mocks.pool.query.mockResolvedValue({ rows: [{ total: 0, total_amount: 0 }] });

    const { status, body } = await getJson('/outstanding/orders?marketplace=flipkart&pageSize=5');

    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 0, page: 1, pageSize: 5 });
    const scoped = mocks.pool.query.mock.calls.filter(([sql, params]) =>
      /o\.marketplace = \$1/.test(sql) && params?.[0] === 'flipkart');
    expect(scoped.length).toBeGreaterThan(0);
  });

  it('GET /outstanding/config returns the stored channel configs', async () => {
    const rows = [{ channel_key: 'myntra', grace_period_days: 15, payment_cycle_days: 30, is_active: true }];
    mocks.getOutstandingConfig.mockResolvedValueOnce(rows);

    expect(await getJson('/outstanding/config')).toEqual({ status: 200, body: { success: true, data: rows } });
    expect(mocks.getOutstandingConfig).toHaveBeenCalledWith(mocks.pool);
  });

  it('PUT /outstanding/config/:channelKey passes only the validated fields', async () => {
    const updated = { channel_key: 'myntra', grace_period_days: 16, payment_cycle_days: 30, is_active: true };
    mocks.updateOutstandingConfig.mockResolvedValueOnce(updated);

    expect(await putJson('/outstanding/config/myntra', { grace_period_days: 16 }))
      .toEqual({ status: 200, body: { success: true, data: updated } });
    expect(mocks.updateOutstandingConfig).toHaveBeenCalledWith(mocks.pool, 'myntra', {
      grace_period_days: 16,
      payment_cycle_days: null,
      is_active: null,
    });
  });

  it('PUT /outstanding/config/:channelKey answers 404 for an unknown channel', async () => {
    mocks.updateOutstandingConfig.mockResolvedValueOnce(undefined);

    const { status, body } = await putJson('/outstanding/config/unknown_nonexistent_channel', { grace_period_days: 20 });
    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });

  it.each([
    [{ grace_period_days: 366 }, 'grace_period_days'],
    [{ grace_period_days: 'soon' }, 'grace_period_days'],
    [{ payment_cycle_days: -1 }, 'payment_cycle_days'],
    [{ is_active: 'yes' }, 'is_active'],
  ])('PUT /outstanding/config/:channelKey rejects %j before writing', async (body, field) => {
    const res = await putJson('/outstanding/config/myntra', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(field);
    expect(mocks.updateOutstandingConfig).not.toHaveBeenCalled();
  });
});
