import dotenv from 'dotenv';
import pg from 'pg';
import { resolvePgConfig } from '../db/index.js';

dotenv.config();

const config = resolvePgConfig();
if (!config.connectionString && !(config.host && config.database && config.user && config.password)) {
  throw new Error('DATABASE_URL or PG_* settings are required for PostgreSQL verification.');
}

const pool = new pg.Pool({ ...config, connectionTimeoutMillis: 10_000, max: 1, min: 0 });

try {
  const [identity, uploadStats, history, dataCenterCounts, reconciliationIntegrity] = await Promise.all([
    pool.query('SELECT current_database() AS database, version() AS version'),
    pool.query(`
      SELECT
        (SELECT COUNT(*)::bigint FROM upload_log) AS upload_history_rows,
        (SELECT COUNT(*)::bigint FROM upload_skipped_rows) AS skipped_row_details
    `),
    pool.query(`
      SELECT id, data_type, marketplace, status, uploaded_at
      FROM upload_log
      ORDER BY uploaded_at DESC, id DESC
      LIMIT 5
    `),
    pool.query(`
      SELECT
        (SELECT COUNT(*)::bigint FROM orders) AS orders,
        (SELECT COUNT(*)::bigint FROM returns) AS returns,
        (SELECT COUNT(*)::bigint FROM fk_settlement_orders) AS fk_settlement_orders,
        (SELECT COUNT(*)::bigint FROM amazon_settlement_lines) AS amazon_settlement_lines,
        (SELECT COUNT(*)::bigint FROM amazon_settlements) AS amazon_settlements
    `),
    pool.query(`
      SELECT
        (SELECT COUNT(*)::bigint FROM audit_events) AS audit_events,
        (SELECT COUNT(*)::bigint FROM mp_invoices WHERE source_fingerprint IS NOT NULL) AS fingerprinted_invoices,
        (SELECT COUNT(*)::bigint FROM mp_ledger_entries WHERE source_fingerprint IS NOT NULL) AS fingerprinted_ledger_entries,
        (SELECT COUNT(*)::bigint FROM (
          SELECT source_fingerprint
          FROM mp_invoices
          WHERE source_fingerprint IS NOT NULL
          GROUP BY source_fingerprint
          HAVING COUNT(*) > 1
        ) duplicate_invoice_fingerprints) AS duplicate_invoice_fingerprints,
        (SELECT COUNT(*)::bigint FROM (
          SELECT source_fingerprint
          FROM mp_ledger_entries
          WHERE source_fingerprint IS NOT NULL
          GROUP BY source_fingerprint
          HAVING COUNT(*) > 1
        ) duplicate_ledger_fingerprints) AS duplicate_ledger_fingerprints,
        (SELECT COUNT(*)::bigint FROM schema_version WHERE version IN (
          '2026.08.mp-invoice-idempotency-1',
          '2026.08.mp-ledger-idempotency-1'
        )) AS reconciliation_schema_migrations
    `),
  ]);

  console.log(JSON.stringify({
    ok: true,
    activeDatabase: 'postgresql',
    sslEnabled: Boolean(config.ssl),
    sslRejectUnauthorized: config.ssl ? config.ssl.rejectUnauthorized !== false : null,
    database: identity.rows[0]?.database,
    server: String(identity.rows[0]?.version || '').split(',')[0],
    uploadHistory: uploadStats.rows[0],
    dataCenterCounts: dataCenterCounts.rows[0],
    reconciliationIntegrity: reconciliationIntegrity.rows[0],
    recentUploads: history.rows,
  }, null, 2));
} finally {
  await pool.end();
}
