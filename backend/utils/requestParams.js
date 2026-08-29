export function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  // Do not let parseInt silently turn `12oops` or `1.5` into a different
  // page/limit. Query parameters affect report cost, so they must be whole,
  // safe integers before clamping them to an allowed range.
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function pagination(query = {}, { defaultPageSize = 50, maxPageSize = 100 } = {}) {
  const page = positiveInt(query.page, 1);
  const pageSize = positiveInt(query.pageSize, defaultPageSize, { max: maxPageSize });
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function optionalQueryText(value, label = 'filter', { maxLength = 120 } = {}) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    const error = new Error(`${label} must be text`);
    error.status = 400;
    throw error;
  }
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    const error = new Error(`${label} must contain ${maxLength} characters or fewer`);
    error.status = 400;
    throw error;
  }
  return text;
}
