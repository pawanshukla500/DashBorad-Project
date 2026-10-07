import express from 'express';
import multer from 'multer';
import { createRequire } from 'node:module';
import { getPool, isDbConfigured } from '../db/index.js';
import { parseSpreadsheet } from '../services/spreadsheetWorker.js';
import {
  SOR_DEFAULT_ACCOUNTS,
  SOR_STREAMS,
  applySorUpload,
  parseSorUploadRows,
  sorTemplateAliases,
  sorTemplateHeaders,
} from '../services/sorUpload.js';
import { sanitizeUploadFileName, spreadsheetFileFilter } from '../utils/uploadSecurity.js';

const XLSX = createRequire(import.meta.url)('xlsx');
const router = express.Router();

// One spreadsheet per request, parsed on a worker thread. 20 MB covers a
// year of invoice lines for one portal; larger files are refused before they
// reach the parser.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 5, parts: 8 },
  fileFilter: spreadsheetFileFilter,
});
const SHEET_OPTIONS = { read: { cellDates: true }, sheets: 0, json: { defval: '' }, transfer: true };
const PORTALS = new Set(Object.keys(SOR_DEFAULT_ACCOUNTS));
const ACCOUNT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_SKIPPED_IN_RESPONSE = 200;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// AJIO invoices are imported through the AJIO mp_invoices importer, which
// also feeds the marketplace reports; the SOR ledger mirrors them from there.
function assertStreamAllowed(portal, stream) {
  if (!PORTALS.has(portal)) return { status: 404, error: 'Unknown SOR portal' };
  if (!SOR_STREAMS[stream]) return { status: 404, error: 'Unknown SOR upload stream' };
  if (portal === 'reliance-ajio' && stream === 'invoice') {
    return { status: 400, error: 'AJIO invoices are uploaded through the AJIO invoice importer; the SOR ledger updates from it automatically.' };
  }
  return null;
}

function resolveAccount(portal, value) {
  const account = String(value ?? '').trim() || SOR_DEFAULT_ACCOUNTS[portal];
  if (!ACCOUNT_PATTERN.test(account)) throw badRequest('account may only contain letters, digits, dot, dash and underscore');
  return account;
}

/**
 * POST /api/sor/:portal/upload/:stream   (operator / admin)
 * multipart: file (xlsx / xls / csv), optional account
 */
// Refuse an unknown portal / stream before multer buffers the file.
function checkStream(req, res, next) {
  const denied = assertStreamAllowed(req.params.portal, req.params.stream);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  return next();
}

router.post('/:portal/upload/:stream', checkStream, upload.single('file'), async (req, res) => {
  const { portal, stream } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });

  const filename = sanitizeUploadFileName(req.file.originalname);
  const uploadedBy = req.user?.email || null;
  let account = SOR_DEFAULT_ACCOUNTS[portal];
  const pool = getPool();
  try {
    account = resolveAccount(portal, req.body?.account);
    const workbook = await parseSpreadsheet(req.file.buffer, SHEET_OPTIONS);
    const rows = workbook.Sheets[workbook.SheetNames[0]] ?? [];
    const parsed = parseSorUploadRows(stream, rows);
    const applied = await applySorUpload(pool, { portal, account, stream, records: parsed.records, uploadedBy });
    const skipped = [...parsed.skipped, ...applied.skipped].sort((a, b) => a.rowNum - b.rowNum);
    if (applied.errors.length) console.warn(`[sorUpload] ${portal}/${stream}:`, applied.errors.slice(0, 5));
    const saved = applied.inserted + applied.updated + applied.removed;
    const status = saved === 0 ? 'error' : skipped.length ? 'partial' : 'ok';
    await logSorUpload(pool, {
      portal, account, filename, uploadedBy, status,
      inserted: applied.inserted, updated: applied.updated, skipped: skipped.length,
      remark: SOR_STREAMS[stream].label,
      error: status === 'error' ? (skipped[0]?.reason || 'No rows were saved') : null,
    }).catch(error => console.warn('[sorUpload] audit log write failed:', error.message));
    res.json({
      ok: saved > 0,
      portal,
      account,
      stream,
      rows: rows.length,
      invoices: applied.invoices,
      inserted: applied.inserted,
      updated: applied.updated,
      removed: applied.removed,
      skipped: skipped.length,
      skippedRows: skipped.slice(0, MAX_SKIPPED_IN_RESPONSE),
    });
  } catch (err) {
    // 400 (our validation) and 413 (spreadsheet too large for the parser)
    // carry messages meant for the user; anything else is generic.
    const status = [400, 413].includes(err.status) ? err.status : 500;
    const message = status !== 500 ? err.message : 'The upload could not be processed. Please retry.';
    if (status === 500) console.error(`[sorUpload] ${portal}/${stream} failed:`, err.message);
    await logSorUpload(pool, {
      portal, account, filename, uploadedBy, status: 'error', inserted: 0, updated: 0, skipped: 0,
      remark: SOR_STREAMS[stream].label, error: message,
    }).catch(() => {});
    res.status(status).json({ error: message });
  }
});

/**
 * GET /api/sor/:portal/template/:stream — XLSX template: the upload sheet
 * (template headers + sample rows) and the accepted column names.
 */
router.get('/:portal/template/:stream', (req, res) => {
  const { portal, stream } = req.params;
  const denied = assertStreamAllowed(portal, stream);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  const config = SOR_STREAMS[stream];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([sorTemplateHeaders(stream), ...config.sample]);
  sheet['!cols'] = sorTemplateHeaders(stream).map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(workbook, sheet, config.label.slice(0, 31));
  const required = new Set(config.required.map(column => sorTemplateHeaders(stream)[config.columns.indexOf(column)]));
  const help = XLSX.utils.aoa_to_sheet([
    ['Column', 'Required', 'Also accepted as'],
    ...sorTemplateAliases(stream).map(([header, aliases]) => [header, required.has(header) ? 'Yes' : '', aliases]),
    [],
    ['Dates: YYYY-MM-DD, DD-MM-YYYY or Excel dates. Amounts: plain numbers (₹, commas allowed); a negative amount reverses.'],
    ['Re-uploading a file updates the same lines instead of adding them twice.'],
  ]);
  help['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(workbook, help, 'Column names');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="SOR_${portal}_${stream}_template.xlsx"`);
  res.send(buffer);
});

// sor_upload_log mirrors into upload_log (trigger), so SOR uploads appear in
// Audit History next to the marketplace uploads.
async function logSorUpload(pool, entry) {
  await pool.query(
    `INSERT INTO sor_upload_log
       (portal, portal_account, filename, rows_inserted, rows_updated, rows_skipped, status, error_msg, remark, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [entry.portal, entry.account, entry.filename, entry.inserted, entry.updated, entry.skipped,
      entry.status, entry.error, entry.remark, entry.uploadedBy],
  );
}

export default router;
