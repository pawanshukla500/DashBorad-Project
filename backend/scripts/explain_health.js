import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../db/index.js';

dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../.env') });

async function run() {
  try {
    const pool = getPool();
    const query = `
      EXPLAIN ANALYZE
      WITH order_metrics AS (
        SELECT
          COUNT(*)::int AS orders,
          COUNT(*) FILTER (WHERE NULLIF(o.order_item_id, '') IS NOT NULL)::int AS with_item_id,
          COUNT(*) FILTER (WHERE NULLIF(o.order_item_id, '') IS NULL)::int AS missing_item_id,
          COUNT(*) FILTER (WHERE
            (COALESCE(o.marketplace, 'flipkart') = 'amazon' AND EXISTS (
               SELECT 1 FROM amazon_settlement_lines a 
               WHERE a.order_id = o.order_id 
                 AND (NULLIF(a.sku, '') IS NULL OR o.sku = a.sku)
            ))
            OR (COALESCE(o.marketplace, 'flipkart') = 'flipkart' AND EXISTS (
               SELECT 1 FROM fk_settlement_orders f WHERE f.order_item_id = o.order_item_id
            ))
          )::int AS settled
        FROM orders o
        WHERE ($1::text IS NULL OR COALESCE(o.marketplace, 'flipkart') = $1)
      ),
      return_metrics AS (
        SELECT
          COUNT(*)::int AS returns,
          COUNT(*) FILTER (WHERE
            (COALESCE(r.marketplace, 'flipkart') = 'amazon' AND EXISTS (
               SELECT 1 FROM orders o WHERE o.order_id = r.order_id AND o.sku = r.sku
            ))
            OR (COALESCE(r.marketplace, 'flipkart') = 'flipkart' AND EXISTS (
               SELECT 1 FROM orders o WHERE o.order_item_id = r.order_item_id
            ))
          )::int AS matched_to_orders
        FROM returns r
        WHERE ($1::text IS NULL OR COALESCE(r.marketplace, 'flipkart') = $1)
      )
      SELECT * FROM order_metrics CROSS JOIN return_metrics
    `;
    const res = await pool.query(query, [null]);
    console.log(res.rows.map(r => r['QUERY PLAN']).join('\n'));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
