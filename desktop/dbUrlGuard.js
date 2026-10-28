/**
 * Database URL guard for the ReconCentral desktop worker.
 *
 * The ReconCentral API runs inside Docker, where DATABASE_URL points at the
 * container-internal service host (e.g. postgres:5432). A URL like that can
 * never be reached from a desktop machine, so:
 *
 *   - URLs provisioned by the server are only adopted when their host is
 *     publicly routable (isDesktopReachableDbUrl).
 *   - Locally saved URLs whose host is a container-internal service name are
 *     sanitized away (sanitizeSavedDbUrl), so the app honestly reports
 *     "Not Configured" instead of failing with DNS lookup errors. Loopback and
 *     LAN hosts are preserved for developers running the database locally.
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

export function dbHostFromUrl(rawUrl) {
  try {
    return normalizeHost(new URL(String(rawUrl || '').trim()).hostname);
  } catch {
    return null;
  }
}

/**
 * Container-internal service host: a single-label name (postgres, db, ...) or a
 * .internal/.local style name. Never valid on a desktop machine.
 */
export function isContainerInternalHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  // Loopback is a deliberate local setup, not a container-internal leak.
  if (host === 'localhost' || host === '::1') return false;
  if (!host.includes('.') && !host.includes(':')) return true;
  return NON_ROUTABLE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * True only for hosts a desktop machine outside the server's container network
 * can resolve and reach (public DNS name or public IP).
 */
export function isPubliclyRoutableHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  if (isContainerInternalHost(host)) return false;
  // Loopback / wildcard / unspecified
  if (host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0') return false;
  if (NON_PUBLIC_IP_PATTERNS.some((pattern) => pattern.test(host))) return false;
  return true;
}

/**
 * May this server-provisioned URL be adopted as the worker's database URL?
 */
export function isDesktopReachableDbUrl(rawUrl) {
  const host = dbHostFromUrl(rawUrl);
  return Boolean(host) && isPubliclyRoutableHost(host);
}

/**
 * Sanitize a URL loaded from the local worker config: container-internal hosts
 * (provisioned by old server builds) become '' so the UI can ask the operator
 * to configure a reachable URL. Deliberate local setups (loopback / LAN) pass.
 */
export function sanitizeSavedDbUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  const host = dbHostFromUrl(url);
  if (!host || isContainerInternalHost(host)) {
    console.warn(
      `[dbUrlGuard] Discarded an unusable saved database URL (host "${host ?? 'missing'}"). ` +
        'Configure the PostgreSQL URL in Settings, or set DESKTOP_DATABASE_URL on the API server.'
    );
    return '';
  }
  return url;
}
