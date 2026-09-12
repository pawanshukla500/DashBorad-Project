import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mountApiRoutes } from './routes/index.js';
import { initDb }          from './db/initDb.js';
import {
  getDatabaseStatus,
  getPool,
  isDbConfigured,
  isDbOffline,
  recoverDatabaseConnection,
  startDatabaseHealthMonitor,
  waitForDatabase,
} from './db/index.js';
import { syncFirebaseRoleClaims } from './services/firebaseRoleClaims.js';
import { publicApiError } from './utils/apiError.js';

// ── Crash safety net ───────────────────────────────────────────────────────
// If an unhandled rejection or exception escapes all try/catch blocks the
// process is about to crash. Close the DB pool so PostgreSQL can reclaim the
// connections immediately instead of waiting for TCP keepalive to expire.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[server] Uncaught exception — closing DB pool before exit:', error);
  try {
    const pool = getPool();
    pool.end().catch(() => {});
  } catch { /* pool may not exist yet */ }
  process.exit(1);
});

dotenv.config({ override: true });

export const app = express();
app.disable('x-powered-by');

// Apply standard defensive HTTP headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const PORT = process.env.PORT || 3001;
let databaseSchemaReady = false;

function configuredCorsOrigins() {
  return new Set(
    String(process.env.CORS_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );
}

function isPrivateDevelopmentOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host === '127.0.0.1') return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const match = host.match(/^172\.(\d{1,3})\./);
    return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
  } catch {
    return false;
  }
}

const corsOrigins = configuredCorsOrigins();
const isProduction = process.env.NODE_ENV === 'production';

app.use(cors({
  origin(origin, callback) {
    // Health checks and server-to-server calls do not include an Origin.
    if (!origin) return callback(null, true);
    const normalized = origin.replace(/\/$/, '');
    if (corsOrigins.has(normalized)) return callback(null, true);
    // Keep the START.bat same-LAN workflow working without allowing arbitrary
    // internet origins during development. Production must name its UI origin.
    if (!isProduction && isPrivateDevelopmentOrigin(normalized)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86_400,
}));
app.use(express.json({ limit: '50mb' }));

async function healthCheckHandler(_, res) {
  const configured = await isDbConfigured();
  let dbConnected = false;
  if (configured) {
    try {
      getPool();
      dbConnected = await Promise.race([
        recoverDatabaseConnection(),
        new Promise(resolve => setTimeout(() => resolve(false), 6_000)),
      ]);
    } catch {
      dbConnected = false;
    }
  }
  const database = getDatabaseStatus();
  const databaseEngine = 'PostgreSQL';
  res.status(configured && dbConnected ? 200 : 503).json({
    status: configured && dbConnected ? 'ok' : 'degraded',
    dataSource: 'sql',
    dbConnected,
    database: { ...database, schemaReady: databaseSchemaReady, engine: databaseEngine.toLowerCase() },
    message: dbConnected
      ? `${databaseEngine} connected`
      : `${databaseEngine} is unavailable; automatic reconnection is active. No empty-data fallback is used.`,
  });
}

// Public health check endpoints for liveness probes, monitoring, and deployments
app.get('/health', healthCheckHandler);
app.get('/api/health', healthCheckHandler);

// Do not let a newly started server run dashboard reads while initDb is
// acquiring schema locks. Previously that race blocked report queries and
// exhausted the connection pool. Firebase authentication itself does not need
// PostgreSQL, but the browser no longer calls a database-backed session route.
app.use('/api', (_req, res, next) => {
  if (databaseSchemaReady) return next();
  return res.status(503).json({
    error: 'The data service is preparing its database connection. Please retry in a moment.',
    code: 'DATABASE_STARTING',
  });
});

mountApiRoutes(app);

const clientDist = process.env.CLIENT_DIST_PATH
  ? path.resolve(process.env.CLIENT_DIST_PATH)
  : path.resolve(process.cwd(), '../frontend/dist');

if (fs.existsSync(clientDist)) {
  console.log(`[server] Serving static frontend from ${clientDist}`);
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/health') return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Multer and Express's JSON parser can fail before a route handler gets the
// request. Keep those failures structured and safe for the React client; do
// not fall back to Express's HTML error page or expose an internal stack.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const response = publicApiError(error);
  console.error(`[api] ${req.method} ${req.originalUrl} failed:`, error?.message || error);
  return res.status(response.status).json(response.body);
});

async function initialiseDatabaseWhenReachable() {
  if (!(await isDbConfigured())) {
    console.warn('[db] DATABASE_URL/PG settings are missing. Database recovery cannot start.');
    return;
  }
  try {
    await waitForDatabase();
    startDatabaseHealthMonitor();
    await initDb();
    databaseSchemaReady = true;
    console.log('[db] Database schema is ready.');
    // Backfill legacy SQL directory roles into Firebase once at startup. All
    // request authentication still verifies Firebase only; this is solely a
    // migration of existing access metadata.
    void syncFirebaseRoleClaims(getPool())
      .then(result => console.log(`[firebase roles] checked ${result.checked}; updated ${result.updated}; unchanged ${result.unchanged}; skipped ${result.skipped}.`))
      .catch(error => console.warn('[firebase roles] Startup sync failed:', error.message));
  } catch (error) {
    // waitForDatabase normally does not return until success. Keep this guard
    // so a schema issue never brings down the HTTP process.
    console.error('[db] Database initialisation failed:', error.message);
    setTimeout(() => void initialiseDatabaseWhenReachable(), 5_000).unref?.();
  }
}

let activeServer = null;
let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 5_000;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] Received ${signal} — shutting down gracefully…`);

  // Force-exit safety net: if drain + pool.end() take longer than
  // SHUTDOWN_TIMEOUT_MS (e.g. a stuck transaction), exit anyway so
  // nodemon can restart without waiting forever.
  const forceExitTimer = setTimeout(() => {
    console.warn(`[server] Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref?.();

  // Block new API requests immediately so the load balancer / browser
  // retries hit the new server instead of draining ones.
  databaseSchemaReady = false;

  // 1. Stop accepting new HTTP requests.
  if (activeServer) {
    await new Promise(resolve => activeServer.close(resolve));
    console.log('[server] HTTP server closed.');
  }

  // 2. Drain the database pool so every in-flight query finishes, then
  //    close every idle and active connection. Without this, nodemon
  //    restarts leave orphaned connections on the PostgreSQL server.
  try {
    const pool = getPool();
    const status = getDatabaseStatus();
    if (status.pool) {
      console.log(`[server] Pool state before close: total=${status.pool.total} idle=${status.pool.idle} waiting=${status.pool.waiting}`);
    }
    await pool.end();
    console.log('[server] Database pool closed.');
  } catch (error) {
    console.warn('[server] Database pool close failed:', error?.message || error);
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

export function startServer(port = PORT) {
  // Start serving health/API traffic immediately, then keep retrying until the
  // database is connected and schema initialisation has completed.
  void initialiseDatabaseWhenReachable();
  // Bind 0.0.0.0 so containers and LAN/dev clients can receive traffic.
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Backend running at http://0.0.0.0:${port} [data source: sql]`);
  });
  server.timeout = 900000;
  activeServer = server;
  return server;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) startServer();
