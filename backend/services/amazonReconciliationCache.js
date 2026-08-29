// Short-lived process cache for the compact Amazon rollup read model. It avoids
// re-running the same report when React development mode, pagination, or a
// refresh button asks for identical data. Settlement/rate writes invalidate it.
const TTL_MS = 60_000;
const MAX_ENTRIES = 6;
const entries = new Map();

export function readAmazonReconciliationCache(key) {
  const entry = entries.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return null;
  }
  return entry.value;
}

export function cacheAmazonReconciliation(key, value) {
  if (entries.size >= MAX_ENTRIES && !entries.has(key)) {
    const oldest = entries.keys().next().value;
    if (oldest) entries.delete(oldest);
  }
  entries.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

export function invalidateAmazonReconciliationCache() {
  entries.clear();
}
