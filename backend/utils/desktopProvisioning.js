/**
 * Desktop provisioning resolver.
 *
 * Desktop workers must always land on the SAME PostgreSQL database the
 * ReconCentral dashboard itself uses — a desktop worker is an extension of
 * the dashboard, never a separate data system.
 *
 * Resolution order for operator/admin URLs provisioned to desktop workers:
 *   1. DATABASE_URL — the dashboard's own database, provisioned verbatim
 *      whenever its host is publicly routable from a desktop machine.
 *   2. DESKTOP_DATABASE_URL — containerized-deployment escape hatch for the
 *      rare case where DATABASE_URL points at a container-internal service
 *      host (e.g. postgres:5432). It must be the routable address form of
 *      that SAME database; a URL naming any other database is refused.
 *   3. '' (empty) — the desktop app then reports "Not Configured" and the
 *      operator supplies the URL manually in Settings.
 *
 * Analysts use a separate DESKTOP_ANALYST_DATABASE_URL principal (read-only
 * grants on the same database). It is also refused unless it names the
 * dashboard's own database, and the server never falls back to either
 * writer URL for that role.
 */

const NON_ROUTABLE_HOST_SUFFIXES = ['.internal', '.local', '.localdomain', '.lan', '.home.arpa', '.home', '.box'];

// IANA special-purpose ranges that are never reachable as a public database host.
const NON_PUBLIC_IP_PATTERNS = [
  /^0\./,                                     // 0.0.0.0/8 "this network"
  /^10\./,                                    // 10.0.0.0/8 private
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 carrier-grade NAT
  /^127\./,                                   // loopback
  /^169\.254\./,                              // link-local
  /^172\.(1[6-9]|2\d|3[01])\./,               // 172.16.0.0/12 private
  /^192\.0\.0\./,                             // 192.0.0.0/24 IETF protocol assignments
  /^192\.0\.2\./,                             // TEST-NET-1
  /^192\.168\./,                              // private
  /^198\.1[89]\./,                            // 198.18.0.0/15 benchmarking
  /^198\.51\.100\./,                          // TEST-NET-2
  /^203\.0\.113\./,                           // TEST-NET-3
  /^(22[4-9]|23\d|24\d|25[0-5])\./,           // multicast + reserved (224.0.0.0/3)
  /^f[cd][0-9a-f]{2}:/i,                      // fc00::/7 unique local IPv6
  /^fe[89ab][0-9a-f]?:/i,                     // fe80::/10 link-local IPv6
  /^ff[0-9a-f]{2}:/i,                         // ff00::/8 multicast IPv6
  /^2001:0?db8:/i,                            // 2001:db8::/32 documentation IPv6
  /^2001::/i,                                 // 2001::/32 Teredo
  /^2001:0?2:/i,                              // 2001:2::/48 RFC 2544/5180 benchmarking
  /^2001:1[0-9a-f]:/i,                        // 2001:10::/28 deprecated ORCHID
  /^::ffff:/i                                 // IPv4-mapped IPv6
];

function normalizeHost(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, ''); // "localhost." is the same host as "localhost"
}

/**
 * Non-special URL schemes (e.g. postgres://) do not canonicalize IPv4, so
 * legacy forms like 0177.0.0.1 (octal), 0x7f.0.0.1 (hex), or 127.1 (short)
 * survive URL parsing unchanged. Normalize them to dotted decimal so the
 * non-public range checks see the real address. A purely numeric-looking host
 * that is not valid IPv4 in any form is never a legitimate database DNS name
 * and is rejected outright. Labels made only of bare hexadecimal letters (face,
 * cafe, beef) are DNS names, not inet_aton numeric components, so hosts like
 * face.cafe pass through untouched as ordinary DNS names.
 * Returns the canonical dotted string, 'invalid', or null for non-numeric hosts.
 */
function normalizeLegacyIpv4(host) {
  if (!/^[0-9a-fx.]+$/i.test(host) || !host.includes('.')) return null;
  const parts = host.split('.');
  if (parts.length > 4) return 'invalid';
  const nums = [];
  for (const part of parts) {
    if (!part) return 'invalid';
    if (/^0x[0-9a-f]+$/i.test(part)) {
      nums.push(parseInt(part, 16));
    } else if (/^\d+$/.test(part)) {
      if (part.length > 1 && part.startsWith('0')) {
        if (!/^[0-7]+$/.test(part)) return 'invalid'; // 08/09 are not valid octal
        nums.push(parseInt(part, 8));
      } else {
        nums.push(parseInt(part, 10));
      }
    } else if (/^[0-9a-f]+$/i.test(part)) {
      // Bare hex-letter labels (face, cafe, beef) are DNS names, not numeric
      // notation: the whole host is a DNS name, never an IPv4 form.
      return null;
    } else {
      return 'invalid';
    }
  }
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 255) return 'invalid';
  }
  const lastMax = Math.pow(256, 5 - nums.length) - 1;
  if (nums[nums.length - 1] > lastMax) return 'invalid';
  let ipv4 = 0;
  for (let i = 0; i < nums.length - 1; i++) ipv4 += nums[i] * Math.pow(256, 3 - i);
  ipv4 += nums[nums.length - 1];
  return [(ipv4 >>> 24) & 255, (ipv4 >>> 16) & 255, (ipv4 >>> 8) & 255, ipv4 & 255].join('.');
}

/**
 * IPv4-embedded IPv6 forms carry the same address as their embedded IPv4:
 * ::ffff:10.0.0.5 (mapped), the deprecated IPv4-compatible dotted ::10.0.0.5,
 * and the hex-tail form ::a00:5 (which encodes 10.0.0.5). Returns the embedded
 * dotted IPv4, or null for ordinary hosts.
 */
function extractEmbeddedIpv4(host) {
  if (!host.includes(':')) return null;
  const h = host.toLowerCase();
  if (/^::(?:ffff:)?\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return h.replace(/^::(?:ffff:)?/, '');
  const hexTail = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexTail) {
    const hi = parseInt(hexTail[1], 16);
    const lo = parseInt(hexTail[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

/**
 * True only when the host can be resolved and reached from a desktop machine
 * outside the server's container network (public DNS name or public IP).
 */
export function isPubliclyRoutableDbHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  // Compare numeric hosts in any legacy IPv4 notation by their real address.
  const numeric = normalizeLegacyIpv4(host);
  if (numeric === 'invalid') return false;
  const effective = numeric || host;
  // Loopback / wildcard / unspecified
  if (effective === 'localhost' || host.endsWith('.localhost') || effective === '::1' || effective === '::' || effective === '0.0.0.0') return false;
  if (NON_PUBLIC_IP_PATTERNS.some((pattern) => pattern.test(effective))) return false;
  // IPv4-embedded IPv6 literals (::ffff:10.0.0.5, deprecated ::a00:5 and
  // ::10.0.0.5) carry the same address as their embedded IPv4: the
  // non-public range checks must see that address too.
  const embedded = extractEmbeddedIpv4(host);
  if (embedded && NON_PUBLIC_IP_PATTERNS.some((pattern) => pattern.test(embedded))) return false;
  // Container-internal single-label service names (postgres, db, ...)
  if (!host.includes('.') && !host.includes(':')) return false;
  if (NON_ROUTABLE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  // RFC 2606 / 6761 special-use TLDs (db.example, db.invalid, payment.test)
  // are reserved for documentation and local testing: they can never resolve
  // publicly, so a URL under one is never provisioned.
  if (/\.(example|invalid|test)$/.test(host)) return false;
  return true;
}

/**
 * Database name component of a PostgreSQL URL ('' when absent or unparsable).
 * Used to keep desktop provisioning pinned to the dashboard's own database.
 */
function databaseNameOf(rawUrl) {
  try {
    const { pathname } = new URL(String(rawUrl || '').trim());
    return decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return '';
  }
}

/**
 * The database URL that may be provisioned to a desktop worker, or '' when the
 * server has no desktop-reachable URL for the dashboard's own database.
 */
export function desktopDatabaseUrl(env = process.env) {
  // The dashboard's own DATABASE_URL is the source of truth: whenever it is
  // directly routable it is provisioned verbatim, so desktop workers always
  // work against the very same database the dashboard uses.
  const dbUrl = String(env.DATABASE_URL || '').trim();
  if (dbUrl) {
    try {
      const { hostname } = new URL(dbUrl);
      if (isPubliclyRoutableDbHost(hostname)) return dbUrl;
    } catch {
      // Malformed DATABASE_URL is never provisioned.
    }
  }

  // DESKTOP_DATABASE_URL is the containerized-deployment escape hatch: the
  // routable address form of the SAME database when DATABASE_URL itself is
  // container-internal. A URL naming any other database is refused outright.
  const explicit = String(env.DESKTOP_DATABASE_URL || '').trim();
  if (!explicit) return '';
  const dashboardDatabase = databaseNameOf(dbUrl);
  if (dashboardDatabase && databaseNameOf(explicit) !== dashboardDatabase) {
    return '';
  }
  return explicit;
}

/**
 * A distinct database principal for analysts. It must be configured with
 * read-only grants and is never allowed to fall back to operator credentials.
 */
export function desktopAnalystDatabaseUrl(env = process.env) {
  const explicit = String(env.DESKTOP_ANALYST_DATABASE_URL || '').trim();
  if (!explicit) return '';

  try {
    const { hostname } = new URL(explicit);
    if (!isPubliclyRoutableDbHost(hostname)) return '';
  } catch {
    // Malformed or non-routable read-only URLs are never provisioned.
    return '';
  }
  // The read-only principal must be a principal on the dashboard's own
  // database; a separate analyst database is never provisioned.
  const dashboardDatabase = databaseNameOf(String(env.DATABASE_URL || ''));
  if (dashboardDatabase && databaseNameOf(explicit) !== dashboardDatabase) {
    return '';
  }
  return explicit;
}

export function desktopDatabaseProvisioningForRole(role, env = process.env) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'analyst') {
    return { databaseUrl: desktopAnalystDatabaseUrl(env), databaseAccess: 'read-only' };
  }
  if (normalized === 'admin' || normalized === 'operator') {
    return { databaseUrl: desktopDatabaseUrl(env), databaseAccess: 'standard' };
  }
  return { databaseUrl: '', databaseAccess: 'none' };
}
