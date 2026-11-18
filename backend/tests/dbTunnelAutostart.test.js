import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// scripts/db-tunnel.js forwards localhost:5432 to the production database over
// SSH. A test run must never start it, even with a loopback DATABASE_URL and
// DB_TUNNEL_AUTOSTART=true coming from a developer's backend/.env.

// Each test re-imports modules after vi.resetModules(); under the full
// parallel suite that can exceed the 5 s default, and a timed-out import that
// finishes late would leave a stale module (with the previous test's mocks)
// in the cache for the next test.
vi.setConfig({ testTimeout: 60_000 });

const ensureTunnelMock = vi.fn(async () => true);

class MockPool {
  constructor(options) {
    this.options = options;
    this.totalCount = 0;
    this.idleCount = 0;
    this.waitingCount = 0;
  }

  on() {
    return this;
  }

  async query() {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  }

  async end() {}
}

async function loadDbModule() {
  vi.resetModules();
  vi.doMock('pg', () => ({ default: { Pool: MockPool } }));
  vi.doMock('../../scripts/db-tunnel.js', () => ({ ensureTunnel: ensureTunnelMock }));
  vi.stubEnv('DATABASE_URL', 'postgresql://dev:dev@127.0.0.1:5432/paymentapp');
  vi.stubEnv('DB_TUNNEL_AUTOSTART', 'true');
  vi.stubEnv('PG_SSL', 'false');
  return import('../db/index.js');
}

afterEach(() => {
  vi.doUnmock('pg');
  vi.doUnmock('../../scripts/db-tunnel.js');
  vi.doUnmock('child_process');
  vi.doUnmock('net');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  ensureTunnelMock.mockClear();
});

describe('shouldAutoStartTunnel', () => {
  it('starts the tunnel only for an opted-in loopback host outside tests', async () => {
    const { shouldAutoStartTunnel } = await import('../db/index.js');
    const dev = { NODE_ENV: 'development', DB_TUNNEL_AUTOSTART: 'true' };

    expect(shouldAutoStartTunnel('127.0.0.1', dev)).toBe(true);
    expect(shouldAutoStartTunnel('localhost', dev)).toBe(true);
    expect(shouldAutoStartTunnel('[::1]', dev)).toBe(true);
    expect(shouldAutoStartTunnel('postgres', dev)).toBe(false);
    expect(shouldAutoStartTunnel('127.0.0.1', { NODE_ENV: 'development' })).toBe(false);
    expect(shouldAutoStartTunnel('127.0.0.1', { ...dev, DB_TUNNEL_AUTOSTART: 'false' })).toBe(false);
  });

  it('starts the tunnel only for a connection on the tunnel\'s local port', async () => {
    const { shouldAutoStartTunnel } = await import('../db/index.js');
    const dev = { NODE_ENV: 'development', DB_TUNNEL_AUTOSTART: 'true' };

    expect(shouldAutoStartTunnel('127.0.0.1', dev, '5432')).toBe(true);
    expect(shouldAutoStartTunnel('127.0.0.1', dev, '')).toBe(true);
    // A local database on another port is not the tunnel.
    expect(shouldAutoStartTunnel('127.0.0.1', dev, '5433')).toBe(false);
    expect(shouldAutoStartTunnel('127.0.0.1', { ...dev, DB_TUNNEL_LOCAL_PORT: '6543' }, '6543')).toBe(true);
    expect(shouldAutoStartTunnel('127.0.0.1', { ...dev, DB_TUNNEL_LOCAL_PORT: '6543' }, '5432')).toBe(false);
  });

  it('never starts the tunnel under a test runner, even when opted in', async () => {
    const { shouldAutoStartTunnel } = await import('../db/index.js');

    expect(shouldAutoStartTunnel('127.0.0.1', { DB_TUNNEL_AUTOSTART: 'true', VITEST: 'true' })).toBe(false);
    expect(shouldAutoStartTunnel('127.0.0.1', { DB_TUNNEL_AUTOSTART: 'true', NODE_ENV: 'test' })).toBe(false);
  });
});

describe('database recovery and the SSH tunnel', () => {
  it('does not call ensureTunnel during tests', async () => {
    const db = await loadDbModule();
    db.getPool();

    await expect(db.recoverDatabaseConnection()).resolves.toBe(false);

    expect(ensureTunnelMock).not.toHaveBeenCalled();
    await db.getPool().end();
  });

  it('calls ensureTunnel when a developer opts in outside tests (mock is wired)', async () => {
    const db = await loadDbModule();
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'development');
    db.getPool();

    await db.recoverDatabaseConnection();

    expect(ensureTunnelMock).toHaveBeenCalledTimes(1);
    await db.getPool().end();
  });

  it('does not call ensureTunnel for a loopback database on another port', async () => {
    const db = await loadDbModule();
    vi.stubEnv('DATABASE_URL', 'postgresql://dev:dev@127.0.0.1:5433/paymentapp');
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'development');
    db.getPool();

    await db.recoverDatabaseConnection();

    expect(ensureTunnelMock).not.toHaveBeenCalled();
    await db.getPool().end();
  });
});

describe('ensureTunnel', () => {
  async function loadTunnelModule() {
    vi.resetModules();
    const spawn = vi.fn(() => new EventEmitter());
    let portChecks = 0;
    // The first port check finds nothing listening; later ones succeed, so a
    // spawned tunnel "comes up" after one poll.
    class MockSocket extends EventEmitter {
      setTimeout() {}
      destroy() {}
      connect() {
        portChecks += 1;
        const event = portChecks === 1 ? 'error' : 'connect';
        setImmediate(() => this.emit(event, new Error('ECONNREFUSED')));
      }
    }
    vi.doMock('child_process', () => ({ spawn, default: { spawn } }));
    vi.doMock('net', () => ({ Socket: MockSocket, default: { Socket: MockSocket } }));
    const tunnel = await import('../../scripts/db-tunnel.js');
    return { ...tunnel, spawn };
  }

  it('refuses to spawn ssh under a test runner', async () => {
    const { ensureTunnel, spawn } = await loadTunnelModule();

    await expect(ensureTunnel()).resolves.toBe(false);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns ssh outside tests when the port is closed (mock is wired)', async () => {
    const { ensureTunnel, spawn } = await loadTunnelModule();
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'development');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(ensureTunnel()).resolves.toBe(true);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe('ssh');
  });
});
