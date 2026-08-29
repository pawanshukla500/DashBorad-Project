/*
 * One-time CockroachDB -> PostgreSQL migration for this application.
 *
 * Usage (PowerShell):
 *   $env:POSTGRES_MIGRATION_TARGET_URL='postgresql://...'
 *   node scripts/migrate-cockroach-to-postgres.js preflight
 *   node scripts/migrate-cockroach-to-postgres.js migrate --confirm-empty-target
 *
 * Source: DATABASE_URL from backend/.env (the existing CockroachDB database)
 * Target: POSTGRES_MIGRATION_TARGET_URL (never stored in this repository)
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ override: false });

const { Pool } = pg;
const SOURCE_URL = process.env.DATABASE_URL?.trim();
const TARGET_URL = process.env.POSTGRES_MIGRATION_TARGET_URL?.trim();
const BATCH_SIZE = 250;
const command = process.argv[2] || 'preflight';
const confirmed = process.argv.includes('--confirm-empty-target');

function redact(url) {
  return String(url || '').replace(/:([^:@/]+)@/, ':***@');
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableSql(table) {
  return `public.${quoteIdentifier(table)}`;
}

function qualifiedIdentifier(value) {
  return String(value).split('.').map(quoteIdentifier).join('.');
}

function assertConfiguration() {
  if (!SOURCE_URL?.startsWith('postgres')) throw new Error('DATABASE_URL must contain the current CockroachDB connection string.');
  if (!TARGET_URL?.startsWith('postgres')) throw new Error('POSTGRES_MIGRATION_TARGET_URL must contain the new PostgreSQL connection string.');
  if (SOURCE_URL === TARGET_URL) throw new Error('Source and target connection strings must be different.');
}

function poolFor(connectionString, sslSetting = process.env.PG_SSL) {
  // The existing CockroachDB deployment requires TLS. By default use the same
  // PG_SSL setting as the application; either side can be overridden with
  // MIGRATION_SOURCE_PG_SSL / MIGRATION_TARGET_PG_SSL when required.
  const useSsl = String(sslSetting || '').toLowerCase() === 'true';
  return new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    max: 3,
  });
}

async function databaseIdentity(pool) {
  const result = await pool.query('SELECT current_database() AS database, version() AS version');
  return result.rows[0];
}

async function publicTables(pool) {
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map(row => row.table_name);
}

async function rowCount(pool, table) {
  const result = await pool.query(`SELECT COUNT(*)::bigint AS count FROM ${tableSql(table)}`);
  return Number(result.rows[0]?.count || 0);
}

async function tableCounts(pool, tables) {
  const counts = {};
  for (const table of tables) counts[table] = await rowCount(pool, table);
  return counts;
}

async function preflight() {
  assertConfiguration();
  const source = poolFor(SOURCE_URL, process.env.MIGRATION_SOURCE_PG_SSL || process.env.PG_SSL);
  const target = poolFor(TARGET_URL, process.env.MIGRATION_TARGET_PG_SSL || process.env.PG_SSL);
  try {
    const [sourceIdentity, targetIdentity, sourceTables, targetTables] = await Promise.all([
      databaseIdentity(source), databaseIdentity(target), publicTables(source), publicTables(target),
    ]);
    const sourceCounts = await tableCounts(source, sourceTables);
    const targetCounts = await tableCounts(target, targetTables);
    const targetData = Object.entries(targetCounts).filter(([, count]) => count > 0);

    console.log(JSON.stringify({
      source: { connection: redact(SOURCE_URL), ...sourceIdentity, tables: sourceTables.length, totalRows: Object.values(sourceCounts).reduce((sum, count) => sum + count, 0), counts: sourceCounts },
      target: { connection: redact(TARGET_URL), ...targetIdentity, tables: targetTables.length, totalRows: Object.values(targetCounts).reduce((sum, count) => sum + count, 0), counts: targetCounts },
      readyToMigrate: targetData.length === 0,
      targetDataTables: targetData.map(([table, count]) => ({ table, count })),
    }, null, 2));
    if (targetData.length) process.exitCode = 2;
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

async function columnsFor(pool, table) {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  return result.rows.map(row => row.column_name);
}

async function serialColumnsFor(pool, table) {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
      AND column_default LIKE 'nextval%'
    ORDER BY ordinal_position
  `, [table]);
  return result.rows.map(row => row.column_name);
}

async function bigintColumnsFor(pool, tables) {
  if (!tables.length) return [];
  const result = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1)
      AND data_type = 'bigint'
    ORDER BY table_name, ordinal_position
  `, [tables]);
  return result.rows;
}

async function integerColumnsFor(pool, tables) {
  if (!tables.length) return [];
  const result = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1)
      AND data_type = 'integer'
    ORDER BY table_name, ordinal_position
  `, [tables]);
  return result.rows;
}

async function alignBigintColumns(source, target, tables) {
  const [sourceBigints, targetIntegers] = await Promise.all([
    bigintColumnsFor(source, tables),
    integerColumnsFor(target, tables),
  ]);
  const targetIntegerSet = new Set(targetIntegers.map(row => `${row.table_name}.${row.column_name}`));
  const corrections = sourceBigints.filter(row => targetIntegerSet.has(`${row.table_name}.${row.column_name}`));
  if (!corrections.length) return;

  // CockroachDB INT/SERIAL is 64-bit. PostgreSQL's INTEGER/SERIAL is 32-bit,
  // so preserve the actual source type before importing generated row IDs.
  for (const { table_name: table, column_name: column } of corrections) {
    await target.query(`ALTER TABLE ${tableSql(table)} ALTER COLUMN ${quoteIdentifier(column)} TYPE BIGINT`);
  }
  console.log(`[migration] aligned ${corrections.length} CockroachDB BIGINT columns for PostgreSQL`);
}

async function primaryKeyColumnsFor(pool, table) {
  const result = await pool.query(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_catalog = tc.constraint_catalog
      AND kcu.constraint_schema = tc.constraint_schema
      AND kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
      AND kcu.table_name = tc.table_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name = $1
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position
  `, [table]);
  return result.rows.map(row => row.column_name);
}

async function insertBatch(target, table, columns, rows) {
  if (!rows.length) return;
  const values = [];
  const groups = rows.map(row => {
    const start = values.length;
    values.push(...columns.map(column => row[column]));
    return `(${columns.map((_, index) => `$${start + index + 1}`).join(', ')})`;
  });
  await target.query(`
    INSERT INTO ${tableSql(table)} (${columns.map(quoteIdentifier).join(', ')})
    VALUES ${groups.join(', ')}
    ON CONFLICT DO NOTHING
  `, values);
}

async function copyTable(source, target, table) {
  const [sourceColumns, targetColumns, primaryKeyColumns] = await Promise.all([
    columnsFor(source, table),
    columnsFor(target, table),
    primaryKeyColumnsFor(source, table),
  ]);
  const targetColumnSet = new Set(targetColumns);
  const columns = sourceColumns.filter(column => targetColumnSet.has(column));
  if (!columns.length) throw new Error(`${table}: source and target have no common columns.`);
  const sourceOnly = sourceColumns.filter(column => !targetColumnSet.has(column));
  if (sourceOnly.length) console.warn(`[migration] ${table}: source-only columns skipped because the current target schema has no matching column: ${sourceOnly.join(', ')}`);

  const columnSql = columns.map(quoteIdentifier).join(', ');
  const canUsePrimaryKeyCursor = primaryKeyColumns.length > 0 && primaryKeyColumns.every(column => columns.includes(column));
  if (!canUsePrimaryKeyCursor) {
    console.warn(`[migration] ${table}: no transferable primary key; using OFFSET fallback while the source is quiet.`);
    let offset = 0;
    let copied = 0;
    while (true) {
      const batch = await source.query(`SELECT ${columnSql} FROM ${tableSql(table)} LIMIT $1 OFFSET $2`, [BATCH_SIZE, offset]);
      if (!batch.rows.length) return copied;
      await insertBatch(target, table, columns, batch.rows);
      copied += batch.rows.length;
      offset += batch.rows.length;
      if (copied % 5_000 === 0) console.log(`[migration] ${table}: ${copied} rows copied`);
    }
  }

  let copied = 0;
  let lastKey = null;
  const keySql = primaryKeyColumns.map(quoteIdentifier).join(', ');
  while (true) {
    // A primary-key cursor remains fast as a table grows and is stable while
    // the source is kept quiet for the migration.
    const cursorClause = lastKey
      ? ` WHERE (${keySql}) > (${lastKey.map((_, index) => `$${index + 1}`).join(', ')})`
      : '';
    const orderClause = primaryKeyColumns.length ? ` ORDER BY ${keySql}` : '';
    const batchParams = lastKey ? [...lastKey, BATCH_SIZE] : [BATCH_SIZE];
    const batch = await source.query(
      `SELECT ${columnSql} FROM ${tableSql(table)}${cursorClause}${orderClause} LIMIT $${batchParams.length}`,
      batchParams,
    );
    if (!batch.rows.length) break;
    await insertBatch(target, table, columns, batch.rows);
    copied += batch.rows.length;
    lastKey = primaryKeyColumns.map(column => batch.rows[batch.rows.length - 1][column]);
    if (copied % 5_000 === 0) console.log(`[migration] ${table}: ${copied} rows copied`);
  }
  return copied;
}

async function resetSequences(target, tables) {
  for (const table of tables) {
    const columns = await serialColumnsFor(target, table);
    for (const column of columns) {
      const sequence = await target.query('SELECT pg_get_serial_sequence($1, $2) AS name', [`public.${table}`, column]);
      const sequenceName = sequence.rows[0]?.name;
      if (!sequenceName) continue;
      await target.query(`ALTER SEQUENCE ${qualifiedIdentifier(sequenceName)} AS BIGINT`);
      await target.query(`
        SELECT setval($1::regclass, COALESCE((SELECT MAX(${quoteIdentifier(column)}) FROM ${tableSql(table)}), 1), TRUE)
      `, [sequenceName]);
    }
  }
}

async function createTargetSchema() {
  // The schema initializer intentionally uses the new target connection. The
  // source URL was captured above before DATABASE_URL is changed.
  const previousUrl = process.env.DATABASE_URL;
  const previousSsl = process.env.PG_SSL;
  const previousSeedEmail = process.env.ADMIN_SEED_EMAIL;
  const previousSeedPassword = process.env.ADMIN_SEED_PASSWORD;
  process.env.DATABASE_URL = TARGET_URL;
  process.env.PG_SSL = process.env.MIGRATION_TARGET_PG_SSL || process.env.PG_SSL;
  delete process.env.ADMIN_SEED_EMAIL;
  delete process.env.ADMIN_SEED_PASSWORD;
  try {
    const { initDb } = await import('../db/initDb.js');
    const { getPool } = await import('../db/index.js');
    await initDb();
    return getPool();
  } finally {
    process.env.DATABASE_URL = previousUrl;
    if (previousSsl !== undefined) process.env.PG_SSL = previousSsl;
    else delete process.env.PG_SSL;
    if (previousSeedEmail !== undefined) process.env.ADMIN_SEED_EMAIL = previousSeedEmail;
    if (previousSeedPassword !== undefined) process.env.ADMIN_SEED_PASSWORD = previousSeedPassword;
  }
}

async function migrate() {
  assertConfiguration();
  if (!confirmed) throw new Error('Refusing to write to PostgreSQL. Re-run with --confirm-empty-target after reviewing preflight output.');
  const sourcePool = poolFor(SOURCE_URL, process.env.MIGRATION_SOURCE_PG_SSL || process.env.PG_SSL);
  const targetPreflight = poolFor(TARGET_URL, process.env.MIGRATION_TARGET_PG_SSL || process.env.PG_SSL);
  let target = null;
  let source = null;
  let sourceTransactionOpen = false;
  try {
    const existingTables = await publicTables(targetPreflight);
    const existingCounts = await tableCounts(targetPreflight, existingTables);
    const nonEmpty = Object.entries(existingCounts).filter(([, count]) => count > 0);
    if (nonEmpty.length) {
      throw new Error(`Target is not empty. Migration stopped without changing it: ${nonEmpty.map(([table, count]) => `${table}=${count}`).join(', ')}`);
    }
    await targetPreflight.end();

    // Keep every source metadata query, row count, and batch read on one
    // read-only CockroachDB snapshot. New uploads can continue, but they will
    // not leak partially into this one-time migration.
    source = await sourcePool.connect();
    await source.query('BEGIN READ ONLY');
    sourceTransactionOpen = true;

    target = await createTargetSchema();
    const [sourceTables, targetTables] = await Promise.all([publicTables(source), publicTables(target)]);
    const targetSet = new Set(targetTables);
    const tables = sourceTables.filter(table => targetSet.has(table));
    const missingTables = sourceTables.filter(table => !targetSet.has(table));
    if (missingTables.length) throw new Error(`Target schema is missing source tables: ${missingTables.join(', ')}`);

    // Views prevent a dependent column type from changing. Re-create them
    // after the table type alignment, before importing the source rows.
    await target.query('DROP VIEW IF EXISTS public.order_returns');
    await target.query('DROP VIEW IF EXISTS public.unified_settlements');
    await alignBigintColumns(source, target, tables);
    await createTargetSchema();

    // initDb intentionally seeds configuration rows. The target was confirmed
    // empty before this run, so truncating only migrated tables is safe and
    // ensures source configuration wins over new-install defaults.
    if (tables.length) await target.query(`TRUNCATE ${tables.map(tableSql).join(', ')} RESTART IDENTITY CASCADE`);

    const sourceCounts = {};
    for (const table of tables) {
      sourceCounts[table] = await rowCount(source, table);
      console.log(`[migration] ${table}: copying ${sourceCounts[table]} rows`);
      const copied = await copyTable(source, target, table);
      if (copied !== sourceCounts[table]) throw new Error(`${table}: source changed during migration (${sourceCounts[table]} expected, ${copied} read). Re-run migration from a quiet source.`);
    }
    await resetSequences(target, tables);

    const targetCounts = await tableCounts(target, tables);
    const mismatches = tables
      .filter(table => sourceCounts[table] !== targetCounts[table])
      .map(table => ({ table, source: sourceCounts[table], target: targetCounts[table] }));
    if (mismatches.length) throw new Error(`Validation failed: ${JSON.stringify(mismatches)}`);

    await source.query('COMMIT');
    sourceTransactionOpen = false;

    console.log(JSON.stringify({
      ok: true,
      source: redact(SOURCE_URL),
      target: redact(TARGET_URL),
      tablesMigrated: tables.length,
      rowsMigrated: Object.values(sourceCounts).reduce((sum, count) => sum + count, 0),
      counts: targetCounts,
    }, null, 2));
  } finally {
    if (sourceTransactionOpen) await source?.query('ROLLBACK').catch(() => {});
    source?.release();
    await sourcePool.end().catch(() => {});
    await targetPreflight.end().catch(() => {});
    await target?.end().catch(() => {});
  }
}

if (command === 'preflight') await preflight();
else if (command === 'migrate') await migrate();
else throw new Error(`Unknown command: ${command}. Use preflight or migrate.`);
