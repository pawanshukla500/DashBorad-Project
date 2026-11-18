// Text uploads (CSV, HTML-table ".xls") are read with SheetJS `raw: true`
// since the data-optimization hardening. Before, SheetJS guessed types in their
// text: '000123' became 123, 18+ digit IDs became rounded numbers, '05/04/2026'
// became a 4 May date. Rows imported then were keyed (source fingerprints, SOR
// invoice numbers) from those guessed values, so re-uploading the same file
// with exact text would add a second copy instead of updating the first.
// Re-reading a text file the old way gives each row's legacy key, so the
// re-upload can adopt the legacy row.
import { parseSpreadsheet } from '../services/spreadsheetWorker.js';

/** True for text spreadsheets (not an XLSX zip or an OLE2 .xls). */
export function isTextSpreadsheet(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const zip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const ole = buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
  return !zip && !ole;
}

/**
 * The first sheet's rows as the pre-hardening parse produced them (the same
 * options without `raw: true`), or null for binary workbooks, whose cells were
 * never type-guessed. Reads a copy, so `buffer` stays usable.
 */
export async function readLegacyTextRows(buffer, options) {
  if (!isTextSpreadsheet(buffer)) return null;
  const { raw, ...legacyRead } = options.read || {};
  const workbook = await parseSpreadsheet(Buffer.from(buffer), { ...options, read: legacyRead, transfer: true });
  return workbook.Sheets[workbook.SheetNames[0]] ?? [];
}

/**
 * Re-key legacy rows to their current fingerprint before the upsert. `pairs`
 * are [legacyFingerprint, currentFingerprint]. A legacy row whose current twin
 * already exists (an earlier re-upload inserted it) is a duplicate and is
 * removed; the upsert then writes the current values onto the adopted row.
 */
export async function adoptLegacyFingerprints(queryable, table, pairs) {
  const byLegacy = new Map();
  for (const [legacy, current] of pairs) {
    if (legacy && current && legacy !== current && !byLegacy.has(legacy)) byLegacy.set(legacy, current);
  }
  if (!byLegacy.size) return { adopted: 0, duplicatesRemoved: 0 };
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Invalid table name: ${table}`);
  const legacy = [...byLegacy.keys()];
  const current = [...byLegacy.values()];
  const removed = await queryable.query(`
    DELETE FROM ${table} t
    USING unnest($1::text[], $2::text[]) AS p(legacy, current)
    WHERE t.source_fingerprint = p.legacy
      AND EXISTS (SELECT 1 FROM ${table} n WHERE n.source_fingerprint = p.current)
  `, [legacy, current]);
  const adopted = await queryable.query(`
    UPDATE ${table} t
    SET source_fingerprint = p.current
    FROM unnest($1::text[], $2::text[]) AS p(legacy, current)
    WHERE t.source_fingerprint = p.legacy
  `, [legacy, current]);
  return { adopted: adopted.rowCount || 0, duplicatesRemoved: removed.rowCount || 0 };
}
