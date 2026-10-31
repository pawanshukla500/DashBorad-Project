import { createHash } from 'node:crypto';
// Explicit rc_* contract. Identifiers below are constants, never request data.
export const rateDiffFingerprint = (diffs, effectiveDate) => createHash('sha256').update(JSON.stringify({
  effectiveDate: effectiveDate || null,
  diffs: diffs.map(d => {
  const descriptor = RATE_TABLES.find(t => t.table === d.table);
  return [d.table, d.category, d.changeType,
    d.oldRow ? [d.oldRow.id, String(d.oldRow.start_date), String(d.oldRow.end_date), normalizeObservationRow(descriptor, d.oldRow)] : null,
    d.newRow ? normalizeObservationRow(descriptor, d.newRow) : null];
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
})).digest('hex');
export const RATE_TABLES = [
  { table: 'rc_commission', field: 'commissions', keys: ['brand_name', 'price_min', 'price_max'], values: ['rate'] },
  { table: 'rc_fixed_fee', field: 'fixedFees', keys: ['fulfilment_type', 'price_min', 'price_max'], values: ['rate'] },
  { table: 'rc_collection_fee', field: 'collectionFees', keys: ['fulfilment_type', 'price_min', 'price_max'], values: ['prepaid', 'postpaid', 'prepaid_type', 'postpaid_type'] },
  { table: 'rc_reverse_shipping', field: 'reverseShipping', keys: ['weight_slab', 'price_min', 'price_max'], values: ['local_fee', 'zonal_fee', 'national_fee', 'weight_min', 'weight_max', 'base_weight', 'increment_weight', 'local_additional_fee', 'zonal_additional_fee', 'national_additional_fee'] },
  { table: 'rc_pick_pack', field: 'pickPackFees', keys: ['fulfilment_type', 'weight_min', 'weight_max', 'price_min', 'price_max'], values: ['price_scope', 'rate', 'local_fee', 'zonal_fee', 'national_fee', 'base_weight', 'increment_weight', 'local_additional_fee', 'zonal_additional_fee', 'national_additional_fee'] }
];

const brand = value => !String(value || '').trim() || ['general', 'all brands'].includes(String(value).trim().toLowerCase()) ? null : String(value).trim();
const keyValue = (key, value) => key === 'brand_name' && value ? value.toLowerCase() : value;
const mode = value => String(value || 'ALL').toUpperCase().replace(/[ -]/g, '_');
const decimal = (value, name, precision) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean' || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(`Invalid ${name}; no rates were changed.`);
  }
  return Number(Number(value).toFixed(precision));
};

export function normalizeObservationRow(descriptor, row, observation = {}) {
  row = { ...row };
  const result = { category: observation.vertical || observation.category || row.category };
  if (typeof result.category !== 'string' || !result.category.trim()) throw new Error('Missing category.');
  result.price_min = decimal(row.price_min, 'price_min', 2);
  result.price_max = decimal(row.price_max, 'price_max', 2);
  if (result.price_max < result.price_min) throw new Error('Reversed price range.');
  if (descriptor.table === 'rc_commission') result.brand_name = brand(row.brand_name || observation.brand || observation.brand_name);
  if (descriptor.keys.includes('fulfilment_type')) result.fulfilment_type = mode(row.fulfilment_type);
  if (descriptor.table === 'rc_reverse_shipping') {
    if (!row.weight_slab) throw new Error('Missing reverse-shipping weight slab.');
    const weights = String(row.weight_slab).match(/\d+(?:\.\d+)?/g)?.map(Number);
    if (!weights?.length) throw new Error('Invalid reverse-shipping weight slab.');
    row.weight_min ??= weights.length > 1 ? weights[0] : 0;
    row.weight_max ??= weights.at(-1);
    result.weight_slab = `${decimal(row.weight_min, 'weight_min', 3)}kg-${decimal(row.weight_max, 'weight_max', 3)}kg`;
  }
  if (descriptor.table === 'rc_pick_pack') {
    row.weight_min ??= 0; row.weight_max ??= 999999;
    result.weight_min = decimal(row.weight_min, 'weight_min', 3);
    result.weight_max = decimal(row.weight_max, 'weight_max', 3);
    row.price_scope ??= 'range';
    row.rate ??= row.local_fee;
    row.local_fee ??= row.rate; row.zonal_fee ??= row.rate; row.national_fee ??= row.rate;
  }
  if (['rc_reverse_shipping','rc_pick_pack'].includes(descriptor.table)) {
    // Legacy records describe flat fees. Missing new model columns on those
    // stored records mean no incremental component, never missing scraped data.
    const legacy = !observation.vertical && !observation.category;
    for (const key of ['base_weight','increment_weight','local_additional_fee','zonal_additional_fee','national_additional_fee']) {
      if (legacy) row[key] ??= key === 'base_weight' ? row.weight_min : 0;
    }
  }
  for (const key of descriptor.values) {
    if (key === 'price_scope') {
      if (!['all','range'].includes(row[key])) throw new Error('Invalid price scope.');
      result[key] = row[key];
    } else if (key.endsWith('_type')) {
      if (!['pct', 'flat'].includes(row[key])) throw new Error(`Invalid ${key}.`);
      result[key] = row[key];
    } else {
      const percentage = descriptor.table === 'rc_commission' || (key === 'prepaid' && row.prepaid_type === 'pct') || (key === 'postpaid' && row.postpaid_type === 'pct');
      result[key] = decimal(row[key], key, percentage ? 6 : /weight/.test(key) ? 3 : 2);
      if (percentage && result[key] > 1) throw new Error(`${key} must be a fraction between zero and one.`);
    }
  }
  return result;
}

export function validateRateObservations(observations, { marketplace, complete = false, expectedVerticals = [] } = {}) {
  if (!Array.isArray(observations) || !observations.length) throw new Error('Non-empty rate observations are required.');
  const categories = new Set();
  const identities = new Map();
  for (const observation of observations) {
    if (observation.marketplace && observation.marketplace !== marketplace) throw new Error('Mixed marketplace observations are not allowed.');
    const category = observation.vertical || observation.category;
    categories.add(category);
    if (complete && (observation.source !== 'seller_portal' ||
        !['FBF', 'NON_FBF'].every(m => observation.fulfilmentModes?.includes(m)))) {
      throw new Error('A complete Seller Hub extraction for both fulfilment modes is required.');
    }
    if (complete) {
      const evidence = Array.isArray(observation.portalEvidence) ? observation.portalEvidence : [];
      const responseHasRows = family => Boolean(family?.slabs?.asp?.length || family?.slabs?.shippingSlab?.length);
      for (const fulfilment of ['FBF', 'NON_FBF']) {
        const response = evidence.find(item => item?.fulfilment === fulfilment);
        if (!response) throw new Error('Missing ' + fulfilment + ' Seller Hub response evidence; extraction is incomplete.');
        for (const family of ['platformFee', 'closingFee', 'collectionFee', 'reverseShippingFee']) {
          if (!responseHasRows(response.fees?.[family])) {
            throw new Error('Missing ' + family + ' response evidence for ' + fulfilment + '; extraction is incomplete.');
          }
        }
        if (fulfilment === 'FBF' && !responseHasRows(response.fees?.pickAndPackFee)) {
          throw new Error('Missing FBF pick-and-pack response evidence; extraction is incomplete.');
        }
      }
    }
    for (const descriptor of RATE_TABLES) {
      const rows = observation[descriptor.field] || [];
      const required = complete;
      if (!Array.isArray(rows) || (required && !rows.length)) throw new Error(`Missing ${descriptor.field}; incomplete extractions cannot be published.`);
      for (const row of rows) {
        const normalized = normalizeObservationRow(descriptor, row, observation);
        if (complete && marketplace === 'shopsy' && descriptor.table === 'rc_commission' && normalized.rate !== 0) {
          throw new Error('Unexpected nonzero Shopsy commission; review the portal response before publication.');
        }
        const identity = JSON.stringify([descriptor.table, normalized.category, ...descriptor.keys.map(k => keyValue(k, normalized[k]))]);
        if (identities.has(identity)) {
          const previous = identities.get(identity);
          if (descriptor.table === 'rc_commission' || previous.owner === observation || previous.value !== JSON.stringify(normalized)) {
            throw new Error(`Duplicate or conflicting ${descriptor.field} identity; review the extraction.`);
          }
        } else identities.set(identity, { owner: observation, value: JSON.stringify(normalized) });
      }
    }
  }
  for (const category of expectedVerticals) if (!categories.has(category)) throw new Error(`Missing configured category: ${category}.`);
}

export const rateRowIdentity = (descriptor, row) => JSON.stringify([row.category, ...descriptor.keys.map(k => keyValue(k, row[k]))]);
const identity = rateRowIdentity;
const value = (descriptor, row) => JSON.stringify(descriptor.values.map(k => row[k]));
const scope = (descriptor, row) => JSON.stringify([row.category, descriptor.table === 'rc_commission' ? keyValue('brand_name', row.brand_name) : null]);
const rawScope = (descriptor, row) => JSON.stringify([
  row.category,
  descriptor.table === 'rc_commission' ? keyValue('brand_name', brand(row.brand_name)) : null
]);
const display = (descriptor, row) => !row ? null : descriptor.table === 'rc_collection_fee'
  ? `Prepaid: ${row.prepaid} ${row.prepaid_type}, Postpaid: ${row.postpaid} ${row.postpaid_type}`
  : descriptor.table === 'rc_reverse_shipping' ? `L:₹${row.local_fee}/Z:₹${row.zonal_fee}/N:₹${row.national_fee}` : row.rate;

export async function planRateCardChanges(client, observations, { marketplace, sellerAccount, effectiveDate }) {
  validateRateObservations(observations, { marketplace });
  const diffs = [];
  let unchanged = 0;
  for (const descriptor of RATE_TABLES) {
    const incoming = [...new Map(observations.flatMap(o => (o[descriptor.field] || []).map(row => normalizeObservationRow(descriptor, row, o))).map(row => [identity(descriptor, row), row])).values()];
    if (!incoming.length) continue;
    const scopes = new Set(incoming.map(row => scope(descriptor, row)));
    const result = await client.query(`SELECT * FROM ${descriptor.table}
      WHERE marketplace = $1 AND seller_account = $2
        AND (start_date IS NULL OR start_date <= $3) AND (end_date IS NULL OR end_date >= $3)`, [marketplace, sellerAccount, effectiveDate]);
    const existing = new Map();
    for (const raw of result.rows) {
      // Filter irrelevant legacy records before normalizing fields that may be
      // absent on an unrelated category or brand.
      if (!scopes.has(rawScope(descriptor, raw))) continue;
      const row = normalizeObservationRow(descriptor, raw);
      const key = identity(descriptor, row);
      if (existing.has(key)) throw new Error(`Duplicate active ${descriptor.table} rows for ${row.category}. Publication requires database review.`);
      existing.set(key, { raw, row });
    }
    const push = (changeType, previous, row) => {
      const next = row || previous.row;
      const oldRate = display(descriptor, previous?.row), newRate = display(descriptor, row);
      const delta = typeof oldRate === 'number' && typeof newRate === 'number' ? Math.abs(oldRate - newRate) : 0;
      diffs.push({ table: descriptor.table, category: next.category, brand_name: next.brand_name || null,
        fulfilment_type: next.fulfilment_type || null,
        slab: descriptor.table === 'rc_reverse_shipping' ? `${next.weight_slab}: ₹${next.price_min} - ₹${next.price_max}` : `₹${next.price_min} - ₹${next.price_max}`,
        changeType, oldRate, newRate, anomaly: delta > 0 && ((oldRate > 0 && delta / oldRate >= 0.5) || (descriptor.table === 'rc_commission' && delta >= 0.05)),
        oldRow: previous?.raw || null, newRow: row || null, details: `${changeType}: ${descriptor.field} for ${next.category}` });
    };
    for (const row of incoming) {
      const key = identity(descriptor, row), previous = existing.get(key);
      if (!previous) push('ADDED', null, row);
      else if (value(descriptor, row) !== value(descriptor, previous.row)) push('MODIFIED', previous, row);
      else unchanged++;
      existing.delete(key);
    }
    for (const previous of existing.values()) push('REMOVED', previous, null);
  }
  return { hasChanges: diffs.length > 0, diffCount: diffs.length, diffs, fingerprint: rateDiffFingerprint(diffs, effectiveDate),
    summary: { added: diffs.filter(d => d.changeType === 'ADDED').length,
      modified: diffs.filter(d => d.changeType !== 'ADDED').length, unchanged,
      anomalies: diffs.filter(d => d.anomaly).length, totalChecked: diffs.length + unchanged } };
}
