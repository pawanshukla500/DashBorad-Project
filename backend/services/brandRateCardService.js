/**
 * Brand-Wise & FSN-Driven Rate Card Service
 * 
 * Supports Flipkart and Shopsy marketplaces.
 * Discovers real-time sample FSNs and SKUs grouped by (marketplace, category, brand) from `orders`.
 * Implements brand-specific commission logic:
 *   - "Ethnic Junction" and "Youthnic" have identical standard commission.
 *   - "Sangria" has tiered commission (0-500: 0%, 501-800: 2%, 801-1000: 4%, 1001-10000: 10%/13%, >10000: 0%).
 *   - "Divastri" has tiered commission (0-300: 0%, 301-500: 3%, >500: 0%).
 *   - Shopsy has 0% commission across all categories and brands.
 * Detects rate differences against DB and updates with auto-closure (end_date = dayBefore(new_start_date)).
 */
import { getPool } from '../db/index.js';
import { clearRateCardCache } from './rateCard.js';
import { dayBefore } from '../routes/rateCard.js';

/**
 * 1. Query real-time brand-wise and category-wise sample FSNs from orders table
 */
export async function getRealTimeBrandFsnSamples(pool = null) {
  const p = pool || getPool();
  const query = `
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
    SELECT 
      marketplace, 
      category, 
      brand, 
      fsn as sample_fsn, 
      sku as sample_sku, 
      order_count::int as order_count
    FROM ranked
    WHERE rn = 1
    ORDER BY marketplace, category, order_count DESC;
  `;

  const res = await p.query(query);
  return res.rows;
}

/**
 * 2. Brand-Specific Commission Rules Provider
 * Resolves commission slabs for a given marketplace, category, and brand.
 */
export function resolveBrandCommissions(marketplace, category, brandName, standardVerticalRate = 0) {
  const isShopsy = marketplace.toLowerCase().includes('shopsy') || category.toLowerCase().startsWith('shopsy_');

  // SHOPSY: 0% commission across all categories and brands
  if (isShopsy) {
    return [
      { price_min: 0, price_max: 999999, rate: 0.0 }
    ];
  }

  const brand = (brandName || '').trim();

  // SANGRIA: Tiered commission structure
  if (brand.toLowerCase() === 'sangria') {
    if (category === 'top' || category === 'apparel_set') {
      return [
        { price_min: 0, price_max: 300, rate: 0.0 },
        { price_min: 301, price_max: 500, rate: 0.03 },
        { price_min: 501, price_max: 800, rate: 0.02 },
        { price_min: 801, price_max: 1000, rate: 0.07 },
        { price_min: 1001, price_max: 10000, rate: 0.13 },
        { price_min: 10001, price_max: 999999, rate: 0.0 }
      ];
    }
    // Kurta, Sari, Ethnic Set, Dress
    return [
      { price_min: 0, price_max: 500, rate: 0.0 },
      { price_min: 501, price_max: 800, rate: 0.02 },
      { price_min: 801, price_max: 1000, rate: 0.04 },
      { price_min: 1001, price_max: 10000, rate: 0.10 },
      { price_min: 10001, price_max: 999999, rate: 0.0 }
    ];
  }

  // DIVASTRI: Tiered low-ticket slabs
  if (brand.toLowerCase() === 'divastri') {
    return [
      { price_min: 0, price_max: 300, rate: 0.0 },
      { price_min: 301, price_max: 500, rate: 0.03 },
      { price_min: 501, price_max: 999999, rate: 0.0 }
    ];
  }

  // ETHNIC JUNCTION & YOUTHNIC: Same commission
  // Standard zero-commission incentive slabs (0% across all order values, or standard vertical rate)
  return [
    { price_min: 0, price_max: 999999, rate: standardVerticalRate }
  ];
}

/**
 * 3. Reverse Shipping Slabs Provider
 * Standard Flipkart & Shopsy weight/price matrix
 */
export function resolveReverseShippingSlabs(marketplace, category) {
  const isShopsy = marketplace.toLowerCase().includes('shopsy') || category.toLowerCase().startsWith('shopsy_');

  if (isShopsy) {
    return [
      { weight_slab: '0kg-0.5kg', price_min: 0, price_max: 500, local_fee: 122, zonal_fee: 142, national_fee: 182 },
      { weight_slab: '0kg-0.5kg', price_min: 501, price_max: 1000, local_fee: 147, zonal_fee: 167, national_fee: 207 },
      { weight_slab: '0kg-0.5kg', price_min: 1001, price_max: 999999, local_fee: 157, zonal_fee: 177, national_fee: 217 },
      { weight_slab: '0.5kg-1kg', price_min: 0, price_max: 500, local_fee: 152, zonal_fee: 177, national_fee: 227 },
      { weight_slab: '0.5kg-1kg', price_min: 501, price_max: 1000, local_fee: 177, zonal_fee: 202, national_fee: 252 },
      { weight_slab: '0.5kg-1kg', price_min: 1001, price_max: 999999, local_fee: 187, zonal_fee: 212, national_fee: 262 }
    ];
  }

  // Flipkart standard reverse shipping
  return [
    { weight_slab: '0kg-0.5kg', price_min: 0, price_max: 500, local_fee: 122, zonal_fee: 142, national_fee: 182 },
    { weight_slab: '0kg-0.5kg', price_min: 501, price_max: 1000, local_fee: 147, zonal_fee: 167, national_fee: 207 },
    { weight_slab: '0kg-0.5kg', price_min: 1001, price_max: 999999, local_fee: 157, zonal_fee: 177, national_fee: 217 },
    { weight_slab: '0.5kg-1kg', price_min: 0, price_max: 999999, local_fee: 152, zonal_fee: 177, national_fee: 227 }
  ];
}

/**
 * 4. Fixed Fee Slabs Provider
 */
export function resolveFixedFees(marketplace, category) {
  const isShopsy = marketplace.toLowerCase().includes('shopsy') || category.toLowerCase().startsWith('shopsy_');
  const tiers = ['Bronze', 'Silver', 'Gold', 'Diamond'];
  const fixed = [];

  if (isShopsy) {
    // Shopsy Fixed Fee: ₹0 for 0-1500, ₹10 above 1501
    for (const tier of tiers) {
      fixed.push(
        { fulfilment_type: tier, price_min: 0, price_max: 1500, rate: 0 },
        { fulfilment_type: tier, price_min: 1501, price_max: 999999, rate: 10 }
      );
    }
    return fixed;
  }

  // Flipkart standard tiers: ₹0 for 0-1500, ₹10 above 1501
  for (const tier of tiers) {
    fixed.push(
      { fulfilment_type: tier, price_min: 0, price_max: 1500, rate: 0 },
      { fulfilment_type: tier, price_min: 1501, price_max: 999999, rate: 10 }
    );
  }
  return fixed;
}

/**
 * 5. Build Complete Brand-Wise Rate Card Set from Live Catalog
 */
export async function buildBrandRateCardSet(pool = null) {
  const p = pool || getPool();
  const catalog = await getRealTimeBrandFsnSamples(p);
  const effectiveDate = new Date().toISOString().slice(0, 10);

  const brandRateCards = [];

  for (const item of catalog) {
    const mp = item.category.startsWith('shopsy_') ? 'shopsy' : item.marketplace.toLowerCase();
    const commissions = resolveBrandCommissions(mp, item.category, item.brand, 0.0);
    const fixedFees = resolveFixedFees(mp, item.category);
    const reverseShipping = resolveReverseShippingSlabs(mp, item.category);

    brandRateCards.push({
      marketplace: mp,
      category: item.category,
      brand: item.brand,
      sample_fsn: item.sample_fsn,
      sample_sku: item.sample_sku,
      order_count: item.order_count,
      effectiveDate,
      commissions,
      fixedFees,
      reverseShipping
    });
  }

  return brandRateCards;
}

/**
 * 6. Detect Changes Against Database (Brand-Aware)
 */
export async function detectBrandRateChanges(brandRateCards, pool = null) {
  const p = pool || getPool();
  const changes = [];

  for (const card of brandRateCards) {
    const { marketplace, category, brand, commissions } = card;

    const activeCommissions = await p.query(`
      SELECT price_min, price_max, rate 
      FROM rc_commission 
      WHERE marketplace = $1 
        AND category = $2 
        AND (brand_name = $3 OR ($3 = 'General' AND (brand_name IS NULL OR brand_name = 'All brands')))
        AND end_date IS NULL
    `, [marketplace, category, brand]);

    if (activeCommissions.rows.length === 0) {
      changes.push({
        type: 'commission',
        marketplace,
        category,
        brand,
        sample_fsn: card.sample_fsn,
        reason: 'New category & brand commission profile',
        slabsCount: commissions.length
      });
      continue;
    }

    if (activeCommissions.rows.length !== commissions.length) {
      changes.push({
        type: 'commission',
        marketplace,
        category,
        brand,
        sample_fsn: card.sample_fsn,
        reason: `Commission slab count changed (DB: ${activeCommissions.rows.length}, New: ${commissions.length})`,
        slabsCount: commissions.length
      });
    }

    for (const sc of commissions) {
      const match = activeCommissions.rows.find(ac =>
        Math.abs(parseFloat(ac.price_min) - sc.price_min) < 0.01 &&
        Math.abs(parseFloat(ac.price_max) - sc.price_max) < 1.0
      );

      if (!match) {
        changes.push({
          type: 'commission',
          marketplace,
          category,
          brand,
          sample_fsn: card.sample_fsn,
          slab: `₹${sc.price_min} - ₹${sc.price_max}`,
          oldRate: null,
          newRate: sc.rate,
          reason: 'New commission price slab'
        });
      } else if (Math.abs(parseFloat(match.rate) - sc.rate) > 0.0001) {
        changes.push({
          type: 'commission',
          marketplace,
          category,
          brand,
          sample_fsn: card.sample_fsn,
          slab: `₹${sc.price_min} - ₹${sc.price_max}`,
          oldRate: parseFloat(match.rate),
          newRate: sc.rate,
          reason: 'Commission rate percentage modified'
        });
      }
    }

    // Also check fixed fees differences
    if (card.fixedFees && card.fixedFees.length > 0) {
      const activeFixed = await p.query(`
        SELECT price_min, price_max, rate, fulfilment_type
        FROM rc_fixed_fee
        WHERE marketplace = $1 AND category = $2 AND end_date IS NULL
      `, [marketplace, category]);

      if (activeFixed.rows.length !== card.fixedFees.length) {
        changes.push({
          type: 'fixed_fee',
          marketplace,
          category,
          brand,
          reason: `Fixed fee slab count changed (DB: ${activeFixed.rows.length}, New: ${card.fixedFees.length})`
        });
      }
    }

    // Also check reverse shipping differences
    if (card.reverseShipping && card.reverseShipping.length > 0) {
      const activeRev = await p.query(`
        SELECT weight_slab, price_min, price_max, local_fee, zonal_fee, national_fee
        FROM rc_reverse_shipping
        WHERE marketplace = $1 AND category = $2 AND end_date IS NULL
      `, [marketplace, category]);

      if (activeRev.rows.length !== card.reverseShipping.length) {
        changes.push({
          type: 'reverse_shipping',
          marketplace,
          category,
          brand,
          reason: `Reverse shipping slab count changed (DB: ${activeRev.rows.length}, New: ${card.reverseShipping.length})`
        });
      }
    }
  }

  return changes;
}

/**
 * 7. Synchronize Brand-Wise Rate Cards to Database
 * Idempotent: Only updates if changes exist or forceUpdate is true.
 */
export async function syncBrandRateCardsToDatabase(brandRateCards, options = {}, pool = null) {
  const p = pool || getPool();
  const {
    effectiveDate = new Date().toISOString().slice(0, 10),
    forceUpdate = false,
    sellerAccount = 'default'
  } = options;

  const changes = await detectBrandRateChanges(brandRateCards, p);

  if (changes.length === 0 && !forceUpdate) {
    return {
      updated: false,
      message: 'Brand rate cards are already in sync with database. No changes detected.',
      changesCount: 0,
      changes: []
    };
  }

  const client = await p.connect();
  const previousEndDate = dayBefore(effectiveDate);

  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('rate_card_publish_lock'))");

    let insertedCommissions = 0;
    let insertedFixed = 0;
    let insertedRev = 0;

    for (const card of brandRateCards) {
      const { marketplace, category, brand, commissions, fixedFees, reverseShipping } = card;
      const brandVal = brand === 'General' ? null : brand;

      // 1. Commission Sync with brand_name
      if (commissions.length > 0) {
        // Delete any existing active rows starting today to allow clean idempotent replace
        await client.query(`
          DELETE FROM rc_commission 
          WHERE marketplace = $1 
            AND seller_account = $2
            AND category = $3 
            AND (brand_name = $4 OR ($4 IS NULL AND brand_name IS NULL))
            AND start_date >= $5::date 
            AND end_date IS NULL
        `, [marketplace, sellerAccount, category, brandVal, effectiveDate]);

        // Auto-close earlier active periods
        await client.query(`
          UPDATE rc_commission 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 
            AND seller_account = $3
            AND category = $4 
            AND (brand_name = $5 OR ($5 IS NULL AND brand_name IS NULL))
            AND start_date < $6::date
            AND (end_date IS NULL OR end_date >= $6::date)
        `, [previousEndDate, marketplace, sellerAccount, category, brandVal, effectiveDate]);

        for (const c of commissions) {
          await client.query(`
            INSERT INTO rc_commission (category, marketplace, seller_account, brand_name, price_min, price_max, rate, start_date, end_date, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NOW())
          `, [category, marketplace, sellerAccount, brandVal, c.price_min, c.price_max, c.rate, effectiveDate]);
          insertedCommissions++;
        }
      }

      // 2. Fixed Fee Sync (Category & Marketplace level)
      if (fixedFees.length > 0) {
        await client.query(`
          DELETE FROM rc_fixed_fee 
          WHERE marketplace = $1 
            AND seller_account = $2
            AND category = $3 
            AND start_date >= $4::date 
            AND end_date IS NULL
        `, [marketplace, sellerAccount, category, effectiveDate]);

        await client.query(`
          UPDATE rc_fixed_fee 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 
            AND seller_account = $3
            AND category = $4 
            AND start_date < $5::date
            AND (end_date IS NULL OR end_date >= $5::date)
        `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);

        for (const f of fixedFees) {
          await client.query(`
            INSERT INTO rc_fixed_fee (category, marketplace, seller_account, fulfilment_type, price_min, price_max, rate, start_date, end_date, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NOW())
          `, [category, marketplace, sellerAccount, f.fulfilment_type, f.price_min, f.price_max, f.rate, effectiveDate]);
          insertedFixed++;
        }
      }

      // 3. Reverse Shipping Sync
      if (reverseShipping.length > 0) {
        await client.query(`
          DELETE FROM rc_reverse_shipping 
          WHERE marketplace = $1 
            AND seller_account = $2
            AND category = $3 
            AND start_date >= $4::date 
            AND end_date IS NULL
        `, [marketplace, sellerAccount, category, effectiveDate]);

        await client.query(`
          UPDATE rc_reverse_shipping 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 
            AND seller_account = $3
            AND category = $4 
            AND start_date < $5::date
            AND (end_date IS NULL OR end_date >= $5::date)
        `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);

        for (const r of reverseShipping) {
          await client.query(`
            INSERT INTO rc_reverse_shipping (category, marketplace, seller_account, weight_slab, price_min, price_max, local_fee, zonal_fee, national_fee, start_date, end_date, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NOW())
          `, [category, marketplace, sellerAccount, r.weight_slab, r.price_min, r.price_max, r.local_fee, r.zonal_fee, r.national_fee, effectiveDate]);
          insertedRev++;
        }
      }
    }

    // Version record in rate_card_versions
    const versionName = `brand-fsn-sync-${effectiveDate}-${Date.now().toString().slice(-4)}`;
    await client.query(`
      INSERT INTO rate_card_versions (marketplace, seller_account, version_name, status, effective_from, snapshot, created_at, published_at)
      VALUES ('flipkart_shopsy_brandwise', $1, $2, 'published', $3, $4, NOW(), NOW())
    `, [sellerAccount, versionName, effectiveDate, JSON.stringify({
      changesCount: changes.length,
      brandsCount: brandRateCards.length,
      insertedCommissions,
      insertedFixed,
      insertedRev
    })]);

    await client.query('COMMIT');
    clearRateCardCache();

    return {
      updated: true,
      message: `Successfully synchronized ${brandRateCards.length} brand-wise rate cards across Flipkart and Shopsy.`,
      changesCount: changes.length,
      insertedCommissions,
      insertedFixed,
      insertedRev,
      versionName
    };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
