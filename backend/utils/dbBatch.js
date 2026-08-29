export const UPLOAD_BATCH_SIZE = 5000;

// PostgreSQL accepts at most 65,535 bind parameters. Leave headroom for
// route-specific parameters while still using the requested target.
export const QUERY_PARAMETER_BUDGET = 60000;

export function safeBatchSize(columnCount, preferredSize = UPLOAD_BATCH_SIZE) {
  const columns = Math.max(1, Number.parseInt(columnCount, 10) || 1);
  const preferred = Math.max(1, Number.parseInt(preferredSize, 10) || UPLOAD_BATCH_SIZE);
  return Math.max(1, Math.min(preferred, Math.floor(QUERY_PARAMETER_BUDGET / columns)));
}

export async function forEachDbBatch(rows, columnCount, handler, options = {}) {
  const batchSize = safeBatchSize(columnCount, options.preferredSize);
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    await handler(batch, {
      batchSize,
      batchNumber: Math.floor(start / batchSize) + 1,
      batchCount: Math.ceil(rows.length / batchSize),
      start,
    });
    if (options.yieldBetween !== false && start + batchSize < rows.length) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return batchSize;
}
