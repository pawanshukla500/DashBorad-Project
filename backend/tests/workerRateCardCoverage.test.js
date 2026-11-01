import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { parsePortalRateSnapshot } from '../../desktop/portalRates.js';
import { normalizeScrapedCards } from '../../desktop/scrapeResults.js';
import { rateFixture } from '../../desktop/tests/fixtures/portalRateFixture.js';

const mockState = vi.hoisted(() => ({
  query: vi.fn(),
  compare: vi.fn(),
  publish: vi.fn(),
  job: null,
  configRows: {},
  fsnRows: [],
}));

vi.mock('../db/index.js', () => ({ getPool: () => ({ query: mockState.query }) }));
vi.mock('../services/rateCardCanonicalEngine.js', () => ({ compareScrapedRatesWithActive: mockState.compare }));
vi.mock('../services/rateCardPublisher.js', () => ({ publishRateCardObservations: mockState.publish }));

import { workerJobsRouter } from '../routes/workerJobs.js';

let server;
let observations;

function job({ status = 'running' } = {}) {
  return {
    id: 'rate-job-1', status, job_type: 'RATE_CARD_SCRAPE', marketplace: 'flipkart',
    seller_account: 'default', parameters: { verticals: ['kurta'] }, lease_worker_id: null,
    lease_expires_at: null, created_by: 'operator@example.com',
    results: observations, diff_summary: { fingerprint: 'review-fingerprint', effectiveDate: '2026-10-30' },
    created_at: '2026-10-30T10:00:00.000Z', completed_at: '2026-10-30T10:00:00.000Z',
  };
}

async function listen() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { email: 'admin@example.com', role: 'admin' }; next(); });
  app.use('/api/worker-jobs', workerJobsRouter);
  server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(base, path, body = {}) {
  return fetch(`${base}/api/worker-jobs/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockState.query.mockReset();
  mockState.compare.mockReset();
  mockState.publish.mockReset();
  mockState.job = job();
  mockState.configRows = {
    rc_commission: [{ category: 'kurta' }],
    rc_fixed_fee: [{ category: 'dress' }],
    rc_collection_fee: [], rc_pick_pack: [], rc_reverse_shipping: [], rc_franchise_fee: [],
  };
  mockState.fsnRows = [
    { category: 'kurta', order_rows: 1, valid_fsn_order_rows: 1 },
    { category: 'dress', order_rows: 1, valid_fsn_order_rows: 1 },
  ];
  mockState.compare.mockResolvedValue({ fingerprint: 'server-fingerprint', effectiveDate: '2026-10-30', diffs: [], diffCount: 0, summary: {} });
  mockState.publish.mockResolvedValue({ published: true });
  mockState.query.mockImplementation(async sql => {
    const text = String(sql);
    if (text.includes('FROM worker_jobs WHERE id = $1')) return { rows: mockState.job ? [mockState.job] : [] };
    const table = Object.keys(mockState.configRows).find(name => text.includes(`FROM ${name}`));
    if (table) return { rows: mockState.configRows[table] };
    if (text.includes('FROM orders')) return { rows: mockState.fsnRows };
    if (text.includes("SET \n        status = 'completed'")) return { rows: [{ ...mockState.job, status: 'completed' }] };
    throw new Error(`Unexpected worker route query: ${text}`);
  });
  observations = normalizeScrapedCards(['FBF', 'NON_FBF'].map(fulfilment => parsePortalRateSnapshot(
    rateFixture(fulfilment), { vertical: 'kurta', marketplace: 'flipkart', fulfilment, effectiveDate: '2026-10-30', portalVertical: 'kurta' }
  )));
});

afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
});

describe('worker rate-card category coverage boundary', () => {
  it('rejects results missing a configured category despite caller-supplied vertical parameters', async () => {
    mockState.job = job();
    const response = await post(await listen(), 'rate-job-1/results', { results: observations });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'RATE_CARD_COVERAGE_INCOMPLETE',
      error: expect.stringContaining('Missing configured rate-card categories: dress'),
    });
    expect(mockState.compare).not.toHaveBeenCalled();
    expect(mockState.query.mock.calls.some(([sql]) => String(sql).includes("status = 'completed'"))).toBe(false);
  });

  it('skips a configured category without an account FSN and accepts the complete FSN-backed scope', async () => {
    mockState.job = job();
    mockState.fsnRows = [
      { category: 'kurta', order_rows: 10, valid_fsn_order_rows: 10 },
      { category: 'dress', order_rows: 2, valid_fsn_order_rows: 0 },
    ];
    const response = await post(await listen(), 'rate-job-1/results', { results: observations });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.diffResult.coverage).toMatchObject({
      configuredCategories: ['dress', 'kurta'],
      fsnBackedConfiguredCategories: ['kurta'],
      missingFsnCategories: ['dress'],
      configuredCategoriesWithOrdersButNoFsns: ['dress'],
      complete: true,
    });
    expect(mockState.compare).toHaveBeenCalledOnce();
  });

  it('persists the resolved UTC date on every result before review and publish', async () => {
    mockState.job = job();
    mockState.configRows = {
      rc_commission: [{ category: 'kurta' }],
      rc_fixed_fee: [], rc_collection_fee: [], rc_pick_pack: [],
      rc_reverse_shipping: [], rc_franchise_fee: [],
    };
    mockState.fsnRows = [{ category: 'kurta', order_rows: 1, valid_fsn_order_rows: 1 }];
    const withoutEffectiveDate = observations.map(row => {
      const { effectiveDate: _effectiveDate, ...rest } = row;
      return { ...rest, source_effective_date: '2026-10-30' };
    });

    const response = await post(await listen(), 'rate-job-1/results', { results: withoutEffectiveDate });
    expect(response.status).toBe(200);
    const completion = mockState.query.mock.calls.find(([sql]) => String(sql).includes("status = 'completed'"));
    const saved = JSON.parse(completion[1][0]);
    expect(saved.every(row => row.effectiveDate === '2026-10-30')).toBe(true);
    expect(saved.every(row => row.source_effective_date === '2026-10-30')).toBe(true);
    expect(mockState.compare.mock.calls[0][0].every(row => row.effectiveDate === '2026-10-30')).toBe(true);
    expect(mockState.compare.mock.calls[0][1].effectiveDate).toBe('2026-10-30');
  });

  it('rechecks actual configured coverage before publish and ignores a narrowed job parameter', async () => {
    mockState.job = job({ status: 'completed' });
    const response = await post(await listen(), 'rate-job-1/publish', { effectiveDate: '2026-10-30' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'RATE_CARD_COVERAGE_INCOMPLETE' });
    expect(mockState.publish).not.toHaveBeenCalled();
  });
});
