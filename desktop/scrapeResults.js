export function normalizeScrapedCards(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('No extracted rate cards to review.');
  const cards = new Map();
  for (const item of items) {
    if (!['flipkart', 'shopsy'].includes(item.marketplace) || !item.vertical) {
      throw new Error('Extraction contains an unsupported marketplace or missing vertical.');
    }
    if (!item.commissions?.length && !item.fixedFees?.length && !item.reverseShipping?.length) {
      throw new Error(`No recognized fee slabs for ${item.vertical}. Nothing was staged.`);
    }
    const key = `${item.marketplace}:${item.vertical}`;
    if (!cards.has(key)) {
      cards.set(key, {
        marketplace: item.marketplace, category: item.vertical, brand: 'General',
        source: item.marketplace === 'shopsy' ? 'shopsy_policy' : 'seller_portal',
        commissions: [], fixedFees: [], reverseShipping: []
      });
    }
    const card = cards.get(key);
    for (const field of ['commissions', 'fixedFees', 'reverseShipping']) {
      for (const slab of item[field] || []) {
        if (!card[field].some(existing => JSON.stringify(existing) === JSON.stringify(slab))) {
          card[field].push(slab);
        }
      }
    }
  }
  return [...cards.values()];
}
