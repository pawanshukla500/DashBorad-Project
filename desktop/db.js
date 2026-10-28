import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getResolvedUserDataDir } from './cookieVault.js';
import { sanitizeSavedDbUrl } from './dbUrlGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

// Parse PostgreSQL DATE directly as string 'YYYY-MM-DD'
if (pg.types?.setTypeParser) {
  pg.types.setTypeParser(1082, (val) => val);
}

let activePool = null;
let activeConnectionString = null;
let analystDatabaseUrl = null;

// A verified analyst session must never fall back to a writer URL from the
// environment, a manual argument, or a previous operator's configuration.
export function setDesktopDatabaseAccess(role, databaseUrl = '') {
  analystDatabaseUrl = role === 'analyst' ? String(databaseUrl || '').trim() : null;
}

function loadLocalEnvFiles() {
  for (const envPath of [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../backend/.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'backend/.env')
  ]) {
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            let val = trimmed.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (process.env[key] === undefined && val !== undefined) {
              process.env[key] = val;
            }
          }
        }
      }
    } catch {}
  }
}
loadLocalEnvFiles();

/**
 * Resolves PostgreSQL connection URL in order of priority:
 * 1. Explicit argument
 * 2. process.env.DATABASE_URL or process.env.RECON_DATABASE_URL
 * 3. Saved worker configuration in userData: `worker-config.json`
 * 4. Local `.env` or `backend/.env` (if running in repo workspace)
 */
export function resolveDatabaseUrl(customUrl = null) {
  if (analystDatabaseUrl !== null) return analystDatabaseUrl || null;
  loadLocalEnvFiles();
  if (customUrl && typeof customUrl === 'string' && customUrl.trim()) {
    return customUrl.trim();
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim()) {
    return process.env.DATABASE_URL.trim();
  }
  if (process.env.RECON_DATABASE_URL && process.env.RECON_DATABASE_URL.trim()) {
    return process.env.RECON_DATABASE_URL.trim();
  }

  // Check saved worker-config.json in user-data dir
  try {
    const configPath = path.join(getResolvedUserDataDir(), 'worker-config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // Container-internal hosts (e.g. postgres:5432 provisioned by old server
      // builds) are discarded so callers get a clear "not configured" error.
      const savedUrl = sanitizeSavedDbUrl(parsed?.databaseUrl);
      if (savedUrl) {
        return savedUrl;
      }
    }
  } catch {}

  // Check system-wide Linux configuration (/etc/reconcentral-ratecard/worker-config.json)
  if (process.platform === 'linux') {
    try {
      const sysConfigPath = '/etc/reconcentral-ratecard/worker-config.json';
      if (fs.existsSync(sysConfigPath)) {
        const parsed = JSON.parse(fs.readFileSync(sysConfigPath, 'utf8'));
        const savedUrl = sanitizeSavedDbUrl(parsed?.databaseUrl);
        if (savedUrl) {
          return savedUrl;
        }
      }
    } catch {}
  }

  return null;
}

function optionalBoolean(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function urlRequiresSsl(connectionString) {
  try {
    const sslmode = new URL(connectionString).searchParams.get('sslmode')?.toLowerCase();
    return ['require', 'verify-ca', 'verify-full'].includes(sslmode);
  } catch {
    return false;
  }
}

function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1';
}

/**
 * Configure SSL for PostgreSQL connection with secure defaults.
 * Disables SSL for local loopback development, validates certificates by default for remote hosts,
 * and honors PG_SSL, PG_SSL_CA, and PG_SSL_REJECT_UNAUTHORIZED environment variables.
 */
export function configuredSsl(connectionString) {
  if (!connectionString) return false;

  const sslSetting = process.env.PG_SSL;
  const rejectUnauthorizedSetting = process.env.PG_SSL_REJECT_UNAUTHORIZED;
  const caSetting = process.env.PG_SSL_CA;
  const explicitSsl = optionalBoolean(sslSetting);

  let isLoopback = false;
  try {
    const url = new URL(connectionString);
    isLoopback = isLoopbackHost(url.hostname);
  } catch {}

  const enabled = explicitSsl != null ? explicitSsl : (!isLoopback && (urlRequiresSsl(connectionString) || !connectionString.includes('localhost')));
  if (!enabled) return false;

  const isDevOrTest = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const rejectUnauthorized = optionalBoolean(rejectUnauthorizedSetting) ?? !isDevOrTest;
  const ca = String(caSetting || '').trim();

  return {
    rejectUnauthorized,
    ...(ca ? { ca: ca.replace(/\\n/g, '\n') } : {})
  };
}

/**
 * Get or create resilient PostgreSQL connection pool for Desktop application.
 */
export function getDesktopPool(customUrl = null) {
  const dbUrl = resolveDatabaseUrl(customUrl);
  if (!dbUrl) {
    throw new Error('Database connection URL not configured. Please authorize the desktop app or provide DATABASE_URL.');
  }

  if (activePool && activeConnectionString === dbUrl) {
    return activePool;
  }

  if (activePool) {
    try { activePool.end(); } catch {}
  }

  activeConnectionString = dbUrl;
  const ssl = configuredSsl(dbUrl);
  activePool = new Pool({
    connectionString: dbUrl,
    ...(ssl ? { ssl } : {}),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
  });

  activePool.on('error', (err) => {
    console.warn('[Desktop DB Pool] Background error:', err.message);
  });

  return activePool;
}

/**
 * Cleanly close the desktop database pool.
 */
export async function closeDesktopPool() {
  if (activePool) {
    const p = activePool;
    activePool = null;
    activeConnectionString = null;
    await p.end();
  }
}

/**
 * Test connectivity, ping latency, and retrieve database metadata.
 */
export async function testDatabaseConnection(customUrl = null) {
  const pool = getDesktopPool(customUrl);
  const start = Date.now();
  const res = await pool.query(`
    SELECT 
      current_database() as db_name, 
      current_user as db_user, 
      version() as db_version,
      NOW() as server_time
  `);
  const latency = Date.now() - start;
  return {
    success: true,
    latencyMs: latency,
    dbName: res.rows[0].db_name,
    dbUser: res.rows[0].db_user,
    serverTime: res.rows[0].server_time
  };
}

/**
 * Safe parameterized query executor.
 */
export async function executeQuery(sql, params = []) {
  const pool = getDesktopPool();
  return await pool.query(sql, params);
}

export const ALLOWED_TABLES = new Set([
  'orders',
  'returns',
  'settlements',
  'rc_commission',
  'rc_fixed_fee',
  'rc_collection_fee',
  'rc_reverse_shipping',
  'rate_card_versions',
  'sku_master',
  'vb_sku_master'
]);

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ORDER_BY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*(\s+(ASC|DESC))?$/i;

/**
 * Extensible: Download table details / records for offline desktop usage or local sync.
 * Completely parameterized and guarded against SQL injection.
 */
export async function downloadTableDetails(tableName, options = {}) {
  const pool = getDesktopPool();
  const safeTable = String(tableName || '').trim().toLowerCase();

  if (!ALLOWED_TABLES.has(safeTable)) {
    throw new Error(`Table "${tableName}" is not in the allowed query allowlist.`);
  }

  const { filters = {}, orderBy = 'id DESC', limit = 500 } = options;

  const queryParams = [];
  const whereClauses = [];

  if (filters && typeof filters === 'object' && !Array.isArray(filters)) {
    for (const [col, val] of Object.entries(filters)) {
      if (!IDENTIFIER_REGEX.test(col)) {
        throw new Error(`Invalid column identifier in filter: "${col}"`);
      }
      queryParams.push(val);
      whereClauses.push(`"${col}" = $${queryParams.length}`);
    }
  }

  let safeOrderBy = 'id DESC';
  if (orderBy && typeof orderBy === 'string' && ORDER_BY_REGEX.test(orderBy.trim())) {
    safeOrderBy = orderBy.trim();
  }

  const clampedLimit = Math.min(Math.max(1, parseInt(limit, 10) || 500), 5000);

  let sql = `SELECT * FROM "${safeTable}"`;
  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }
  sql += ` ORDER BY ${safeOrderBy}`;
  sql += ` LIMIT ${clampedLimit}`;

  const res = await pool.query(sql, queryParams);
  return {
    table: safeTable,
    count: res.rows.length,
    downloadedAt: new Date().toISOString(),
    rows: res.rows
  };
}

/**
 * Extensible: Upload local table updates to PostgreSQL.
 * Validates table against allowlist and checks all column identifiers.
 */
export async function uploadTableUpdates(tableName, rows = [], keyColumns = ['id']) {
  if (!rows || rows.length === 0) return { updated: 0 };
  const pool = getDesktopPool();
  const safeTable = String(tableName || '').trim().toLowerCase();

  if (!ALLOWED_TABLES.has(safeTable)) {
    throw new Error(`Table "${tableName}" is not in the allowed update allowlist.`);
  }

  for (const col of keyColumns) {
    if (!IDENTIFIER_REGEX.test(col)) {
      throw new Error(`Invalid key column identifier: "${col}"`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let count = 0;
    for (const row of rows) {
      const keys = Object.keys(row);
      for (const k of keys) {
        if (!IDENTIFIER_REGEX.test(k)) {
          throw new Error(`Invalid column identifier in row: "${k}"`);
        }
      }
      const values = Object.values(row);
      const cols = keys.map(k => `"${k}"`).join(', ');
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      const conflictCols = keyColumns.map(k => `"${k}"`).join(', ');
      const updateCols = keys
        .filter(k => !keyColumns.includes(k))
        .map(k => `"${k}" = EXCLUDED."${k}"`)
        .join(', ');

      const upsertSql = updateCols
        ? `INSERT INTO "${safeTable}" (${cols}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols}`
        : `INSERT INTO "${safeTable}" (${cols}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO NOTHING`;

      const res = await client.query(upsertSql, values);
      count += (res.rowCount || 0);
    }
    await client.query('COMMIT');
    return { success: true, updated: count };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.warn('[Desktop DB] Rollback error ignored to preserve original query failure:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}
