import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'reconcentral_desktop_session';
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function isSameDesktopOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  return origin === `http://${req.headers.host}`;
}

export function isAllowedDesktopOrigin(req) {
  if (isSameDesktopOrigin(req)) return true;
  try {
    const url = new URL(req.headers.origin);
    return url.protocol === 'https:' && !url.port &&
      ['youthnic.shop', 'vbexports.co.in', 'srv1845788.hstgr.cloud'].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
      );
  } catch {
    return false;
  }
}

export function bindBrowserSession(session) {
  const token = randomBytes(32).toString('hex');
  return {
    session: { ...session, browserTokenHash: hashToken(token) },
    cookie: `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=2592000`
  };
}

export const expiredBrowserCookie = `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0`;

function hasBrowserProof(req, session) {
  if (!isSameDesktopOrigin(req)) return false;
  const match = String(req.headers.cookie || '').match(
    /(?:^|;\s*)reconcentral_desktop_session=([a-f0-9]{64})(?:;|$)/
  );
  const expected = session?.browserTokenHash;
  if (!match || !/^[a-f0-9]{64}$/.test(expected || '')) return false;
  return timingSafeEqual(Buffer.from(hashToken(match[1]), 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * A saved Firebase token is not proof that an HTTP caller owns that session.
 * Require either the browser's HttpOnly cookie or a verified matching bearer.
 */
export async function authorizeDesktopRequest(req, { authorize, verify, mutation = false }) {
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const check = bearer ? await verify(bearer, true) : null;
  const session = await authorize(mutation);
  if (!session) return { session: null, error: check?.error };
  if (hasBrowserProof(req, session)) return { session };
  const uid = check?.verifiedPayload?.uid || check?.verifiedPayload?.sub;
  if (check?.authorized && uid === session.user?.firebase_uid && check.role === session.user?.role) {
    return { session };
  }
  return { session: null, error: check?.error || 'A matching browser session or verified bearer token is required.' };
}
