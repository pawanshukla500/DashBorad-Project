const PERMANENT_ERROR_CODES = new Set([
  'RATE_CARD_COVERAGE_INCOMPLETE',
  'FSN_COVERAGE_INCOMPLETE',
  'UNSUPPORTED_VERTICAL',
]);

export function isPermanentScrapeError(error) {
  if (!error) return false;
  if (PERMANENT_ERROR_CODES.has(error.code)) return true;
  const message = String(error.message || '').toLowerCase();
  return [
    'verticals selected',
    'not implemented for',
    'human login (2fa)',
    'user cancelled',
    'unauthorized',
    'configured categories have no database fsns',
    'no configured rate-card categories',
    'no configured rate-card category has a database fsn',
    'selected categories have no database fsns',
    'no database fsn for configured categories',
  ].some(fragment => message.includes(fragment));
}

export function permanentScrapeError(message, code = 'RATE_CARD_COVERAGE_INCOMPLETE') {
  return Object.assign(new Error(message), { code });
}
