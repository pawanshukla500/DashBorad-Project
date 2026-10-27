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
} from '../backend/utils/cookieVault.js';

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
 * Verify whether a role is authorized for desktop scraping & DB operations.
 */
export function isAuthorizedDesktopRole(role) {
  return Boolean(role && AUTHORIZED_ROLES.includes(role));
}

/**
 * Complete token role validation against the authorized roles roster.
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
