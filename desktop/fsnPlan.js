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
