/**
 * Desktop provisioning resolver.
 *
 * The API server usually runs inside Docker, where DATABASE_URL points at the
 * container-internal service host (e.g. postgres:5432). Such a URL can never be
 * reached from a desktop worker machine, so it must never be handed to clients.
 *
 * Resolution order for operator/admin URLs provisioned to desktop workers:
 *   1. DESKTOP_DATABASE_URL — explicit override, trusted verbatim (set this on
 *      the production server to the publicly routable PostgreSQL URL).
 *   2. DATABASE_URL — only when its host is publicly routable.
 *   3. '' (empty) — the desktop app then reports "Not Configured" and the
 *      operator supplies the URL manually in Settings.
 *
 * Analysts use a separate DESKTOP_ANALYST_DATABASE_URL principal. The server
 * never falls back to either writer URL for that role.
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
  /^::ffff:/i                                 // IPv4-mapped IPv6
];

function normalizeHost(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

/**
 * True only when the host can be resolved and reached from a desktop machine
 * outside the server's container network (public DNS name or public IP).
 */
export function isPubliclyRoutableDbHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  // Loopback / wildcard / unspecified
  if (host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0') return false;
  if (NON_PUBLIC_IP_PATTERNS.some((pattern) => pattern.test(host))) return false;
  // Container-internal single-label service names (postgres, db, ...)
  if (!host.includes('.') && !host.includes(':')) return false;
  if (NON_ROUTABLE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return true;
}

/**
 * The database URL that may be provisioned to a desktop worker, or '' when the
 * server has no desktop-reachable URL to hand out.
 */
export function desktopDatabaseUrl(env = process.env) {
  const explicit = String(env.DESKTOP_DATABASE_URL || '').trim();
  if (explicit) return explicit;

  const dbUrl = String(env.DATABASE_URL || '').trim();
  if (!dbUrl) return '';

  try {
    const { hostname } = new URL(dbUrl);
    if (isPubliclyRoutableDbHost(hostname)) return dbUrl;
  } catch {
    // Malformed DATABASE_URL is never provisioned.
  }
  return '';
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
    if (isPubliclyRoutableDbHost(hostname)) return explicit;
  } catch {
    // Malformed or non-routable read-only URLs are never provisioned.
  }
  return '';
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
