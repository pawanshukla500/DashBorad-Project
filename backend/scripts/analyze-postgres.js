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
// in alphabetical order was never maintained. Maintenance has no statement
// timeout, but a finite lock_timeout: a table held by a conflicting lock fails
// fast and the run continues, while a long VACUUM that is making progress is
// never cancelled.
const LOCK_TIMEOUT_MS = Number.parseInt(process.env.MAINTENANCE_LOCK_TIMEOUT_MS, 10) > 0
  ? Number.parseInt(process.env.MAINTENANCE_LOCK_TIMEOUT_MS, 10)
  : 30_000;

const pool = new pg.Pool({
  ...config,
  statement_timeout: 0,
  lock_timeout: LOCK_TIMEOUT_MS,
  connectionTimeoutMillis: 10_000,
  max: 1,
  min: 0,
  application_name: 'reconcentral-maintenance',
});

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// PostgreSQL does not reject VACUUM on a table the role may not maintain: it
// skips the table with a WARNING notice ("skipping ... only table or database
// owner can vacuum it" / "permission denied to vacuum"). Capture those so the
// table is reported as failed instead of maintained.
const SKIP_NOTICE = /skipping|permission denied/i;

let failed = 0;
const client = await pool.connect();
const notices = [];
client.on('notice', notice => notices.push(notice?.message || String(notice)));
try {
  const { rows } = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  for (const { table_name: table } of rows) {
    const started = Date.now();
    notices.length = 0;
    try {
      await client.query(`VACUUM (ANALYZE) public.${quoteIdentifier(table)}`);
      const skip = notices.find(message => SKIP_NOTICE.test(message));
      if (skip) {
        failed += 1;
        console.warn(`  ${table}: skipped by PostgreSQL (${skip})`);
      } else {
        console.log(`  ${table}: ${Date.now() - started} ms`);
      }
    } catch (error) {
      // One locked or unpermitted table must not skip the rest.
      failed += 1;
      console.warn(`  ${table}: skipped (${error.message})`);
    }
  }
  console.log(`PostgreSQL maintenance completed for ${rows.length - failed} of ${rows.length} application tables.`);
} finally {
  client.release();
  await pool.end();
}
if (failed) process.exitCode = 1;
