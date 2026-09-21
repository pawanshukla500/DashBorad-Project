import express from 'express';
import multer from 'multer';
import { createRequire } from 'module';
import { getPool, isDbConfigured } from '../db/index.js';
import { forEachDbBatch } from '../utils/dbBatch.js';
import { logUpload, saveSkippedRows } from '../services/uploadLog.js';
import { parseSpreadsheet } from '../services/spreadsheetWorker.js';
import { pagination } from '../utils/requestParams.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 5, parts: 10 },
});

const router = express.Router();

const PHYSICAL_CONDITIONS = new Map([
  ['good', 'Good'],
  ['bad', 'Bad'],
  ['damaged', 'Damaged'],
  ['not received', 'Not Received'],
  ['notreceived', 'Not Received'],
  ['unknown', 'Unknown'],
]);

const SPF_STATUSES = new Map([
  ['not applicable', 'Not Applicable'],
  ['notapplicable', 'Not Applicable'],
  ['applicable', 'Applicable'],
  ['claimed', 'Claimed'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['pending', 'Pending'],
]);

function hasValue(value) {
  return value != null && String(value).trim() !== '';
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function canonicalMarketplace(value) {
  const marketplace = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,49}$/.test(marketplace) ? marketplace : null;
}

function canonicalChoice(value, choices, label) {
  if (!hasValue(value)) return { value: null };
  const normalized = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const canonical = choices.get(normalized) || choices.get(normalized.replace(/\s/g, ''));
  return canonical ? { value: canonical } : { error: `invalid ${label}: ${value}` };
}

function aliasIndex(headerRow, names) {
  const normalizedNames = new Set(names.map(name => name.toLowerCase().replace(/[\s_-]+/g, '')));
  return headerRow.findIndex(header => normalizedNames.has(String(header || '').trim().toLowerCase().replace(/[\s_-]+/g, '')));
}

export function parseReturnTrackingRow({
  orderItemId,
  marketplace,
  physicalCondition,
  spfStatus,
  remarks,
}) {
  const normalizedMarketplace = canonicalMarketplace(marketplace);
  if (!normalizedMarketplace) return { error: 'invalid marketplace' };
  const item = String(orderItemId ?? '').trim();
  if (!item) return { error: 'order item ID is required' };
  if (item.length > 250) return { error: 'order item ID is too long' };
  const condition = canonicalChoice(physicalCondition, PHYSICAL_CONDITIONS, 'physical condition');
  if (condition.error) return condition;
  const status = canonicalChoice(spfStatus, SPF_STATUSES, 'SPF status');
  if (status.error) return status;
  const note = hasValue(remarks) ? String(remarks).trim() : null;
  if (note?.length > 4000) return { error: 'remarks must be 4000 characters or fewer' };
  if (!condition.value && !status.value && !note) {
    return { error: 'provide a physical condition, SPF status, or remarks' };
  }
  return {
    values: [item, normalizedMarketplace, condition.value, status.value, note],
  };
}

// GET /api/returns/tracking
// Fetches all orders that have a return, joined with return_tracking and fk_spf_claims.
router.get('/tracking', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ success: false, error: 'DB not configured' });
  const pool = getPool();
  try {
    const marketplace = canonicalMarketplace(req.query.marketplace || 'flipkart');
    if (!marketplace) return res.status(400).json({ success: false, error: 'Invalid marketplace' });
    // `limit` is the established public parameter for this legacy endpoint.
    // Normalize it through the shared strict page-size parser.
    const { page, pageSize, offset } = pagination(
      { page: req.query.page, pageSize: req.query.limit },
      { defaultPageSize: 50, maxPageSize: 200 },
    );

    // Fetch returns joined with orders, tracking, and SPF.
    const query = `
      SELECT 
        o.order_id,
        o.order_item_id,
        o.order_date,
        o.sku,
        r.return_id,
        r.return_status as marketplace_return_status,
        r.primary_pv_output,
        rt.physical_condition,
        rt.spf_status as manual_spf_status,
        spf.claim_id,
        spf.status as spf_claim_status,
        spf.settlement_value as spf_amount
      FROM returns r
      JOIN orders o ON o.order_item_id = r.order_item_id
      LEFT JOIN return_tracking rt ON rt.order_item_id = r.order_item_id AND rt.marketplace = $1
      LEFT JOIN fk_spf_claims spf ON spf.order_item_id = r.order_item_id
      WHERE r.marketplace = $1
      ORDER BY o.order_date DESC NULLS LAST
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `SELECT COUNT(*) as total FROM returns WHERE marketplace = $1`;
    
    const [dataRes, countRes] = await Promise.all([
      pool.query(query, [marketplace, pageSize, offset]),
      pool.query(countQuery, [marketplace])
    ]);

    res.json({
      success: true,
      data: dataRes.rows,
      total: Number(countRes.rows[0].total),
      page,
      limit: pageSize
    });
  } catch (error) {
    console.error('[returnTracking GET] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch return tracking data' });
  }
});

// POST /api/returns/tracking
// Upserts the manual tracking input
router.post('/tracking', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ success: false, error: 'DB not configured' });
  const pool = getPool();
  try {
    const parsed = parseReturnTrackingRow({
      orderItemId: req.body.order_item_id,
      marketplace: req.body.marketplace || 'flipkart',
      physicalCondition: req.body.physical_condition,
      spfStatus: req.body.spf_status,
      remarks: req.body.remarks,
    });
    if (parsed.error) throw inputError(parsed.error);
    const [orderItemId, marketplace, physicalCondition, spfStatus, remarks] = parsed.values;

    const query = `
      INSERT INTO return_tracking (order_item_id, marketplace, physical_condition, spf_status, remarks, updated_at)
      SELECT $1, $2, $3, $4, $5, NOW()
      WHERE EXISTS (
        SELECT 1 FROM returns WHERE marketplace = $2 AND order_item_id = $1
      )
      ON CONFLICT (order_item_id, marketplace) 
      DO UPDATE SET 
        physical_condition = COALESCE(EXCLUDED.physical_condition, return_tracking.physical_condition),
        spf_status = COALESCE(EXCLUDED.spf_status, return_tracking.spf_status),
        remarks = COALESCE(EXCLUDED.remarks, return_tracking.remarks),
        updated_at = NOW()
      RETURNING *
    `;

    const { rows } = await pool.query(query, [orderItemId, marketplace, physicalCondition, spfStatus, remarks]);
    if (!rows[0]) return res.status(404).json({ success: false, error: 'No matching marketplace return found for this order item ID' });
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('[returnTracking POST] Error:', error);
    res.status(error.status || 500).json({ success: false, error: error.status ? error.message : 'Failed to update return tracking' });
  }
});

// GET /api/returns/tracking/download
// Downloads the tracking data as an Excel file
router.get('/tracking/download', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ success: false, error: 'DB not configured' });
  const pool = getPool();
  try {
    const marketplace = canonicalMarketplace(req.query.marketplace || 'flipkart');
    if (!marketplace) return res.status(400).json({ success: false, error: 'Invalid marketplace' });

    const query = `
      SELECT 
        o.order_id,
        o.order_item_id,
        o.order_date,
        o.sku,
        r.return_status as marketplace_return_status,
        r.primary_pv_output,
        rt.physical_condition,
        rt.spf_status as manual_spf_status,
        spf.status as spf_claim_status,
        spf.settlement_value as spf_amount
      FROM returns r
      JOIN orders o ON o.order_item_id = r.order_item_id
      LEFT JOIN return_tracking rt ON rt.order_item_id = r.order_item_id AND rt.marketplace = $1
      LEFT JOIN fk_spf_claims spf ON spf.order_item_id = r.order_item_id
      WHERE r.marketplace = $1
      ORDER BY o.order_date DESC NULLS LAST
    `;

    const { rows } = await pool.query(query, [marketplace]);

    const headers = [
      'Order ID', 'Order Item ID', 'SKU', 'Order Date', 
      'MP Return Status', 'MP Condition', 
      'Received Condition (Good/Bad)', 'Manual SPF Status (Not Applicable/Applicable/Claimed/Approved/Rejected/Pending)', 
      'System SPF Status', 'SPF Claim Amt'
    ];

    const dataRows = rows.map(r => [
      r.order_id || '',
      r.order_item_id || '',
      r.sku || '',
      r.order_date ? new Date(r.order_date).toLocaleDateString('en-GB') : '',
      r.marketplace_return_status || '',
      r.primary_pv_output || '',
      r.physical_condition || '',
      r.manual_spf_status || '',
      r.spf_claim_status || '',
      r.spf_amount || ''
    ]);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Return Tracking');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="return-tracking-${marketplace}-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (error) {
    console.error('[returnTracking download] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to download return tracking data' });
  }
});

// POST /api/returns/tracking/upload
// Bulk uploads return tracking data
router.post('/tracking/upload', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ success: false, error: 'DB not configured' });
  const pool = getPool();
  let updated = 0;
  let inserted = 0;
  let skipped = 0;
  let skippedRows = [];
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const marketplace = canonicalMarketplace(req.query.marketplace || 'flipkart');
    if (!marketplace) throw inputError('Invalid marketplace');

    const wb = await parseSpreadsheet(req.file.buffer, { sheets: 0, json: { header: 1, defval: '' }, transfer: true });
    const rows = wb.Sheets[wb.SheetNames[0]] ?? [];
    if (rows.length < 2) throw inputError('The workbook has headers but no data rows. No data was saved.');

    // Find column indexes based on header row (row 0)
    const headerRow = rows[0] || [];
    const orderItemIdx = aliasIndex(headerRow, ['order item id', 'order_item_id', 'orderitemid']);
    const conditionIdx = aliasIndex(headerRow, ['received condition (good/bad)', 'received condition', 'physical condition', 'physical_condition']);
    const spfIdx = aliasIndex(headerRow, ['manual spf status (not applicable/applicable/claimed/approved/rejected/pending)', 'manual spf status', 'spf status', 'spf_status']);
    const remarksIdx = aliasIndex(headerRow, ['remarks', 'remark', 'notes', 'note']);

    if (orderItemIdx === -1) {
      throw inputError('Missing Order Item ID column in Excel file.');
    }

    const recordsByKey = new Map();
    for (let index = 1; index < rows.length; index++) {
      const row = rows[index];
      if (!row.some(hasValue)) continue;
      const parsed = parseReturnTrackingRow({
        orderItemId: row[orderItemIdx],
        marketplace,
        physicalCondition: conditionIdx === -1 ? null : row[conditionIdx],
        spfStatus: spfIdx === -1 ? null : row[spfIdx],
        remarks: remarksIdx === -1 ? null : row[remarksIdx],
      });
      if (parsed.error) {
        skipped++;
        skippedRows.push({ rowNum: index + 1, reason: parsed.error, data: Object.fromEntries(headerRow.map((header, column) => [header || `Column ${column + 1}`, row[column] ?? ''])) });
        continue;
      }
      const key = `${parsed.values[1]}\u001f${parsed.values[0]}`;
      if (recordsByKey.has(key)) {
        skipped++;
        skippedRows.push({ rowNum: index + 1, reason: 'duplicate order item within this file', data: Object.fromEntries(headerRow.map((header, column) => [header || `Column ${column + 1}`, row[column] ?? ''])) });
        continue;
      }
      recordsByKey.set(key, { rowNum: index + 1, values: parsed.values });
    }

    const records = [...recordsByKey.values()];
    if (!records.length) throw inputError('No valid return-tracking rows were found. Review the skipped-row reasons and correct the file before retrying.');
    await forEachDbBatch(records, 5, async batch => {
      const values = [];
      const groups = batch.map(({ values: record }) => {
        const start = values.length;
        values.push(...record);
        return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}, $${start + 5})`;
      });
      const result = await pool.query(`
        WITH incoming (order_item_id, marketplace, physical_condition, spf_status, remarks) AS (
          VALUES ${groups.join(', ')}
        )
        INSERT INTO return_tracking (order_item_id, marketplace, physical_condition, spf_status, remarks, updated_at)
        SELECT incoming.order_item_id, incoming.marketplace, incoming.physical_condition, incoming.spf_status, incoming.remarks, NOW()
        FROM incoming
        WHERE EXISTS (
          SELECT 1 FROM returns
          WHERE returns.marketplace = incoming.marketplace
            AND returns.order_item_id = incoming.order_item_id
        )
        ON CONFLICT (order_item_id, marketplace)
        DO UPDATE SET
          physical_condition = COALESCE(EXCLUDED.physical_condition, return_tracking.physical_condition),
          spf_status = COALESCE(EXCLUDED.spf_status, return_tracking.spf_status),
          remarks = COALESCE(EXCLUDED.remarks, return_tracking.remarks),
          updated_at = NOW()
        RETURNING order_item_id, marketplace, (xmax = 0) AS inserted
      `, values);
      const persisted = new Set(result.rows.map(record => `${record.marketplace}\u001f${record.order_item_id}`));
      for (const record of result.rows) {
        if (record.inserted) inserted++;
        else updated++;
      }
      for (const record of batch) {
        const key = `${record.values[1]}\u001f${record.values[0]}`;
        if (!persisted.has(key)) {
          skipped++;
          skippedRows.push({ rowNum: record.rowNum, reason: 'no matching marketplace return found for this order item ID', data: { order_item_id: record.values[0], marketplace: record.values[1] } });
        }
      }
    });

    const logId = await logUpload(pool, 'return_tracking', req.file.originalname, marketplace, inserted, updated, skipped, 'ok');
    await saveSkippedRows(pool, logId, skippedRows);
    res.json({ success: true, marketplace, inserted, updated, skipped, total: rows.length - 1, logId });
  } catch (error) {
    console.error('[returnTracking upload] Error:', error);
    const marketplace = canonicalMarketplace(req.query.marketplace || 'flipkart') || 'flipkart';
    const logId = await logUpload(pool, 'return_tracking', req.file?.originalname || 'unknown', marketplace, inserted, updated, skipped, 'error', error.message);
    await saveSkippedRows(pool, logId, skippedRows).catch(() => {});
    res.status(error.status || 500).json({ success: false, error: error.status ? error.message : 'Failed to process uploaded file.' });
  }
});

export default router;
