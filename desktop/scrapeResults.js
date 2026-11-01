const FEE_FIELDS = ['commissions', 'fixedFees', 'collectionFees', 'reverseShipping', 'pickPackFees'];

const canonical = value => JSON.stringify(value, Object.keys(value).sort());
const sameSlabs = (a, b) => Array.isArray(a) && Array.isArray(b)
  ? JSON.stringify(a.map(canonical).sort()) === JSON.stringify(b.map(canonical).sort())
  : canonical(a) === canonical(b);

/**
 * Create process-local staging state shared by both desktop entry points.
 * Each runtime gets its own instance, but auth-generation invalidation stays
 * consistent between the Electron and standalone-server flows.
 */
export function createStagedExtractionState() {
  const state = { cards: [], coverage: null, authGeneration: 0 };
  state.resetForAuthChange = () => {
    state.cards = [];
    state.coverage = null;
    state.review = null;
    state.authGeneration += 1;
  };
  return state;
}

export function captureScrapeAuthContext(state, session) {
  const userId = String(session?.user?.firebase_uid || '').trim();
  if (!userId) throw new Error('An authenticated ReconCentral account is required to start a scrape.');
  return Object.freeze({ authGeneration: state.authGeneration, userId });
}

export function isScrapeAuthContextCurrent(state, context, session) {
  const userId = String(session?.user?.firebase_uid || '').trim();
  return Boolean(context?.userId) && context.userId === userId &&
    context.authGeneration === state.authGeneration;
}

export function resolveSellerAccountForRateCards(cards, requestedAccount) {
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('No rate cards are available for seller-account review.');
  const accounts = [...new Set(cards.map(card => String(card.seller_account || 'default').trim() || 'default'))];
  if (accounts.length !== 1) throw new Error('Review one seller account at a time.');
  const account = accounts[0];
  if (requestedAccount != null && String(requestedAccount).trim() !== account) {
    throw new Error('Selected seller account does not match the staged rate cards.');
  }
  return account;
}

function dedupe(slabs) {
  const out = [];
  for (const slab of slabs || []) {
    const numeric = ['price_min', 'price_max', ...('prepaid' in slab ? ['prepaid', 'postpaid'] : 'local_fee' in slab ? ['local_fee', 'zonal_fee', 'national_fee'] : ['rate'])];
    if (numeric.some(k => typeof slab[k] !== 'number' || !Number.isFinite(slab[k]) || slab[k] < 0) || slab.price_max < slab.price_min) {
      throw new Error('Invalid or missing fee value; nothing was staged.');
    }
    const identity = row => JSON.stringify([row.price_min, row.price_max, row.fulfilment_type, row.weight_slab, row.brand_name]);
    if (out.some(existing => identity(existing) === identity(slab) && !sameSlabs(existing, slab))) throw new Error('Conflicting duplicate fee slabs; nothing was staged.');
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

  // Preserve the day the portal was actually scraped: a review committed
  // after midnight must record rates under the scrape date, not the commit date.
  const scrapedOn = String(items.find(item => item.effectiveDate)?.effectiveDate || '');
  const effectiveDate = /^\d{4}-\d{2}-\d{2}$/.test(scrapedOn) ? scrapedOn : new Date().toISOString().slice(0, 10);

  const groups = new Map();
  for (const item of items) {
    if (!['flipkart', 'shopsy'].includes(item.marketplace) || !item.vertical) {
      throw new Error('Extraction contains an unsupported marketplace or missing vertical.');
    }
    if (!FEE_FIELDS.some(field => item[field]?.length)) {
      throw new Error(`No recognized fee slabs for ${item.vertical}. Nothing was staged.`);
    }
    if (item.marketplace === 'shopsy' && (item.commissions || []).some(row => row.rate !== 0)) {
      throw new Error('Unexpected nonzero Shopsy commission. Review the actual portal response; no rates were staged.');
    }
    const sellerAccount = item.seller_account || item.sellerAccount || 'default';
    const key = JSON.stringify([item.marketplace, item.vertical, item.brand || 'General', item.sample_fsn || null, sellerAccount]);
    if (!groups.has(key)) groups.set(key, new Map());
    const byMode = groups.get(key);
    const mode = item.fulfilment_type || 'ALL';
    const slabs = byMode.get(mode) || Object.fromEntries(FEE_FIELDS.map(field => [field, []]));
    for (const field of FEE_FIELDS) {
      let incoming = field === 'collectionFees' ? (item[field] || []).map(normalizeCollectionFee) : item[field];
      if (field === 'fixedFees' && ['FBF', 'NON_FBF'].includes(mode)) {
        incoming = (incoming || []).map(fee => ({ ...fee, fulfilment_type: mode }));
      }
      slabs[field] = dedupe([...slabs[field], ...(incoming || [])]);
    }
    byMode.set(mode, slabs);
  }

  const cards = [];
  for (const [key, byMode] of groups) {
    const [marketplace, vertical, brand, fsn, sellerAccount] = JSON.parse(key);
    const modes = [...byMode.keys()];
    const [first, ...rest] = [...byMode.values()];
    // A table present in one mode but missing in another is also a disagreement:
    // syncing the partial set would close the category's existing rates.
    for (const field of FEE_FIELDS) {
      const modeSpecific = field === 'fixedFees' && modes.every(mode => ['FBF', 'NON_FBF'].includes(mode));
      if (field !== 'pickPackFees' && rest.some(other => modeSpecific ? Boolean(other[field].length) !== Boolean(first[field].length) : !sameSlabs(other[field], first[field]))) {
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
      brand,
      seller_account: sellerAccount,
      sample_fsn: fsn,
      sample_sku: items.find(i => i.marketplace === marketplace && i.vertical === vertical &&
        (i.brand || 'General') === brand && (i.sample_fsn || null) === fsn &&
        (i.seller_account || i.sellerAccount || 'default') === sellerAccount)?.sample_sku,
      source: 'seller_portal',
      fulfilmentModes: modes,
      portalEvidence: items.filter(item => item.marketplace === marketplace && item.vertical === vertical &&
        (item.brand || 'General') === brand && (item.sample_fsn || null) === fsn &&
        (item.seller_account || item.sellerAccount || 'default') === sellerAccount).map(item => item.portalEvidence).filter(Boolean),
      effectiveDate,
      ...merged
    });
  }
  return cards;
}

/**
 * The staged cards a sync request may commit: a non-empty selection in which
 * every submitted card exactly matches a distinct staged card (e.g. the
 * channel-filtered preview). Returns the staged objects themselves, or null.
 */
export function selectStagedCards(stagedCards, submittedCards) {
  if (!Array.isArray(stagedCards) || !stagedCards.length) return null;
  if (!Array.isArray(submittedCards) || !submittedCards.length) return null;
  const remaining = stagedCards.map(card => ({ card, json: JSON.stringify(card) }));
  const selected = [];
  for (const submitted of submittedCards) {
    const json = JSON.stringify(submitted);
    const index = remaining.findIndex(entry => entry.json === json);
    if (index === -1) return null;
    selected.push(remaining[index].card);
    remaining.splice(index, 1);
  }
  return selected;
}
