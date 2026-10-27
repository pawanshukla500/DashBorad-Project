/**
 * ReconCentral Desktop Scraper - Authentication, Token Role Validation & Channel Filtering
 * 
 * Shared production validation logic used across Electron main process (main.js),
 * standalone desktop server (desktopServer.mjs), and automated test suites.
 */

export const FIREBASE_ROLE_CLAIM = 'recon_role';
export const AUTHORIZED_ROLES = ['admin', 'operator', 'analyst'];

/**
 * Decode base64url or standard base64 encoded JWT payload without external libraries.
 */
export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length >= 2) {
      // Normalize base64url to standard base64 if needed
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
 * Channel-based rate card filtering ensuring strict multi-channel isolation.
 * Handles Myntra account separation:
 *  - Myntra VB: account_id 'myntra_vb' or seller_id / account '10708'
 *  - Myntra EJ: account_id 'myntra_ej' or seller_id / account '45833'
 * Normalizes all string and numeric comparisons.
 */
export function filterRateCardsByChannel(channel, rateCards) {
  const cards = Array.isArray(rateCards) ? rateCards : [];
  const target = String(channel || '').toLowerCase().trim();
  if (!target || target === 'both' || target === 'all' || target === 'flipkart_shopsy') {
    return cards;
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
