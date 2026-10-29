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
const LOCAL_NETWORK_HOST_SUFFIXES = NON_ROUTABLE_HOST_SUFFIXES.filter(
  (suffix) => suffix !== '.internal' && suffix !== '.localdomain'
);

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

function isSavedContainerInternalHost(hostname) {
  const host = normalizeHost(hostname);
  // Explicitly saved mDNS / LAN DNS names are valid local database endpoints.
  // They remain forbidden in server-provisioned URLs via isContainerInternalHost.
  if (LOCAL_NETWORK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return isContainerInternalHost(host);
}

/**
 * True only for hosts a desktop machine outside the server's container network
 * can resolve and reach (public DNS name or public IP).
 */
export function isPubliclyRoutableHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  if (isContainerInternalHost(host)) return false;
  // Compare numeric hosts in any legacy IPv4 notation by their real address.
  const numeric = normalizeLegacyIpv4(host);
  if (numeric === 'invalid') return false;
  const effective = numeric || host;
  // Loopback / wildcard / unspecified
  if (effective === 'localhost' || host.endsWith('.localhost') || effective === '::1' || effective === '::' || effective === '0.0.0.0') return false;
  if (NON_PUBLIC_IP_PATTERNS.some((pattern) => pattern.test(effective))) return false;
  // RFC 2606 / 6761 special-use TLDs (db.example, db.invalid, payment.test) can
  // never resolve publicly, so a server-provisioned URL under one is refused.
  // Deliberately saved local URLs keep the sanitizeSavedDbUrl policy instead.
  if (/\.(example|invalid|test)$/.test(host)) return false;
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
 * Choose a connection URL for a verified desktop session. Analysts may only
 * retain a server-issued URL explicitly marked read-only; manual URLs and
 * legacy server responses are not safe to reuse for that role.
 */
export function selectDesktopDatabaseUrlForSession({
  role,
  manualUrl = '',
  serverUrl = '',
  serverAccess = ''
} = {}) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (normalizedRole === 'analyst') {
    return serverAccess === 'read-only' && isDesktopReachableDbUrl(serverUrl)
      ? String(serverUrl).trim()
      : '';
  }
  if (!['admin', 'operator'].includes(normalizedRole)) return '';

  const manual = String(manualUrl || '').trim();
  if (manual) return manual;
  return isDesktopReachableDbUrl(serverUrl) ? String(serverUrl).trim() : '';
}

/**
 * The stored config URL may be reused only by sessions whose role matches the
 * role that provisioned it: an analyst's read-only URL must never silently
 * become a later operator/admin session's URL (every write would fail on the
 * read-only principal), and an operator's writer URL must never reach an
 * analyst session. Unmarked stored URLs (manually configured, or saved by
 * older builds) keep the legacy reuse behavior for privileged roles only.
 */
export function storedDatabaseUrlForRole(role, { databaseUrl = '', databaseUrlRole = '' } = {}) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  const storedRole = String(databaseUrlRole || '').trim().toLowerCase();
  if (normalizedRole === 'analyst') {
    return storedRole === 'analyst' ? String(databaseUrl || '').trim() : '';
  }
  return storedRole === 'analyst' ? '' : String(databaseUrl || '').trim();
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
  if (!host || isSavedContainerInternalHost(host)) {
    console.warn(
      `[dbUrlGuard] Discarded an unusable saved database URL (host "${host ?? 'missing'}"). ` +
        'Configure the PostgreSQL URL in Settings, or set DESKTOP_DATABASE_URL on the API server.'
    );
    return '';
  }
  return url;
}
