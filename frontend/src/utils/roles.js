const LEGACY_ROLE_MAP = { user: 'operator' };

export const VALID_ROLES = ['viewer', 'analyst', 'operator', 'admin'];

const ROLE_RANK = { viewer: 1, analyst: 2, operator: 3, admin: 4 };

/** Normalize legacy DB role `user` → `operator`. */
export function normalizeRole(role) {
  return LEGACY_ROLE_MAP[role] || role || 'viewer';
}

export function withNormalizedRole(user) {
  if (!user) return null;
  return { ...user, role: normalizeRole(user.role) };
}

export function hasRole(role, allowed = []) {
  return allowed.includes(normalizeRole(role));
}

/** True if role can export reports (analyst+). */
export function canExport(role) {
  return (ROLE_RANK[normalizeRole(role)] || 0) >= ROLE_RANK.analyst;
}
