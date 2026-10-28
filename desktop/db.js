import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getResolvedUserDataDir } from './cookieVault.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

// Parse PostgreSQL DATE directly as string 'YYYY-MM-DD'
if (pg.types?.setTypeParser) {
  pg.types.setTypeParser(1082, (val) => val);
}

let activePool = null;
let activeConnectionString = null;

/**
 * Resolves PostgreSQL connection URL in order of priority:
 * 1. Explicit argument
 * 2. process.env.DATABASE_URL or process.env.RECON_DATABASE_URL
 * 3. Saved worker configuration in userData: `worker-config.json`
 * 4. Local `.env` or `backend/.env` (if running in repo workspace)
 */
export function resolveDatabaseUrl(customUrl = null) {
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
      if (parsed && parsed.databaseUrl && String(parsed.databaseUrl).trim()) {
        return String(parsed.databaseUrl).trim();
      }
    }
  } catch {}

  // Fallback to checking local .env paths (for local dev)
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
          if (trimmed.startsWith('DATABASE_URL=')) {
            let val = trimmed.slice('DATABASE_URL='.length).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (val) return val;
          }
        }
      }
    } catch {}
  }

  return null;
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
  activePool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
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

/**
 * Extensible: Download table details / records for offline desktop usage or local sync.
 */
export async function downloadTableDetails(tableName, options = {}) {
  const pool = getDesktopPool();
  const { whereClause = '', params = [], limit = 1000, orderBy = 'id DESC' } = options;
  
  // Sanitize table name (letters, numbers, underscores only)
  const safeTable = String(tableName).replace(/[^a-zA-Z0-9_]/g, '');
  let sql = `SELECT * FROM ${safeTable}`;
  if (whereClause) {
    sql += ` WHERE ${whereClause}`;
  }
  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }
  if (limit) {
    sql += ` LIMIT ${Number(limit) || 1000}`;
  }

  const res = await pool.query(sql, params);
  return {
    table: safeTable,
    count: res.rows.length,
    downloadedAt: new Date().toISOString(),
    rows: res.rows
  };
}

/**
 * Extensible: Upload local table updates to PostgreSQL.
 */
export async function uploadTableUpdates(tableName, rows = [], keyColumns = ['id']) {
  if (!rows || rows.length === 0) return { updated: 0 };
  const pool = getDesktopPool();
  const safeTable = String(tableName).replace(/[^a-zA-Z0-9_]/g, '');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let count = 0;
    for (const row of rows) {
      const keys = Object.keys(row);
      const values = Object.values(row);
      const cols = keys.map(k => `"${k.replace(/"/g, '')}"`).join(', ');
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      const conflictCols = keyColumns.map(k => `"${k.replace(/"/g, '')}"`).join(', ');
      const updateCols = keys.filter(k => !keyColumns.includes(k)).map(k => `"${k.replace(/"/g, '')}" = EXCLUDED."${k.replace(/"/g, '')}"`).join(', ');
      
      const upsertSql = updateCols 
        ? `INSERT INTO ${safeTable} (${cols}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols}`
        : `INSERT INTO ${safeTable} (${cols}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO NOTHING`;
        
      await client.query(upsertSql, values);
      count++;
    }
    await client.query('COMMIT');
    return { success: true, updated: count };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
