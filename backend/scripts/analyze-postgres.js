import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const connectionString = process.env.POSTGRES_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!connectionString || process.env.DATABASE_ENGINE !== 'postgresql') {
  throw new Error('DATABASE_URL is not marked as the active PostgreSQL connection.');
}

const ssl = String(process.env.POSTGRES_PG_SSL ?? process.env.PG_SSL ?? '').toLowerCase() === 'true'
  ? { rejectUnauthorized: false }
  : false;
const pool = new pg.Pool({ connectionString, ssl, connectionTimeoutMillis: 10_000, max: 1 });

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
