// Discovery data comes from the authenticated backend's category and orders
// catalogs. Persisted defaults from older app versions are intentionally not
// accepted here: they can name categories that no longer have real FSN samples.
export function resolveScrapeVerticals({ requestedVerticals, configuredVerticals = [], brand = 'all' } = {}) {
  const normalize = values => Array.isArray(values)
    ? [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
    : [];
  const requested = normalize(requestedVerticals);
  const configured = normalize(configuredVerticals);
  const hasExplicitVerticals = requested.length > 0;
  const scopeVerticals = hasExplicitVerticals ? requested : configured;
  return {
    scopeVerticals,
    requiredVerticals: hasExplicitVerticals ? requested : (brand && brand !== 'all' ? [] : scopeVerticals)
  };
}

function catalogVerticals(catalog, { marketplace = 'both', brand = 'all' } = {}) {
  if (!Array.isArray(catalog)) return [];
  const selectedMarketplace = String(marketplace || 'both').trim().toLowerCase();
  const selectedBrand = String(brand || 'all').trim().toLowerCase();
  const available = new Set();
  for (const item of catalog) {
    const rawCategory = String(item?.category || '').trim();
    const itemMarketplace = String(item?.marketplace || '').trim().toLowerCase();
    const isShopsy = itemMarketplace === 'shopsy' || rawCategory.toLowerCase().startsWith('shopsy_');
    const channel = isShopsy ? 'shopsy' : itemMarketplace;
    if (!['flipkart', 'shopsy'].includes(channel)) continue;
    if (['flipkart', 'shopsy'].includes(selectedMarketplace) && selectedMarketplace !== channel) continue;
    if (selectedBrand !== 'all' && String(item?.brand || '').trim().toLowerCase() !== selectedBrand) continue;
    const category = isShopsy && !rawCategory.toLowerCase().startsWith('shopsy_')
      ? `shopsy_${rawCategory}`
      : rawCategory;
    if (category) available.add(category);
  }
  return [...available];
}

/**
 * Resolve the extraction scope against categories that have real database FSNs.
 * Unselected categories from the rate-card tables are reported as unavailable;
 * they are never represented by fabricated sample FSNs. Explicit category
 * selections remain strict and are validated by buildFsnPlan before browsing.
 */
export function resolveFsnBackedScrapeVerticals({
  requestedVerticals,
  configuredVerticals = [],
  catalog,
  marketplace = 'both',
  brand = 'all'
} = {}) {
  const normalize = values => Array.isArray(values)
    ? [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
    : [];
  const requested = normalize(requestedVerticals);
  const configured = normalize(configuredVerticals);
  const available = catalogVerticals(catalog, { marketplace, brand });
  const explicit = requested.length > 0;
  if (!explicit && !configured.length) {
    throw new Error('No configured rate-card categories were returned. Extraction was not started.');
  }
  const scopeVerticals = explicit ? requested : configured.filter(category => available.includes(category));
  if (!explicit && !scopeVerticals.length) {
    throw new Error('No configured rate-card category has a database FSN for the selected marketplace and brand. Extraction was not started.');
  }
  const requiredVerticals = explicit ? requested : scopeVerticals;
  const unavailableConfiguredVerticals = explicit || (brand && brand !== 'all')
    ? []
    : configured.filter(category => !available.includes(category));
  const incompleteByMarketplace = { flipkart: [], shopsy: [] };
  for (const category of unavailableConfiguredVerticals) {
    const channel = category.toLowerCase().startsWith('shopsy_') ? 'shopsy' : 'flipkart';
    incompleteByMarketplace[channel].push(category);
  }
  return {
    scopeVerticals,
    requiredVerticals,
    configuredVerticals: configured,
    availableVerticals: available,
    unavailableConfiguredVerticals,
    incompleteByMarketplace,
    complete: unavailableConfiguredVerticals.length === 0
  };
}

export function missingFsnCategoriesForMarketplace(coverage, marketplace) {
  const target = String(marketplace || '').trim().toLowerCase();
  const byMarketplace = coverage?.incompleteByMarketplace;
  if (target === 'flipkart' || target === 'shopsy') {
    return Array.isArray(byMarketplace?.[target]) ? byMarketplace[target] : [];
  }
  if (!byMarketplace || typeof byMarketplace !== 'object') return [];
  return [...new Set(['flipkart', 'shopsy'].flatMap(channel =>
    Array.isArray(byMarketplace[channel]) ? byMarketplace[channel] : []
  ))];
}

export function buildFsnPlan(catalog, { marketplace = 'both', brand = 'all', verticals, requiredVerticals } = {}) {
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('No database FSNs are available for extraction.');
  const required = requiredVerticals ?? (brand && brand !== 'all' ? [] : verticals);
  const targets = new Map();
  for (const item of catalog) {
    const channel = item.marketplace === 'shopsy' || item.category?.startsWith('shopsy_') ? 'shopsy' : item.marketplace;
    const category = channel === 'shopsy' && !item.category?.startsWith('shopsy_')
      ? `shopsy_${item.category}`
      : item.category;
    if (!['flipkart','shopsy'].includes(channel)) continue;
    if (['flipkart','shopsy'].includes(marketplace) && channel !== marketplace) continue;
    if (brand && brand !== 'all' && item.brand?.toLowerCase() !== brand.toLowerCase()) continue;
    if (verticals?.length && !verticals.includes(category)) continue;
    if (!category || !item.brand || !/^[A-Z0-9]{16}$/.test(item.sample_fsn || '')) throw new Error('Catalog has a missing or invalid real FSN, brand or category. Nothing was staged.');
    const key = JSON.stringify([channel,category,item.brand.toLowerCase()]);
    if (!targets.has(key)) targets.set(key, {...item,category,marketplace:channel});
  }
  const missing = (required || []).filter(category => ![...targets.values()].some(t=>t.category === category));
  if (missing.length) throw new Error(`No database FSN for configured categories: ${missing.join(', ')}. Nothing was staged.`);
  if (!targets.size) throw new Error('No database FSNs match the selected marketplace and brand.');
  return [...targets.values()];
}
