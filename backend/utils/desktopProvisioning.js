/**
 * Desktop provisioning resolver.
 *
 * The API server usually runs inside Docker, where DATABASE_URL points at the
 * container-internal service host (e.g. postgres:5432). Such a URL can never be
 * reached from a desktop worker machine, so it must never be handed to clients.
 *
 * Resolution order for the URL provisioned to desktop workers:
 *   1. DESKTOP_DATABASE_URL — explicit override, trusted verbatim (set this on
 *      the production server to the publicly routable PostgreSQL URL).
 *   2. DATABASE_URL — only when its host is publicly routable.
 *   3. '' (empty) — the desktop app then reports "Not Configured" and the
 *      operator supplies the URL manually in Settings.
 */

const NON_ROUTABLE_HOST_SUFFIXES = ['.internal', '.local', '.localdomain', '.lan', '.home.arpa', '.home', '.box'];

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
  if (/^127\./.test(host)) return false;
  // Private and link-local IPv4 ranges
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  // Private (fc00::/7) and link-local (fe80::/10) IPv6
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]?:/i.test(host)) return false;
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
