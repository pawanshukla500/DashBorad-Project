/**
 * Rate Card routes — config CRUD, versioning, categories, and legacy endpoints.
 *
 * Tables used:
 *   rc_commission, rc_fixed_fee, rc_collection_fee, rc_pick_pack,
 *   rc_reverse_shipping, rc_franchise_fee, rate_card_versions
 */
import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getPool, isDbConfigured } from '../db/index.js';
import { normalizeCategory } from '../services/rateCard.js';
import { scrapeRateCard } from '../services/rateCardScraper.js';
import { clearRateCardCache } from '../services/rateCard.js';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { optionalNumber } from '../utils/valueParsers.js';
import { forEachDbBatch } from '../utils/dbBatch.js';

const router = express.Router();

// ── Table mapping ────────────────────────────────────────────────────────────
const TABLE_MAP = {
  commission:      'rc_commission',
  fixed_fee:       'rc_fixed_fee',
  collection_fee:  'rc_collection_fee',
  pick_pack:       'rc_pick_pack',
  reverse_shipping:'rc_reverse_shipping',
  franchise_fee:   'rc_franchise_fee',
};

// Columns that vary per table (beyond id, category, start_date, end_date, marketplace, seller_account, updated_at)
const TABLE_EXTRA_COLUMNS = {
  commission:      ['brand_name', 'price_min', 'price_max', 'rate'],
  fixed_fee:       ['fulfilment_type', 'price_min', 'price_max', 'rate'],
  collection_fee:  ['price_min', 'price_max', 'prepaid', 'postpaid', 'prepaid_type', 'postpaid_type'],
  pick_pack:       ['fulfilment_type', 'price_min', 'price_max', 'rate'],
  reverse_shipping:['price_min', 'price_max', 'weight_slab', 'local_fee', 'zonal_fee', 'national_fee'],
  franchise_fee:   ['brand_name', 'price_min', 'price_max', 'rate'],
};

function resolveTable(type) {
  const table = TABLE_MAP[type];
  if (!table) throw Object.assign(new Error(`Unknown rate card type: ${type}`), { status: 400 });
  return table;
}

// ── Input validation helpers ─────────────────────────────────────────────────
function validateRateRow(type, body) {
  const errors = [];
  if (body.price_min !== undefined && body.price_max !== undefined) {
    const min = Number(body.price_min);
    const max = Number(body.price_max);
    if (!isNaN(min) && !isNaN(max) && min > max) {
      errors.push('price_min must be ≤ price_max');
    }
  }
  if (body.rate !== undefined && body.rate !== null && body.rate !== '') {
    const rate = Number(body.rate);
    if (isNaN(rate) || rate < 0) {
      errors.push('rate must be a non-negative number');
    }
  }
  if (body.prepaid !== undefined && body.prepaid !== null && body.prepaid !== '') {
    const v = Number(body.prepaid);
    if (isNaN(v) || v < 0) errors.push('prepaid must be non-negative');
  }
  if (body.postpaid !== undefined && body.postpaid !== null && body.postpaid !== '') {
    const v = Number(body.postpaid);
    if (isNaN(v) || v < 0) errors.push('postpaid must be non-negative');
  }
  return errors;
}

function firstDefined(object, ...keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  return undefined;
}

function requiredNonNegativeNumber(value, label) {
  const parsed = optionalNumber(value);
  if (parsed == null || parsed < 0) throw new Error(`${label} must be a number`);
  return parsed;
}

function optionalNonNegativeNumber(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return requiredNonNegativeNumber(value, label);
}

function normalizeFulfilmentType(value) {
  const normalized = String(value || 'NON_FBF').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return normalized || 'NON_FBF';
}

// Pure parser used by spreadsheet/config workflows before they issue an SQL
// write. It rejects malformed monetary values rather than silently turning
// them into zero-rate rules.
export function parseRateCardRow(type, row) {
  resolveTable(type);
  const category = normalizeCategory(firstDefined(row, 'category', 'Category') || 'ALL');
  const marketplace = String(firstDefined(row, 'marketplace', 'Marketplace') || 'flipkart').trim().toLowerCase();
  const sellerAccount = String(firstDefined(row, 'seller_account', 'sellerAccount') || 'default').trim();
  const startRaw = firstDefined(row, 'start_date', 'startDate');
  const endRaw = firstDefined(row, 'end_date', 'endDate');
  const startDate = startRaw == null ? null : normalizeSqlDate(startRaw);
  const endDate = endRaw == null ? null : normalizeSqlDate(endRaw);
  if (startRaw != null && !startDate) throw new Error('Start date must be a valid date');
  if (endRaw != null && !endDate) throw new Error('End date must be a valid date');

  const priceMin = optionalNonNegativeNumber(firstDefined(row, 'price_min', 'priceMin'), 'Order-value "From"');
  const priceMax = optionalNonNegativeNumber(firstDefined(row, 'price_max', 'priceMax'), 'Order-value "To"');
  if (priceMin != null && priceMax != null && priceMax <= priceMin) {
    throw new Error('Order-value "To" must be greater than "From"');
  }

  const base = [category, marketplace, sellerAccount, startDate, endDate];
  if (type === 'collection_fee') {
    return [
      ...base,
      normalizeFulfilmentType(firstDefined(row, 'fulfilment_type', 'fulfilmentType')),
      priceMin, priceMax,
      optionalNonNegativeNumber(row.prepaid, 'Prepaid fee'),
      optionalNonNegativeNumber(row.postpaid, 'Postpaid fee'),
      String(row.prepaid_type || 'flat').toLowerCase(),
      String(row.postpaid_type || 'flat').toLowerCase(),
    ];
  }
  if (type === 'reverse_shipping') {
    const weight = optionalNumber(firstDefined(row, 'weight_slab', 'weightSlab'));
    if (weight == null || weight <= 0) throw new Error('Weight slab must be a positive number');
    return [
      ...base, priceMin, priceMax, weight,
      optionalNonNegativeNumber(firstDefined(row, 'local_fee', 'localFee'), 'Local fee'),
      optionalNonNegativeNumber(firstDefined(row, 'zonal_fee', 'zonalFee'), 'Zonal fee'),
      optionalNonNegativeNumber(firstDefined(row, 'national_fee', 'nationalFee'), 'National fee'),
    ];
  }
  const rateLabel = type === 'commission' ? 'Commission rate' : 'Rate';
  const rate = requiredNonNegativeNumber(row.rate, rateLabel);
  if (type === 'commission' || type === 'franchise_fee') {
    return [...base, String(firstDefined(row, 'brand_name', 'brandName') || ''), priceMin, priceMax, rate];
  }
  return [...base, normalizeFulfilmentType(firstDefined(row, 'fulfilment_type', 'fulfilmentType')), priceMin, priceMax, rate];
}

export function resolveMarketplaceAndAccount(rawMarketplace, rawSellerAccount) {
  let marketplace = String(rawMarketplace || 'flipkart').trim().toLowerCase();
  let sellerAccount = String(rawSellerAccount || 'default').trim();
  if (marketplace === 'myntra_vb') {
    marketplace = 'myntra';
    sellerAccount = 'myntra_vb';
  } else if (marketplace === 'myntra_ej') {
    marketplace = 'myntra';
    sellerAccount = 'myntra_ej';
  } else if (marketplace === 'myntra' && (!sellerAccount || sellerAccount === 'default')) {
    sellerAccount = 'myntra_vb';
  }
  return { marketplace, sellerAccount };
}

export function parseRcEntryOrdersQuery(query = {}) {
  const rcIdText = String(query.rc_id || '').trim();
  if (!/^[1-9]\d*$/.test(rcIdText)) throw new Error('rc_id must be a positive whole number');
  const resolved = resolveMarketplaceAndAccount(query.marketplace, query.seller_account);
  const marketplace = resolved.marketplace;
  const sellerAccount = resolved.sellerAccount;
  if (!/^[a-z0-9_-]+$/.test(marketplace)) throw new Error('Marketplace may contain only letters, numbers, underscores, and hyphens');
  const feeType = String(query.fee_type || 'commission').trim().toLowerCase();
  resolveTable(feeType);
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(query.pageSize, 10) || 50));
  return { feeType, rcId: Number(rcIdText), marketplace, sellerAccount, page, pageSize };
}

// ── FIXED-ROUTE HANDLERS (must come BEFORE parameterized routes) ────────────

// GET /api/rate-card/config/template — download Excel template
router.get('/config/template', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
    const pool = getPool();
    const { marketplace, sellerAccount } = resolveMarketplaceAndAccount(req.query.marketplace, req.query.seller_account);

    const { rows } = await pool.query(`
      SELECT 
        COALESCE(marketplace, 'flipkart') as marketplace, 
        category, 
        brand,
        MAX(CASE WHEN COALESCE(marketplace, 'flipkart') = 'flipkart' THEN COALESCE(fsn, sku) ELSE sku END) as sample_sku 
      FROM orders 
      WHERE category IS NOT NULL AND category != '' 
        AND COALESCE(marketplace, 'flipkart') = $1
      GROUP BY COALESCE(marketplace, 'flipkart'), category, brand
      ORDER BY category, brand
    `, [marketplace]);

    const data = rows.map(row => ({
      Marketplace: row.marketplace,
      Category: row.category,
      Brand: row.brand || 'ANY',
      'Sample SKU (FSN)': row.sample_sku || '',
      'Min Price': 0,
      'Max Price': 99999,
      'Commission Rate (%)': ''
    }));

    if (data.length === 0) {
      data.push({
        Marketplace: marketplace, Category: 'Example Category', Brand: 'ANY',
        'Sample SKU (FSN)': 'SKU123', 'Min Price': 0, 'Max Price': 99999, 'Commission Rate (%)': ''
      });
    }
    
    const XLSXLIB = await import('xlsx');
    const ws = XLSXLIB.utils.json_to_sheet(data);
    const wb = XLSXLIB.utils.book_new();
    XLSXLIB.utils.book_append_sheet(wb, ws, 'Template');
    const buffer = XLSXLIB.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', `attachment; filename="RateCard_Commission_Template.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    console.error('[rate-card/template]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rate-card/config/categories — distinct categories for a marketplace
// Supports ?includeBrands=true to also return brand-level categories
router.get('/config/categories', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ categories: [] });
  try {
    const { marketplace, sellerAccount } = resolveMarketplaceAndAccount(req.query.marketplace, req.query.seller_account);
    const includeBrands = req.query.includeBrands === 'true';
    const pool = getPool();

    // Collect categories from all rate card tables
    const results = await Promise.all(
      Object.values(TABLE_MAP).map(table =>
        pool.query(
          `SELECT DISTINCT category FROM ${table} WHERE marketplace = $1 AND seller_account = $2`,
          [marketplace, sellerAccount],
        ).catch(() => ({ rows: [] })),
      ),
    );
    const cats = new Set();
    for (const { rows } of results) {
      for (const r of rows) cats.add(normalizeCategory(r.category));
    }

    // Also pull categories from orders for this marketplace & account
    try {
      const orderCond = sellerAccount !== 'default'
        ? `marketplace = $1 AND seller_account = $2`
        : `marketplace = $1`;
      const orderParams = sellerAccount !== 'default' ? [marketplace, sellerAccount] : [marketplace];
      const { rows: orderCats } = await pool.query(
        `SELECT DISTINCT category FROM orders WHERE ${orderCond} AND category IS NOT NULL AND category != ''`,
        orderParams,
      );
      for (const r of orderCats) cats.add(normalizeCategory(r.category));
    } catch { /* ignore */ }

    const categories = [...cats].sort();

    // If includeBrands, also return brand categories from commission table
    if (includeBrands) {
      try {
        const { rows: brandRows } = await pool.query(
          `SELECT DISTINCT brand_name FROM rc_commission 
           WHERE marketplace = $1 AND seller_account = $2 AND brand_name IS NOT NULL AND brand_name != ''`,
          [marketplace, sellerAccount],
        );
        const brands = brandRows.map(r => r.brand_name).filter(Boolean).sort();
        return res.json({ categories, brands });
      } catch { /* ignore */ }
    }

    res.json({ categories });
  } catch (e) {
    console.error('[rate-card/categories]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/rate-card/config-status — summary for Payment Reconciliation page
router.get('/config-status', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ configured: false });
  try {
    const { marketplace, sellerAccount } = resolveMarketplaceAndAccount(req.query.marketplace, req.query.seller_account);
    const pool = getPool();
    const results = await Promise.all(
      Object.entries(TABLE_MAP).map(async ([type, table]) => {
        const { rows } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM ${table} WHERE marketplace = $1 AND seller_account = $2`,
          [marketplace, sellerAccount],
        );
        return { type, count: Number(rows[0]?.cnt || 0) };
      }),
    );
    const total = results.reduce((s, r) => s + r.count, 0);
    res.json({
      configured: total > 0,
      marketplace,
      seller_account: sellerAccount,
      types: Object.fromEntries(results.map(r => [r.type, r.count])),
      totalRows: total,
    });
  } catch (e) {
    console.error('[rate-card/config-status]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/rate-card/config/seed — seed from legacy Excel workbook
router.post('/config/seed', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    // The service exports seedRateCardToDb; the old name was undefined, so
    // every seed request failed with "seedRateCard is not a function".
    const { seedRateCardToDb } = await import('../services/rateCard.js');
    const result = await seedRateCardToDb();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[rate-card/seed]', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── PARAMETERIZED CONFIG ROUTES ─────────────────────────────────────────────

router.get('/config/:type', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ rows: [] });
  try {
    const table = resolveTable(req.params.type);
    const { marketplace, sellerAccount } = resolveMarketplaceAndAccount(req.query.marketplace, req.query.seller_account);
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, category, TO_CHAR(start_date,'YYYY-MM-DD') AS start_date, TO_CHAR(end_date,'YYYY-MM-DD') AS end_date,
              marketplace, seller_account, ${TABLE_EXTRA_COLUMNS[req.params.type].join(', ')}
       FROM ${table}
       WHERE marketplace = $1 AND seller_account = $2
       ORDER BY category, ${TABLE_EXTRA_COLUMNS[req.params.type].includes('brand_name') ? "NULLIF(brand_name,'') NULLS LAST, " : ""} price_min ${TABLE_EXTRA_COLUMNS[req.params.type].includes('weight_slab') ? ", weight_slab" : ""}`,
      [marketplace, sellerAccount],
    );
    res.json({ rows });
  } catch (e) {
    console.error('[rate-card/config]', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/rate-card/config/:type — add a single row
router.post('/config/:type', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const type = req.params.type;
    const table = resolveTable(type);
    const pool = getPool();
    const body = req.body;

    // Validate input
    const errors = validateRateRow(type, body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const { marketplace, sellerAccount } = resolveMarketplaceAndAccount(body.marketplace, body.seller_account);

    // Build INSERT dynamically based on table
    const extraCols = TABLE_EXTRA_COLUMNS[type];
    const allCols = ['category', 'start_date', 'end_date', 'marketplace', 'seller_account', ...extraCols];
    const values = [
      body.category || 'ALL',
      body.start_date || null,
      body.end_date || null,
      marketplace,
      sellerAccount,
      ...extraCols.map(col => body[col] ?? null),
    ];
    const placeholders = allCols.map((_, i) => `$${i + 1}`);

    const { rows } = await pool.query(
      `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values,
    );
    clearRateCardCache();
    res.json({ ok: true, row: rows[0] });
  } catch (e) {
    console.error('[rate-card/config POST]', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// PUT /api/rate-card/config/:type/:id — update a row
router.put('/config/:type/:id', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const type = req.params.type;
    const table = resolveTable(type);
    const pool = getPool();
    const body = req.body;

    // Validate input
    const errors = validateRateRow(type, body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const extraCols = TABLE_EXTRA_COLUMNS[type];

    // Build SET clause for only provided fields
    const updates = [];
    const values = [];
    let idx = 1;
    const fields = ['category', 'start_date', 'end_date', ...extraCols];
    for (const col of fields) {
      if (body[col] !== undefined) {
        updates.push(`${col} = $${idx++}`);
        values.push(body[col]);
      }
    }
    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE ${table} SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    clearRateCardCache();
    res.json({ ok: true, row: rows[0] || null });
  } catch (e) {
    console.error('[rate-card/config PUT]', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// DELETE /api/rate-card/config/:type/:id — delete a row
router.delete('/config/:type/:id', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const table = resolveTable(req.params.type);
    const pool = getPool();
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
    clearRateCardCache();
    res.json({ ok: true });
  } catch (e) {
    console.error('[rate-card/config DELETE]', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/rate-card/config/:type/save-period — batch upsert an entire rate period
router.post('/config/:type/save-period', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const type = req.params.type;
    const table = resolveTable(type);
    const pool = getPool();
    const resolved = resolveMarketplaceAndAccount(req.body.marketplace, req.body.seller_account);
    const marketplace = resolved.marketplace;
    const seller_account = resolved.sellerAccount;
    const { rows: slabRows, start_date, end_date, category, replaceIds } = req.body;

    if (!Array.isArray(slabRows) || !slabRows.length) {
      return res.status(400).json({ error: 'No rate rows provided' });
    }

    // Validate dates server-side too — defence-in-depth so a UI bypass can't
    // poison the table with inverted ranges.
    if (start_date && end_date && end_date < start_date) {
      return res.status(400).json({ error: 'end_date must be on or after start_date' });
    }

    // Validate all rows
    for (let i = 0; i < slabRows.length; i++) {
      const errors = validateRateRow(type, slabRows[i]);
      if (errors.length) {
        return res.status(400).json({ error: `Row ${i + 1}: ${errors.join('; ')}` });
      }
    }

    // Start transaction: delete existing period, then insert new rows
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Two delete paths:
      //  (a) replaceIds — surgical IN-list delete. Use this for edit mode so
      //      we only touch the exact rows the user was editing.
      //  (b) fallback — match by category + date triple. Use for new periods
      //      and for edits where the page didn't track IDs.
      const idList = Array.isArray(replaceIds) ? replaceIds.filter(n => Number.isFinite(+n)).map(Number) : null;
      if (idList && idList.length > 0) {
        await client.query(
          `DELETE FROM ${table} WHERE id = ANY($1::int[])`,
          [idList],
        );
      } else {
        await client.query(
          `DELETE FROM ${table} WHERE category = $1 AND marketplace = $2 AND seller_account = $3
           AND start_date IS NOT DISTINCT FROM $4 AND end_date IS NOT DISTINCT FROM $5`,
          [category || 'ALL', marketplace, seller_account, start_date || null, end_date || null],
        );
      }

      const extraCols = TABLE_EXTRA_COLUMNS[type];
      const allCols = ['category', 'start_date', 'end_date', 'marketplace', 'seller_account', ...extraCols];

      // Batch insert using forEachDbBatch to stay under PostgreSQL's 65,535
      // parameter limit when a rate period has many slabs.
      const slabData = slabRows.map(slab => [
        slab.category || category || 'ALL',
        start_date || null,
        end_date || null,
        marketplace,
        seller_account,
        ...extraCols.map(col => slab[col] ?? null),
      ]);

      await forEachDbBatch(slabData, allCols.length, async batch => {
        const valueSets = [];
        const allValues = [];
        let paramIdx = 1;
        for (const vals of batch) {
          const placeholders = allCols.map(() => `$${paramIdx++}`);
          valueSets.push(`(${placeholders.join(', ')})`);
          allValues.push(...vals);
        }
        await client.query(
          `INSERT INTO ${table} (${allCols.join(', ')}) VALUES ${valueSets.join(', ')}`,
          allValues,
        );
      });

      await client.query('COMMIT');
      clearRateCardCache();
      res.json({ ok: true, inserted: slabRows.length, deleted: idList ? idList.length : null });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[rate-card/save-period]', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});




// ══════════════════════════════════════════════════════════════════════════════
//  VERSION MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /versions — list snapshots ───────────────────────────────────────────
router.get('/versions', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ versions: [] });
  try {
    const { marketplace, sellerAccount } = resolveMarketplaceAndAccount(req.query.marketplace, req.query.seller_account);
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, version_name, status, effective_from, effective_to,
              created_at, published_at, created_by, published_by
       FROM rate_card_versions
       WHERE marketplace = $1 AND seller_account = $2
       ORDER BY created_at DESC
       LIMIT 50`,
      [marketplace, sellerAccount],
    );
    res.json({ versions: rows });
  } catch (e) {
    console.error('[rate-card/versions]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /versions — create a snapshot ───────────────────────────────────────
router.post('/versions', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { marketplace, sellerAccount } = resolveMarketplaceAndAccount(req.body.marketplace, req.body.seller_account);
    const versionName = req.body.version_name || `snapshot-${new Date().toISOString().slice(0, 10)}`;
    const effectiveFrom = req.body.effective_from || new Date().toISOString().slice(0, 10);

    // Capture current rate card state as JSONB snapshot
    const snapshot = {};
    for (const [type, table] of Object.entries(TABLE_MAP)) {
      const { rows } = await pool.query(
        `SELECT * FROM ${table} WHERE marketplace = $1 AND seller_account = $2 ORDER BY category, price_min`,
        [marketplace, sellerAccount],
      );
      snapshot[type] = rows;
    }

    const { rows } = await pool.query(
      `INSERT INTO rate_card_versions (marketplace, seller_account, version_name, status, effective_from, snapshot)
       VALUES ($1, $2, $3, 'draft', $4, $5) RETURNING id, version_name, status, created_at`,
      [marketplace, sellerAccount, versionName, effectiveFrom, JSON.stringify(snapshot)],
    );
    res.json({ ok: true, version: rows[0] });
  } catch (e) {
    console.error('[rate-card/versions POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /versions/:id/publish ──────────────────────────────────────────────
router.post('/versions/:id/publish', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE rate_card_versions SET status = 'published', published_at = NOW()
       WHERE id = $1 RETURNING id, version_name, status, published_at`,
      [req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Version not found' });
    res.json({ ok: true, version: rows[0] });
  } catch (e) {
    console.error('[rate-card/publish]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/rate-card/versions/:id/rollback — restore snapshot with batch inserts
router.post('/versions/:id/rollback', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { rows: versions } = await pool.query(
      `SELECT * FROM rate_card_versions WHERE id = $1`,
      [req.params.id],
    );
    if (!versions.length) return res.status(404).json({ error: 'Version not found' });
    const version = versions[0];
    const snapshot = version.snapshot;
    if (!snapshot || typeof snapshot !== 'object') {
      return res.status(400).json({ error: 'Version has no snapshot data' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mp = version.marketplace;
      const sa = version.seller_account;

      for (const [type, table] of Object.entries(TABLE_MAP)) {
        const rows = snapshot[type];
        if (!Array.isArray(rows) || !rows.length) continue;
        // Delete current rows for this marketplace/seller_account
        await client.query(`DELETE FROM ${table} WHERE marketplace = $1 AND seller_account = $2`, [mp, sa]);

        // Batch insert using forEachDbBatch to stay under PostgreSQL's
        // 65,535 parameter limit when a snapshot has many rows.
        const firstRow = rows[0];
        const cols = Object.keys(firstRow).filter(k => k !== 'id' && k !== 'updated_at');
        const rowData = rows.map(row => cols.map(c => row[c]));

        await forEachDbBatch(rowData, cols.length, async batch => {
          const valueSets = [];
          const allValues = [];
          let paramIdx = 1;
          for (const vals of batch) {
            const placeholders = cols.map(() => `$${paramIdx++}`);
            valueSets.push(`(${placeholders.join(', ')})`);
            allValues.push(...vals);
          }
          await client.query(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${valueSets.join(', ')}`,
            allValues,
          );
        });
      }

      await client.query('COMMIT');
      clearRateCardCache();
      res.json({ ok: true, message: `Rolled back to version "${version.version_name}"` });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[rate-card/rollback]', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS (stub — implement with Resend API if needed)
// ══════════════════════════════════════════════════════════════════════════════

router.get('/notifications', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ notifications: [] });
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, event_type, recipient, subject, status, created_at, sent_at
       FROM rate_card_notification_log ORDER BY created_at DESC LIMIT 20`,
    );
    res.json({ notifications: rows });
  } catch (e) {
    res.json({ notifications: [] });
  }
});

router.post('/notifications/test', async (req, res) => {
  res.json({ ok: false, message: 'Email notifications are not configured. Set RESEND_API_KEY to enable.' });
});

// ══════════════════════════════════════════════════════════════════════════════
//  LEGACY ENDPOINTS (kept for backward compatibility)
// ══════════════════════════════════════════════════════════════════════════════

router.post('/sync', async (req, res) => {
  try {
    const { email, password } = process.env;
    const headless = process.env.SCRAPER_HEADLESS === 'true';
    const result = await scrapeRateCard({
      email: email || process.env.FLIPKART_EMAIL,
      password: password || process.env.FLIPKART_PASSWORD,
      headless,
    });
    if (result.success) {
      res.json({ message: 'Rate card synced successfully.', data: result.data });
    } else {
      res.status(500).json({ error: 'Failed to sync rate card.', details: result.error });
    }
  } catch (error) {
    console.error('[rate-card/sync]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/commissions', async (req, res) => {
  if (!(await isDbConfigured())) return res.json([]);
  try {
    const pool = getPool();
    const marketplace = req.query.marketplace || 'flipkart';
    const sellerAccount = req.query.seller_account || 'default';
    const { rows } = await pool.query(
      'SELECT * FROM rc_commission WHERE marketplace = $1 AND seller_account = $2 ORDER BY category, price_min',
      [marketplace, sellerAccount],
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fixed', async (req, res) => {
  if (!(await isDbConfigured())) return res.json([]);
  try {
    const pool = getPool();
    const marketplace = req.query.marketplace || 'flipkart';
    const sellerAccount = req.query.seller_account || 'default';
    const { rows } = await pool.query(
      'SELECT * FROM rc_fixed_fee WHERE marketplace = $1 AND seller_account = $2 ORDER BY category, price_min',
      [marketplace, sellerAccount],
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/collection', async (req, res) => {
  if (!(await isDbConfigured())) return res.json([]);
  try {
    const pool = getPool();
    const marketplace = req.query.marketplace || 'flipkart';
    const sellerAccount = req.query.seller_account || 'default';
    const { rows } = await pool.query(
      'SELECT * FROM rc_collection_fee WHERE marketplace = $1 AND seller_account = $2 ORDER BY category, price_min',
      [marketplace, sellerAccount],
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/shipping', async (req, res) => {
  if (!(await isDbConfigured())) return res.json([]);
  try {
    const pool = getPool();
    const marketplace = req.query.marketplace || 'flipkart';
    const sellerAccount = req.query.seller_account || 'default';
    const { rows } = await pool.query(
      'SELECT * FROM rc_pick_pack WHERE marketplace = $1 AND seller_account = $2 ORDER BY category, price_min',
      [marketplace, sellerAccount],
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});




// --- RECOVERED ENDPOINTS ---

// GET /api/rate-card/accounts
router.get('/accounts', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ accounts: [{ account_id: 'default', display_name: 'Default' }] });
  try {
    const rawMp = String(req.query.marketplace || 'flipkart').trim().toLowerCase();
    if (rawMp === 'myntra_vb') {
      return res.json({ accounts: [{ account_id: 'myntra_vb', display_name: 'Myntra (VB)' }] });
    }
    if (rawMp === 'myntra_ej') {
      return res.json({ accounts: [{ account_id: 'myntra_ej', display_name: 'Myntra (EJ)' }] });
    }
    const isMyntra = rawMp === 'myntra';
    const marketplace = isMyntra ? 'myntra' : rawMp;
    const pool = getPool();
    const { rows } = await pool.query('SELECT account_id, display_name FROM marketplace_accounts WHERE marketplace = $1 AND is_active = true ORDER BY id', [marketplace]);
    if (!isMyntra && !rows.some(r => r.account_id === 'default')) {
      rows.unshift({ account_id: 'default', display_name: 'Default Account' });
    }
    res.json({ accounts: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/rate-card/accounts
router.post('/accounts', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const { marketplace, account_id, display_name } = req.body;
    const pool = getPool();
    await pool.query('INSERT INTO marketplace_accounts (marketplace, account_id, display_name) VALUES ($1, $2, $3) ON CONFLICT (marketplace, account_id) DO UPDATE SET display_name = $3', [marketplace, account_id, display_name]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/rate-card/accounts/:id
router.delete('/accounts/:id', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const pool = getPool();
    await pool.query('DELETE FROM marketplace_accounts WHERE account_id = $1 AND marketplace = $2', [req.params.id, req.query.marketplace || 'flipkart']);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// GET /api/rate-card/reconcile
router.get('/reconcile', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });

    const pool = getPool();
    // The filter bar sends Myntra as its account id (myntra_vb / myntra_ej).
    const requestedMp = String(req.query.marketplace || 'flipkart').trim().toLowerCase();
    const mp = requestedMp.startsWith('myntra_') ? 'myntra' : requestedMp;
    const sa = req.query.seller_account || (requestedMp.startsWith('myntra_') ? requestedMp : 'default');
    const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    const startDate = isDate(req.query.startDate) ? req.query.startDate : null;
    const endDate = isDate(req.query.endDate) ? req.query.endDate : null;

    const { getRateCard, reconcileOrder } = await import('../services/rateCard.js');
    const rc = await getRateCard(mp, sa);

    const { rows } = await pool.query(`
      SELECT o.order_item_id as "orderItemId", o.order_date as "orderDate", o.category, o.final_invoice_amount as price,
             -- orders has no payment_type column (selecting it failed every
             -- request); order_type carries prepaid/COD as in /platform/summary.
             o.fulfilment_type as "fulfilmentType", o.brand as "brandName", o.order_type as "paymentType",
             o.shipping_zone as zone,
             COALESCE(s.commission, ost.commission, 0) as commission,
             COALESCE(s.fixed_fee, ost.fixed_fee, 0) as "fixedFee",
             COALESCE(s.collection_fee, ost.collection_fee, 0) as "collectionFee",
             COALESCE(s.bank_settlement, ost.net_bank, 0) as "bankSettlement"
      FROM orders o
      LEFT JOIN fk_settlement_orders s ON o.order_item_id = s.order_item_id
      LEFT JOIN order_settlement_totals ost ON o.order_item_id = ost.order_item_id
      WHERE o.marketplace = $1 AND COALESCE(o.seller_account, 'default') = $2
        AND o.final_invoice_amount > 0
        AND ($3::date IS NULL OR o.order_date >= $3::date)
        AND ($4::date IS NULL OR o.order_date <= $4::date)
    `, [mp, sa, startDate, endDate]);

    const orderMap = new Map();
    for (const row of rows) {
      if (!orderMap.has(row.orderItemId)) {
        // reconcileOrder() reads finalInvoiceAmount/shippingZone; passing
        // price/zone made it return null for every order (an always-empty report).
        orderMap.set(row.orderItemId, {
          orderItemId: row.orderItemId,
          orderDate: row.orderDate,
          category: row.category,
          finalInvoiceAmount: row.price == null ? null : Number(row.price),
          fulfilmentType: row.fulfilmentType,
          brandName: row.brandName,
          paymentType: row.paymentType,
          shippingZone: row.zone,
          settlementRows: []
        });
      }
      if (row.bankSettlement !== null) {
        orderMap.get(row.orderItemId).settlementRows.push({
          bankSettlement: row.bankSettlement,
          commission: row.commission,
          fixedFee: row.fixedFee,
          collectionFee: row.collectionFee
        });
      }
    }

    const allOrders = [...orderMap.values()];
    const results = allOrders.map(o => reconcileOrder(rc, o)).filter(Boolean);

    const withIssues = results.filter(r => r.issues.length > 0);
    const overcharged = withIssues.filter(r => r.status === 'overcharged');
    const undercharged = withIssues.filter(r => r.status === 'undercharged');
    const totalOver = +overcharged.reduce((s, r) => s + r.totalOvercharge, 0).toFixed(2);
    const totalUnder = +undercharged.reduce((s, r) => s + r.totalUndercharge, 0).toFixed(2);

    res.json({
      summary: {
        totalOrders: results.length,
        checkedOrders: results.filter(r => r.status !== 'no_settlement').length,
        issueCount: withIssues.length,
        overchargedCount: overcharged.length,
        underchargedCount: undercharged.length,
        totalOvercharged: totalOver,
        totalUndercharged: totalUnder,
        issuePct: results.length > 0 ? +((withIssues.length / results.length) * 100).toFixed(1) : 0,
      },
      issues: withIssues.sort((a, b) => (b.totalOvercharge + b.totalUndercharge) - (a.totalOvercharge + a.totalUndercharge))
    });
  } catch (err) {
    console.error('[rate-card/reconcile]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rate-card/calculate

// GET /api/rate-card/categories
router.get('/categories', async (req, res) => {
  try {
    const { getRateCard } = await import('../services/rateCard.js');
    const rc = await getRateCard('flipkart', 'default');
    res.json({ categories: rc.allCategories || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/calculate', async (req, res) => {
  try {
    const { getRateCard, calculateFees } = await import('../services/rateCard.js');
    const rc = await getRateCard(req.body.marketplace || 'flipkart', req.body.seller_account || 'default');
    res.json(calculateFees(rc, req.body));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rate-card/compare
router.post('/compare', async (req, res) => {
  try {
    const { getRateCard, calculateFees, normalizeCategory } = await import('../services/rateCard.js');
    const rc = await getRateCard();
    const body = req.body;
    const cat = normalizeCategory(body.category || '');
    const shopsyCat = cat.startsWith('shopsy_') ? cat : `shopsy_${cat}`;
    const flipkart = calculateFees(rc, { ...body, category: cat });
    const shopsy = calculateFees(rc, { ...body, category: shopsyCat });
    res.json({ flipkart, shopsy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rate-card/fee-summary
router.get('/fee-summary', async (req, res) => {
  try {
    if (!(await isDbConfigured())) {
      return res.json({
        grossSales: 0,
        netSettlement: 0,
        saleOrders: 0,
        returnOrders: 0,
        totalDeducted: 0,
        deductionPct: 0,
        fees: [],
        mpFees: [],
        taxFees: [],
        nonOrderFees: [],
        spfFees: [],
        spfClaimRows: [],
      });
    }

    const pool = getPool();
    const mp = req.query.marketplace || 'flipkart';
    const sa = req.query.seller_account || req.query.sellerAccount;
    const { startDate, endDate, category, month } = req.query;

    const conds = [`o.marketplace = $1`];
    const vals = [mp];

    if (sa && sa !== 'all') {
      conds.push(`COALESCE(o.seller_account, 'default') = $${vals.push(sa)}`);
    }
    if (category) {
      conds.push(`o.category = $${vals.push(category)}`);
    }
    if (month) {
      conds.push(`TO_CHAR(o.order_date, 'YYYY-MM') = $${vals.push(month)}`);
    }
    if (startDate) {
      conds.push(`o.order_date >= $${vals.push(startDate)}`);
    }
    if (endDate) {
      conds.push(`o.order_date <= $${vals.push(endDate)}`);
    }

    const whereClause = conds.join(' AND ');

    const sql = `
      SELECT
        COUNT(DISTINCT o.order_item_id) AS total_orders,
        COALESCE(SUM(o.final_invoice_amount), 0) AS gross_sales,
        COALESCE(SUM(s.net_bank), 0) AS net_settlement,
        COALESCE(SUM(s.refund_amount), 0) AS refunds,
        COALESCE(SUM(s.commission), 0) AS commission,
        COALESCE(SUM(s.fixed_fee), 0) AS fixed_fee,
        COALESCE(SUM(s.collection_fee), 0) AS collection_fee,
        COALESCE(SUM(s.pick_pack_fee), 0) AS pick_pack_fee,
        COALESCE(SUM(s.shipping_fee), 0) AS shipping_fee,
        COALESCE(SUM(s.reverse_shipping), 0) AS reverse_shipping,
        COALESCE(SUM(s.franchise_fee), 0) AS franchise_fee,
        COALESCE(SUM(s.tcs), 0) AS tcs,
        COALESCE(SUM(s.tds), 0) AS tds,
        COALESCE(SUM(s.gst_on_mp_fees), 0) AS gst_on_mp_fees
      FROM orders o
      JOIN order_settlement_totals s ON o.order_item_id = s.order_item_id
      WHERE ${whereClause}
    `;

    const { rows } = await pool.query(sql, vals);
    const r = rows[0] || {};
    const grossSales = +r.gross_sales || 0;
    const netSettlement = +r.net_settlement || 0;
    const saleOrders = +r.total_orders || 0;
    const returnOrders = +r.refunds > 0 ? 1 : 0;

    const mpFeeDefs = [
      { key: 'commission', label: 'Commission Fee', amount: +r.commission || 0 },
      { key: 'fixedFee', label: 'Fixed Fee', amount: +r.fixed_fee || 0 },
      { key: 'collectionFee', label: 'Collection Fee', amount: +r.collection_fee || 0 },
      { key: 'pickPackFee', label: 'Pick & Pack Fee', amount: +r.pick_pack_fee || 0 },
      { key: 'shippingFee', label: 'Shipping Fee', amount: +r.shipping_fee || 0 },
      { key: 'reverseShipping', label: 'Reverse Shipping Fee', amount: +r.reverse_shipping || 0 },
      { key: 'franchiseFee', label: 'Franchise Fee', amount: +r.franchise_fee || 0 },
    ];

    const totalMp = mpFeeDefs.reduce((s, f) => s + f.amount, 0);

    const taxFeeDefs = [
      {
        key: 'gstOnMpFees',
        label: 'GST on Marketplace Fees (18%)',
        amount: +r.gst_on_mp_fees || 0,
        group: 'tax',
        statutory: '18% GST',
        expected: +(totalMp * 0.18).toFixed(2),
        variance: +(+r.gst_on_mp_fees - (totalMp * 0.18)).toFixed(2),
        overcharged: (+r.gst_on_mp_fees || 0) > (totalMp * 0.18) + 2,
      },
      {
        key: 'tcs',
        label: 'TCS (Tax Collected at Source - 1%)',
        amount: +r.tcs || 0,
        group: 'tax',
        statutory: '1% IGST/CGST',
        expected: +(grossSales * 0.01).toFixed(2),
        variance: +(+r.tcs - (grossSales * 0.01)).toFixed(2),
        overcharged: (+r.tcs || 0) > (grossSales * 0.01) + 2,
      },
      {
        key: 'tds',
        label: 'TDS (u/s 194-O - 0.1%)',
        amount: +r.tds || 0,
        group: 'tax',
        statutory: '0.1% IT-TDS',
        expected: +(grossSales * 0.001).toFixed(2),
        variance: +(+r.tds - (grossSales * 0.001)).toFixed(2),
        overcharged: (+r.tds || 0) > (grossSales * 0.001) + 2,
      },
    ];

    const totalTax = taxFeeDefs.reduce((s, f) => s + f.amount, 0);
    const totalDeducted = +(totalMp + totalTax).toFixed(2);

    const mpFees = mpFeeDefs.map(f => ({
      ...f,
      group: 'mp',
      pctOfSales: grossSales > 0 ? +((f.amount / grossSales) * 100).toFixed(2) : 0,
      pctOfTotal: totalDeducted > 0 ? +((f.amount / totalDeducted) * 100).toFixed(1) : 0,
    }));

    const taxFees = taxFeeDefs.map(f => ({
      ...f,
      pctOfSales: grossSales > 0 ? +((f.amount / grossSales) * 100).toFixed(2) : 0,
      pctOfTotal: totalDeducted > 0 ? +((f.amount / totalDeducted) * 100).toFixed(1) : 0,
    }));

    const fees = [...mpFees, ...taxFees];

    res.json({
      grossSales,
      netSettlement,
      saleOrders,
      returnOrders,
      totalDeducted,
      deductionPct: grossSales > 0 ? +((totalDeducted / grossSales) * 100).toFixed(1) : 0,
      fees,
      mpFees,
      taxFees,
      nonOrderFees: [],
      spfFees: [],
      spfClaimRows: [],
    });
  } catch (err) {
    console.error('[rate-card/fee-summary]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/refresh', (req, res) => res.json({ ok: true }));
router.get('/intelligence', (req, res) => res.json({ orderFees: [], nonOrderFees: [], alerts: [] }));

// ── AI Screenshot Parser (Gemini Vision) ─────────────────────────────────────
// Accepts a base64-encoded screenshot of a marketplace rate card page and
// extracts structured slab data using Google Gemini's vision model.
const GEMINI_VISION_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite-preview-06-17', 'gemini-1.5-pro'];

const FEE_TYPE_PROMPTS = {
  commission: `Extract commission rate slabs. Each slab has: brand_name (string, null if "All brands" or generic), price_min (number, from price range start), price_max (number, null if no upper limit), rate (decimal: 0.14 = 14%, 0.05 = 5%).`,
  fixed_fee: `Extract fixed fee slabs. Each slab has: fulfilment_type (string: Bronze/Silver/Gold/Diamond/All), price_min (number), price_max (number, null if infinite), rate (flat rupee amount, e.g. 6).`,
  collection_fee: `Extract collection fee slabs. Each slab has: fulfilment_type (string: All/FBF/Non-FBF/Self-Ship), price_min (number), price_max (number, null if infinite), prepaid (number), prepaid_type ("pct" or "flat"), postpaid (number), postpaid_type ("pct" or "flat"). For percentage values, use decimal (0.003 = 0.3%).`,
  pick_pack: `Extract pick & pack fee slabs. Each slab has: fulfilment_type (string: FBF/Non-FBF/Flex/ALL), price_min (number), price_max (number, null if infinite), rate (flat rupee amount).`,
  reverse_shipping: `Extract reverse shipping fee slabs. Each slab has: price_min (number), price_max (number, null if infinite), weight_slab (number in kg), local_fee (rupee amount), zonal_fee (rupee amount), national_fee (rupee amount).`,
  franchise_fee: `Extract franchise fee slabs. Each slab has: brand_name (string, null if generic), price_min (number), price_max (number, null if infinite), rate (decimal: 0.02 = 2%).`,
};

router.post('/parse-image', async (req, res) => {
  try {
    const { imageBase64, mimeType, type } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
    if (!mimeType) return res.status(400).json({ error: 'Image MIME type is required' });

    const feeType = Object.keys(FEE_TYPE_PROMPTS).includes(type) ? type : 'commission';
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI parser is not configured. Set GEMINI_API_KEY to enable screenshot extraction.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const extractionGuide = FEE_TYPE_PROMPTS[feeType];

    const prompt = `You are a rate card data extraction assistant. Analyze this screenshot of a marketplace seller rate card page and extract ALL rate slab rows visible in the image.

${extractionGuide}

Return ONLY valid JSON (no markdown, no explanation):
{
  "slabs": [
    { "brand_name": null, "price_min": 0, "price_max": 300, "rate": 0.14 }
  ]
}

Rules:
1. Extract every visible row from the rate card table in the screenshot.
2. Use null for empty/unlimited values (e.g. price_max with no upper bound).
3. For percentage rates, use decimals: 14% = 0.14, 5% = 0.05, 0.3% = 0.003.
4. For flat rupee amounts, use the number directly: ₹6 = 6.
5. If the table is not visible or unreadable, return { "slabs": [] }.
6. Do not include any text outside the JSON.`;

    let lastErr;
    let modelUsed = null;
    for (const modelName of GEMINI_VISION_MODELS) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent([
          { text: prompt },
          { inlineData: { data: imageBase64, mimeType } },
        ]);
        const raw = result.response.text().trim();
        const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(jsonStr.startsWith('{') ? jsonStr : (jsonStr.match(/\{[\s\S]*\}/)?.[0] ?? '{"slabs":[]}'));
        const slabs = Array.isArray(parsed.slabs) ? parsed.slabs : [];
        modelUsed = modelName;
        console.log(`[rate-card/parse-image] extracted ${slabs.length} slabs with model: ${modelName}`);
        return res.json({ slabs, count: slabs.length, modelUsed });
      } catch (err) {
        const is404 = err.message?.includes('404') || err.message?.includes('not found') || err.message?.includes('no longer available');
        if (is404) {
          console.warn(`[rate-card/parse-image] model ${modelName} unavailable, trying next...`);
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw new Error(`All Gemini models unavailable. Last error: ${lastErr?.message}`);
  } catch (err) {
    console.error('[rate-card/parse-image]', err.message);
    res.status(500).json({ error: err.message, slabs: [], count: 0 });
  }
});

router.get('/rc-entry-reco', (req, res) => res.json({ commission: [], fixed_fee: [], pick_pack: [], franchise_fee: [] }));
router.get('/rc-entry-orders', (req, res) => res.json({ orders: [], total: 0 }));

export default router;
