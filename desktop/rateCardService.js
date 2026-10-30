/**
 * Desktop Brand-Wise & FSN-Driven Rate Card Service
 * 
 * Standalone, self-contained rate calculation, change detection,
 * and database synchronization engine for ReconCentral Desktop Worker.
 * 
 * Runs seamlessly on both Windows and Linux without repository dependencies.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDesktopPool } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let cachedAppVersion = null;
export function getDesktopAppVersion() {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    cachedAppVersion = pkg.version || '1.6.0';
  } catch {
    cachedAppVersion = '1.6.0';
  }
  return cachedAppVersion;
}

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

/** Read-only published database snapshot. It is never a scraped observation. */
export async function buildBrandRateCardSet(pool = null) {
  const p = pool || getDesktopPool();
  const effectiveDate = new Date().toISOString().slice(0, 10);
  const fields = [['rc_commission','commissions'],['rc_fixed_fee','fixedFees'],['rc_collection_fee','collectionFees'],['rc_reverse_shipping','reverseShipping']];
  const cards = new Map();
  for (const [table, field] of fields) {
    const { rows } = await p.query(`SELECT * FROM ${table} WHERE marketplace IN ('flipkart','shopsy')
      AND (start_date IS NULL OR start_date <= $1) AND (end_date IS NULL OR end_date >= $1) ORDER BY category, id`, [effectiveDate]);
    for (const row of rows) {
      const brand = row.brand_name || 'General';
      const key = JSON.stringify([row.marketplace,row.category,field === 'commissions' ? brand : 'General']);
      if (!cards.has(key)) cards.set(key, { marketplace: row.marketplace, category: row.category, brand,
        source: 'published_database', effectiveDate, commissions: [], fixedFees: [], collectionFees: [], reverseShipping: [] });
      const slab = { ...row };
      for (const k of ['price_min','price_max','rate','prepaid','postpaid','local_fee','zonal_fee','national_fee']) {
        if (slab[k] !== undefined && slab[k] !== null) slab[k] = Number(slab[k]);
      }
      cards.get(key)[field].push(slab);
    }
  }
  return [...cards.values()];
}

/**
 * Annotates and flags rate changes as anomalies when unexpected or extreme
 * shifts are detected (e.g. commission jump >= 5%, relative shift >= 50%,
 * closing fee shift >= ₹20, return fee shift >= ₹25).
 */
export function annotateRateAnomaly(change) {
  let anomaly = false;
  let anomalyType = null;
  let anomalySeverity = null;
  let anomalyNote = '';

  const { type, oldRate, newRate } = change;

  if (type === 'commission') {
    if (oldRate != null && newRate != null && typeof oldRate === 'number' && typeof newRate === 'number') {
      const deltaAbs = Math.abs(newRate - oldRate);
      const relPct = oldRate > 0 ? (deltaAbs / oldRate) : 1;
      if (deltaAbs >= 0.05 || (oldRate > 0 && relPct >= 0.50)) {
        anomaly = true;
        anomalyType = 'commission_shift';
        anomalySeverity = 'high';
        anomalyNote = `${newRate >= oldRate ? '+' : ''}${((newRate - oldRate) * 100).toFixed(1)}% shift`;
      }
    } else if (oldRate == null && typeof newRate === 'number' && newRate >= 0.25) {
      anomaly = true;
      anomalyType = 'high_initial_rate';
      anomalySeverity = 'medium';
      anomalyNote = `high initial rate ${(newRate * 100).toFixed(1)}%`;
    }
  } else if (type === 'fixed_fee') {
    if (oldRate != null && newRate != null && typeof oldRate === 'number' && typeof newRate === 'number') {
      const deltaAbs = Math.abs(newRate - oldRate);
      const relPct = oldRate > 0 ? (deltaAbs / oldRate) : 1;
      if (deltaAbs >= 20 || (oldRate > 0 && relPct >= 0.50)) {
        anomaly = true;
        anomalyType = 'fixed_fee_shift';
        anomalySeverity = 'high';
        anomalyNote = `${newRate >= oldRate ? '+₹' : '-₹'}${deltaAbs.toFixed(0)} shift`;
      }
    }
  } else if (type === 'reverse_shipping') {
    if (change.oldFees && change.newFees) {
      const lDelta = Math.abs(change.newFees.local - change.oldFees.local);
      const zDelta = Math.abs(change.newFees.zonal - change.oldFees.zonal);
      const nDelta = Math.abs(change.newFees.national - change.oldFees.national);
      if (lDelta >= 25 || zDelta >= 25 || nDelta >= 25) {
        anomaly = true;
        anomalyType = 'reverse_shipping_shift';
        anomalySeverity = 'high';
        anomalyNote = 'return fee shift ≥₹25';
      }
    }
  } else if (type === 'collection_fee') {
    if (change.prepaidDelta >= 0.02 || change.postpaidDelta >= 0.02 || (change.flatDelta && change.flatDelta >= 15)) {
      anomaly = true;
      anomalyType = 'collection_fee_shift';
      anomalySeverity = 'high';
      anomalyNote = 'collection fee shift';
    }
  }

  if (anomaly) {
    change.anomaly = true;
    change.anomalyType = anomalyType;
    change.anomalySeverity = anomalySeverity;
    if (anomalyNote && !String(change.reason).includes('⚠️ Anomaly')) {
      change.reason = `${change.reason} (⚠️ Anomaly: ${anomalyNote})`;
    }
  } else if (change.anomaly !== true) {
    change.anomaly = false;
    change.anomalyType = null;
    change.anomalySeverity = null;
  }

  return change;
}

/**
 * 6. Detect Changes Against Database (Brand-Aware)
 */
export async function detectBrandRateChanges(brandRateCards, pool = null, options = {}) {
  const p = pool || getDesktopPool();
  const sellerAccount = (typeof options === 'string' ? options : options?.sellerAccount) || 'default';
  const changes = [];
  // Collection fees are category-level: check them once per marketplace/category,
  // not once per brand card in that category.
  const checkedCollectionFeeCategories = new Set();

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
      changes.push(annotateRateAnomaly({
        type: 'commission',
        marketplace,
        category,
        brand,
        sample_fsn: card.sample_fsn,
        reason: 'New category & brand commission profile',
        slabsCount: commissions.length
      }));

      for (const sc of commissions) {
        if (sc.rate >= 0.25) {
          changes.push(annotateRateAnomaly({
            type: 'commission',
            marketplace,
            category,
            brand,
            sample_fsn: card.sample_fsn,
            slab: `₹${sc.price_min} - ₹${sc.price_max}`,
            priceMin: sc.price_min,
            priceMax: sc.price_max,
            oldRate: null,
            newRate: sc.rate,
            reason: 'New commission price slab'
          }));
        }
      }
    } else {
      if (activeCommissions.rows.length !== commissions.length) {
        const countDiff = Math.abs(activeCommissions.rows.length - commissions.length);
        const countChange = {
          type: 'commission',
          marketplace,
          category,
          brand,
          sample_fsn: card.sample_fsn,
          reason: `Commission slab count changed (DB: ${activeCommissions.rows.length}, New: ${commissions.length})`,
          slabsCount: commissions.length
        };
        if (countDiff >= 3) {
          countChange.anomaly = true;
          countChange.anomalyType = 'slab_count_jump';
          countChange.anomalySeverity = 'medium';
          countChange.reason += ` (⚠️ Anomaly: ${countDiff} slab jump)`;
        }
        changes.push(annotateRateAnomaly(countChange));
      }

      for (const sc of commissions) {
        const match = activeCommissions.rows.find(ac =>
          Math.abs(parseFloat(ac.price_min) - sc.price_min) < 0.01 &&
          Math.abs(parseFloat(ac.price_max) - sc.price_max) < 1.0
        );

        if (!match) {
          changes.push(annotateRateAnomaly({
            type: 'commission',
            marketplace,
            category,
            brand,
            sample_fsn: card.sample_fsn,
            slab: `₹${sc.price_min} - ₹${sc.price_max}`,
            priceMin: sc.price_min,
            priceMax: sc.price_max,
            oldRate: null,
            newRate: sc.rate,
            reason: 'New commission price slab'
          }));
        } else if (Math.abs(parseFloat(match.rate) - sc.rate) > 0.0001) {
          changes.push(annotateRateAnomaly({
            type: 'commission',
            marketplace,
            category,
            brand,
            sample_fsn: card.sample_fsn,
            slab: `₹${sc.price_min} - ₹${sc.price_max}`,
            priceMin: sc.price_min,
            priceMax: sc.price_max,
            oldRate: parseFloat(match.rate),
            newRate: sc.rate,
            reason: 'Commission rate percentage modified'
          }));
        }
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
        const countDiff = Math.abs(activeFixed.rows.length - card.fixedFees.length);
        const countChange = {
          type: 'fixed_fee',
          marketplace,
          category,
          brand,
          reason: `Fixed fee slab count changed (DB: ${activeFixed.rows.length}, New: ${card.fixedFees.length})`
        };
        if (countDiff >= 3) {
          countChange.anomaly = true;
          countChange.anomalyType = 'slab_count_jump';
          countChange.anomalySeverity = 'medium';
          countChange.reason += ` (⚠️ Anomaly: ${countDiff} slab jump)`;
        }
        changes.push(annotateRateAnomaly(countChange));
      } else {
        for (const ff of card.fixedFees) {
          const match = activeFixed.rows.find(af =>
            af.fulfilment_type === ff.fulfilment_type &&
            Math.abs(parseFloat(af.price_min) - ff.price_min) < 0.01 &&
            Math.abs(parseFloat(af.price_max) - ff.price_max) < 1.0
          );
          if (!match) {
            changes.push(annotateRateAnomaly({
              type: 'fixed_fee',
              marketplace,
              category,
              brand,
              slab: `${ff.fulfilment_type}: ₹${ff.price_min} - ₹${ff.price_max}`,
              priceMin: ff.price_min,
              priceMax: ff.price_max,
              fulfilmentType: ff.fulfilment_type,
              oldRate: null,
              newRate: ff.rate,
              reason: 'New fixed fee tier/slab'
            }));
          } else if (Math.abs(parseFloat(match.rate) - ff.rate) > 0.01) {
            changes.push(annotateRateAnomaly({
              type: 'fixed_fee',
              marketplace,
              category,
              brand,
              slab: `${ff.fulfilment_type}: ₹${ff.price_min} - ₹${ff.price_max}`,
              priceMin: ff.price_min,
              priceMax: ff.price_max,
              fulfilmentType: ff.fulfilment_type,
              oldRate: parseFloat(match.rate),
              newRate: ff.rate,
              reason: 'Fixed fee rate modified'
            }));
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
        const countDiff = Math.abs(activeRev.rows.length - card.reverseShipping.length);
        const countChange = {
          type: 'reverse_shipping',
          marketplace,
          category,
          brand,
          reason: `Reverse shipping slab count changed (DB: ${activeRev.rows.length}, New: ${card.reverseShipping.length})`
        };
        if (countDiff >= 3) {
          countChange.anomaly = true;
          countChange.anomalyType = 'slab_count_jump';
          countChange.anomalySeverity = 'medium';
          countChange.reason += ` (⚠️ Anomaly: ${countDiff} slab jump)`;
        }
        changes.push(annotateRateAnomaly(countChange));
      } else {
        for (const rs of card.reverseShipping) {
          const match = activeRev.rows.find(ar =>
            ar.weight_slab === rs.weight_slab &&
            Math.abs(parseFloat(ar.price_min) - rs.price_min) < 0.01 &&
            Math.abs(parseFloat(ar.price_max) - rs.price_max) < 1.0
          );
          if (!match) {
            changes.push(annotateRateAnomaly({
              type: 'reverse_shipping',
              marketplace,
              category,
              brand,
              slab: `${rs.weight_slab}: ₹${rs.price_min} - ₹${rs.price_max}`,
              priceMin: rs.price_min,
              priceMax: rs.price_max,
              weightSlab: rs.weight_slab,
              reason: 'New reverse shipping weight/price slab'
            }));
          } else if (
            Math.abs(parseFloat(match.local_fee) - rs.local_fee) > 0.01 ||
            Math.abs(parseFloat(match.zonal_fee) - rs.zonal_fee) > 0.01 ||
            Math.abs(parseFloat(match.national_fee) - rs.national_fee) > 0.01
          ) {
            changes.push(annotateRateAnomaly({
              type: 'reverse_shipping',
              marketplace,
              category,
              brand,
              slab: `${rs.weight_slab}: ₹${rs.price_min} - ₹${rs.price_max}`,
              priceMin: rs.price_min,
              priceMax: rs.price_max,
              weightSlab: rs.weight_slab,
              oldRate: `L: ₹${match.local_fee}, Z: ₹${match.zonal_fee}, N: ₹${match.national_fee}`,
              newRate: `L: ₹${rs.local_fee}, Z: ₹${rs.zonal_fee}, N: ₹${rs.national_fee}`,
              oldFees: { local: parseFloat(match.local_fee), zonal: parseFloat(match.zonal_fee), national: parseFloat(match.national_fee) },
              newFees: { local: rs.local_fee, zonal: rs.zonal_fee, national: rs.national_fee },
              reason: 'Reverse shipping fees modified'
            }));
          }
        }
      }
    }

    // Collection fee differences (compare row count and individual slab values).
    // Staged cards carry these fees and commits write them, so the review must
    // surface any difference instead of silently syncing them.
    if (card.collectionFees && card.collectionFees.length > 0) {
      const collKey = [marketplace, sellerAccount, category].join('|');
      if (!checkedCollectionFeeCategories.has(collKey)) {
        checkedCollectionFeeCategories.add(collKey);
        const activeColl = await p.query(`
          SELECT fulfilment_type, price_min, price_max, prepaid, postpaid, prepaid_type, postpaid_type
          FROM rc_collection_fee
          WHERE marketplace = $1
            AND (seller_account = $3 OR ($3 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
            AND category = $2
            AND end_date IS NULL
        `, [marketplace, category, sellerAccount]);

        const fmtCollFee = (value, type) => (type === 'pct' ? (parseFloat(value) * 100).toFixed(2) + '%' : '₹' + parseFloat(value));
        const collRateLabel = (cf) => 'Prepaid ' + fmtCollFee(cf.prepaid, cf.prepaid_type || 'flat') + ' / Postpaid ' + fmtCollFee(cf.postpaid, cf.postpaid_type || 'flat');

        if (activeColl.rows.length !== card.collectionFees.length) {
          const countDiff = Math.abs(activeColl.rows.length - card.collectionFees.length);
          const countChange = {
            type: 'collection_fee',
            marketplace,
            category,
            brand,
            reason: 'Collection fee slab count changed (DB: ' + activeColl.rows.length + ', New: ' + card.collectionFees.length + ')'
          };
          if (countDiff >= 3) {
            countChange.anomaly = true;
            countChange.anomalyType = 'slab_count_jump';
            countChange.anomalySeverity = 'medium';
            countChange.reason += ` (⚠️ Anomaly: ${countDiff} slab jump)`;
          }
          changes.push(annotateRateAnomaly(countChange));
        } else {
          for (const cf of card.collectionFees) {
            const match = activeColl.rows.find(ac =>
              (ac.fulfilment_type || 'All') === (cf.fulfilment_type || 'All') &&
              Math.abs(parseFloat(ac.price_min) - cf.price_min) < 0.01 &&
              Math.abs(parseFloat(ac.price_max) - cf.price_max) < 1.0
            );
            const slab = '₹' + cf.price_min + ' - ₹' + cf.price_max;
            if (!match) {
              changes.push(annotateRateAnomaly({
                type: 'collection_fee',
                marketplace,
                category,
                brand,
                slab,
                priceMin: cf.price_min,
                priceMax: cf.price_max,
                newRate: collRateLabel(cf),
                reason: 'New collection fee slab'
              }));
            } else if (
              Math.abs(parseFloat(match.prepaid) - cf.prepaid) > 0.0001 ||
              Math.abs(parseFloat(match.postpaid) - cf.postpaid) > 0.0001 ||
              (match.prepaid_type || 'flat') !== (cf.prepaid_type || 'flat') ||
              (match.postpaid_type || 'flat') !== (cf.postpaid_type || 'flat')
            ) {
              const prepaidDelta = (cf.prepaid_type === 'pct') ? Math.abs(cf.prepaid - parseFloat(match.prepaid)) : 0;
              const postpaidDelta = (cf.postpaid_type === 'pct') ? Math.abs(cf.postpaid - parseFloat(match.postpaid)) : 0;
              const prepaidFlatDelta = (cf.prepaid_type === 'flat') ? Math.abs(cf.prepaid - parseFloat(match.prepaid)) : 0;
              const postpaidFlatDelta = (cf.postpaid_type === 'flat') ? Math.abs(cf.postpaid - parseFloat(match.postpaid)) : 0;
              const flatDelta = Math.max(prepaidFlatDelta, postpaidFlatDelta);
              changes.push(annotateRateAnomaly({
                type: 'collection_fee',
                marketplace,
                category,
                brand,
                slab,
                priceMin: cf.price_min,
                priceMax: cf.price_max,
                oldRate: collRateLabel(match),
                newRate: collRateLabel(cf),
                prepaidDelta,
                postpaidDelta,
                flatDelta,
                reason: 'Collection fee modified'
              }));
            }
          }
        }
      }
    }
  }

  return changes;
}

/**
 * The day a sync takes effect: an explicit option wins, then the staged
 * extraction's scrape date (a review committed after midnight must not shift
 * the rates to the wrong day), then today.
 */
export function resolveSyncEffectiveDate(options = {}, brandRateCards = []) {
  const requested = String(options?.effectiveDate || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(requested)) return requested;
  const staged = String((Array.isArray(brandRateCards) ? brandRateCards.find(card => card?.effectiveDate) : null)?.effectiveDate || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(staged)) return staged;
  return new Date().toISOString().slice(0, 10);
}

/**
 * 7. Synchronize Brand-Wise Rate Cards to Database with automatic period closure
 */
export async function syncBrandRateCardsToDatabase(brandRateCards, options = {}, pool = null) {
  const p = pool || getDesktopPool();
  const {
    forceUpdate = false,
    sellerAccount = 'default'
  } = options;
  // Committed under the day the rates were observed (the staged scrape date),
  // never silently shifted by a review that runs past midnight.
  const effectiveDate = resolveSyncEffectiveDate(options, brandRateCards);

  const changes = await detectBrandRateChanges(brandRateCards, p, { sellerAccount });

  if (changes.length === 0) {
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
    let insertedCollection = 0;
    const processedFixedFeeCategories = new Set();
    const processedRevShippingCategories = new Set();
    const processedCollectionFeeCategories = new Set();

    for (const card of brandRateCards) {
      const { marketplace, category, brand, commissions, fixedFees, reverseShipping } = card;
      const brandVal = brand === 'General' ? null : brand;

      // 1. Commission Sync with brand_name
      if (commissions.length > 0) {
        await client.query(`
          DELETE FROM rc_commission 
          WHERE marketplace = $1 
            AND (seller_account = $2 OR ($2 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
            AND category = $3 
            AND (brand_name = $4 OR ($4 = 'General' AND (brand_name IS NULL OR brand_name = 'All brands' OR brand_name = 'General')) OR ($4 IS NULL AND (brand_name IS NULL OR brand_name = 'All brands' OR brand_name = 'General')))
            AND start_date >= $5::date 
            AND end_date IS NULL
        `, [marketplace, sellerAccount, category, brandVal, effectiveDate]);

        await client.query(`
          UPDATE rc_commission 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 
            AND (seller_account = $3 OR ($3 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
            AND category = $4 
            AND (brand_name = $5 OR ($5 = 'General' AND (brand_name IS NULL OR brand_name = 'All brands' OR brand_name = 'General')) OR ($5 IS NULL AND (brand_name IS NULL OR brand_name = 'All brands' OR brand_name = 'General')))
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
            AND (seller_account = $2 OR ($2 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
            AND category = $3 
            AND start_date >= $4::date 
            AND end_date IS NULL
        `, [marketplace, sellerAccount, category, effectiveDate]);

        await client.query(`
          UPDATE rc_fixed_fee 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 
            AND (seller_account = $3 OR ($3 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
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
            AND (seller_account = $2 OR ($2 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
            AND category = $3 
            AND start_date >= $4::date 
            AND end_date IS NULL
        `, [marketplace, sellerAccount, category, effectiveDate]);

        await client.query(`
          UPDATE rc_reverse_shipping 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 
            AND (seller_account = $3 OR ($3 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
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

      // 4. Collection Fee Sync (category-level, same period-closure rules)
      const collectionFees = card.collectionFees || [];
      const collKey = `${marketplace}_${sellerAccount}_${category}`;
      if (!processedCollectionFeeCategories.has(collKey) && collectionFees.length > 0) {
        processedCollectionFeeCategories.add(collKey);

        await client.query(`
          DELETE FROM rc_collection_fee 
          WHERE marketplace = $1 
            AND (seller_account = $2 OR ($2 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
            AND category = $3 
            AND start_date >= $4::date 
            AND end_date IS NULL
        `, [marketplace, sellerAccount, category, effectiveDate]);

        await client.query(`
          UPDATE rc_collection_fee 
          SET end_date = $1::date, updated_at = NOW() 
          WHERE marketplace = $2 
            AND (seller_account = $3 OR ($3 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
            AND category = $4 
            AND start_date < $5::date
            AND (end_date IS NULL OR end_date >= $5::date)
        `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);

        for (const cf of collectionFees) {
          await client.query(`
            INSERT INTO rc_collection_fee (
              marketplace, seller_account, category, fulfilment_type, price_min, price_max,
              prepaid, postpaid, prepaid_type, postpaid_type, start_date, end_date, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, NULL, NOW()
            )
          `, [
            marketplace, sellerAccount, category, cf.fulfilment_type || 'All', cf.price_min, cf.price_max,
            cf.prepaid, cf.postpaid, cf.prepaid_type, cf.postpaid_type, effectiveDate
          ]);
          insertedCollection++;
        }
      }
    }

    // Rich audit snapshot for rate_card_versions
    const versionName = `brand-fsn-sync-${effectiveDate}-${Date.now().toString().slice(-4)}`;
    const actor = options.actor || 'desktop-operator';
    const runMetadata = options.runMetadata || { source: 'desktop-worker' };
    const anomaliesCount = changes.filter(c => c.anomaly).length;

    const richSnapshot = {
      version: getDesktopAppVersion(),
      syncTimestamp: new Date().toISOString(),
      effectiveDate,
      sellerAccount,
      actor,
      runMetadata,
      stats: {
        changesCount: changes.length,
        anomaliesCount,
        brandsCount: brandRateCards.length,
        insertedCommissions,
        insertedFixed,
        insertedRev,
        insertedCollection
      },
      summary: {
        commissionChanges: changes.filter(c => c.type === 'commission').length,
        fixedFeeChanges: changes.filter(c => c.type === 'fixed_fee').length,
        reverseShippingChanges: changes.filter(c => c.type === 'reverse_shipping').length,
        collectionFeeChanges: changes.filter(c => c.type === 'collection_fee').length,
        anomalies: changes.filter(c => c.anomaly).map(c => ({
          type: c.type,
          marketplace: c.marketplace,
          category: c.category,
          brand: c.brand,
          slab: c.slab,
          oldRate: c.oldRate,
          newRate: c.newRate,
          anomalyType: c.anomalyType,
          anomalySeverity: c.anomalySeverity,
          reason: c.reason
        }))
      },
      changes: changes.map(c => ({
        type: c.type,
        marketplace: c.marketplace,
        category: c.category,
        brand: c.brand,
        slab: c.slab,
        oldRate: c.oldRate,
        newRate: c.newRate,
        reason: c.reason,
        anomaly: Boolean(c.anomaly),
        anomalyType: c.anomalyType || null,
        anomalySeverity: c.anomalySeverity || null
      }))
    };

    await client.query(`
      INSERT INTO rate_card_versions (marketplace, seller_account, version_name, status, effective_from, snapshot, created_at, published_at)
      VALUES ('flipkart_shopsy_brandwise', $1, $2, 'published', $3, $4, NOW(), NOW())
    `, [sellerAccount, versionName, effectiveDate, JSON.stringify(richSnapshot)]);

    await client.query('COMMIT');

    return {
      updated: true,
      message: `Successfully synchronized ${brandRateCards.length} brand-wise rate cards across Flipkart and Shopsy.`,
      changesCount: changes.length,
      anomaliesCount,
      insertedCommissions,
      insertedFixed,
      insertedRev,
      insertedCollection,
      versionName,
      snapshot: richSnapshot
    };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
