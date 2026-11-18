import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, startServer } from '../server.js';
import { stubNoDatabaseEnv } from './helpers/databaseEnv.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('server entrypoint', () => {
  it('imports the complete route graph without syntax errors or starting a listener', () => {
    expect(app).toBeTypeOf('function');
    expect(app.listening).not.toBe(true);
    expect(startServer).toBeTypeOf('function');
  });

  it('serves /health and /api/health publicly without requiring an authorization token', async () => {
    // No database, whatever the shell exports: the health check must never
    // probe a real one, so the answer is always the unconfigured 503.
    stubNoDatabaseEnv();
    const server = app.listen(0);
    const port = server.address().port;
    try {
      for (const route of ['/health', '/api/health']) {
        const res = await fetch(`http://127.0.0.1:${port}${route}`);
        expect(res.status).toBe(503);
        const json = await res.json();
        expect(json).toHaveProperty('status', 'degraded');
        expect(json).toHaveProperty('dbConnected', false);
      }
    } finally {
      server.close();
    }
  });
});
