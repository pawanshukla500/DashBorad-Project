import { auth } from './firebaseAdmin.js';
import { FIREBASE_ROLE_CLAIM } from '../services/firebaseRoleClaims.js';
import { VALID_ROLES, normalizedRole, roleFromClaim } from './accessRole.js';

export { VALID_ROLES, normalizedRole };

// This object is built exclusively from a Firebase Admin verified ID token.
// Do not add a PostgreSQL lookup here: login/session validity and access checks
// must continue to work when the reporting database is busy or reconnecting.
export function firebaseSessionFromToken(decodedToken = {}) {
  const firebaseUid = String(decodedToken.uid || '').trim();
  const email = String(decodedToken.email || '').trim().toLowerCase();
  if (!firebaseUid || !email) throw new Error('Firebase token must contain a UID and email address');
  return {
    id: firebaseUid,
    firebase_uid: firebaseUid,
    email,
    username: String(decodedToken.name || decodedToken.email.split('@')[0]).trim(),
    role: roleFromClaim(decodedToken[FIREBASE_ROLE_CLAIM]),
    authentication_provider: 'firebase',
  };
}

// Firebase ID tokens stay valid for up to an hour, carrying the role claim
// they were issued with. Role changes and deletions revoke the user's
// sessions (auth.js); a token issued before that is refused here. The
// revocation time is cached per user for a minute so a request does not
// always wait on Firebase.
const REVOCATION_CACHE_MS = 60_000;
const REVOCATION_LOOKUP_TIMEOUT_MS = 1_500;
const revocationCache = new Map();
const revocationLookups = new Map();
// Bumped whenever a user's state is cleared (role change, deletion): a lookup
// that started before the change must not write its stale answer back.
const revocationGenerations = new Map();
let allGeneration = 0;

export function forgetRevocationState(uid) {
  if (uid) {
    revocationCache.delete(uid);
    revocationLookups.delete(uid);
    revocationGenerations.set(uid, (revocationGenerations.get(uid) || 0) + 1);
  } else {
    revocationCache.clear();
    revocationLookups.clear();
    allGeneration++;
  }
}

const generationOf = uid => `${allGeneration}:${revocationGenerations.get(uid) || 0}`;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`revocation lookup timed out after ${ms} ms`), { code: 'timeout' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// One Firebase lookup per user at a time, at most once a minute, never
// longer than the timeout. While Firebase is slow or down the last known
// state (or "not revoked") is reused for the cache window, so requests do not
// each wait on retries — and verified users are not locked out.
function revocationState(uid) {
  const cached = revocationCache.get(uid);
  if (cached && Date.now() - cached.at <= REVOCATION_CACHE_MS) return Promise.resolve(cached);
  if (revocationLookups.has(uid)) return revocationLookups.get(uid);
  const generation = generationOf(uid);
  const lookup = withTimeout(auth.getUser(uid), REVOCATION_LOOKUP_TIMEOUT_MS)
    .then(
      user => ({ validAfterMs: user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : 0, deleted: false }),
      error => {
        if (error?.code === 'auth/user-not-found') return { validAfterMs: 0, deleted: true };
        console.warn('[Auth Middleware] revocation check unavailable:', error?.message);
        return { validAfterMs: cached?.validAfterMs ?? 0, deleted: cached?.deleted ?? false };
      },
    )
    .then(state => {
      const entry = { ...state, at: Date.now() };
      // Cleared meanwhile: answer this request, but cache nothing stale.
      if (generationOf(uid) === generation) revocationCache.set(uid, entry);
      return entry;
    })
    .finally(() => {
      if (revocationLookups.get(uid) === lookup) revocationLookups.delete(uid);
    });
  revocationLookups.set(uid, lookup);
  return lookup;
}

async function sessionRevoked(decodedToken) {
  const entry = await revocationState(decodedToken.uid);
  if (entry.deleted) return true;
  const issuedAtMs = Number(decodedToken.auth_time || decodedToken.iat || 0) * 1000;
  return entry.validAfterMs > 0 && issuedAtMs < entry.validAfterMs;
}

export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token missing or malformed' });
  }
  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(token);
    if (await sessionRevoked(decodedToken)) {
      return res.status(401).json({
        error: 'Your access was changed. Please sign in again.',
        code: 'SESSION_REVOKED',
      });
    }
    req.user = firebaseSessionFromToken(decodedToken);
  } catch (err) {
    console.error('[Auth Middleware]', err.message);
    return res.status(403).json({ error: 'Invalid or expired Firebase token' });
  }
  // A valid Firebase account outside the team directory (e.g. a self sign-up
  // with the public web API key) carries no role claim and gets no access.
  if (!req.user.role) {
    return res.status(403).json({
      error: 'This account has not been granted access. Ask an administrator to add it in Admin Center.',
      code: 'ACCESS_NOT_GRANTED',
    });
  }
  return next();
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const check = () => {
      const role = normalizedRole(req.user?.role);
      if (allowedRoles.includes(role)) return next();
      return res.status(403).json({
        error: `Access denied. Required role: ${allowedRoles.join(' or ')}`,
      });
    };

    if (req.user) return check();
    return authMiddleware(req, res, check);
  };
}

export const requireAdmin = requireRole('admin');

export function mutationAccessGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.method === 'DELETE') return requireRole('admin')(req, res, next);
  return requireRole('operator', 'admin')(req, res, next);
}

export function rateCardAccessGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/calculate' || req.path === '/compare') return next();
  return requireRole('admin')(req, res, next);
}
