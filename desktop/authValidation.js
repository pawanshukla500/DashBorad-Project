/**
 * ReconCentral Desktop Scraper - Authentication, Token Role Validation & Channel Filtering
 * 
 * Shared production validation logic used across Electron main process (main.js),
 * standalone desktop server (desktopServer.mjs), and automated test suites.
 */

export const FIREBASE_ROLE_CLAIM = 'recon_role';
export const AUTHORIZED_ROLES = ['admin', 'operator', 'analyst'];

export { 
  getResolvedUserDataDir, 
  getResolvedCookiesPath, 
  getResolvedCapturesDir, 
  saveEncryptedCookies, 
  loadEncryptedCookies 
} from './cookieVault.js';

/**
 * Decode base64url or standard base64 encoded JWT payload without external libraries.
 */
export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length >= 2) {
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      return JSON.parse(decoded);
    }
  } catch {}
  return null;
}

/**
 * Extract role from JWT payload, prioritizing the namespaced Firebase custom claim 'recon_role'
 * with fallback to standard 'role'.
 */
export function extractRoleFromTokenPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload[FIREBASE_ROLE_CLAIM] || payload.role || null;
}

/**
 * Extract role directly from an encoded JWT token string.
 */
export function extractRoleFromToken(token) {
  const payload = decodeJwtPayload(token);
  return extractRoleFromTokenPayload(payload);
}

/**
 * Verify whether a role is authorized for desktop scraping & read operations.
 */
export function isAuthorizedDesktopRole(role) {
  return Boolean(role && AUTHORIZED_ROLES.includes(role));
}

export const MUTATION_ROLES = ['admin', 'operator'];

/**
 * Verify whether a role is authorized for database mutations (rate-card sync, table updates).
 */
export function isAuthorizedMutationRole(role) {
  return Boolean(role && MUTATION_ROLES.includes(role));
}

/**
 * Complete token role validation against the authorized roles roster (structure & claim only).
 */
export function validateDesktopTokenRole(token) {
  const payload = decodeJwtPayload(token);
  const role = extractRoleFromTokenPayload(payload);
  const authorized = isAuthorizedDesktopRole(role);
  return {
    authorized,
    role,
    payload
  };
}

/**
 * Verifies fallback token revocation status against Identity Toolkit user metadata.
 * Fail-closed: Requires valid positive integer issue timestamp, valid positive integer validSince timestamp,
 * and strictly enforces that issueTime >= validSinceSec.
 * Malformed validSince (e.g. non-numeric characters, suffixes like '2000junk', or decimals like '2000.9')
 * are strictly rejected.
 */
export function verifyFallbackTokenRevocation(userRec, payload) {
  if (!userRec || !payload) return false;

  // Issue timestamp must be a finite, positive integer
  const issueTimeRaw = payload.auth_time !== undefined ? payload.auth_time : payload.iat;
  if (typeof issueTimeRaw !== 'number' || !Number.isFinite(issueTimeRaw) || !Number.isInteger(issueTimeRaw) || issueTimeRaw <= 0) {
    return false;
  }
  const issueTime = issueTimeRaw;

  // validSince must strictly match an all-digit positive integer string or positive integer number
  const validSinceRaw = userRec.validSince;
  if (validSinceRaw === undefined || validSinceRaw === null) {
    return false;
  }

  let validSinceSec;
  if (typeof validSinceRaw === 'string') {
    // Strictly require all digits without trimming; reject whitespace (e.g. " 2000 "), suffixes ("2000junk"), decimals ("2000.9")
    if (!/^\d+$/.test(validSinceRaw)) {
      return false;
    }
    validSinceSec = Number(validSinceRaw);
  } else if (typeof validSinceRaw === 'number' && Number.isFinite(validSinceRaw) && Number.isInteger(validSinceRaw)) {
    validSinceSec = validSinceRaw;
  } else {
    return false;
  }

  if (!Number.isFinite(validSinceSec) || validSinceSec <= 0) {
    return false;
  }

  // Token is valid only if issued at or after validSinceSec
  return issueTime >= validSinceSec;
}

/**
 * Cryptographically verifies a Firebase ID token and determines specific error reasons.
 * Returns { payload, error, isRevoked }.
 */
export async function verifyFirebaseTokenWithDetails(token, checkRevoked = true, options = {}) {
  if (!token || typeof token !== 'string') {
    return { payload: null, error: 'Token is missing or invalid' };
  }

  // 1. Local cryptographic signature and revocation verification via Firebase Admin SDK if configured
  try {
    const authModule = options.authModule || (options.auth !== undefined ? { auth: options.auth } : await import('../backend/utils/firebaseAdmin.js').catch(() => null));
    const auth = authModule?.auth;
    if (auth && typeof auth.verifyIdToken === 'function') {
      const decoded = await auth.verifyIdToken(token, checkRevoked);
      if (decoded && decoded.uid) {
        return { payload: decoded, error: null };
      }
    }
  } catch (adminErr) {
    if (
      adminErr.code === 'auth/id-token-revoked' ||
      adminErr.message?.includes('revoked')
    ) {
      return { payload: null, error: 'Firebase ID token has been revoked', isRevoked: true };
    }
    if (adminErr.code?.startsWith('auth/') || adminErr.message?.includes('Firebase ID token')) {
      return { payload: null, error: 'Cryptographic signature verification failed' };
    }
  }

  // 2. Cryptographic verification & revocation fallback via Google Identity Toolkit API
  try {
    const fetchFn = options.fetchFn || fetch;
    const apiKey = process.env.VITE_FIREBASE_API_KEY || 'AIzaSyD3FSzQXK7MACZOJR9tz_N7tnQ40QLMchs';
    const verifyUrl = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`;
    const res = await fetchFn(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token })
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.users && data.users.length > 0) {
        const userRec = data.users[0];
        const payload = decodeJwtPayload(token);
        
        // Check revocation against validSince timestamp (fail-closed)
        if (checkRevoked) {
          if (!verifyFallbackTokenRevocation(userRec, payload)) {
            return { payload: null, error: 'Firebase ID token has been revoked or revocation metadata is invalid', isRevoked: true };
          }
        }
        return { payload, error: null };
      }
    }
  } catch {}

  return { payload: null, error: 'Cryptographic signature or revocation verification failed' };
}

/**
 * Cryptographically verifies a Firebase ID token and verifies revocation status.
 * Validates token signature, issuer, audience, expiration, and checks revocation
 * via Firebase Admin SDK (checkRevoked: true) or Google Identity Toolkit (validSince check).
 * Returns verified decoded token payload or null if forged, unsigned, invalidly signed, or revoked.
 * Fails closed if revocation metadata or issue timestamps cannot be established when checkRevoked is true.
 */
export async function verifyFirebaseTokenCryptographically(token, checkRevoked = true, options = {}) {
  const result = await verifyFirebaseTokenWithDetails(token, checkRevoked, options);
  return result.payload;
}

/**
 * Verifies both the cryptographic signature and the authorized role claims of a desktop session token,
 * strictly verifying that the token has not been revoked (checkRevoked = true).
 * Preserves specific error details such as explicit token revocation.
 */
export async function verifyDesktopTokenAuthorization(token, checkRevoked = true, options = {}) {
  const { payload: verifiedPayload, error } = await verifyFirebaseTokenWithDetails(token, checkRevoked, options);
  if (!verifiedPayload) {
    return { authorized: false, role: null, error: error || 'Cryptographic signature or revocation verification failed' };
  }
  const role = extractRoleFromTokenPayload(verifiedPayload);
  const authorized = isAuthorizedDesktopRole(role);
  return { authorized, role, verifiedPayload };
}

/**
 * Validates that the token not only contains an authorized role, but strictly matches
 * the directory role from the ReconCentral database.
 */
export function validateTokenRoleMatchesDatabase(token, expectedRole) {
  const tokenValidation = validateDesktopTokenRole(token);
  const normalizedExpected = String(expectedRole || '').toLowerCase().trim();
  const matches = Boolean(tokenValidation.authorized && tokenValidation.role === normalizedExpected);
  return {
    valid: matches,
    tokenRole: tokenValidation.role,
    expectedRole: normalizedExpected,
    authorized: tokenValidation.authorized
  };
}

/**
 * Channel-based rate card filtering ensuring strict multi-channel isolation.
 * Handles Flipkart/Shopsy combined channel isolation (filtering to flipkart & shopsy only),
 * and Myntra account separation (VB: 10708, EJ: 45833).
 */
export function filterRateCardsByChannel(channel, rateCards) {
  const cards = Array.isArray(rateCards) ? rateCards : [];
  const target = String(channel || '').toLowerCase().trim();
  if (!target || target === 'all') {
    return cards;
  }
  if (target === 'flipkart_shopsy' || target === 'both') {
    return cards.filter(rc => {
      const mp = String(rc.marketplace || '').toLowerCase();
      return mp === 'flipkart' || mp === 'shopsy';
    });
  }
  if (target === 'myntra_vb') {
    return cards.filter(rc => (
      String(rc.account_id || '').toLowerCase() === 'myntra_vb' ||
      (String(rc.marketplace || '').toLowerCase() === 'myntra' && (String(rc.seller_id || '') === '10708' || String(rc.account || '') === '10708'))
    ));
  }
  if (target === 'myntra_ej') {
    return cards.filter(rc => (
      String(rc.account_id || '').toLowerCase() === 'myntra_ej' ||
      (String(rc.marketplace || '').toLowerCase() === 'myntra' && (String(rc.seller_id || '') === '45833' || String(rc.account || '') === '45833'))
    ));
  }
  return cards.filter(rc => String(rc.marketplace || '').toLowerCase() === target);
}
