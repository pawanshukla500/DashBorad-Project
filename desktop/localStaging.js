/**
 * Desktop Local SQLite Staging Module
 * 
 * Provides robust, crash-resilient local staging for in-flight rate card extractions.
 * Uses WebAssembly SQLite (sql.js) with file persistence to ensure zero native C++
 * compilation issues during packaging, cross-platform stability, and genuine SQLite
 * binary storage on disk.
 */
import path from 'node:path';
import fs from 'node:fs';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();

let dbInstance = null;
let currentDbPath = null;

function persist(db, filePath) {
  const target = filePath || currentDbPath;
  if (!db || !target) return;
  try {
    const data = db.export();
    const tmpPath = `${target}.tmp.${Date.now()}`;
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try { fs.writeFileSync(fd, Buffer.from(data)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmpPath, target);
  } catch (err) {
    console.error('[Local Staging] Failed to persist SQLite db:', err.message);
    throw err;
  }
}

export function getStagingDb(userDataDir) {
  const resolvedDir = userDataDir || (process.env.APPDATA ? path.join(process.env.APPDATA, 'reconcentral-ratecard-worker') : process.cwd());
  const dbPath = path.join(resolvedDir, 'staging.db');

  if (dbInstance && currentDbPath === dbPath) {
    return dbInstance;
  }

  if (dbInstance) {
    try {
      persist(dbInstance, currentDbPath);
      dbInstance.close();
    } catch {}
    dbInstance = null;
  }

  fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  currentDbPath = dbPath;

  if (fs.existsSync(dbPath)) {
    try {
      const fileBuffer = fs.readFileSync(dbPath);
      dbInstance = new SQL.Database(fileBuffer);
    } catch (err) {
      throw new Error(`Existing SQLite staging database could not be opened; it was preserved for recovery: ${err.message}`);
    }
  } else {
    dbInstance = new SQL.Database();
  }

  // Backwards-compatible pragma helper
  dbInstance.pragma = function (sqlPragma, opts) {
    try {
      const res = dbInstance.exec(`PRAGMA ${sqlPragma};`);
      if (opts?.simple) {
        return res[0]?.values[0]?.[0];
      }
      return res;
    } catch {
      return null;
    }
  };

  // Performance and schema setup
  dbInstance.run('PRAGMA journal_mode = WAL;');
  dbInstance.run('PRAGMA synchronous = NORMAL;');
  dbInstance.run('PRAGMA foreign_keys = ON;');

  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS staged_jobs (
      id TEXT PRIMARY KEY,
      remote_job_id INTEGER,
      marketplace TEXT NOT NULL,
      seller_account TEXT DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'staged',
      parameters TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS staged_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      vertical TEXT NOT NULL,
      fulfilment_type TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES staged_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS ix_staged_obs_job ON staged_observations(job_id);

    CREATE TABLE IF NOT EXISTS staged_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES staged_jobs(id) ON DELETE CASCADE
    );
  `);

  persist(dbInstance, currentDbPath);
  return dbInstance;
}

export function saveStagedJob(db, job) {
  const targetDb = db || dbInstance;
  if (!targetDb) throw new Error('Staging database is not initialized');

  targetDb.run(`
    INSERT INTO staged_jobs (id, remote_job_id, marketplace, seller_account, status, parameters, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (id) DO UPDATE SET
      remote_job_id = EXCLUDED.remote_job_id,
      status = EXCLUDED.status,
      parameters = EXCLUDED.parameters,
      updated_at = datetime('now');
  `, [
    String(job.id),
    job.remote_job_id || null,
    job.marketplace || 'flipkart',
    job.seller_account || 'default',
    job.status || 'staged',
    typeof job.parameters === 'object' ? JSON.stringify(job.parameters) : job.parameters || '{}'
  ]);

  persist(targetDb, currentDbPath);
}

export function saveStagedObservations(db, jobId, observations) {
  const targetDb = db || dbInstance;
  if (!targetDb) throw new Error('Staging database is not initialized');

  targetDb.run('BEGIN TRANSACTION;');
  let stmt;
  try {
    targetDb.run('DELETE FROM staged_observations WHERE job_id = ?;', [String(jobId)]);
    stmt = targetDb.prepare(`INSERT INTO staged_observations (job_id, vertical, fulfilment_type, payload) VALUES (?, ?, ?, ?);`);
    for (const item of observations) {
      stmt.run([
        String(jobId),
        item.vertical || item.category || 'unknown',
        item.fulfilment_type || null,
        JSON.stringify(item)
      ]);
    }
    targetDb.run('COMMIT;');
  } catch (err) {
    targetDb.run('ROLLBACK;');
    throw err;
  } finally {
    stmt?.free();
  }

  persist(targetDb, currentDbPath);
}

export function stageReview(db, jobId, owner, marketplace, cards) {
  if (!owner) throw new Error('Verified review owner is required.');
  saveStagedJob(db, { id: jobId, marketplace, status: 'staging', parameters: { owner } });
  saveStagedObservations(db, jobId, cards);
  markStagedJobStatus(db, jobId, 'review');
}

export function supersedeReviews(db, owner) {
  if (!owner) throw new Error('Verified review owner is required.');
  db.run("UPDATE staged_jobs SET status = 'superseded', updated_at = datetime('now') WHERE status = 'review' AND json_extract(parameters, '$.owner') = ?", [owner]);
  persist(db, currentDbPath);
}

export function recoverReview(db, owner) {
  const rows = db.exec("SELECT id, parameters FROM staged_jobs WHERE status = 'review' ORDER BY created_at DESC, rowid DESC");
  for (const [id, parameters] of rows[0]?.values || []) {
    if (JSON.parse(parameters || '{}').owner !== owner) continue;
    return { id, cards: getStagedObservations(db, id).map(({ _staged_id, _created_at, ...card }) => card) };
  }
  return null;
}

export function getStagedObservations(db, jobId) {
  const targetDb = db || dbInstance;
  if (!targetDb) throw new Error('Staging database is not initialized');

  const stmt = targetDb.prepare(`
    SELECT id, vertical, fulfilment_type, payload, created_at
    FROM staged_observations
    WHERE job_id = ?
    ORDER BY id ASC;
  `);

  stmt.bind([String(jobId)]);
  const results = [];
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        ...JSON.parse(row.payload),
        _staged_id: row.id,
        _created_at: row.created_at
      });
    }
  } finally {
    stmt.free();
  }

  return results;
}

export function markStagedJobStatus(db, jobId, status) {
  const targetDb = db || dbInstance;
  if (!targetDb) throw new Error('Staging database is not initialized');

  targetDb.run(`
    UPDATE staged_jobs
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?;
  `, [status, String(jobId)]);

  persist(targetDb, currentDbPath);
}

export function clearStagedJob(db, jobId) {
  const targetDb = db || dbInstance;
  if (!targetDb) throw new Error('Staging database is not initialized');

  targetDb.run('BEGIN TRANSACTION;');
  targetDb.run('DELETE FROM staged_observations WHERE job_id = ?;', [String(jobId)]);
  targetDb.run('DELETE FROM staged_jobs WHERE id = ?;', [String(jobId)]);
  targetDb.run('COMMIT;');

  persist(targetDb, currentDbPath);
}

export function closeStagingDb() {
  if (dbInstance) {
    try {
      persist(dbInstance, currentDbPath);
      dbInstance.close();
    } catch {}
    dbInstance = null;
    currentDbPath = null;
  }
}
