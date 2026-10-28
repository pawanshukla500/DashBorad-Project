/**
 * Desktop Brand-Wise & FSN-Driven Rate Card Service
 * 
 * Standalone, self-contained rate calculation, change detection,
 * and database synchronization engine for ReconCentral Desktop Worker.
 * 
 * Runs seamlessly on both Windows and Linux without repository dependencies.
 */
import { getDesktopPool } from './db.js';

/**
 * Returns date of day before ISO date string (YYYY-MM-DD).
 */
export function dayBefore(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 1. Query real-time brand-wise and category-wise sample FSNs from orders table
 */
export async function getRealTimeBrandFsnSamples(pool = null) {
  const p = pool || getDesktopPool();
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
  return [
    { price_min: 0, price_max: 999999, rate: standardVerticalRate }
  ];
}

/**
 * 3. Reverse Shipping Slabs Provider
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
    for (const tier of tiers) {
      fixed.push(
        { fulfilment_type: tier, price_min: 0, price_max: 1500, rate: 0 },
        { fulfilment_type: tier, price_min: 1501, price_max: 999999, rate: 10 }
      );
    }
    return fixed;
  }

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
  const p = pool || getDesktopPool();
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
export async function detectBrandRateChanges(brandRateCards, pool = null, options = {}) {
  const p = pool || getDesktopPool();
  const sellerAccount = (typeof options === 'string' ? options : options?.sellerAccount) || 'default';
  const changes = [];

  for (const card of brandRateCards) {
    const { marketplace, category, brand, commissions } = card;

    const activeCommissions = await p.query(`
      SELECT price_min, price_max, rate 
      FROM rc_commission 
      WHERE marketplace = $1 
        AND (seller_account = $4 OR ($4 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
        AND category = $2 
        AND (brand_name = $3 OR ($3 = 'General' AND (brand_name IS NULL OR brand_name = 'All brands')))
        AND end_date IS NULL
    `, [marketplace, category, brand, sellerAccount]);

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

    // Fixed fee differences (compare row count and individual slab values)
    if (card.fixedFees && card.fixedFees.length > 0) {
      const activeFixed = await p.query(`
        SELECT price_min, price_max, rate, fulfilment_type
        FROM rc_fixed_fee
        WHERE marketplace = $1 
          AND (seller_account = $3 OR ($3 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
          AND category = $2 
          AND end_date IS NULL
      `, [marketplace, category, sellerAccount]);

      if (activeFixed.rows.length !== card.fixedFees.length) {
        changes.push({
          type: 'fixed_fee',
          marketplace,
          category,
          brand,
          reason: `Fixed fee slab count changed (DB: ${activeFixed.rows.length}, New: ${card.fixedFees.length})`
        });
      } else {
        for (const ff of card.fixedFees) {
          const match = activeFixed.rows.find(af =>
            af.fulfilment_type === ff.fulfilment_type &&
            Math.abs(parseFloat(af.price_min) - ff.price_min) < 0.01 &&
            Math.abs(parseFloat(af.price_max) - ff.price_max) < 1.0
          );
          if (!match) {
            changes.push({
              type: 'fixed_fee',
              marketplace,
              category,
              brand,
              slab: `${ff.fulfilment_type}: ₹${ff.price_min} - ₹${ff.price_max}`,
              reason: 'New fixed fee tier/slab'
            });
          } else if (Math.abs(parseFloat(match.rate) - ff.rate) > 0.01) {
            changes.push({
              type: 'fixed_fee',
              marketplace,
              category,
              brand,
              slab: `${ff.fulfilment_type}: ₹${ff.price_min} - ₹${ff.price_max}`,
              oldRate: parseFloat(match.rate),
              newRate: ff.rate,
              reason: 'Fixed fee rate modified'
            });
          }
        }
      }
    }

    // Reverse shipping differences (compare row count and individual slab values)
    if (card.reverseShipping && card.reverseShipping.length > 0) {
      const activeRev = await p.query(`
        SELECT weight_slab, price_min, price_max, local_fee, zonal_fee, national_fee
        FROM rc_reverse_shipping
        WHERE marketplace = $1 
          AND (seller_account = $3 OR ($3 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
          AND category = $2 
          AND end_date IS NULL
      `, [marketplace, category, sellerAccount]);

      if (activeRev.rows.length !== card.reverseShipping.length) {
        changes.push({
          type: 'reverse_shipping',
          marketplace,
          category,
          brand,
          reason: `Reverse shipping slab count changed (DB: ${activeRev.rows.length}, New: ${card.reverseShipping.length})`
        });
      } else {
        for (const rs of card.reverseShipping) {
          const match = activeRev.rows.find(ar =>
            ar.weight_slab === rs.weight_slab &&
            Math.abs(parseFloat(ar.price_min) - rs.price_min) < 0.01 &&
            Math.abs(parseFloat(ar.price_max) - rs.price_max) < 1.0
          );
          if (!match) {
            changes.push({
              type: 'reverse_shipping',
              marketplace,
              category,
              brand,
              slab: `${rs.weight_slab}: ₹${rs.price_min} - ₹${rs.price_max}`,
              reason: 'New reverse shipping weight/price slab'
            });
          } else if (
            Math.abs(parseFloat(match.local_fee) - rs.local_fee) > 0.01 ||
            Math.abs(parseFloat(match.zonal_fee) - rs.zonal_fee) > 0.01 ||
            Math.abs(parseFloat(match.national_fee) - rs.national_fee) > 0.01
          ) {
            changes.push({
              type: 'reverse_shipping',
              marketplace,
              category,
              brand,
              slab: `${rs.weight_slab}: ₹${rs.price_min} - ₹${rs.price_max}`,
              reason: 'Reverse shipping fees modified'
            });
          }
        }
      }
    }
  }

  return changes;
}

/**
 * 7. Synchronize Brand-Wise Rate Cards to Database with automatic period closure
 */
export async function syncBrandRateCardsToDatabase(brandRateCards, options = {}, pool = null) {
  const p = pool || getDesktopPool();
  const {
    effectiveDate = new Date().toISOString().slice(0, 10),
    forceUpdate = false,
    sellerAccount = 'default'
  } = options;

  const changes = await detectBrandRateChanges(brandRateCards, p, { sellerAccount });

  if (changes.length === 0 && !forceUpdate) {
    return {
      updated: false,
      message: 'Brand rate cards are already in sync with database. No changes detected.',
      changesCount: 0,
      changes: []
    };
  }

  const previousEndDate = dayBefore(effectiveDate);
  const client = await p.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rate_card_sync_${sellerAccount}`]);

    let insertedCommissions = 0;
    let insertedFixed = 0;
    let insertedRev = 0;
    const processedFixedFeeCategories = new Set();
    const processedRevShippingCategories = new Set();

    for (const card of brandRateCards) {
      const { marketplace, category, brand, commissions, fixedFees, reverseShipping } = card;
      const brandVal = brand === 'General' ? null : brand;

      // 1. Commission Sync with brand_name
      if (commissions.length > 0) {
        await client.query(`
          DELETE FROM rc_commission 
          WHERE marketplace = $1 
            AND seller_account = $2
            AND category = $3 
            AND (brand_name = $4 OR ($4 IS NULL AND brand_name IS NULL))
            AND start_date >= $5::date 
            AND end_date IS NULL
        `, [marketplace, sellerAccount, category, brandVal, effectiveDate]);

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

        for (const comm of commissions) {
          await client.query(`
            INSERT INTO rc_commission (
              marketplace, seller_account, category, brand_name, price_min, price_max, 
              rate, start_date, end_date, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8::date, NULL, NOW()
            )
          `, [marketplace, sellerAccount, category, brandVal, comm.price_min, comm.price_max, comm.rate, effectiveDate]);
          insertedCommissions++;
        }
      }

      // 2. Fixed Fee Sync (category-level: sync once per marketplace + category + seller_account)
      const fixedKey = `${marketplace}_${sellerAccount}_${category}`;
      if (!processedFixedFeeCategories.has(fixedKey) && fixedFees && fixedFees.length > 0) {
        processedFixedFeeCategories.add(fixedKey);

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

        for (const fix of fixedFees) {
          await client.query(`
            INSERT INTO rc_fixed_fee (
              marketplace, seller_account, category, fulfilment_type, price_min, price_max, 
              rate, start_date, end_date, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8::date, NULL, NOW()
            )
          `, [marketplace, sellerAccount, category, fix.fulfilment_type, fix.price_min, fix.price_max, fix.rate, effectiveDate]);
          insertedFixed++;
        }
      }

      // 3. Reverse Shipping Fee Sync (category-level: sync once per marketplace + category + seller_account)
      const revKey = `${marketplace}_${sellerAccount}_${category}`;
      if (!processedRevShippingCategories.has(revKey) && reverseShipping && reverseShipping.length > 0) {
        processedRevShippingCategories.add(revKey);

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

        for (const rev of reverseShipping) {
          await client.query(`
            INSERT INTO rc_reverse_shipping (
              marketplace, seller_account, category, weight_slab, price_min, price_max, 
              local_fee, zonal_fee, national_fee, start_date, end_date, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, NULL, NOW()
            )
          `, [
            marketplace, sellerAccount, category, rev.weight_slab, rev.price_min, rev.price_max,
            rev.local_fee, rev.zonal_fee, rev.national_fee, effectiveDate
          ]);
          insertedRev++;
        }
      }
    }

    // Version record in rate_card_versions
    const versionName = `brand-fsn-sync-${effectiveDate}-${Date.now().toString().slice(-4)}`;
    try {
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
    } catch (verErr) {
      console.warn('[syncBrandRateCardsToDatabase] Note: Could not write rate_card_versions snapshot:', verErr.message);
    }

    await client.query('COMMIT');

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
