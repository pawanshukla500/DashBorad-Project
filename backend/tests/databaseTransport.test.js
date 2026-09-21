import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseUnavailableError, getDatabaseStatus, resolvePgConfig } from '../db/index.js';

const ENV_KEYS = [
  'NODE_ENV', 'DATABASE_URL', 'POSTGRES_DATABASE_URL',
  'PG_SSL', 'POSTGRES_PG_SSL',
  'PG_SSL_REJECT_UNAUTHORIZED', 'POSTGRES_PG_SSL_REJECT_UNAUTHORIZED',
  'PG_SSL_CA', 'POSTGRES_PG_SSL_CA',
  'PG_READ_STATEMENT_TIMEOUT_MS',
  'PG_CONNECT_TIMEOUT_MS',
  'PG_POOL_IDLE_TIMEOUT_MS',
  'PG_POOL_MAX_LIFETIME_SECONDS',
  'PG_JIT',
  'PG_WORK_MEM',
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
    expect(resolvePgConfig().statement_timeout).toBe(45_000);
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

  it('allows a non-TLS Docker service database on the private production network', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://payments:secret@postgres:5432/reconciliation';
    process.env.PG_SSL = 'false';

    expect(resolvePgConfig().ssl).toBe(false);
    expect(getDatabaseStatus().transport).toEqual({
      tlsEnabled: false,
      certificateVerified: null,
      productionReady: true,
    });
  });

  it('ignores legacy POSTGRES_DATABASE_URL values', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;
    process.env.POSTGRES_DATABASE_URL = 'postgresql://payments:secret@db.example.com:5432/old';
    process.env.POSTGRES_PG_SSL = 'true';

    expect(() => resolvePgConfig()).toThrow(DatabaseUnavailableError);
    expect(getDatabaseStatus().configured).toBe(false);
  });

  it('keeps an explicitly non-TLS loopback connection available for local development', () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://payments:secret@127.0.0.1:5432/reconciliation';
    process.env.PG_SSL = 'false';

    expect(resolvePgConfig().ssl).toBe(false);
  });

  it('configures TCP keepalives and bounded pool lifetime for network stability', () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://payments:secret@127.0.0.1:5432/reconciliation';
    process.env.PG_SSL = 'false';

    const config = resolvePgConfig();
    expect(config.keepAlive).toBe(true);
    expect(config.keepAliveInitialDelayMillis).toBe(10_000);
    expect(config.idleTimeoutMillis).toBe(120_000);
    expect(config.maxLifetimeSeconds).toBe(900);
    expect(config.min).toBeGreaterThanOrEqual(2);
    expect(config.max).toBe(20);
  });

  it('allows deployment to tune pool idle and lifetime limits without code changes', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://payments:secret@postgres:5432/reconciliation';
    process.env.PG_SSL = 'false';
    process.env.PG_READ_STATEMENT_TIMEOUT_MS = '30000';
    process.env.PG_POOL_IDLE_TIMEOUT_MS = '30000';
    process.env.PG_POOL_MAX_LIFETIME_SECONDS = '300';

    const config = resolvePgConfig();
    expect(config.statement_timeout).toBe(30_000);
    expect(config.idleTimeoutMillis).toBe(30_000);
    expect(config.maxLifetimeSeconds).toBe(300);
  });

  it('turns off JIT for API sessions in the startup packet unless PG_JIT=on', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://payments:secret@postgres:5432/reconciliation';
    process.env.PG_SSL = 'false';
    delete process.env.PG_JIT;
    delete process.env.PG_WORK_MEM;

    expect(resolvePgConfig().options).toBe('-c jit=off');

    process.env.PG_JIT = 'on';
    expect(resolvePgConfig().options).toBeUndefined();
    process.env.PG_JIT = 'true';
    expect(resolvePgConfig().options).toBeUndefined();
  });

  it('adds a validated work_mem to the session options and ignores malformed values', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://payments:secret@postgres:5432/reconciliation';
    process.env.PG_SSL = 'false';
    delete process.env.PG_JIT;

    process.env.PG_WORK_MEM = '32MB';
    expect(resolvePgConfig().options).toBe('-c jit=off -c work_mem=32MB');

    process.env.PG_WORK_MEM = '32MB -c statement_timeout=0';
    expect(resolvePgConfig().options).toBe('-c jit=off');
  });
});
