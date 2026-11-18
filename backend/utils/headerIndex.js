// Normalized-header lookup for spreadsheet row objects.
//
// Upload parsers read each row by several header aliases ("Order Line ID",
// "order_line_id", ...). Re-normalizing every column of every row for every
// alias blocked the event loop for minutes on 100K-row files, and keeping a
// separate index Map per row (to avoid that) cost ~180 MB per 100K rows, enough
// to exhaust the 768 MB heap on large Myntra files.
//
// Rows parsed from one sheet share the same column set, so an index is built
// once per distinct column signature and shared by every row that has it. Each
// row only holds a WeakMap entry pointing at the shared index.
//
// The index keeps the FIRST column (in object key order) for each normalized
// name, exactly like `Object.keys(row).find(...)` did.

const MAX_SIGNATURES = 256;
const MAX_MEMOIZED_HEADERS = 10_000;

export function createHeaderIndex(normalize) {
  const normalizedHeaders = new Map();
  const indexesBySignature = new Map();
  const rowIndexes = new WeakMap();

  function key(text) {
    const raw = String(text ?? '');
    let normalized = normalizedHeaders.get(raw);
    if (normalized === undefined) {
      normalized = normalize(raw);
      if (normalizedHeaders.size < MAX_MEMOIZED_HEADERS) normalizedHeaders.set(raw, normalized);
    }
    return normalized;
  }

  function indexFor(row) {
    let index = rowIndexes.get(row);
    if (index) return index;
    const columns = Object.keys(row);
    const signature = columns.join('\u0000');
    index = indexesBySignature.get(signature);
    if (!index) {
      index = new Map();
      for (const column of columns) {
        const normalized = key(column);
        if (!index.has(normalized)) index.set(normalized, column);
      }
      if (indexesBySignature.size >= MAX_SIGNATURES) {
        indexesBySignature.delete(indexesBySignature.keys().next().value);
      }
      indexesBySignature.set(signature, index);
    }
    rowIndexes.set(row, index);
    return index;
  }

  /** The row's own column name whose normalized form equals `name`'s, or undefined. */
  function column(row, name) {
    if (!row || typeof row !== 'object') return undefined;
    return indexFor(row).get(key(name));
  }

  return { key, indexFor, column };
}
