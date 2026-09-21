import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'PG_SSL'];
const originalEnvironment = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

let queryResponses = [];
let queryCalls = [];
let createdPools = [];
let connectedClients = [];
let clientQueryImpl = async () => ({ rows: [] });

class MockPool {
  constructor(options) {
    this.options = options;
    this.totalCount = 1;
    this.idleCount = 1;
    this.waitingCount = 0;
    this.handlers = {};
    this.ended = false;
    createdPools.push(this);
  }

  on(event, handler) {
    this.handlers[event] = handler;
    return this;
  }

  async query(text, params) {
    queryCalls.push({ pool: this, text, params });
    const response = queryResponses.shift();
    if (response instanceof Error) throw response;
    return response || { rows: [{ ok: 1 }] };
  }

  async connect() {
    // db/index.js wraps query/release on the returned object, so keep the
    // original mocks separately for assertions.
    const query = vi.fn((...args) => clientQueryImpl(...args));
    const release = vi.fn();
    connectedClients.push({ query, release });
    return { query, release };
  }

  async end() {
    this.ended = true;
  }
}

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
}

function connectionBreak(message = 'connection terminated unexpectedly') {
  return Object.assign(new Error(message), { code: 'ECONNRESET' });
}

async function loadDbModule(responses = []) {
  vi.resetModules();
  vi.doMock('pg', () => ({ default: { Pool: MockPool } }));
  queryResponses = [...responses];
  queryCalls = [];
  createdPools = [];
  connectedClients = [];
  clientQueryImpl = async () => ({ rows: [] });
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://payments:secret@postgres:5432/paymentapp';
  process.env.PG_SSL = 'false';
  return import('../db/index.js');
}

afterEach(async () => {
  vi.doUnmock('pg');
  vi.restoreAllMocks();
  restoreEnvironment();
});

describe('PostgreSQL connection recovery', () => {
  it('retries a safe read once after a dropped pooled socket', async () => {
    const success = { rows: [{ ok: 1 }] };
    const db = await loadDbModule([connectionBreak(), success]);

    await expect(db.getPool().query('SELECT 1')).resolves.toBe(success);

    expect(queryCalls).toHaveLength(2);
    expect(db.getDatabaseStatus().poolRecreatePending).toBe(true);
    await db.getPool().end();
  });

  it('does not replay writes after a connection break', async () => {
    const db = await loadDbModule([connectionBreak()]);

    await expect(db.getPool().query('INSERT INTO upload_log(status) VALUES ($1)', ['ok']))
      .rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });

    expect(queryCalls).toHaveLength(1);
    expect(db.getDatabaseStatus().connected).toBe(false);
    expect(db.getDatabaseStatus().poolRecreatePending).toBe(true);
    await db.getPool().end();
  });

  it('rebuilds the pool after an idle client disconnect event', async () => {
    const db = await loadDbModule([{ rows: [{ ok: 1 }] }]);
    db.getPool();

    createdPools[0].handlers.error(connectionBreak('server closed the connection unexpectedly'));
    await db.recoverDatabaseConnection();

    expect(createdPools).toHaveLength(2);
    expect(createdPools[0].ended).toBe(true);
    expect(db.getDatabaseStatus().connected).toBe(true);
    expect(db.getDatabaseStatus().poolRecreatePending).toBe(false);
    expect(db.getDatabaseStatus().lastPoolRecreatedAt).toEqual(expect.any(String));
    await db.getPool().end();
  });

  it('restores the read statement timeout before a transaction client returns to the pool', async () => {
    const db = await loadDbModule();
    const client = await db.getPool().connect();
    const [raw] = connectedClients;
    expect(raw.query).toHaveBeenCalledWith('SET statement_timeout = 0; SET idle_in_transaction_session_timeout = 0;');

    client.release();
    client.release(); // a double release must not reach pg-pool twice
    await vi.waitFor(() => expect(raw.release).toHaveBeenCalledTimes(1));

    expect(raw.query).toHaveBeenLastCalledWith('RESET statement_timeout; RESET idle_in_transaction_session_timeout;');
    expect(raw.release).toHaveBeenCalledWith();
    await db.getPool().end();
  });

  it('discards a transaction client whose session limits cannot be reset', async () => {
    const db = await loadDbModule();
    const client = await db.getPool().connect();
    const [raw] = connectedClients;
    clientQueryImpl = async (text) => {
      if (String(text).startsWith('RESET')) throw new Error('current transaction is aborted');
      return { rows: [] };
    };

    client.release();
    await vi.waitFor(() => expect(raw.release).toHaveBeenCalledTimes(1));

    expect(raw.release.mock.calls[0][0]).toBeInstanceOf(Error);
    await db.getPool().end();
  });

  it('passes a release error straight through without attempting a reset', async () => {
    const db = await loadDbModule();
    const client = await db.getPool().connect();
    const [raw] = connectedClients;
    const failure = new Error('broken client');

    client.release(failure);

    expect(raw.release).toHaveBeenCalledWith(failure);
    expect(raw.query).not.toHaveBeenCalledWith('RESET statement_timeout; RESET idle_in_transaction_session_timeout;');
    await db.getPool().end();
  });
});
