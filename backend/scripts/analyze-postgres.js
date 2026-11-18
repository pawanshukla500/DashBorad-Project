import dotenv from 'dotenv';
import pg from 'pg';
import { resolvePgConfig } from '../db/index.js';

dotenv.config();

const config = resolvePgConfig();
if (!config.connectionString && !(config.host && config.database && config.user && config.password)) {
  throw new Error('DATABASE_URL or PG_* settings are required for PostgreSQL maintenance.');
}

// resolvePgConfig() carries the API's 45 s read statement_timeout. VACUUM
// (ANALYZE) on a large table (orders, settlements, amazon_settlement_lines)
// takes longer, so it was cancelled and the loop stopped: every table after it
// in alphabetical order was never maintained. Maintenance has no timeout.
const pool = new pg.Pool({
  ...config,
  statement_timeout: 0,
  connectionTimeoutMillis: 10_000,
  max: 1,
  min: 0,
  application_name: 'reconcentral-maintenance',
});

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

let failed = 0;
try {
  const { rows } = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  for (const { table_name: table } of rows) {
    const started = Date.now();
    try {
      await pool.query(`VACUUM (ANALYZE) public.${quoteIdentifier(table)}`);
      console.log(`  ${table}: ${Date.now() - started} ms`);
    } catch (error) {
      // One locked or unpermitted table must not skip the rest.
      failed += 1;
      console.warn(`  ${table}: skipped (${error.message})`);
    }
  }
  console.log(`PostgreSQL maintenance completed for ${rows.length - failed} of ${rows.length} application tables.`);
} finally {
  await pool.end();
}
if (failed) process.exitCode = 1;
