/**
 * Rate Card Canonical Change Detection Engine
 * 
 * Compares scraped observations against active published rate card records
 * in rc_commission, rc_fixed_fee, rc_collection_fee, rc_reverse_shipping.
 * 
 * Strict Zero-Change Invariant:
 * When scraped rates are numerically identical to active DB rates, returns
 * hasChanges = false and diffCount = 0. No records are touched.
 */
import { getPool } from '../db/index.js';

const EPSILON_RATE = 0.0001; // For commission rates (0.15 = 15%)
const EPSILON_FEE = 0.01;    // For currency values in INR

function roundCurrency(val) {
  return Math.round((Number(val) || 0) * 100) / 100;
}

function roundRate(val) {
  return Math.round((Number(val) || 0) * 10000) / 10000;
}

export async function compareScrapedRatesWithActive(observations, options = {}) {
  const {
    marketplace = 'flipkart',
    sellerAccount = 'default',
    effectiveDate = new Date().toISOString().slice(0, 10),
    dbClient = null
  } = options;

  const pool = dbClient || getPool();
  const diffs = [];
  let totalObserved = 0;
  let unchangedCount = 0;
  let addedCount = 0;
  let modifiedCount = 0;
  let anomalyCount = 0;

  for (const obs of observations) {
    const category = obs.vertical || obs.category;
    if (!category) continue;

    // 1. Commission comparison
    const activeCommissions = await pool.query(`
      SELECT id, category, COALESCE(brand_name, '') AS brand_name, price_min, price_max, rate
      FROM rc_commission
      WHERE marketplace = $1 AND seller_account = $2 AND category = $3 AND end_date IS NULL
    `, [marketplace, sellerAccount, category]);

    const scrapedComms = obs.commissions || [];
    for (const sc of scrapedComms) {
      totalObserved++;
      const scBrand = String(sc.brand_name || '').trim();
      const scMin = roundCurrency(sc.price_min);
      const scMax = roundCurrency(sc.price_max);
      const scRate = roundRate(sc.rate);

      const match = activeCommissions.rows.find(ac =>
        String(ac.brand_name || '').trim() === scBrand &&
        Math.abs(roundCurrency(ac.price_min) - scMin) < EPS_SLAB(scMin) &&
        Math.abs(roundCurrency(ac.price_max) - scMax) < 1.0
      );

      if (!match) {
        addedCount++;
        diffs.push({
          table: 'rc_commission',
          category,
          brand_name: scBrand || null,
          slab: `₹${scMin} - ₹${scMax}`,
          fulfilment_type: null,
          changeType: 'ADDED',
          oldRate: null,
          newRate: scRate,
          anomaly: false,
          details: `New commission slab: ${scRate * 100}%`
        });
      } else {
        const oldRate = roundRate(match.rate);
        if (Math.abs(oldRate - scRate) > EPSILON_RATE) {
          modifiedCount++;
          const rateChangePct = oldRate > 0 ? Math.abs((scRate - oldRate) / oldRate) * 100 : 100;
          const isAnomaly = rateChangePct >= 50.0;
          if (isAnomaly) anomalyCount++;

          diffs.push({
            table: 'rc_commission',
            category,
            brand_name: scBrand || null,
            slab: `₹${scMin} - ₹${scMax}`,
            fulfilment_type: null,
            changeType: 'MODIFIED',
            oldRate,
            newRate: scRate,
            anomaly: isAnomaly,
            details: `Commission rate changed from ${(oldRate * 100).toFixed(2)}% to ${(scRate * 100).toFixed(2)}%`
          });
        } else {
          unchangedCount++;
        }
      }
    }

    // 2. Fixed Fee comparison
    const activeFixedFees = await pool.query(`
      SELECT id, category, COALESCE(fulfilment_type, '') AS fulfilment_type, price_min, price_max, rate
      FROM rc_fixed_fee
      WHERE marketplace = $1 AND seller_account = $2 AND category = $3 AND end_date IS NULL
    `, [marketplace, sellerAccount, category]);

    const scrapedFixed = obs.fixedFees || [];
    for (const sf of scrapedFixed) {
      totalObserved++;
      const sfType = String(sf.fulfilment_type || '').trim();
      const sfMin = roundCurrency(sf.price_min);
      const sfMax = roundCurrency(sf.price_max);
      const sfRate = roundCurrency(sf.rate);

      const match = activeFixedFees.rows.find(af =>
        String(af.fulfilment_type || '').trim().toLowerCase() === sfType.toLowerCase() &&
        Math.abs(roundCurrency(af.price_min) - sfMin) < EPS_SLAB(sfMin) &&
        Math.abs(roundCurrency(af.price_max) - sfMax) < 1.0
      );

      if (!match) {
        addedCount++;
        diffs.push({
          table: 'rc_fixed_fee',
          category,
          brand_name: null,
          fulfilment_type: sfType || null,
          slab: `₹${sfMin} - ₹${sfMax}`,
          changeType: 'ADDED',
          oldRate: null,
          newRate: sfRate,
          anomaly: false,
          details: `New fixed fee slab (${sfType}): ₹${sfRate}`
        });
      } else {
        const oldRate = roundCurrency(match.rate);
        if (Math.abs(oldRate - sfRate) > EPSILON_FEE) {
          modifiedCount++;
          const feeChangePct = oldRate > 0 ? Math.abs((sfRate - oldRate) / oldRate) * 100 : 100;
          const isAnomaly = feeChangePct >= 50.0;
          if (isAnomaly) anomalyCount++;

          diffs.push({
            table: 'rc_fixed_fee',
            category,
            brand_name: null,
            fulfilment_type: sfType || null,
            slab: `₹${sfMin} - ₹${sfMax}`,
            changeType: 'MODIFIED',
            oldRate,
            newRate: sfRate,
            anomaly: isAnomaly,
            details: `Fixed fee changed from ₹${oldRate} to ₹${sfRate}`
          });
        } else {
          unchangedCount++;
        }
      }
    }

    // 3. Collection Fee comparison
    const activeCollFees = await pool.query(`
      SELECT id, category, COALESCE(fulfilment_type, '') AS fulfilment_type, price_min, price_max, prepaid, postpaid
      FROM rc_collection_fee
      WHERE marketplace = $1 AND seller_account = $2 AND category = $3 AND end_date IS NULL
    `, [marketplace, sellerAccount, category]);

    const scrapedColl = obs.collectionFees || [];
    for (const scf of scrapedColl) {
      totalObserved++;
      const scfType = String(scf.fulfilment_type || '').trim();
      const scfMin = roundCurrency(scf.price_min);
      const scfMax = roundCurrency(scf.price_max);
      const scfPrepaid = roundCurrency(scf.prepaid);
      const scfPostpaid = roundCurrency(scf.postpaid);

      const match = activeCollFees.rows.find(acf =>
        String(acf.fulfilment_type || '').trim().toLowerCase() === scfType.toLowerCase() &&
        Math.abs(roundCurrency(acf.price_min) - scfMin) < EPS_SLAB(scfMin) &&
        Math.abs(roundCurrency(acf.price_max) - scfMax) < 1.0
      );

      if (!match) {
        addedCount++;
        diffs.push({
          table: 'rc_collection_fee',
          category,
          brand_name: null,
          fulfilment_type: scfType || null,
          slab: `₹${scfMin} - ₹${scfMax}`,
          changeType: 'ADDED',
          oldRate: null,
          newRate: `Prepaid: ${scfPrepaid}, Postpaid: ${scfPostpaid}`,
          anomaly: false,
          details: `New collection fee slab: Prepaid ₹${scfPrepaid}, Postpaid ₹${scfPostpaid}`
        });
      } else {
        const oldPrepaid = roundCurrency(match.prepaid);
        const oldPostpaid = roundCurrency(match.postpaid);
        if (Math.abs(oldPrepaid - scfPrepaid) > EPSILON_FEE || Math.abs(oldPostpaid - scfPostpaid) > EPSILON_FEE) {
          modifiedCount++;
          diffs.push({
            table: 'rc_collection_fee',
            category,
            brand_name: null,
            fulfilment_type: scfType || null,
            slab: `₹${scfMin} - ₹${scfMax}`,
            changeType: 'MODIFIED',
            oldRate: `Prepaid: ${oldPrepaid}, Postpaid: ${oldPostpaid}`,
            newRate: `Prepaid: ${scfPrepaid}, Postpaid: ${scfPostpaid}`,
            anomaly: false,
            details: `Collection fee changed from P:₹${oldPrepaid}/Po:₹${oldPostpaid} to P:₹${scfPrepaid}/Po:₹${scfPostpaid}`
          });
        } else {
          unchangedCount++;
        }
      }
    }

    // 4. Reverse Shipping comparison
    const activeRevShip = await pool.query(`
      SELECT id, category, COALESCE(weight_slab, '') AS weight_slab, price_min, price_max, local_fee, zonal_fee, national_fee
      FROM rc_reverse_shipping
      WHERE marketplace = $1 AND seller_account = $2 AND category = $3 AND end_date IS NULL
    `, [marketplace, sellerAccount, category]);

    const scrapedRev = obs.reverseShipping || [];
    for (const srv of scrapedRev) {
      totalObserved++;
      const srvSlab = String(srv.weight_slab || '').trim().replace(/\s+/g, '');
      const srvMin = roundCurrency(srv.price_min);
      const srvMax = roundCurrency(srv.price_max);
      const srvLoc = roundCurrency(srv.local_fee);
      const srvZon = roundCurrency(srv.zonal_fee);
      const srvNat = roundCurrency(srv.national_fee);

      const match = activeRevShip.rows.find(ars =>
        String(ars.weight_slab || '').trim().replace(/\s+/g, '').toLowerCase() === srvSlab.toLowerCase() &&
        Math.abs(roundCurrency(ars.price_min) - srvMin) < EPS_SLAB(srvMin) &&
        Math.abs(roundCurrency(ars.price_max) - srvMax) < 1.0
      );

      if (!match) {
        addedCount++;
        diffs.push({
          table: 'rc_reverse_shipping',
          category,
          brand_name: null,
          fulfilment_type: null,
          slab: `${srvSlab} (₹${srvMin} - ₹${srvMax})`,
          changeType: 'ADDED',
          oldRate: null,
          newRate: `L: ₹${srvLoc}, Z: ₹${srvZon}, N: ₹${srvNat}`,
          anomaly: false,
          details: `New reverse shipping slab: Local ₹${srvLoc}, Zonal ₹${srvZon}, National ₹${srvNat}`
        });
      } else {
        const oldLoc = roundCurrency(match.local_fee);
        const oldZon = roundCurrency(match.zonal_fee);
        const oldNat = roundCurrency(match.national_fee);
        const feeChanged = Math.abs(oldLoc - srvLoc) > EPSILON_FEE ||
                           Math.abs(oldZon - srvZon) > EPSILON_FEE ||
                           Math.abs(oldNat - srvNat) > EPSILON_FEE;

        if (feeChanged) {
          modifiedCount++;
          diffs.push({
            table: 'rc_reverse_shipping',
            category,
            brand_name: null,
            fulfilment_type: null,
            slab: `${srvSlab} (₹${srvMin} - ₹${srvMax})`,
            changeType: 'MODIFIED',
            oldRate: `L: ₹${oldLoc}, Z: ₹${oldZon}, N: ₹${oldNat}`,
            newRate: `L: ₹${srvLoc}, Z: ₹${srvZon}, N: ₹${srvNat}`,
            anomaly: false,
            details: `Reverse shipping rates changed`
          });
        } else {
          unchangedCount++;
        }
      }
    }
  }

  const hasChanges = diffs.length > 0;
  return {
    hasChanges,
    diffCount: diffs.length,
    diffs,
    summary: {
      totalObserved,
      unchanged: unchangedCount,
      modified: modifiedCount,
      added: addedCount,
      anomalies: anomalyCount
    }
  };
}

function EPS_SLAB(min) {
  return min === 0 ? 0.05 : 1.05;
}

