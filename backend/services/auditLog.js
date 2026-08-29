import { getPool, isDbConfigured } from '../db/index.js';

const MAX_AUDIT_DEPTH = 4;
const MAX_AUDIT_ARRAY_ITEMS = 25;
const MAX_AUDIT_OBJECT_KEYS = 40;
const MAX_AUDIT_STRING_LENGTH = 1_000;

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'file') return true;
  return [
    'password', 'token', 'authorization', 'secret', 'apikey',
    'credential', 'privatekey', 'imagedata', 'base64', 'dataurl',
  ].some(sensitive => normalized === sensitive || normalized.includes(sensitive));
}

function safeAuditValue(value, depth, seen) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.length <= MAX_AUDIT_STRING_LENGTH) return value;
    return `${value.slice(0, MAX_AUDIT_STRING_LENGTH)}… [truncated ${value.length - MAX_AUDIT_STRING_LENGTH} characters]`;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[invalid date]' : value.toISOString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return '[binary omitted]';
  if (depth >= MAX_AUDIT_DEPTH) return '[nested value omitted]';
  if (typeof value !== 'object') return `[${typeof value} omitted]`;
  if (seen.has(value)) return '[circular reference omitted]';

  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_AUDIT_ARRAY_ITEMS).map(item => safeAuditValue(item, depth + 1, seen));
    if (value.length > MAX_AUDIT_ARRAY_ITEMS) items.push(`[${value.length - MAX_AUDIT_ARRAY_ITEMS} more items omitted]`);
    seen.delete(value);
    return items;
  }

  const copy = {};
  for (const [index, [key, nested]] of Object.entries(value).entries()) {
    if (index >= MAX_AUDIT_OBJECT_KEYS) {
      copy._truncated = `${Object.keys(value).length - MAX_AUDIT_OBJECT_KEYS} additional keys omitted`;
      break;
    }
    copy[key] = isSensitiveKey(key) ? '[redacted]' : safeAuditValue(nested, depth + 1, seen);
  }
  seen.delete(value);
  return copy;
}

export function sanitizeAuditDetails(details) {
  if (!details || typeof details !== 'object') return {};
  return safeAuditValue(details, 0, new WeakSet());
}

export async function writeAudit(req, {
  action,
  entityType = 'api',
  entityId = null,
  details = {},
} = {}) {
  try {
    if (!(await isDbConfigured()) || !action) return;
    await getPool().query(
      `INSERT INTO audit_events
       (actor_user_id, actor_email, actor_role, action, entity_type, entity_id, details, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        // Firebase UID is a string, while this old optional SQL column is an
        // integer. Keep the UID-independent audit email/role fields instead
        // of forcing authentication to query the users directory for an id.
        req.user?.directory_user_id || null,
        req.user?.email || null,
        req.user?.role || null,
        action,
        entityType,
        entityId == null ? null : String(entityId),
        JSON.stringify(sanitizeAuditDetails(details)),
        req.ip || req.socket?.remoteAddress || null,
      ]
    );
  } catch (error) {
    console.warn('[audit]', error.message);
  }
}

export function auditMutationMiddleware(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    void writeAudit(req, {
      action: `${req.method} ${req.originalUrl.split('?')[0]}`,
      entityType: 'api_mutation',
      entityId: req.params?.id || null,
      details: {
        statusCode: res.statusCode,
        query: req.query || {},
        body: sanitizeAuditDetails(req.body || {}),
      },
    });
  });
  next();
}
