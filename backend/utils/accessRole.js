const LEGACY_ROLE_MAP = { user: 'operator' };
export const VALID_ROLES = ['viewer', 'analyst', 'operator', 'admin'];

export function normalizedRole(role) {
  const normalized = LEGACY_ROLE_MAP[String(role || '').toLowerCase()] || String(role || '').toLowerCase();
  return VALID_ROLES.includes(normalized) ? normalized : 'viewer';
}
