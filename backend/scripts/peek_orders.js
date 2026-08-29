import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../db/index.js';

dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../.env') });

async function run() {
  try {
    const pool = getPool();
    const res = await pool.query(`
      SELECT 
        COALESCE(marketplace, 'flipkart') as marketplace, 
        category, 
        brand, 
        sku, 
        fsn, 
        fnsku,
        product_name
      FROM orders 
      WHERE category IS NOT NULL AND category != ''
      LIMIT 10
    `);
    console.table(res.rows);
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
