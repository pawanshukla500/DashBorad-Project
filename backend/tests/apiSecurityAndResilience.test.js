import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { app, setDatabaseSchemaReadyForTesting } from '../server.js';
import { getDatabaseStatus, isDbConfigured, resolvePgConfig } from '../db/index.js';

describe('API Security and Database Resilience Suite', () => {
  beforeAll(() => {
    setDatabaseSchemaReadyForTesting(true);
  });

  afterAll(() => {
    setDatabaseSchemaReadyForTesting(false);
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
      expect(JSON.stringify(status)).not.toContain('1MoreM!les2Go$');
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
        expect(bodyStr).not.toContain('password');
      } finally {
        server.close();
      }
    });

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
