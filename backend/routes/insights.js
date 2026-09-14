import express from 'express';
import { getPool, isDbConfigured } from '../db/index.js';
import { SETT_CTE } from '../services/settlementSql.js';
import { ORDER_SETTLEMENT_TOTALS_TABLE } from '../services/orderSettlementTotals.js';

const router = express.Router();

function buildWhere(q, alias = 'o') {
  const conds = [];
  const values = [];
  if (q.startDate) { conds.push(`${alias}.order_date >= $${values.push(q.startDate)}`); }
  if (q.endDate)   { conds.push(`${alias}.order_date <= $${values.push(q.endDate)}`); }
  if (q.marketplace && q.marketplace !== 'all') {
    const mp = String(q.marketplace).trim().toLowerCase();
    if (mp === 'myntra_vb') {
      conds.push(`${alias}.marketplace = 'myntra' AND COALESCE(${alias}.seller_account, 'myntra_vb') = 'myntra_vb'`);
    } else if (mp === 'myntra_ej') {
      conds.push(`${alias}.marketplace = 'myntra' AND ${alias}.seller_account = 'myntra_ej'`);
    } else {
      conds.push(`${alias}.marketplace = $${values.push(mp)}`);
    }
  }
  return { where: conds.length ? 'AND ' + conds.join(' AND ') : '', values };
}

// GET /api/insights/marketplace-summary
router.get('/marketplace-summary', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
    const pool = getPool();
    const conds = []; const values = [];
    if (req.query.startDate) { conds.push(`o.order_date >= $${values.push(req.query.startDate)}`); }
    if (req.query.endDate)   { conds.push(`o.order_date <= $${values.push(req.query.endDate)}`); }
    const where = conds.length ? 'AND ' + conds.join(' AND ') : '';

    const { rows } = await pool.query(`
      ${SETT_CTE}
      SELECT
        CASE
          WHEN o.marketplace = 'myntra' THEN COALESCE(o.seller_account, 'myntra_vb')
          ELSE COALESCE(o.marketplace, 'Unknown')
        END                                                                       AS marketplace,
        COUNT(o.order_item_id)                                                    AS orders,
        COALESCE(SUM(o.final_invoice_amount), 0)                                  AS revenue,
        COALESCE(SUM(COALESCE(s.net_bank,0)), 0)                                  AS settlement,
        COUNT(r.order_item_id)                                                    AS returns,
        ROUND(COUNT(r.order_item_id)::numeric / NULLIF(COUNT(o.order_item_id),0)*100,1) AS return_rate,
        COALESCE(SUM(COALESCE(s.commission,0)), 0)                                AS commission,
        COALESCE(SUM(COALESCE(s.fixed_fee,0)), 0)                                 AS fixed_fee,
        COALESCE(SUM(COALESCE(s.pick_pack_fee,0)), 0)                             AS pick_pack_fee,
        COALESCE(SUM(COALESCE(s.shipping_fee,0)), 0)                              AS shipping_fee,
        COALESCE(SUM(
          COALESCE(s.commission,0) + COALESCE(s.fixed_fee,0) +
          COALESCE(s.collection_fee,0) + COALESCE(s.pick_pack_fee,0) +
          COALESCE(s.shipping_fee,0)
        ), 0)                                                                     AS total_fees
      FROM orders o
      LEFT JOIN order_returns r ON r.order_item_id = o.order_item_id
      LEFT JOIN sett s ON s.order_item_id = o.order_item_id
      WHERE 1=1 ${where}
      GROUP BY CASE
        WHEN o.marketplace = 'myntra' THEN COALESCE(o.seller_account, 'myntra_vb')
        ELSE COALESCE(o.marketplace, 'Unknown')
      END
      ORDER BY revenue DESC
    `, values);
    res.json({ marketplaces: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET /api/insights/return-heatmap
router.get('/return-heatmap', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
    const pool = getPool();
    const { where, values } = buildWhere(req.query);

    const [matrixRes, catRes, stateRes, reasonRes] = await Promise.all([
      pool.query(`
        SELECT
          o.category, o.delivery_state AS state, o.marketplace,
          COUNT(o.order_item_id)  AS orders,
          COUNT(r.order_item_id)  AS returns,
          ROUND(COUNT(r.order_item_id)::numeric / NULLIF(COUNT(o.order_item_id),0)*100,1) AS return_rate,
          COALESCE(SUM(CASE WHEN r.order_item_id IS NOT NULL THEN o.final_invoice_amount ELSE 0 END),0) AS return_value
        FROM orders o
        LEFT JOIN order_returns r ON r.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
          AND o.category IS NOT NULL AND o.category <> ''
          AND o.delivery_state IS NOT NULL AND o.delivery_state <> '' AND o.delivery_state <> '-'
        GROUP BY o.category, o.delivery_state, o.marketplace
        ORDER BY return_rate DESC NULLS LAST
      `, values),
      pool.query(`
        SELECT
          o.category, o.marketplace,
          COUNT(o.order_item_id)  AS orders,
          COUNT(r.order_item_id)  AS returns,
          ROUND(COUNT(r.order_item_id)::numeric / NULLIF(COUNT(o.order_item_id),0)*100,1) AS return_rate,
          COALESCE(SUM(o.final_invoice_amount),0) AS revenue,
          COALESCE(SUM(CASE WHEN r.order_item_id IS NOT NULL THEN o.final_invoice_amount ELSE 0 END),0) AS return_value
        FROM orders o
        LEFT JOIN order_returns r ON r.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
          AND o.category IS NOT NULL AND o.category <> ''
        GROUP BY o.category, o.marketplace
        ORDER BY returns DESC NULLS LAST
      `, values),
      pool.query(`
        SELECT
          o.delivery_state AS state, o.marketplace,
          COUNT(o.order_item_id)  AS orders,
          COUNT(r.order_item_id)  AS returns,
          ROUND(COUNT(r.order_item_id)::numeric / NULLIF(COUNT(o.order_item_id),0)*100,1) AS return_rate
        FROM orders o
        LEFT JOIN order_returns r ON r.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
          AND o.delivery_state IS NOT NULL AND o.delivery_state <> '' AND o.delivery_state <> '-'
        GROUP BY o.delivery_state, o.marketplace
        ORDER BY returns DESC NULLS LAST
        LIMIT 25
      `, values),
      pool.query(`
        SELECT
          r.return_reason, o.category, o.marketplace,
          COUNT(*) AS count
        FROM returns r
        JOIN orders o ON o.order_item_id = r.order_item_id
        WHERE r.return_reason IS NOT NULL AND r.return_reason <> '' ${where}
        GROUP BY r.return_reason, o.category, o.marketplace
        ORDER BY count DESC
        LIMIT 60
      `, values),
    ]);

    res.json({
      matrix: matrixRes.rows,
      byCategory: catRes.rows,
      byState: stateRes.rows,
      byReason: reasonRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET /api/insights/rto-risk
router.get('/rto-risk', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
    const pool = getPool();
    const { where, values } = buildWhere(req.query);

    const [skuRes, stateCatRes] = await Promise.all([
      pool.query(`
        SELECT
          o.sku, o.category, o.marketplace,
          COUNT(o.order_item_id)  AS orders,
          COUNT(r.order_item_id)  AS returns,
          ROUND(COUNT(r.order_item_id)::numeric / NULLIF(COUNT(o.order_item_id),0)*100,1) AS return_rate,
          COALESCE(SUM(o.final_invoice_amount),0) AS revenue,
          COALESCE(SUM(CASE WHEN r.order_item_id IS NOT NULL THEN o.final_invoice_amount ELSE 0 END),0) AS return_value
        FROM orders o
        LEFT JOIN order_returns r ON r.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
          AND o.sku IS NOT NULL AND o.sku <> ''
        GROUP BY o.sku, o.category, o.marketplace
        HAVING COUNT(o.order_item_id) >= 3
        ORDER BY return_rate DESC NULLS LAST
        LIMIT 50
      `, values),
      pool.query(`
        SELECT
          o.delivery_state AS state, o.category, o.marketplace,
          COUNT(o.order_item_id)  AS orders,
          COUNT(r.order_item_id)  AS returns,
          ROUND(COUNT(r.order_item_id)::numeric / NULLIF(COUNT(o.order_item_id),0)*100,1) AS return_rate
        FROM orders o
        LEFT JOIN order_returns r ON r.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
          AND o.delivery_state IS NOT NULL AND o.delivery_state <> '' AND o.delivery_state <> '-'
          AND o.category IS NOT NULL AND o.category <> ''
        GROUP BY o.delivery_state, o.category, o.marketplace
        HAVING COUNT(o.order_item_id) >= 5
        ORDER BY return_rate DESC NULLS LAST
        LIMIT 80
      `, values),
    ]);

    res.json({ bySku: skuRes.rows, byStateCategory: stateCatRes.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET /api/insights/fulfilment-pl
router.get('/fulfilment-pl', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
    const pool = getPool();
    const { where, values } = buildWhere(req.query);

    const FT_CASE = `
      CASE
        WHEN UPPER(o.fulfilment_type) IN ('FBF','FLIPKART_FULFILLED','FLIPKART FULFILLED') THEN 'FBF'
        WHEN UPPER(o.fulfilment_type) = 'FBA' THEN 'FBA'
        WHEN UPPER(o.fulfilment_type) IN ('FLEX','SELLER_FLEX','SELLER FLEX') THEN 'Flex'
        WHEN UPPER(o.fulfilment_type) IN ('EASY_SHIP','EASY SHIP','EASYSHIP') THEN 'Easy Ship'
        WHEN UPPER(o.fulfilment_type) IN ('NON_FBF','SELLER_SHIPPED','SELF_SHIP') THEN 'Self-Ship'
        ELSE COALESCE(NULLIF(o.fulfilment_type,''), 'Unknown')
      END`;

    const [ftRes, catRes] = await Promise.all([
      pool.query(`
        ${SETT_CTE}
        SELECT
          ${FT_CASE} AS ft, o.marketplace,
          COUNT(o.order_item_id)                                                  AS orders,
          COALESCE(SUM(o.final_invoice_amount),0)                                 AS revenue,
          COALESCE(SUM(COALESCE(s.commission,0)),0)                               AS commission,
          COALESCE(SUM(COALESCE(s.fixed_fee,0)),0)                                AS fixed_fee,
          COALESCE(SUM(COALESCE(s.collection_fee,0)),0)                           AS collection_fee,
          COALESCE(SUM(COALESCE(s.pick_pack_fee,0)),0)                            AS pick_pack_fee,
          COALESCE(SUM(COALESCE(s.shipping_fee,0)),0)                             AS shipping_fee,
          COALESCE(SUM(
            COALESCE(s.commission,0) + COALESCE(s.fixed_fee,0) +
            COALESCE(s.collection_fee,0) + COALESCE(s.pick_pack_fee,0) +
            COALESCE(s.shipping_fee,0)
          ),0)                                                                    AS total_fees,
          COALESCE(SUM(COALESCE(s.net_bank,0)),0)                                 AS settlement,
          COUNT(r.order_item_id)                                                  AS returns,
          ROUND(COUNT(r.order_item_id)::numeric / NULLIF(COUNT(o.order_item_id),0)*100,1) AS return_rate
        FROM orders o
        LEFT JOIN order_returns r ON r.order_item_id = o.order_item_id
        LEFT JOIN sett s ON s.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
        GROUP BY ft, o.marketplace
        ORDER BY revenue DESC
      `, values),
      pool.query(`
        SELECT
          o.category, ${FT_CASE} AS ft, o.marketplace,
          COUNT(o.order_item_id)            AS orders,
          COALESCE(SUM(o.final_invoice_amount),0) AS revenue,
          COALESCE(SUM(o.settlement_amount),0)    AS settlement,
          COUNT(r.order_item_id)            AS returns
        FROM orders o
        LEFT JOIN order_returns r ON r.order_item_id = o.order_item_id
        WHERE 1=1 ${where}
          AND o.category IS NOT NULL AND o.category <> ''
        GROUP BY o.category, ft, o.marketplace
        ORDER BY revenue DESC
      `, values),
    ]);

    res.json({ byFulfilment: ftRes.rows, byCategoryFt: catRes.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

export function buildSpfQueries(rawMp) {
  const targetMp = rawMp && rawMp !== 'all' ? String(rawMp).trim().toLowerCase() : null;

  const includeFk = !targetMp || targetMp === 'flipkart';
  const includeAmz = !targetMp || targetMp === 'amazon';
  const includeMynVb = !targetMp || targetMp === 'myntra' || targetMp === 'myntra_vb';
  const includeMynEj = !targetMp || targetMp === 'myntra' || targetMp === 'myntra_ej';
  const includeMeesho = !targetMp || targetMp === 'meesho';

  const cteClaimsParts = [];
  const cteReasonsParts = [];
  const cteOrderSummaryParts = [];
  const cteOrderDetailParts = [];

  if (includeFk) {
    cteClaimsParts.push(`
      SELECT 'flipkart' AS marketplace, claim_id::text AS id, ABS(settlement_value) AS val, payment_date::text AS last_date
      FROM fk_spf_claims
    `);
    cteReasonsParts.push(`
      SELECT 'flipkart' AS marketplace, protection_reason, ABS(settlement_value) AS val
      FROM fk_spf_claims
    `);
    cteOrderSummaryParts.push(`
      SELECT 'flipkart' AS marketplace, order_item_id, protection_fund AS val, payment_date
      FROM unified_settlements
      WHERE protection_fund > 0 AND marketplace = 'flipkart'
    `);
    cteOrderDetailParts.push(`
      SELECT
        s.order_item_id, s.order_id,
        TO_CHAR(s.payment_date,'YYYY-MM-DD') AS payment_date,
        s.protection_fund AS spf_amount,
        'flipkart' AS marketplace,
        o.sku, o.category, o.delivery_state,
        COALESCE(o.final_invoice_amount, 0) AS final_invoice_amount,
        COALESCE(c.protection_reason, 'Order Protection Fund') AS claim_reason
      FROM unified_settlements s
      LEFT JOIN orders o ON o.order_item_id = s.order_item_id
      LEFT JOIN fk_spf_claims c ON c.order_item_id = s.order_item_id
      WHERE s.protection_fund > 0 AND s.marketplace = 'flipkart'
    `);
  }

  if (includeAmz) {
    cteClaimsParts.push(`
      SELECT 'amazon' AS marketplace, id::text AS id, amount AS val, posted_date::text AS last_date
      FROM amazon_settlement_lines
      WHERE (transaction_type IN ('SAFE-T Reimbursement', 'TDS Reimbursement') OR amount_type ILIKE '%reimburse%' OR amount_description ILIKE '%reimburse%') AND amount > 0
    `);
    cteReasonsParts.push(`
      SELECT 'amazon' AS marketplace, amount_description AS protection_reason, amount AS val
      FROM amazon_settlement_lines
      WHERE (transaction_type IN ('SAFE-T Reimbursement', 'TDS Reimbursement') OR amount_type ILIKE '%reimburse%' OR amount_description ILIKE '%reimburse%') AND amount > 0
    `);
    cteOrderSummaryParts.push(`
      SELECT 'amazon' AS marketplace, order_id AS order_item_id, amount AS val, posted_date AS payment_date
      FROM amazon_settlement_lines
      WHERE (transaction_type IN ('SAFE-T Reimbursement', 'TDS Reimbursement') OR amount_type ILIKE '%reimburse%' OR amount_description ILIKE '%reimburse%')
        AND order_id IS NOT NULL AND order_id != '' AND amount > 0
    `);
    cteOrderDetailParts.push(`
      SELECT
        COALESCE(l.order_item_code, l.composite_key, l.order_id) AS order_item_id,
        l.order_id,
        TO_CHAR(l.posted_date,'YYYY-MM-DD') AS payment_date,
        l.amount AS spf_amount,
        'amazon' AS marketplace,
        l.sku, o.category, o.delivery_state,
        COALESCE(o.final_invoice_amount, 0) AS final_invoice_amount,
        l.amount_description AS claim_reason
      FROM amazon_settlement_lines l
      LEFT JOIN orders o ON o.order_id = l.order_id
      WHERE (l.transaction_type IN ('SAFE-T Reimbursement', 'TDS Reimbursement') OR l.amount_type ILIKE '%reimburse%' OR l.amount_description ILIKE '%reimburse%')
        AND l.order_id IS NOT NULL AND l.order_id != '' AND l.amount > 0
    `);
  }

  if (includeMynVb) {
    cteClaimsParts.push(`
      SELECT 'myntra_vb' AS marketplace, id::text AS id, amount_received AS val, payment_date::text AS last_date
      FROM mp_invoices
      WHERE marketplace = 'myntra' AND COALESCE(seller_account, 'myntra_vb') = 'myntra_vb'
        AND (notes ILIKE '%spf%' OR invoice_number ILIKE '%spf%' OR notes ILIKE '%rbnr%') AND amount_received > 0
    `);
    cteReasonsParts.push(`
      SELECT 'myntra_vb' AS marketplace, notes AS protection_reason, amount_received AS val
      FROM mp_invoices
      WHERE marketplace = 'myntra' AND COALESCE(seller_account, 'myntra_vb') = 'myntra_vb'
        AND (notes ILIKE '%spf%' OR invoice_number ILIKE '%spf%' OR notes ILIKE '%rbnr%') AND amount_received > 0
    `);
    cteOrderSummaryParts.push(`
      SELECT 'myntra_vb' AS marketplace, invoice_number AS order_item_id, amount_received AS val, payment_date
      FROM mp_invoices
      WHERE marketplace = 'myntra' AND COALESCE(seller_account, 'myntra_vb') = 'myntra_vb'
        AND notes = 'ForwardAutoSPF' AND amount_received > 0
    `);
    cteOrderDetailParts.push(`
      SELECT
        inv.invoice_number AS order_item_id,
        inv.invoice_number AS order_id,
        TO_CHAR(inv.payment_date,'YYYY-MM-DD') AS payment_date,
        inv.amount_received AS spf_amount,
        'myntra_vb' AS marketplace,
        o.sku, o.category, o.delivery_state,
        COALESCE(inv.invoice_amount, o.final_invoice_amount, 0) AS final_invoice_amount,
        inv.notes AS claim_reason
      FROM mp_invoices inv
      LEFT JOIN orders o ON o.order_id = inv.invoice_number
      WHERE inv.marketplace = 'myntra' AND COALESCE(inv.seller_account, 'myntra_vb') = 'myntra_vb'
        AND (inv.notes ILIKE '%spf%' OR inv.invoice_number ILIKE '%spf%' OR inv.notes ILIKE '%rbnr%') AND inv.amount_received > 0
    `);
  }

  if (includeMynEj) {
    cteClaimsParts.push(`
      SELECT 'myntra_ej' AS marketplace, id::text AS id, amount_received AS val, payment_date::text AS last_date
      FROM mp_invoices
      WHERE marketplace = 'myntra' AND seller_account = 'myntra_ej'
        AND (notes ILIKE '%spf%' OR invoice_number ILIKE '%spf%' OR notes ILIKE '%rbnr%') AND amount_received > 0
    `);
    cteReasonsParts.push(`
      SELECT 'myntra_ej' AS marketplace, notes AS protection_reason, amount_received AS val
      FROM mp_invoices
      WHERE marketplace = 'myntra' AND seller_account = 'myntra_ej'
        AND (notes ILIKE '%spf%' OR invoice_number ILIKE '%spf%' OR notes ILIKE '%rbnr%') AND amount_received > 0
    `);
    cteOrderSummaryParts.push(`
      SELECT 'myntra_ej' AS marketplace, invoice_number AS order_item_id, amount_received AS val, payment_date
      FROM mp_invoices
      WHERE marketplace = 'myntra' AND seller_account = 'myntra_ej'
        AND notes = 'ForwardAutoSPF' AND amount_received > 0
    `);
    cteOrderDetailParts.push(`
      SELECT
        inv.invoice_number AS order_item_id,
        inv.invoice_number AS order_id,
        TO_CHAR(inv.payment_date,'YYYY-MM-DD') AS payment_date,
        inv.amount_received AS spf_amount,
        'myntra_ej' AS marketplace,
        o.sku, o.category, o.delivery_state,
        COALESCE(inv.invoice_amount, o.final_invoice_amount, 0) AS final_invoice_amount,
        inv.notes AS claim_reason
      FROM mp_invoices inv
      LEFT JOIN orders o ON o.order_id = inv.invoice_number
      WHERE inv.marketplace = 'myntra' AND inv.seller_account = 'myntra_ej'
        AND (inv.notes ILIKE '%spf%' OR inv.invoice_number ILIKE '%spf%' OR inv.notes ILIKE '%rbnr%') AND inv.amount_received > 0
    `);
  }

  if (includeMeesho) {
    cteClaimsParts.push(`
      SELECT 'meesho' AS marketplace, id::text AS id, claims AS val, payment_date::text AS last_date
      FROM meesho_settlement_items
      WHERE claims > 0
    `);
    cteReasonsParts.push(`
      SELECT 'meesho' AS marketplace, 'Settlement Claim' AS protection_reason, claims AS val
      FROM meesho_settlement_items
      WHERE claims > 0
    `);
    cteOrderSummaryParts.push(`
      SELECT 'meesho' AS marketplace, order_item_id, claims AS val, payment_date
      FROM meesho_settlement_items
      WHERE claims > 0 AND order_item_id IS NOT NULL AND order_item_id != ''
    `);
    cteOrderDetailParts.push(`
      SELECT
        m.order_item_id, m.order_item_id AS order_id,
        TO_CHAR(m.payment_date,'YYYY-MM-DD') AS payment_date,
        m.claims AS spf_amount,
        'meesho' AS marketplace,
        m.sku, o.category, o.delivery_state,
        COALESCE(o.final_invoice_amount, m.sale_amount, 0) AS final_invoice_amount,
        'Meesho Claim' AS claim_reason
      FROM meesho_settlement_items m
      LEFT JOIN orders o ON o.order_item_id = m.order_item_id
      WHERE m.claims > 0
    `);
  }

  const emptyClaim = `SELECT 'none' AS marketplace, '' AS id, 0::numeric AS val, '' AS last_date WHERE 1=0`;
  const emptyReason = `SELECT 'none' AS marketplace, '' AS protection_reason, 0::numeric AS val WHERE 1=0`;
  const emptyOrderSummary = `SELECT 'none' AS marketplace, '' AS order_item_id, 0::numeric AS val, CURRENT_DATE AS payment_date WHERE 1=0`;
  const emptyOrderDetail = `SELECT '' AS order_item_id, '' AS order_id, '' AS payment_date, 0::numeric AS spf_amount, 'none' AS marketplace, '' AS sku, '' AS category, '' AS delivery_state, 0::numeric AS final_invoice_amount, '' AS claim_reason WHERE 1=0`;

  const totalSql = `
    WITH all_claims AS (
      ${cteClaimsParts.length ? cteClaimsParts.join(' UNION ALL ') : emptyClaim}
    )
    SELECT marketplace, COUNT(id) AS total_claims, ROUND(SUM(val), 2) AS total_recovered, MAX(last_date) AS last_claim_date
    FROM all_claims GROUP BY marketplace
  `;

  const reasonsSql = `
    WITH all_reasons AS (
      ${cteReasonsParts.length ? cteReasonsParts.join(' UNION ALL ') : emptyReason}
    )
    SELECT protection_reason, marketplace, COUNT(*) AS count, ROUND(SUM(val), 2) AS value
    FROM all_reasons GROUP BY protection_reason, marketplace ORDER BY value DESC LIMIT 25
  `;

  const orderSummarySql = `
    WITH all_order_spf AS (
      ${cteOrderSummaryParts.length ? cteOrderSummaryParts.join(' UNION ALL ') : emptyOrderSummary}
    )
    SELECT marketplace, COUNT(DISTINCT order_item_id) AS total_orders, ROUND(SUM(val), 2) AS total_recovered, MAX(TO_CHAR(payment_date,'YYYY-MM-DD')) AS last_date
    FROM all_order_spf GROUP BY marketplace
  `;

  const orderDetailSql = `
    WITH all_order_details AS (
      ${cteOrderDetailParts.length ? cteOrderDetailParts.join(' UNION ALL ') : emptyOrderDetail}
    )
    SELECT * FROM all_order_details ORDER BY spf_amount DESC LIMIT 200
  `;

  return { totalSql, reasonsSql, orderSummarySql, orderDetailSql };
}

// GET /api/insights/cash-flow
router.get('/cash-flow', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
    const pool = getPool();
    const rawMp = req.query.marketplace;
    let mpWhere = '';
    let mpWhereS = '';
    let omWhere = '';
    const mpVals = [];
    if (rawMp && rawMp !== 'all') {
      const mp = String(rawMp).trim().toLowerCase();
      if (mp === 'myntra_vb') {
        mpWhere = "AND marketplace = 'myntra'";
        mpWhereS = "AND s.marketplace = 'myntra' AND COALESCE(o.seller_account, 'myntra_vb') = 'myntra_vb'";
        omWhere = "AND o.marketplace = 'myntra' AND COALESCE(o.seller_account, 'myntra_vb') = 'myntra_vb'";
      } else if (mp === 'myntra_ej') {
        mpWhere = "AND marketplace = 'myntra'";
        mpWhereS = "AND s.marketplace = 'myntra' AND o.seller_account = 'myntra_ej'";
        omWhere = "AND o.marketplace = 'myntra' AND o.seller_account = 'myntra_ej'";
      } else {
        mpVals.push(mp);
        mpWhere = `AND marketplace = $${mpVals.length}`;
        mpWhereS = `AND s.marketplace = $${mpVals.length}`;
        omWhere = `AND o.marketplace = $${mpVals.length}`;
      }
    }

    const { totalSql, reasonsSql, orderSummarySql, orderDetailSql } = buildSpfQueries(rawMp);

    const [settRes, unsettledRes, spfTotalRes, spfReasonRes, neftRes, orderSpfSummaryRes, orderSpfDetailRes] = await Promise.all([
      pool.query(`
        SELECT
          TO_CHAR(payment_date,'YYYY-MM-DD') AS date,
          SUM(CASE WHEN bank_settlement > 0 THEN bank_settlement ELSE 0 END) AS inflow,
          SUM(CASE WHEN bank_settlement < 0 THEN ABS(bank_settlement) ELSE 0 END) AS outflow,
          SUM(bank_settlement) AS net,
          COUNT(DISTINCT neft_id) AS neft_count,
          marketplace
        FROM unified_settlements
        WHERE payment_date >= CURRENT_DATE - INTERVAL '120 days' ${mpWhere}
        GROUP BY date, marketplace
        ORDER BY date ASC
      `, mpVals),
      pool.query(`
        SELECT
          o.marketplace,
          COUNT(o.order_item_id)            AS count,
          COALESCE(SUM(o.final_invoice_amount),0) AS value,
          MIN(TO_CHAR(o.order_date, 'YYYY-MM-DD')) AS oldest,
          MAX(TO_CHAR(o.order_date, 'YYYY-MM-DD')) AS newest
        FROM orders o
        LEFT JOIN ${ORDER_SETTLEMENT_TOTALS_TABLE} fk ON fk.order_item_id = o.order_item_id
        LEFT JOIN returns ret ON ret.order_item_id = o.order_item_id
        WHERE fk.order_item_id IS NULL
          AND o.orders_status NOT IN ('Cancelled','CANCELLED','cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned')
          AND o.return_type IS NULL
          AND ret.order_item_id IS NULL ${omWhere}
        GROUP BY o.marketplace
      `, mpVals),
      pool.query(totalSql),
      pool.query(reasonsSql),
      pool.query(`
        SELECT
          neft_id,
          TO_CHAR(payment_date,'YYYY-MM-DD') AS date,
          SUM(CASE WHEN bank_settlement > 0 THEN bank_settlement ELSE 0 END) AS inflow,
          SUM(bank_settlement) AS net,
          COUNT(DISTINCT order_item_id) AS items,
          marketplace
        FROM unified_settlements
        WHERE payment_date >= CURRENT_DATE - INTERVAL '60 days' ${mpWhere}
        GROUP BY neft_id, date, marketplace
        ORDER BY date DESC
        LIMIT 30
      `, mpVals),
      pool.query(orderSummarySql),
      pool.query(orderDetailSql),
    ]);

    res.json({
      settlementHistory: settRes.rows,
      unsettled: unsettledRes.rows,
      spfTotals: spfTotalRes.rows,
      spfReasons: spfReasonRes.rows,
      recentNefts: neftRes.rows,
      orderSpfSummary: orderSpfSummaryRes.rows,
      orderSpfDetail: orderSpfDetailRes.rows,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

export default router;
