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
  //
  // The sign, accounting parentheses and currency marker may wrap each other
  // in any order: Excel renders a negative currency cell as "-₹1,234.00",
  // "₹-1,234.00", "(₹1,234.00)" or "₹(1,234.00)" depending on its format.
  // "-₹1,234" used to become NULL, silently dropping a deduction.
  let body = text.replace(/\u00a0/g, ' ').trim();
  let parenthesised = false;
  let sign = '';
  // Up to four layers: parentheses, a sign and repeated currency markers
  // ("INR ₹1,234.50", which the original sequential strip also accepted).
  for (let layer = 0; layer < 4; layer++) {
    let match;
    if (!parenthesised && (match = body.match(/^\((.+)\)$/))) {
      parenthesised = true;
      body = match[1].trim();
    } else if (!sign && (match = body.match(/^([+-])\s*(.+)$/))) {
      sign = match[1];
      body = match[2];
    } else if ((match = body.match(/^(?:INR|Rs\.?|₹)\s*(.+)$/i))) {
      body = match[1];
    } else {
      break;
    }
  }
  // "(-5)" / "-(5)" are ambiguous, never a spreadsheet's own notation.
  if (parenthesised && sign) return null;
  let normalized = body
    .replace(/\s+/g, '')
    .replace(/\/-$/, '');
  // Thousands separators must sit where Western (1,234,567.89) or Indian
  // (12,34,567.89) grouping puts them; "12.3,4" or "1234,50" is not an amount
  // and must be reported, not read as 12.34 / 123450.
  if (normalized.includes(',')) {
    const western = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
    const indian = /^\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?$/;
    if (!western.test(normalized) && !indian.test(normalized)) return null;
    normalized = normalized.replace(/,/g, '');
  }
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parenthesised || sign === '-' ? -parsed : parsed;
}

export function optionalInteger(value) {
  const parsed = optionalNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}

export function numberOrZero(value) {
  return optionalNumber(value) ?? 0;
}
