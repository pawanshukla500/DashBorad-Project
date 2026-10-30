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

export function roundCurrency(val) {
  return Math.round((Number(val) || 0) * 100) / 100;
}

export function roundRate(val) {
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
    // Strictly filter start_date <= effectiveDate to avoid matching future-dated records.
    const [commRows, fixedRows, collRows, revRows] = await Promise.all([
      client.query(`
        SELECT category, brand_name, start_date, end_date, price_min, price_max, rate
        FROM rc_commission
        WHERE marketplace = $1 AND seller_account = $2
          AND start_date <= $3 AND (end_date IS NULL OR end_date >= $3)
      `, [marketplace, sellerAccount, effectiveDate]),

      client.query(`
        SELECT category, fulfilment_type, start_date, end_date, price_min, price_max, rate
        FROM rc_fixed_fee
        WHERE marketplace = $1 AND seller_account = $2
          AND start_date <= $3 AND (end_date IS NULL OR end_date >= $3)
      `, [marketplace, sellerAccount, effectiveDate]),

      client.query(`
        SELECT category, fulfilment_type, start_date, end_date, price_min, price_max, prepaid, postpaid, prepaid_type, postpaid_type
        FROM rc_collection_fee
        WHERE marketplace = $1 AND seller_account = $2
          AND start_date <= $3 AND (end_date IS NULL OR end_date >= $3)
      `, [marketplace, sellerAccount, effectiveDate]),

      client.query(`
        SELECT category, weight_slab, start_date, end_date, price_min, price_max, local_fee, zonal_fee, national_fee
        FROM rc_reverse_shipping
        WHERE marketplace = $1 AND seller_account = $2
          AND start_date <= $3 AND (end_date IS NULL OR end_date >= $3)
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
      const obsBrand = obs.brand || obs.brand_name || null;
      // If observation specifies a brand, compare against that brand's rules in DB.
      // If observation is generic (no brand), compare only against generic DB rules (c.brand_name is null/empty).
      // This ensures generic portal scrapes do not mistakenly report named brand rates as "removed".
      const dbComms = activeCommissions.filter(c => {
        if (c.category !== category) return false;
        if (obsBrand) return (c.brand_name || null) === obsBrand;
        return !c.brand_name;
      });
      const matchedDbCommIdxs = new Set();

      for (const sc of scrapedComms) {
        const scMin = roundCurrency(sc.price_min || 0);
        const scMax = roundCurrency(sc.price_max || 999999);
        const scRate = roundRate(sc.rate);
        const scBrand = sc.brand_name || obsBrand || null;

        const matchIdx = dbComms.findIndex(c =>
          roundCurrency(c.price_min) === scMin &&
          roundCurrency(c.price_max) === scMax &&
          (c.brand_name || null) === scBrand
        );

        if (matchIdx === -1) {
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
          matchedDbCommIdxs.add(matchIdx);
          const match = dbComms[matchIdx];
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

      // Check for removed commission slabs
      if (scrapedComms.length > 0) {
        dbComms.forEach((c, idx) => {
          if (!matchedDbCommIdxs.has(idx)) {
            modifiedCount++;
            diffs.push({
              table: 'rc_commission',
              category,
              brand_name: c.brand_name || null,
              fulfilment_type: null,
              slab: `₹${roundCurrency(c.price_min)} - ₹${roundCurrency(c.price_max)}`,
              changeType: 'REMOVED',
              oldRate: roundRate(c.rate),
              newRate: null,
              anomaly: false,
              details: `Commission slab removed from rate card (previously ${(roundRate(c.rate) * 100).toFixed(2)}%)`
            });
          }
        });
      }

      // ── 2. Check Fixed Fee Slabs ───────────────────────────────────────────
      const scrapedFixed = obs.fixedFees || [];
      const dbFixed = activeFixedFees.filter(f => f.category === category);
      const matchedDbFixedIdxs = new Set();

      for (const sf of scrapedFixed) {
        const sfMin = roundCurrency(sf.price_min || 0);
        const sfMax = roundCurrency(sf.price_max || 999999);
        const sfRate = roundCurrency(sf.rate);
        const sfType = sf.fulfilment_type || 'All';

        const matchIdx = dbFixed.findIndex(f =>
          roundCurrency(f.price_min) === sfMin &&
          roundCurrency(f.price_max) === sfMax &&
          (f.fulfilment_type || 'All').toLowerCase() === sfType.toLowerCase()
        );

        if (matchIdx === -1) {
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
          matchedDbFixedIdxs.add(matchIdx);
          const match = dbFixed[matchIdx];
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

      // Check for removed fixed fee slabs
      if (scrapedFixed.length > 0) {
        dbFixed.forEach((f, idx) => {
          if (!matchedDbFixedIdxs.has(idx)) {
            modifiedCount++;
            diffs.push({
              table: 'rc_fixed_fee',
              category,
              brand_name: null,
              fulfilment_type: f.fulfilment_type || 'All',
              slab: `₹${roundCurrency(f.price_min)} - ₹${roundCurrency(f.price_max)}`,
              changeType: 'REMOVED',
              oldRate: roundCurrency(f.rate),
              newRate: null,
              anomaly: false,
              details: `Fixed fee slab (${f.fulfilment_type || 'All'}) removed from rate card`
            });
          }
        });
      }

      // ── 3. Check Collection Fee Slabs ──────────────────────────────────────
      const scrapedColl = obs.collectionFees || [];
      const dbColl = activeCollFees.filter(c => c.category === category);
      const matchedDbCollIdxs = new Set();

      for (const scf of scrapedColl) {
        const scfMin = roundCurrency(scf.price_min || 0);
        const scfMax = roundCurrency(scf.price_max || 999999);
        const scfType = scf.fulfilment_type || 'All';
        const scfPrepaidType = (scf.prepaid_type || 'pct').toLowerCase() === 'pct' ? 'pct' : 'flat';
        const scfPostpaidType = (scf.postpaid_type || 'flat').toLowerCase() === 'pct' ? 'pct' : 'flat';
        const scfPrepaid = scfPrepaidType === 'pct' ? roundRate(scf.prepaid) : roundCurrency(scf.prepaid);
        const scfPostpaid = scfPostpaidType === 'pct' ? roundRate(scf.postpaid) : roundCurrency(scf.postpaid);

        const matchIdx = dbColl.findIndex(c =>
          roundCurrency(c.price_min) === scfMin &&
          roundCurrency(c.price_max) === scfMax &&
          (c.fulfilment_type || 'All').toLowerCase() === scfType.toLowerCase()
        );

        if (matchIdx === -1) {
          addedCount++;
          diffs.push({
            table: 'rc_collection_fee',
            category,
            brand_name: null,
            fulfilment_type: scfType || null,
            slab: `₹${scfMin} - ₹${scfMax}`,
            changeType: 'ADDED',
            oldRate: null,
            newRate: `Prepaid: ${scfPrepaid}${scfPrepaidType === 'pct' ? '%' : ''}, Postpaid: ${scfPostpaid}${scfPostpaidType === 'pct' ? '%' : ''}`,
            anomaly: false,
            details: `New collection fee slab: Prepaid ${scfPrepaid}${scfPrepaidType === 'pct' ? '%' : ''}, Postpaid ${scfPostpaid}${scfPostpaidType === 'pct' ? '%' : ''}`
          });
        } else {
          matchedDbCollIdxs.add(matchIdx);
          const match = dbColl[matchIdx];
          const dbPrepaidType = (match.prepaid_type || 'pct').toLowerCase() === 'pct' ? 'pct' : 'flat';
          const dbPostpaidType = (match.postpaid_type || 'flat').toLowerCase() === 'pct' ? 'pct' : 'flat';
          const oldPrepaid = dbPrepaidType === 'pct' ? roundRate(match.prepaid) : roundCurrency(match.prepaid);
          const oldPostpaid = dbPostpaidType === 'pct' ? roundRate(match.postpaid) : roundCurrency(match.postpaid);

          const typeChanged = (scfPrepaidType !== dbPrepaidType) || (scfPostpaidType !== dbPostpaidType);
          const prepaidChanged = scfPrepaidType === 'pct'
            ? Math.abs(oldPrepaid - scfPrepaid) >= EPSILON_RATE
            : Math.abs(oldPrepaid - scfPrepaid) >= EPSILON_FEE;
          const postpaidChanged = scfPostpaidType === 'pct'
            ? Math.abs(oldPostpaid - scfPostpaid) >= EPSILON_RATE
            : Math.abs(oldPostpaid - scfPostpaid) >= EPSILON_FEE;

          if (typeChanged || prepaidChanged || postpaidChanged) {
            modifiedCount++;
            diffs.push({
              table: 'rc_collection_fee',
              category,
              brand_name: null,
              fulfilment_type: scfType || null,
              slab: `₹${scfMin} - ₹${scfMax}`,
              changeType: 'MODIFIED',
              oldRate: `Prepaid: ${oldPrepaid}${dbPrepaidType === 'pct' ? '%' : ''}, Postpaid: ${oldPostpaid}${dbPostpaidType === 'pct' ? '%' : ''}`,
              newRate: `Prepaid: ${scfPrepaid}${scfPrepaidType === 'pct' ? '%' : ''}, Postpaid: ${scfPostpaid}${scfPostpaidType === 'pct' ? '%' : ''}`,
              anomaly: false,
              details: `Collection fee changed from P:${oldPrepaid}${dbPrepaidType === 'pct' ? '%' : ''}/Po:${oldPostpaid}${dbPostpaidType === 'pct' ? '%' : ''} to P:${scfPrepaid}${scfPrepaidType === 'pct' ? '%' : ''}/Po:${scfPostpaid}${scfPostpaidType === 'pct' ? '%' : ''}`
            });
          } else {
            unchangedCount++;
          }
        }
      }

      // Check for removed collection fee slabs
      if (scrapedColl.length > 0) {
        dbColl.forEach((c, idx) => {
          if (!matchedDbCollIdxs.has(idx)) {
            modifiedCount++;
            const dbPrepaidType = (c.prepaid_type || 'pct').toLowerCase() === 'pct' ? 'pct' : 'flat';
            const dbPostpaidType = (c.postpaid_type || 'flat').toLowerCase() === 'pct' ? 'pct' : 'flat';
            diffs.push({
              table: 'rc_collection_fee',
              category,
              brand_name: null,
              fulfilment_type: c.fulfilment_type || 'All',
              slab: `₹${roundCurrency(c.price_min)} - ₹${roundCurrency(c.price_max)}`,
              changeType: 'REMOVED',
              oldRate: `Prepaid: ${c.prepaid}${dbPrepaidType === 'pct' ? '%' : ''}, Postpaid: ${c.postpaid}${dbPostpaidType === 'pct' ? '%' : ''}`,
              newRate: null,
              anomaly: false,
              details: `Collection fee slab removed from rate card`
            });
          }
        });
      }

      // ── 4. Check Reverse Shipping Slabs ────────────────────────────────────
      const scrapedRev = obs.reverseShipping || [];
      const dbRev = activeRevShipping.filter(r => r.category === category);
      const matchedDbRevIdxs = new Set();

      for (const srv of scrapedRev) {
        const srvSlab = (srv.weight_slab || '0kg-0.5kg').toLowerCase();
        const srvLoc = roundCurrency(srv.local_fee);
        const srvZon = roundCurrency(srv.zonal_fee);
        const srvNat = roundCurrency(srv.national_fee);

        let matchIdx = dbRev.findIndex((r, idx) => {
          if (matchedDbRevIdxs.has(idx)) return false;
          const sameSlab = (r.weight_slab || '0kg-0.5kg').toLowerCase() === srvSlab;
          if (!sameSlab) return false;
          const rMin = roundCurrency(r.price_min ?? 0);
          const sMin = roundCurrency(srv.price_min ?? 0);
          return Math.abs(rMin - sMin) < 1.05;
        });

        if (matchIdx === -1) {
          matchIdx = dbRev.findIndex((r, idx) =>
            !matchedDbRevIdxs.has(idx) && (r.weight_slab || '0kg-0.5kg').toLowerCase() === srvSlab
          );
        }

        if (matchIdx === -1) {
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
          matchedDbRevIdxs.add(matchIdx);
          const match = dbRev[matchIdx];
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

      // Check for removed reverse shipping slabs
      if (scrapedRev.length > 0) {
        dbRev.forEach((r, idx) => {
          if (!matchedDbRevIdxs.has(idx)) {
            modifiedCount++;
            diffs.push({
              table: 'rc_reverse_shipping',
              category,
              brand_name: null,
              fulfilment_type: null,
              slab: (r.weight_slab || '0kg-0.5kg').toLowerCase(),
              changeType: 'REMOVED',
              oldRate: `L:₹${roundCurrency(r.local_fee)}/Z:₹${roundCurrency(r.zonal_fee)}/N:₹${roundCurrency(r.national_fee)}`,
              newRate: null,
              anomaly: false,
              details: `Reverse shipping slab ${r.weight_slab} removed from rate card`
            });
          }
        });
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
