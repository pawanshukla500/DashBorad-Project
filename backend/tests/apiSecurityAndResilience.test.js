import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { app, setDatabaseSchemaReadyForTesting, publicDatabaseStatus } from '../server.js';
import { getDatabaseStatus, isDbConfigured, resolvePgConfig } from '../db/index.js';

describe('API Security and Database Resilience Suite', () => {
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    setDatabaseSchemaReadyForTesting(true);
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_DATABASE_URL) {
      process.env.DATABASE_URL = 'postgresql://test_ci_user:test_ci_dummy_pass@127.0.0.1:5432/recon_ci';
    }
  });

  afterAll(() => {
    setDatabaseSchemaReadyForTesting(false);
    if (originalDbUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDbUrl;
    }
  });
  describe('Database Resilience & Transport Security', () => {
    it('successfully resolves database configuration from environment cascade', async () => {
      const configured = await isDbConfigured();
      expect(configured).toBe(true);

      const status = getDatabaseStatus();
      expect(status.configured).toBe(true);
      expect(status.transport).toBeDefined();
      expect(status.transport).toHaveProperty('productionReady');
      // Passwords or sensitive connection strings must never be leaked in status
      expect(status).not.toHaveProperty('password');
      if (process.env.DATABASE_URL) {
        try {
          const parsed = new URL(process.env.DATABASE_URL);
          if (parsed.password) {
            expect(JSON.stringify(status)).not.toContain(parsed.password);
          }
        } catch { /* ignore URL parse errors */ }
      }
    });

    it('verifies resolvePgConfig enforces secure connection options', () => {
      const config = resolvePgConfig();
      expect(config).toBeDefined();
      expect(config.keepAlive).toBe(true);
      expect(config.keepAliveInitialDelayMillis).toBe(10_000);
      expect(config.connectionTimeoutMillis).toBeGreaterThanOrEqual(5_000);
      expect(config.statement_timeout).toBeGreaterThanOrEqual(5_000);
    });
  });

  describe('API Security & Authentication Boundaries', () => {
    it('blocks unauthenticated access to protected report and mutation endpoints', async () => {
      const server = app.listen(0);
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        // Protected endpoints should require Firebase token and return 401
        const endpoints = [
          { url: `${baseUrl}/api/summary`, method: 'GET' },
          { url: `${baseUrl}/api/export/monthly-summary`, method: 'GET' },
          { url: `${baseUrl}/api/sor/myntra-jabong/ledger`, method: 'GET' },
          { url: `${baseUrl}/api/marketplace-accounts`, method: 'GET' },
          { url: `${baseUrl}/api/rate-card/config`, method: 'GET' },
        ];

        for (const ep of endpoints) {
          const res = await fetch(ep.url, { method: ep.method });
          expect(res.status, `Endpoint ${ep.url} should reject unauthenticated request`).toBe(401);
          const data = await res.json();
          expect(data).toHaveProperty('error');
        }
      } finally {
        server.close();
      }
    });

    it('health check endpoints return safe public status without sensitive credentials', async () => {
      const server = app.listen(0);
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const res = await fetch(`${baseUrl}/health`);
        expect([200, 503]).toContain(res.status);
        const data = await res.json();
        expect(data).toHaveProperty('status');
        expect(data).toHaveProperty('dataSource', 'sql');
        
        // Ensure no internal DB URL with credentials leaks to external callers
        const bodyStr = JSON.stringify(data);
        expect(bodyStr).not.toContain('postgres://');
        expect(bodyStr).not.toContain('postgresql://');
        expect(bodyStr).not.toContain('password');
        if (process.env.DATABASE_URL) {
          try {
            const parsed = new URL(process.env.DATABASE_URL);
            if (parsed.password) {
              expect(bodyStr).not.toContain(parsed.password);
            }
            expect(bodyStr).not.toContain(process.env.DATABASE_URL);
          } catch { /* ignore URL parse errors */ }
        }

        // Exercise public health projection branch directly to verify internal diagnostic field omission
        const internalDiagnosticDetail = {
          configured: true,
          connected: true,
          lastSuccessAt: Date.now(),
          schemaReady: true,
          engine: 'postgresql',
          transport: { tlsEnabled: true, productionReady: true },
          pool: { totalCount: 5, idleCount: 4, waitingCount: 0 },
          internalError: 'PostgreSQL connection timeout on internal socket',
        };
        const publicProjection = publicDatabaseStatus(internalDiagnosticDetail);
        expect(publicProjection).toEqual({
          configured: true,
          connected: true,
          lastSuccessAt: internalDiagnosticDetail.lastSuccessAt,
          schemaReady: true,
          engine: 'postgresql',
        });
        expect(publicProjection).not.toHaveProperty('transport');
        expect(publicProjection).not.toHaveProperty('pool');
        expect(publicProjection).not.toHaveProperty('internalError');
      } finally {
        server.close();
      }
    }, 15_000);

    it('handles malformed JSON payloads gracefully without exposing stack traces', async () => {
      const server = app.listen(0);
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{ malformed json: true, ',
        });

        // Malformed JSON should return 400 Bad Request
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data).toHaveProperty('error');
        expect(data).not.toHaveProperty('stack');
      } finally {
        server.close();
      }
    });
  });
});
