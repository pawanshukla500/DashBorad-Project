import dotenv from 'dotenv';
import pg from 'pg';
import { resolvePgConfig } from '../db/index.js';

dotenv.config();

const config = resolvePgConfig();
if (!config.connectionString && !(config.host && config.database && config.user && config.password)) {
  throw new Error('DATABASE_URL or PG_* settings are required for PostgreSQL maintenance.');
}

const pool = new pg.Pool({ ...config, connectionTimeoutMillis: 10_000, max: 1, min: 0 });

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

try {
  const { rows } = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  for (const { table_name: table } of rows) {
    await pool.query(`VACUUM (ANALYZE) public.${quoteIdentifier(table)}`);
  }
  console.log(`PostgreSQL maintenance completed for ${rows.length} application tables.`);
} finally {
  await pool.end();
}
