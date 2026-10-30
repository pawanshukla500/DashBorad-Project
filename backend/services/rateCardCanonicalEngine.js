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
const EPSILON_FEE = 0.005;   // Half a paisa (detects any >= 1 paisa / 0.01 fee shift)

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

  const client = dbClient || await getPool().connect();
  const shouldRelease = !dbClient;

  try {
    // Fetch all active published rate card records for this marketplace + seller_account
    const [commRows, fixedRows, collRows, revRows] = await Promise.all([
      client.query(`
        SELECT category, brand_name, start_date, end_date, price_min, price_max, rate
        FROM rc_commission
        WHERE marketplace = $1 AND seller_account = $2
          AND (end_date IS NULL OR end_date >= $3)
      `, [marketplace, sellerAccount, effectiveDate]),

      client.query(`
        SELECT category, fulfilment_type, start_date, end_date, price_min, price_max, rate
        FROM rc_fixed_fee
        WHERE marketplace = $1 AND seller_account = $2
          AND (end_date IS NULL OR end_date >= $3)
      `, [marketplace, sellerAccount, effectiveDate]),

      client.query(`
        SELECT category, fulfilment_type, start_date, end_date, price_min, price_max, prepaid, postpaid, prepaid_type, postpaid_type
        FROM rc_collection_fee
        WHERE marketplace = $1 AND seller_account = $2
          AND (end_date IS NULL OR end_date >= $3)
      `, [marketplace, sellerAccount, effectiveDate]),

      client.query(`
        SELECT category, weight_slab, start_date, end_date, price_min, price_max, local_fee, zonal_fee, national_fee
        FROM rc_reverse_shipping
        WHERE marketplace = $1 AND seller_account = $2
          AND (end_date IS NULL OR end_date >= $3)
      `, [marketplace, sellerAccount, effectiveDate])
    ]);

    const activeCommissions = commRows.rows;
    const activeFixedFees = fixedRows.rows;
    const activeCollFees = collRows.rows;
    const activeRevShipping = revRows.rows;

    const diffs = [];
    let addedCount = 0;
    let modifiedCount = 0;
    let unchangedCount = 0;

    for (const obs of observations) {
      const category = obs.vertical || obs.category;
      if (!category) continue;

      // ── 1. Check Commission Slabs ──────────────────────────────────────────
      const scrapedComms = obs.commissions || [];
      const dbComms = activeCommissions.filter(c => c.category === category);

      for (const sc of scrapedComms) {
        const scMin = roundCurrency(sc.price_min || 0);
        const scMax = roundCurrency(sc.price_max || 999999);
        const scRate = roundRate(sc.rate);
        const scBrand = sc.brand_name || null;

        const match = dbComms.find(c =>
          roundCurrency(c.price_min) === scMin &&
          roundCurrency(c.price_max) === scMax &&
          (c.brand_name || null) === scBrand
        );

        if (!match) {
          addedCount++;
          diffs.push({
            table: 'rc_commission',
            category,
            brand_name: scBrand,
            fulfilment_type: null,
            slab: `₹${scMin} - ₹${scMax}`,
            changeType: 'ADDED',
            oldRate: null,
            newRate: scRate,
            anomaly: false,
            details: `New commission slab: ${(scRate * 100).toFixed(2)}%`
          });
        } else {
          const oldRate = roundRate(match.rate);
          const rateDiff = Math.abs(oldRate - scRate);
          if (rateDiff >= EPSILON_RATE) {
            modifiedCount++;
            const pctShift = oldRate > 0 ? (rateDiff / oldRate) * 100 : 100;
            const isAnomaly = rateDiff >= 0.05 || pctShift >= 50;

            diffs.push({
              table: 'rc_commission',
              category,
              brand_name: scBrand,
              fulfilment_type: null,
              slab: `₹${scMin} - ₹${scMax}`,
              changeType: 'MODIFIED',
              oldRate: oldRate,
              newRate: scRate,
              anomaly: isAnomaly,
              details: `Commission changed from ${(oldRate * 100).toFixed(2)}% to ${(scRate * 100).toFixed(2)}% (shift: ${pctShift.toFixed(1)}%)`
            });
          } else {
            unchangedCount++;
          }
        }
      }

      // ── 2. Check Fixed Fee Slabs ───────────────────────────────────────────
      const scrapedFixed = obs.fixedFees || [];
      const dbFixed = activeFixedFees.filter(f => f.category === category);

      for (const sf of scrapedFixed) {
        const sfMin = roundCurrency(sf.price_min || 0);
        const sfMax = roundCurrency(sf.price_max || 999999);
        const sfRate = roundCurrency(sf.rate);
        const sfType = sf.fulfilment_type || 'All';

        const match = dbFixed.find(f =>
          roundCurrency(f.price_min) === sfMin &&
          roundCurrency(f.price_max) === sfMax &&
          (f.fulfilment_type || 'All').toLowerCase() === sfType.toLowerCase()
        );

        if (!match) {
          addedCount++;
          diffs.push({
            table: 'rc_fixed_fee',
            category,
            brand_name: null,
            fulfilment_type: sfType,
            slab: `₹${sfMin} - ₹${sfMax}`,
            changeType: 'ADDED',
            oldRate: null,
            newRate: sfRate,
            anomaly: false,
            details: `New fixed fee slab (${sfType}): ₹${sfRate}`
          });
        } else {
          const oldRate = roundCurrency(match.rate);
          if (Math.abs(oldRate - sfRate) >= EPSILON_FEE) {
            modifiedCount++;
            const feeDiff = Math.abs(oldRate - sfRate);
            const isAnomaly = oldRate > 0 && (feeDiff / oldRate) >= 0.5;

            diffs.push({
              table: 'rc_fixed_fee',
              category,
              brand_name: null,
              fulfilment_type: sfType,
              slab: `₹${sfMin} - ₹${sfMax}`,
              changeType: 'MODIFIED',
              oldRate: oldRate,
              newRate: sfRate,
              anomaly: isAnomaly,
              details: `Fixed fee (${sfType}) changed from ₹${oldRate} to ₹${sfRate}`
            });
          } else {
            unchangedCount++;
          }
        }
      }

      // ── 3. Check Collection Fee Slabs ──────────────────────────────────────
      const scrapedColl = obs.collectionFees || [];
      const dbColl = activeCollFees.filter(c => c.category === category);

      for (const scf of scrapedColl) {
        const scfMin = roundCurrency(scf.price_min || 0);
        const scfMax = roundCurrency(scf.price_max || 999999);
        const scfPrepaid = roundCurrency(scf.prepaid);
        const scfPostpaid = roundCurrency(scf.postpaid);
        const scfType = scf.fulfilment_type || 'All';

        const match = dbColl.find(c =>
          roundCurrency(c.price_min) === scfMin &&
          roundCurrency(c.price_max) === scfMax &&
          (c.fulfilment_type || 'All').toLowerCase() === scfType.toLowerCase()
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
          if (Math.abs(oldPrepaid - scfPrepaid) >= EPSILON_FEE || Math.abs(oldPostpaid - scfPostpaid) >= EPSILON_FEE) {
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

      // ── 4. Check Reverse Shipping Slabs ────────────────────────────────────
      const scrapedRev = obs.reverseShipping || [];
      const dbRev = activeRevShipping.filter(r => r.category === category);

      for (const srv of scrapedRev) {
        const srvSlab = (srv.weight_slab || '0kg-0.5kg').toLowerCase();
        const srvLoc = roundCurrency(srv.local_fee);
        const srvZon = roundCurrency(srv.zonal_fee);
        const srvNat = roundCurrency(srv.national_fee);

        const match = dbRev.find(r =>
          (r.weight_slab || '0kg-0.5kg').toLowerCase() === srvSlab
        );

        if (!match) {
          addedCount++;
          diffs.push({
            table: 'rc_reverse_shipping',
            category,
            brand_name: null,
            fulfilment_type: null,
            slab: srvSlab,
            changeType: 'ADDED',
            oldRate: null,
            newRate: `L:₹${srvLoc}/Z:₹${srvZon}/N:₹${srvNat}`,
            anomaly: false,
            details: `New reverse shipping slab ${srvSlab}`
          });
        } else {
          const oldLoc = roundCurrency(match.local_fee);
          const oldZon = roundCurrency(match.zonal_fee);
          const oldNat = roundCurrency(match.national_fee);

          const feeChanged = Math.abs(oldLoc - srvLoc) >= EPSILON_FEE ||
                             Math.abs(oldZon - srvZon) >= EPSILON_FEE ||
                             Math.abs(oldNat - srvNat) >= EPSILON_FEE;

          if (feeChanged) {
            modifiedCount++;
            diffs.push({
              table: 'rc_reverse_shipping',
              category,
              brand_name: null,
              fulfilment_type: null,
              slab: srvSlab,
              changeType: 'MODIFIED',
              oldRate: `L:₹${oldLoc}/Z:₹${oldZon}/N:₹${oldNat}`,
              newRate: `L:₹${srvLoc}/Z:₹${srvZon}/N:₹${srvNat}`,
              anomaly: false,
              details: `Reverse shipping ${srvSlab} changed from L:₹${oldLoc}/Z:₹${oldZon}/N:₹${oldNat} to L:₹${srvLoc}/Z:₹${srvZon}/N:₹${srvNat}`
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
        added: addedCount,
        modified: modifiedCount,
        unchanged: unchangedCount,
        anomalies: diffs.filter(d => d.anomaly).length,
        totalChecked: addedCount + modifiedCount + unchangedCount
      }
    };
  } finally {
    if (shouldRelease) client.release();
  }
}
