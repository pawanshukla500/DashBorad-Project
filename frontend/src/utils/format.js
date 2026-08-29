// Safe coercion — pg returns NUMERIC as strings, this makes toFixed() safe
export function toNum(v) { return +(v ?? 0) || 0; }

/** Coerce chart row numeric fields — pg returns NUMERIC as strings */
export function normalizeRows(data, fields) {
  return (data || []).map(row => {
    const out = { ...row };
    for (const f of fields) out[f] = toNum(row[f]);
    return out;
  });
}

export function currency(v) {
  const n = parseFloat(v) || 0;
  if (Math.abs(n) >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
  if (Math.abs(n) >= 100000)   return `₹${(n / 100000).toFixed(2)}L`;
  if (Math.abs(n) >= 1000)     return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

export function currencyFull(v) {
  return `₹${(parseFloat(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(v) { return `${(parseFloat(v) || 0).toFixed(1)}%`; }

export function num(v) { return (parseInt(v) || 0).toLocaleString('en-IN'); }

export function formatNumber(v, digits = 0, empty = '—') {
  if (v == null || v === '') return empty;
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(+v || 0);
}

export function currencyCompact(v, empty = '₹0') {
  if (v == null || v === '') return empty;
  const n = +v || 0;
  if (Math.abs(n) >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (Math.abs(n) >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${formatNumber(n)}`;
}

export function currencyRounded(v, empty = '—') {
  return v == null || v === '' ? empty : `₹${formatNumber(v)}`;
}

export function percentageOrDash(v, digits = 1) {
  return v == null || v === '' ? '—' : `${(+v || 0).toFixed(digits)}%`;
}

export function formatDateShort(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export function formatDateFull(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
