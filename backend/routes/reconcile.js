import express from 'express';
import { getPool, isDbConfigured } from '../db/index.js';
import { getRateCard, calculateFees, normalizeCategory } from '../services/rateCard.js';
import { ORDER_SETTLEMENT_TOTALS_TABLE } from '../services/orderSettlementTotals.js';
import { pagination } from '../utils/requestParams.js';

const router = express.Router();

// ── GET /api/reconcile/unified-linkup ───────────────────────────────────────────────
router.get('/unified-linkup', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ configured: false, data: [], total: 0 });
  try {
    const pool = getPool();
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });

    const { where, values } = buildFilters(req.query);
    const dataValues = [...values, pageSize, offset];
    const pageSizeParam = `${values.length + 1}`;
    const offsetParam   = `${values.length + 2}`;

    const [data, cnt] = await Promise.all([
      pool.query(`
        SELECT
          o.order_id, o.order_item_id, o.order_date, o.marketplace, o.seller_account,
          o.sku, o.category, o.fulfilment_type, o.orders_status, o.final_invoice_amount,
          rt.return_status, rt.return_type, rt.return_reason,
          COALESCE(SUM(s.sale_amount), 0) AS total_sale_amount,
          COALESCE(SUM(s.bank_settlement), 0) AS total_bank_settlement,
          COALESCE(SUM(s.refund), 0) AS total_refund,
          COUNT(s.neft_id) AS settlement_count
        FROM orders o
        LEFT JOIN order_returns rt ON rt.order_item_id = o.order_item_id
        LEFT JOIN unified_settlements s ON s.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
        GROUP BY o.order_id, o.order_item_id, o.order_date, o.marketplace, o.seller_account,
                 o.sku, o.category, o.fulfilment_type, o.orders_status, o.final_invoice_amount,
                 rt.return_status, rt.return_type, rt.return_reason
        ORDER BY o.order_date DESC
        LIMIT ${pageSizeParam} OFFSET ${offsetParam}
      `, dataValues),
      pool.query(`
        SELECT COUNT(*) AS total
        FROM orders o
        WHERE 1=1 ${where}
      `, values),
    ]);

    res.json({ data: data.rows, total: +cnt.rows[0].total, page, pageSize });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Filter builder ────────────────────────────────────────────────────────────
function buildFilters(q) {
  const conds  = [];
  const values = [];
  if (q.marketplace && q.marketplace !== 'all') { conds.push(`fko.marketplace = $${values.push(q.marketplace)}`); }
  if (q.startDate)      { conds.push(`fko.payment_date >= $${values.push(q.startDate)}`); }
  if (q.endDate)        { conds.push(`fko.payment_date <= $${values.push(q.endDate)}`); }
  if (q.category)       { conds.push(`fko.product_sub_category = $${values.push(q.category)}`); }
  if (q.neftId)         { conds.push(`fko.neft_id = $${values.push(q.neftId)}`); }
  if (q.orderId)        { conds.push(`(fko.order_id = $${values.push(q.orderId)} OR fko.order_item_id = $${values.push(q.orderId)})`); }
  if (q.suspiciousOnly === '1') {
    conds.push(`(fko.bank_settlement < 0 AND NOT EXISTS (SELECT 1 FROM returns rx WHERE rx.order_item_id = fko.order_item_id))`);
  }
  return { where: conds.length ? ' AND ' + conds.join(' AND ') : '', values };
}

// Total deduction expression (ABS since fees are stored as negative)
const DEDUCTIONS_SQL = `
  ABS(COALESCE(fko.commission,0))              + ABS(COALESCE(fko.fixed_fee,0))          +
  ABS(COALESCE(fko.collection_fee,0))          + ABS(COALESCE(fko.pick_pack_fee,0))      +
  ABS(COALESCE(fko.shipping_fee,0))            + ABS(COALESCE(fko.reverse_shipping,0))   +
  ABS(COALESCE(fko.no_cost_emi_fee,0))         + ABS(COALESCE(fko.installation_fee,0))   +
  ABS(COALESCE(fko.tech_visit_fee,0))          + ABS(COALESCE(fko.uninstallation_fee,0)) +
  ABS(COALESCE(fko.customer_addon_recovery,0)) + ABS(COALESCE(fko.franchise_fee,0))      +
  ABS(COALESCE(fko.shopsy_marketing_fee,0))    + ABS(COALESCE(fko.cancellation_fee,0))   +
  ABS(COALESCE(fko.tcs,0)) + ABS(COALESCE(fko.tds,0)) + ABS(COALESCE(fko.gst_on_mp_fees,0))
`;

// ── GET /api/reconcile/summary ────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ configured: false });
  try {
    const pool = getPool();
    const { where, values } = buildFilters(req.query);

    const [sett, unsett, nonOrd] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                    AS total_rows,
          COUNT(DISTINCT fko.order_item_id)           AS settled_items,
          SUM(COALESCE(fko.sale_amount, 0))           AS total_sale,
          SUM(COALESCE(fko.total_offer_amount, 0))    AS total_offer,
          SUM(${DEDUCTIONS_SQL})                      AS total_deductions,
          SUM(COALESCE(fko.bank_settlement, 0))       AS bank_received,
          COUNT(DISTINCT CASE WHEN r.return_id IS NOT NULL THEN fko.order_item_id END)
                                                      AS returned_items,
          SUM(CASE WHEN sc.cnt > 1 THEN 1 ELSE 0 END) AS multi_settled_rows,
          SUM(CASE
                WHEN fko.bank_settlement < 0 AND r.return_id IS NULL THEN 1 ELSE 0
              END)                                    AS suspicious_negative,
          MIN(fko.payment_date)                       AS period_start,
          MAX(fko.payment_date)                       AS period_end,
          COUNT(DISTINCT fko.neft_id)                 AS neft_count
        FROM unified_settlements fko
        LEFT JOIN order_returns r ON r.order_item_id = fko.order_item_id
        LEFT JOIN (
          SELECT order_item_id, COUNT(*) AS cnt
          FROM   unified_settlements
          GROUP BY order_item_id
        ) sc ON sc.order_item_id = fko.order_item_id
        WHERE 1=1 ${where}
      `, values),
      pool.query(`
        SELECT
          COUNT(*)                                      AS unsettled_items,
          SUM(COALESCE(o.final_invoice_amount, 0))      AS unsettled_amount
        FROM orders o
        WHERE NOT EXISTS (
          SELECT 1 FROM ${ORDER_SETTLEMENT_TOTALS_TABLE} s WHERE s.order_item_id = o.order_item_id
        )
      `),
      pool.query(`
        SELECT
          COALESCE((SELECT SUM(settlement_value) FROM fk_spf_claims),     0) AS spf_total,
          COALESCE((SELECT SUM(settlement_value) FROM fk_storage_recall), 0) AS storage_total,
          COALESCE((SELECT SUM(settlement_value) FROM fk_ads),            0) AS ads_total,
          COALESCE((SELECT SUM(settlement_value) FROM fk_google_ads),     0) AS google_ads_total
      `),
    ]);

    res.json({
      ...sett.rows[0],
      ...unsett.rows[0],
      nonOrder: nonOrd.rows[0],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/reconcile/items ──────────────────────────────────────────────────
router.get('/items', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ configured: false, data: [], total: 0 });
  try {
    const pool = getPool();
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });

    const { where, values } = buildFilters(req.query);
    const dataValues = [...values, pageSize, offset];
    const pageSizeParam = `$${values.length + 1}`;
    const offsetParam   = `$${values.length + 2}`;

    const [data, cnt] = await Promise.all([
      pool.query(`
        SELECT
          fko.order_item_id, fko.order_id,
          fko.order_date, fko.payment_date, fko.neft_id,
          fko.seller_sku, fko.product_sub_category AS category,
          fko.fulfilment_type, fko.shipping_zone, fko.quantity,
          fko.return_type, fko.item_return_status, fko.commission_rate,
          fko.sale_amount, fko.total_offer_amount, fko.my_share, fko.bank_settlement,
          fko.commission, fko.fixed_fee, fko.collection_fee, fko.pick_pack_fee,
          fko.shipping_fee, fko.reverse_shipping, fko.no_cost_emi_fee,
          fko.installation_fee, fko.tech_visit_fee, fko.uninstallation_fee,
          fko.customer_addon_recovery, fko.franchise_fee,
          fko.shopsy_marketing_fee, fko.cancellation_fee,
          fko.tcs, fko.tds, fko.gst_on_mp_fees,
          fko.offer_amount_discount_mp, fko.total_discount_mp_fee,
          (${DEDUCTIONS_SQL}) AS total_deductions,
          COUNT(*) OVER (PARTITION BY fko.order_item_id) AS settlement_count,
          CASE
            WHEN fko.bank_settlement < 0 AND r.return_id IS NULL THEN 1
            ELSE 0
          END AS suspicious_negative,
          r.return_status, r.return_reason, r.return_type AS ret_type,
          o.category AS order_category, o.orders_status
        FROM unified_settlements fko
        LEFT JOIN orders  o ON o.order_item_id = fko.order_item_id
        LEFT JOIN order_returns r ON r.order_item_id = fko.order_item_id
        WHERE 1=1 ${where}
        ORDER BY fko.payment_date DESC, fko.order_item_id, fko.neft_id
        LIMIT ${pageSizeParam} OFFSET ${offsetParam}
      `, dataValues),
      pool.query(`
        SELECT COUNT(*) AS total
        FROM unified_settlements fko
        WHERE 1=1 ${where}
      `, values),
    ]);

    res.json({ data: data.rows, total: +cnt.rows[0].total, page, pageSize });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/reconcile/unsettled ──────────────────────────────────────────────
router.get('/unsettled', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ configured: false, data: [], total: 0 });
  try {
    const pool = getPool();
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });

    const [data, cnt] = await Promise.all([
      pool.query(`
        SELECT
          o.order_item_id, o.order_id, o.order_date,
          o.sku, o.category, o.fulfilment_type,
          o.orders_status, o.final_invoice_amount,
          o.weight_slab, o.shipping_zone,
          rt.return_status, rt.return_type AS ret_type, rt.return_reason
        FROM orders o
        LEFT JOIN order_returns rt ON rt.order_item_id = o.order_item_id
        WHERE NOT EXISTS (
          SELECT 1 FROM ${ORDER_SETTLEMENT_TOTALS_TABLE} s WHERE s.order_item_id = o.order_item_id
        )
        ORDER BY o.order_date DESC
        LIMIT $1 OFFSET $2
      `, [pageSize, offset]),
      pool.query(`
        SELECT COUNT(*) AS total
        FROM orders o
        WHERE NOT EXISTS (
          SELECT 1 FROM ${ORDER_SETTLEMENT_TOTALS_TABLE} s WHERE s.order_item_id = o.order_item_id
        )
      `),
    ]);

    res.json({ data: data.rows, total: +cnt.rows[0].total, page, pageSize });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/reconcile/by-order ───────────────────────────────────────────────
// Search by order_id → returns all item_ids under that order with settlement status
router.get('/by-order', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ configured: false, data: [] });
  const orderId = (req.query.orderId || '').trim();
  if (!orderId) return res.json({ data: [] });
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT
        o.order_id,
        o.order_item_id,
        o.order_date,
        o.sku,
        o.category,
        o.fulfilment_type,
        o.orders_status,
        o.final_invoice_amount,
        o.qty,
        -- Settlement columns (may be NULL if not yet settled)
        fko.neft_id,
        fko.payment_date,
        fko.sale_amount,
        fko.bank_settlement,
        fko.commission,
        fko.fixed_fee,
        fko.collection_fee,
        fko.pick_pack_fee,
        fko.shipping_fee,
        fko.reverse_shipping,
        fko.tcs,
        fko.tds,
        fko.gst_on_mp_fees,
        fko.return_type     AS settlement_return_type,
        fko.item_return_status,
        -- Return info
        rt.return_status,
        rt.return_reason,
        CASE WHEN fko.order_item_id IS NOT NULL THEN true ELSE false END AS is_settled
      FROM orders o
      LEFT JOIN unified_settlements fko ON fko.order_item_id = o.order_item_id
      LEFT JOIN order_returns rt ON rt.order_item_id = o.order_item_id
      WHERE o.order_id = $1
      ORDER BY o.order_item_id, fko.payment_date
    `, [orderId]);

    const totalInvoice   = rows.reduce((s, r) => s + (+r.final_invoice_amount || 0), 0);
    const totalSettled   = rows.filter(r => r.is_settled).reduce((s, r) => s + (+r.bank_settlement || 0), 0);
    const settledItems   = [...new Set(rows.filter(r => r.is_settled).map(r => r.order_item_id))];
    const unsettledItems = [...new Set(rows.filter(r => !r.is_settled).map(r => r.order_item_id))];

    res.json({
      orderId,
      totalItems:    rows.length,
      settledCount:  settledItems.length,
      unsettledCount: unsettledItems.length,
      totalInvoice:  +totalInvoice.toFixed(2),
      totalSettled:  +totalSettled.toFixed(2),
      items: rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/reconcile/non-order ──────────────────────────────────────────────
router.get('/non-order', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ configured: false });
  try {
    const pool = getPool();
    const [spf, storage, ads, gads, amazon] = await Promise.all([
      pool.query(`
        SELECT neft_id, payment_date, claim_id, settlement_value, protection_reason, seller_sku, fsn FROM fk_spf_claims 
        UNION ALL 
        SELECT settlement_id AS neft_id, posted_date AS payment_date, order_id AS claim_id, amount AS settlement_value, amount_description AS protection_reason, sku AS seller_sku, order_item_code AS fsn FROM amazon_settlement_lines WHERE (amount_type = 'FBA Inventory Reimbursement' OR amount_description IN ('SAFE-T Reimbursement', 'Reimbursement for Lost packages')) AND (order_id !~ '^\\d{3}-\\d{7}-\\d{7}$' OR order_id IS NULL) 
        ORDER BY payment_date DESC
      `),
      pool.query(`
        SELECT neft_id, payment_date, service_name, settlement_value, fsn, storage_fee, removal_fee, warehouse_state FROM fk_storage_recall 
        UNION ALL 
        SELECT settlement_id AS neft_id, posted_date AS payment_date, amount_type AS service_name, amount AS settlement_value, order_item_code AS fsn, CASE WHEN amount_type ILIKE '%Storage%' THEN amount ELSE 0 END AS storage_fee, CASE WHEN amount_type ILIKE '%Removal%' THEN amount ELSE 0 END AS removal_fee, NULL AS warehouse_state FROM amazon_settlement_lines WHERE (amount_type ILIKE '%Removal%' OR amount_type ILIKE '%Storage%') AND (order_id !~ '^\\d{3}-\\d{7}-\\d{7}$' OR order_id IS NULL) 
        ORDER BY payment_date DESC
      `),
      pool.query(`
        SELECT neft_id, payment_date, transaction_type, settlement_value, campaign_id, gst_on_ads FROM fk_ads 
        UNION ALL 
        SELECT settlement_id AS neft_id, posted_date AS payment_date, amount_description AS transaction_type, amount AS settlement_value, order_id AS campaign_id, 0 AS gst_on_ads FROM amazon_settlement_lines WHERE amount_type = 'Cost of Advertising' 
        ORDER BY payment_date DESC
      `),
      pool.query(`SELECT neft_id, payment_date, service_name, settlement_value, total_amount, gst_on_service FROM fk_google_ads ORDER BY payment_date DESC`),
      pool.query(`
        SELECT settlement_id AS neft_id, posted_date AS payment_date, transaction_type, amount_type, amount_description AS service_name, amount AS settlement_value, order_id AS reference_id FROM amazon_settlement_lines 
        WHERE (order_id !~ '^\\d{3}-\\d{7}-\\d{7}$' OR order_id IS NULL) 
          AND NOT (amount_type = 'FBA Inventory Reimbursement' OR amount_description IN ('SAFE-T Reimbursement', 'Reimbursement for Lost packages')) 
          AND NOT (amount_type ILIKE '%Removal%' OR amount_type ILIKE '%Storage%') 
          AND NOT (amount_type = 'Cost of Advertising') 
        ORDER BY posted_date DESC
      `)
    ]);
    res.json({ spf: spf.rows, storage: storage.rows, ads: ads.rows, googleAds: gads.rows, amazonNonOrder: amazon.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/reconcile/rate-audit ─────────────────────────────────────────────
router.get('/rate-audit', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ configured: false, data: [] });
  try {
    const pool = getPool();
    const { where, values } = buildFilters(req.query);
    const limitValues = [...values, 500];
    const limitParam  = `$${values.length + 1}`;

    const mp = req.query.marketplace || 'flipkart';
    const sa = req.query.seller_account || 'default';
    let rc = null;
    try { rc = await getRateCard(mp, sa); } catch { /* rate card unavailable */ }

    const { rows } = await pool.query(`
      SELECT
        fko.order_item_id, fko.order_id, fko.order_date, fko.payment_date,
        fko.seller_sku, fko.product_sub_category AS category,
        COALESCE(o.category, fko.product_sub_category) AS rc_category,
        fko.fulfilment_type, fko.shipping_zone, fko.quantity,
        fko.sale_amount, fko.commission_rate,
        fko.commission, fko.fixed_fee, fko.collection_fee, fko.pick_pack_fee,
        fko.shipping_fee, fko.reverse_shipping, fko.tcs, fko.tds, fko.gst_on_mp_fees,
        (${DEDUCTIONS_SQL}) AS actual_total_deductions,
        fko.bank_settlement
      FROM unified_settlements fko
      LEFT JOIN orders o ON o.order_item_id = fko.order_item_id
      WHERE fko.sale_amount > 0 ${where}
      ORDER BY fko.payment_date DESC, fko.order_item_id
      LIMIT ${limitParam}
    `, limitValues);

    const THRESH = 2;

    const data = rows.map(row => {
      let expected = null;
      let issues   = [];
      let variance = 0;

      if (rc) {
        try {
          expected = calculateFees(rc, {
            category:       row.rc_category || row.category,
            price:          +row.sale_amount,
            fulfilmentType: row.fulfilment_type || 'NON_FBF',
            zone:           row.shipping_zone || 'national',
            orderDate:      row.order_date,
          });

          const actComm = Math.abs(+row.commission || 0);
          const expComm = expected.commission || 0;
          const commDiff = actComm - expComm;
          if (Math.abs(commDiff) > THRESH) {
            issues.push({ field: 'commission', actual: actComm, expected: expComm, diff: +commDiff.toFixed(2) });
          }

          const actFixed = Math.abs(+row.fixed_fee || 0);
          const expFixed = expected.fixedFee || 0;
          const fixedDiff = actFixed - expFixed;
          if (Math.abs(fixedDiff) > THRESH) {
            issues.push({ field: 'fixed_fee', actual: actFixed, expected: expFixed, diff: +fixedDiff.toFixed(2) });
          }

          const actColl = Math.abs(+row.collection_fee || 0);
          const expColl = expected.collectionFee || 0;
          const collDiff = actColl - expColl;
          if (Math.abs(collDiff) > THRESH) {
            issues.push({ field: 'collection_fee', actual: actColl, expected: expColl, diff: +collDiff.toFixed(2) });
          }

          variance = issues.reduce((s, i) => s + i.diff, 0);
        } catch { /* skip if calc fails for this row */ }
      }

      return {
        order_item_id:   row.order_item_id,
        order_id:        row.order_id,
        order_date:      row.order_date,
        payment_date:    row.payment_date,
        seller_sku:      row.seller_sku,
        category:        row.category,
        fulfilment_type: row.fulfilment_type,
        sale_amount:     +row.sale_amount,
        commission_rate: +row.commission_rate,
        bank_settlement: +row.bank_settlement,
        actual: {
          commission:     Math.abs(+row.commission || 0),
          fixed_fee:      Math.abs(+row.fixed_fee   || 0),
          collection_fee: Math.abs(+row.collection_fee || 0),
          pick_pack_fee:  Math.abs(+row.pick_pack_fee  || 0),
          shipping_fee:   Math.abs(+row.shipping_fee   || 0),
          tcs:            Math.abs(+row.tcs || 0),
          tds:            Math.abs(+row.tds || 0),
          gst_on_mp:      Math.abs(+row.gst_on_mp_fees || 0),
          total:          Math.abs(+row.actual_total_deductions || 0),
        },
        expected: expected ? {
          commission:      expected.commission    || 0,
          commission_rate: expected.commissionRate,
          fixed_fee:       expected.fixedFee      || 0,
          collection_fee:  expected.collectionFee || 0,
          gst_on_fees:     expected.gstOnFees     || 0,
          tcs:             expected.tcs           || 0,
          total:           expected.totalFees     || 0,
        } : null,
        issues,
        variance: +variance.toFixed(2),
        status: variance > THRESH ? 'overcharged' : variance < -THRESH ? 'undercharged' : 'ok',
        rateCardAvailable: !!rc,
      };
    });

    const overcharged   = data.filter(d => d.status === 'overcharged').length;
    const undercharged  = data.filter(d => d.status === 'undercharged').length;
    const totalVariance = +data.reduce((s, d) => s + d.variance, 0).toFixed(2);

    res.json({ data, overcharged, undercharged, totalVariance, rateCardAvailable: !!rc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
