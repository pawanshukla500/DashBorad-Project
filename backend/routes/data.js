import express from 'express';
import { getPool } from '../db/index.js';
import { attachRcFees } from '../services/orderFeeService.js';
import { SETT_CTE as SHARED_SETT_CTE } from '../services/settlementSql.js';
import { ORDER_SETTLEMENT_TOTALS_TABLE } from '../services/orderSettlementTotals.js';
import { forEachDbBatch } from '../utils/dbBatch.js';
import { optionalQueryText, pagination, positiveInt } from '../utils/requestParams.js';
import { classifyMyntraNod } from '../services/myntraNodClassification.js';

const router = express.Router();

const ORDER_FEE_TYPES = {
  collection_fee:   { col: 'fk.collection_fee',   label: 'Collection Fee' },
  commission:       { col: 'fk.commission',        label: 'Commission' },
  fixed_fee:        { col: 'fk.fixed_fee',         label: 'Fixed Fee' },
  pick_pack_fee:    { col: 'fk.pick_pack_fee',     label: 'Pick & Pack Fee' },
  shipping_fee:     { col: 'fk.shipping_fee',      label: 'Shipping Fee' },
  reverse_shipping: { col: 'fk.reverse_shipping',  label: 'Reverse Shipping' },
  franchise_fee:    { col: 'fk.franchise_fee',     label: 'Franchise Fee' },
  protection_fund:  { col: 'fk.protection_fund',   label: 'SPF (per-order)' },
  tcs:              { col: 'fk.tcs',               label: 'TCS' },
  tds:              { col: 'fk.tds',               label: 'TDS' },
  gst_on_mp_fees:   { col: 'fk.gst_on_mp_fees',    label: 'GST on MP Fees' },
  mp_other_fee:     { col: '0',                     label: 'Other Amazon Fees' },
};

export function parseMarketplaceFilter(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    const error = new Error('marketplace filter is invalid');
    error.status = 400;
    throw error;
  }

  const marketplace = value.trim().toLowerCase();
  if (!marketplace || marketplace === 'all') return null;
  if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(marketplace)) {
    const error = new Error('marketplace filter is invalid');
    error.status = 400;
    throw error;
  }
  return marketplace;
}

export function parseOrderFeeDetailQuery(query = {}) {
  const fee = typeof query.fee === 'string' ? query.fee.trim() : '';
  if (!ORDER_FEE_TYPES[fee]) {
    const error = new Error(`fee param required. Allowed: ${Object.keys(ORDER_FEE_TYPES).join(', ')}`);
    error.status = 400;
    throw error;
  }
  const month = typeof query.month === 'string' ? query.month.trim() : '';
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
    const error = new Error('month param required (YYYY-MM)');
    error.status = 400;
    throw error;
  }
  return {
    fee,
    month,
    marketplace: parseMarketplaceFilter(query.marketplace),
    limit: positiveInt(query.limit, 500, { max: 2000 }),
  };
}

// The overview contains five independent chart requests.  They are read-only
// and are safe to cache briefly: it avoids repeating expensive aggregate scans
// when a user moves between workspaces or reopens the same dashboard.  Uploads
// remain visible immediately through the manual Refresh button, which sends
// `_refresh` and bypasses the cache.
const DASHBOARD_CACHE_TTL_MS = 45_000;
const dashboardCache = new Map();
const dashboardInFlight = new Map();
const dashboardReadVersions = new Map();
const DASHBOARD_CACHE_PATHS = new Set([
  '/summary',
  '/sales-trend',
  '/category-breakdown',
  '/return-reasons',
  '/top-products',
]);

function dashboardCacheKey(req) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (key !== '_refresh' && value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  return `${req.path}?${params.toString()}`;
}

export function invalidateDashboardReportCache() {
  dashboardCache.clear();
  // A request that began before a write may still finish afterwards. Advancing
  // the version prevents that older response from repopulating the cache.
  for (const [key, version] of dashboardReadVersions) {
    dashboardReadVersions.set(key, version + 1);
  }
}

router.use(async (req, res, next) => {
  if (req.method !== 'GET' || !DASHBOARD_CACHE_PATHS.has(req.path)) return next();

  const key = dashboardCacheKey(req);
  // Any non-empty client refresh token must bypass the cache. FilterContext
  // increments this value, so checking only for "1" made the second and later
  // refreshes unexpectedly serve stale financial totals.
  const forceRefresh = Boolean(req.query?._refresh);
  const version = forceRefresh
    ? (dashboardReadVersions.get(key) || 0) + 1
    : (dashboardReadVersions.get(key) || 0);
  dashboardReadVersions.set(key, version);
  const cached = !forceRefresh && dashboardCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    res.set('X-Report-Cache', 'HIT');
    return res.json(cached.body);
  }

  dashboardCache.delete(key);
  const inFlightKey = `${key}\u001f${version}`;
  const existing = !forceRefresh && dashboardInFlight.get(inFlightKey);
  if (existing) {
    try {
      const result = await existing;
      res.set('X-Report-Cache', 'COALESCED');
      return res.status(result.statusCode).json(result.body);
    } catch {
      // If the source request was disconnected before it produced JSON, serve
      // this caller normally rather than leaving it waiting on a dead promise.
      return next();
    }
  }

  let settle;
  let reject;
  let completed = false;
  const pending = new Promise((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  // Avoid an unhandled rejection when the originating HTTP client disconnects
  // and no other request was waiting for the shared result.
  pending.catch(() => {});
  dashboardInFlight.set(inFlightKey, pending);
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    completed = true;
    dashboardInFlight.delete(inFlightKey);
    const statusCode = res.statusCode;
    if (statusCode >= 200 && statusCode < 300 && dashboardReadVersions.get(key) === version) {
      dashboardCache.set(key, { body, expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS });
      res.set('X-Report-Cache', forceRefresh ? 'REFRESHED' : 'MISS');
    }
    settle({ statusCode, body });
    return sendJson(body);
  };
  res.on('close', () => {
    if (!completed && dashboardInFlight.get(inFlightKey) === pending) {
      dashboardInFlight.delete(inFlightKey);
      reject(new Error('Source request closed before producing a response'));
    }
  });
  return next();
});

// ── Filter helpers ─────────────────────────────────────────────────────────────
// Returns { where: 'AND col=$1 AND col=$2', values: [...] }
// Array.push() returns the new length (1-based), which is exactly the $N we need.
function buildWhere(q, alias = 'o') {
  const conds = [];
  const values = [];
  const isRetJoin = alias.includes('ret');
  const mpCol = isRetJoin ? 'COALESCE(o.marketplace, ret.marketplace)' : `${alias}.marketplace`;
  const saCol = isRetJoin ? 'COALESCE(o.seller_account, ret.seller_account)' : `${alias}.seller_account`;

  if (q.startDate)   { conds.push(`${alias}.order_date >= $${values.push(q.startDate)}`); }
  if (q.endDate)     { conds.push(`${alias}.order_date <= $${values.push(q.endDate)}`); }
  if (q.category)    { conds.push(`COALESCE(${alias}.vb_export_category, ${alias}.category) = $${values.push(q.category)}`); }
  if (q.region)      { conds.push(`${alias}.delivery_state = $${values.push(q.region)}`); }
  if (q.status)      { conds.push(`${alias}.orders_status = $${values.push(q.status)}`); }
  if (q.marketplace && q.marketplace !== 'all') {
    const mp = String(q.marketplace).trim().toLowerCase();
    if (mp === 'myntra_vb') {
      conds.push(`${mpCol} = 'myntra'`);
      conds.push(`COALESCE(${saCol}, 'myntra_vb') = 'myntra_vb'`);
    } else if (mp === 'myntra_ej') {
      conds.push(`${mpCol} = 'myntra'`);
      conds.push(`${saCol} = 'myntra_ej'`);
    } else {
      conds.push(`${mpCol} = $${values.push(mp)}`);
    }
  }
  const sellerAccount = q.sellerAccount || q.seller_account;
  if (sellerAccount && sellerAccount !== 'all' && sellerAccount !== 'default' && sellerAccount !== 'myntra_vb' && sellerAccount !== 'myntra_ej') {
    conds.push(`${saCol} = $${values.push(sellerAccount)}`);
  }
  if (q.brand)       { conds.push(`${alias}.brand_name  = $${values.push(q.brand)}`); }
  return { where: conds.length ? 'AND ' + conds.join(' AND ') : '', values };
}

function periodExpr(groupBy, col) {
  const g = ['day', 'week', 'month'].includes(groupBy) ? groupBy : 'month';
  if (g === 'day')  return `TO_CHAR(${col}, 'YYYY-MM-DD')`;
  if (g === 'week') return `TO_CHAR(${col}, 'IYYY-"W"IW')`;
  return `TO_CHAR(${col}, 'YYYY-MM')`;
}

// Prefer shared SETT_CTE (single money definition)
const SETT_CTE = SHARED_SETT_CTE;

const COGS_UNIT_SQL = `COALESCE(sm_mp.cogs, sm_all.cogs, vsm.cogs, cc_mp.cogs, cc_all.cogs, 0)`;
const COGS_TOTAL_SQL = `(${COGS_UNIT_SQL} * COALESCE(o.qty,1))`;
const MASTER_SKU_SQL = `COALESCE(o.vb_export_sku, sm_mp.master_sku, sm_all.master_sku, o.sku)`;
const COGS_JOINS = `
        LEFT JOIN sku_master sm_mp  ON sm_mp.listing_sku = o.sku AND sm_mp.marketplace = o.marketplace
        LEFT JOIN sku_master sm_all ON sm_all.listing_sku = o.sku AND sm_all.marketplace = 'all'
        LEFT JOIN vb_sku_master vsm ON vsm.vb_export_sku = COALESCE(o.vb_export_sku, sm_mp.master_sku, sm_all.master_sku)
        LEFT JOIN catalog_cogs cc_mp  ON cc_mp.catalog_id = o.fsn AND cc_mp.marketplace = o.marketplace
        LEFT JOIN catalog_cogs cc_all ON cc_all.catalog_id = o.fsn AND cc_all.marketplace = 'all'
`;
const SETT_FEE_SQL = `
            COALESCE(s.commission,0)+COALESCE(s.fixed_fee,0)+COALESCE(s.collection_fee,0)+
            COALESCE(s.pick_pack_fee,0)+COALESCE(s.shipping_fee,0)+COALESCE(s.reverse_shipping,0)+
            COALESCE(s.franchise_fee,0)+COALESCE(s.tcs,0)+COALESCE(s.tds,0)+COALESCE(s.gst_on_mp_fees,0)
`;

function buildDimensionWhere(q, alias = 'o') {
  const { startDate, endDate, groupBy, ...rest } = q || {};
  return buildWhere(rest, alias);
}

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return +asNum(v).toFixed(2);
}

function pct(part, total) {
  return asNum(total) > 0 ? +((asNum(part) / asNum(total)) * 100).toFixed(2) : 0;
}

const STATUS_EXPR = `
  CASE
    WHEN s.order_item_id IS NULL AND (o.orders_status IN ('Cancelled', 'RTO', 'Customer Return', 'Return', 'Refunded', 'Returned') OR o.return_type IS NOT NULL) THEN 'Returned / Cancelled'
    WHEN s.order_item_id IS NULL                                   THEN 'Unsettled'
    WHEN COALESCE(s.net_bank,0) < 0                                THEN 'Clawback'
    WHEN COALESCE(s.net_bank,0)=0 AND s.refund_count > 0           THEN 'Fully Returned'
    WHEN COALESCE(s.net_bank,0)>0 AND s.refund_count > 0           THEN 'Partial Return'
    WHEN COALESCE(s.net_bank,0) > 0                                THEN 'Settled'
    ELSE 'Pending'
  END`;

function settStatusFilter(ss) {
  switch (ss) {
    case 'Settled':        return `AND s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)>0 AND s.refund_count=0`;
    case 'Partial Return': return `AND s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)>0 AND s.refund_count>0`;
    case 'Fully Returned': return `AND s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)=0 AND s.refund_count>0`;
    case 'Clawback':       return `AND s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)<0`;
    case 'Unsettled':      return `AND s.order_item_id IS NULL AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Return', 'Refunded', 'Returned') AND o.return_type IS NULL`;
    case 'Returned / Cancelled': return `AND s.order_item_id IS NULL AND (o.orders_status IN ('Cancelled', 'RTO', 'Customer Return', 'Return', 'Refunded', 'Returned') OR o.return_type IS NOT NULL)`;
    // Refund = Fully Returned + Partial Return + Clawback + Returned/Cancelled combined
    case 'Refund':         return `AND (s.order_item_id IS NOT NULL AND (COALESCE(s.net_bank,0)<0 OR s.refund_count>0) OR (s.order_item_id IS NULL AND (o.orders_status IN ('Cancelled', 'RTO', 'Customer Return', 'Return', 'Refunded', 'Returned') OR o.return_type IS NOT NULL)))`;
    default:               return '';
  }
}

// ── POST /api/fetch ────────────────────────────────────────────────────────────
router.post('/fetch', async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM orders)               AS "ordersCount",
        (SELECT COUNT(*) FROM returns)              AS "returnsCount",
        (SELECT COUNT(*) FROM unified_settlements) AS "settlementsCount"
    `);
    res.json({ ...rows[0], ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/summary ───────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);
    const { rows } = await pool.query(`
      ${SETT_CTE}
      SELECT
        COUNT(*)                                                                   AS "totalOrders",
        COALESCE(SUM(o.final_invoice_amount), 0)                                  AS "totalRevenue",
        COALESCE(SUM(o.final_invoice_amount), 0)                                  AS "totalSaleAmount",
        -- Bank Received = net settlement cash (glossary). Legacy aliases below.
        COALESCE(SUM(COALESCE(s.net_bank,0)), 0)                                  AS "bankReceived",
        COALESCE(SUM(COALESCE(s.commission,0)), 0)                                AS "totalCommission",
        COALESCE(SUM(COALESCE(s.fixed_fee,0)+COALESCE(s.collection_fee,0)+
                     COALESCE(s.pick_pack_fee,0)+COALESCE(s.shipping_fee,0)+
                     COALESCE(s.reverse_shipping,0)+COALESCE(s.franchise_fee,0)+
                     COALESCE(s.tcs,0)+COALESCE(s.tds,0)+COALESCE(s.gst_on_mp_fees,0)), 0) AS "totalFees",
        COUNT(*) FILTER (WHERE s.order_item_id IS NULL AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned') AND o.return_type IS NULL AND ret.order_item_id IS NULL) AS "unsettledCount",
        COALESCE(SUM(o.final_invoice_amount) FILTER (WHERE s.order_item_id IS NULL AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned') AND o.return_type IS NULL AND ret.order_item_id IS NULL), 0) AS "unsettledAmount",
        COUNT(ret.order_item_id)                                                   AS "returnCount",
        SUM(CASE WHEN ret.return_type ILIKE '%customer%' OR ret.return_type = 'Return' THEN 1 ELSE 0 END) AS "customerReturns",
        SUM(CASE WHEN ret.return_type ILIKE '%courier%' OR ret.return_type ILIKE '%rto%' THEN 1 ELSE 0 END) AS "courierReturns",
        -- QC outcome from final_condition, fallback primary_pv_output (not return_reason)
        SUM(CASE WHEN ret.order_item_id IS NOT NULL AND LOWER(COALESCE(NULLIF(TRIM(ret.final_condition),''), NULLIF(TRIM(ret.primary_pv_output),''), ''))
              ~ '(damag|reject|fail|bad|defect|scrap|unsell)' THEN 1 ELSE 0 END) AS "badReturns",
        SUM(CASE WHEN ret.order_item_id IS NOT NULL AND LOWER(COALESCE(NULLIF(TRIM(ret.final_condition),''), NULLIF(TRIM(ret.primary_pv_output),''), ''))
              ~ '(good|sellable|pass|new|unopened|undamaged)'
              AND LOWER(COALESCE(NULLIF(TRIM(ret.final_condition),''), NULLIF(TRIM(ret.primary_pv_output),''), ''))
              !~ '(damag|reject|fail|bad|defect|scrap|unsell)' THEN 1 ELSE 0 END) AS "goodReturns",
        SUM(CASE WHEN ret.order_item_id IS NOT NULL
              AND COALESCE(NULLIF(TRIM(ret.final_condition),''), NULLIF(TRIM(ret.primary_pv_output),''), '') = ''
              THEN 1 ELSE 0 END) AS "pendingCondition"
      FROM orders o
      LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
      LEFT JOIN sett s ON s.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
    `, values);
    const d = rows[0];
    const bankReceived = +(d.bankReceived) || 0;
    res.json({
      ...d,
      bankReceived,
      // Legacy aliases — same value as bankReceived (do not invent a second number)
      myShare: bankReceived,
      totalSettlement: bankReceived,
      goodReturns:       +d.goodReturns       || 0,
      badReturns:        +d.badReturns        || 0,
      pendingCondition:  +d.pendingCondition  || 0,
      unsettledCount:    +d.unsettledCount    || 0,
      unsettledAmount:   +d.unsettledAmount   || 0,
      returnRate:    d.totalOrders > 0 ? (d.returnCount / d.totalOrders) * 100 : 0,
      avgOrderValue: d.totalOrders > 0 ? d.totalRevenue / d.totalOrders : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/marketplace-summary ──────────────────────────────────────────────
router.get('/marketplace-summary', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);
    const { rows } = await pool.query(`
      ${SETT_CTE}
      SELECT
        CASE
          WHEN o.marketplace = 'myntra' THEN COALESCE(o.seller_account, 'myntra_vb')
          ELSE COALESCE(o.marketplace, 'Unknown')
        END                                                                       AS marketplace,
        COUNT(*)                                                                   AS orders,
        COALESCE(SUM(o.final_invoice_amount), 0)                                  AS revenue,
        COALESCE(SUM(COALESCE(s.net_bank,0)), 0)                                  AS "myShare",
        COUNT(ret.order_item_id)                                                  AS returns,
        COALESCE(SUM(COALESCE(s.commission,0)), 0)                                AS commission,
        COALESCE(SUM(
          COALESCE(s.fixed_fee,0)+COALESCE(s.collection_fee,0)+
          COALESCE(s.pick_pack_fee,0)+COALESCE(s.shipping_fee,0)
        ), 0)                                                                     AS fees,
        COALESCE(SUM(COALESCE(s.net_bank,0)), 0)                                  AS settlement
      FROM orders o
      LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
      LEFT JOIN sett s ON s.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
      GROUP BY CASE
        WHEN o.marketplace = 'myntra' THEN COALESCE(o.seller_account, 'myntra_vb')
        ELSE COALESCE(o.marketplace, 'Unknown')
      END
      ORDER BY revenue DESC
    `, values);
    res.json(rows.map(row => ({
      ...row,
      returnRate: row.orders > 0 ? (row.returns / row.orders) * 100 : 0,
      netFees:    +row.commission + +row.fees,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sales-trend ───────────────────────────────────────────────────────
router.get('/sales-trend', async (req, res) => {
  try {
    const pool = getPool();
    const { groupBy = 'month', ...q } = req.query;
    const { where, values } = buildWhere(q);
    const period = periodExpr(groupBy, 'o.order_date');
    const { rows } = await pool.query(`
      ${SETT_CTE}
      SELECT
        ${period}                                  AS period,
        COALESCE(SUM(o.final_invoice_amount), 0)   AS revenue,
        COALESCE(SUM(COALESCE(s.net_bank, 0)), 0)  AS "myShare",
        COUNT(*)                                   AS orders,
        COUNT(ret.order_item_id)                   AS returns
      FROM orders o
      LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
      LEFT JOIN sett s ON s.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
      GROUP BY ${period}
      HAVING COUNT(*) >= 1
      ORDER BY period
    `, values);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/return-trend ──────────────────────────────────────────────────────
router.get('/return-trend', async (req, res) => {
  try {
    const pool = getPool();
    const { groupBy = 'month', ...q } = req.query;
    const { where, values } = buildWhere(q);
    const period = periodExpr(groupBy, 'o.order_date');
    const { rows } = await pool.query(`
      SELECT
        ${period}                                                                AS period,
        COUNT(*)                                                                 AS orders,
        COUNT(ret.order_item_id)                                                AS returns,
        SUM(CASE WHEN ret.return_type ILIKE '%customer%' OR ret.return_type = 'Return' THEN 1 ELSE 0 END) AS "customerReturns",
        SUM(CASE WHEN ret.return_type ILIKE '%courier%' OR ret.return_type ILIKE '%rto%' THEN 1 ELSE 0 END) AS "courierReturns",
        CASE WHEN COUNT(*) > 0
          THEN ROUND((COUNT(ret.order_item_id)::numeric / COUNT(*) * 100), 1)
          ELSE 0 END                                                            AS "returnRate"
      FROM orders o
      LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
      GROUP BY ${period}
      HAVING COUNT(*) >= 5
      ORDER BY period
    `, values);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/category-breakdown ───────────────────────────────────────────────
router.get('/category-breakdown', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);
    const { rows } = await pool.query(`
      ${SETT_CTE}
      SELECT
        COALESCE(o.vb_export_category, o.category, 'Uncategorized')             AS category,
        COUNT(*)                                                                  AS orders,
        COALESCE(SUM(o.final_invoice_amount), 0)                                  AS revenue,
        -- Order uploads are sales evidence, not payment evidence.  Use the
        -- aggregated settlement source so Amazon and Flipkart render the
        -- same bank/fee numbers in this chart.
        COALESCE(SUM(COALESCE(s.net_bank, 0)), 0)                                  AS "myShare",
        COALESCE(SUM(COALESCE(s.commission, 0)), 0)                                AS commission,
        COALESCE(SUM(${SETT_FEE_SQL}), 0)                                          AS fees,
        COALESCE(SUM(COALESCE(s.net_bank, 0)), 0)                                  AS settlement,
        COUNT(ret.order_item_id)                                                  AS returns
      FROM orders o
      LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
      LEFT JOIN sett s ON s.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
      GROUP BY COALESCE(o.vb_export_category, o.category, 'Uncategorized')
      ORDER BY revenue DESC
    `, values);
    res.json(rows.map(c => ({
      ...c,
      returnRate: c.orders > 0 ? (c.returns / c.orders) * 100 : 0,
      net: +c.myShare - +c.commission - +c.fees,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/return-reasons ───────────────────────────────────────────────────
router.get('/return-reasons', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);
    const { rows } = await pool.query(`
      SELECT
        COALESCE(ret.return_reason, 'Unknown') AS reason,
        COUNT(*)                               AS count,
        COALESCE(SUM(o.my_share), 0)           AS amount
      FROM orders o
      INNER JOIN order_returns ret ON ret.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
      GROUP BY COALESCE(ret.return_reason, 'Unknown')
      ORDER BY count DESC
    `, values);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/return-types ─────────────────────────────────────────────────────
router.get('/return-types', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);
    const { rows } = await pool.query(`
      SELECT
        COALESCE(ret.return_type, 'Unknown') AS type,
        COUNT(*)                             AS count
      FROM orders o
      INNER JOIN order_returns ret ON ret.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
      GROUP BY COALESCE(ret.return_type, 'Unknown')
      ORDER BY count DESC
    `, values);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/top-products ─────────────────────────────────────────────────────
router.get('/top-products', async (req, res) => {
  try {
    const pool = getPool();
    const { limit = '10', ...q } = req.query;
    const { where, values } = buildWhere(q);
    const topLimit = Math.min(+limit || 10, 100);
    const { rows } = await pool.query(`
      ${SETT_CTE}
      SELECT
        o.sku, o.fsn, o.category,
        COALESCE(SUM(o.final_invoice_amount), 0) AS revenue,
        COALESCE(SUM(COALESCE(s.net_bank, 0)), 0) AS "myShare",
        SUM(COALESCE(o.qty, 1))                  AS units,
        COUNT(ret.order_item_id)                 AS returns,
        CASE WHEN SUM(COALESCE(o.qty,1)) > 0
          THEN (COUNT(ret.order_item_id)::float / SUM(COALESCE(o.qty,1))::float) * 100
          ELSE 0 END                             AS "returnRate"
      FROM orders o
      LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
      LEFT JOIN sett s ON s.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
      GROUP BY o.sku, o.fsn, o.category
      ORDER BY revenue DESC
      LIMIT $${values.push(topLimit)}
    `, values);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/fee-breakdown ────────────────────────────────────────────────────
router.get('/fee-breakdown', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);
    const { rows } = await pool.query(`
      ${SETT_CTE}
      SELECT
        COALESCE(SUM(COALESCE(s.commission,0)), 0)        AS commission,
        COALESCE(SUM(COALESCE(s.fixed_fee,0)), 0)         AS "fixedFee",
        COALESCE(SUM(COALESCE(s.collection_fee,0)), 0)    AS "collectionFee",
        COALESCE(SUM(COALESCE(s.pick_pack_fee,0)), 0)     AS "pickPackFee",
        COALESCE(SUM(COALESCE(s.shipping_fee,0)), 0)      AS "shippingFee",
        COALESCE(SUM(COALESCE(s.reverse_shipping,0)), 0)  AS "reverseShipping",
        COALESCE(SUM(COALESCE(s.franchise_fee,0)), 0)     AS "franchiseFee",
        COALESCE(SUM(COALESCE(s.tcs,0)), 0)               AS tcs,
        COALESCE(SUM(COALESCE(s.tds,0)), 0)               AS tds,
        COALESCE(SUM(COALESCE(s.gst_on_mp_fees,0)), 0)    AS "gstOnMp"
      FROM orders o
      LEFT JOIN sett s ON s.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
    `, values);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/profit-loss ──────────────────────────────────────────────────────
router.get('/profit-loss', async (req, res) => {
  try {
    const pool = getPool();
    const { groupBy = 'month', ...q } = req.query;
    const { where, values } = buildWhere(q);
    const period = periodExpr(groupBy, 'o.order_date');

    const [sum, trend, byCat] = await Promise.all([
      pool.query(`
        ${SETT_CTE}
        SELECT
          COUNT(*) AS "totalOrders",
          COALESCE(SUM(o.final_invoice_amount),0)                AS "grossRevenue",
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)                AS "bankReceived",
          COALESCE(SUM(COALESCE(s.refund_amount,0)),0)           AS "refundDebited",
          COUNT(ret.order_item_id)                               AS "returnCount",
          SUM(CASE WHEN s.order_item_id IS NULL AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned') AND o.return_type IS NULL AND ret.order_item_id IS NULL THEN o.final_invoice_amount ELSE 0 END) AS "unsettledAmount",
          SUM(CASE WHEN s.order_item_id IS NULL AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned') AND o.return_type IS NULL AND ret.order_item_id IS NULL THEN 1 ELSE 0 END)              AS "unsettledCount",
          COALESCE(SUM(COALESCE(s.commission,0)),0)              AS commission,
          COALESCE(SUM(COALESCE(s.fixed_fee,0)),0)               AS "fixedFee",
          COALESCE(SUM(COALESCE(s.collection_fee,0)),0)          AS "collectionFee",
          COALESCE(SUM(COALESCE(s.pick_pack_fee,0)),0)           AS "pickPackFee",
          COALESCE(SUM(COALESCE(s.shipping_fee,0)),0)            AS "shippingFee",
          COALESCE(SUM(COALESCE(s.reverse_shipping,0)),0)        AS "reverseShipping",
          COALESCE(SUM(COALESCE(s.franchise_fee,0)),0)           AS "franchiseFee",
          COALESCE(SUM(COALESCE(s.tcs,0)),0)                     AS tcs,
          COALESCE(SUM(COALESCE(s.tds,0)),0)                     AS tds,
          COALESCE(SUM(COALESCE(s.gst_on_mp_fees,0)),0)          AS "gstOnMpFees"
        FROM orders o
        LEFT JOIN sett s      ON s.order_item_id = o.order_item_id
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
      `, values),
      pool.query(`
        ${SETT_CTE}
        SELECT
          ${period} AS period,
          COALESCE(SUM(o.final_invoice_amount),0)                AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)                AS "bankReceived",
          COALESCE(SUM(COALESCE(s.refund_amount,0)),0)           AS refunds,
          COALESCE(SUM(COALESCE(s.net_bank,0))-SUM(COALESCE(s.refund_amount,0)),0) AS net
        FROM orders o
        LEFT JOIN sett s ON s.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
        GROUP BY ${period}
        ORDER BY period
      `, values),
      pool.query(`
        ${SETT_CTE}
        SELECT
          COALESCE(o.vb_export_category, o.category, 'Uncategorized') AS category,
          COUNT(*) AS orders,
          COALESCE(SUM(o.final_invoice_amount),0)                AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)                AS "bankReceived",
          COALESCE(SUM(COALESCE(s.refund_amount,0)),0)           AS refunds,
          COALESCE(SUM(COALESCE(s.commission,0)+COALESCE(s.fixed_fee,0)+COALESCE(s.collection_fee,0)+
            COALESCE(s.pick_pack_fee,0)+COALESCE(s.shipping_fee,0)+COALESCE(s.reverse_shipping,0)+
            COALESCE(s.tcs,0)+COALESCE(s.tds,0)+COALESCE(s.gst_on_mp_fees,0)),0) AS deductions,
          COUNT(ret.order_item_id) AS returns
        FROM orders o
        LEFT JOIN sett s      ON s.order_item_id = o.order_item_id
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
        GROUP BY COALESCE(o.vb_export_category, o.category, 'Uncategorized')
        ORDER BY revenue DESC
      `, values),
    ]);

    const d = sum.rows[0];
    const netBank = +d.bankReceived - +d.refundDebited;
    const totalDeductions = +d.commission + +d.fixedFee + +d.collectionFee + +d.pickPackFee +
      +d.shippingFee + +d.reverseShipping + +d.franchiseFee + +d.tcs + +d.tds + +d.gstOnMpFees;

    res.json({
      summary: {
        grossRevenue: +d.grossRevenue, bankReceived: +d.bankReceived, totalDeductions,
        refundDebited: +d.refundDebited, netBank, unsettledAmount: +d.unsettledAmount,
        unsettledCount: +d.unsettledCount, returnCount: +d.returnCount, totalOrders: +d.totalOrders,
        returnRate:  d.totalOrders > 0 ? (+d.returnCount / +d.totalOrders) * 100 : 0,
        marginPct:   d.grossRevenue > 0 ? (netBank / +d.grossRevenue) * 100 : 0,
      },
      fees: {
        commission: +d.commission, fixedFee: +d.fixedFee, collectionFee: +d.collectionFee,
        pickPackFee: +d.pickPackFee, shippingFee: +d.shippingFee, reverseShipping: +d.reverseShipping,
        tcs: +d.tcs, tds: +d.tds, gstOnMpFees: +d.gstOnMpFees, franchiseFee: +d.franchiseFee,
      },
      trend: trend.rows,
      byCategory: byCat.rows.map(c => ({
        ...c,
        net:        +c.bankReceived - +c.refunds,
        returnRate: c.orders > 0 ? (+c.returns / +c.orders) * 100 : 0,
        margin:     c.revenue > 0 ? ((+c.bankReceived - +c.refunds) / +c.revenue) * 100 : 0,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/platform/summary
// One command-center payload for reconciliation readiness, payment gaps, returns, COGS
// coverage, marketplace performance, and sampled rate-card variance checks.
router.get('/platform/summary', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);
    const { where: dimensionWhere, values: dimensionValues } = buildDimensionWhere(req.query);

    const [summaryRes, marketplaceRes, uploadsRes, coverageRes, unsettledRes, catDriversRes, skuDriversRes, rateRowsRes] = await Promise.all([
      pool.query(`
        ${SETT_CTE}
        SELECT
          COUNT(*) AS "totalOrders",
          COALESCE(SUM(o.final_invoice_amount),0) AS "grossRevenue",
          COALESCE(SUM(COALESCE(s.net_bank,0)),0) AS "bankReceived",
          COALESCE(SUM(COALESCE(s.refund_amount,0)),0) AS "totalRefunds",
          COALESCE(SUM(${COGS_TOTAL_SQL}),0) AS "totalCogs",
          COALESCE(SUM(${SETT_FEE_SQL}),0) AS "totalFees",
          COUNT(DISTINCT ret.order_item_id) AS "returnCount",
          COUNT(*) FILTER (WHERE ${COGS_UNIT_SQL} > 0) AS "cogsCoveredOrders"
        FROM orders o
        LEFT JOIN sett s ON s.order_item_id = o.order_item_id
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        ${COGS_JOINS}
        WHERE 1=1 ${where}
      `, values),

      pool.query(`
        ${SETT_CTE}
        SELECT
          COALESCE(o.marketplace,'Unknown') AS marketplace,
          COUNT(*) AS orders,
          COALESCE(SUM(o.final_invoice_amount),0) AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)),0) AS "bankReceived",
          COALESCE(SUM(COALESCE(s.refund_amount,0)),0) AS refunds,
          COALESCE(SUM(${COGS_TOTAL_SQL}),0) AS cogs,
          COALESCE(SUM(${SETT_FEE_SQL}),0) AS fees,
          COUNT(DISTINCT ret.order_item_id) AS returns,
          COUNT(*) FILTER (WHERE ${COGS_UNIT_SQL} > 0) AS "cogsCoveredOrders"
        FROM orders o
        LEFT JOIN sett s ON s.order_item_id = o.order_item_id
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        ${COGS_JOINS}
        WHERE 1=1 ${where}
        GROUP BY COALESCE(o.marketplace,'Unknown')
        ORDER BY revenue DESC
      `, values),

      pool.query(`
        SELECT DISTINCT ON (marketplace, data_type)
          marketplace, data_type AS "dataType", filename, uploaded_at AS "uploadedAt",
          rows_inserted AS "rowsInserted", rows_updated AS "rowsUpdated",
          rows_skipped AS "rowsSkipped", status, error_msg AS "errorMsg"
        FROM upload_log
        ORDER BY marketplace, data_type, uploaded_at DESC
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT
          COUNT(DISTINCT o.sku) FILTER (WHERE o.sku IS NOT NULL AND o.sku <> '') AS "skuCount",
          COUNT(DISTINCT o.sku) FILTER (
            WHERE o.sku IS NOT NULL AND o.sku <> ''
              AND NOT EXISTS (
                SELECT 1 FROM sku_master sm
                WHERE sm.listing_sku = o.sku
                  AND (sm.marketplace = o.marketplace OR sm.marketplace = 'all')
              )
          ) AS "missingSkuCount",
          COUNT(DISTINCT o.fsn) FILTER (WHERE o.fsn IS NOT NULL AND o.fsn <> '') AS "catalogCount",
          COUNT(DISTINCT o.fsn) FILTER (
            WHERE o.fsn IS NOT NULL AND o.fsn <> ''
              AND NOT EXISTS (
                SELECT 1 FROM catalog_cogs cc
                WHERE cc.catalog_id = o.fsn
                  AND (cc.marketplace = o.marketplace OR cc.marketplace = 'all')
              )
          ) AS "missingCatalogCount",
          COUNT(*) FILTER (WHERE ${COGS_UNIT_SQL} = 0) AS "profitGapOrders"
        FROM orders o
        ${COGS_JOINS}
        WHERE 1=1 ${where}
      `, values),

      pool.query(`
        SELECT
          COUNT(*) AS "unsettledCount",
          COALESCE(SUM(o.final_invoice_amount),0) AS "unsettledAmount"
        FROM orders o
        WHERE 1=1 ${where}
          AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned')
          AND o.return_type IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${ORDER_SETTLEMENT_TOTALS_TABLE} fs WHERE fs.order_item_id = o.order_item_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM returns r WHERE r.order_item_id = o.order_item_id
          )
      `, values),

      pool.query(`
        WITH bounds AS (
          SELECT COALESCE(MAX(o.order_date), CURRENT_DATE) AS anchor
          FROM orders o
          WHERE 1=1 ${dimensionWhere}
        )
        SELECT
          COALESCE(o.vb_export_category, o.category, 'Uncategorized') AS dimension,
          COUNT(*) FILTER (
            WHERE o.order_date > b.anchor - INTERVAL '30 days' AND o.order_date <= b.anchor
          ) AS "currentOrders",
          COUNT(DISTINCT ret.order_item_id) FILTER (
            WHERE o.order_date > b.anchor - INTERVAL '30 days' AND o.order_date <= b.anchor
          ) AS "currentReturns",
          COUNT(*) FILTER (
            WHERE o.order_date > b.anchor - INTERVAL '60 days' AND o.order_date <= b.anchor - INTERVAL '30 days'
          ) AS "previousOrders",
          COUNT(DISTINCT ret.order_item_id) FILTER (
            WHERE o.order_date > b.anchor - INTERVAL '60 days' AND o.order_date <= b.anchor - INTERVAL '30 days'
          ) AS "previousReturns",
          MAX(NULLIF(ret.return_reason,'')) FILTER (
            WHERE o.order_date > b.anchor - INTERVAL '30 days' AND o.order_date <= b.anchor
          ) AS "sampleReason"
        FROM orders o
        CROSS JOIN bounds b
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        WHERE 1=1 ${dimensionWhere}
        GROUP BY COALESCE(o.vb_export_category, o.category, 'Uncategorized')
        HAVING COUNT(*) FILTER (
          WHERE o.order_date > b.anchor - INTERVAL '30 days' AND o.order_date <= b.anchor
        ) > 0
        ORDER BY "currentReturns" DESC, "currentOrders" DESC
        LIMIT 12
      `, dimensionValues),

      pool.query(`
        WITH bounds AS (
          SELECT COALESCE(MAX(o.order_date), CURRENT_DATE) AS anchor
          FROM orders o
          WHERE 1=1 ${dimensionWhere}
        )
        SELECT
          COALESCE(o.sku,'Unknown') AS dimension,
          MAX(o.fsn) AS "catalogId",
          MAX(COALESCE(o.vb_export_category, o.category, 'Uncategorized')) AS category,
          COUNT(*) FILTER (
            WHERE o.order_date > b.anchor - INTERVAL '30 days' AND o.order_date <= b.anchor
          ) AS "currentOrders",
          COUNT(DISTINCT ret.order_item_id) FILTER (
            WHERE o.order_date > b.anchor - INTERVAL '30 days' AND o.order_date <= b.anchor
          ) AS "currentReturns",
          COUNT(*) FILTER (
            WHERE o.order_date > b.anchor - INTERVAL '60 days' AND o.order_date <= b.anchor - INTERVAL '30 days'
          ) AS "previousOrders",
          COUNT(DISTINCT ret.order_item_id) FILTER (
            WHERE o.order_date > b.anchor - INTERVAL '60 days' AND o.order_date <= b.anchor - INTERVAL '30 days'
          ) AS "previousReturns",
          MAX(NULLIF(ret.return_reason,'')) FILTER (
            WHERE o.order_date > b.anchor - INTERVAL '30 days' AND o.order_date <= b.anchor
          ) AS "sampleReason"
        FROM orders o
        CROSS JOIN bounds b
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        WHERE 1=1 ${dimensionWhere}
        GROUP BY COALESCE(o.sku,'Unknown')
        HAVING COUNT(*) FILTER (
          WHERE o.order_date > b.anchor - INTERVAL '30 days' AND o.order_date <= b.anchor
        ) > 0
        ORDER BY "currentReturns" DESC, "currentOrders" DESC
        LIMIT 15
      `, dimensionValues),

      pool.query(`
        ${SETT_CTE}
        SELECT
          o.order_item_id AS "orderItemId",
          o.order_id AS "orderId",
          o.sku,
          o.category,
          COALESCE(o.marketplace,'flipkart') AS marketplace,
          COALESCE(o.seller_account,'default') AS "sellerAccount",
          COALESCE(o.final_invoice_amount,0) AS "finalInvoiceAmount",
          o.fulfilment_type AS "fulfilmentType",
          o.shipping_zone AS "shippingZone",
          o.order_type AS "orderType",
          o.order_date AS "orderDate",
          o.brand_name AS "brandName",
          COALESCE(s.commission,0) AS commission,
          COALESCE(s.fixed_fee,0) AS "fixedFee",
          COALESCE(s.collection_fee,0) AS "collectionFee",
          COALESCE(s.pick_pack_fee,0) AS "pickPackFee",
          COALESCE(s.franchise_fee,0) AS "franchiseFee",
          COALESCE(s.gst_on_mp_fees,0) AS "gstOnFees",
          COALESCE(s.tcs,0) AS tcs,
          COALESCE(s.tds,0) AS tds
        FROM orders o
        JOIN sett s ON s.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
          AND COALESCE(s.net_bank,0) > 0
        ORDER BY o.order_date DESC NULLS LAST, o.order_item_id
        LIMIT 800
      `, values),
    ]);

    const d = summaryRes.rows[0] || {};
    const unsettled = unsettledRes.rows[0] || {};
    const coverage = coverageRes.rows[0] || {};
    const bankReceived = asNum(d.bankReceived);
    const totalRefunds = asNum(d.totalRefunds);
    const totalCogs = asNum(d.totalCogs);
    const grossRevenue = asNum(d.grossRevenue);
    const netBank = round2(bankReceived - totalRefunds);
    const grossProfit = round2(netBank - totalCogs);

    const marketplace = marketplaceRes.rows.map(row => {
      const net = asNum(row.bankReceived) - asNum(row.refunds);
      const profit = net - asNum(row.cogs);
      return {
        ...row,
        orders: asNum(row.orders),
        revenue: round2(row.revenue),
        bankReceived: round2(row.bankReceived),
        refunds: round2(row.refunds),
        cogs: round2(row.cogs),
        fees: round2(row.fees),
        netBank: round2(net),
        grossProfit: round2(profit),
        returnRate: pct(row.returns, row.orders),
        profitMarginPct: pct(profit, row.revenue),
        cogsCoveragePct: pct(row.cogsCoveredOrders, row.orders),
      };
    });

    const enrichDriver = (row) => {
      const currentRate = pct(row.currentReturns, row.currentOrders);
      const previousRate = pct(row.previousReturns, row.previousOrders);
      return {
        ...row,
        currentOrders: asNum(row.currentOrders),
        currentReturns: asNum(row.currentReturns),
        previousOrders: asNum(row.previousOrders),
        previousReturns: asNum(row.previousReturns),
        currentRate,
        previousRate,
        deltaPct: round2(currentRate - previousRate),
      };
    };

    const returnDrivers = {
      categories: catDriversRes.rows.map(enrichDriver).sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct)).slice(0, 8),
      skus: skuDriversRes.rows.map(enrichDriver).sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct)).slice(0, 10),
    };

    const rateRows = rateRowsRes.rows || [];
    const rcKeys = [...new Set(rateRows.map(row => `${row.marketplace || 'flipkart'}:${row.sellerAccount || 'default'}`))];
    const rcMap = {};
    await Promise.all(rcKeys.map(async key => {
      const [marketplaceName, sellerAccount] = key.split(':');
      rcMap[key] = await getRateCard(marketplaceName, sellerAccount).catch(() => null);
    }));

    const rateIssues = [];
    for (const row of rateRows) {
      const rc = rcMap[`${row.marketplace || 'flipkart'}:${row.sellerAccount || 'default'}`];
      if (!rc) continue;
      const price = asNum(row.finalInvoiceAmount);
      const expected = calculateFees(rc, {
        category: row.category,
        price,
        fulfilmentType: row.fulfilmentType,
        zone: row.shippingZone || 'national',
        paymentType: row.orderType || 'prepaid',
        orderDate: row.orderDate,
        brandName: row.brandName,
      });
      const checks = [
        ['Commission', expected.commission, row.commission],
        ['Fixed Fee', expected.fixedFee, row.fixedFee],
        ['Collection Fee', expected.collectionFee, row.collectionFee],
        ['Pick & Pack', expected.pickPack, row.pickPackFee],
        ['Franchise Fee', expected.franchiseFee, row.franchiseFee],
        ['GST on Fees', expected.gstOnFees, row.gstOnFees],
        ['TCS', expected.tcs, row.tcs],
        ['TDS', +(price * 0.001).toFixed(2), row.tds],
      ];
      for (const [fee, expectedValue, actualValue] of checks) {
        if (expectedValue == null) continue;
        const actual = asNum(actualValue);
        const diff = round2(actual - asNum(expectedValue));
        if (Math.abs(diff) >= 2) {
          rateIssues.push({
            orderItemId: row.orderItemId,
            orderId: row.orderId,
            marketplace: row.marketplace,
            sellerAccount: row.sellerAccount,
            sku: row.sku,
            category: row.category,
            fee,
            expected: round2(expectedValue),
            actual: round2(actual),
            diff,
            status: diff > 0 ? 'overcharged' : 'undercharged',
          });
        }
      }
    }

    rateIssues.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    const totalVariance = rateIssues.reduce((sum, issue) => sum + issue.diff, 0);
    const overcharged = rateIssues.filter(i => i.diff > 0).reduce((sum, issue) => sum + issue.diff, 0);
    const undercharged = rateIssues.filter(i => i.diff < 0).reduce((sum, issue) => sum + Math.abs(issue.diff), 0);

    res.json({
      summary: {
        totalOrders: asNum(d.totalOrders),
        grossRevenue: round2(grossRevenue),
        bankReceived: round2(bankReceived),
        totalRefunds: round2(totalRefunds),
        totalCogs: round2(totalCogs),
        totalFees: round2(d.totalFees),
        netBank,
        grossProfit,
        profitMarginPct: pct(grossProfit, grossRevenue),
        returnCount: asNum(d.returnCount),
        returnRate: pct(d.returnCount, d.totalOrders),
        unsettledCount: asNum(unsettled.unsettledCount),
        unsettledAmount: round2(unsettled.unsettledAmount),
        cogsCoveragePct: pct(d.cogsCoveredOrders, d.totalOrders),
      },
      marketplace,
      uploads: uploadsRes.rows,
      coverage: {
        skuCount: asNum(coverage.skuCount),
        missingSkuCount: asNum(coverage.missingSkuCount),
        catalogCount: asNum(coverage.catalogCount),
        missingCatalogCount: asNum(coverage.missingCatalogCount),
        profitGapOrders: asNum(coverage.profitGapOrders),
      },
      rateAudit: {
        checked: rateRows.length,
        issueCount: rateIssues.length,
        totalVariance: round2(totalVariance),
        overcharged: round2(overcharged),
        undercharged: round2(undercharged),
        topIssues: rateIssues.slice(0, 12),
      },
      returnDrivers,
    });
  } catch (err) {
    console.error('[platform/summary]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/profit-analysis ──────────────────────────────────────────────────
// Full profit view: Revenue – FK-actual fees – COGS = Gross Profit
// Includes RC-calculated expected fees for comparison.
// Groups: overall summary + by category + by month + by SKU (top 20) + by account (Myntra brands)
router.get('/profit-analysis', async (req, res) => {
  try {
    const pool = getPool();
    const { groupBy = 'month', sellerAccount, ...q } = req.query;
    const { where, values } = buildWhere(q);
    const period = periodExpr(groupBy, 'o.order_date');

    // Extra filter for seller_account (Myntra brand analysis)
    let acctWhere = '';
    if (sellerAccount && sellerAccount !== 'all') {
      acctWhere = ` AND COALESCE(o.seller_account,'default') = $${values.push(sellerAccount)}`;
    }

    const [sumRes, trendRes, catRes, skuRes, accountRes, zoneRes, vbSkuRes, unmergedRes] = await Promise.all([

      // ── Overall summary ──────────────────────────────────────────────────────
      pool.query(`
        ${SETT_CTE}
        SELECT
          COUNT(*)                                                AS "totalOrders",
          COALESCE(SUM(o.final_invoice_amount),0)                AS "grossRevenue",
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)                AS "bankReceived",
          COALESCE(SUM(COALESCE(s.refund_amount,0)),0)           AS "totalRefunds",
          COALESCE(SUM(${COGS_TOTAL_SQL}), 0) AS "totalCogs",
          -- FK-actual fees from settlement
          COALESCE(SUM(COALESCE(s.commission,0)),0)              AS "fkCommission",
          COALESCE(SUM(COALESCE(s.fixed_fee,0)),0)               AS "fkFixedFee",
          COALESCE(SUM(COALESCE(s.collection_fee,0)),0)          AS "fkCollectionFee",
          COALESCE(SUM(COALESCE(s.pick_pack_fee,0)),0)           AS "fkPickPack",
          COALESCE(SUM(COALESCE(s.shipping_fee,0)),0)            AS "fkShipping",
          COALESCE(SUM(COALESCE(s.reverse_shipping,0)),0)        AS "fkReverseShipping",
          COALESCE(SUM(COALESCE(s.tcs,0)),0)                     AS "fkTcs",
          COALESCE(SUM(COALESCE(s.tds,0)),0)                     AS "fkTds",
          COALESCE(SUM(COALESCE(s.gst_on_mp_fees,0)),0)          AS "fkGstOnFees",
          COUNT(ret.order_item_id)                               AS "returnCount",
          COUNT(DISTINCT COALESCE(o.seller_account,'default'))   AS "accountCount"
        FROM orders o
        LEFT JOIN sett s        ON s.order_item_id  = o.order_item_id
        LEFT JOIN order_returns ret   ON ret.order_item_id = o.order_item_id
        ${COGS_JOINS}
        WHERE 1=1 ${where}${acctWhere}
      `, values),

      // ── Trend by period ──────────────────────────────────────────────────────
      pool.query(`
        ${SETT_CTE}
        SELECT
          ${period}                                              AS period,
          COUNT(*)                                               AS orders,
          COALESCE(SUM(o.final_invoice_amount),0)               AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)               AS "bankReceived",
          COALESCE(SUM(COALESCE(s.refund_amount,0)),0)          AS refunds,
          COALESCE(SUM(${COGS_TOTAL_SQL}), 0) AS cogs,
          COALESCE(SUM(
            COALESCE(s.commission,0)+COALESCE(s.fixed_fee,0)+COALESCE(s.collection_fee,0)+
            COALESCE(s.pick_pack_fee,0)+COALESCE(s.shipping_fee,0)+COALESCE(s.reverse_shipping,0)+
            COALESCE(s.tcs,0)+COALESCE(s.tds,0)+COALESCE(s.gst_on_mp_fees,0)
          ),0)                                                   AS "fkTotalFees"
        FROM orders o
        LEFT JOIN sett s        ON s.order_item_id  = o.order_item_id
        ${COGS_JOINS}
        WHERE 1=1 ${where}${acctWhere}
        GROUP BY ${period}
        ORDER BY period
      `, values),

      // ── By category ──────────────────────────────────────────────────────────
      pool.query(`
        ${SETT_CTE}
        SELECT
          COALESCE(o.vb_export_category, vsm.category, sm_all.category, sm_mp.category, o.category, 'Uncategorized') AS category,
          COUNT(*)                                              AS orders,
          COALESCE(SUM(o.final_invoice_amount),0)              AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)              AS "bankReceived",
          COALESCE(SUM(COALESCE(s.refund_amount,0)),0)         AS refunds,
          COALESCE(SUM(${COGS_TOTAL_SQL}), 0) AS cogs,
          COALESCE(SUM(COALESCE(s.commission,0)),0)            AS commission,
          COALESCE(SUM(COALESCE(s.fixed_fee,0)),0)             AS "fixedFee",
          COALESCE(SUM(COALESCE(s.collection_fee,0)),0)        AS "collectionFee",
          COALESCE(SUM(
            COALESCE(s.commission,0)+COALESCE(s.fixed_fee,0)+COALESCE(s.collection_fee,0)+
            COALESCE(s.pick_pack_fee,0)+COALESCE(s.shipping_fee,0)+COALESCE(s.reverse_shipping,0)+
            COALESCE(s.tcs,0)+COALESCE(s.tds,0)+COALESCE(s.gst_on_mp_fees,0)
          ),0)                                                 AS "fkTotalFees",
          COUNT(ret.order_item_id)                             AS returns
        FROM orders o
        LEFT JOIN sett s        ON s.order_item_id  = o.order_item_id
        LEFT JOIN order_returns ret   ON ret.order_item_id = o.order_item_id
        ${COGS_JOINS}
        WHERE 1=1 ${where}${acctWhere}
        GROUP BY COALESCE(o.vb_export_category, vsm.category, sm_all.category, sm_mp.category, o.category, 'Uncategorized')
        ORDER BY revenue DESC
      `, values),

      // ── Top SKUs by revenue ───────────────────────────────────────────────────
      pool.query(`
        ${SETT_CTE}
        SELECT
          o.sku,
          ${MASTER_SKU_SQL} AS "masterSku",
          COALESCE(o.vb_export_category, vsm.category, sm_all.category, sm_mp.category, o.category, 'Uncategorized') AS category,
          COUNT(*)                                              AS orders,
          SUM(COALESCE(o.qty,1))                               AS units,
          COALESCE(SUM(o.final_invoice_amount),0)              AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)              AS "bankReceived",
          COALESCE(SUM(${COGS_TOTAL_SQL}), 0) AS cogs,
          COALESCE(SUM(
            COALESCE(s.commission,0)+COALESCE(s.fixed_fee,0)+COALESCE(s.collection_fee,0)+
            COALESCE(s.pick_pack_fee,0)+COALESCE(s.shipping_fee,0)+COALESCE(s.reverse_shipping,0)+
            COALESCE(s.tcs,0)+COALESCE(s.tds,0)+COALESCE(s.gst_on_mp_fees,0)
          ),0)                                                  AS "fkTotalFees",
          COUNT(ret.order_item_id)                              AS returns
        FROM orders o
        LEFT JOIN sett s        ON s.order_item_id  = o.order_item_id
        LEFT JOIN order_returns ret   ON ret.order_item_id = o.order_item_id
        ${COGS_JOINS}
        WHERE 1=1 ${where}${acctWhere}
        GROUP BY o.sku, ${MASTER_SKU_SQL}, COALESCE(o.vb_export_category, vsm.category, sm_all.category, sm_mp.category, o.category, 'Uncategorized')
        ORDER BY revenue DESC
        LIMIT 30
      `, values),

      // ── By seller account (Myntra brand breakdown) ────────────────────────────
      pool.query(`
        ${SETT_CTE}
        SELECT
          COALESCE(o.seller_account,'default')                  AS "sellerAccount",
          COUNT(*)                                              AS orders,
          COALESCE(SUM(o.final_invoice_amount),0)              AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)              AS "bankReceived",
          COALESCE(SUM(COALESCE(s.refund_amount,0)),0)         AS refunds,
          COALESCE(SUM(${COGS_TOTAL_SQL}), 0) AS cogs,
          COALESCE(SUM(
            COALESCE(s.commission,0)+COALESCE(s.fixed_fee,0)+COALESCE(s.collection_fee,0)+
            COALESCE(s.pick_pack_fee,0)+COALESCE(s.shipping_fee,0)+COALESCE(s.reverse_shipping,0)+
            COALESCE(s.tcs,0)+COALESCE(s.tds,0)+COALESCE(s.gst_on_mp_fees,0)
          ),0)                                                 AS "fkTotalFees",
          COUNT(ret.order_item_id)                             AS returns
        FROM orders o
        LEFT JOIN sett s        ON s.order_item_id  = o.order_item_id
        LEFT JOIN order_returns ret   ON ret.order_item_id = o.order_item_id
        ${COGS_JOINS}
        WHERE 1=1 ${where}
        GROUP BY COALESCE(o.seller_account,'default')
        ORDER BY revenue DESC
      `, values.filter((_, i) => i < values.length - (sellerAccount && sellerAccount !== 'all' ? 1 : 0))),

      // ── By shipping zone ──────────────────────────────────────────────────────
      pool.query(`
        ${SETT_CTE}
        SELECT
          COALESCE(o.shipping_zone,'Unknown')                   AS "shippingZone",
          COUNT(*)                                              AS orders,
          COALESCE(SUM(o.final_invoice_amount),0)              AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)              AS "bankReceived",
          COALESCE(SUM(COALESCE(s.refund_amount,0)),0)         AS refunds,
          COALESCE(SUM(${COGS_TOTAL_SQL}), 0) AS cogs,
          COALESCE(SUM(
            COALESCE(s.commission,0)+COALESCE(s.fixed_fee,0)+COALESCE(s.collection_fee,0)+
            COALESCE(s.pick_pack_fee,0)+COALESCE(s.shipping_fee,0)+COALESCE(s.reverse_shipping,0)+
            COALESCE(s.tcs,0)+COALESCE(s.tds,0)+COALESCE(s.gst_on_mp_fees,0)
          ),0)                                                 AS "fkTotalFees",
          COUNT(ret.order_item_id)                             AS returns
        FROM orders o
        LEFT JOIN sett s        ON s.order_item_id  = o.order_item_id
        LEFT JOIN order_returns ret   ON ret.order_item_id = o.order_item_id
        ${COGS_JOINS}
        WHERE 1=1 ${where}${acctWhere}
        GROUP BY COALESCE(o.shipping_zone,'Unknown')
        ORDER BY revenue DESC
      `, values),
      // ── By VB EXPORT SKU (Consolidated Product Profitability) ────────────────
      pool.query(`
        ${SETT_CTE}
        SELECT
          COALESCE(o.vb_export_sku, sm_all.master_sku, sm_mp.master_sku, o.sku) AS "vbExportSku",
          COALESCE(o.vb_export_category, vsm.category, sm_all.category, sm_mp.category, o.category, 'Uncategorized') AS category,
          COALESCE(vsm.weight_slab, sm_all.weight_slab, sm_mp.weight_slab) AS "weightSlab",
          COALESCE(vsm.cogs, sm_all.cogs, sm_mp.cogs, 0) AS "cogsPerUnit",
          COUNT(*)                                              AS orders,
          SUM(COALESCE(o.qty,1))                                AS units,
          COALESCE(SUM(o.final_invoice_amount),0)               AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)               AS "bankReceived",
          COALESCE(SUM(${COGS_TOTAL_SQL}), 0)                   AS cogs,
          COALESCE(SUM(${SETT_FEE_SQL}),0)                      AS "fkTotalFees",
          COUNT(ret.order_item_id)                              AS returns,
          COUNT(DISTINCT o.sku)                                 AS "listingCount",
          ARRAY_AGG(DISTINCT o.sku) FILTER (WHERE o.sku IS NOT NULL) AS "listingSkus"
        FROM orders o
        LEFT JOIN sett s        ON s.order_item_id  = o.order_item_id
        LEFT JOIN order_returns ret   ON ret.order_item_id = o.order_item_id
        ${COGS_JOINS}
        WHERE 1=1 ${where}${acctWhere}
        GROUP BY
          COALESCE(o.vb_export_sku, sm_all.master_sku, sm_mp.master_sku, o.sku),
          COALESCE(o.vb_export_category, vsm.category, sm_all.category, sm_mp.category, o.category, 'Uncategorized'),
          COALESCE(vsm.weight_slab, sm_all.weight_slab, sm_mp.weight_slab),
          COALESCE(vsm.cogs, sm_all.cogs, sm_mp.cogs, 0)
        ORDER BY revenue DESC
        LIMIT 100
      `, values),

      // ── Unmerged marketplace listings check (Trigger Alert) ─────────────────
      pool.query(`
        SELECT
          COUNT(DISTINCT o.sku)                    AS "unmergedSkuCount",
          COUNT(o.order_item_id)                   AS "unmergedOrderCount",
          COALESCE(SUM(o.final_invoice_amount), 0) AS "unmergedRevenue"
        FROM orders o
        LEFT JOIN sku_master sm ON sm.listing_sku = o.sku
        WHERE 1=1 ${where}${acctWhere}
          AND (o.vb_export_sku IS NULL OR sm.listing_sku IS NULL)
      `, values),
    ]);

    // Build summary
    const d = sumRes.rows[0];
    const bankReceived   = +d.bankReceived;
    const totalRefunds   = +d.totalRefunds;
    const totalCogs      = +d.totalCogs;
    const fkTotalFees    = +d.fkCommission + +d.fkFixedFee + +d.fkCollectionFee +
                           +d.fkPickPack + +d.fkShipping + +d.fkReverseShipping +
                           +d.fkTcs + +d.fkTds + +d.fkGstOnFees;
    const netBank        = +(bankReceived - totalRefunds).toFixed(2);
    const grossProfit    = +(netBank - totalCogs).toFixed(2);
    const grossRevenue   = +d.grossRevenue;
    const profitMarginPct= grossRevenue > 0 ? +((grossProfit / grossRevenue) * 100).toFixed(2) : 0;

    // Enrich trend
    const trend = trendRes.rows.map(r => {
      const net = +r.bankReceived - +r.refunds;
      const gp  = +(net - +r.cogs).toFixed(2);
      return { ...r, netBank: +net.toFixed(2), grossProfit: gp, profitMarginPct: +r.revenue > 0 ? +((gp / +r.revenue) * 100).toFixed(2) : 0 };
    });

    // Enrich category
    const byCategory = catRes.rows.map(r => {
      const net = +r.bankReceived - +r.refunds;
      const gp  = +(net - +r.cogs).toFixed(2);
      return { ...r, netBank: +net.toFixed(2), grossProfit: gp, returnRate: +r.orders > 0 ? +((+r.returns/+r.orders)*100).toFixed(1) : 0 };
    });

    // Enrich SKUs
    const bySkuTop = skuRes.rows.map(r => {
      const net     = +r.bankReceived;
      const gp      = +(net - +r.cogs).toFixed(2);
      const gpPerUnit = +r.units > 0 ? +(gp / +r.units).toFixed(2) : 0;
      const cogsPerUnit = +r.units > 0 ? +(+r.cogs / +r.units).toFixed(2) : 0;
      return { ...r, netBank: net, grossProfit: gp, gpPerUnit, cogsPerUnit,
        returnRate: +r.orders > 0 ? +((+r.returns/+r.orders)*100).toFixed(1) : 0,
        hasCogs: +r.cogs > 0 };
    });

    // Enrich by account
    const byAccount = accountRes.rows.map(r => {
      const net = +r.bankReceived - +r.refunds;
      const gp  = +(net - +r.cogs).toFixed(2);
      return { ...r, netBank: +net.toFixed(2), grossProfit: gp, returnRate: +r.orders > 0 ? +((+r.returns/+r.orders)*100).toFixed(1) : 0 };
    });

    // Enrich by zone
    const byZone = zoneRes.rows.map(r => {
      const net = +r.bankReceived - +r.refunds;
      const gp  = +(net - +r.cogs).toFixed(2);
      return { ...r, netBank: +net.toFixed(2), grossProfit: gp, returnRate: +r.orders > 0 ? +((+r.returns/+r.orders)*100).toFixed(1) : 0 };
    });

    // Enrich by VB EXPORT SKU
    const byVbSkuTop = (vbSkuRes?.rows || []).map(r => {
      const net = +r.bankReceived;
      const gp = +(net - +r.cogs).toFixed(2);
      const gpPerUnit = +r.units > 0 ? +(gp / +r.units).toFixed(2) : 0;
      const cogsPerUnit = +r.cogsPerUnit || (+r.units > 0 ? +(+r.cogs / +r.units).toFixed(2) : 0);
      const marginPct = +r.revenue > 0 ? +((gp / +r.revenue) * 100).toFixed(1) : 0;
      const returnRate = +r.orders > 0 ? +((+r.returns / +r.orders) * 100).toFixed(1) : 0;
      return {
        ...r,
        orders: +r.orders,
        units: +r.units,
        revenue: +r.revenue,
        bankReceived: net,
        cogs: +r.cogs,
        fkTotalFees: +r.fkTotalFees,
        returns: +r.returns,
        grossProfit: gp,
        gpPerUnit,
        cogsPerUnit,
        marginPct,
        returnRate,
        hasCogs: +r.cogs > 0,
        listingCount: +r.listingCount || 1,
        listingSkus: r.listingSkus || [],
      };
    });

    const unmergedRow = unmergedRes?.rows?.[0] || {};
    const unmergedSummary = {
      unmergedSkuCount: +unmergedRow.unmergedSkuCount || 0,
      unmergedOrderCount: +unmergedRow.unmergedOrderCount || 0,
      unmergedRevenue: +unmergedRow.unmergedRevenue || 0,
    };

    const cogsConfigured = grossRevenue > 0 && totalCogs > 0;

    res.json({
      summary: {
        totalOrders: +d.totalOrders, grossRevenue, bankReceived, totalRefunds, netBank,
        totalCogs, fkTotalFees: +fkTotalFees.toFixed(2),
        grossProfit, profitMarginPct,
        returnCount: +d.returnCount,
        returnRate: +d.totalOrders > 0 ? +((+d.returnCount / +d.totalOrders)*100).toFixed(1) : 0,
        cogsConfigured,
        fees: {
          commission:  +d.fkCommission, fixedFee:   +d.fkFixedFee,
          collectionFee: +d.fkCollectionFee, pickPack: +d.fkPickPack,
          shipping: +d.fkShipping, reverseShipping: +d.fkReverseShipping,
          tcs: +d.fkTcs, tds: +d.fkTds, gstOnFees: +d.fkGstOnFees,
        },
      },
      trend,
      byCategory,
      bySkuTop,
      byVbSku: byVbSkuTop,
      byAccount,
      byZone,
      unmergedSummary,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/profit-analysis/unmerged-skus ─────────────────────────────────────
router.get('/profit-analysis/unmerged-skus', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);
    const { rows } = await pool.query(`
      SELECT
        o.sku,
        o.marketplace,
        COALESCE(o.category, 'Uncategorized')    AS category,
        COUNT(o.order_item_id)                   AS order_count,
        SUM(COALESCE(o.qty, 1))                  AS units,
        COALESCE(SUM(o.final_invoice_amount), 0) AS total_revenue,
        MIN(o.order_date::text)                  AS first_seen,
        MAX(o.order_date::text)                  AS last_seen
      FROM orders o
      LEFT JOIN sku_master sm ON sm.listing_sku = o.sku
      WHERE 1=1 ${where}
        AND (o.vb_export_sku IS NULL OR sm.listing_sku IS NULL)
      GROUP BY o.sku, o.marketplace, o.category
      ORDER BY order_count DESC
      LIMIT 200;
    `, values);
    res.json({ unmerged: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export function buildSkuReturnSummaryQuery(skuView = 'listing', where = '') {
  const normalizedSkuView = (skuView || 'listing').toLowerCase();
  let selectSku, groupBySku;
  if (normalizedSkuView === 'master') {
    selectSku   = `COALESCE(sm.master_sku, o.sku, 'Unknown') AS sku, NULL::text AS listing_sku`;
    groupBySku  = `COALESCE(sm.master_sku, o.sku, 'Unknown')`;
  } else if (normalizedSkuView === 'both') {
    selectSku   = `COALESCE(sm.master_sku, o.sku, 'Unknown') AS master_sku, COALESCE(o.sku, 'Unknown') AS sku`;
    groupBySku  = `COALESCE(sm.master_sku, o.sku, 'Unknown'), COALESCE(o.sku, 'Unknown')`;
  } else {
    // listing (default)
    selectSku   = `COALESCE(o.sku, 'Unknown') AS sku, NULL::text AS listing_sku`;
    groupBySku  = `COALESCE(o.sku, 'Unknown')`;
  }

  const skuJoin = normalizedSkuView !== 'listing'
    ? `LEFT JOIN sku_master sm ON sm.listing_sku = o.sku AND (sm.marketplace = o.marketplace OR sm.marketplace = 'all')`
    : '';

  const sql = `
      SELECT
        ${selectSku},
        TO_CHAR(DATE_TRUNC('month', o.order_date), 'Mon-YYYY')                AS month,
        DATE_TRUNC('month', o.order_date)                                     AS month_sort,
        SUM(COALESCE(o.qty, 1))                                               AS gross,
        COALESCE(SUM(CASE WHEN r.return_type ILIKE '%customer%' OR r.return_type = 'Return'
                          THEN COALESCE(r.quantity,1) END), 0)                AS returns,
        COALESCE(SUM(CASE WHEN r.return_type ILIKE '%courier%' OR r.return_type ILIKE '%rto%'
                          THEN COALESCE(r.quantity,1) END), 0)                AS rto
      FROM orders o
      ${skuJoin}
      LEFT JOIN order_returns r
        ON r.order_item_id = o.order_item_id
        AND r.order_item_id NOT LIKE 'RET_%'
      WHERE 1=1 ${where}
      GROUP BY ${groupBySku}, DATE_TRUNC('month', o.order_date)
      ORDER BY DATE_TRUNC('month', o.order_date), SUM(COALESCE(o.qty,1)) DESC
  `;

  return { skuView: normalizedSkuView, selectSku, groupBySku, skuJoin, sql };
}

// ── GET /api/sku-return-summary ───────────────────────────────────────────────
// skuView: 'listing' (default) | 'master' | 'both'
router.get('/sku-return-summary', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);
    const { sql, skuView } = buildSkuReturnSummaryQuery(req.query.skuView, where);
    const { rows } = await pool.query(sql, values);

    const data = rows.map(r => {
      const gross   = +r.gross;
      const returns = +r.returns;
      const rto     = +r.rto;
      const net     = gross - returns - rto;
      return {
        sku:        r.sku,
        masterSku:  skuView === 'both' ? r.master_sku : null,
        month:      r.month,
        gross,
        returns,
        rto,
        net,
        returnPct:  gross > 0 ? +((returns + rto) / gross * 100).toFixed(2) : 0,
      };
    });

    const months = [...new Set(rows.map(r => r.month))];
    res.json({ months, data, skuView });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/filters ──────────────────────────────────────────────────────────
router.get('/filters', async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT DISTINCT COALESCE(vb_export_category, category) AS val,'category' AS type FROM orders WHERE COALESCE(vb_export_category, category) IS NOT NULL
      UNION ALL
      SELECT DISTINCT delivery_state  AS val,'region'         AS type FROM orders WHERE delivery_state  IS NOT NULL
      UNION ALL
      SELECT DISTINCT orders_status   AS val,'status'         AS type FROM orders WHERE orders_status   IS NOT NULL
      UNION ALL
      SELECT DISTINCT selling_channel AS val,'sellingChannel' AS type FROM orders WHERE selling_channel IS NOT NULL
      UNION ALL
      SELECT DISTINCT fulfilment_type AS val,'fulfilmentType' AS type FROM orders WHERE fulfilment_type IS NOT NULL
      UNION ALL
      SELECT DISTINCT brand_name      AS val,'brand'          AS type FROM orders WHERE brand_name      IS NOT NULL
      UNION ALL
      SELECT DISTINCT marketplace     AS val,'marketplace'    AS type FROM orders WHERE marketplace     IS NOT NULL
    `);
    const g = (t) => rows.filter(r => r.type === t).map(r => r.val).sort();
    res.json({
      categories:      g('category'),
      regions:         g('region'),
      statuses:        g('status'),
      sellingChannels: g('sellingChannel'),
      fulfilmentTypes: g('fulfilmentType'),
      brands:          g('brand'),
      marketplaces:    g('marketplace'),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/orders ───────────────────────────────────────────────────────────
router.get('/orders', async (req, res) => {
  try {
    const pool = getPool();
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 100000 });
    const includeRc = req.query.includeRc !== 'false';  // default true
    const { where, values } = buildWhere(req.query);

    const [data, cnt] = await Promise.all([
      pool.query(`
        SELECT
          o.order_item_id         AS "orderItemId",
          o.order_id              AS "orderId",
          TO_CHAR(COALESCE(o.order_date, ost.payment_date), 'YYYY-MM-DD') AS "orderDate",
          o.sku, o.fsn, o.category,
          o.marketplace,
          COALESCE(o.seller_account, 'default') AS "sellerAccount",
          o.fulfilment_type       AS "fulfilmentType",
          o.shipping_zone         AS "shippingZone",
          o.order_type            AS "orderType",
          o.delivery_state        AS "deliveryState",
          o.orders_status         AS "ordersStatus",
          o.qty,
          o.final_invoice_amount  AS "finalInvoiceAmount",
          o.total_share_amount    AS "totalShareAmount",
          COALESCE(NULLIF(o.my_share, 0), ost.net_bank, 0) AS "myShare",
          COALESCE(NULLIF(o.commission, 0), ost.commission, 0) AS "commission",
          COALESCE(NULLIF(ost.fixed_fee, 0), o.fixed_fee, 0) AS "fixedFee",
          COALESCE(NULLIF(ost.collection_fee, 0), o.collection_fee, 0) AS "collectionFee",
          COALESCE(NULLIF(ost.pick_pack_fee, 0), o.pick_pack_fee, 0) AS "pickPackFee",
          COALESCE(NULLIF(ost.shipping_fee, 0), o.shipping_fee, 0) AS "shippingFee",
          COALESCE(NULLIF(ost.reverse_shipping, 0), o.reverse_shipping, 0) AS "reverseShipping",
          COALESCE(NULLIF(ost.franchise_fee, 0), o.franchise, 0) AS "franchise",
          COALESCE(NULLIF(o.settlement_amount, 0), ost.net_bank, 0) AS "settlementAmount",
          ret.return_status       AS "returnStatus",
          ret.return_type         AS "returnType",
          ret.return_reason       AS "returnReason",
          ret.return_sub_reason   AS "returnSubReason",
          TO_CHAR(ret.return_requested_date, 'YYYY-MM-DD') AS "returnRequestedDate",
          TO_CHAR(ret.return_approval_date, 'YYYY-MM-DD') AS "returnApprovalDate",
          ret.return_result       AS "returnResult",
          ret.return_expectation  AS "returnExpectation",
          ret.reverse_logistics_tracking_id AS "reverseLogisticsTrackingId",
          ret.return_completion_type AS "returnCompletionType",
          ret.final_condition     AS "finalCondition",
          -- COGS prefers SKU master, then catalog-level fallback.
          ${COGS_UNIT_SQL} AS cogs,
          ${MASTER_SKU_SQL} AS "masterSku"
        FROM orders o
        LEFT JOIN order_settlement_totals ost ON ost.order_item_id = o.order_item_id
        LEFT JOIN order_returns ret   ON ret.order_item_id = o.order_item_id
        ${COGS_JOINS}
        WHERE 1=1 ${where}
        ORDER BY o.order_date DESC NULLS LAST, o.order_item_id
        LIMIT $${values.push(pageSize)} OFFSET $${values.push(offset)}
      `, values),
      pool.query(`SELECT COUNT(*) AS total FROM orders o WHERE 1=1 ${where}`, values.slice(0, values.length - 2)),
    ]);

    // Attach RC fees for pages small enough to compute quickly (skip for bulk exports)
    const rows = (includeRc && data.rows.length <= 100000)
      ? await attachRcFees(data.rows)
      : data.rows;

    res.json({ total: +cnt.rows[0].total, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sku-orders ───────────────────────────────────────────────────────
// All orders + return info for a specific SKU, paginated
router.get('/sku-orders', async (req, res) => {
  try {
    const pool     = getPool();
    const sku      = req.query.sku || '';
    const { page, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 50 });
    const pageSize = 50;

    const [data, cnt, summary] = await Promise.all([
      pool.query(`
        SELECT
          o.order_item_id                                        AS "orderItemId",
          TO_CHAR(COALESCE(o.order_date, ost.payment_date), 'DD-Mon-YYYY') AS "orderDate",
          o.category,
          o.delivery_state                                       AS "deliveryState",
          o.orders_status                                        AS "orderStatus",
          o.final_invoice_amount                                 AS "invoiceAmount",
          COALESCE(NULLIF(o.my_share, 0), ost.net_bank, 0)       AS "myShare",
          ret.return_type                                        AS "returnType",
          ret.return_reason                                      AS "returnReason",
          ret.return_status                                      AS "returnStatus",
          ret.return_completion_type                             AS "returnCompletionType",
          TO_CHAR(ret.return_requested_date, 'DD-Mon-YYYY')     AS "returnDate"
        FROM orders o
        LEFT JOIN order_settlement_totals ost ON ost.order_item_id = o.order_item_id
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        WHERE o.sku = $1
        ORDER BY o.order_date DESC NULLS LAST, o.order_item_id
        LIMIT $2 OFFSET $3
      `, [sku, pageSize, offset]),
      pool.query(`SELECT COUNT(*) AS total FROM orders o WHERE o.sku = $1`, [sku]),
      pool.query(`
        SELECT
          COUNT(*)                                                                    AS "totalOrders",
          COALESCE(SUM(o.final_invoice_amount), 0)                                  AS "totalInvoice",
          COALESCE(SUM(o.my_share), 0)                                              AS "totalMyShare",
          COUNT(ret.order_item_id)                                                   AS "returnCount",
          COUNT(CASE WHEN ret.return_type ILIKE '%customer%' OR ret.return_type = 'Return' THEN 1 END) AS "customerReturns",
          COUNT(CASE WHEN ret.return_type ILIKE '%courier%' OR ret.return_type ILIKE '%rto%' THEN 1 END) AS "courierReturns"
        FROM orders o
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        WHERE o.sku = $1
      `, [sku]),
    ]);

    const s = summary.rows[0];
    res.json({
      sku,
      total:          +cnt.rows[0].total,
      totalOrders:    +s.totalOrders,
      totalInvoice:   +s.totalInvoice  || 0,
      totalMyShare:   +s.totalMyShare  || 0,
      returnCount:    +s.returnCount,
      customerReturns:+s.customerReturns,
      courierReturns: +s.courierReturns,
      returnRate:     s.totalOrders > 0 ? +(s.returnCount / s.totalOrders * 100).toFixed(1) : 0,
      data: data.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/returns ──────────────────────────────────────────────────────────
router.get('/returns', async (req, res) => {
  try {
    const pool = getPool();
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 100000 });
    const { where, values } = buildWhere(req.query);

    // LEFT JOIN from returns so ALL returns show (not just those matched to orders)
    const [data, cnt] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(ret.order_item_id, o.order_item_id)        AS "orderItemId",
          o.order_id                                           AS "orderId",
          TO_CHAR(o.order_date, 'DD-Mon-YYYY')                AS "orderDate",
          o.sku,
          o.category,
          o.delivery_state                                     AS "deliveryState",
          o.final_invoice_amount                               AS "finalInvoiceAmount",
          COALESCE(o.my_share, 0)                              AS "myShare",
          ret.return_id                                        AS "returnId",
          ret.return_type                                      AS "returnType",
          ret.return_reason                                    AS "returnReason",
          ret.return_sub_reason                                AS "returnSubReason",
          ret.return_status                                    AS "returnStatus",
          ret.return_completion_type                           AS "returnCompletionType",
          ret.final_condition                                  AS "finalCondition",
          TO_CHAR(ret.return_requested_date, 'DD-Mon-YYYY')   AS "returnDate"
        FROM returns ret
        LEFT JOIN orders o ON o.order_item_id = ret.order_item_id
                           AND ret.order_item_id NOT LIKE 'RET_%'
        WHERE 1=1 ${where}
        ORDER BY ret.return_requested_date DESC NULLS LAST, o.order_date DESC NULLS LAST, ret.order_item_id
        LIMIT $${values.push(pageSize)} OFFSET $${values.push(offset)}
      `, values),
      pool.query(`
        SELECT COUNT(*) AS total
        FROM returns ret
        LEFT JOIN orders o ON o.order_item_id = ret.order_item_id
                           AND ret.order_item_id NOT LIKE 'RET_%'
        WHERE 1=1 ${where}
      `, values.slice(0, values.length - 2)),
    ]);
    res.json({ total: +cnt.rows[0].total, data: data.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settlement/summary ───────────────────────────────────────────────
router.get('/settlement/summary', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);
    const { rows } = await pool.query(`
      ${SETT_CTE}
      SELECT
        COUNT(*) AS "totalOrders",
        SUM(CASE WHEN s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)>0 AND s.refund_count=0 THEN 1 ELSE 0 END) AS "settledCount",
        SUM(CASE WHEN s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)>0 AND s.refund_count>0 THEN 1 ELSE 0 END) AS "partialReturnCount",
        SUM(CASE WHEN s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)=0 AND s.refund_count>0 THEN 1 ELSE 0 END) AS "fullyReturnedCount",
        SUM(CASE WHEN s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)<0                       THEN 1 ELSE 0 END) AS "clawbackCount",
        SUM(CASE WHEN s.order_item_id IS NULL AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned') AND o.return_type IS NULL AND ret.order_item_id IS NULL THEN 1 ELSE 0 END) AS "unsettledCount",
        COALESCE(SUM(CASE WHEN COALESCE(s.net_bank,0)>0 THEN s.net_bank ELSE 0 END),0)       AS "totalBankReceived",
        COALESCE(SUM(CASE WHEN COALESCE(s.net_bank,0)<0 THEN ABS(s.net_bank) ELSE 0 END),0)  AS "totalDeducted",
        COALESCE(SUM(COALESCE(s.net_bank,0)),0)                                               AS "netBank",
        COALESCE(SUM(COALESCE(s.refund_amount,0)),0)                                          AS "totalRefundAmount",
        CASE WHEN COUNT(*) > 0
          THEN SUM(CASE WHEN s.order_item_id IS NOT NULL THEN 1 ELSE 0 END)::float/COUNT(*)*100
          ELSE 0 END AS "settlementRate"
      FROM orders o
      LEFT JOIN sett s ON s.order_item_id = o.order_item_id
      LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
    `, values);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settlement/trend ─────────────────────────────────────────────────
router.get('/settlement/trend', async (req, res) => {
  try {
    const pool = getPool();
    const { groupBy = 'month', startDate, endDate } = req.query;
    const conds = [];
    const values = [];
    if (startDate) { conds.push(`fs.payment_date >= $${values.push(startDate)}`); }
    if (endDate)   { conds.push(`fs.payment_date <= $${values.push(endDate)}`);   }
    const where  = conds.length ? 'AND ' + conds.join(' AND ') : '';
    const period = periodExpr(groupBy, 'fs.payment_date');
    const { rows } = await pool.query(`
      SELECT
        ${period} AS period,
        SUM(CASE WHEN fs.bank_settlement>0 THEN fs.bank_settlement ELSE 0 END)      AS received,
        SUM(CASE WHEN fs.bank_settlement<0 THEN ABS(fs.bank_settlement) ELSE 0 END) AS deducted,
        SUM(fs.bank_settlement)                                                      AS net,
        COUNT(CASE WHEN fs.bank_settlement>0 THEN 1 END)                             AS count
      FROM unified_settlements fs
      WHERE 1=1 ${where}
      GROUP BY ${period}
      ORDER BY period
    `, values);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settlement/orders ────────────────────────────────────────────────
router.get('/settlement/orders', async (req, res) => {
  try {
    const pool = getPool();
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 100000 });
    const ss       = req.query.settlementStatus || '';
    const { where, values } = buildWhere(req.query);
    const ssWhere  = settStatusFilter(ss);

    const [data, cnt] = await Promise.all([
      pool.query(`
        ${SETT_CTE}
        SELECT
          o.order_item_id    AS "orderItemId",
          o.order_id         AS "orderId",
          TO_CHAR(o.order_date, 'YYYY-MM-DD') AS "orderDate",
          o.category,
          o.sku,
          COALESCE(o.marketplace, 'flipkart') AS marketplace,
          COALESCE(o.seller_account, 'default') AS "sellerAccount",
          o.fulfilment_type  AS "fulfilmentType",
          o.delivery_state   AS "deliveryState",
          o.final_invoice_amount AS "finalInvoiceAmount",
          o.commission,
          o.fixed_fee        AS "fixedFee",
          o.collection_fee   AS "collectionFee",
          o.pick_pack_fee    AS "pickPackFee",
          o.shipping_fee     AS "shippingFee",
          o.reverse_shipping AS "reverseShipping",
          o.franchise,
          COALESCE(s.net_bank,0)      AS "bankReceived",
          COALESCE(s.refund_amount,0) AS "refundAmount",
          s.payment_date              AS "paymentDate",
          ${STATUS_EXPR}              AS "settlementStatus",
          ret.return_type             AS "returnType",
          ret.return_status           AS "returnStatus",
          ret.return_reason           AS "returnReason",
          ret.return_sub_reason       AS "returnSubReason",
          TO_CHAR(ret.return_requested_date, 'YYYY-MM-DD') AS "returnRequestedDate",
          TO_CHAR(ret.return_approval_date, 'YYYY-MM-DD') AS "returnApprovalDate",
          ret.return_result           AS "returnResult",
          ret.return_expectation      AS "returnExpectation",
          ret.reverse_logistics_tracking_id AS "reverseLogisticsTrackingId",
          ret.return_completion_type  AS "returnCompletionType",
          ret.final_condition         AS "finalCondition"
        FROM orders o
        LEFT JOIN sett s      ON s.order_item_id = o.order_item_id
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        WHERE 1=1 ${where} ${ssWhere}
        ORDER BY o.order_date DESC, o.order_item_id
        LIMIT $${values.push(pageSize)} OFFSET $${values.push(offset)}
      `, values),
      pool.query(`
        ${SETT_CTE}
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)>0 AND s.refund_count=0 THEN 1 ELSE 0 END) AS settled,
          SUM(CASE WHEN s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)>0 AND s.refund_count>0 THEN 1 ELSE 0 END) AS "partialReturn",
          SUM(CASE WHEN s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)=0 AND s.refund_count>0 THEN 1 ELSE 0 END) AS "fullyReturned",
          SUM(CASE WHEN s.order_item_id IS NOT NULL AND COALESCE(s.net_bank,0)<0                       THEN 1 ELSE 0 END) AS clawback,
          SUM(CASE WHEN s.order_item_id IS NULL AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned') AND o.return_type IS NULL AND ret.order_item_id IS NULL THEN 1 ELSE 0 END) AS unsettled
        FROM orders o
        LEFT JOIN sett s ON s.order_item_id = o.order_item_id
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
      `, values.slice(0, values.length - 2)),
    ]);

    const counts = cnt.rows[0];
    const refundTotal = (+counts.fullyReturned||0) + (+counts.partialReturn||0) + (+counts.clawback||0);
    
    // Attach calculated rate card fees dynamically
    const enrichedRows = await attachRcFees(data.rows);

    res.json({
      total: +counts.total,
      statusCounts: {
        Settled: +counts.settled,
        Unsettled: +counts.unsettled,
        Refund: refundTotal,
        // sub-types (kept for detail use)
        'Fully Returned': +counts.fullyReturned,
        'Partial Return': +counts.partialReturn,
        Clawback: +counts.clawback,
      },
      data: enrichedRows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settlement/unsettled-summary ─────────────────────────────────────
router.get('/settlement/unsettled-summary', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);

    const [bycat, tot] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(o.vb_export_category, o.category, 'Uncategorized') AS category,
          COUNT(*)                             AS count,
          COALESCE(SUM(o.final_invoice_amount),0) AS "orderAmount"
        FROM orders o
        WHERE NOT EXISTS (SELECT 1 FROM ${ORDER_SETTLEMENT_TOTALS_TABLE} fs WHERE fs.order_item_id=o.order_item_id)
        AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned')
        AND o.return_type IS NULL
        AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.order_item_id = o.order_item_id)
        AND 1=1 ${where}
        GROUP BY COALESCE(o.vb_export_category, o.category, 'Uncategorized')
        ORDER BY count DESC
      `, values),
      pool.query(`
        SELECT COUNT(*) AS total, COALESCE(SUM(o.final_invoice_amount),0) AS "totalAmount"
        FROM orders o
        WHERE NOT EXISTS (SELECT 1 FROM ${ORDER_SETTLEMENT_TOTALS_TABLE} fs WHERE fs.order_item_id=o.order_item_id)
        AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned')
        AND o.return_type IS NULL
        AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.order_item_id = o.order_item_id)
        AND 1=1 ${where}
      `, values),
    ]);
    res.json({ total: +tot.rows[0].total, totalAmount: +tot.rows[0].totalAmount, byCategory: bycat.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/order/:orderItemId ───────────────────────────────────────────────
router.get('/order/:orderItemId', async (req, res) => {
  try {
    const pool = getPool();
    const id = req.params.orderItemId;
    const [orderRes, retRes, settRes] = await Promise.all([
      pool.query(`
        SELECT
          o.order_item_id                              AS "orderItemId",
          o.order_id                                   AS "orderId",
          TO_CHAR(COALESCE(o.order_date, ost.payment_date), 'DD-Mon-YYYY') AS "orderDate",
          o.category, o.sku, o.marketplace,
          o.fulfilment_type                            AS "fulfilmentType",
          o.selling_channel                            AS "sellingChannel",
          o.delivery_state                             AS "deliveryState",
          o.delivery_city                              AS "deliveryCity",
          o.delivery_pincode                           AS "deliveryPincode",
          o.orders_status                              AS "ordersStatus",
          o.qty, o.weight_slab AS "weightSlab", o.shipping_zone AS "shippingZone",
          o.final_invoice_amount                       AS "finalInvoiceAmount",
          o.total_share_amount                         AS "totalShareAmount",
          COALESCE(NULLIF(o.my_share, 0), ost.net_bank, 0)        AS "myShare",
          COALESCE(NULLIF(o.commission, 0), ost.commission, 0)    AS "commission",
          COALESCE(NULLIF(ost.fixed_fee, 0), o.fixed_fee, 0)      AS "fixedFee",
          COALESCE(NULLIF(ost.collection_fee, 0), o.collection_fee, 0) AS "collectionFee",
          COALESCE(NULLIF(ost.pick_pack_fee, 0), o.pick_pack_fee, 0)   AS "pickPackFee",
          COALESCE(NULLIF(ost.shipping_fee, 0), o.shipping_fee, 0)     AS "shippingFee",
          COALESCE(NULLIF(ost.reverse_shipping, 0), o.reverse_shipping, 0) AS "reverseShipping",
          COALESCE(NULLIF(ost.franchise_fee, 0), o.franchise, 0)  AS "franchise",
          o.tcs, o.tds, o.gst_on_mp AS "gstOnMp",
          COALESCE(NULLIF(o.settlement_amount, 0), ost.net_bank, 0) AS "settlementAmount",
          COALESCE(o.seller_account, 'default')        AS "sellerAccount",
          o.order_type                                 AS "orderType",
          TO_CHAR(COALESCE(o.order_date, ost.payment_date), 'YYYY-MM-DD') AS "rawDate",
          o.brand_name                                 AS "brandName"
        FROM orders o
        LEFT JOIN order_settlement_totals ost ON ost.order_item_id = o.order_item_id
        WHERE o.order_item_id = $1
      `, [id]),
      pool.query(`
        SELECT
          return_id                                         AS "returnId",
          order_item_id                                     AS "orderItemId",
          return_type                                       AS "returnType",
          return_status                                     AS "returnStatus",
          return_result                                     AS "returnResult",
          return_reason                                     AS "returnReason",
          return_sub_reason                                 AS "returnSubReason",
          TO_CHAR(return_requested_date, 'DD-Mon-YYYY')     AS "returnRequestedDate",
          TO_CHAR(return_approval_date, 'DD-Mon-YYYY')      AS "returnApprovalDate",
          return_expectation                                AS "returnExpectation",
          return_completion_type                            AS "returnCompletionType",
          quantity, final_condition AS "finalCondition",
          primary_pv_output AS "primaryPvOutput",
          detailed_pv_output AS "detailedPvOutput",
          fulfilment_type AS "fulfilmentType"
        FROM order_returns WHERE order_item_id = $1
      `, [id]),
      pool.query(`
        SELECT
          neft_id                                           AS "neftId",
          neft_type                                         AS "neftType",
          TO_CHAR(payment_date, 'DD-Mon-YYYY')              AS "paymentDate",
          bank_settlement                                   AS "bankSettlement",
          input_gst_tcs                                     AS "inputGstTcs",
          income_tax_credits                                AS "incomeTaxCredits",
          sale_amount                                       AS "saleAmount",
          total_offer_amount                                AS "totalOfferAmount",
          my_share                                          AS "myShare",
          customer_addons                                   AS "customerAddons",
          marketplace_fee                                   AS "marketplaceFee",
          taxes, refund,
          commission_rate                                   AS "commissionRate",
          commission,
          fixed_fee                                         AS "fixedFee",
          collection_fee                                    AS "collectionFee",
          pick_pack_fee                                     AS "pickPackFee",
          shipping_fee                                      AS "shippingFee",
          reverse_shipping                                  AS "reverseShipping",
          no_cost_emi_fee                                   AS "noCostEmiFee",
          customer_addon_recovery                           AS "customerAddonRecovery",
          franchise_fee                                     AS "franchiseFee",
          shopsy_marketing_fee                              AS "shopsyMarketingFee",
          cancellation_fee                                  AS "cancellationFee",
          tcs, tds,
          gst_on_mp_fees                                    AS "gstOnMpFees",
          offer_amount_discount_mp                          AS "offerAmountDiscountMp",
          return_type                                       AS "returnType",
          item_return_status                                AS "itemReturnStatus",
          fulfilment_type                                   AS "fulfilmentType",
          tier, quantity
        FROM unified_settlements WHERE order_item_id = $1 ORDER BY payment_date
      `, [id]),
    ]);

    const settlementRows = settRes.rows;
    const bankReceived   = settlementRows.reduce((s, r) => s + (+r.bankSettlement || 0), 0);
    const refundTotal    = settlementRows.reduce((s, r) => s + (r.refund < 0 ? +r.refund : 0), 0);
    const hasRefund      = settlementRows.some(r => +r.refund < 0);

    // Allow settlement-only lookup (order may not be in orders table)
    if (!orderRes.rows.length && !settlementRows.length) {
      return res.status(404).json({ error: 'Order not found' });
    }

    let settlementStatus = 'Unsettled';
    if (settlementRows.length) {
      if (bankReceived < 0)                     settlementStatus = 'Clawback';
      else if (bankReceived === 0 && hasRefund) settlementStatus = 'Fully Returned';
      else if (bankReceived > 0 && hasRefund)   settlementStatus = 'Partial Return';
      else if (bankReceived > 0)                settlementStatus = 'Settled';
      else                                      settlementStatus = 'Pending';
    }

    // ── RC fee calculation ─────────────────────────────────────────────────────
    let rcFees = null;
    const o = orderRes.rows[0];
    if (o) {
      try {
        const mp   = o.marketplace   || 'flipkart';
        const acct = o.sellerAccount || 'default';
        const rc   = await getRateCard(mp, acct).catch(() => null);
        if (rc) {
          const price = parseFloat(o.finalInvoiceAmount) || 0;
          const fees  = calculateFees(rc, {
            category:      o.category,
            price,
            fulfilmentType: o.fulfilmentType,
            zone:           o.shippingZone   || 'national',
            paymentType:    o.orderType      || 'prepaid',
            weight:         parseFloat(o.weightSlab) || 0.5,
            orderDate:      o.rawDate,
            isReturn:       false,
            brandName:      o.brandName      || null,
          });
          rcFees = {
            commission:        fees.commission,
            commissionRate:    fees.commissionRate,
            fixedFee:          fees.fixedFee,
            collectionFee:     fees.collectionFee,
            collectionFeeRate: fees.collectionFeeRate,
            pickPack:          fees.pickPack,
            franchiseFee:      fees.franchiseFee,
            gstOnFees:         fees.gstOnFees,
            tcs:               fees.tcs,
            tds:               price > 0 ? +(price * 0.001).toFixed(2) : 0,
            totalFees:         fees.totalFees,
            netToSeller:       fees.netToSeller,
            configured:        true,
          };
        }
      } catch (e) {
        console.warn('/order detail RC:', e.message);
      }
    }

    res.json({
      order:         orderRes.rows[0] || null,
      returnInfo:    retRes.rows[0]   || null,
      settlementRows,
      bankReceived,
      refundAmount:  Math.abs(refundTotal),
      settlementStatus,
      rcFees,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /settlement/month-pl ──────────────────────────────────────────────────
// Month-wise P&L: sale, returns, fees, bank received, cross-month, pending
// Grouped by order_date month + marketplace
router.get('/settlement/month-pl', async (req, res) => {
  try {
    const pool = getPool();
    const mpFilter = parseMarketplaceFilter(req.query.marketplace);

    let mpWhereO = '';
    let mpWhereFk = '';
    let mpWhereNO = '';
    const mpVals = [];

    if (mpFilter === 'myntra_vb') {
      mpWhereO = "AND o.marketplace = 'myntra' AND COALESCE(o.seller_account, 'myntra_vb') = 'myntra_vb'";
      mpWhereFk = "AND COALESCE(fk.marketplace, o.marketplace) = 'myntra' AND COALESCE(o.seller_account, 'myntra_vb') = 'myntra_vb'";
      mpWhereNO = "AND marketplace = 'myntra'";
    } else if (mpFilter === 'myntra_ej') {
      mpWhereO = "AND o.marketplace = 'myntra' AND o.seller_account = 'myntra_ej'";
      mpWhereFk = "AND COALESCE(fk.marketplace, o.marketplace) = 'myntra' AND o.seller_account = 'myntra_ej'";
      mpWhereNO = "AND marketplace = 'myntra'";
    } else if (mpFilter === 'myntra') {
      mpWhereO = "AND o.marketplace = 'myntra'";
      mpWhereFk = "AND COALESCE(fk.marketplace, o.marketplace) = 'myntra'";
      mpWhereNO = "AND marketplace = 'myntra'";
    } else if (mpFilter) {
      mpVals.push(mpFilter);
      mpWhereO = `AND COALESCE(o.marketplace, 'flipkart') = $${mpVals.length}`;
      mpWhereFk = `AND COALESCE(fk.marketplace, 'flipkart') = $${mpVals.length}`;
      mpWhereNO = `AND COALESCE(marketplace, 'flipkart') = $${mpVals.length}`;
    }

    // ── 1. Main: per order_month (order placed in that month) ──
    const mainRes = await pool.query(`
      WITH order_fees AS (
        SELECT
          fk.order_item_id,
          SUM(fk.bank_settlement)                                                            AS net_bank,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.commission,0))       ELSE 0 END) AS commission,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.fixed_fee,0))        ELSE 0 END) AS fixed_fee,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.collection_fee,0))   ELSE 0 END) AS collection_fee,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.pick_pack_fee,0))    ELSE 0 END) AS pick_pack_fee,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.shipping_fee,0))     ELSE 0 END) AS shipping_fee,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.reverse_shipping,0)) ELSE 0 END) AS reverse_shipping,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.franchise_fee,0))    ELSE 0 END) AS franchise_fee,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.tcs,0))              ELSE 0 END) AS tcs,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.tds,0))              ELSE 0 END) AS tds,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.gst_on_mp_fees,0))   ELSE 0 END) AS gst_on_mp_fees,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.protection_fund,0))  ELSE 0 END) AS protection_fund
        FROM unified_settlements fk
        GROUP BY fk.order_item_id
      )
      SELECT
        TO_CHAR(o.order_date, 'YYYY-MM')          AS month,
        CASE
          WHEN o.marketplace = 'myntra' THEN COALESCE(o.seller_account, 'myntra_vb')
          ELSE COALESCE(o.marketplace, 'Unknown')
        END                                        AS marketplace,
        COUNT(DISTINCT o.order_item_id)            AS order_count,
        COALESCE(SUM(o.final_invoice_amount), 0)   AS sale_amount,
        COUNT(DISTINCT r.order_item_id)            AS return_count,
        COALESCE(SUM(CASE WHEN r.order_item_id IS NOT NULL THEN o.final_invoice_amount ELSE 0 END), 0) AS return_amount,
        COALESCE(SUM(COALESCE(f.commission,0)),      0) AS commission,
        COALESCE(SUM(COALESCE(f.fixed_fee,0)),       0) AS fixed_fee,
        COALESCE(SUM(COALESCE(f.collection_fee,0)),  0) AS collection_fee,
        COALESCE(SUM(COALESCE(f.pick_pack_fee,0)),   0) AS pick_pack_fee,
        COALESCE(SUM(COALESCE(f.shipping_fee,0)),    0) AS shipping_fee,
        COALESCE(SUM(COALESCE(f.reverse_shipping,0)),0) AS reverse_shipping,
        COALESCE(SUM(COALESCE(f.franchise_fee,0)),   0) AS franchise_fee,
        COALESCE(SUM(COALESCE(f.tcs,0)),             0) AS tcs,
        COALESCE(SUM(COALESCE(f.tds,0)),             0) AS tds,
        COALESCE(SUM(COALESCE(f.gst_on_mp_fees,0)),   0) AS gst_on_mp_fees,
        COALESCE(SUM(COALESCE(f.protection_fund,0)),  0) AS protection_fund,
        COALESCE(SUM(CASE WHEN f.net_bank > 0 THEN f.net_bank ELSE 0 END), 0) AS bank_received,
        -- Pending = no entry at all in unified_settlements (f.order_item_id IS NULL)
        -- Using f.order_item_id IS NULL (not f.net_bank IS NULL) to exclude returned orders
        -- whose bank_settlement rows are NULL (which would cause SUM to be NULL despite existing)
        COALESCE(SUM(CASE WHEN f.order_item_id IS NULL THEN o.final_invoice_amount ELSE 0 END), 0) AS pending_amount,
        COUNT(DISTINCT CASE WHEN f.order_item_id IS NULL THEN o.order_item_id END)                  AS pending_count,
        COALESCE(SUM(CASE WHEN COALESCE(f.net_bank,0) > 0 THEN o.final_invoice_amount ELSE 0 END), 0) AS settled_invoice_amount
      FROM orders o
      LEFT JOIN order_returns r      ON r.order_item_id = o.order_item_id
      LEFT JOIN order_fees f   ON f.order_item_id = o.order_item_id
      WHERE o.order_date IS NOT NULL ${mpWhereO}
      GROUP BY TO_CHAR(o.order_date, 'YYYY-MM'),
        CASE
          WHEN o.marketplace = 'myntra' THEN COALESCE(o.seller_account, 'myntra_vb')
          ELSE COALESCE(o.marketplace, 'Unknown')
        END
      ORDER BY month, marketplace
    `, mpVals);

    // ── 2. Cross-month: money received THIS month for orders placed BEFORE this month ──
    const crossRes = await pool.query(`
      SELECT
        TO_CHAR(fk.payment_date, 'YYYY-MM')            AS payment_month,
        CASE
          WHEN COALESCE(fk.marketplace, o.marketplace) = 'myntra' THEN COALESCE(o.seller_account, 'myntra_vb')
          ELSE COALESCE(fk.marketplace, o.marketplace, 'Unknown')
        END AS marketplace,
        COUNT(DISTINCT fk.order_item_id)               AS order_count,
        SUM(CASE WHEN fk.bank_settlement > 0 THEN fk.bank_settlement ELSE 0 END) AS received
      FROM unified_settlements fk
      LEFT JOIN orders o ON o.order_item_id = fk.order_item_id
      WHERE fk.payment_date IS NOT NULL
        AND fk.bank_settlement > 0
        AND o.order_date IS NOT NULL
        AND TO_CHAR(fk.payment_date, 'YYYY-MM') != TO_CHAR(o.order_date, 'YYYY-MM') ${mpWhereFk}
      GROUP BY TO_CHAR(fk.payment_date, 'YYYY-MM'),
        CASE
          WHEN COALESCE(fk.marketplace, o.marketplace) = 'myntra' THEN COALESCE(o.seller_account, 'myntra_vb')
          ELSE COALESCE(fk.marketplace, o.marketplace, 'Unknown')
        END
      ORDER BY payment_month, marketplace
    `, mpVals);

    // ── 3. Non-order NEFT charges: storage, ads, google ads, SPF claims — grouped by payment month ──
    const noOrderSql = (table) => `
      SELECT TO_CHAR(payment_date,'YYYY-MM')    AS month,
             COALESCE(marketplace,'flipkart')   AS marketplace,
             COALESCE(SUM(ABS(settlement_value)),0) AS total
      FROM ${table}
      WHERE payment_date IS NOT NULL ${mpWhereNO}
      GROUP BY 1,2
    `;

    // SPF claims split: positive = FK pays you (claims approved); negative = FK deducts (loss/recovery)
    const spfClaimsSql = `
      SELECT TO_CHAR(payment_date,'YYYY-MM')    AS month,
             COALESCE(marketplace,'flipkart')   AS marketplace,
             COALESCE(SUM(CASE WHEN settlement_value > 0 THEN settlement_value   ELSE 0 END), 0) AS total
      FROM fk_spf_claims
      WHERE payment_date IS NOT NULL ${mpWhereNO} GROUP BY 1,2
    `;
    const spfLossSql = `
      SELECT TO_CHAR(payment_date,'YYYY-MM')    AS month,
             COALESCE(marketplace,'flipkart')   AS marketplace,
             COALESCE(SUM(CASE WHEN settlement_value < 0 THEN ABS(settlement_value) ELSE 0 END), 0) AS total
      FROM fk_spf_claims
      WHERE payment_date IS NOT NULL ${mpWhereNO} GROUP BY 1,2
    `;

    // ── 4. Rate Card Calculated Expected Fees ──
    const rcSql = `
      WITH rc_calc AS (
        SELECT
          fk.order_item_id,
          TO_CHAR(o.order_date, 'YYYY-MM')   AS month,
          CASE
            WHEN o.marketplace = 'myntra' THEN COALESCE(o.seller_account, 'myntra_vb')
            ELSE COALESCE(o.marketplace, 'Unknown')
          END AS marketplace,
          COALESCE(NULLIF(fk.sale_amount, 0), o.final_invoice_amount, 0) AS inv_amt,
          GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)                   AS qty,
          COALESCE((
            SELECT rc.rate * COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
            FROM rc_commission rc
            WHERE LOWER(rc.category) = REGEXP_REPLACE(LOWER(o.category), '^shopsy_', '')
              AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND (rc.brand_name IS NULL OR rc.brand_name = '' OR rc.brand_name = o.brand_name)
              AND rc.price_min <= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0) / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
              AND rc.price_max >= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0) / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
              AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
              AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
            ORDER BY (rc.brand_name IS NOT NULL AND rc.brand_name <> '') DESC, rc.start_date DESC NULLS LAST LIMIT 1
          ), 0) AS vb_commission,
          (
            SELECT rc.rate * GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
            FROM rc_fixed_fee rc
            WHERE LOWER(rc.category) = REGEXP_REPLACE(LOWER(o.category), '^shopsy_', '')
              AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND rc.price_min <= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0) / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
              AND rc.price_max >= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0) / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
              AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
              AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
            ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
          ) AS vb_fixed_fee,
          (
            SELECT CASE WHEN rc.prepaid_type = 'flat' THEN rc.prepaid * GREATEST(COALESCE(fk.quantity, o.qty, 1), 1) ELSE rc.prepaid * COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0) END
            FROM rc_collection_fee rc
            WHERE LOWER(rc.category) = REGEXP_REPLACE(LOWER(o.category), '^shopsy_', '')
              AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND rc.price_min <= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0) / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
              AND rc.price_max >= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0) / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
              AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
              AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
            ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
          ) AS vb_collection_fee,
          (
            SELECT rc.rate * GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
            FROM rc_pick_pack rc
            WHERE LOWER(rc.category) = REGEXP_REPLACE(LOWER(o.category), '^shopsy_', '')
              AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND rc.price_min <= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0) / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
              AND rc.price_max >= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0) / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
              AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
              AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
            ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
          ) AS vb_pick_pack_fee
        FROM unified_settlements fk
        INNER JOIN orders o ON o.order_item_id = fk.order_item_id
        WHERE o.order_date IS NOT NULL AND fk.bank_settlement > 0 ${mpWhereO}
      )
      SELECT month, marketplace,
        SUM(vb_commission)        AS vb_commission,
        SUM(vb_fixed_fee)         AS vb_fixed_fee,
        SUM(vb_collection_fee)    AS vb_collection_fee,
        SUM(vb_pick_pack_fee)     AS vb_pick_pack_fee
      FROM rc_calc GROUP BY month, marketplace
    `;

    const isMyntraFilter = mpFilter && mpFilter.startsWith('myntra');
    const myntraNodSql = `
      SELECT
        TO_CHAR(payment_date, 'YYYY-MM') AS month,
        COALESCE(seller_account, 'myntra_vb') AS marketplace,
        invoice_number,
        notes,
        amount_received
      FROM mp_invoices
      WHERE marketplace = 'myntra'
        AND payment_date IS NOT NULL
        AND (order_type = 'nod' OR notes ILIKE '%nod%' OR invoice_number ILIKE '%nod%')
        ${mpFilter === 'myntra_vb' ? "AND COALESCE(seller_account, 'myntra_vb') = 'myntra_vb'" : mpFilter === 'myntra_ej' ? "AND seller_account = 'myntra_ej'" : ''}
    `;

    const [storRes, adsRes, gadsRes, spfClaimsRes, spfLossRes, rcRes, myntraNodRes] = await Promise.all([
      pool.query(noOrderSql('fk_storage_recall'), mpVals).catch(() => ({ rows: [] })),
      pool.query(noOrderSql('fk_ads'),            mpVals).catch(() => ({ rows: [] })),
      pool.query(noOrderSql('fk_google_ads'),     mpVals).catch(() => ({ rows: [] })),
      pool.query(spfClaimsSql,                    mpVals).catch(() => ({ rows: [] })),
      pool.query(spfLossSql,                      mpVals).catch(() => ({ rows: [] })),
      pool.query(rcSql,                           mpVals).catch(() => ({ rows: [] })),
      (!mpFilter || isMyntraFilter) ? pool.query(myntraNodSql).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
    ]);

    // Build lookup helper: key = "month|marketplace" → numeric total
    const makeMap = (rows) => {
      const m = {};
      for (const r of rows) m[`${r.month}|${r.marketplace}`] = +r.total || 0;
      return m;
    };
    const storMap      = makeMap(storRes.rows);
    const adsMap       = makeMap(adsRes.rows);
    const gadsMap      = makeMap(gadsRes.rows);
    const spfClaimsMap = makeMap(spfClaimsRes.rows);
    const spfLossMap   = makeMap(spfLossRes.rows);

    // Merge Myntra Non-Order Deductions and Credits
    if (myntraNodRes && myntraNodRes.rows) {
      for (const nr of myntraNodRes.rows) {
        const key = `${nr.month}|${nr.marketplace}`;
        const val = Number(nr.amount_received || 0);
        const c = classifyMyntraNod(nr.invoice_number, nr.notes, val);
        if (val < 0) {
          // Negative amounts (marketing, MFB, split NOD, service invoices) are non-order deductions
          adsMap[key] = (adsMap[key] || 0) + Math.abs(val);
        } else if (val > 0) {
          // Positive amounts (SPF reimbursements, credit notes, logistics reimbursements) are credits
          spfClaimsMap[key] = (spfClaimsMap[key] || 0) + val;
        }
      }
    }

    const rcMap = {};
    for (const r of rcRes.rows) {
      rcMap[`${r.month}|${r.marketplace}`] = {
        vb_commission: +r.vb_commission || 0,
        vb_fixed_fee: +r.vb_fixed_fee || null,
        vb_collection_fee: +r.vb_collection_fee || null,
        vb_pick_pack_fee: +r.vb_pick_pack_fee || null,
      };
    }

    // Build a lookup map for cross-month: key = "paymentMonth|marketplace"
    const crossMap = {};
    for (const r of crossRes.rows) {
      const key = `${r.payment_month}|${r.marketplace}`;
      crossMap[key] = { orderCount: +r.order_count || 0, received: +r.received || 0 };
    }

    // Merge cross-month into main rows
    const data = mainRes.rows.map(r => {
      const crossKey    = `${r.month}|${r.marketplace}`;
      const cross       = crossMap[crossKey] || { orderCount: 0, received: 0 };
      const saleAmount  = +r.sale_amount   || 0;
      const returnAmt   = +r.return_amount || 0;
      const netSale     = saleAmount - returnAmt;
      const commission     = +r.commission      || 0;
      const fixedFee       = +r.fixed_fee       || 0;
      const collectionFee  = +r.collection_fee  || 0;
      const pickPackFee    = +r.pick_pack_fee   || 0;
      const shippingFee    = +r.shipping_fee    || 0;
      const reverseShip    = +r.reverse_shipping|| 0;
      const franchiseFee   = +r.franchise_fee   || 0;
      const tcs            = +r.tcs             || 0;
      const tds            = +r.tds             || 0;
      const gst            = +r.gst_on_mp_fees  || 0;
      const protectionFund = +r.protection_fund || 0;
      const totalOrderFees = commission + fixedFee + collectionFee + pickPackFee +
                             shippingFee + reverseShip + franchiseFee + tcs + tds + gst + protectionFund;
      const bankReceived   = +r.bank_received   || 0;
      const prevReceived   = cross.received;
      const totalBankInMonth = bankReceived + prevReceived;
      const pendingAmount  = +r.pending_amount  || 0;
      const settledInvoiceAmount = +r.settled_invoice_amount || 0;
      // Effective settlement rate = what % of invoice actually reached bank (for settled orders)
      // Use this to estimate what the pending orders will yield after FK deductions
      const effectiveRate  = settledInvoiceAmount > 0 ? bankReceived / settledInvoiceAmount : 0;
      const pendingAmountNet = (pendingAmount > 0 && effectiveRate > 0)
        ? Math.round(pendingAmount * effectiveRate)
        : null;

      // ── Non-order NEFT charges for THIS payment month ──
      const mapKey            = `${r.month}|${r.marketplace}`;
      const storageCharges    = storMap[mapKey]      || 0;
      const adsSpend          = adsMap[mapKey]       || 0;
      const googleAdsSpend    = gadsMap[mapKey]      || 0;
      const totalNonOrder     = storageCharges + adsSpend + googleAdsSpend;

      // SPF: split positive claims (income) from negative deductions (warehouse loss / recovery)
      const spfClaimsReceived = spfClaimsMap[mapKey] || 0; // +ve: FK pays you (wrong product, warehouse claims)
      const spfWarehouseLoss  = spfLossMap[mapKey]   || 0; // -ve made positive: FK deducts (reversals/recovery)

      // Net position = bank in month − non-order charges − warehouse loss + SPF claims received
      const netPosition = totalBankInMonth - totalNonOrder - spfWarehouseLoss + spfClaimsReceived;

      const rc = rcMap[mapKey] || { vb_commission: null, vb_fixed_fee: null, vb_collection_fee: null, vb_pick_pack_fee: null };

      return {
        month:           r.month,
        marketplace:     r.marketplace,
        orderCount:      +r.order_count    || 0,
        saleAmount,
        returnCount:     +r.return_count   || 0,
        returnAmount:    returnAmt,
        netSaleAmount:   netSale,
        commission, fixedFee, collectionFee, pickPackFee,
        shippingFee, reverseShipping: reverseShip, franchiseFee,
        tcs, tds, gstOnMpFees: gst,
        protectionFund,
        totalOrderFees,
        totalFees: totalOrderFees, // keep alias for backward compat
        vb_commission: rc.vb_commission,
        vb_fixed_fee: rc.vb_fixed_fee,
        vb_collection_fee: rc.vb_collection_fee,
        vb_pick_pack_fee: rc.vb_pick_pack_fee,
        bankReceived,
        prevMonthReceived: prevReceived,
        prevMonthOrderCount: cross.orderCount,
        totalBankInMonth,
        pendingAmount,
        pendingAmountNet,
        pendingCount:         +r.pending_count   || 0,
        settledInvoiceAmount,
        // Non-order charges (by payment month)
        storageCharges,
        adsSpend,
        googleAdsSpend,
        totalNonOrder,
        // SPF — two separate flows
        spfClaimsReceived,   // +ve: FK credits you (wrong product / warehouse recovery claims approved)
        spfWarehouseLoss,    // +ve magnitude: FK deducts (warehouse loss reversals / recovery deductions)
        spfReceived: spfClaimsReceived, // backward-compat alias (some older UI refs)
        netPosition,
      };
    });

    const months = [...new Set(data.map(d => d.month))].sort();
    const marketplaces = [...new Set(data.map(d => d.marketplace))].sort();
    res.json({ months, marketplaces, data });
  } catch (err) {
    console.error('[settlement/month-pl]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /settlement/non-order-detail ──────────────────────────────────────────
// Returns individual rows from non-order NEFT charge tables for a given month
// source: 'storage' | 'ads' | 'google_ads' | 'spf'
// month:  'YYYY-MM'
router.get('/settlement/non-order-detail', async (req, res) => {
  try {
    const pool = getPool();
    const { source } = req.query;
    const month = typeof req.query.month === 'string' ? req.query.month.trim() : '';
    if (!source || !month) return res.status(400).json({ error: 'source and month are required' });
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month must use YYYY-MM format' });
    }
    const marketplace = parseMarketplaceFilter(req.query.marketplace);

    const mpCond = marketplace ? `AND COALESCE(marketplace,'flipkart') = $2` : '';
    const params = marketplace ? [month, marketplace] : [month];

    let sql;
    switch (source) {
      case 'storage':
        sql = `
          SELECT TO_CHAR(payment_date,'YYYY-MM-DD') AS date,
                 neft_id, service_name,
                 fsn, listing_id, warehouse_state, product_sub_category,
                 chargeable_weight_slab,
                 ABS(COALESCE(storage_fee,0))        AS storage_fee,
                 ABS(COALESCE(removal_fee,0))         AS removal_fee,
                 ABS(COALESCE(marketplace_fees,0))    AS marketplace_fees,
                 ABS(COALESCE(settlement_value,0))    AS amount
          FROM fk_storage_recall
          WHERE TO_CHAR(payment_date,'YYYY-MM') = $1 ${mpCond}
          ORDER BY ABS(settlement_value) DESC LIMIT 500`;
        break;
      case 'ads':
        sql = `
          SELECT TO_CHAR(payment_date,'YYYY-MM-DD') AS date,
                 neft_id, transaction_type, campaign_id,
                 ABS(COALESCE(wallet_redeem,0))        AS wallet_redeem,
                 ABS(COALESCE(gst_on_ads,0))           AS gst_on_ads,
                 ABS(COALESCE(settlement_value,0))      AS amount
          FROM fk_ads
          WHERE TO_CHAR(payment_date,'YYYY-MM') = $1 ${mpCond}
          ORDER BY ABS(settlement_value) DESC LIMIT 500`;
        break;
      case 'google_ads':
        sql = `
          SELECT TO_CHAR(payment_date,'YYYY-MM-DD') AS date,
                 neft_id, service_name, service_details, service_order_id,
                 TO_CHAR(purchase_date,'YYYY-MM-DD')   AS purchase_date,
                 ABS(COALESCE(total_amount,0))          AS total_amount,
                 ABS(COALESCE(service_amount,0))        AS service_amount,
                 ABS(COALESCE(gst_on_service,0))        AS gst_on_service,
                 ABS(COALESCE(settlement_value,0))      AS amount
          FROM fk_google_ads
          WHERE TO_CHAR(payment_date,'YYYY-MM') = $1 ${mpCond}
          ORDER BY ABS(settlement_value) DESC LIMIT 500`;
        break;
      // SPF Claims Received: positive settlement_value — FK credits you (wrong product, approved warehouse claims)
      case 'spf_claims':
        sql = `
          SELECT TO_CHAR(payment_date,'YYYY-MM-DD') AS date,
                 neft_id, claim_id, protection_reason, seller_sku, fsn,
                 COALESCE(selling_price,0)            AS selling_price,
                 COALESCE(settlement_value,0)         AS amount
          FROM fk_spf_claims
          WHERE TO_CHAR(payment_date,'YYYY-MM') = $1 ${mpCond}
            AND settlement_value > 0
          ORDER BY settlement_value DESC LIMIT 500`;
        break;
      // SPF Warehouse Loss / Recovery: negative settlement_value — FK deducts from you
      case 'spf_loss':
        sql = `
          SELECT TO_CHAR(payment_date,'YYYY-MM-DD') AS date,
                 neft_id, claim_id, protection_reason, seller_sku, fsn,
                 COALESCE(selling_price,0)            AS selling_price,
                 ABS(COALESCE(settlement_value,0))    AS amount
          FROM fk_spf_claims
          WHERE TO_CHAR(payment_date,'YYYY-MM') = $1 ${mpCond}
            AND settlement_value < 0
          ORDER BY ABS(settlement_value) DESC LIMIT 500`;
        break;
      // Legacy: all SPF rows combined (kept for backward compat)
      case 'spf':
        sql = `
          SELECT TO_CHAR(payment_date,'YYYY-MM-DD') AS date,
                 neft_id, claim_id, protection_reason, seller_sku, fsn,
                 COALESCE(selling_price,0)           AS selling_price,
                 COALESCE(settlement_value,0)        AS amount
          FROM fk_spf_claims
          WHERE TO_CHAR(payment_date,'YYYY-MM') = $1 ${mpCond}
          ORDER BY settlement_value DESC LIMIT 500`;
        break;
      default:
        return res.status(400).json({ error: `Unknown source: ${source}` });
    }

    const { rows } = await pool.query(sql, params);
    const total = rows.reduce((s, r) => s + (+r.amount || 0), 0);
    res.json({ source, month, total, rows });
  } catch (err) {
    console.error('[non-order-detail]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /settlement/order-fee-compare ────────────────────────────────────────
// Per-order FK actual fees vs RC expected fees for a given order month
// Params: month (YYYY-MM), marketplace?, page?, pageSize?, varFilter? (over|under|match|norc), all?
router.get('/settlement/order-fee-compare', async (req, res) => {
  try {
    const pool = getPool();
    const { page = '1', pageSize = '50', varFilter, all } = req.query;
    const month = typeof req.query.month === 'string' ? req.query.month.trim() : '';
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month must use YYYY-MM format' });
    }
    const marketplace = parseMarketplaceFilter(req.query.marketplace);

    const pg   = positiveInt(page, 1);
    const ps   = all === 'true' ? 5000 : positiveInt(pageSize, 50, { max: 200 });
    const offs = (pg - 1) * ps;

    let mpCond = '';
    const baseParams = [month];
    if (marketplace === 'myntra_vb') {
      mpCond = "AND o.marketplace = 'myntra' AND COALESCE(o.seller_account, 'myntra_vb') = 'myntra_vb'";
    } else if (marketplace === 'myntra_ej') {
      mpCond = "AND o.marketplace = 'myntra' AND o.seller_account = 'myntra_ej'";
    } else if (marketplace === 'myntra') {
      mpCond = "AND o.marketplace = 'myntra'";
    } else if (marketplace) {
      baseParams.push(marketplace);
      mpCond = `AND COALESCE(o.marketplace, 'flipkart') = $${baseParams.length}`;
    }
    const detailParams = [...baseParams, ps, offs];

    // Variance filter condition (applied on computed columns in outer query)
    const VAR_COND =
      varFilter === 'over'  ? 'AND var_status = \'over\''  :
      varFilter === 'under' ? 'AND var_status = \'under\'' :
      varFilter === 'match' ? 'AND var_status = \'match\'' :
      varFilter === 'norc'  ? 'AND var_status = \'no_rc\'' : '';

    // RC expected fee sub-selects (correlated by category + price band + effective date)
    const RC_COMM = `COALESCE((
      SELECT rc.rate * COALESCE(o.final_invoice_amount,0)
      FROM rc_commission rc
      WHERE LOWER(rc.category)=LOWER(o.category)
        AND rc.marketplace=COALESCE(o.marketplace,'flipkart')
        AND rc.seller_account = COALESCE(o.seller_account, 'default')
        AND (rc.brand_name IS NULL OR rc.brand_name='' OR rc.brand_name=o.brand_name)
        AND (rc.price_min IS NULL OR rc.price_min<=COALESCE(o.final_invoice_amount,0))
        AND (rc.price_max IS NULL OR rc.price_max>=COALESCE(o.final_invoice_amount,0))
        AND (rc.start_date IS NULL OR rc.start_date<=COALESCE(fs.payment_date,o.order_date))
        AND (rc.end_date   IS NULL OR rc.end_date  >=COALESCE(fs.payment_date,o.order_date))
      ORDER BY (rc.brand_name IS NOT NULL AND rc.brand_name<>'') DESC,
               rc.start_date DESC NULLS LAST LIMIT 1
    ),0)`;

    const RC_FIXED = `COALESCE((
      SELECT rc.rate FROM rc_fixed_fee rc
      WHERE LOWER(rc.category)=LOWER(o.category)
        AND rc.marketplace=COALESCE(o.marketplace,'flipkart')
        AND rc.seller_account = COALESCE(o.seller_account, 'default')
        AND (rc.price_min IS NULL OR rc.price_min<=COALESCE(o.final_invoice_amount,0))
        AND (rc.price_max IS NULL OR rc.price_max>=COALESCE(o.final_invoice_amount,0))
        AND (rc.start_date IS NULL OR rc.start_date<=COALESCE(fs.payment_date,o.order_date))
        AND (rc.end_date   IS NULL OR rc.end_date  >=COALESCE(fs.payment_date,o.order_date))
      ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
    ),0)`;

    const RC_COLL = `COALESCE((
      SELECT CASE WHEN rc.prepaid_type='flat' THEN rc.prepaid
                  ELSE rc.prepaid * COALESCE(o.final_invoice_amount,0) END
      FROM rc_collection_fee rc
      WHERE LOWER(rc.category)=LOWER(o.category)
        AND rc.marketplace=COALESCE(o.marketplace,'flipkart')
        AND rc.seller_account = COALESCE(o.seller_account, 'default')
        AND (rc.price_min IS NULL OR rc.price_min<=COALESCE(o.final_invoice_amount,0))
        AND (rc.price_max IS NULL OR rc.price_max>=COALESCE(o.final_invoice_amount,0))
        AND (rc.start_date IS NULL OR rc.start_date<=COALESCE(fs.payment_date,o.order_date))
        AND (rc.end_date   IS NULL OR rc.end_date  >=COALESCE(fs.payment_date,o.order_date))
      ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
    ),0)`;

    const RC_PACK = `COALESCE((
      SELECT rc.rate FROM rc_pick_pack rc
      WHERE LOWER(rc.category)=LOWER(o.category)
        AND rc.marketplace=COALESCE(o.marketplace,'flipkart')
        AND rc.seller_account = COALESCE(o.seller_account, 'default')
        AND (rc.price_min IS NULL OR rc.price_min<=COALESCE(o.final_invoice_amount,0))
        AND (rc.price_max IS NULL OR rc.price_max>=COALESCE(o.final_invoice_amount,0))
        AND (rc.start_date IS NULL OR rc.start_date<=COALESCE(fs.payment_date,o.order_date))
        AND (rc.end_date   IS NULL OR rc.end_date  >=COALESCE(fs.payment_date,o.order_date))
      ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
    ),0)`;

    // Base CTE: compute FK fees + RC fees per settled order
    const BASE_CTE = `
    WITH sett AS (
      SELECT order_item_id,
        net_bank,
        payment_date,
        commission AS fk_comm,
        fixed_fee AS fk_fixed,
        collection_fee AS fk_coll,
        pick_pack_fee AS fk_pack,
        shipping_fee AS fk_ship,
        tcs AS fk_tcs,
        tds AS fk_tds,
        gst_on_mp_fees AS fk_gst
      FROM ${ORDER_SETTLEMENT_TOTALS_TABLE}
    ),
    base AS (
      SELECT
        o.order_item_id, o.order_id,
        TO_CHAR(o.order_date,'YYYY-MM-DD') AS order_date,
        TO_CHAR(fs.payment_date,'YYYY-MM-DD') AS payment_date,
        o.sku, o.category,
        COALESCE(o.marketplace,'flipkart') AS marketplace,
        COALESCE(o.final_invoice_amount,0) AS invoice,
        COALESCE(fs.net_bank,0)             AS bank_received,
        COALESCE(fs.fk_comm,0)  AS fk_comm,
        COALESCE(fs.fk_fixed,0) AS fk_fixed,
        COALESCE(fs.fk_coll,0)  AS fk_coll,
        COALESCE(fs.fk_pack,0)  AS fk_pack,
        COALESCE(fs.fk_ship,0)  AS fk_ship,
        COALESCE(fs.fk_tcs,0)   AS fk_tcs,
        COALESCE(fs.fk_tds,0)   AS fk_tds,
        COALESCE(fs.fk_gst,0)   AS fk_gst,
        ${RC_COMM}  AS rc_comm,
        ${RC_FIXED} AS rc_fixed,
        ${RC_COLL}  AS rc_coll,
        ${RC_PACK}  AS rc_pack
      FROM orders o
      INNER JOIN sett fs ON fs.order_item_id=o.order_item_id AND fs.net_bank>0
      WHERE TO_CHAR(o.order_date,'YYYY-MM')=$1 ${mpCond}
    ),
    enriched AS (
      SELECT *,
        (fk_comm+fk_fixed+fk_coll+fk_pack)   AS fk_fees_total,
        (rc_comm+rc_fixed+rc_coll+rc_pack)    AS rc_fees_total,
        (fk_comm+fk_fixed+fk_coll+fk_pack) - (rc_comm+rc_fixed+rc_coll+rc_pack) AS variance,
        CASE
          WHEN (rc_comm+rc_fixed+rc_coll+rc_pack) = 0 AND (fk_comm+fk_fixed+fk_coll+fk_pack) > 0 THEN 'no_rc'
          WHEN (fk_comm+fk_fixed+fk_coll+fk_pack) > (rc_comm+rc_fixed+rc_coll+rc_pack) + 1 THEN 'over'
          WHEN (fk_comm+fk_fixed+fk_coll+fk_pack) < (rc_comm+rc_fixed+rc_coll+rc_pack) - 1 THEN 'under'
          ELSE 'match'
        END AS var_status
      FROM base
    )
    `;

    // Run data + counts queries in parallel
    const [dataRes, countRes] = await Promise.all([
      pool.query(`
        ${BASE_CTE}
        SELECT * FROM enriched
        WHERE 1=1 ${VAR_COND}
        ORDER BY ABS(variance) DESC, invoice DESC
        LIMIT $${detailParams.length - 1} OFFSET $${detailParams.length}
      `, detailParams),

      pool.query(`
        ${BASE_CTE}
        SELECT
          COUNT(*)                                                  AS total,
          COUNT(CASE WHEN var_status='over'  THEN 1 END)            AS over_count,
          COUNT(CASE WHEN var_status='under' THEN 1 END)            AS under_count,
          COUNT(CASE WHEN var_status='match' THEN 1 END)            AS match_count,
          COUNT(CASE WHEN var_status='no_rc' THEN 1 END)            AS no_rc_count,
          COALESCE(SUM(fk_fees_total),0)  AS total_fk_fees,
          COALESCE(SUM(rc_fees_total),0)  AS total_rc_fees,
          COALESCE(SUM(CASE WHEN var_status='over' THEN variance ELSE 0 END),0) AS total_overcharge,
          COALESCE(SUM(CASE WHEN var_status='under' THEN ABS(variance) ELSE 0 END),0) AS total_undercharge
        FROM enriched
      `, baseParams),
    ]);

    const c = countRes.rows[0];
    res.json({
      month, marketplace: marketplace || 'all',
      counts: {
        total:    +c.total,
        over:     +c.over_count,
        under:    +c.under_count,
        match:    +c.match_count,
        noRc:     +c.no_rc_count,
        totalFkFees:    +c.total_fk_fees,
        totalRcFees:    +c.total_rc_fees,
        totalOvercharge:  +c.total_overcharge,
        totalUndercharge: +c.total_undercharge,
      },
      page: pg, pageSize: ps, total: +c.total,
      data: dataRes.rows.map(r => ({
        orderItemId: r.order_item_id,
        orderId:     r.order_id,
        orderDate:   r.order_date,
        paymentDate: r.payment_date,
        sku:         r.sku,
        category:    r.category,
        marketplace: r.marketplace,
        invoice:     +r.invoice,
        bankReceived:+r.bank_received,
        fk: {
          commission:    +r.fk_comm,
          fixedFee:      +r.fk_fixed,
          collectionFee: +r.fk_coll,
          pickPack:      +r.fk_pack,
          shipping:      +r.fk_ship,
          tcs:           +r.fk_tcs,
          tds:           +r.fk_tds,
          gst:           +r.fk_gst,
          total:         +r.fk_fees_total,
        },
        rc: {
          commission:    +r.rc_comm,
          fixedFee:      +r.rc_fixed,
          collectionFee: +r.rc_coll,
          pickPack:      +r.rc_pack,
          total:         +r.rc_fees_total,
        },
        variance:   +r.variance,
        varStatus:  r.var_status,
      })),
    });
  } catch (err) {
    console.error('[order-fee-compare]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /settlement/monthly-statement ─────────────────────────────────────────
router.get('/settlement/monthly-statement', async (req, res) => {
  try {
    const pool = getPool();
    const marketplace = parseMarketplaceFilter(req.query.marketplace);
    const mpCond = marketplace ? "AND COALESCE(marketplace, 'flipkart') = $1" : '';
    const mpParams = marketplace ? [marketplace] : [];
    const includeFlipkartOnlyCharges = !marketplace || marketplace === 'flipkart';
    const M = `TO_CHAR(payment_date, 'YYYY-MM')`;

    const [ordRes, spfRes, storRes, adsRes, gadsRes] = await Promise.all([
      pool.query(`
        SELECT ${M} AS month,
          TO_CHAR(MIN(payment_date), 'YYYY-MM-DD') AS period_start,
          TO_CHAR(MAX(payment_date), 'YYYY-MM-DD') AS period_end,
          SUM(CASE WHEN bank_settlement>0 THEN COALESCE(sale_amount,0)        ELSE 0 END) AS gross_sales,
          SUM(CASE WHEN bank_settlement>0 THEN COALESCE(total_offer_amount,0) ELSE 0 END) AS offer_amount,
          SUM(CASE WHEN bank_settlement>0 THEN COALESCE(my_share,0)           ELSE 0 END) AS my_share,
          SUM(CASE WHEN bank_settlement<0 THEN ABS(COALESCE(sale_amount,0))   ELSE 0 END) AS returns_reversal,
          SUM(bank_settlement) AS net_orders,
          SUM(CASE WHEN bank_settlement>0 THEN ABS(COALESCE(commission,0))       ELSE 0 END) AS commission,
          SUM(CASE WHEN bank_settlement>0 THEN ABS(COALESCE(fixed_fee,0))        ELSE 0 END) AS fixed_fee,
          SUM(CASE WHEN bank_settlement>0 THEN ABS(COALESCE(collection_fee,0))   ELSE 0 END) AS collection_fee,
          SUM(CASE WHEN bank_settlement>0 THEN ABS(COALESCE(pick_pack_fee,0))    ELSE 0 END) AS pick_pack_fee,
          SUM(CASE WHEN bank_settlement>0 THEN ABS(COALESCE(shipping_fee,0))     ELSE 0 END) AS shipping_fee,
          SUM(CASE WHEN bank_settlement>0 THEN ABS(COALESCE(reverse_shipping,0)) ELSE 0 END) AS reverse_shipping,
          SUM(CASE WHEN bank_settlement>0 THEN ABS(COALESCE(franchise_fee,0))    ELSE 0 END) AS franchise_fee,
          SUM(CASE WHEN bank_settlement>0 THEN ABS(COALESCE(tcs,0))              ELSE 0 END) AS tcs,
          SUM(CASE WHEN bank_settlement>0 THEN ABS(COALESCE(tds,0))              ELSE 0 END) AS tds,
          SUM(CASE WHEN bank_settlement>0 THEN ABS(COALESCE(gst_on_mp_fees,0))   ELSE 0 END) AS gst_on_mp_fees,
          COUNT(DISTINCT CASE WHEN bank_settlement>0 THEN order_item_id END) AS sale_count,
          COUNT(DISTINCT CASE WHEN bank_settlement<0 THEN order_item_id END) AS return_count
        FROM unified_settlements WHERE payment_date IS NOT NULL ${mpCond}
        GROUP BY ${M}`, mpParams),

      pool.query(`
        SELECT ${M} AS month, SUM(settlement_value) AS spf_total
        FROM fk_spf_claims WHERE payment_date IS NOT NULL ${includeFlipkartOnlyCharges ? '' : 'AND 1=0'} GROUP BY ${M}`),

      pool.query(`
        SELECT ${M} AS month,
          SUM(CASE WHEN service_name ILIKE '%storage%' THEN settlement_value ELSE 0 END) AS storage_total,
          SUM(CASE WHEN service_name ILIKE '%recall%' OR service_name ILIKE '%removal%'  THEN settlement_value ELSE 0 END) AS recall_total,
          SUM(settlement_value) AS stor_total
        FROM fk_storage_recall WHERE payment_date IS NOT NULL ${includeFlipkartOnlyCharges ? '' : 'AND 1=0'} GROUP BY ${M}`),

      pool.query(`
        SELECT ${M} AS month, SUM(settlement_value) AS ads_total
        FROM fk_ads WHERE payment_date IS NOT NULL ${includeFlipkartOnlyCharges ? '' : 'AND 1=0'} GROUP BY ${M}`),

      pool.query(`
        SELECT ${M} AS month, SUM(settlement_value) AS google_ads_total
        FROM fk_google_ads WHERE payment_date IS NOT NULL ${includeFlipkartOnlyCharges ? '' : 'AND 1=0'} GROUP BY ${M}`),
    ]);

    const mm = {};
    for (const r of ordRes.rows)  { mm[r.month] = { ...r }; }
    for (const r of spfRes.rows)  { if (!mm[r.month]) mm[r.month] = { month: r.month }; mm[r.month].spf_total = r.spf_total; }
    for (const r of storRes.rows) { if (!mm[r.month]) mm[r.month] = { month: r.month }; Object.assign(mm[r.month], { storage_total: r.storage_total, recall_total: r.recall_total, stor_total: r.stor_total }); }
    for (const r of adsRes.rows)  { if (!mm[r.month]) mm[r.month] = { month: r.month }; mm[r.month].ads_total = r.ads_total; }
    for (const r of gadsRes.rows) { if (!mm[r.month]) mm[r.month] = { month: r.month }; mm[r.month].google_ads_total = r.google_ads_total; }

    const months = Object.keys(mm).sort();
    const allData = [];

    for (const month of months) {
      const d = mm[month];
      const gs = +(d.gross_sales || 0);
      const period = d.period_start && d.period_end ? `${d.period_start} — ${d.period_end}` : month;

      const row = (description, category, net, credits, debits) => ({
        month, period, description, category,
        credits: credits ?? (net >= 0 ? +net.toFixed(2) : 0),
        debits:  debits  ?? (net <  0 ? +(-net).toFixed(2) : 0),
        net: +net.toFixed(2),
        pct: gs > 0 ? +(net / gs * 100).toFixed(2) : 0,
      });

      if (gs > 0)                            allData.push(row('Sale Amount',             'Revenue',     gs, gs, 0));
      if ((d.returns_reversal||0) > 0.01)    allData.push(row('Returns Reversal',        'Return Cost', -(+(d.returns_reversal)||0), 0, +(d.returns_reversal)||0));
      if (Math.abs(+(d.offer_amount)||0) > 0.01) allData.push(row('Offer Amount (MP Share)', 'Adjustment', +(d.offer_amount)||0));
      if (Math.abs(+(d.my_share)||0) > 0.01) allData.push(row('My Share (Seller Offers)','Adjustment',  +(d.my_share)||0));
      if ((d.commission||0) > 0.01)          allData.push(row('Commission',              'Marketplace Fee',-(d.commission||0)));
      if ((d.fixed_fee||0) > 0.01)           allData.push(row('Fixed Fee',               'Marketplace Fee',-(d.fixed_fee||0)));
      if ((d.collection_fee||0) > 0.01)      allData.push(row('Collection Fee',          'Marketplace Fee',-(d.collection_fee||0)));
      if ((d.pick_pack_fee||0) > 0.01)       allData.push(row('Pick & Pack Fee',         'Marketplace Fee',-(d.pick_pack_fee||0)));
      if ((d.shipping_fee||0) > 0.01)        allData.push(row('Shipping Fee',            'Marketplace Fee',-(d.shipping_fee||0)));
      if ((d.reverse_shipping||0) > 0.01)    allData.push(row('Reverse Shipping',        'Marketplace Fee',-(d.reverse_shipping||0)));
      if ((d.franchise_fee||0) > 0.01)       allData.push(row('Franchise Fee',           'Marketplace Fee',-(d.franchise_fee||0)));
      if ((d.tcs||0) > 0.01)                 allData.push(row('TCS',                     'Tax',         -(d.tcs||0)));
      if ((d.tds||0) > 0.01)                 allData.push(row('TDS',                     'Tax',         -(d.tds||0)));
      if ((d.gst_on_mp_fees||0) > 0.01)      allData.push(row('GST on MP Fees',          'Tax',         -(d.gst_on_mp_fees||0)));
      if ((d.fk_other_fee||0) > 0.01)        allData.push(row('Other Amazon Fees',       'Amazon Fee',  -(d.fk_other_fee||0)));
      if (d.spf_total)                        allData.push(row('SPF Claims',              'Adjustment',  +(d.spf_total||0)));
      if (d.storage_total)                    allData.push(row('Storage Fee',             'Marketplace Fee',+(d.storage_total||0)));
      if (d.recall_total)                     allData.push(row('Recall / Removal Fee',    'Marketplace Fee',+(d.recall_total||0)));
      if (d.ads_total)                        allData.push(row('Marketplace Ads',            'Marketplace Fee',+(d.ads_total||0)));
      if (d.google_ads_total)                 allData.push(row('Google Ads',              'Marketplace Fee',+(d.google_ads_total||0)));

      const totalNet = +(d.net_orders||0) + +(d.spf_total||0) + +(d.stor_total||0) + +(d.ads_total||0) + +(d.google_ads_total||0);
      allData.push(row('NET SETTLED', 'Total', totalNet, totalNet >= 0 ? totalNet : 0, totalNet < 0 ? -totalNet : 0));
    }

    res.json({ months, data: allData });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /settlement/reco-statement ───────────────────────────────────────────
router.get('/settlement/reco-statement', async (req, res) => {
  try {
    const pool = getPool();
    const marketplace = parseMarketplaceFilter(req.query.marketplace);
    let mpCond = '';
    const mpParams = [];
    if (marketplace === 'myntra_vb') {
      mpCond = "AND o.marketplace = 'myntra' AND COALESCE(o.seller_account, 'myntra_vb') = 'myntra_vb'";
    } else if (marketplace === 'myntra_ej') {
      mpCond = "AND o.marketplace = 'myntra' AND o.seller_account = 'myntra_ej'";
    } else if (marketplace === 'myntra') {
      mpCond = "AND o.marketplace = 'myntra'";
    } else if (marketplace) {
      mpParams.push(marketplace);
      mpCond = `AND COALESCE(o.marketplace, 'flipkart') = $${mpParams.length}`;
    }
    const includeFlipkartOnlyCharges = !marketplace || marketplace === 'flipkart';
    const M  = `TO_CHAR(payment_date, 'YYYY-MM')`;
    const OM = `TO_CHAR(order_date, 'YYYY-MM')`;

    const [fkRes, vbRes, spfRes, storRes, adsRes, pendingRes] = await Promise.all([
      // FK Settlement: actual amounts FK deducted — grouped by ORDER DATE to match month-pl
      // INNER JOIN with orders so we only include orders that exist in the orders table
      // (same universe as month-pl which drives FROM orders o)
      pool.query(`
        SELECT TO_CHAR(o.order_date, 'YYYY-MM') AS month,
          SUM(CASE WHEN fk.bank_settlement>0 THEN COALESCE(fk.sale_amount,0) ELSE 0 END)           AS mp_sale,
          SUM(CASE WHEN fk.bank_settlement<0 THEN ABS(COALESCE(fk.sale_amount,0)) ELSE 0 END)      AS mp_returns,
          SUM(fk.bank_settlement)                                                                    AS net_settled,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.commission,0)) ELSE 0 END)       AS mp_commission,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.fixed_fee,0)) ELSE 0 END)        AS mp_fixed_fee,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.collection_fee,0)) ELSE 0 END)   AS mp_collection_fee,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.pick_pack_fee,0)) ELSE 0 END)    AS mp_pick_pack_fee,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.shipping_fee,0)) ELSE 0 END)     AS mp_shipping_fee,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.reverse_shipping,0)) ELSE 0 END) AS mp_reverse_shipping,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.franchise_fee,0)) ELSE 0 END)    AS mp_franchise_fee,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.tcs,0)) ELSE 0 END)              AS mp_tcs,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.tds,0)) ELSE 0 END)              AS mp_tds,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.gst_on_mp_fees,0)) ELSE 0 END)   AS mp_gst,
          SUM(CASE WHEN fk.bank_settlement>0 THEN ABS(COALESCE(fk.mp_other_fee,0)) ELSE 0 END)     AS mp_other_fee,
          COUNT(DISTINCT CASE WHEN fk.bank_settlement>0 THEN fk.order_item_id END)                  AS settled_count,
          COUNT(DISTINCT CASE WHEN fk.bank_settlement<0 THEN fk.order_item_id END)                  AS return_count
        FROM unified_settlements fk
        INNER JOIN orders o ON o.order_item_id = fk.order_item_id
        WHERE o.order_date IS NOT NULL ${mpCond}
        GROUP BY TO_CHAR(o.order_date, 'YYYY-MM') ORDER BY month
      `, mpParams),

      // ── RC-Calculated fees: per-order Rate Card expected values ──────────────────
      //
      // KEY DESIGN DECISIONS (document for future reference):
      //
      // 1. DATE BASIS: Uses o.order_date (not payment_date) so this aligns with month-pl
      //    which also groups by order_date. This ensures the RC Check compares the SAME
      //    set of orders as the Fees Deducted section above it in the P&L panel.
      //
      // 2. PRICE BASE — CRITICAL:
      //    We use COALESCE(fk.sale_amount, o.final_invoice_amount) as the price base,
      //    NOT o.final_invoice_amount alone.
      //
      //    WHY: Flipkart calculates ALL fees (commission, collection, fixed fee, pick&pack)
      //    on fk.sale_amount — the actual selling price after Flipkart's discounts/offers.
      //    The orders table stores final_invoice_amount (gross MRP / pre-discount price).
      //    These differ by ~20% on average (e.g. March 2026: invoice=₹94.9L vs sale=₹76.1L).
      //
      //    Using the wrong base gives WRONG price-band lookup AND wrong fee calculation:
      //    - An order with invoice ₹1,400 (band: 1200-2000 → 2.13% collection fee)
      //      but sale ₹950 (band: 500-999 → 0.3% collection fee) — completely different!
      //    - Commission RC is OVER-estimated if invoice > sale (RC says 21% of ₹1,400 but
      //      FK actually charged 21% of ₹950 = much lower)
      //
      // 3. COLLECTION FEE — uses prepaid rate (same for prepaid/COD in most slabs).
      //    unified_settlements has no payment_mode column, so we cannot distinguish.
      //    prepaid==postpaid for most slabs, so this gives correct result.
      //    Exception: if postpaid>>prepaid, the RC will understate COD collection fee.
      //
      // 4. RATE PERIOD LOOKUP: uses o.order_date to find the rate active on order day
      //    (ORDER BY start_date DESC LIMIT 1 picks the most recently started valid period).
      //    If no period covers a date (e.g., rate card gaps between periods), returns NULL
      //    → displayed as "no RC data". Fix: ensure rate card periods have no gaps.
      //
      pool.query(`
        -- ── PER-UNIT PRICE LOGIC (CRITICAL) ──────────────────────────────────
        -- FK calculates ALL fees on PER-UNIT price, NOT total order price.
        -- Example: qty=3, sale_amount=₹2109 → unit_price=₹703
        --   Commission: rate(₹703) × ₹703 × 3 = total commission
        --   Collection:  rate(₹703) × ₹703 × 3 = total collection fee
        --   Fixed fee:   flat_rate(₹703) × 3 = total fixed fee
        --   Pick & Pack: flat_rate(₹703) × 3 = total pick & pack fee
        -- Band lookup MUST use unit_price (₹703), NOT total (₹2109).
        -- ──────────────────────────────────────────────────────────────────────
        WITH rc_calc AS (
          SELECT
            fk.order_item_id,
            TO_CHAR(o.order_date, 'YYYY-MM')   AS month,
            -- Total sale amount (for display / aggregation)
            COALESCE(NULLIF(fk.sale_amount, 0), o.final_invoice_amount, 0) AS inv_amt,
            -- Quantity: use fk.quantity first, fallback to orders.qty, minimum 1
            GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)                   AS qty,
            -- Per-unit price = total_sale / qty (FK uses this for ALL fee band lookups)
            COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
              / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)               AS unit_price,
            -- Normalised category (strip shopsy_ prefix for RC lookup)
            REGEXP_REPLACE(LOWER(o.category), '^shopsy_', '')              AS norm_cat,

            -- Commission: rate(unit_price) × total_sale_amount
            -- (rate × unit_price × qty = rate × total, so we can use total directly for % fees)
            COALESCE((
              SELECT rc.rate * COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
              FROM rc_commission rc
              WHERE LOWER(rc.category) = REGEXP_REPLACE(LOWER(o.category), '^shopsy_', '')
                AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND (rc.brand_name IS NULL OR rc.brand_name = '' OR rc.brand_name = o.brand_name)
                AND rc.price_min <= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
                                     / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
                AND rc.price_max >= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
                                     / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
                AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
                AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
              ORDER BY (rc.brand_name IS NOT NULL AND rc.brand_name <> '') DESC,
                       rc.start_date DESC NULLS LAST LIMIT 1
            ), 0) AS vb_commission,

            -- Fixed fee: flat ₹ per UNIT × qty (NULL = no RC entry)
            (
              SELECT rc.rate * GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
              FROM rc_fixed_fee rc
              WHERE LOWER(rc.category) = REGEXP_REPLACE(LOWER(o.category), '^shopsy_', '')
                AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND rc.price_min <= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
                                     / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
                AND rc.price_max >= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
                                     / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
                AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
                AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
              ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
            ) AS vb_fixed_fee,

            -- Collection fee: band lookup uses UNIT_PRICE; result × qty
            -- prepaid_type='flat' → flat_amt × qty; 'pct' → rate × unit_price × qty = rate × total
            (
              SELECT CASE
                WHEN rc.prepaid_type = 'flat'
                     THEN rc.prepaid * GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
                ELSE rc.prepaid * COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
              END
              FROM rc_collection_fee rc
              WHERE LOWER(rc.category) = REGEXP_REPLACE(LOWER(o.category), '^shopsy_', '')
                AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND rc.price_min <= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
                                     / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
                AND rc.price_max >= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
                                     / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
                AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
                AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
              ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
            ) AS vb_collection_fee,

            (
              SELECT rc.rate * GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
              FROM rc_pick_pack rc
              WHERE LOWER(rc.category) = REGEXP_REPLACE(LOWER(o.category), '^shopsy_', '')
                AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND rc.price_min <= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
                                     / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
                AND rc.price_max >= COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
                                     / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
                AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
                AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
              ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
            ) AS vb_pick_pack_fee
          FROM unified_settlements fk
          INNER JOIN orders o ON o.order_item_id = fk.order_item_id
          WHERE o.order_date IS NOT NULL ${mpCond} AND fk.bank_settlement > 0
        )
        SELECT month,
          SUM(inv_amt)              AS vb_sale,
          SUM(vb_commission)        AS vb_commission,
          SUM(vb_fixed_fee)         AS vb_fixed_fee,
          SUM(vb_collection_fee)    AS vb_collection_fee,
          SUM(vb_pick_pack_fee)     AS vb_pick_pack_fee,
          0                         AS vb_shipping_fee,
          COUNT(DISTINCT order_item_id) AS vb_order_count
        FROM rc_calc GROUP BY month ORDER BY month
      `, mpParams),

      pool.query(`SELECT ${M} AS month, SUM(settlement_value) AS spf_total
        FROM fk_spf_claims WHERE payment_date IS NOT NULL ${includeFlipkartOnlyCharges ? '' : 'AND 1=0'} GROUP BY ${M}
      `).catch(() => ({ rows: [] })),

      pool.query(`SELECT ${M} AS month, SUM(settlement_value) AS stor_total
        FROM fk_storage_recall WHERE payment_date IS NOT NULL ${includeFlipkartOnlyCharges ? '' : 'AND 1=0'} GROUP BY ${M}
      `).catch(() => ({ rows: [] })),

      pool.query(`SELECT ${M} AS month, SUM(settlement_value) AS ads_total
        FROM fk_ads WHERE payment_date IS NOT NULL ${includeFlipkartOnlyCharges ? '' : 'AND 1=0'} GROUP BY ${M}
      `).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT ${OM} AS month,
          COUNT(*)                                      AS pending_count,
          SUM(COALESCE(final_invoice_amount, 0))        AS pending_amount
        FROM orders o
        WHERE o.order_date IS NOT NULL ${mpCond}
          AND NOT EXISTS (
          SELECT 1 FROM ${ORDER_SETTLEMENT_TOTALS_TABLE} fko WHERE fko.order_item_id = o.order_item_id
        )
        GROUP BY ${OM} ORDER BY month
      `, mpParams),
    ]);

    const mm = {};
    for (const r of fkRes.rows)   mm[r.month] = { ...r };
    for (const r of vbRes.rows)   { if (!mm[r.month]) mm[r.month] = { month: r.month }; Object.assign(mm[r.month], r); }
    for (const r of spfRes.rows)  { if (!mm[r.month]) mm[r.month] = { month: r.month }; mm[r.month].spf_total  = r.spf_total;  }
    for (const r of storRes.rows) { if (!mm[r.month]) mm[r.month] = { month: r.month }; mm[r.month].stor_total = r.stor_total; }
    for (const r of adsRes.rows)  { if (!mm[r.month]) mm[r.month] = { month: r.month }; mm[r.month].ads_total  = r.ads_total;  }

    const pendingByMonth = {};
    for (const r of pendingRes.rows) pendingByMonth[r.month] = r;

    const months = Object.keys(mm).sort();

    const data = months.map(month => {
      const d = mm[month];

      const rcVal = (v) => (v != null && +v > 0) ? +v : null;

      const mpSaleAmt      = +(d.mp_sale || 0);
      const mpTaxableFees  = +(d.mp_commission||0) + +(d.mp_fixed_fee||0)
                           + +(d.mp_collection_fee||0) + +(d.mp_pick_pack_fee||0)
                           + +(d.mp_shipping_fee||0);
      const vbTcs = +(mpSaleAmt * 0.01).toFixed(2);
      const vbTds = +(mpSaleAmt * 0.001).toFixed(2);
      const vbGst = +(mpTaxableFees * 0.18).toFixed(2);

      const lines = [
        { key: 'commission',       label: 'Commission',       cat: 'fee', fk: +(d.fk_commission||0),        vb: +(d.vb_commission||0)        },
        { key: 'fixed_fee',        label: 'Fixed Fee',         cat: 'fee', fk: +(d.fk_fixed_fee||0),         vb: rcVal(d.vb_fixed_fee)         },
        { key: 'collection_fee',   label: 'Collection Fee',    cat: 'fee', fk: +(d.fk_collection_fee||0),    vb: rcVal(d.vb_collection_fee)    },
        { key: 'pick_pack_fee',    label: 'Pick & Pack Fee',   cat: 'fee', fk: +(d.fk_pick_pack_fee||0),     vb: rcVal(d.vb_pick_pack_fee)     },
        { key: 'shipping_fee',     label: 'Shipping Fee',      cat: 'fee', fk: +(d.fk_shipping_fee||0),      vb: null },
        { key: 'reverse_shipping', label: 'Reverse Shipping',  cat: 'fee', fk: +(d.fk_reverse_shipping||0),  vb: null },
        { key: 'franchise_fee',    label: 'Franchise Fee',     cat: 'fee', fk: +(d.fk_franchise_fee||0),     vb: null },
        { key: 'tcs',              label: 'TCS',               cat: 'tax', fk: +(d.fk_tcs||0),               vb: vbTcs, calc: true },
        { key: 'tds',              label: 'TDS',               cat: 'tax', fk: +(d.fk_tds||0),               vb: vbTds, calc: true },
        { key: 'gst_on_mp_fees',   label: 'GST on MP Fees',    cat: 'tax', fk: +(d.fk_gst||0),               vb: vbGst, calc: true },
        { key: 'mp_other_fee',     label: 'Other Amazon Fees', cat: 'fee', fk: +(d.fk_other_fee||0),         vb: null },
      ]
        .filter(l => l.fk > 0.005 || (l.vb !== null && l.vb > 0.005))
        .map(l => ({
          ...l,
          variance:    l.vb !== null ? +(l.fk - l.vb).toFixed(2) : null,
          // Effective MP rate as % of MP sale amount — shows what FK actually charged per ₹1 of sale
          // Useful for diagnosing whether the rate card data reflects reality
          // e.g. Collection Fee FK eff=0.53% but RC expected only 0.01% → rate card needs updating
          fkEffRate:   mpSaleAmt > 0 ? +((l.fk / mpSaleAmt) * 100).toFixed(3) : 0,
          // Effective RC rate as % of RC scope sale amount (vbSale = sum of sale_amount in RC scope)
          rcEffRate:   l.vb != null && +(d.vb_sale||0) > 0
                         ? +((l.vb / +(d.vb_sale||1)) * 100).toFixed(3)
                         : null,
        }));

      const fkSale        = +(d.fk_sale       || 0);
      const vbSale        = +(d.vb_sale        || 0);
      const fkReturns     = +(d.fk_returns     || 0);
      const netSettled    = +(d.net_settled     || 0);
      const spfTotal      = +(d.spf_total       || 0);
      const storTotal     = +(d.stor_total      || 0);
      const adsTotal      = +(d.ads_total       || 0);
      // All FK fees (display in table — including lines without RC data)
      const totalFkFees = +lines.reduce((s, l) => s + l.fk, 0).toFixed(2);
      // Only lines where RC data exists — the correct apples-to-apples comparison
      const comparableLines   = lines.filter(l => l.vb !== null);
      const totalFkComparable = +comparableLines.reduce((s, l) => s + l.fk, 0).toFixed(2);
      const totalVbFees       = +comparableLines.reduce((s, l) => s + (l.vb || 0), 0).toFixed(2);
      // +ve = FK overcharged vs RC expected; -ve = FK undercharged (good for seller)
      const feeVariance = +(totalFkComparable - totalVbFees).toFixed(2);
      const vbExpectedNet = +(vbSale - fkReturns - totalVbFees + spfTotal + storTotal + adsTotal).toFixed(2);

      return {
        month, fkSale, vbSale, fkReturns, netSettled,
        spfTotal, storTotal, adsTotal,
        settledCount:  +(d.settled_count  || 0),
        returnCount:   +(d.return_count   || 0),
        vbOrderCount:  +(d.vb_order_count || 0),
        totalFkFees, totalFkComparable, totalVbFees, feeVariance, vbExpectedNet,
        lines,
        pending: pendingByMonth[month]
          ? { count: +pendingByMonth[month].pending_count, amount: +pendingByMonth[month].pending_amount }
          : null,
      };
    });

    res.json({ months, data });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── POST /api/settlement/push-report ─────────────────────────────────────────
router.post('/settlement/push-report', async (req, res) => {
  try {
    const pool = getPool();
    await pool.query(`DELETE FROM reconciliation_reports`);
    const { rows } = await pool.query(`
      ${SETT_CTE}
      SELECT
        TO_CHAR(o.order_date, 'YYYY-MM-DD')    AS order_date,
        o.order_item_id,
        o.order_id,
        o.category,
        o.fulfilment_type,
        o.delivery_state,
        o.final_invoice_amount                 AS invoice_amount,
        COALESCE(s.net_bank, 0)                AS bank_received,
        COALESCE(s.refund_amount, 0)           AS refund_debited,
        COALESCE(s.net_bank, 0) - COALESCE(s.refund_amount, 0) AS net_settlement,
        ret.return_reason,
        ret.return_type,
        ${STATUS_EXPR}                         AS settlement_status
      FROM orders o
      LEFT JOIN sett s      ON s.order_item_id = o.order_item_id
      LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
    `);

    if (rows.length) {
      const cols  = ['order_date','order_item_id','order_id','category','fulfilment_type',
                     'delivery_state','invoice_amount','bank_received','refund_debited',
                     'net_settlement','return_reason','return_type','settlement_status'];
      await forEachDbBatch(rows, cols.length, async batch => {
        const values = [];
        const groups = batch.map(r => {
          const start = values.length;
          const vals  = cols.map(c => r[c]);
          values.push(...vals);
          return `(${vals.map((_, ci) => `$${start + ci + 1}`).join(', ')})`;
        });
        await pool.query(`INSERT INTO reconciliation_reports (${cols.join(', ')}) VALUES ${groups.join(', ')}`, values);
      });
    }
    res.json({ ok: true, rows: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settlement/sale-statement ───────────────────────────────────────
// Order-date based statement: sale → returns → FK fees (settled only) → bank received → carry forward
router.get('/settlement/sale-statement', async (req, res) => {
  try {
    const pool = getPool();
    const marketplace = parseMarketplaceFilter(req.query.marketplace);
    let mpCond = '';
    let settlementMpCond = '';
    const mpParams = [];
    if (marketplace === 'myntra_vb') {
      mpCond = "AND o.marketplace = 'myntra' AND COALESCE(o.seller_account, 'myntra_vb') = 'myntra_vb'";
      settlementMpCond = "AND marketplace = 'myntra'";
    } else if (marketplace === 'myntra_ej') {
      mpCond = "AND o.marketplace = 'myntra' AND o.seller_account = 'myntra_ej'";
      settlementMpCond = "AND marketplace = 'myntra'";
    } else if (marketplace === 'myntra') {
      mpCond = "AND o.marketplace = 'myntra'";
      settlementMpCond = "AND marketplace = 'myntra'";
    } else if (marketplace) {
      mpParams.push(marketplace);
      mpCond = `AND COALESCE(o.marketplace, 'flipkart') = $${mpParams.length}`;
      settlementMpCond = `AND COALESCE(marketplace, 'flipkart') = $${mpParams.length}`;
    }

    // Per-sale-month aggregation joining settled orders to their FK settlement rows
    const { rows: saleRows } = await pool.query(`
      WITH sett AS (
        SELECT
          order_item_id,
          SUM(bank_settlement)                                              AS net_bank,
          SUM(CASE WHEN refund < 0 THEN ABS(refund) ELSE 0 END)            AS refund_amount,
          SUM(ABS(COALESCE(commission,0)))                                  AS fk_commission,
          SUM(ABS(COALESCE(fixed_fee,0)))                                   AS fk_fixed_fee,
          SUM(ABS(COALESCE(collection_fee,0)))                              AS fk_collection_fee,
          SUM(ABS(COALESCE(pick_pack_fee,0)))                               AS fk_pick_pack_fee,
          SUM(ABS(COALESCE(shipping_fee,0)))                                AS fk_shipping_fee,
          SUM(ABS(COALESCE(reverse_shipping,0)))                            AS fk_reverse_shipping,
          SUM(ABS(COALESCE(franchise_fee,0)))                               AS fk_franchise_fee,
          SUM(ABS(COALESCE(tcs,0)))                                         AS fk_tcs,
          SUM(ABS(COALESCE(tds,0)))                                         AS fk_tds,
          SUM(ABS(COALESCE(gst_on_mp_fees,0)))                              AS fk_gst,
          0                                                                  AS fk_other_fee
        FROM unified_settlements
        GROUP BY order_item_id
      )
      SELECT
        TO_CHAR(DATE_TRUNC('month', o.order_date), 'Mon-YYYY')            AS sale_month,
        DATE_TRUNC('month', o.order_date)                                  AS month_sort,
        COUNT(*)                                                           AS order_count,
        SUM(o.final_invoice_amount)                                        AS gross_sale,
        -- Returns / clawback from settlement
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.refund_amount ELSE 0 END), 0)  AS return_amount,
        COUNT(CASE WHEN s.order_item_id IS NOT NULL THEN 1 END)            AS settled_count,
        COUNT(CASE WHEN s.order_item_id IS NULL     THEN 1 END)            AS pending_count,
        COUNT(CASE WHEN s.refund_amount > 0.01      THEN 1 END)            AS return_count,
        -- Bank received (settled orders net)
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.net_bank ELSE 0 END), 0)       AS bank_received,
        -- Pending invoice total
        COALESCE(SUM(CASE WHEN s.order_item_id IS NULL THEN o.final_invoice_amount ELSE 0 END), 0) AS pending_invoice,
        -- VB-calculated fees for pending orders (from orders export columns)
        COALESCE(SUM(CASE WHEN s.order_item_id IS NULL THEN
          ABS(COALESCE(o.commission,0)) + ABS(COALESCE(o.fixed_fee,0)) +
          ABS(COALESCE(o.collection_fee,0)) + ABS(COALESCE(o.pick_pack_fee,0)) +
          ABS(COALESCE(o.shipping_fee,0))
        ELSE 0 END), 0)                                                    AS pending_vb_fees,
        -- FK fees (settled orders only, from settlement sheet)
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.fk_commission      ELSE 0 END), 0) AS fk_commission,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.fk_fixed_fee       ELSE 0 END), 0) AS fk_fixed_fee,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.fk_collection_fee  ELSE 0 END), 0) AS fk_collection_fee,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.fk_pick_pack_fee   ELSE 0 END), 0) AS fk_pick_pack_fee,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.fk_shipping_fee    ELSE 0 END), 0) AS fk_shipping_fee,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.fk_reverse_shipping ELSE 0 END), 0) AS fk_reverse_shipping,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.fk_franchise_fee   ELSE 0 END), 0) AS fk_franchise_fee,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.fk_tcs             ELSE 0 END), 0) AS fk_tcs,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.fk_tds             ELSE 0 END), 0) AS fk_tds,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN s.fk_gst             ELSE 0 END), 0) AS fk_gst,
        -- VB-calculated fees for SETTLED orders (from orders export)
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN ABS(COALESCE(o.commission,0))    ELSE 0 END), 0) AS vb_commission,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN ABS(COALESCE(o.fixed_fee,0))     ELSE 0 END), 0) AS vb_fixed_fee,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN ABS(COALESCE(o.collection_fee,0)) ELSE 0 END), 0) AS vb_collection_fee,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN ABS(COALESCE(o.pick_pack_fee,0)) ELSE 0 END), 0) AS vb_pick_pack_fee,
        COALESCE(SUM(CASE WHEN s.order_item_id IS NOT NULL THEN ABS(COALESCE(o.shipping_fee,0))  ELSE 0 END), 0) AS vb_shipping_fee
      FROM orders o
      LEFT JOIN sett s ON s.order_item_id = o.order_item_id
      WHERE o.order_date IS NOT NULL ${mpCond}
      GROUP BY DATE_TRUNC('month', o.order_date)
      ORDER BY DATE_TRUNC('month', o.order_date)
    `, mpParams);

    // RC-calculated fees using the rate card tables directly in SQL
    // (mirrors the rc_calc CTE pattern used in /reco-statement)
    const { rows: rcRows } = await pool.query(`
      WITH rc_calc AS (
        SELECT
          o.order_item_id,
          o.final_invoice_amount AS inv_amt,
          CASE WHEN LOWER(COALESCE(o.order_type,'prepaid')) LIKE '%prepaid%' THEN 'prepaid' ELSE 'postpaid' END AS pay_type,

          -- Commission
          COALESCE((
            SELECT rc.rate * COALESCE(o.final_invoice_amount, 0)
            FROM rc_commission rc
            WHERE LOWER(rc.category) = LOWER(o.category)
              AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND (rc.brand_name IS NULL OR rc.brand_name = '' OR rc.brand_name = o.brand_name)
              AND (rc.price_min IS NULL OR rc.price_min <= COALESCE(o.final_invoice_amount,0))
              AND (rc.price_max IS NULL OR rc.price_max >= COALESCE(o.final_invoice_amount,0))
              AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
              AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
            ORDER BY (rc.brand_name IS NOT NULL AND rc.brand_name <> '') DESC,
                     rc.start_date DESC NULLS LAST
            LIMIT 1
          ), 0) AS calc_commission,

          -- Fixed Fee
          COALESCE((
            SELECT rc.rate
            FROM rc_fixed_fee rc
            WHERE LOWER(rc.category) = LOWER(o.category)
              AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND (rc.price_min IS NULL OR rc.price_min <= COALESCE(o.final_invoice_amount,0))
              AND (rc.price_max IS NULL OR rc.price_max >= COALESCE(o.final_invoice_amount,0))
              AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
              AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
            ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
          ), 0) AS calc_fixed_fee,

          -- Collection Fee
          COALESCE((
            SELECT
              CASE WHEN rc.prepaid_type = 'flat'
                   THEN rc.prepaid
                   ELSE rc.prepaid * COALESCE(o.final_invoice_amount, 0)
              END
            FROM rc_collection_fee rc
            WHERE LOWER(rc.category) = LOWER(o.category)
              AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND (rc.price_min IS NULL OR rc.price_min <= COALESCE(o.final_invoice_amount,0))
              AND (rc.price_max IS NULL OR rc.price_max >= COALESCE(o.final_invoice_amount,0))
              AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
              AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
            ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
          ), 0) AS calc_collection_fee,

          -- Pick & Pack
          COALESCE((
            SELECT rc.rate
            FROM rc_pick_pack rc
            WHERE LOWER(rc.category) = LOWER(o.category)
              AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND (rc.price_min IS NULL OR rc.price_min <= COALESCE(o.final_invoice_amount,0))
              AND (rc.price_max IS NULL OR rc.price_max >= COALESCE(o.final_invoice_amount,0))
              AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
              AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
            ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
          ), 0) AS calc_pick_pack_fee,

          -- Reverse Shipping
          COALESCE((
            SELECT
              CASE
                WHEN LOWER(COALESCE(o.shipping_zone,'national')) = 'local'     THEN rc.local_fee
                WHEN LOWER(COALESCE(o.shipping_zone,'national')) = 'zonal'     THEN rc.zonal_fee
                ELSE rc.national_fee
              END
            FROM rc_reverse_shipping rc
            WHERE LOWER(rc.category) = LOWER(o.category)
              AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND (rc.weight_slab IS NULL OR rc.weight_slab = COALESCE(o.weight_slab,''))
              AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
              AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
            ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
          ), 0) AS calc_reverse_shipping,

          -- Franchise Fee
          COALESCE((
            SELECT rc.rate
            FROM rc_franchise_fee rc
            WHERE (rc.category = 'ALL' OR LOWER(rc.category) = LOWER(o.category))
              AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND (rc.brand_name IS NULL OR rc.brand_name = '' OR rc.brand_name = o.brand_name)
              AND (rc.price_min IS NULL OR rc.price_min <= COALESCE(o.final_invoice_amount,0))
              AND (rc.price_max IS NULL OR rc.price_max >= COALESCE(o.final_invoice_amount,0))
              AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
              AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
            ORDER BY (rc.brand_name IS NOT NULL AND rc.brand_name <> '') DESC,
                     (rc.category <> 'ALL') DESC,
                     rc.start_date DESC NULLS LAST
            LIMIT 1
          ), 0) AS calc_franchise_fee

        FROM orders o
        WHERE o.order_date IS NOT NULL ${mpCond}
      )
      SELECT
        DATE_TRUNC('month', o.order_date)                      AS month_sort,
        rc.calc_commission,
        rc.calc_fixed_fee,
        rc.calc_collection_fee,
        rc.calc_pick_pack_fee,
        rc.calc_reverse_shipping,
        rc.calc_franchise_fee,
        -- GST = 18% × (commission + fixedFee + franchiseFee)
        (rc.calc_commission + rc.calc_fixed_fee + rc.calc_franchise_fee) * 0.18 AS calc_gst
      FROM orders o
      LEFT JOIN rc_calc rc ON rc.order_item_id = o.order_item_id
      WHERE o.order_date IS NOT NULL ${mpCond}
    `, mpParams);

    // Pre-build a monthly rcMap: { [monthSort]: { commission, fixedFee, ... } }
    const rcMap = {};
    for (const row of rcRows) {
      const key = row.month_sort;
      if (!rcMap[key]) rcMap[key] = {
        calc_commission: 0, calc_fixed_fee: 0, calc_collection_fee: 0,
        calc_pick_pack_fee: 0, calc_reverse_shipping: 0, calc_franchise_fee: 0, calc_gst: 0,
      };
      rcMap[key].calc_commission       += +(row.calc_commission)       || 0;
      rcMap[key].calc_fixed_fee        += +(row.calc_fixed_fee)        || 0;
      rcMap[key].calc_collection_fee   += +(row.calc_collection_fee)   || 0;
      rcMap[key].calc_pick_pack_fee    += +(row.calc_pick_pack_fee)    || 0;
      rcMap[key].calc_reverse_shipping += +(row.calc_reverse_shipping) || 0;
      rcMap[key].calc_franchise_fee    += +(row.calc_franchise_fee)    || 0;
      rcMap[key].calc_gst              += +(row.calc_gst)              || 0;
    }

    const saleData = saleRows.map(r => {
      const grossSale      = +r.gross_sale      || 0;
      const returnAmount   = +r.return_amount   || 0;
      const bankReceived   = +r.bank_received   || 0;
      const pendingInvoice = +r.pending_invoice || 0;
      const pendingVbFees  = +r.pending_vb_fees || 0;
      const pendingExpectedNet = Math.max(0, pendingInvoice - pendingVbFees);

      const fkCommission      = +r.fk_commission      || 0;
      const fkFixedFee        = +r.fk_fixed_fee       || 0;
      const fkCollectionFee   = +r.fk_collection_fee  || 0;
      const fkPickPackFee     = +r.fk_pick_pack_fee   || 0;
      const fkShippingFee     = +r.fk_shipping_fee    || 0;
      const fkReverseShipping = +r.fk_reverse_shipping || 0;
      const fkFranchiseFee   = +r.fk_franchise_fee   || 0;
      const fkTcs             = +r.fk_tcs             || 0;
      const fkTds             = +r.fk_tds             || 0;
      const fkGst             = +r.fk_gst             || 0;

      const vbCommission    = +r.vb_commission    || 0;
      const vbFixedFee     = +r.vb_fixed_fee     || 0;
      const vbCollectionFee = +r.vb_collection_fee|| 0;
      const vbPickPackFee  = +r.vb_pick_pack_fee || 0;
      const vbShippingFee  = +r.vb_shipping_fee  || 0;

      const totalFkFees = fkCommission + fkFixedFee + fkCollectionFee + fkPickPackFee +
                          fkShippingFee + fkReverseShipping + fkFranchiseFee + fkTcs + fkTds + fkGst;
      const totalVbFees = vbCommission + vbFixedFee + vbCollectionFee + vbPickPackFee + vbShippingFee;

      // RC fees for this sale-month (from SQL-computed rcMap)
      const rc = rcMap[r.month_sort] || {};
      const rcCommission     = rc.calc_commission     || 0;
      const rcFixedFee       = rc.calc_fixed_fee       || 0;
      const rcCollectionFee  = rc.calc_collection_fee || 0;
      const rcPickPackFee   = rc.calc_pick_pack_fee   || 0;
      const rcReverseShipping = rc.calc_reverse_shipping || 0;
      const rcFranchiseFee  = rc.calc_franchise_fee   || 0;
      const rcGst           = rc.calc_gst             || 0;
      const totalRcFees = rcCommission + rcFixedFee + rcCollectionFee + rcPickPackFee +
                          rcReverseShipping + rcFranchiseFee + rcGst;

      const settlementPct = grossSale > 0 ? +(bankReceived / grossSale * 100).toFixed(1) : 0;

      return {
        saleMonth:       r.sale_month,
        monthSort:       r.month_sort,
        orderCount:      +r.order_count,
        grossSale,
        returnAmount,
        netSale:         grossSale - returnAmount,
        totalFkFees,
        totalVbFees,
        totalRcFees:     +totalRcFees.toFixed(2),
        feeVariance:     +(totalFkFees - totalRcFees).toFixed(2),
        bankReceived,
        settledCount:    +r.settled_count,
        pendingCount:    +r.pending_count,
        returnCount:     +r.return_count,
        pendingInvoice,
        pendingVbFees,
        pendingExpectedNet,
        settlementPct,
        fees: {
          fkCommission, fkFixedFee, fkCollectionFee, fkPickPackFee,
          fkShippingFee, fkReverseShipping, fkFranchiseFee, fkTcs, fkTds, fkGst,
          vbCommission, vbFixedFee, vbCollectionFee, vbPickPackFee, vbShippingFee,
          rcCommission, rcFixedFee, rcCollectionFee, rcPickPackFee,
          rcReverseShipping, rcFranchiseFee, rcGst,
          totalRcFees,
        },
      };
    });

    // Cash flow view: actual bank receipts grouped by FK payment month
    const { rows: cashRows } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', payment_date), 'Mon-YYYY')  AS payment_month,
        DATE_TRUNC('month', payment_date)                      AS month_sort,
        COUNT(DISTINCT order_item_id)                          AS settled_count,
        SUM(bank_settlement)                                   AS cash_in,
        SUM(ABS(COALESCE(commission,0)) + ABS(COALESCE(fixed_fee,0)) +
            ABS(COALESCE(collection_fee,0)) + ABS(COALESCE(pick_pack_fee,0)) +
            ABS(COALESCE(shipping_fee,0)) + ABS(COALESCE(reverse_shipping,0)) +
            ABS(COALESCE(franchise_fee,0)) + ABS(COALESCE(tcs,0)) +
            ABS(COALESCE(tds,0)) + ABS(COALESCE(gst_on_mp_fees,0))) AS cash_out,
        SUM(ABS(COALESCE(protection_fund,0)))                  AS spf,
        0                                                      AS storage,
        0                                                      AS ads
      FROM unified_settlements
      WHERE payment_date IS NOT NULL ${settlementMpCond}
      GROUP BY DATE_TRUNC('month', payment_date)
      ORDER BY DATE_TRUNC('month', payment_date)
    `, mpParams);

    const cashFlow = cashRows.map(r => {
      const cashIn  = +r.cash_in  || 0;
      const cashOut = +r.cash_out || 0;
      const spf     = +r.spf     || 0;
      const storage = +r.storage  || 0;
      const ads     = +r.ads      || 0;
      return {
        paymentMonth:  r.payment_month,
        monthSort:     r.month_sort,
        settledCount:  +r.settled_count,
        cashIn, cashOut, spf, storage, ads,
        totalReceived: cashIn - cashOut + spf + storage + ads,
      };
    });

    res.json({ saleData, cashFlow });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /api/search-order?q=<order_id or order_item_id> ──────────────────────
router.get('/search-order', async (req, res) => {
  try {
    const pool = getPool();
    const q = optionalQueryText(req.query.q, 'Search query', { maxLength: 100 });
    if (!q || q.length < 3) return res.json({ orders: [], settlements: [], returns: [] });

    const search = `%${q}%`;

    const [ordersRes, settlRes, returnsRes] = await Promise.all([
      pool.query(`
        SELECT
          o.order_item_id, o.order_id, o.sku, o.category,
          o.marketplace, o.orders_status, o.order_date::text AS order_date,
          o.final_invoice_amount, o.settlement_amount,
          o.delivery_state, o.fulfilment_type,
          o.commission, o.fixed_fee, o.shipping_fee
        FROM orders o
        WHERE o.order_item_id ILIKE $1 OR o.order_id ILIKE $1
        ORDER BY o.order_date DESC, o.order_item_id
        LIMIT 20
      `, [search]),
      pool.query(`
        SELECT
          s.order_item_id, s.order_id, s.marketplace,
          TO_CHAR(s.payment_date,'YYYY-MM-DD') AS payment_date,
          s.bank_settlement, s.protection_fund,
          s.neft_id, s.refund, s.commission,
          s.fixed_fee, s.collection_fee, s.pick_pack_fee,
          s.shipping_fee
        FROM unified_settlements s
        WHERE s.order_item_id ILIKE $1 OR s.order_id ILIKE $1
        ORDER BY s.payment_date DESC
        LIMIT 30
      `, [search]),
      pool.query(`
        SELECT
          r.order_item_id, r.order_id,
          r.return_type, r.return_reason,
          r.return_date::text AS return_date,
          r.quantity
        FROM returns r
        WHERE r.order_item_id ILIKE $1 OR r.order_id ILIKE $1
        ORDER BY r.return_date DESC
        LIMIT 10
      `, [search]),
    ]);

    res.json({
      orders: ordersRes.rows,
      settlements: settlRes.rows,
      returns: returnsRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /api/brand-sales ──────────────────────────────────────────────────────
// Returns: { combined: [{brand,orders,revenue,myShare,fees,returns,returnRate}],
//            byMarketplace: [{brand,marketplace,orders,revenue,myShare,returns,returnRate}] }
router.get('/brand-sales', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);

    const [combinedRes, byMpRes] = await Promise.all([
      pool.query(`
        ${SETT_CTE}
        SELECT
          COALESCE(o.brand_name, 'Unknown')                                   AS brand,
          COUNT(*)                                                             AS orders,
          COALESCE(SUM(o.final_invoice_amount), 0)                            AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)), 0)                            AS "myShare",
          COALESCE(SUM(
            COALESCE(s.commission,0) + COALESCE(s.fixed_fee,0) +
            COALESCE(s.collection_fee,0) + COALESCE(s.pick_pack_fee,0)
          ), 0)                                                               AS fees,
          COUNT(ret.order_item_id)                                            AS returns
        FROM orders o
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        LEFT JOIN sett s ON s.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
        GROUP BY COALESCE(o.brand_name, 'Unknown')
        ORDER BY revenue DESC NULLS LAST
      `, values),
      pool.query(`
        ${SETT_CTE}
        SELECT
          COALESCE(o.brand_name, 'Unknown')                                   AS brand,
          COALESCE(o.marketplace, 'Unknown')                                  AS marketplace,
          COUNT(*)                                                             AS orders,
          COALESCE(SUM(o.final_invoice_amount), 0)                            AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)), 0)                            AS "myShare",
          COUNT(ret.order_item_id)                                            AS returns
        FROM orders o
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        LEFT JOIN sett s ON s.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
        GROUP BY COALESCE(o.brand_name, 'Unknown'), COALESCE(o.marketplace, 'Unknown')
        ORDER BY marketplace, revenue DESC NULLS LAST
      `, values),
    ]);

    const toRr = r => +r.orders > 0 ? +((+r.returns / +r.orders) * 100).toFixed(1) : 0;

    res.json({
      combined:      combinedRes.rows.map(r => ({ ...r, returnRate: toRr(r) })),
      byMarketplace: byMpRes.rows.map(r => ({ ...r, returnRate: toRr(r) })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/brand-top-skus ───────────────────────────────────────────────────
// Returns object keyed by brand: { BrandName: [{sku,title,orders,revenue,myShare,returnCount,returnRate}] }
// Each brand has top 25 SKUs ranked by revenue.
router.get('/brand-top-skus', async (req, res) => {
  try {
    const pool = getPool();
    const { where, values } = buildWhere(req.query);

    const { rows } = await pool.query(`
      ${SETT_CTE.replace(/;\s*$/, '')},
      agg AS (
        SELECT
          COALESCE(o.brand_name, 'Unknown')                                   AS brand,
          COALESCE(o.sku, 'Unknown')                                          AS sku,
          COALESCE(MAX(sm.product_name), MAX(ret.product_title), COALESCE(o.sku, 'Unknown')) AS title,
          COUNT(*)                                                             AS orders,
          COALESCE(SUM(o.final_invoice_amount), 0)                            AS revenue,
          COALESCE(SUM(COALESCE(s.net_bank,0)), 0)                            AS "myShare",
          COUNT(ret.order_item_id)                                            AS "returnCount"
        FROM orders o
        LEFT JOIN order_returns ret ON ret.order_item_id = o.order_item_id
        LEFT JOIN sett s ON s.order_item_id = o.order_item_id
        LEFT JOIN sku_master sm
          ON sm.listing_sku = o.sku
         AND (sm.marketplace = COALESCE(o.marketplace, 'flipkart') OR sm.marketplace = 'all')
        WHERE 1=1 ${where}
        GROUP BY COALESCE(o.brand_name, 'Unknown'), COALESCE(o.sku, 'Unknown')
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY brand
            ORDER BY revenue DESC NULLS LAST
          ) AS rn
        FROM agg
      )
      SELECT brand, sku, title, orders, revenue, "myShare", "returnCount"
      FROM ranked
      WHERE rn <= 25
      ORDER BY brand, revenue DESC NULLS LAST
    `, values);

    // Group by brand
    const byBrand = {};
    for (const row of rows) {
      const rr = +row.orders > 0 ? +((+row.returnCount / +row.orders) * 100).toFixed(1) : 0;
      if (!byBrand[row.brand]) byBrand[row.brand] = [];
      byBrand[row.brand].push({ ...row, returnRate: rr });
    }
    res.json(byBrand);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /settlement/fee-leaks ────────────────────────────────────────────────
// Order-level fee leaks (where actual FK fee > RC expected fee).
router.get('/settlement/fee-leaks', async (req, res) => {
  try {
    const pool = getPool();
    const { page = '1', pageSize = '100' } = req.query;
    const marketplace = parseMarketplaceFilter(req.query.marketplace) || 'flipkart';
    const rawMonth = typeof req.query.month === 'string' ? req.query.month.trim() : '';
    const month = rawMonth && rawMonth !== 'all' ? rawMonth : null;
    if (month && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month must use YYYY-MM format' });
    }
    const feeType = typeof req.query.feeType === 'string' ? req.query.feeType.trim() : 'all';
    if (!['all', 'commission', 'fixed_fee', 'collection_fee', 'pick_pack_fee'].includes(feeType)) {
      return res.status(400).json({ error: 'feeType is invalid' });
    }

    const pg   = positiveInt(page, 1);
    const ps   = positiveInt(pageSize, 100, { max: 1000 });
    const offs = (pg - 1) * ps;

    let params = [marketplace];
    let monthCond = '';
    if (month) {
      params.push(month);
      // for Amazon we will use fs.payment_date just like unified_settlements
      monthCond = `AND TO_CHAR(fs.payment_date, 'YYYY-MM') = $2`;
    }

    const RC_COMM = `COALESCE((
      SELECT rc.rate * COALESCE(o.final_invoice_amount,0)
      FROM rc_commission rc
      WHERE LOWER(rc.category)=LOWER(o.category)
        AND rc.marketplace=COALESCE(o.marketplace,'flipkart')
        AND rc.seller_account = COALESCE(o.seller_account, 'default')
        AND (rc.brand_name IS NULL OR rc.brand_name='' OR rc.brand_name=o.brand_name)
        AND (rc.price_min IS NULL OR rc.price_min<=COALESCE(o.final_invoice_amount,0))
        AND (rc.price_max IS NULL OR rc.price_max>=COALESCE(o.final_invoice_amount,0))
        AND (rc.start_date IS NULL OR rc.start_date<=COALESCE(fs.payment_date,o.order_date))
        AND (rc.end_date   IS NULL OR rc.end_date  >=COALESCE(fs.payment_date,o.order_date))
      ORDER BY (rc.brand_name IS NOT NULL AND rc.brand_name<>'') DESC,
               rc.start_date DESC NULLS LAST LIMIT 1
    ),0)`;

    const RC_FIXED = `COALESCE((
      SELECT rc.rate FROM rc_fixed_fee rc
      WHERE LOWER(rc.category)=LOWER(o.category)
        AND rc.marketplace=COALESCE(o.marketplace,'flipkart')
        AND rc.seller_account = COALESCE(o.seller_account, 'default')
        AND (rc.price_min IS NULL OR rc.price_min<=COALESCE(o.final_invoice_amount,0))
        AND (rc.price_max IS NULL OR rc.price_max>=COALESCE(o.final_invoice_amount,0))
        AND (rc.start_date IS NULL OR rc.start_date<=COALESCE(fs.payment_date,o.order_date))
        AND (rc.end_date   IS NULL OR rc.end_date  >=COALESCE(fs.payment_date,o.order_date))
      ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
    ),0)`;

    const RC_COLL = `COALESCE((
      SELECT CASE WHEN rc.prepaid_type='flat' THEN rc.prepaid
                  ELSE rc.prepaid * COALESCE(o.final_invoice_amount,0) END
      FROM rc_collection_fee rc
      WHERE LOWER(rc.category)=LOWER(o.category)
        AND rc.marketplace=COALESCE(o.marketplace,'flipkart')
        AND rc.seller_account = COALESCE(o.seller_account, 'default')
        AND (rc.price_min IS NULL OR rc.price_min<=COALESCE(o.final_invoice_amount,0))
        AND (rc.price_max IS NULL OR rc.price_max>=COALESCE(o.final_invoice_amount,0))
        AND (rc.start_date IS NULL OR rc.start_date<=COALESCE(fs.payment_date,o.order_date))
        AND (rc.end_date   IS NULL OR rc.end_date  >=COALESCE(fs.payment_date,o.order_date))
      ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
    ),0)`;

    const RC_PACK = `COALESCE((
      SELECT rc.rate FROM rc_pick_pack rc
      WHERE LOWER(rc.category)=LOWER(o.category)
        AND rc.marketplace=COALESCE(o.marketplace,'flipkart')
        AND rc.seller_account = COALESCE(o.seller_account, 'default')
        AND (rc.price_min IS NULL OR rc.price_min<=COALESCE(o.final_invoice_amount,0))
        AND (rc.price_max IS NULL OR rc.price_max>=COALESCE(o.final_invoice_amount,0))
        AND (rc.start_date IS NULL OR rc.start_date<=COALESCE(fs.payment_date,o.order_date))
        AND (rc.end_date   IS NULL OR rc.end_date  >=COALESCE(fs.payment_date,o.order_date))
      ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
    ),0)`;

    let feeLeakCond = ``;
    if (feeType === 'commission') feeLeakCond = `WHERE mp_comm > rc_comm + 0.5`;
    else if (feeType === 'fixed_fee') feeLeakCond = `WHERE mp_fixed > rc_fixed + 0.5`;
    else if (feeType === 'collection_fee') feeLeakCond = `WHERE mp_coll > rc_coll + 0.5`;
    else if (feeType === 'pick_pack_fee') feeLeakCond = `WHERE mp_pack > rc_pack + 0.5`;
    else feeLeakCond = `WHERE mp_comm > rc_comm + 0.5 OR mp_fixed > rc_fixed + 0.5 OR mp_coll > rc_coll + 0.5 OR mp_pack > rc_pack + 0.5`;

    let settCTE = ``;
    let joinCond = ``;

    if (marketplace === 'amazon') {
      settCTE = `
      amazon_classified AS (
        SELECT order_id, sku, MIN(posted_date) AS payment_date, amount,
          CASE
            WHEN amount_description ILIKE 'Commission%' OR amount_description ILIKE 'Refund commission%' THEN 'order_commission'
            WHEN amount_description ILIKE 'Fixed closing fee%' THEN 'order_closing_fee'
            WHEN amount_description ILIKE 'Technology%Fee%' THEN 'order_tech_fee'
            WHEN amount_description ILIKE 'FBA Weight Handling Fee%' 
              OR amount_description ILIKE 'FBA Pick & Pack Fee%' 
              OR amount_description ILIKE 'FBA Inbound%' 
              OR (amount_type = 'ItemFees' AND amount_description ILIKE 'FBA%') THEN 'order_fba_fee'
            ELSE 'other'
          END AS category
        FROM amazon_settlement_lines
        WHERE order_id IS NOT NULL
        GROUP BY order_id, sku, amount, amount_description, amount_type
      ),
      sett AS (
        SELECT order_id, sku,
          MIN(payment_date) AS payment_date,
          SUM(CASE WHEN category = 'order_commission' THEN ABS(amount) ELSE 0 END) AS mp_comm,
          SUM(CASE WHEN category IN ('order_closing_fee', 'order_tech_fee') THEN ABS(amount) ELSE 0 END) AS mp_fixed,
          0 AS mp_coll,
          SUM(CASE WHEN category = 'order_fba_fee' THEN ABS(amount) ELSE 0 END) AS mp_pack,
          SUM(CASE WHEN category = 'other' THEN ABS(amount) ELSE 0 END) AS mp_other_fee
        FROM amazon_classified 
        GROUP BY order_id, sku
      )
      `;
      joinCond = `INNER JOIN sett fs ON fs.order_id = o.order_id AND (fs.sku IS NULL OR fs.sku = o.sku)`;
    } else {
      settCTE = `
      sett AS (
        SELECT order_item_id,
          payment_date,
          commission AS mp_comm,
          fixed_fee AS mp_fixed,
          collection_fee AS mp_coll,
          pick_pack_fee AS mp_pack
        FROM ${ORDER_SETTLEMENT_TOTALS_TABLE}
      )
      `;
      joinCond = `INNER JOIN sett fs ON fs.order_item_id=o.order_item_id`;
    }

    const sql = `
    WITH ${settCTE},
    base AS (
      SELECT
        o.order_item_id, o.order_id,
        TO_CHAR(o.order_date,'YYYY-MM-DD') AS order_date,
        o.sku, o.category,
        COALESCE(o.final_invoice_amount,0) AS invoice,
        COALESCE(fs.mp_comm,0)  AS mp_comm,
        COALESCE(fs.mp_fixed,0) AS mp_fixed,
        COALESCE(fs.mp_coll,0)  AS mp_coll,
        COALESCE(fs.mp_pack,0)  AS mp_pack,
        ${RC_COMM}  AS rc_comm,
        ${RC_FIXED} AS rc_fixed,
        ${RC_COLL}  AS rc_coll,
        ${RC_PACK}  AS rc_pack
      FROM orders o
      ${joinCond}
      WHERE COALESCE(o.marketplace, 'flipkart') = $1 ${monthCond}
    )
    SELECT *
    FROM (
      SELECT *,
        (mp_comm - rc_comm) + (mp_fixed - rc_fixed) + (mp_coll - rc_coll) + (mp_pack - rc_pack) AS leak_amount
      FROM base
    ) leaks
    ${feeLeakCond}
    ORDER BY leak_amount DESC
    LIMIT $2 OFFSET $3
    `;

    const countSql = `
    WITH ${settCTE},
    base AS (
      SELECT
        o.order_item_id,
        COALESCE(fs.mp_comm,0)  AS mp_comm,
        COALESCE(fs.mp_fixed,0) AS mp_fixed,
        COALESCE(fs.mp_coll,0)  AS mp_coll,
        COALESCE(fs.mp_pack,0)  AS mp_pack,
        ${RC_COMM}  AS rc_comm,
        ${RC_FIXED} AS rc_fixed,
        ${RC_COLL}  AS rc_coll,
        ${RC_PACK}  AS rc_pack
      FROM orders o
      ${joinCond}
      WHERE COALESCE(o.marketplace, 'flipkart') = $1 ${monthCond}
    )
    SELECT COUNT(*)::int AS total
    FROM base
    ${feeLeakCond}
    `;

    const [rowsRes, cntRes] = await Promise.all([
      pool.query(sql, [...params, ps, offs]),
      pool.query(countSql, params)
    ]);

    res.json({
      data: rowsRes.rows,
      pagination: {
        page: pg,
        pageSize: ps,
        total: cntRes.rows[0]?.total || 0
      }
    });
  } catch (err) {
    console.error('[settlement/fee-leaks]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});


// ── GET /settlement/order-fee-detail ─────────────────────────────────────────
// Per-order drill-down for any fee type (collection_fee, commission, fixed_fee, etc.)
// Shows each order with: date, category, brand, sale_amount, FK charged, RC expected, variance
// ?fee=collection_fee&month=YYYY-MM&marketplace=flipkart&limit=500
router.get('/settlement/order-fee-detail', async (req, res) => {
  try {
    const pool       = getPool();
    const { fee, month, marketplace, limit } = parseOrderFeeDetailQuery(req.query);
    const feeCol = ORDER_FEE_TYPES[fee].col;
    const mpCond = marketplace ? `AND COALESCE(fk.marketplace, 'flipkart') = $2` : '';
    const aggregateParams = marketplace ? [month, marketplace] : [month];
    const detailParams = [...aggregateParams, limit];
    const detailLimitPlaceholder = `$${detailParams.length}`;

    // ── RC expected subquery — PER-UNIT PRICE LOGIC ──
    // FK calculates fees on per-unit price: sale_amount / qty.
    // Band lookup uses unit_price, result × qty for flat fees,
    // rate × total for percentage fees (rate × unit × qty = rate × total).
    // QTY = GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)
    // UNIT = sale / QTY
    const UNIT_PRICE = `COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
                         / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)`;
    const TOTAL_SALE = `COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)`;
    const QTY        = `GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)`;
    const NORM_CAT   = `REGEXP_REPLACE(LOWER(o.category),'^shopsy_','')`;

    const RC_SUBQUERY = {
      collection_fee: `(
        SELECT CASE WHEN rc.prepaid_type='flat'
                    THEN rc.prepaid * ${QTY}
                    ELSE rc.prepaid * ${TOTAL_SALE}
               END
        FROM rc_collection_fee rc
        WHERE LOWER(rc.category) = ${NORM_CAT}
          AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND rc.price_min <= ${UNIT_PRICE}
          AND rc.price_max >= ${UNIT_PRICE}
          AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
          AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
        ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
      )`,
      commission: `(
        SELECT rc.rate * ${TOTAL_SALE}
        FROM rc_commission rc
        WHERE LOWER(rc.category) = ${NORM_CAT}
          AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND (rc.brand_name IS NULL OR rc.brand_name = '' OR rc.brand_name = o.brand_name)
          AND rc.price_min <= ${UNIT_PRICE}
          AND rc.price_max >= ${UNIT_PRICE}
          AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
          AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
        ORDER BY (rc.brand_name IS NOT NULL AND rc.brand_name <> '') DESC,
                 rc.start_date DESC NULLS LAST LIMIT 1
      )`,
      fixed_fee: `(
        SELECT rc.rate * ${QTY}
        FROM rc_fixed_fee rc
        WHERE LOWER(rc.category) = ${NORM_CAT}
          AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND rc.price_min <= ${UNIT_PRICE}
          AND rc.price_max >= ${UNIT_PRICE}
          AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
          AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
        ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
      )`,
      pick_pack_fee: `(
        SELECT rc.rate * ${QTY}
        FROM rc_pick_pack rc
        WHERE LOWER(rc.category) = ${NORM_CAT}
          AND rc.marketplace = COALESCE(o.marketplace, 'flipkart')
              AND rc.seller_account = COALESCE(o.seller_account, 'default')
              AND rc.price_min <= ${UNIT_PRICE}
          AND rc.price_max >= ${UNIT_PRICE}
          AND (rc.start_date IS NULL OR rc.start_date <= o.order_date)
          AND (rc.end_date   IS NULL OR rc.end_date   >= o.order_date)
        ORDER BY rc.start_date DESC NULLS LAST LIMIT 1
      )`,
    };
    const rcSubquery = RC_SUBQUERY[fee] || 'NULL';

    // Run aggregate (all orders) and detail (top N) queries in parallel
    const [aggResult, detailResult] = await Promise.all([
      // Aggregate over ALL matching orders — for correct header totals
      pool.query(`
        SELECT
          COUNT(*)                                                              AS total_orders,
          COALESCE(SUM(ABS(COALESCE(${feeCol}, 0))), 0)                        AS total_fee,
          COALESCE(SUM(COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)), 0) AS total_sale
        FROM unified_settlements fk
        INNER JOIN orders o ON o.order_item_id = fk.order_item_id
        WHERE TO_CHAR(o.order_date, 'YYYY-MM') = $1
          AND fk.bank_settlement > 0
          AND ABS(COALESCE(${feeCol}, 0)) > 0.005
          ${mpCond}
      `, aggregateParams),
      // Per-order detail — top N by fee amount (for display)
      // Includes qty and unit_price so user can see per-unit breakdown
      pool.query(`
        SELECT
          fk.order_item_id,
          TO_CHAR(o.order_date, 'YYYY-MM-DD')                              AS order_date,
          COALESCE(o.category, fk.product_sub_category, 'unknown')         AS category,
          COALESCE(o.brand_name, '—')                                      AS brand,
          GREATEST(COALESCE(fk.quantity, o.qty, 1), 1)                     AS qty,
          ROUND(COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)::numeric, 2) AS sale_amount,
          ROUND((COALESCE(NULLIF(fk.sale_amount,0), o.final_invoice_amount, 0)
                 / GREATEST(COALESCE(fk.quantity, o.qty, 1), 1))::numeric, 2) AS unit_price,
          ROUND(ABS(COALESCE(${feeCol}, 0))::numeric, 2)                   AS fee_amount,
          ROUND((${rcSubquery})::numeric, 2)                               AS rc_expected
        FROM unified_settlements fk
        INNER JOIN orders o ON o.order_item_id = fk.order_item_id
        WHERE TO_CHAR(o.order_date, 'YYYY-MM') = $1
          AND fk.bank_settlement > 0
          AND ABS(COALESCE(${feeCol}, 0)) > 0.005
          ${mpCond}
        ORDER BY ABS(COALESCE(${feeCol}, 0)) DESC
        LIMIT ${detailLimitPlaceholder}
      `, detailParams),
    ]);

    const agg  = aggResult.rows[0];
    const rows = detailResult.rows;

    // Totals from aggregate (all orders) — these are the correct overall figures
    const totalFee   = +agg.total_fee;
    const totalSale  = +agg.total_sale;
    const totalOrders = +agg.total_orders;
    // RC expected only computable from returned rows (requires per-order rate card lookup)
    const totalRc = rows.filter(r => r.rc_expected != null).reduce((s, r) => s + +r.rc_expected, 0);

    res.json({
      fee, label: ORDER_FEE_TYPES[fee].label,
      month,
      totalOrders,                                               // all orders with this fee
      orderCount: rows.length,                                   // rows returned (≤ limit)
      totalFee: +totalFee.toFixed(2),                           // total from ALL orders
      totalRcExpected: rcSubquery === 'NULL' ? null : +totalRc.toFixed(2), // RC from returned rows
      totalSaleAmount: +totalSale.toFixed(2),
      effectiveRate: totalSale > 0 ? +((totalFee / totalSale) * 100).toFixed(3) : 0,
      rows,
    });

  } catch (err) {
    console.error('[order-fee-detail]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
