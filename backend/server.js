import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { mountApiRoutes } from './routes/index.js';
import { initDb }          from './db/initDb.js';
import {
  getDatabaseStatus,
  getPool,
  isDbConfigured,
  recoverDatabaseConnection,
  startDatabaseHealthMonitor,
  waitForDatabase,
} from './db/index.js';
import { syncFirebaseRoleClaims } from './services/firebaseRoleClaims.js';
import { publicApiError } from './utils/apiError.js';

dotenv.config({ override: true });

export const app = express();
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
app.use(express.json({ limit: '20mb' }));

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

app.get('/health', async (_, res) => {
  const configured = await isDbConfigured();
  let dbConnected = false;
  if (configured) {
    try {
      getPool();
      dbConnected = await Promise.race([
        recoverDatabaseConnection(),
        new Promise(resolve => setTimeout(() => resolve(false), 3_000)),
      ]);
    } catch {
      dbConnected = false;
    }
  }
  const database = getDatabaseStatus();
  const databaseEngine = process.env.DATABASE_ENGINE === 'postgresql' || process.env.POSTGRES_DATABASE_URL
    ? 'PostgreSQL'
    : 'CockroachDB';
  res.status(configured && dbConnected ? 200 : 503).json({
    status: configured && dbConnected ? 'ok' : 'degraded',
    dataSource: 'sql',
    dbConnected,
    database: { ...database, schemaReady: databaseSchemaReady, engine: databaseEngine.toLowerCase() },
    message: dbConnected
      ? `${databaseEngine} connected`
      : `${databaseEngine} is unavailable; automatic reconnection is active. No empty-data fallback is used.`,
  });
});

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

export function startServer(port = PORT) {
  // Start serving health/API traffic immediately, then keep retrying until the
  // database is connected and schema initialisation has completed.
  void initialiseDatabaseWhenReachable();
  // Bind 0.0.0.0 so Cloud Run / containers can receive traffic (not just localhost).
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Backend running at http://0.0.0.0:${port} [data source: sql]`);
  });
  server.timeout = 900000;
  return server;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) startServer();
