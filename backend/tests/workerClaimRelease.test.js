import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/index.js', () => ({ getPool: () => ({ query }) }));
import { workersRouter } from '../routes/workerJobs.js';

let server;
afterEach(async () => {
  query.mockReset();
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
});

async function listen() {
  const app = express();
  app.use(express.json());
  app.use('/api/workers', workersRouter);
  server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

describe('worker late-claim release', () => {
  it('requeues only an active claim held by that worker and restores the attempt count', async () => {
    query.mockResolvedValue({ rows: [{ id: '17', status: 'queued' }] });
    const response = await fetch(`${await listen()}/api/workers/jobs/release`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: '17', worker_id: 'worker-a' })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, job: { id: '17', status: 'queued' } });
    expect(query.mock.calls[0][0]).toMatch(/status = 'queued'.*lease_worker_id = NULL.*attempts = GREATEST\(attempts - 1, 0\)/s);
    expect(query.mock.calls[0][0]).toMatch(/status = 'claimed'/);
    expect(query.mock.calls[0][1]).toEqual(['17', 'worker-a']);
  });

  it('rejects missing identifiers and stale or foreign leases', async () => {
    query.mockResolvedValue({ rows: [] });
    const base = await listen();
    const missing = await fetch(`${base}/api/workers/jobs/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(missing.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    const stale = await fetch(`${base}/api/workers/jobs/release`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: '17', worker_id: 'worker-a' })
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'LEASE_MISMATCH' });
  });
});
