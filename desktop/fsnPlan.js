// Discovery data comes from the authenticated backend's category and orders
// catalogs. Persisted defaults from older app versions are intentionally not
// accepted here: they can name categories that no longer have real FSN samples.
const CATEGORY_ALIASES = {
  saree: 'sari', sarees: 'sari',
  'ethnic set': 'ethnic_set', 'ethnic sets': 'ethnic_set',
  kurtas: 'kurta',
  tops: 'top', 't-shirt': 'top', tshirt: 'top',
  fabrics: 'fabric', dupattas: 'dupatta', shirts: 'shirt',
  dresses: 'dress', gowns: 'gown',
  'apparel set': 'apparel_set', 'apparel sets': 'apparel_set',
  'salwar kurta dupatta': 'salwar_kurta_dupatta',
  'salwar suit': 'salwar_kurta_dupatta', 'salwar suits': 'salwar_kurta_dupatta',
  'salwar kameez': 'salwar_kurta_dupatta', 'kurta set': 'salwar_kurta_dupatta',
  'kurta sets': 'salwar_kurta_dupatta',
};
const hasShopsyPrefix = value => /^shopsy(?:[_\s-]+)/i.test(String(value || '').trim());

export function normalizeScrapeVertical(value, marketplace = 'both') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const shopsyPrefixed = hasShopsyPrefix(raw);
  const suffix = shopsyPrefixed ? raw.replace(/^shopsy(?:[_\s-]+)+/, '') : raw;
  const canonical = CATEGORY_ALIASES[suffix] || suffix.replace(/[\s-]+/g, '_');
  if (!canonical) return '';
  return (shopsyPrefixed || String(marketplace || '').trim().toLowerCase() === 'shopsy')
    ? `shopsy_${canonical}`
    : canonical;
}

export function resolveScrapeVerticals({ requestedVerticals, configuredVerticals = [], brand = 'all', marketplace = 'both' } = {}) {
  const normalize = values => Array.isArray(values)
    ? [...new Set(values.map(value => normalizeScrapeVertical(value, marketplace)).filter(Boolean))]
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
    const isShopsy = itemMarketplace === 'shopsy' || hasShopsyPrefix(rawCategory);
    const channel = isShopsy ? 'shopsy' : itemMarketplace;
    if (!['flipkart', 'shopsy'].includes(channel)) continue;
    if (['flipkart', 'shopsy'].includes(selectedMarketplace) && selectedMarketplace !== channel) continue;
    if (selectedBrand !== 'all' && String(item?.brand || '').trim().toLowerCase() !== selectedBrand) continue;
    const category = normalizeScrapeVertical(rawCategory, channel);
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
    ? [...new Set(values.map(value => normalizeScrapeVertical(value, marketplace)).filter(Boolean))]
    : [];
  const requested = normalize(requestedVerticals);
  const configured = normalize(configuredVerticals);
  const available = catalogVerticals(catalog, { marketplace, brand });
  const explicit = requested.length > 0;
  const availableAcrossBrands = catalogVerticals(catalog, { marketplace, brand: 'all' });
  if (!configured.length) {
    throw new Error('No configured rate-card categories were returned. Extraction was not started.');
  }
  const unavailableRequestedVerticals = explicit
    ? requested.filter(category => !available.includes(category))
    : [];
  if (unavailableRequestedVerticals.length) {
    throw new Error(`Selected categories have no database FSNs for the selected marketplace and brand: ${unavailableRequestedVerticals.join(', ')}. Nothing was scraped.`);
  }
  const unconfiguredRequestedVerticals = explicit
    ? requested.filter(category => !configured.includes(category))
    : [];
  if (unconfiguredRequestedVerticals.length) {
    throw new Error(`Selected categories are not configured for rate-card extraction: ${unconfiguredRequestedVerticals.join(', ')}. Nothing was scraped.`);
  }
  const scopeVerticals = explicit ? requested : configured.filter(category => available.includes(category));
  if (!explicit && !scopeVerticals.length) {
    throw new Error('No configured rate-card category has a database FSN for the selected marketplace and brand. Extraction was not started.');
  }
  const requiredVerticals = explicit ? requested : scopeVerticals;
  const unavailableConfiguredVerticals = configured.filter(category => !availableAcrossBrands.includes(category));
  const uncoveredConfiguredVerticals = configured.filter(category => !scopeVerticals.includes(category));
  const incompleteByMarketplace = { flipkart: [], shopsy: [] };
  for (const category of unavailableConfiguredVerticals) {
    const channel = category.toLowerCase().startsWith('shopsy_') ? 'shopsy' : 'flipkart';
    incompleteByMarketplace[channel].push(category);
  }
  const uncoveredByMarketplace = { flipkart: [], shopsy: [] };
  for (const category of uncoveredConfiguredVerticals) {
    const channel = category.toLowerCase().startsWith('shopsy_') ? 'shopsy' : 'flipkart';
    uncoveredByMarketplace[channel].push(category);
  }
  return {
    scopeVerticals,
    requiredVerticals,
    configuredVerticals: configured,
    availableVerticals: available,
    unavailableConfiguredVerticals,
    uncoveredConfiguredVerticals,
    incompleteByMarketplace,
    uncoveredByMarketplace,
    complete: unavailableConfiguredVerticals.length === 0 && uncoveredConfiguredVerticals.length === 0
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

export function uncoveredCategoriesForMarketplace(coverage, marketplace) {
  const target = String(marketplace || '').trim().toLowerCase();
  const byMarketplace = coverage?.uncoveredByMarketplace;
  if (target === 'flipkart' || target === 'shopsy') {
    return Array.isArray(byMarketplace?.[target]) ? byMarketplace[target] : [];
  }
  if (!byMarketplace || typeof byMarketplace !== 'object') return [];
  return [...new Set(['flipkart', 'shopsy'].flatMap(channel =>
    Array.isArray(byMarketplace[channel]) ? byMarketplace[channel] : []
  ))];
}

export function describeCoverageBlockers(coverage, marketplace) {
  const missingFsns = missingFsnCategoriesForMarketplace(coverage, marketplace);
  const uncovered = uncoveredCategoriesForMarketplace(coverage, marketplace)
    .filter(category => !missingFsns.includes(category));
  const blockers = [];
  if (missingFsns.length) blockers.push(`categories without database FSNs: ${missingFsns.join(', ')}`);
  if (uncovered.length) blockers.push(`configured categories omitted from this extraction: ${uncovered.join(', ')}`);
  return blockers.join('; ') || 'configured category coverage is incomplete';
}

export function hasKnownMarketplaceFsnCoverage(coverage, marketplace) {
  const target = String(marketplace || '').trim().toLowerCase();
  if (!['flipkart', 'shopsy'].includes(target)) return false;
  return Array.isArray(coverage?.configuredVerticals) && coverage.configuredVerticals.length > 0 &&
    Array.isArray(coverage?.scopeVerticals) &&
    Array.isArray(coverage?.incompleteByMarketplace?.[target]) &&
    Array.isArray(coverage?.uncoveredByMarketplace?.[target]) &&
    typeof coverage.complete === 'boolean';
}

export function buildFsnPlan(catalog, { marketplace = 'both', brand = 'all', verticals, requiredVerticals } = {}) {
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('No database FSNs are available for extraction.');
  const normalizeList = values => Array.isArray(values)
    ? [...new Set(values.map(value => normalizeScrapeVertical(value, marketplace)).filter(Boolean))]
    : values;
  const normalizedVerticals = normalizeList(verticals);
  const required = requiredVerticals == null
    ? (brand && brand !== 'all' ? [] : normalizedVerticals)
    : normalizeList(requiredVerticals);
  const targets = new Map();
  for (const item of catalog) {
    const itemMarketplace = String(item.marketplace || '').trim().toLowerCase();
    const channel = itemMarketplace === 'shopsy' || hasShopsyPrefix(item.category)
      ? 'shopsy' : itemMarketplace;
    const category = normalizeScrapeVertical(item.category, channel);
    if (!['flipkart','shopsy'].includes(channel)) continue;
    if (['flipkart','shopsy'].includes(marketplace) && channel !== marketplace) continue;
    if (brand && brand !== 'all' && item.brand?.toLowerCase() !== brand.toLowerCase()) continue;
    if (normalizedVerticals?.length && !normalizedVerticals.includes(category)) continue;
    if (!category || !item.brand || !/^[A-Z0-9]{16}$/.test(item.sample_fsn || '')) throw new Error('Catalog has a missing or invalid real FSN, brand or category. Nothing was staged.');
    const key = JSON.stringify([channel,category,item.brand.toLowerCase()]);
    if (!targets.has(key)) targets.set(key, {...item,category,marketplace:channel});
  }
  const missing = (required || []).filter(category => ![...targets.values()].some(t=>t.category === category));
  if (missing.length) throw new Error(`No database FSN for configured categories: ${missing.join(', ')}. Nothing was staged.`);
  if (!targets.size) throw new Error('No database FSNs match the selected marketplace and brand.');
  return [...targets.values()];
}
