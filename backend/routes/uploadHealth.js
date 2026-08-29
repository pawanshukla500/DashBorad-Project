import express from 'express';
import { getPool, isDbConfigured } from '../db/index.js';

const router = express.Router();

/**
 * GET /api/upload/linkage-health?marketplace=flipkart|amazon|all
 * Recon checklist metrics for Data Hub.
 */
router.get('/linkage-health', async (req, res) => {
  if (!(await isDbConfigured())) {
    return res.json({ configured: false });
  }
  try {
    const pool = getPool();
    const requestedMarketplace = (req.query.marketplace || '').toLowerCase();
    const marketplace = requestedMarketplace && requestedMarketplace !== 'all'
      ? requestedMarketplace
      : null;

    // Do not query the unified_settlements VIEW here. For Amazon it expands and
    // aggregates every settlement line before the order match; five browser
    // refreshes could therefore monopolise the pool and block normal uploads.
    // The physical source tables below have narrow lookup indexes and preserve
    // the same linkage rules: Amazon uses (order_id, seller SKU); Flipkart uses
    // order_item_id. Other marketplace settlement importers do not yet write a
    // reconciliation source, so they correctly show zero linked settlements.
    const [r1, r2_fk, r2_amz, r3, r4_fk, r4_amz] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS orders,
          COUNT(*) FILTER (WHERE NULLIF(order_item_id, '') IS NOT NULL)::int AS with_item_id,
          COUNT(*) FILTER (WHERE NULLIF(order_item_id, '') IS NULL)::int AS missing_item_id
        FROM orders
        WHERE ($1::text IS NULL OR COALESCE(marketplace, 'flipkart') = $1)
      `, [marketplace]),
      pool.query(`
        SELECT COUNT(*)::int AS settled
        FROM orders o
        WHERE ($1::text IS NULL OR COALESCE(o.marketplace, 'flipkart') = $1)
          AND COALESCE(o.marketplace, 'flipkart') = 'flipkart'
          AND EXISTS (SELECT 1 FROM fk_settlement_orders f WHERE f.order_item_id = o.order_item_id)
      `, [marketplace]),
      pool.query(`
        SELECT COUNT(*)::int AS settled
        FROM orders o
        WHERE ($1::text IS NULL OR COALESCE(o.marketplace, 'flipkart') = $1)
          AND COALESCE(o.marketplace, 'flipkart') = 'amazon'
          AND EXISTS (
             SELECT 1 FROM amazon_settlement_lines a 
             WHERE a.order_id = o.order_id 
               AND (NULLIF(a.sku, '') IS NULL OR o.sku = a.sku)
          )
      `, [marketplace]),
      pool.query(`
        SELECT COUNT(*)::int AS returns
        FROM returns r
        WHERE ($1::text IS NULL OR COALESCE(r.marketplace, 'flipkart') = $1)
      `, [marketplace]),
      pool.query(`
        SELECT COUNT(*)::int AS matched_to_orders
        FROM returns r
        WHERE ($1::text IS NULL OR COALESCE(r.marketplace, 'flipkart') = $1)
          AND COALESCE(r.marketplace, 'flipkart') = 'flipkart'
          AND EXISTS (SELECT 1 FROM orders o WHERE o.order_item_id = r.order_item_id)
      `, [marketplace]),
      pool.query(`
        SELECT COUNT(*)::int AS matched_to_orders
        FROM returns r
        WHERE ($1::text IS NULL OR COALESCE(r.marketplace, 'flipkart') = $1)
          AND COALESCE(r.marketplace, 'flipkart') = 'amazon'
          AND EXISTS (SELECT 1 FROM orders o WHERE o.order_id = r.order_id AND o.sku = r.sku)
      `, [marketplace])
    ]);

    const orders = r1.rows[0].orders;
    const withItemId = r1.rows[0].with_item_id;
    const settled = r2_fk.rows[0].settled + r2_amz.rows[0].settled;
    const totalReturns = r3.rows[0].returns;
    const matchedReturns = r4_fk.rows[0].matched_to_orders + r4_amz.rows[0].matched_to_orders;

    res.json({
      configured: true,
      marketplace: requestedMarketplace || 'all',
      orders,
      withItemId,
      missingItemId: r1.rows[0].missing_item_id || 0,
      itemIdPct: orders > 0 ? +(withItemId / orders * 100).toFixed(1) : 0,
      returns: totalReturns,
      settled,
      unsettled: Math.max(orders - settled, 0),
      settledPct: orders > 0 ? +(settled / orders * 100).toFixed(1) : 0,
      returnsMatched: matchedReturns,
      returnsMatchedPct: totalReturns > 0 ? +(matchedReturns / totalReturns * 100).toFixed(1) : 0,
      checklist: requestedMarketplace === 'amazon' ? [
        { key: 'amazon-sale-orders', label: 'Sale Orders', required: true },
        { key: 'amazon-fba-returns', label: 'FBA Returns', required: false },
        { key: 'amazon-flex-returns', label: 'Flex Returns', required: false },
        { key: 'amazon-settlement', label: 'Settlement (Payment)', required: true },
      ] : [
        { key: 'orders', label: 'Sales / Orders', required: true },
        { key: 'returns', label: 'Returns', required: true },
        { key: 'fk-settlement', label: 'FK Settlement Report', required: true },
      ],
    });
  } catch (e) {
    console.error('[linkage-health]', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
