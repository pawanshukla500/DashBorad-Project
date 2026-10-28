const FEE_FIELDS = ['commissions', 'fixedFees', 'collectionFees', 'reverseShipping'];

const sameSlabs = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function dedupe(slabs) {
  const out = [];
  for (const slab of slabs || []) {
    if (!out.some(existing => sameSlabs(existing, slab))) out.push(slab);
  }
  return out;
}

// The portal parser reports percentage collection fees as whole percents
// (0.3 for 0.3%); rc_collection_fee stores them as 'pct' decimals (0.003),
// which is what the fee calculations multiply by.
function normalizeCollectionFee(fee) {
  const convert = (value, type) => {
    const isPct = type === 'percentage' || type === 'pct';
    return { value: isPct && type === 'percentage' ? Number(value) / 100 : Number(value), type: isPct ? 'pct' : 'flat' };
  };
  const prepaid = convert(fee.prepaid, fee.prepaid_type);
  const postpaid = convert(fee.postpaid, fee.postpaid_type);
  return {
    ...fee,
    prepaid: prepaid.value,
    prepaid_type: prepaid.type,
    postpaid: postpaid.value,
    postpaid_type: postpaid.type
  };
}

/**
 * Turn raw portal extractions into reviewable cards, one per marketplace + vertical.
 *
 * Each vertical is scraped once per fulfilment mode (FBF / NON_FBF), but the
 * rate tables store a single rate set per category. The modes are merged only
 * when they agree; if they disagree the extraction is refused, because syncing
 * either one (or a mix) would write rates that are wrong for the other mode.
 */
export function normalizeScrapedCards(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('No extracted rate cards to review.');

  const groups = new Map();
  for (const item of items) {
    if (!['flipkart', 'shopsy'].includes(item.marketplace) || !item.vertical) {
      throw new Error('Extraction contains an unsupported marketplace or missing vertical.');
    }
    if (!FEE_FIELDS.some(field => item[field]?.length)) {
      throw new Error(`No recognized fee slabs for ${item.vertical}. Nothing was staged.`);
    }
    const key = `${item.marketplace}:${item.vertical}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const byMode = groups.get(key);
    const mode = item.fulfilment_type || 'ALL';
    const slabs = byMode.get(mode) || Object.fromEntries(FEE_FIELDS.map(field => [field, []]));
    for (const field of FEE_FIELDS) {
      const incoming = field === 'collectionFees' ? (item[field] || []).map(normalizeCollectionFee) : item[field];
      slabs[field] = dedupe([...slabs[field], ...(incoming || [])]);
    }
    byMode.set(mode, slabs);
  }

  const cards = [];
  for (const [key, byMode] of groups) {
    const [marketplace, vertical] = key.split(':');
    const modes = [...byMode.keys()];
    const [first, ...rest] = [...byMode.values()];
    for (const field of FEE_FIELDS) {
      const conflicting = rest.find(other => other[field].length && first[field].length && !sameSlabs(other[field], first[field]));
      if (conflicting) {
        throw new Error(
          `${vertical} (${marketplace}) has different ${field} for ${modes.join(' and ')}. ` +
          'The rate tables store one rate set per category, so nothing was staged.'
        );
      }
    }
    const merged = Object.fromEntries(FEE_FIELDS.map(field => [
      field,
      dedupe([...byMode.values()].flatMap(slabs => slabs[field]))
    ]));
    cards.push({
      marketplace,
      category: vertical,
      brand: 'General',
      source: marketplace === 'shopsy' ? 'shopsy_policy' : 'seller_portal',
      fulfilmentModes: modes,
      ...merged
    });
  }
  return cards;
}
