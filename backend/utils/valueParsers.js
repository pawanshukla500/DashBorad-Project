const EMPTY_VALUES = new Set(['', 'na', 'n/a', '-']);

export function optionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return EMPTY_VALUES.has(text.toLowerCase()) ? null : text;
}

export function optionalNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = optionalString(value);
  if (text == null) return null;
  // Do not use parseFloat after stripping arbitrary characters: it would turn
  // values like "12oops" into 12 and silently corrupt a reconciliation total.
  // Currency/grouping/accounting notation remains accepted for spreadsheet
  // exports, while any other populated cell is reported as invalid upstream.
  const normalized = text
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/^(?:INR|Rs\.?)\s*/i, '')
    .replace(/^₹\s*/, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .replace(/^\((.+)\)$/, '-$1')
    .replace(/\/-$/, '');
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function optionalInteger(value) {
  const parsed = optionalNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}

export function numberOrZero(value) {
  return optionalNumber(value) ?? 0;
}
