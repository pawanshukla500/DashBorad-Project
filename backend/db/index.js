import pg from 'pg';

const { Pool } = pg;

// Parse PostgreSQL DATE (OID 1082) directly as string 'YYYY-MM-DD'
// rather than instantiating JavaScript Date objects which shift timezones and serialize with ISO timestamps.
if (pg.types?.setTypeParser) {
  pg.types.setTypeParser(1082, (val) => val);
}

// The application must never pretend that business data is empty when the
// database is unavailable. Instead, reads retry briefly and the pool keeps
// recovering in the background until the configured database is reachable again.
const CONNECT_TIMEOUT_MS = positiveInteger(process.env.PG_CONNECT_TIMEOUT_MS, 30_000, { min: 5_000, max: 120_000 });
const RECOVERY_INTERVAL_MS = 5_000;
const MAX_RECOVERY_INTERVAL_MS = 60_000;
const READ_RETRY_DELAYS_MS = [0, 500, 1_500, 4_000];
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 20_000;
const MIN_HEALTH_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_READ_STATEMENT_TIMEOUT_MS = 45_000;
const DEFAULT_POOL_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_POOL_MAX_LIFETIME_SECONDS = 15 * 60;

let _pool = null;
let _realPool = null;
let dbOffline = false;
let lastDbError = null;
let lastDbSuccessAt = null;
let recoveryTimer = null;
let recoveryInFlight = null;
let healthCheckTimer = null;
let lastHealthCheckAt = null;
let lastDbFailureAt = null;
let lastDbRecoveryAt = null;
let consecutiveDbFailures = 0;
let poolRecreateRequested = false;
let lastPoolRecreatedAt = null;
let currentRecoveryDelay = RECOVERY_INTERVAL_MS;

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function healthCheckIntervalMs() {
  return positiveInteger(process.env.PG_HEALTHCHECK_INTERVAL_MS, DEFAULT_HEALTH_CHECK_INTERVAL_MS, {
    min: MIN_HEALTH_CHECK_INTERVAL_MS,
    max: 10 * 60_000,
  });
}

function readStatementTimeoutMs() {
  return positiveInteger(process.env.PG_READ_STATEMENT_TIMEOUT_MS, DEFAULT_READ_STATEMENT_TIMEOUT_MS, {
    min: 5_000,
    max: 5 * 60_000,
  });
}

function poolIdleTimeoutMs() {
  return positiveInteger(process.env.PG_POOL_IDLE_TIMEOUT_MS, DEFAULT_POOL_IDLE_TIMEOUT_MS, {
    min: 10_000,
    max: 10 * 60_000,
  });
}

function poolMaxLifetimeSeconds() {
  return positiveInteger(process.env.PG_POOL_MAX_LIFETIME_SECONDS, DEFAULT_POOL_MAX_LIFETIME_SECONDS, {
    min: 60,
    max: 2 * 60 * 60,
  });
}

export class DatabaseUnavailableError extends Error {
  constructor(cause) {
    super('Database connection is temporarily unavailable. The service is retrying automatically; please try again shortly.');
    this.name = 'DatabaseUnavailableError';
    this.code = 'DB_UNAVAILABLE';
    this.status = 503;
    this.cause = cause;
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function cleanDatabaseUrl(raw) {
  if (!raw) return '';
  // Strip accidental dashboard separators pasted onto a .env line.
  return raw.split(/[─–—]/u)[0].trim();
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

function databaseHost(connectionString) {
  if (connectionString) {
    try { return new URL(connectionString).hostname; } catch { return ''; }
  }
  return process.env.PG_HOST || process.env.PGHOST || '';
}

function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1';
}

function activeDatabaseUrl() {
  const databaseUrl = cleanDatabaseUrl(process.env.DATABASE_URL);
  return { connectionString: databaseUrl, source: databaseUrl ? 'DATABASE_URL' : '' };
}

function configuredSsl(connectionString) {
  const sslSetting = process.env.PG_SSL;
  const rejectUnauthorizedSetting = process.env.PG_SSL_REJECT_UNAUTHORIZED;
  const caSetting = process.env.PG_SSL_CA;
  const explicitSsl = optionalBoolean(sslSetting);
  const enabled = explicitSsl == null ? urlRequiresSsl(connectionString) : explicitSsl;
  if (!enabled) return false;

  // Certificate validation is mandatory by default. A managed provider that
  // cannot supply a CA must opt out explicitly, making that trade-off visible
  // in deployment configuration rather than silently weakening every TLS link.
  const rejectUnauthorized = optionalBoolean(rejectUnauthorizedSetting) ?? true;
  const ca = String(caSetting || '').trim();
  return {
    rejectUnauthorized,
    ...(ca ? { ca: ca.replace(/\\n/g, '\n') } : {}),
  };
}

function databaseTransportStatus() {
  const { connectionString } = activeDatabaseUrl();
  const ssl = configuredSsl(connectionString);
  const host = databaseHost(connectionString);
  const productionRequiresTls = process.env.NODE_ENV === 'production' && !isPrivateDatabaseHost(host);
  return {
    tlsEnabled: Boolean(ssl),
    certificateVerified: ssl ? ssl.rejectUnauthorized !== false : null,
    productionReady: !productionRequiresTls || Boolean(ssl),
  };
}

// Exported for operational verification. It is pure and does not create a
// database connection, so deployment checks can validate the exact TLS policy
// that the API will use.
export function resolvePgConfig() {
  const { connectionString } = activeDatabaseUrl();
  const ssl = configuredSsl(connectionString);
  const host = databaseHost(connectionString);
  const discreteConfig = {
    host,
    port: Number.parseInt(process.env.PG_PORT || process.env.PGPORT || '5432', 10),
    database: process.env.PG_DATABASE || process.env.PGDATABASE,
    user: process.env.PG_USER || process.env.PGUSER,
    password: process.env.PG_PASSWORD || process.env.PGPASSWORD,
  };
  if (!connectionString && !(discreteConfig.host && discreteConfig.database && discreteConfig.user && discreteConfig.password)) {
    throw new DatabaseUnavailableError(new Error('DATABASE_URL or PG connection settings are missing'));
  }
  if (process.env.NODE_ENV === 'production' && !isPrivateDatabaseHost(host) && !ssl) {
    throw new DatabaseUnavailableError(new Error(
      'Production PostgreSQL connections over public networks require TLS. For Hostinger Docker PostgreSQL, connect over a private Docker/local network with PG_SSL=false, or enable TLS for public database hosts.',
    ));
  }
  const poolOptions = {
    // Dashboard pages issue several independent aggregate reads on first
    // load. Keep the pool bounded, but leave enough headroom that a report
    // query cannot make Firebase-authenticated requests wait in the pool.
    max: positiveInteger(process.env.PG_POOL_MAX, 20, { min: 1, max: 100 }),
    min: positiveInteger(process.env.PG_POOL_MIN, 2, { min: 0, max: 100 }),
    idleTimeoutMillis: poolIdleTimeoutMs(),
    maxLifetimeSeconds: poolMaxLifetimeSeconds(),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Interactive API reads must fail clearly rather than pinning a pool
    // connection forever. Import/rebuild transactions explicitly clear this
    // session limit below, because their atomic work is not a browser report.
    statement_timeout: readStatementTimeoutMs(),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: process.env.PG_APPLICATION_NAME || 'reconcentral-api',
  };

  // pg requires min <= max. A bad environment value should never prevent the
  // service from starting or accidentally create an unbounded pool.
  poolOptions.min = Math.min(poolOptions.min, poolOptions.max);

  if (connectionString.startsWith('postgres')) return { connectionString, ssl, ...poolOptions };

  return {
    ...discreteConfig,
    ssl,
    ...poolOptions,
  };
}

function isPrivateIpv4(host) {
  return /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host);
}

function isDockerServiceHost(host) {
  return /^[a-z0-9][a-z0-9-]*$/.test(host);
}

function isPrivateDatabaseHost(host) {
  const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return false;
  if (isLoopbackHost(normalized)) return true;
  if (isPrivateIpv4(normalized)) return true;
  if (normalized === 'host.docker.internal' || normalized.endsWith('.docker.internal')) return true;
  return isDockerServiceHost(normalized);
}

function isRetryableConnectionError(error) {
  const code = String(error?.code || '');
  if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ENOTFOUND'].includes(code)) return true;
  if (/^08/.test(code) || ['57P01', '57P02', '57P03'].includes(code)) return true;
  return /connection terminated|connection.*closed|connection.*timeout|connect.*timeout|timeout exceeded when trying to connect|socket.*hang up|network.*error|server closed the connection/i.test(String(error?.message || ''));
}

function isPoolAcquireTimeout(error) {
  return /timeout exceeded when trying to connect/i.test(String(error?.message || ''));
}

function isConnectionBreakError(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '').toLowerCase();
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED' ||
    /connection terminated|socket.*hang up|server closed the connection|connection.*closed/i.test(msg)
  );
}

function queryTextFrom(query) {
  if (typeof query === 'string') return query;
  if (query && typeof query === 'object' && typeof query.text === 'string') return query.text;
  return '';
}

// Retrying an INSERT after a network break can duplicate a completed write.
// Only idempotent read statements are retried in the same request. Writes fail
// clearly and their normal upload/API flow can safely decide whether to retry.
function isSafeReadStatement(text) {
  const start = queryTextFrom(text).replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*/, '').toLowerCase();
  return /^(select|show|explain|values)\b/.test(start);
}

function markDatabaseOnline() {
  const wasOffline = dbOffline;
  dbOffline = false;
  lastDbError = null;
  lastDbSuccessAt = new Date().toISOString();
  if (wasOffline) lastDbRecoveryAt = lastDbSuccessAt;
  consecutiveDbFailures = 0;
  currentRecoveryDelay = RECOVERY_INTERVAL_MS; // reset backoff
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  if (wasOffline) console.log('[db] Database connection restored.');
}

function markDatabaseOffline(error) {
  const now = new Date().toISOString();
  dbOffline = true;
  lastDbError = String(error?.message || error || 'Database connection failed').slice(0, 500);
  lastDbFailureAt = now;
  consecutiveDbFailures += 1;
  if (isRetryableConnectionError(error) && !isPoolAcquireTimeout(error)) poolRecreateRequested = true;
  scheduleRecovery();
}

function markPoolSuspect(error) {
  const now = new Date().toISOString();
  lastDbError = String(error?.message || error || 'Database connection failed').slice(0, 500);
  lastDbFailureAt = now;
  poolRecreateRequested = true;
  scheduleRecovery();
}

async function pingDatabase(timeoutMs = 5_000) {
  getPool();
  try {
    await _realPool.query({ text: 'SELECT 1', query_timeout: timeoutMs });
    markDatabaseOnline();
    return true;
  } catch (error) {
    // pg-pool uses this message when all application connections are busy.
    // It is not proof that PostgreSQL is down, so do not falsely mark the
    // database offline or make healthy API responses return a 503.
    if (isPoolAcquireTimeout(error)) return !dbOffline;
    if (isRetryableConnectionError(error) && !isPoolAcquireTimeout(error)) poolRecreateRequested = true;
    markDatabaseOffline(error);
    return false;
  }
}

function scheduleRecovery() {
  if (recoveryTimer || recoveryInFlight || !_realPool) return;
  // Exponential backoff: start at 5s, double each failure, cap at 60s.
  // This prevents aggressive pool recreation churn during prolonged outages
  // while still recovering quickly from short network blips.
  const delay = currentRecoveryDelay;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void recoverDatabaseConnection();
  }, delay);
  recoveryTimer.unref?.();
  // Increase backoff for the next cycle (capped at MAX_RECOVERY_INTERVAL_MS).
  currentRecoveryDelay = Math.min(currentRecoveryDelay * 2, MAX_RECOVERY_INTERVAL_MS);
}

export async function recoverDatabaseConnection() {
  if (!_realPool) return false;
  if (recoveryInFlight) return recoveryInFlight;
  recoveryInFlight = (async () => {
    // If the pool emitted idle socket errors or consecutive checks failed,
    // build a fresh pool before the next public request fans out dashboard
    // reads through possibly stale clients.
    if (poolRecreateRequested || consecutiveDbFailures >= 2) {
      console.log('[db] Re-establishing PostgreSQL connection pool after transport failure...');
      const oldPool = _realPool;
      try {
        const replacementPool = createRealPool();
        _realPool = replacementPool;
        poolRecreateRequested = false;
        lastPoolRecreatedAt = new Date().toISOString();
        if (oldPool) {
          void oldPool.end().catch(() => {});
        }
      } catch (err) {
        poolRecreateRequested = true;
        console.warn('[db] Pool recreation error:', err.message);
      }
    }

    const { connectionString } = activeDatabaseUrl();
    const host = databaseHost(connectionString);
    if (isLoopbackHost(host)) {
      try {
        const { ensureTunnel } = await import('../../scripts/db-tunnel.js');
        await ensureTunnel().catch(() => {});
      } catch {
        // scripts/db-tunnel.js may not be present in standalone Docker containers
      }
    }
    return pingDatabase(CONNECT_TIMEOUT_MS);
  })().finally(() => {
    recoveryInFlight = null;
  });
  const restored = await recoveryInFlight;
  if (!restored) scheduleRecovery();
  return restored;
}

async function keepPoolWarmAndHealthy() {
  if (!_realPool) return;
  try {
    // Active heartbeat: keeps remote NAT state tables alive and purges stale sockets
    await _realPool.query({ text: 'SELECT 1', query_timeout: 5_000 });
    markDatabaseOnline();
  } catch (error) {
    if (isPoolAcquireTimeout(error)) return;
    console.warn('[db] Pool keepalive check failed:', error?.message || error);
    if (isRetryableConnectionError(error)) poolRecreateRequested = true;
    markDatabaseOffline(error);
    void recoverDatabaseConnection();
  }
}

export function startDatabaseHealthMonitor() {
  if (healthCheckTimer || !_realPool) return;
  const intervalMs = healthCheckIntervalMs();
  healthCheckTimer = setInterval(() => {
    lastHealthCheckAt = new Date().toISOString();
    void keepPoolWarmAndHealthy();
  }, intervalMs);
  // The monitor must not hold a CLI/test process open after its HTTP server
  // has stopped.
  healthCheckTimer.unref?.();
  console.log(`[db] Health monitor & NAT keepalive enabled (every ${Math.round(intervalMs / 1000)}s).`);
}

export function stopDatabaseHealthMonitor() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = null;
}

export async function waitForDatabase({ retryIntervalMs = RECOVERY_INTERVAL_MS } = {}) {
  if (!(await isDbConfigured())) return false;
  getPool();
  while (!(await recoverDatabaseConnection())) {
    console.warn(`[db] Database unavailable; retrying in ${Math.ceil(retryIntervalMs / 1000)} seconds.`);
    await delay(retryIntervalMs);
  }
  return true;
}

function createRealPool() {
  const config = resolvePgConfig();
  if (!config.connectionString && !(config.host && config.database && config.user && config.password)) {
    throw new DatabaseUnavailableError(new Error('DATABASE_URL or PG connection settings are missing'));
  }
  if (config.connectionString) {
    console.log('[db] Using configured database ->', describeConnection(config.connectionString));
  } else {
    console.log(`[db] Using discrete configuration -> ${describeHost(config.host)}:${config.port}/${config.database}`);
  }

  const realPool = new Pool(config);

  // Tune TCP keepalive on every new client connection so idle sockets send
  // keepalive probes well within typical NAT/firewall timeout windows
  // (often 60-300s). Without this, OS defaults (Linux: 2h) let sockets die
  // silently behind Hostinger's NAT, causing frequent "connection terminated"
  // errors that trigger pool recreation storms.
  realPool.on('connect', (client) => {
    const stream = client?.connection?.stream;
    if (stream && typeof stream.setKeepAlive === 'function') {
      stream.setKeepAlive(true, 10_000);
      // On Linux, also tighten TCP_KEEPIDLE (seconds before first probe),
      // TCP_KEEPINTVL (seconds between probes), and TCP_KEEPCNT (probes
      // before giving up) so dead connections are detected in ~30s.
      if (typeof stream.setKeepAliveInitialDelay === 'function') {
        stream.setKeepAliveInitialDelay(10_000);
      }
      // ipc.net.Socket exposes setKeepAliveTimeval on Node 19+ / Linux.
      // Fall back silently when not available (e.g., Windows dev machines).
      const sock = stream;
      if (typeof sock.setKeepAliveTimeval === 'function') {
        sock.setKeepAliveTimeval(10); // TCP_KEEPIDLE = 10s
      }
    }
  });

  realPool.on('error', error => {
    // Idle client errors are a normal symptom of container restarts, NAT state
    // expiry, or server socket drops. pg-pool discards the failed client, then
    // we proactively rebuild the pool in the background so the next dashboard
    // fan-out does not inherit a cluster of stale sockets.
    console.warn('[db] Idle pool client disconnected and discarded by pool:', error.message);
    if (!dbOffline && isRetryableConnectionError(error)) {
      markPoolSuspect(error);
      void recoverDatabaseConnection();
    }
  });
  return realPool;
}

function describeHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (!normalized) return '<unset-host>';
  if (isLoopbackHost(normalized)) return 'local';
  if (isPrivateIpv4(normalized)) return 'private-network';
  if (isDockerServiceHost(normalized) || normalized.endsWith('.docker.internal')) return normalized;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return 'public-ip';
  return 'remote-host';
}

function describeConnection(connectionString) {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '') || '<database>';
    const port = url.port || '5432';
    return `${describeHost(url.hostname)}:${port}/${database}`;
  } catch {
    return '<unparseable-database-url>';
  }
}

function instrumentClient(client) {
  const query = client.query.bind(client);
  // Transactional callers use client.query directly. Mark a broken client as
  // offline as well, so the background recovery path is not limited to pool
  // queries. The write is deliberately not replayed here.
  client.query = async (...args) => {
    try {
      const result = await query(...args);
      markDatabaseOnline();
      return result;
    } catch (error) {
      if (isRetryableConnectionError(error)) {
        if (!isPoolAcquireTimeout(error)) markDatabaseOffline(error);
        throw new DatabaseUnavailableError(error);
      }
      throw error;
    }
  };
  return client;
}

export function getPool() {
  if (_pool) return _pool;
  _realPool = createRealPool();

  _pool = {
    // Existing health and diagnostics callers use this property. Keep it as a
    // getter so the public wrapper remains the only application query entry.
    get _realPool() { return _realPool; },
    on(event, handler) { return _realPool.on(event, handler); },

    async query(text, params = []) {
      const retryableRead = isSafeReadStatement(text);
      let lastError = null;

      for (let attempt = 0; attempt < READ_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) await delay(READ_RETRY_DELAYS_MS[attempt]);
        try {
          const result = await _realPool.query(text, params);
          markDatabaseOnline();
          return result;
        } catch (error) {
          lastError = error;
          if (!isRetryableConnectionError(error)) throw error;
          // A saturated local pool does not mean PostgreSQL is down. Retrying
          // reads may still help after another dashboard request completes,
          // but do not flip the whole service into its offline state.
          if (isPoolAcquireTimeout(error)) {
            if (!retryableRead || attempt === READ_RETRY_DELAYS_MS.length - 1) break;
            continue;
          }

          if (!isPoolAcquireTimeout(error)) poolRecreateRequested = true;

          // A SELECT can be safely replayed after a stale socket; an INSERT,
          // UPDATE, DELETE, or DDL may already have reached PostgreSQL before
          // the TCP break was observed, so fail clearly instead of risking a
          // duplicate write or partial upload state.
          if (retryableRead && attempt < READ_RETRY_DELAYS_MS.length - 1) {
            markPoolSuspect(error);
            continue;
          }
          markDatabaseOffline(error);
          break;
        }
      }
      throw new DatabaseUnavailableError(lastError);
    },

    async connect() {
      try {
        const client = instrumentClient(await _realPool.connect());
        // Ensure long tasks don't get killed by Postgres session limits
        await client.query('SET statement_timeout = 0; SET idle_in_transaction_session_timeout = 0;').catch(() => {});
        markDatabaseOnline();
        return client;
      } catch (error) {
        if (isRetryableConnectionError(error)) {
          if (isConnectionBreakError(error)) poolRecreateRequested = true;
          if (!isPoolAcquireTimeout(error)) markDatabaseOffline(error);
          throw new DatabaseUnavailableError(error);
        }
        throw error;
      }
    },

    async end() {
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = null;
      recoveryInFlight = null;
      stopDatabaseHealthMonitor();
      const endingPool = _realPool;
      _pool = null;
      _realPool = null;
      dbOffline = false;
      lastDbError = null;
      lastDbSuccessAt = null;
      lastDbFailureAt = null;
      lastDbRecoveryAt = null;
      consecutiveDbFailures = 0;
      poolRecreateRequested = false;
      lastPoolRecreatedAt = null;
      return endingPool?.end();
    },
  };
  return _pool;
}

export async function isDbConfigured() {
  const url = cleanDatabaseUrl(process.env.DATABASE_URL);
  if (url.startsWith('postgres')) return true;
  const host = process.env.PG_HOST || process.env.PGHOST;
  const database = process.env.PG_DATABASE || process.env.PGDATABASE;
  const user = process.env.PG_USER || process.env.PGUSER;
  const password = process.env.PG_PASSWORD || process.env.PGPASSWORD;
  return Boolean(host && database && user && password);
}

export function isDbOffline() {
  return dbOffline;
}

export function getDatabaseStatus() {
  return {
    configured: Boolean(_realPool) || Boolean(cleanDatabaseUrl(process.env.DATABASE_URL)) || Boolean(process.env.PG_HOST || process.env.PGHOST),
    connected: Boolean(_realPool) && !dbOffline,
    lastSuccessAt: lastDbSuccessAt,
    lastError: lastDbError,
    lastFailureAt: lastDbFailureAt,
    lastRecoveryAt: lastDbRecoveryAt,
    consecutiveFailures: consecutiveDbFailures,
    poolRecreatePending: poolRecreateRequested,
    lastPoolRecreatedAt,
    healthCheck: {
      enabled: Boolean(healthCheckTimer),
      intervalMs: healthCheckIntervalMs(),
      lastCheckedAt: lastHealthCheckAt,
    },
    readStatementTimeoutMs: readStatementTimeoutMs(),
    recoveryIntervalMs: RECOVERY_INTERVAL_MS,
    transport: databaseTransportStatus(),
    pool: _realPool ? {
      max: _realPool.options.max,
      min: _realPool.options.min,
      idleTimeoutMillis: _realPool.options.idleTimeoutMillis,
      maxLifetimeSeconds: _realPool.options.maxLifetimeSeconds,
      total: _realPool.totalCount,
      idle: _realPool.idleCount,
      waiting: _realPool.waitingCount,
    } : null,
  };
}

// Backward-compatible placeholder for modules that import { sql }.
export const sql = {};
