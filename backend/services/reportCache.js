// Shared, process-local cache for read-only report endpoints.
//
// Report responses are pure functions of the query string (no per-user data),
// and each one costs 0.5-6 s of aggregate SQL over the full order history. The
// data only changes when something writes to PostgreSQL, so a cached body stays
// valid until then. Two mechanisms detect that:
//
//  1. invalidateReportCache() — called synchronously after every successful
//     API mutation (routes/index.js) and at the end of background import jobs.
//  2. A data version read from PostgreSQL's own per-table write counters
//     (pg_stat_user_tables). It changes within ~1 s of ANY committed write,
//     including ones this process never sees: background jobs, another API
//     instance or a developer backend pointed at the same database, scripts.
//     A cache hit is only served when the version still matches.
//
// A request carrying a new non-empty `_refresh` token (the UI Refresh button)
// recomputes and replaces the entry once per token.
import { getPool } from '../db/index.js';

const DEFAULT_TTL_MS = 10 * 60_000;
// Bodies are up to a few hundred KB; keep the worst case well inside the 1 GB
// container limit.
const MAX_ENTRIES = 150;
const MAX_TRACKED_KEYS = 5_000;
// Several report requests arrive together when a page opens; share one
// version lookup between them.
const VERSION_MEMO_MS = 1_500;
// Writes to these tables never change a report result.
const VERSION_IGNORED_TABLES = [
  'audit_events',
  'rate_card_notification_log',
  'schema_version',
  'upload_skipped_rows',
];

const entries = new Map();
const inFlight = new Map();
const keyGenerations = new Map();
// Browsers keep sending the last Refresh token with every later request (see
// frontend/src/api/client.js). Recompute once per token per report; repeats of
// the same token are served normally instead of bypassing the cache forever.
const honouredRefreshTokens = new Map();
let generation = 0;
let versionMemo = null;
let versionRequest = null;

function ttlMs() {
  const parsed = Number.parseInt(process.env.REPORT_CACHE_TTL_MS, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

export function reportCacheKey(req) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (key !== '_refresh' && value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  return `${req.baseUrl || ''}${req.path}?${params.toString()}`;
}

/** Drop every cached report and prevent in-flight reads from repopulating it. */
export function invalidateReportCache() {
  generation += 1;
  entries.clear();
  inFlight.clear();
  keyGenerations.clear();
  versionMemo = null;
}

/**
 * Current write-counter version of the business tables, or null when it cannot
 * be read (for example while the database is reconnecting).
 */
export async function currentDataVersion() {
  if (versionMemo && Date.now() - versionMemo.at < VERSION_MEMO_MS) return versionMemo.value;
  if (versionRequest) return versionRequest;
  const startedGeneration = generation;
  versionRequest = getPool().query(`
      SELECT COALESCE(SUM(n_tup_ins + n_tup_upd + n_tup_del), 0)::text AS version
      FROM pg_stat_user_tables
      WHERE schemaname = current_schema()
        AND relname <> ALL($1::text[])
    `, [VERSION_IGNORED_TABLES])
    .then(({ rows }) => {
      const value = rows[0]?.version ?? null;
      // An invalidation during the lookup means the answer may predate a
      // write this process just made; don't memoize it.
      if (generation === startedGeneration) versionMemo = { value, at: Date.now() };
      return value;
    })
    .catch(() => null)
    .finally(() => { versionRequest = null; });
  return versionRequest;
}

function remember(key, entry) {
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

/**
 * Express middleware. `shouldCache(req)` decides which GET requests are
 * cacheable; everything else passes straight through.
 */
export function reportCacheMiddleware(shouldCache) {
  return async function reportCache(req, res, next) {
    if (req.method !== 'GET' || !shouldCache(req)) return next();

    const key = reportCacheKey(req);
    const refreshToken = req.query?._refresh ? String(req.query._refresh) : '';
    const forceRefresh = Boolean(refreshToken) && honouredRefreshTokens.get(key) !== refreshToken;
    if (forceRefresh) {
      honouredRefreshTokens.delete(key);
      honouredRefreshTokens.set(key, refreshToken);
      if (honouredRefreshTokens.size > MAX_TRACKED_KEYS) {
        honouredRefreshTokens.delete(honouredRefreshTokens.keys().next().value);
      }
    }
    const startedGeneration = generation;
    // Losing this map only makes an in-flight read skip storing its result.
    if (keyGenerations.size > MAX_TRACKED_KEYS) keyGenerations.clear();
    const keyGeneration = (keyGenerations.get(key) || 0) + (forceRefresh ? 1 : 0);
    keyGenerations.set(key, keyGeneration);

    let version;
    try {
      version = await currentDataVersion();
    } catch {
      version = null;
    }

    const cached = !forceRefresh && entries.get(key);
    if (cached && cached.expiresAt > Date.now()
      && (version === null || cached.version === null || cached.version === version)) {
      res.set('X-Report-Cache', 'HIT');
      return res.json(cached.body);
    }
    if (cached) entries.delete(key);

    // Identical concurrent requests share one computation.
    const inFlightKey = `${key}${keyGeneration}`;
    const existing = !forceRefresh && inFlight.get(inFlightKey);
    if (existing) {
      try {
        const result = await existing;
        res.set('X-Report-Cache', 'COALESCED');
        return res.status(result.statusCode).json(result.body);
      } catch {
        // The source request disconnected before producing JSON; compute
        // normally rather than waiting on a dead promise.
        return next();
      }
    }

    let settle;
    let reject;
    let completed = false;
    const pending = new Promise((resolve, rejectPromise) => {
      settle = resolve;
      reject = rejectPromise;
    });
    // Avoid an unhandled rejection when the originating client disconnects
    // and nobody else was waiting for the shared result.
    pending.catch(() => {});
    inFlight.set(inFlightKey, pending);

    const sendJson = res.json.bind(res);
    res.json = (body) => {
      completed = true;
      if (inFlight.get(inFlightKey) === pending) inFlight.delete(inFlightKey);
      const statusCode = res.statusCode;
      const stillCurrent = generation === startedGeneration && keyGenerations.get(key) === keyGeneration;
      if (statusCode >= 200 && statusCode < 300 && stillCurrent) {
        const ttl = ttlMs();
        if (ttl > 0) remember(key, { body, version, expiresAt: Date.now() + ttl });
        res.set('X-Report-Cache', forceRefresh ? 'REFRESHED' : 'MISS');
      }
      settle({ statusCode, body });
      return sendJson(body);
    };
    res.on('close', () => {
      if (!completed && inFlight.get(inFlightKey) === pending) {
        inFlight.delete(inFlightKey);
        reject(new Error('Source request closed before producing a response'));
      }
    });
    return next();
  };
}

// Exposed for tests.
export function reportCacheSize() {
  return entries.size;
}
