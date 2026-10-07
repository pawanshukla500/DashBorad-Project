/**
 * Range checks for rate-card rows, in the units each rc_* table stores.
 *
 * Commission rates and percentage collection fees are fractions of the order
 * value (0.14 = 14%): services/rateCard.js charges price × rate, the editor
 * labels them "Decimal: 0.14 = 14%", and the workbook import turns "14%" into
 * 0.14. Fixed, pick & pack, franchise and reverse-shipping fees, and flat
 * collection fees, are rupees per order.
 *
 * Errors are values no row can hold: a non-number, a negative, an inverted
 * price band, a *_type other than pct/flat, or a number too large for its
 * NUMERIC column (PostgreSQL would otherwise fail the whole save).
 *
 * Warnings are values that can be stored but are implausible, most often a
 * percentage on the wrong scale. They never block a save: editing a period
 * re-sends its untouched rows, and legacy rows (such as a commission imported
 * as 14 rather than 0.14 by scripts/import_commissions.js) must stay editable.
 */

// PostgreSQL NUMERIC(p, s) holds magnitudes below 10^(p - s).
const NUMERIC_8_6_LIMIT = 100;              // rc_commission.rate, rc_collection_fee.prepaid/postpaid
const NUMERIC_10_2_LIMIT = 100_000_000;     // flat ₹ fee columns
const NUMERIC_12_2_LIMIT = 10_000_000_000;  // price_min / price_max

// initDb.js resets commission rates below this to 0 on every start.
const COMMISSION_RESET_BELOW = 0.005;

const RATE_TYPES = new Set(['pct', 'flat']);

const FRACTION = 'fraction';
const RUPEES = 'rupees';

const FEE_FIELDS = {
  commission: [
    {
      key: 'rate', label: 'Commission rate', unit: FRACTION, limit: NUMERIC_8_6_LIMIT, warnAbove: 0.6,
      resetBelow: COMMISSION_RESET_BELOW,
    },
  ],
  fixed_fee: [
    { key: 'rate', label: 'Fixed fee', unit: RUPEES, limit: NUMERIC_10_2_LIMIT, warnAbove: 500 },
  ],
  pick_pack: [
    { key: 'rate', label: 'Pick & pack fee', unit: RUPEES, limit: NUMERIC_10_2_LIMIT, warnAbove: 500 },
  ],
  franchise_fee: [
    { key: 'rate', label: 'Franchise fee', unit: RUPEES, limit: NUMERIC_10_2_LIMIT, warnAbove: 500 },
  ],
  reverse_shipping: [
    { key: 'local_fee', label: 'Local fee', unit: RUPEES, limit: NUMERIC_10_2_LIMIT, warnAbove: 1500 },
    { key: 'zonal_fee', label: 'Zonal fee', unit: RUPEES, limit: NUMERIC_10_2_LIMIT, warnAbove: 1500 },
    { key: 'national_fee', label: 'National fee', unit: RUPEES, limit: NUMERIC_10_2_LIMIT, warnAbove: 1500 },
  ],
  // Unit follows the row's *_type; a blank type is stored as the column
  // default 'pct'. Both share a NUMERIC(8,6) column, so flat fees cap at ₹99.99.
  collection_fee: [
    { key: 'prepaid', label: 'Prepaid fee', typeKey: 'prepaid_type', limit: NUMERIC_8_6_LIMIT },
    { key: 'postpaid', label: 'Postpaid fee', typeKey: 'postpaid_type', limit: NUMERIC_8_6_LIMIT },
  ],
};

const COLLECTION_UNITS = {
  pct: { unit: FRACTION, warnAbove: 0.05 },
  flat: { unit: RUPEES, warnAbove: 50 },
};

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value.trim());
  return NaN;
}

function formatPercent(fraction) {
  return `${+(fraction * 100).toFixed(4)}%`;
}

function checkFraction(field, value, warnAbove, warnings) {
  if (value > 1) {
    warnings.push(
      `${field.label} ${value} is above 1. Rates are stored as fractions (14% = 0.14), so this charges `
      + `${formatPercent(value)} of the order value — enter ${+(value / 100).toFixed(6)} if you meant ${value}%.`,
    );
  } else if (value > warnAbove) {
    warnings.push(`${field.label} ${formatPercent(value)} is unusually high (above ${formatPercent(warnAbove)}). Check it against the rate card.`);
  }
  if (field.resetBelow && value > 0 && value < field.resetBelow) {
    warnings.push(
      `${field.label} ${formatPercent(value)} is below ${formatPercent(field.resetBelow)}; `
      + 'the server resets rates this small to 0% when it restarts.',
    );
  }
}

function checkRupees(field, value, warnAbove, warnings) {
  if (value > 0 && value < 1) {
    warnings.push(
      `${field.label} ₹${value} is under ₹1. This fee is a flat rupee amount per order — `
      + 'a percentage written as a fraction looks like this.',
    );
  } else if (value > warnAbove) {
    warnings.push(`${field.label} ₹${value} is above the ₹${warnAbove} expected for this fee. Check it against the rate card.`);
  }
}

function checkPrice(row, key, errors) {
  if (isBlank(row[key])) return null;
  const value = toNumber(row[key]);
  if (!Number.isFinite(value)) {
    errors.push(`${key} must be a number`);
    return null;
  }
  if (value < 0) errors.push(`${key} must be 0 or more`);
  else if (value >= NUMERIC_12_2_LIMIT) errors.push(`${key} must be below ${NUMERIC_12_2_LIMIT.toLocaleString('en-IN')}`);
  return value;
}

/**
 * @returns {{ errors: string[], warnings: string[], row: object }} `row` is a
 *   copy with *_type values trimmed and lower-cased: the fee engine compares
 *   `=== 'flat'`, so a stored 'FLAT' would silently be charged as a percentage.
 */
export function checkRateRow(type, input = {}) {
  const row = { ...(input || {}) };
  const errors = [];
  const warnings = [];

  const priceMin = checkPrice(row, 'price_min', errors);
  const priceMax = checkPrice(row, 'price_max', errors);
  // A blank price_max means "no upper limit" (saved as 999999), so only two
  // given bounds can be inverted.
  if (priceMin != null && priceMax != null && priceMin > priceMax) {
    errors.push('price_min must be ≤ price_max');
  }

  for (const field of FEE_FIELDS[type] || []) {
    let { unit, warnAbove } = field;
    if (field.typeKey) {
      const rawType = row[field.typeKey];
      let rateType = 'pct';
      if (!isBlank(rawType)) {
        rateType = String(rawType).trim().toLowerCase();
        if (!RATE_TYPES.has(rateType)) {
          errors.push(`${field.typeKey} must be "pct" or "flat"`);
          continue;
        }
        row[field.typeKey] = rateType;
      }
      ({ unit, warnAbove } = COLLECTION_UNITS[rateType]);
    }

    if (isBlank(row[field.key])) continue;
    const value = toNumber(row[field.key]);
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`${field.key} must be a non-negative number`);
      continue;
    }
    if (value >= field.limit) {
      errors.push(`${field.key} must be below ${field.limit.toLocaleString('en-IN')} (the most its column can hold)`);
      continue;
    }
    if (unit === FRACTION) checkFraction(field, value, warnAbove, warnings);
    else checkRupees(field, value, warnAbove, warnings);
  }

  return { errors, warnings, row };
}
