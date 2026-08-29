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
      SELECT COUNT(*) 
      FROM orders o 
      WHERE (COALESCE(o.marketplace, 'flipkart') = 'flipkart' AND EXISTS (
               SELECT 1 FROM fk_settlement_orders f WHERE f.order_item_id = o.order_item_id
            ))
    `;
    const res = await pool.query(query);
    console.log(res.rows.map(r => r['QUERY PLAN']).join('\n'));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
