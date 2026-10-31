import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/index.js', () => ({ getPool: () => ({ query }) }));
import { workerJobsRouter } from '../routes/workerJobs.js';

let server;
afterEach(async () => {
  query.mockReset();
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
});

async function listen() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { email: 'operator@example.com' }; next(); });
  app.use('/api/worker-jobs', workerJobsRouter);
  server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

describe('discard worker extraction results', () => {
  it('cancels and clears a completed job only for its worker lease owner', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: '17', status: 'cancelled' }] });
    const response = await fetch(`${await listen()}/api/worker-jobs/17/discard-results`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: 'worker-a', reason: 'account changed' })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, discarded: true });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/status = 'cancelled'/);
    expect(sql).toMatch(/results = NULL, diff_summary = NULL/);
    expect(sql).toMatch(/status IN \('queued', 'claimed', 'running', 'completed'\)/);
    expect(sql).toMatch(/lease_worker_id = \$2/);
    expect(params).toEqual(['17', 'worker-a', 'operator@example.com', 'account changed']);
  });

  it('allows the job creator to clean up an unleased sync job and makes cleanup idempotent', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      id: '19', status: 'cancelled', lease_worker_id: null, created_by: 'operator@example.com'
    }] });
    const response = await fetch(`${await listen()}/api/worker-jobs/19/discard-results`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'submission failed' })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, alreadyDiscarded: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toMatch(/created_by = \$3/);
  });

  it('refuses cleanup when the caller owns neither the lease nor the job', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      id: '20', status: 'completed', lease_worker_id: 'worker-b', created_by: 'another@example.com'
    }] });
    const response = await fetch(`${await listen()}/api/worker-jobs/20/discard-results`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worker_id: 'worker-a' })
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'JOB_NOT_OWNED_OR_ACTIVE' });
  });
});
