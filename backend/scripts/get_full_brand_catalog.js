import { getPool } from '../db/index.js';
import { getRealTimeBrandFsnSamples } from '../services/brandRateCardService.js';

async function getFullBrandCatalog() {
  const pool = getPool();
  try {
    const catalog = await getRealTimeBrandFsnSamples(pool);
    const unbacked = await pool.query(`
      SELECT marketplace, category,
        COALESCE(NULLIF(TRIM(brand_name), ''), NULLIF(TRIM(brand), ''), 'General') AS brand,
        COALESCE(NULLIF(TRIM(seller_account), ''), 'default') AS seller_account,
        COUNT(*)::int AS order_rows
      FROM orders
      WHERE (marketplace ILIKE '%flipkart%' OR marketplace ILIKE '%shopsy%')
        AND category IS NOT NULL AND TRIM(category) <> ''
      GROUP BY marketplace, category,
        COALESCE(NULLIF(TRIM(brand_name), ''), NULLIF(TRIM(brand), ''), 'General'),
        COALESCE(NULLIF(TRIM(seller_account), ''), 'default')
      HAVING COUNT(*) FILTER (
        WHERE fsn IS NOT NULL AND UPPER(TRIM(fsn)) ~ '^[A-Z0-9]{16}$'
      ) = 0
      ORDER BY marketplace, category, seller_account, brand
    `);

    console.log(`Discovered ${catalog.length} marketplace/category/brand/account combinations with real 16-character order FSNs:`);
    console.table(catalog);
    if (unbacked.rows.length) {
      console.warn('Order category/brand/account combinations with no valid database FSN are skipped by the scraper:');
      console.table(unbacked.rows);
    } else {
      console.log('Every category present in Flipkart/Shopsy orders has at least one valid database FSN.');
    }
    return catalog;
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

getFullBrandCatalog();
