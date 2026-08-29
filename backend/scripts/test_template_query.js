import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../db/index.js';

dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../.env') });

async function run() {
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
        SELECT 
          COALESCE(marketplace, 'flipkart') as marketplace, 
          category, 
          brand,
          MAX(CASE WHEN COALESCE(marketplace, 'flipkart') = 'flipkart' THEN COALESCE(fsn, sku) ELSE sku END) as sample_sku 
        FROM orders 
        WHERE category IS NOT NULL AND category != '' 
          AND COALESCE(marketplace, 'flipkart') = 'flipkart'
        GROUP BY COALESCE(marketplace, 'flipkart'), category, brand
        ORDER BY category, brand
        LIMIT 10
      `);
    console.table(rows);
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
