import { auth } from './firebaseAdmin.js';
import { FIREBASE_ROLE_CLAIM } from '../services/firebaseRoleClaims.js';
import { VALID_ROLES, normalizedRole } from './accessRole.js';

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
    role: normalizedRole(decodedToken[FIREBASE_ROLE_CLAIM]),
    authentication_provider: 'firebase',
  };
}

export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token missing or malformed' });
  }
  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.user = firebaseSessionFromToken(decodedToken);
    next();
  } catch (err) {
    console.error('[Auth Middleware]', err.message);
    return res.status(403).json({ error: 'Invalid or expired Firebase token' });
  }
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
