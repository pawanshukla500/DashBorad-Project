import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseUnavailableError, getDatabaseStatus, resolvePgConfig } from '../db/index.js';

const ENV_KEYS = [
  'NODE_ENV', 'DATABASE_URL', 'POSTGRES_DATABASE_URL',
  'PG_SSL', 'POSTGRES_PG_SSL',
  'PG_SSL_REJECT_UNAUTHORIZED', 'POSTGRES_PG_SSL_REJECT_UNAUTHORIZED',
  'PG_SSL_CA', 'POSTGRES_PG_SSL_CA',
  'PG_READ_STATEMENT_TIMEOUT_MS',
];
const originalEnvironment = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
}

afterEach(restoreEnvironment);

describe('PostgreSQL transport policy', () => {
  it('uses certificate validation for an explicitly enabled TLS connection', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://payments:secret@db.example.com:5432/reconciliation';
    process.env.PG_SSL = 'true';
    delete process.env.PG_SSL_REJECT_UNAUTHORIZED;

    expect(resolvePgConfig().ssl).toEqual({ rejectUnauthorized: true });
    expect(resolvePgConfig().statement_timeout).toBe(90_000);
  });

  it('rejects an unencrypted remote production database connection', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://payments:secret@db.example.com:5432/reconciliation';
    process.env.PG_SSL = 'false';

    expect(() => resolvePgConfig()).toThrow(DatabaseUnavailableError);
    expect(getDatabaseStatus().transport).toEqual({
      tlsEnabled: false,
      certificateVerified: null,
      productionReady: false,
    });
  });

  it('keeps an explicitly non-TLS loopback connection available for local development', () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://payments:secret@127.0.0.1:5432/reconciliation';
    process.env.PG_SSL = 'false';

    expect(resolvePgConfig().ssl).toBe(false);
  });
});
