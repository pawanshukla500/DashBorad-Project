import { getPool } from '../db/index.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

async function getFullBrandCatalog() {
  const pool = getPool();
  try {
    const res = await pool.query(`
      WITH ranked AS (
        SELECT 
          marketplace,
          category,
          COALESCE(NULLIF(TRIM(brand), ''), 'General') as brand,
          fsn,
          sku,
          ROW_NUMBER() OVER (
            PARTITION BY marketplace, category, COALESCE(NULLIF(TRIM(brand), ''), 'General') 
            ORDER BY id DESC
          ) as rn,
          COUNT(1) OVER (
            PARTITION BY marketplace, category, COALESCE(NULLIF(TRIM(brand), ''), 'General')
          ) as order_count
        FROM orders
        WHERE (marketplace ILIKE '%flipkart%' OR marketplace ILIKE '%shopsy%')
          AND fsn IS NOT NULL AND fsn != ''
          AND category IS NOT NULL AND category != ''
      )
      SELECT marketplace, category, brand, fsn as sample_fsn, sku as sample_sku, order_count
      FROM ranked
      WHERE rn = 1
      ORDER BY marketplace, category, order_count DESC;
    `);

    console.log(`Discovered ${res.rows.length} brand-category combinations in orders:`);
    console.table(res.rows);
    return res.rows;
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

getFullBrandCatalog();
