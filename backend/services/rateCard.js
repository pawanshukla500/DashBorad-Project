import { createRequire } from 'module';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { getPool, isDbConfigured } from '../db/index.js';
import { optionalNumber, optionalString } from '../utils/valueParsers.js';

const req     = createRequire(import.meta.url);
const XLSXLIB = (() => { try { return req('xlsx'); } catch { return null; } })();

const RATE_CARD_XLSX_PATH = process.env.RATE_CARD_XLSX_PATH || 'C:/Users/shukl/Desktop/Flipkart Rate Card (1).xlsx';

// ── Date helpers ─────────────────────────────────────────────────────────────
function parseRateDate(v) {
  if (!v || v === '') return null;
  return normalizeSqlDate(v);
}
function inRange(orderDate, startVal, endVal) {
  const d = normalizeSqlDate(orderDate);
  if (!d) return true;
  const s = parseRateDate(startVal);
  const e = parseRateDate(endVal);
  if (s && d < s) return false;
  if (e && d > e) return false;
  return true;
}

// ── Category normalisation ───────────────────────────────────────────────────
const CAT_MAP = {
  'saree': 'sari', 'sarees': 'sari', 'sari': 'sari',
  'ethnic set': 'ethnic_set', 'ethnic sets': 'ethnic_set',
  'kurta': 'kurta', 'kurtas': 'kurta',
  'top': 'top', 'tops': 'top', 't-shirt': 'top', 'tshirt': 'top',
  'fabric': 'fabric', 'fabrics': 'fabric',
  'dupatta': 'dupatta', 'dupattas': 'dupatta',
  'shirt': 'shirt', 'shirts': 'shirt',
  'dress': 'dress', 'dresses': 'dress',
  'gown': 'gown', 'gowns': 'gown',
  'apparel set': 'apparel_set', 'apparel sets': 'apparel_set',
  'salwar kurta dupatta': 'salwar_kurta_dupatta',
  'salwar suit': 'salwar_kurta_dupatta',
  'salwar suits': 'salwar_kurta_dupatta',
  'salwar kameez': 'salwar_kurta_dupatta',
  'kurta set': 'salwar_kurta_dupatta',
  'kurta sets': 'salwar_kurta_dupatta',
};

export function normalizeCategory(cat) {
  if (!cat) return '';
  const c = (cat + '').toLowerCase().trim();
  return CAT_MAP[c] || c.replace(/[\s-]+/g, '_');
}

export const ALL_CATEGORIES = [
  'ethnic_set','sari','kurta','top','fabric','dupatta',
  'shirt','dress','gown','apparel_set','salwar_kurta_dupatta',
  'shopsy_fabric','shopsy_ethnic_set','shopsy_kurta','shopsy_sari',
];

// ── Cache ────────────────────────────────────────────────────────────────────
const _cacheMap = new Map();   // key = "marketplace:sellerAccount"
const CACHE_TTL = 30 * 60 * 1000;

export function clearRateCardCache() { _cacheMap.clear(); }

// ── Legacy workbook parsing ──────────────────────────────────────────────────
// The Excel fallback predates the in-app rate-card editor, but it still changes
// reconciliation outcomes. Treat it like every other import: reject corrupt
// cells rather than turning them into zero-valued fee rules.
function workbookError(message) {
  const error = new Error(`Rate-card workbook: ${message}`);
  error.status = 400;
  return error;
}

function workbookText(value, label, { required = false, max = 120 } = {}) {
  const text = optionalString(value);
  if (!text && required) throw workbookError(`${label} is required.`);
  if (text && text.length > max) throw workbookError(`${label} must be ${max} characters or fewer.`);
  return text;
}

function workbookNumber(value, label, { fallback, required = false, min = 0, max = 1_000_000_000 } = {}) {
  const text = optionalString(value);
  if (!text) {
    if (required) throw workbookError(`${label} is required.`);
    return fallback;
  }
  const parsed = optionalNumber(text);
  if (parsed == null || parsed < min || parsed > max) {
    throw workbookError(`${label} must be a number from ${min} to ${max}.`);
  }
  return parsed;
}

function workbookRate(value, label, { required = true, max = 1_000_000_000 } = {}) {
  const text = workbookText(value, label, { required });
  if (!text) return 0;
  const isPercent = text.endsWith('%');
  const raw = isPercent ? text.slice(0, -1).trim() : text;
  const parsed = optionalNumber(raw);
  if (parsed == null || parsed < 0) throw workbookError(`${label} must be a non-negative number.`);
  const rate = isPercent ? parsed / 100 : parsed;
  if (rate > max) throw workbookError(`${label} must be no greater than ${max}.`);
  return rate;
}

function workbookDate(value, label) {
  const text = optionalString(value);
  if (!text) return null;
  const parsed = normalizeSqlDate(value);
  if (!parsed) throw workbookError(`${label} must be a valid date.`);
  return parsed;
}

function workbookBase(row, rowNumber, sheet, { priceMinIndex, priceMaxIndex }) {
  const prefix = `${sheet} row ${rowNumber}`;
  const category = normalizeCategory(workbookText(row[0], `${prefix} category`, { required: true }));
  const startDate = workbookDate(row[1], `${prefix} start date`);
  const endDate = workbookDate(row[2], `${prefix} end date`);
  if (startDate && endDate && endDate < startDate) {
    throw workbookError(`${prefix} end date cannot be earlier than start date.`);
  }
  const priceMin = workbookNumber(row[priceMinIndex], `${prefix} order-value From`, { fallback: 0 });
  const priceMax = workbookNumber(row[priceMaxIndex], `${prefix} order-value To`, { fallback: 999999 });
  if (priceMax < priceMin) throw workbookError(`${prefix} order-value To cannot be lower than From.`);
  return { category, startDate, endDate, priceMin, priceMax, prefix };
}

function workbookFulfilment(value, label) {
  const raw = (workbookText(value, label, { max: 40 }) || 'ALL').toUpperCase().replace(/[\s-]+/g, '_');
  const aliases = { ALL: 'ALL', FBF: 'FBF', NON_FBF: 'NON_FBF', NONFBF: 'NON_FBF', SELF_SHIP: 'SELF_SHIP', SELFSHIP: 'SELF_SHIP', FLEX: 'FLEX' };
  if (!aliases[raw]) throw workbookError(`${label} must be All, FBF, Non-FBF, Self-Ship, or Flex.`);
  return aliases[raw];
}

function workbookWeightSlab(value, label) {
  const text = workbookText(value, label, { required: true, max: 50 });
  const compact = text.toLowerCase().replace(/\s+/g, '').replace(/[–—]/g, '-');
  const isGrams = /gms?$/.test(compact);
  const normalized = compact.replace(/(?:kgs?|gms?)$/i, '');
  const range = normalized.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  const rawUpper = range ? Number(range[2]) : optionalNumber(normalized);
  const rawLower = range ? Number(range[1]) : null;
  const upper = isGrams ? rawUpper / 1000 : rawUpper;
  const lower = isGrams ? rawLower / 1000 : rawLower;
  if (upper == null || upper <= 0 || upper > 100 || (range && lower >= upper)) {
    throw workbookError(`${label} must be a positive number or increasing range up to 100 kg.`);
  }
  return text;
}

// ── Load from DB ──────────────────────────────────────────────────────────────
// Loads rates for a specific account. If sellerAccount != 'default', also loads 'default'
// rows as fallback and merges (account-specific rows come first so find() prefers them).
async function loadFromDb(marketplace = 'flipkart', sellerAccount = 'default') {
  try {
    const pool = getPool();
    // Include 'default' as fallback for non-default accounts
    const accounts = sellerAccount !== 'default' ? [sellerAccount, 'default'] : ['default'];

    const orderBy = accounts.length > 1
      ? `(CASE WHEN seller_account = $2[1] THEN 0 ELSE 1 END)`
      : `1`;

    // During rolling PostgreSQL schema upgrades, keep current rate-card
    // calculations working until the optional price-band columns are visible.
    const reverseShippingQuery = pool.query(
      `SELECT category, TO_CHAR(start_date,'YYYY-MM-DD') AS start_date, TO_CHAR(end_date,'YYYY-MM-DD') AS end_date, price_min, price_max, weight_slab, local_fee, zonal_fee, national_fee FROM rc_reverse_shipping WHERE marketplace = $1 AND seller_account = ANY($2) ORDER BY ${orderBy}, category, price_min, weight_slab`,
      [marketplace, accounts]
    ).catch(async error => {
      if (!/price_(?:min|max)/i.test(error.message || '')) throw error;
      return pool.query(
        `SELECT category, TO_CHAR(start_date,'YYYY-MM-DD') AS start_date, TO_CHAR(end_date,'YYYY-MM-DD') AS end_date, weight_slab, local_fee, zonal_fee, national_fee FROM rc_reverse_shipping WHERE marketplace = $1 AND seller_account = ANY($2) ORDER BY ${orderBy}, category, weight_slab`,
        [marketplace, accounts]
      );
    });

    const [commRes, fixRes, colRes, ppRes, revRes, franRes] = await Promise.all([
      pool.query(`SELECT category, COALESCE(brand_name, '') AS brand_name, TO_CHAR(start_date,'YYYY-MM-DD') AS start_date, TO_CHAR(end_date,'YYYY-MM-DD') AS end_date, price_min, price_max, rate FROM rc_commission WHERE marketplace = $1 AND seller_account = ANY($2) ORDER BY ${orderBy}, category, NULLIF(brand_name,'') NULLS LAST, price_min`, [marketplace, accounts]),
      pool.query(`SELECT category, TO_CHAR(start_date,'YYYY-MM-DD') AS start_date, TO_CHAR(end_date,'YYYY-MM-DD') AS end_date, fulfilment_type, price_min, price_max, rate FROM rc_fixed_fee WHERE marketplace = $1 AND seller_account = ANY($2) ORDER BY ${orderBy}, category, price_min`, [marketplace, accounts]),
      pool.query(`SELECT category, TO_CHAR(start_date,'YYYY-MM-DD') AS start_date, TO_CHAR(end_date,'YYYY-MM-DD') AS end_date, price_min, price_max, prepaid, postpaid, COALESCE(prepaid_type,'pct') AS prepaid_type, COALESCE(postpaid_type,'pct') AS postpaid_type FROM rc_collection_fee WHERE marketplace = $1 AND seller_account = ANY($2) ORDER BY ${orderBy}, category, price_min`, [marketplace, accounts]),
      pool.query(`SELECT category, TO_CHAR(start_date,'YYYY-MM-DD') AS start_date, TO_CHAR(end_date,'YYYY-MM-DD') AS end_date, COALESCE(fulfilment_type,'ALL') AS fulfilment_type, price_min, price_max, rate FROM rc_pick_pack WHERE marketplace = $1 AND seller_account = ANY($2) ORDER BY ${orderBy}, category, price_min`, [marketplace, accounts]),
      reverseShippingQuery,
      pool.query(`SELECT category, COALESCE(brand_name,'') AS brand_name, TO_CHAR(start_date,'YYYY-MM-DD') AS start_date, TO_CHAR(end_date,'YYYY-MM-DD') AS end_date, price_min, price_max, rate FROM rc_franchise_fee WHERE marketplace = $1 AND seller_account = ANY($2) ORDER BY ${orderBy}, category, NULLIF(brand_name,'') NULLS LAST, price_min`, [marketplace, accounts]).catch(() => ({ rows: [] })),
    ]);
    // normalizeCategory so DB categories match lookup keys regardless of stored case
    const commission      = commRes.rows.map(r => ({ category: normalizeCategory(r.category), brandName: r.brand_name || null, startDate: r.start_date, endDate: r.end_date, priceMin: +r.price_min, priceMax: +r.price_max, rate: +r.rate }));
    const fixedFee        = fixRes.rows.map(r  => ({ category: normalizeCategory(r.category), startDate: r.start_date, endDate: r.end_date, fulfilmentType: r.fulfilment_type || 'ALL', priceMin: +r.price_min, priceMax: +r.price_max, rate: +r.rate }));
    const collectionFee   = colRes.rows.map(r  => ({ category: normalizeCategory(r.category), startDate: r.start_date, endDate: r.end_date, priceMin: +r.price_min, priceMax: +r.price_max, prepaid: +r.prepaid, postpaid: +r.postpaid, prepaidType: r.prepaid_type, postpaidType: r.postpaid_type }));
    const pickAndPack     = ppRes.rows.map(r   => ({ category: normalizeCategory(r.category), startDate: r.start_date, endDate: r.end_date, fulfilmentType: r.fulfilment_type || 'ALL', priceMin: +r.price_min, priceMax: +r.price_max, rate: +r.rate }));
    const reverseShipping = revRes.rows.map(r  => ({ category: normalizeCategory(r.category), startDate: r.start_date, endDate: r.end_date, priceMin: Number(r.price_min ?? 0), priceMax: Number(r.price_max ?? 999999), weightSlab: r.weight_slab, local: +r.local_fee, zonal: +r.zonal_fee, national: +r.national_fee }));
    const franchiseFee    = franRes.rows.map(r => ({ category: normalizeCategory(r.category) || 'all', brandName: r.brand_name || null, startDate: r.start_date, endDate: r.end_date, priceMin: +r.price_min, priceMax: +r.price_max, rate: +r.rate }));
    return { commission, fixedFee, collectionFee, pickAndPack, reverseShipping, franchiseFee };
  } catch { return null; }
}

// ── Load from Excel ─────────────────────────────────────────────────────────
const TABS = {
  commission:      'Comission Fee',
  fixedFee:        'Fixed Fee',
  reverseShipping: 'Reverse Shipping Fee',
  collectionFee:   'Collection Fee',
  pickAndPack:     'Pick And Pack Fee',
};

function loadFromExcel() {
  if (!XLSXLIB) throw workbookError('the Excel reader dependency is unavailable.');
  try {
    const wb = XLSXLIB.readFile(RATE_CARD_XLSX_PATH);
    const raw = {};
    for (const [key, tab] of Object.entries(TABS)) {
      const ws = wb.Sheets[tab];
      raw[key] = ws ? XLSXLIB.utils.sheet_to_json(ws, { header: 1, defval: '' }).slice(1) : [];
    }
    return buildRateCardTables(raw);
  } catch (error) {
    if (error?.status) throw error;
    throw workbookError(`could not be read (${error.message}).`);
  }
}

export function buildRateCardTables(raw = {}) {
  const commission = (raw.commission || []).map((row, index) => {
    const base = workbookBase(row, index + 2, TABS.commission, { priceMinIndex: 3, priceMaxIndex: 4 });
    return { ...base, rate: workbookRate(row[5], `${base.prefix} commission rate`, { max: 1 }) };
  });

  const fixedFee = (raw.fixedFee || []).map((row, index) => {
    const base = workbookBase(row, index + 2, TABS.fixedFee, { priceMinIndex: 4, priceMaxIndex: 5 });
    return {
      ...base,
      fulfilmentType: workbookFulfilment(row[3], `${base.prefix} fulfilment type`),
      rate: workbookRate(row[6], `${base.prefix} fixed fee`),
    };
  });

  const reverseShipping = (raw.reverseShipping || []).map((row, index) => {
    // Legacy workbook: category, dates, weight, local, zonal, national.
    // New workbook:    category, dates, price min, price max, weight, local, zonal, national.
    const looksLikeWeightSlab = value => /(?:kg|gm|\bg\b|[-–]\s*\d)/i.test(String(value ?? ''));
    const isNewLayout = row.length >= 9 && !looksLikeWeightSlab(row[3]);
    const base = workbookBase(row, index + 2, TABS.reverseShipping, {
      priceMinIndex: isNewLayout ? 3 : -1,
      priceMaxIndex: isNewLayout ? 4 : -1,
    });
    const weightIndex = isNewLayout ? 5 : 3;
    const feeIndex = isNewLayout ? 6 : 4;
    return {
      ...base,
      weightSlab: workbookWeightSlab(row[weightIndex], `${base.prefix} weight slab`),
      local: workbookNumber(row[feeIndex], `${base.prefix} local fee`, { required: true }),
      zonal: workbookNumber(row[feeIndex + 1], `${base.prefix} zonal fee`, { required: true }),
      national: workbookNumber(row[feeIndex + 2], `${base.prefix} national fee`, { required: true }),
    };
  });

  const collectionFee = (raw.collectionFee || []).map((row, index) => {
    const base = workbookBase(row, index + 2, TABS.collectionFee, { priceMinIndex: 3, priceMaxIndex: 4 });
    return {
      ...base,
      prepaid: workbookRate(row[5], `${base.prefix} prepaid rate`, { max: 1 }),
      postpaid: workbookRate(row[6], `${base.prefix} postpaid rate`, { max: 1 }),
    };
  });

  const pickAndPack = (raw.pickAndPack || []).map((row, index) => {
    const base = workbookBase(row, index + 2, TABS.pickAndPack, { priceMinIndex: 3, priceMaxIndex: 4 });
    return { ...base, rate: workbookRate(row[5], `${base.prefix} Pick & Pack fee`) };
  });

  const allCategories = [...new Set([
    ...commission.map(r => r.category),
    ...fixedFee.map(r => r.category),
  ].filter(Boolean))].sort();

  return { commission, fixedFee, reverseShipping, collectionFee, pickAndPack, allCategories };
}

// ── Seed Excel rows into DB ──────────────────────────────────────────────────
export async function seedRateCardToDb() {
  const pool = getPool();
  // Read and validate the entire source before any active DB card is touched.
  const excel = loadFromExcel();
  const allRows = [excel.commission, excel.fixedFee, excel.collectionFee, excel.pickAndPack, excel.reverseShipping];
  if (!allRows.some(rows => rows.length)) throw workbookError('contains no rate rows; existing cards were left unchanged.');
  const fmt   = d => { const x = parseRateDate(d); return x || null; };
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // The legacy workbook is Flipkart/default only. Never erase rate cards for
    // other marketplaces or seller accounts when refreshing this seed.
    for (const table of ['rc_commission', 'rc_fixed_fee', 'rc_collection_fee', 'rc_pick_pack', 'rc_reverse_shipping']) {
      await client.query(`DELETE FROM ${table} WHERE marketplace = 'flipkart' AND seller_account = 'default'`);
    }

    for (const r of excel.commission) {
      await client.query(
      `INSERT INTO rc_commission(category,start_date,end_date,price_min,price_max,rate) VALUES($1,$2,$3,$4,$5,$6)`,
      [r.category, fmt(r.startDate), fmt(r.endDate), r.priceMin, Math.min(r.priceMax,999999), r.rate]
      );
    }
    for (const r of excel.fixedFee) {
      await client.query(
      `INSERT INTO rc_fixed_fee(category,start_date,end_date,fulfilment_type,price_min,price_max,rate) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [r.category, fmt(r.startDate), fmt(r.endDate), r.fulfilmentType, r.priceMin, Math.min(r.priceMax,999999), r.rate]
      );
    }
    for (const r of excel.collectionFee) {
      await client.query(
      `INSERT INTO rc_collection_fee(category,start_date,end_date,price_min,price_max,prepaid,postpaid) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [r.category, fmt(r.startDate), fmt(r.endDate), r.priceMin, Math.min(r.priceMax,999999), r.prepaid, r.postpaid]
      );
    }
    for (const r of excel.pickAndPack) {
      await client.query(
      `INSERT INTO rc_pick_pack(category,start_date,end_date,price_min,price_max,rate) VALUES($1,$2,$3,$4,$5,$6)`,
      [r.category, fmt(r.startDate), fmt(r.endDate), r.priceMin, Math.min(r.priceMax,999999), r.rate]
      );
    }
    for (const r of excel.reverseShipping) {
      await client.query(
      `INSERT INTO rc_reverse_shipping(category,start_date,end_date,price_min,price_max,weight_slab,local_fee,zonal_fee,national_fee) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.category, fmt(r.startDate), fmt(r.endDate), r.priceMin, Math.min(r.priceMax, 999999), r.weightSlab, r.local, r.zonal, r.national]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  clearRateCardCache();
  return {
    commission:      excel.commission.length,
    fixedFee:        excel.fixedFee.length,
    collectionFee:   excel.collectionFee.length,
    pickAndPack:     excel.pickAndPack.length,
    reverseShipping: excel.reverseShipping.length,
  };
}

// ── Main getRateCard — DB first, Excel fallback ──────────────────────────────
export async function getRateCard(marketplace = 'flipkart', sellerAccount = 'default', forceRefresh = false) {
  const key = `${marketplace}:${sellerAccount}`;
  const cached = _cacheMap.get(key);
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  let tables = null;
  if (await isDbConfigured()) {
    const db = await loadFromDb(marketplace, sellerAccount);
    if (db && (db.commission.length > 0 || db.fixedFee.length > 0)) {
      const allCategories = [...new Set([...db.commission.map(r => r.category), ...db.fixedFee.map(r => r.category)].filter(Boolean))].sort();
      tables = { ...db, allCategories };
    }
  }

  if (!tables) {
    tables = loadFromExcel();
  }

  _cacheMap.set(key, { data: tables, at: Date.now() });
  return tables;
}

// ── Lookup helpers ────────────────────────────────────────────────────────────
function matchCommission(rc, cat, price, orderDate, brandName = null) {
  const bn = (brandName || '').toLowerCase().trim();
  // 1) Try brand-specific match first
  if (bn) {
    const branded = rc.commission.find(r =>
      r.category === cat &&
      r.brandName && r.brandName.toLowerCase().trim() === bn &&
      inRange(orderDate, r.startDate, r.endDate) &&
      price >= r.priceMin && price <= r.priceMax
    );
    if (branded) return branded;
  }
  // 2) Fall back to generic (brandName null/empty = applies to all brands)
  return rc.commission.find(r =>
    r.category === cat &&
    !r.brandName &&
    inRange(orderDate, r.startDate, r.endDate) &&
    price >= r.priceMin && price <= r.priceMax
  ) ?? null;
}

function matchFranchiseFee(rc, cat, price, orderDate, brandName = null) {
  if (!rc.franchiseFee || rc.franchiseFee.length === 0) return null;
  const bn = (brandName || '').toLowerCase().trim();
  const tryMatch = (rows) => rows.find(r =>
    (r.category === cat || r.category === 'all') &&
    inRange(orderDate, r.startDate, r.endDate) &&
    price >= r.priceMin && price <= r.priceMax
  ) ?? null;
  // 1) Brand-specific
  if (bn) {
    const branded = (rc.franchiseFee).filter(r => r.brandName && r.brandName.toLowerCase().trim() === bn);
    const m = tryMatch(branded);
    if (m) return m;
  }
  // 2) Generic (no brand restriction)
  const generic = (rc.franchiseFee).filter(r => !r.brandName);
  return tryMatch(generic);
}

function canonicalFulfilmentType(value, fallback = 'ALL') {
  const normalized = String(value || fallback).toUpperCase().trim().replace(/[\s-]+/g, '_');
  return { NONFBF: 'NON_FBF', SELFSHIP: 'SELF_SHIP' }[normalized] || normalized;
}

function matchFixedFee(rc, cat, fulfilmentType, price, orderDate) {
  const ft = canonicalFulfilmentType(String(fulfilmentType || 'NON_FBF').replace('FLIPKART', 'FBF'));
  return rc.fixedFee.find(r =>
    r.category === cat &&
    (canonicalFulfilmentType(r.fulfilmentType) === ft || canonicalFulfilmentType(r.fulfilmentType) === 'ALL') &&
    inRange(orderDate, r.startDate, r.endDate) &&
    price >= r.priceMin && price <= r.priceMax
  ) ?? null;
}

function matchCollectionFee(rc, cat, price, orderDate) {
  return rc.collectionFee.find(r =>
    r.category === cat &&
    inRange(orderDate, r.startDate, r.endDate) &&
    price >= r.priceMin && price <= r.priceMax
  ) ?? null;
}

function matchPickAndPack(rc, cat, fulfilmentType, price, orderDate) {
  const ft = canonicalFulfilmentType(String(fulfilmentType || 'ALL').replace('FLIPKART', 'FBF'));
  return rc.pickAndPack.find(r =>
    r.category === cat &&
    (canonicalFulfilmentType(r.fulfilmentType) === ft || canonicalFulfilmentType(r.fulfilmentType) === 'ALL') &&
    inRange(orderDate, r.startDate, r.endDate) &&
    price >= r.priceMin && price <= r.priceMax
  ) ?? null;
}

function reverseWeightUpperBound(weightSlab) {
  const text = String(weightSlab || '');
  const values = text.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  if (!values.length) return Number.POSITIVE_INFINITY;
  const upper = values[values.length - 1];
  return /(?:gm|\bg\b)/i.test(text) ? upper / 1000 : upper;
}

function findReverseShippingRow(rc, cat, price, weight, orderDate) {
  const w = parseFloat(weight) || 0.5;
  const p = parseFloat(price) || 0;
  return (rc.reverseShipping || [])
    .filter(r => {
      if (r.category !== cat) return false;
      if (!inRange(orderDate, r.startDate, r.endDate)) return false;
      const min = Number.isFinite(Number(r.priceMin)) ? Number(r.priceMin) : 0;
      const max = Number.isFinite(Number(r.priceMax)) ? Number(r.priceMax) : 999999;
      return p >= min && p <= max && w <= reverseWeightUpperBound(r.weightSlab);
    })
    // Do not rely on lexical slab strings ("10 kg" sorts before "2 kg").
    .sort((a, b) => reverseWeightUpperBound(a.weightSlab) - reverseWeightUpperBound(b.weightSlab))[0];
}

function lookupReverseShippingAmount(rc, cat, price, weight, zone, orderDate) {
  const z = (zone || 'national').toLowerCase();
  const match = findReverseShippingRow(rc, cat, price, weight, orderDate);
  if (!match) return null;
  if (z === 'local') return match.local;
  if (z === 'zonal') return match.zonal;
  return match.national;
}

// ── Main calculation ──────────────────────────────────────────────────────────
export function calculateFees(rc, params) {
  const {
    category, price,
    fulfilmentType = 'NON_FBF',
    zone = 'national',
    paymentType = 'prepaid',
    weight = 0.5,
    orderDate = new Date().toISOString(),
    isReturn = false,
    brandName = null,
  } = params;

  const cat = normalizeCategory(category);
  const p   = parseFloat(price) || 0;

  const commRow        = matchCommission(rc, cat, p, orderDate, brandName);
  const commissionRate = commRow?.rate ?? null;
  const commission     = commissionRate !== null ? +(p * commissionRate).toFixed(2) : null;

  const fixedFeeRow = matchFixedFee(rc, cat, fulfilmentType, p, orderDate);
  const fixedFee    = fixedFeeRow?.rate ?? null;

  const collFeeRow    = matchCollectionFee(rc, cat, p, orderDate);
  const colPt         = (paymentType || 'prepaid').toLowerCase();
  const colIsPost     = colPt === 'postpaid';
  const colRate       = collFeeRow ? (colIsPost ? collFeeRow.postpaid : collFeeRow.prepaid) : null;
  const colType       = collFeeRow ? (colIsPost ? (collFeeRow.postpaidType || 'pct') : (collFeeRow.prepaidType || 'pct')) : 'pct';
  const collectionFee = colRate !== null
    ? (colType === 'flat' ? +colRate.toFixed(2) : +(p * colRate).toFixed(2))
    : null;

  const reverseShippingRow = isReturn ? findReverseShippingRow(rc, cat, p, weight, orderDate) : null;
  const reverseShipping = isReturn ? lookupReverseShippingAmount(rc, cat, p, weight, zone, orderDate) : null;

  const ppRow     = matchPickAndPack(rc, cat, fulfilmentType, p, orderDate);
  const pickPack  = ppRow?.rate ?? null;

  // Franchise fee (flat ₹ per order, brand-specific or generic)
  const franRow     = matchFranchiseFee(rc, cat, p, orderDate, brandName);
  const franchiseFee = franRow?.rate ?? null;

  // GST basis = Commission + Fixed Fee + Franchise Fee (all three are FK-taxable fees)
  const feesForGst = (commission || 0) + (fixedFee || 0) + (franchiseFee || 0);
  const gstOnFees  = (commission !== null || franchiseFee !== null)
    ? +(feesForGst * 0.18).toFixed(2)
    : null;

  const tcs = +(p * 0.01).toFixed(2);

  const total = [commission, fixedFee, collectionFee, pickPack, reverseShipping, franchiseFee, gstOnFees].reduce((s, v) => s + (v || 0), 0);
  const net   = +(p - total).toFixed(2);

  return {
    category: cat, price: p,
    commissionRate, commission, fixedFee,
    collectionFeeRate: colRate, collectionFee,
    pickPack, franchiseFee,
    reverseShipping, gstOnFees, tcs,
    totalFees: +total.toFixed(2), netToSeller: net,
    marginPct: p > 0 ? +((net / p) * 100).toFixed(2) : 0,
    commissionMeta:    commRow    ? { startDate: commRow.startDate,    endDate: commRow.endDate    } : null,
    fixedFeeMeta:      fixedFeeRow? { startDate: fixedFeeRow.startDate, endDate: fixedFeeRow.endDate } : null,
    collectionFeeMeta: collFeeRow ? { startDate: collFeeRow.startDate,  endDate: collFeeRow.endDate  } : null,
    pickPackMeta:      ppRow      ? { startDate: ppRow.startDate,       endDate: ppRow.endDate       } : null,
    reverseShippingMeta: reverseShippingRow ? {
      startDate: reverseShippingRow.startDate, endDate: reverseShippingRow.endDate,
      priceMin: reverseShippingRow.priceMin ?? 0, priceMax: reverseShippingRow.priceMax ?? 999999,
      weightSlab: reverseShippingRow.weightSlab,
    } : null,
    franchiseFeeMeta:  franRow    ? { startDate: franRow.startDate,     endDate: franRow.endDate     } : null,
  };
}

// ── Reconciliation ────────────────────────────────────────────────────────────
const THRESH = 2;

export function reconcileOrder(rc, order) {
  const { 
    orderItemId, orderDate, category, finalInvoiceAmount: price, fulfilmentType,
    brandName, paymentType, shippingZone: zone, weightSlab, returnType
  } = order;
  if (!price || !category) return null;

  // Approximate weight from weight_slab (e.g. "0.0-0.5" -> 0.5)
  let weight = 0.5;
  if (weightSlab) {
    const parts = weightSlab.split('-');
    if (parts.length > 1) weight = parseFloat(parts[1]) || 0.5;
  }
  const isReturn = returnType && returnType.toLowerCase().includes('return');

  const expected = calculateFees(rc, { 
    category, price, fulfilmentType, orderDate, 
    brandName, paymentType, zone, weight, isReturn
  });
  const sRows    = order.settlementRows || [];
  const saleRows = sRows.filter(r => r.bankSettlement > 0);

  const actual = {
    commission:    saleRows.reduce((s, r) => s + Math.abs(r.commission    || 0), 0),
    fixedFee:      saleRows.reduce((s, r) => s + Math.abs(r.fixedFee      || 0), 0),
    collectionFee: saleRows.reduce((s, r) => s + Math.abs(r.collectionFee || 0), 0),
  };

  const issues = [];
  const checkFee = (name, exp, act) => {
    if (exp === null || act === 0) return;
    const diff = +(act - exp).toFixed(2);
    if (Math.abs(diff) > THRESH) {
      issues.push({ fee: name, expected: +exp.toFixed(2), actual: +act.toFixed(2), diff, overcharged: diff > 0 });
    }
  };

  if (saleRows.length > 0) {
    checkFee('Commission',    expected.commission,    actual.commission);
    checkFee('Fixed Fee',     expected.fixedFee,      actual.fixedFee);
    checkFee('Collection Fee',expected.collectionFee, actual.collectionFee);
  }

  const totalOvercharge  = issues.filter(i =>  i.overcharged).reduce((s, i) => s + i.diff, 0);
  const totalUndercharge = issues.filter(i => !i.overcharged).reduce((s, i) => s + Math.abs(i.diff), 0);

  return {
    orderItemId, orderDate, category, price,
    expectedCommissionRate: expected.commissionRate,
    expectedFees: expected.totalFees,
    issues,
    status: issues.length === 0
      ? (saleRows.length === 0 ? 'no_settlement' : 'ok')
      : (totalOvercharge > 0 ? 'overcharged' : 'undercharged'),
    totalOvercharge:  +totalOvercharge.toFixed(2),
    totalUndercharge: +totalUndercharge.toFixed(2),
  };
}
