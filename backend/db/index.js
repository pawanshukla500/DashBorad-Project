import pg from 'pg';

const { Pool } = pg;

// The application must never pretend that business data is empty when the
// database is unavailable. Instead, reads retry briefly and the pool keeps
// recovering in the background until the configured database is reachable again.
const CONNECT_TIMEOUT_MS = 12_000;
const RECOVERY_INTERVAL_MS = 5_000;
const READ_RETRY_DELAYS_MS = [0, 400, 1_200];
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;
const MIN_HEALTH_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_READ_STATEMENT_TIMEOUT_MS = 90_000;

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

export class DatabaseUnavailableError extends Error {
  constructor(cause) {
    super('Database connection is temporarily unavailable. The service is retrying automatically; please try again shortly.');
    this.name = 'DatabaseUnavailableError';
    this.code = 'DB_UNAVAILABLE';
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

function configuredSsl(targetUrl, connectionString) {
  const sslSetting = targetUrl ? process.env.POSTGRES_PG_SSL : process.env.PG_SSL;
  const rejectUnauthorizedSetting = targetUrl
    ? process.env.POSTGRES_PG_SSL_REJECT_UNAUTHORIZED
    : process.env.PG_SSL_REJECT_UNAUTHORIZED;
  const caSetting = targetUrl ? process.env.POSTGRES_PG_SSL_CA : process.env.PG_SSL_CA;
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
  const targetUrl = cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL);
  const connectionString = targetUrl || cleanDatabaseUrl(process.env.DATABASE_URL);
  const ssl = configuredSsl(targetUrl, connectionString);
  const remote = Boolean(databaseHost(connectionString)) && !isLoopbackHost(databaseHost(connectionString));
  const productionRequiresTls = process.env.NODE_ENV === 'production' && remote;
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
  const targetUrl = cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL);
  const connectionString = targetUrl || cleanDatabaseUrl(process.env.DATABASE_URL);
  const ssl = configuredSsl(targetUrl, connectionString);
  const host = databaseHost(connectionString);
  if (process.env.NODE_ENV === 'production' && !isLoopbackHost(host) && !ssl) {
    throw new DatabaseUnavailableError(new Error(
      'Production PostgreSQL connections to non-local hosts require TLS. Set PG_SSL=true (or POSTGRES_PG_SSL=true) and configure a trusted certificate.',
    ));
  }
  const poolOptions = {
    // Dashboard pages issue several independent aggregate reads on first
    // load. Keep the pool bounded, but leave enough headroom that a report
    // query cannot make Firebase-authenticated requests wait in the pool.
    max: positiveInteger(process.env.PG_POOL_MAX, 20, { min: 1, max: 100 }),
    min: positiveInteger(process.env.PG_POOL_MIN, 0, { min: 0, max: 100 }),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Interactive API reads must fail clearly rather than pinning a pool
    // connection forever. Import/rebuild transactions explicitly clear this
    // session limit below, because their atomic work is not a browser report.
    statement_timeout: readStatementTimeoutMs(),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    maxLifetimeSeconds: positiveInteger(process.env.PG_POOL_MAX_LIFETIME_SECONDS, 600, { min: 30, max: 86_400 }),
    application_name: process.env.PG_APPLICATION_NAME || 'reconcentral-api',
  };

  // pg requires min <= max. A bad environment value should never prevent the
  // service from starting or accidentally create an unbounded pool.
  poolOptions.min = Math.min(poolOptions.min, poolOptions.max);

  if (connectionString.startsWith('postgres')) return { connectionString, ssl, ...poolOptions };

  return {
    host,
    port: Number.parseInt(process.env.PG_PORT || process.env.PGPORT || '5432', 10),
    database: process.env.PG_DATABASE || process.env.PGDATABASE,
    user: process.env.PG_USER || process.env.PGUSER,
    password: process.env.PG_PASSWORD || process.env.PGPASSWORD,
    ssl,
    ...poolOptions,
  };
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

// Retrying an INSERT after a network break can duplicate a completed write.
// Only idempotent read statements are retried in the same request. Writes fail
// clearly and their normal upload/API flow can safely decide whether to retry.
function isSafeReadStatement(text) {
  const start = String(text || '').replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*/, '').toLowerCase();
  return /^(select|show|explain|values)\b/.test(start);
}

function markDatabaseOnline() {
  const wasOffline = dbOffline;
  dbOffline = false;
  lastDbError = null;
  lastDbSuccessAt = new Date().toISOString();
  if (wasOffline) lastDbRecoveryAt = lastDbSuccessAt;
  consecutiveDbFailures = 0;
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
  scheduleRecovery();
}

async function pingDatabase(timeoutMs = 2_500) {
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
    markDatabaseOffline(error);
    return false;
  }
}

function scheduleRecovery() {
  if (recoveryTimer || recoveryInFlight || !_realPool) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void recoverDatabaseConnection();
  }, RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();
}

export async function recoverDatabaseConnection() {
  if (!_realPool) return false;
  if (recoveryInFlight) return recoveryInFlight;
  recoveryInFlight = pingDatabase(CONNECT_TIMEOUT_MS).finally(() => {
    recoveryInFlight = null;
  });
  const restored = await recoveryInFlight;
  if (!restored) scheduleRecovery();
  return restored;
}

export function startDatabaseHealthMonitor() {
  if (healthCheckTimer || !_realPool) return;
  const intervalMs = healthCheckIntervalMs();
  healthCheckTimer = setInterval(() => {
    lastHealthCheckAt = new Date().toISOString();
    void recoverDatabaseConnection();
  }, intervalMs);
  // The monitor must not hold a CLI/test process open after its HTTP server
  // has stopped.
  healthCheckTimer.unref?.();
  console.log(`[db] Health monitor enabled (every ${Math.round(intervalMs / 1000)}s).`);
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
    const safeUrl = config.connectionString.replace(/:([^:@/]+)@/, ':***@');
    console.log('[db] Using configured database →', safeUrl);
  } else {
    console.log(`[db] Using discrete configuration → ${config.user}@${config.host}:${config.port}/${config.database}`);
  }

  const realPool = new Pool(config);
  realPool.on('error', error => {
    // Idle client errors are a normal symptom of a server/network restart.
    // Do not replace results with blanks; schedule recovery instead.
    console.warn('[db] Pool connection error:', error.message);
    if (isRetryableConnectionError(error)) markDatabaseOffline(error);
  });
  return realPool;
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
          markDatabaseOffline(error);
          if (!retryableRead || attempt === READ_RETRY_DELAYS_MS.length - 1) break;
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
          if (!isPoolAcquireTimeout(error)) markDatabaseOffline(error);
          throw new DatabaseUnavailableError(error);
        }
        throw error;
      }
    },

    async end() {
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = null;
      stopDatabaseHealthMonitor();
      const endingPool = _realPool;
      _pool = null;
      _realPool = null;
      dbOffline = false;
      return endingPool?.end();
    },
  };
  return _pool;
}

export async function isDbConfigured() {
  const url = cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL) || cleanDatabaseUrl(process.env.DATABASE_URL);
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
    configured: Boolean(_realPool) || Boolean(cleanDatabaseUrl(process.env.POSTGRES_DATABASE_URL)) || Boolean(cleanDatabaseUrl(process.env.DATABASE_URL)) || Boolean(process.env.PG_HOST || process.env.PGHOST),
    connected: Boolean(_realPool) && !dbOffline,
    lastSuccessAt: lastDbSuccessAt,
    lastError: lastDbError,
    lastFailureAt: lastDbFailureAt,
    lastRecoveryAt: lastDbRecoveryAt,
    consecutiveFailures: consecutiveDbFailures,
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
      total: _realPool.totalCount,
      idle: _realPool.idleCount,
      waiting: _realPool.waitingCount,
    } : null,
  };
}

// Backward-compatible placeholder for modules that import { sql }.
export const sql = {};
