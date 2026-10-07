const LEGACY_ROLE_MAP = { user: 'operator' };
export const VALID_ROLES = ['viewer', 'analyst', 'operator', 'admin'];

// A token's role claim, or null when it is missing or not a known role. Only
// accounts in the team directory get a claim (Admin Center creation or the
// startup claim sync), so null means "not granted access", never "viewer".
export function roleFromClaim(role) {
  const normalized = LEGACY_ROLE_MAP[String(role || '').toLowerCase()] || String(role || '').toLowerCase();
  return VALID_ROLES.includes(normalized) ? normalized : null;
}

export function normalizedRole(role) {
  const normalized = LEGACY_ROLE_MAP[String(role || '').toLowerCase()] || String(role || '').toLowerCase();
  return VALID_ROLES.includes(normalized) ? normalized : 'viewer';
}
