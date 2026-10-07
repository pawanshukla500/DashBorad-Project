import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// initDb reads its pool from db/index.js; every test supplies a stub instead.
const stubs = vi.hoisted(() => ({ pool: null }));
vi.mock('../db/index.js', async importOriginal => ({
  ...(await importOriginal()),
  isDbConfigured: async () => true,
  getPool: () => stubs.pool,
}));

import {
  SCHEMA_DDL_LOCK_TIMEOUT,
  SCHEMA_DDL_STATEMENT_TIMEOUT,
  SCHEMA_INIT_LOCK_KEY,
  createSchemaInitQueryable,
  initDb,
  replaceViewIfChanged,
} from '../db/initDb.js';
import { ensureOrderSettlementTotals } from '../services/orderSettlementTotals.js';

const normalize = sql => String(sql).replace(/\s+/g, ' ').trim();

function recordingConnection(respond = () => undefined) {
  const statements = [];
  const query = vi.fn(async (sql, params) => {
    const text = normalize(sql);
    statements.push({ text, params });
    return (await respond(text, params)) ?? { rows: [], rowCount: 0 };
  });
  return { query, statements, texts: () => statements.map(statement => statement.text) };
}

// `relations` may be a live Set, so a test can drop an index between reads.
function catalogResponder({ columns = [], relations = [] } = {}) {
  return text => {
    if (text.startsWith('SELECT table_name, column_name, is_nullable')) {
      return { rows: columns.map(([table_name, column_name, nullable = true]) => ({ table_name, column_name, nullable })) };
    }
    if (text.startsWith('SELECT relname FROM pg_class')) return { rows: [...relations].map(relname => ({ relname })) };
    return undefined;
  };
}

const isCatalogRead = text => /^SELECT (table_name, column_name, is_nullable|relname FROM pg_class)/.test(text);
const catalogLoads = texts => texts.filter(text => text.startsWith('SELECT table_name, column_name, is_nullable')).length;
const sqlError = (code, message = 'canceling statement due to lock timeout') => Object.assign(new Error(message), { code });

describe('startup schema queryable', () => {
  it('skips ADD COLUMN when information_schema already has the column, reading the catalog once', async () => {
    const connection = recordingConnection(catalogResponder({ columns: [['orders', 'brand'], ['returns', 'fnsku']] }));
    const db = createSchemaInitQueryable(connection);

    await expect(db.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS brand TEXT')).resolves.toMatchObject({ skipped: true });
    await db.query('ALTER TABLE returns ADD COLUMN IF NOT EXISTS fnsku TEXT');
    await db.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_tax NUMERIC(14,2)');
    // Applied by this run, so a repeat is skipped too.
    await db.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_tax NUMERIC(14,2)');

    const texts = connection.texts();
    expect(catalogLoads(texts)).toBe(1);
    expect(texts.filter(text => !isCatalogRead(text))).toEqual([
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_tax NUMERIC(14,2)',
    ]);
  });

  it('skips CREATE INDEX IF NOT EXISTS for an existing index, folding unquoted names to lower case', async () => {
    const connection = recordingConnection(catalogResponder({ relations: ['ix_orders_market_date'] }));
    const db = createSchemaInitQueryable(connection);

    await db.query('CREATE INDEX IF NOT EXISTS IX_orders_market_date ON orders(marketplace, order_date DESC)');
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS rc_commission_uniq_period
      ON rc_commission (marketplace, seller_account, COALESCE(brand_name, ''), start_date)`);
    await db.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_market_date ON orders (marketplace)');

    expect(connection.texts().filter(text => !isCatalogRead(text))).toEqual([
      "CREATE UNIQUE INDEX IF NOT EXISTS rc_commission_uniq_period ON rc_commission (marketplace, seller_account, COALESCE(brand_name, ''), start_date)",
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_market_date ON orders (marketplace)',
    ]);
  });

  it('skips DROP NOT NULL only on a column that is already nullable', async () => {
    const connection = recordingConnection(catalogResponder({
      columns: [['orders', 'order_item_id', true], ['returns', 'return_id', false]],
    }));
    const db = createSchemaInitQueryable(connection);

    await db.query('ALTER TABLE orders ALTER COLUMN order_item_id DROP NOT NULL');
    await db.query('ALTER TABLE returns ALTER COLUMN return_id DROP NOT NULL');
    // A DO block earlier in the run may have added a constraint the snapshot
    // cannot see, so DROP CONSTRAINT is never skipped.
    await db.query('ALTER TABLE returns DROP CONSTRAINT IF EXISTS uq_return_id');

    expect(connection.texts().filter(text => !isCatalogRead(text))).toEqual([
      'ALTER TABLE returns ALTER COLUMN return_id DROP NOT NULL',
      'ALTER TABLE returns DROP CONSTRAINT IF EXISTS uq_return_id',
    ]);
  });

  it('re-reads the catalog after a statement that drops objects, so a dropped index is re-created', async () => {
    const relations = new Set(['ix_orders_sku']);
    const connection = recordingConnection(text => {
      if (text.startsWith('DROP INDEX')) relations.delete('ix_orders_sku');
      return catalogResponder({ relations })(text);
    });
    const db = createSchemaInitQueryable(connection);

    await db.query('CREATE INDEX IF NOT EXISTS IX_orders_sku ON orders(sku)');
    await db.query('DROP INDEX IF EXISTS ix_orders_sku');
    await db.query('CREATE INDEX IF NOT EXISTS IX_orders_sku ON orders(sku)');

    const texts = connection.texts();
    expect(catalogLoads(texts)).toBe(2);
    expect(texts.filter(text => !isCatalogRead(text))).toEqual([
      'DROP INDEX IF EXISTS ix_orders_sku',
      'CREATE INDEX IF NOT EXISTS IX_orders_sku ON orders(sku)',
    ]);
  });

  it('passes multi-action and multi-statement DDL through without reading the catalog', async () => {
    const connection = recordingConnection(catalogResponder({ columns: [['sor_invoice_line', 'line_type'], ['sor_invoice_line', 'source']] }));
    const db = createSchemaInitQueryable(connection);

    await db.query(`ALTER TABLE sor_invoice_line
      ADD COLUMN IF NOT EXISTS line_type TEXT NOT NULL DEFAULT 'sale',
      ADD COLUMN IF NOT EXISTS source TEXT`);
    await db.query('CREATE INDEX IF NOT EXISTS ix_a ON t (a); DROP INDEX ix_b');

    expect(connection.texts()).toEqual([
      "ALTER TABLE sor_invoice_line ADD COLUMN IF NOT EXISTS line_type TEXT NOT NULL DEFAULT 'sale', ADD COLUMN IF NOT EXISTS source TEXT",
      'CREATE INDEX IF NOT EXISTS ix_a ON t (a); DROP INDEX ix_b',
    ]);
  });

  it.each([
    ['lock_timeout', '55P03'],
    ['statement_timeout', '57014'],
  ])('remembers a swallowed %s and refuses to record any schema version', async (_name, code) => {
    const connection = recordingConnection(text => {
      if (text.startsWith('ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_tax')) throw sqlError(code);
      return catalogResponder()(text);
    });
    const db = createSchemaInitQueryable(connection);

    await db.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_tax NUMERIC(14,2)').catch(() => {});

    await expect(db.query('INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', ['v1']))
      .rejects.toThrow(/1 startup schema statement\(s\) timed out/);
    expect(connection.texts().some(text => text.startsWith('INSERT INTO schema_version'))).toBe(false);
    expect(() => db.throwIfInterrupted()).toThrow('ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_tax');
  });

  it('still records versions after an ordinary (non-timeout) swallowed error', async () => {
    const connection = recordingConnection(text => {
      if (text.startsWith('CREATE UNIQUE INDEX')) throw sqlError('42P01', 'relation "rc_franchise_fee" does not exist');
      return catalogResponder()(text);
    });
    const db = createSchemaInitQueryable(connection);

    await db.query('CREATE UNIQUE INDEX IF NOT EXISTS rc_franchise_fee_uniq_period ON rc_franchise_fee (marketplace)').catch(() => {});
    await db.query('INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', ['v1']);

    expect(() => db.throwIfInterrupted()).not.toThrow();
    expect(connection.texts()).toContain('INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING');
  });
});

describe('replaceViewIfChanged', () => {
  const select = 'SELECT 1 AS one';
  const replaceSql = `DROP VIEW IF EXISTS example;\nCREATE OR REPLACE VIEW example AS ${select}`;

  function viewConnection({ unchanged, probeFails = false } = {}) {
    return recordingConnection(text => {
      if (probeFails && text.includes('CREATE TEMP VIEW')) throw new Error('column "x" does not exist');
      if (text.startsWith('SELECT pg_get_viewdef')) return { rows: [{ unchanged }] };
      return undefined;
    });
  }

  it('takes no lock on the view when its normalized definition is unchanged', async () => {
    const connection = viewConnection({ unchanged: true });

    await expect(replaceViewIfChanged(connection, 'example', select, replaceSql)).resolves.toBe(false);

    const texts = connection.texts();
    expect(texts[0]).toBe('DROP VIEW IF EXISTS pg_temp.example_definition_probe; CREATE TEMP VIEW example_definition_probe AS SELECT 1 AS one');
    expect(connection.statements[1].params).toEqual(['example', 'pg_temp.example_definition_probe']);
    expect(texts.at(-1)).toBe('DROP VIEW IF EXISTS pg_temp.example_definition_probe');
    expect(texts.some(text => text.startsWith('DROP VIEW IF EXISTS example;'))).toBe(false);
  });

  it('replaces a changed view with DROP and CREATE in one query, i.e. one transaction', async () => {
    const connection = viewConnection({ unchanged: false });

    await expect(replaceViewIfChanged(connection, 'example', select, replaceSql)).resolves.toBe(true);

    const replacements = connection.texts().filter(text => text.includes('VIEW example AS') || text.startsWith('DROP VIEW IF EXISTS example'));
    expect(replacements).toEqual(['DROP VIEW IF EXISTS example; CREATE OR REPLACE VIEW example AS SELECT 1 AS one']);
  });

  it('still attempts (and reports) the replacement when the candidate cannot compile', async () => {
    const connection = recordingConnection(text => {
      if (text.includes('CREATE TEMP VIEW')) throw new Error('column "x" does not exist');
      if (text.startsWith('DROP VIEW IF EXISTS example;')) throw new Error('column "x" does not exist');
      return undefined;
    });

    await expect(replaceViewIfChanged(connection, 'example', select, replaceSql)).rejects.toThrow('column "x" does not exist');
    expect(connection.texts()).toContain('DROP VIEW IF EXISTS pg_temp.example_definition_probe');
  });
});

describe('ensureOrderSettlementTotals schema guard', () => {
  function settlementTotalsStubs(existing) {
    const columns = text => (
      text.startsWith('SELECT column_name FROM information_schema.columns')
        ? { rows: existing.map(column_name => ({ column_name })) }
        : undefined
    );
    const ddl = recordingConnection(columns);
    const refreshClient = recordingConnection();
    const pool = recordingConnection(text => {
      if (text.startsWith('SELECT column_name')) return columns(text);
      if (text.startsWith('SELECT COUNT(*) AS count')) return { rows: [{ count: 10, settled_rows: 10 }] };
      if (text.startsWith('WITH sl AS')) return { rows: [{ healed_count: 0 }] };
      return undefined;
    });
    pool.connect = vi.fn(async () => ({ query: refreshClient.query, release: vi.fn() }));
    return { ddl, pool, refreshClient };
  }

  it('runs no ALTER on the hot table when both metric columns exist', async () => {
    const { ddl, pool } = settlementTotalsStubs(['settled_row_count', 'negative_bank_amount']);

    await ensureOrderSettlementTotals(pool, ddl);

    expect([...ddl.texts(), ...pool.texts()].some(text => text.startsWith('ALTER TABLE'))).toBe(false);
    expect(ddl.texts()[0]).toMatch(/^CREATE TABLE IF NOT EXISTS order_settlement_totals/);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('adds only the missing column, on the DDL session, then rebuilds through the pool', async () => {
    const { ddl, pool, refreshClient } = settlementTotalsStubs(['settled_row_count']);

    await ensureOrderSettlementTotals(pool, ddl);

    expect(ddl.texts().filter(text => text.startsWith('ALTER TABLE'))).toEqual([
      'ALTER TABLE order_settlement_totals ADD COLUMN IF NOT EXISTS negative_bank_amount NUMERIC(14,2) NOT NULL DEFAULT 0',
    ]);
    expect(pool.texts().some(text => text.startsWith('ALTER TABLE'))).toBe(false);
    // The metric backfill owns its transaction on a pool client.
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(refreshClient.texts()[0]).toBe('BEGIN');
  });

  it('keeps the single-queryable signature working', async () => {
    const { pool } = settlementTotalsStubs(['settled_row_count', 'negative_bank_amount']);

    await ensureOrderSettlementTotals(pool);

    expect(pool.texts()[0]).toMatch(/^CREATE TABLE IF NOT EXISTS order_settlement_totals/);
    expect(pool.texts().some(text => text.startsWith('ALTER TABLE'))).toBe(false);
  });
});

describe('initDb session, advisory lock and timeouts', () => {
  const savedOptIn = process.env.RUN_SCHEMA_MIGRATIONS;

  beforeEach(() => {
    process.env.RUN_SCHEMA_MIGRATIONS = 'true';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedOptIn === undefined) delete process.env.RUN_SCHEMA_MIGRATIONS;
    else process.env.RUN_SCHEMA_MIGRATIONS = savedOptIn;
    stubs.pool = null;
    vi.restoreAllMocks();
  });

  // Every sub-migration is already recorded; only the CURRENT_SCHEMA_VERSION
  // check (the first version lookup) follows `current`.
  function stubDatabase({ current = true, tryLock = true, viewUnchanged = true, catalog = {}, clientRespond } = {}) {
    let versionChecks = 0;
    const shared = text => {
      if (text.startsWith('SELECT 1 FROM schema_version')) {
        versionChecks += 1;
        return versionChecks === 1 && !current ? { rows: [], rowCount: 0 } : { rows: [{}], rowCount: 1 };
      }
      if (text.startsWith('SELECT COUNT(*) AS count')) return { rows: [{ count: 1, settled_rows: 1 }] };
      if (text.startsWith('WITH sl AS')) return { rows: [{ healed_count: 0 }] };
      if (text.startsWith('SELECT column_name FROM information_schema.columns')) {
        return { rows: [{ column_name: 'settled_row_count' }, { column_name: 'negative_bank_amount' }] };
      }
      if (text.startsWith('SELECT pg_get_viewdef')) return { rows: [{ unchanged: viewUnchanged }] };
      return catalogResponder(catalog)(text);
    };
    const client = recordingConnection(text => {
      const custom = clientRespond?.(text);
      if (custom !== undefined) return custom;
      if (text.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: tryLock }] };
      return shared(text);
    });
    client.release = vi.fn();
    const pool = recordingConnection(shared);
    pool.connect = vi.fn(async () => ({ query: client.query, release: client.release }));
    stubs.pool = pool;
    return { client, pool };
  }

  const SET_TIMEOUTS = `SET lock_timeout = '${SCHEMA_DDL_LOCK_TIMEOUT}'; SET statement_timeout = '${SCHEMA_DDL_STATEMENT_TIMEOUT}'`;

  it('holds the advisory lock on one dedicated client for the whole run, then cleans the session up', async () => {
    const { client, pool } = stubDatabase();

    await initDb();

    const texts = client.texts();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(texts[0]).toBe('SELECT pg_try_advisory_lock($1) AS locked');
    expect(client.statements[0].params).toEqual([SCHEMA_INIT_LOCK_KEY]);
    expect(texts[1]).toBe(SET_TIMEOUTS);
    expect(SCHEMA_DDL_LOCK_TIMEOUT).toBe('3s');
    expect(texts[2]).toMatch(/^CREATE TABLE IF NOT EXISTS schema_version/);
    expect(texts.slice(-2)).toEqual(['RESET lock_timeout; RESET statement_timeout', 'SELECT pg_advisory_unlock($1)']);
    expect(client.statements.at(-1).params).toEqual([SCHEMA_INIT_LOCK_KEY]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('leaves unchanged views and the settlement totals table untouched on a normal restart', async () => {
    const { client, pool } = stubDatabase();

    await initDb();

    const all = [...client.texts(), ...pool.texts()];
    expect(all.some(text => /^DROP VIEW IF EXISTS order_items_summary/.test(text))).toBe(false);
    expect(all.some(text => /CREATE OR REPLACE VIEW (order_items_summary|unified_settlements)/.test(text))).toBe(false);
    expect(all.some(text => text.startsWith('ALTER TABLE'))).toBe(false);
  });

  it('replaces a changed order_items_summary atomically in a single statement batch', async () => {
    const { client } = stubDatabase({ viewUnchanged: false });

    await initDb();

    const texts = client.texts();
    const replacement = texts.filter(text => text.startsWith('DROP VIEW IF EXISTS order_items_summary'));
    expect(replacement).toHaveLength(1);
    expect(replacement[0]).toMatch(/^DROP VIEW IF EXISTS order_items_summary; CREATE OR REPLACE VIEW order_items_summary AS SELECT o\.order_id/);
  });

  it('waits for a backend that already holds the lock before any DDL', async () => {
    const { client } = stubDatabase({ tryLock: false });

    await initDb();

    expect(client.texts().slice(0, 3)).toEqual([
      'SELECT pg_try_advisory_lock($1) AS locked',
      'SELECT pg_advisory_lock($1)',
      SET_TIMEOUTS,
    ]);
  });

  it('runs the full pass on the client, skipping columns and indexes the catalog already has', async () => {
    const { client, pool } = stubDatabase({
      current: false,
      catalog: {
        columns: [['orders', 'brand'], ['orders', 'item_tax'], ['orders', 'order_item_id', true], ['returns', 'fnsku']],
        relations: ['ix_orders_market_date', 'ix_orders_status_return_type_date'],
      },
    });

    await initDb();

    const texts = client.texts();
    // Read once, then again after the full pass's two DROP CONSTRAINT statements.
    expect(catalogLoads(texts)).toBe(2);
    expect(texts).not.toContain('ALTER TABLE orders ADD COLUMN IF NOT EXISTS brand TEXT');
    expect(texts).not.toContain('ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_tax NUMERIC(14,2)');
    expect(texts).not.toContain('ALTER TABLE returns ADD COLUMN IF NOT EXISTS fnsku TEXT');
    expect(texts).not.toContain('ALTER TABLE orders ALTER COLUMN order_item_id DROP NOT NULL');
    expect(texts.some(text => text.startsWith('CREATE INDEX IF NOT EXISTS IX_orders_market_date '))).toBe(false);
    // Missing objects are still created, on the lock_timeout session.
    expect(texts).toContain('ALTER TABLE orders ADD COLUMN IF NOT EXISTS sale_gift_amount NUMERIC(14,2)');
    expect(texts).toContain('CREATE INDEX IF NOT EXISTS IX_orders_sku ON orders(sku)');
    expect(texts.indexOf(SET_TIMEOUTS)).toBeLessThan(texts.findIndex(text => text.startsWith('ALTER TABLE')));
    // No orders/returns DDL goes through the pool, which has no lock_timeout.
    expect(pool.texts().some(text => /^(ALTER TABLE (orders|returns)\b|CREATE (UNIQUE )?INDEX IF NOT EXISTS \w+ ON (orders|returns)\b)/.test(text))).toBe(false);
    const stamp = client.statements.find(statement => statement.text.startsWith('INSERT INTO schema_version (version) VALUES ($1)'));
    expect(stamp?.params).toHaveLength(1);
    expect(texts.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
  });

  it('does not record the schema version when a swallowed ALTER timed out on its lock, and still unlocks', async () => {
    const { client, pool } = stubDatabase({
      current: false,
      clientRespond: text => {
        if (text.startsWith('ALTER TABLE orders ADD COLUMN IF NOT EXISTS sale_gift_amount')) throw sqlError('55P03');
        return undefined;
      },
    });

    await expect(initDb()).rejects.toThrow(/timed out.*sale_gift_amount/);

    expect([...client.texts(), ...pool.texts()].some(text => text.startsWith('INSERT INTO schema_version'))).toBe(false);
    expect(client.texts().slice(-2)).toEqual(['RESET lock_timeout; RESET statement_timeout', 'SELECT pg_advisory_unlock($1)']);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('destroys the session (releasing the advisory lock server-side) when it cannot be cleaned up', async () => {
    const { client } = stubDatabase({
      clientRespond: text => {
        if (text.startsWith('SELECT pg_advisory_unlock')) throw new Error('Connection terminated');
        return undefined;
      },
    });

    await initDb();

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('does not connect at all when startup migrations are disabled', async () => {
    delete process.env.RUN_SCHEMA_MIGRATIONS;
    const { pool } = stubDatabase();

    await initDb();

    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
