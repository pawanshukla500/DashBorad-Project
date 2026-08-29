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
    conds.push(`${alias}.marketplace = $${values.push(q.marketplace)}`);
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
        COALESCE(o.marketplace, 'Unknown')                                        AS marketplace,
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
      GROUP BY COALESCE(o.marketplace, 'Unknown')
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
          AND o.delivery_state IS NOT NULL AND o.delivery_state <> ''
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
          AND o.delivery_state IS NOT NULL AND o.delivery_state <> ''
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
          AND o.delivery_state IS NOT NULL AND o.delivery_state <> ''
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

// GET /api/insights/cash-flow
router.get('/cash-flow', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
    const pool = getPool();
    const mpCond = (req.query.marketplace && req.query.marketplace !== 'all')
      ? [`marketplace = $1`] : [];
    const mpVals = mpCond.length ? [req.query.marketplace] : [];
    const mpWhere  = mpCond.length ? 'AND marketplace = $1' : '';
    const mpWhereS = mpCond.length ? 'AND s.marketplace = $1' : '';
    const omWhere  = mpCond.length ? 'AND o.marketplace = $1' : '';

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
          MIN(o.order_date::text)           AS oldest,
          MAX(o.order_date::text)           AS newest
        FROM orders o
        LEFT JOIN ${ORDER_SETTLEMENT_TOTALS_TABLE} fk ON fk.order_item_id = o.order_item_id
        WHERE fk.order_item_id IS NULL
          AND o.orders_status NOT IN ('Cancelled','CANCELLED','cancelled') ${omWhere}
        GROUP BY o.marketplace
      `, mpVals),
      pool.query(`
        SELECT
          marketplace,
          COUNT(claim_id)            AS total_claims,
          SUM(ABS(settlement_value)) AS total_recovered,
          MAX(payment_date::text)    AS last_claim_date
        FROM fk_spf_claims
        WHERE 1=1 ${mpWhere}
        GROUP BY marketplace
      `, mpVals),
      pool.query(`
        SELECT
          protection_reason, marketplace,
          COUNT(*)                   AS count,
          SUM(ABS(settlement_value)) AS value
        FROM fk_spf_claims
        WHERE 1=1 ${mpWhere}
        GROUP BY protection_reason, marketplace
        ORDER BY value DESC
        LIMIT 20
      `, mpVals),
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
      // Order-level SPF: protection_fund from settlement orders (received against order_item_id)
      pool.query(`
        SELECT
          marketplace,
          COUNT(DISTINCT order_item_id) AS total_orders,
          SUM(protection_fund)          AS total_recovered,
          MAX(TO_CHAR(payment_date,'YYYY-MM-DD')) AS last_date
        FROM unified_settlements
        WHERE protection_fund > 0 ${mpWhere}
        GROUP BY marketplace
      `, mpVals),
      pool.query(`
        SELECT
          s.order_item_id, s.order_id,
          TO_CHAR(s.payment_date,'YYYY-MM-DD') AS payment_date,
          s.protection_fund AS spf_amount,
          s.marketplace,
          o.sku, o.category, o.delivery_state,
          o.final_invoice_amount
        FROM unified_settlements s
        LEFT JOIN orders o ON o.order_item_id = s.order_item_id
        WHERE s.protection_fund > 0 ${mpWhereS}
        ORDER BY s.protection_fund DESC
        LIMIT 200
      `, mpVals),
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
