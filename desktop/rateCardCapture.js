const FEE_KEYS = ['platformFee', 'closingFee', 'collectionFee', 'reverseShippingFee', 'pickAndPackFee'];
export function isRateResponseUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'seller.flipkart.com' &&
    ['/orchestrator/graphql', '/napi/rate-card/get-complete-category-tree'].includes(url.pathname); } catch { return false; }
}

export function createRateCardCapture() {
  let records = [], categoryTree = null;
  return {
    reset() { records = []; },
    get categoryTree() { return categoryTree; },
    observe({ url, postData, status, body }) {
      if (!isRateResponseUrl(url)) return;
      if (new URL(url).pathname.endsWith('get-complete-category-tree')) {
        if (status === 200 && body?.result) categoryTree = body.result;
        return;
      }
      let input;
      try { input = JSON.parse(postData).variables.input; } catch { return; }
      if ((!input?.vertical && !input?.fsn) || !input.partnerContext || !input.serviceProfile) return;
      const settlement = body?.data?.settlement;
      const errors = status !== 200 || body?.graphErrors?.length || Object.keys(body?.dataErrors || {}).length || body?.errors?.length;
      const fees = Object.fromEntries(FEE_KEYS.filter(k => settlement && k in settlement).map(k => [k, settlement[k]]));
      if (Object.keys(fees).length || errors) records.push({ input, status, fees, errors: Boolean(errors) });
    },
    snapshot({ vertical, fsn, marketplace, fulfilment, date }) {
      const fees = {}, tiers = new Set();
      for (const record of records) {
        const input = record.input;
        if ((fsn ? input.fsn !== fsn : input.vertical !== vertical) || input.partnerContext !== marketplace || input.serviceProfile !== fulfilment || input.date !== date) continue;
        if (record.errors) throw new Error(`Seller Hub rate response failed (HTTP ${record.status}) for ${fsn || vertical} / ${fulfilment}.`);
        tiers.add(input.darwinTier);
        for (const [key, fee] of Object.entries(record.fees)) {
          if (!fee || fee.serviceProfile !== fulfilment) throw new Error(`Missing or mismatched ${key} response.`);
          if (fees[key] && JSON.stringify(fees[key]) !== JSON.stringify(fee)) throw new Error(`Conflicting duplicate ${key} responses.`);
          fees[key] = fee;
        }
      }
      if (tiers.size > 1) throw new Error('Rate responses mix seller tiers.');
      const required = fulfilment === 'FBF' ? FEE_KEYS : FEE_KEYS.filter(k => k !== 'pickAndPackFee');
      return { fees, sellerTier: [...tiers][0], missing: required.filter(k => !fees[k]), categoryTree };
    }
  };
}

export function attachRateCardCapture(page) {
  if (page.rateCardCapture) return { capture: page.rateCardCapture, detach() {} };
  const capture = createRateCardCapture();
  const receive = async response => {
    if (!isRateResponseUrl(response.url())) return;
    try { capture.observe({ url: response.url(), postData: response.request().postData(), status: response.status(), body: await response.json() }); }
    catch { /* A missing/invalid response cannot satisfy the completeness gate. */ }
  };
  page.on?.('response', receive);
  return { capture, detach() { page.off?.('response', receive); } };
}

const norm = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
export function resolvePortalVertical(category, tree, mappings = {}) {
  const rows = [];
  const visit = value => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if (value.verticalName) rows.push(value);
      else Object.values(value).forEach(visit);
    }
  };
  visit(tree);
  const requested = category.replace(/^shopsy_/, '');
  if (mappings[category]) {
    if (!rows.some(row => row.verticalName === mappings[category])) throw new Error(`Mapped portal vertical is unavailable: ${category}.`);
    return mappings[category];
  }
  if (rows.some(row => row.verticalName === requested)) return requested;
  const matches = [...new Set(rows.filter(row => [row.verticalDisplayName, ...(row.synonyms || [])].some(value => norm(value) === norm(requested))).map(row => row.verticalName))];
  if (matches.length === 1) return matches[0];
  throw new Error(`Category mapping required for ${category}${matches.length ? ` (${matches.join(', ')})` : ''}. Nothing was staged.`);
}
