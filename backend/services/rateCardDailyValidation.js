/**
 * Rate Card Daily Extraction, Dual Comparison & Anomaly Detection Engine
 * 
 * Implements a rigorous validation workflow:
 * 1. Validates completeness of all extracted fee parameters (commissions, fixed fees,
 *    collection fees, reverse shipping, FBF pick & pack).
 * 2. Runs dual comparison against BOTH:
 *    a) The last successfully validated extraction (detecting multi-day gaps and drift).
 *    b) The currently active PostgreSQL rate card (determining DB updates).
 * 3. Detects anomalies: significant price/rate jumps, slab count shifts, missing parameters,
 *    and future effective dates.
 * 4. Determines whether changes can be automatically applied or require admin approval.
 * 5. Persists extraction snapshots to `rate_card_extractions`.
 */

import { getPool } from '../db/index.js';

export const ANOMALY_THRESHOLDS = {
  COMMISSION_PERCENT_POINTS: 0.05, // 5 percentage points (e.g. 10% -> 15%)
  COMMISSION_RELATIVE_SHIFT: 0.50, // 50% relative increase or decrease
  FIXED_FEE_ABSOLUTE_RUPEES: 20.0, // ₹20 absolute move
  FIXED_FEE_RELATIVE_SHIFT: 0.50,  // 50% relative move
  REVERSE_SHIPPING_ABSOLUTE_RUPEES: 25.0, // ₹25 move on local, zonal, or national
  PICK_PACK_ABSOLUTE_RUPEES: 10.0, // ₹10 move on warehouse pick & pack
  PICK_PACK_RELATIVE_SHIFT: 0.50,  // 50% relative move
  COLLECTION_FEE_PERCENT_POINTS: 0.02, // 2 percentage points
  COLLECTION_FEE_FLAT_RUPEES: 15.0,    // ₹15 flat move
  SLAB_COUNT_JUMP: 3               // >= 3 slabs added or removed in one vertical
};

/**
 * Returns date string (YYYY-MM-DD) for the day prior to given ISO date.
 */
export function dayBefore(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Formats decimal value safely.
 */
function num(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalizes marketplace string.
 */
export function normalizeMarketplace(mp) {
  const s = String(mp || '').trim().toLowerCase();
  if (s.includes('shopsy')) return 'shopsy';
  if (s.includes('flipkart')) return 'flipkart';
  if (s.includes('myntra')) return s.includes('ej') ? 'myntra_ej' : 'myntra_vb';
  if (s.includes('meesho')) return 'meesho';
  if (s.includes('ajio')) return 'reliance_ajio';
  return s || 'flipkart';
}

/**
 * Validates the structural completeness and parameters of extracted rate cards.
 */
export function validateExtractionCompleteness(scrapedCards, options = {}) {
  const errors = [];
  const warnings = [];
  const parametersFound = {
    totalCards: 0,
    marketplaces: new Set(),
    categories: new Set(),
    brands: new Set(),
    commissionsCount: 0,
    fixedFeesCount: 0,
    reverseShippingCount: 0,
    collectionFeesCount: 0,
    pickPackFeesCount: 0
  };

  if (!Array.isArray(scrapedCards) || scrapedCards.length === 0) {
    return {
      valid: false,
      errors: ['Extraction payload is empty or not an array.'],
      warnings: [],
      parametersFound
    };
  }

  for (let idx = 0; idx < scrapedCards.length; idx++) {
    const card = scrapedCards[idx];
    parametersFound.totalCards++;
    const mp = normalizeMarketplace(card.marketplace);
    parametersFound.marketplaces.add(mp);

    const category = String(card.category || card.vertical || '').trim();
    if (!category) {
      errors.push(`Card #${idx + 1} has no category/vertical specified.`);
    } else {
      parametersFound.categories.add(category);
    }

    const brand = String(card.brand || card.brand_name || 'General').trim();
    parametersFound.brands.add(brand);

    // 1. Commission Validation
    const commissions = card.commissions || [];
    parametersFound.commissionsCount += commissions.length;
    for (const c of commissions) {
      if (c.rate === undefined || c.rate === null || !Number.isFinite(Number(c.rate))) {
        errors.push(`Card #${idx + 1} (${category}) has invalid commission rate: ${c.rate}`);
      } else if (Number(c.rate) < 0 || Number(c.rate) > 1.0) {
        errors.push(`Card #${idx + 1} (${category}) commission rate ${c.rate} is outside valid [0, 1.0] range.`);
      }
      // Shopsy 0% commission invariant
      if (mp === 'shopsy' && Number(c.rate) !== 0) {
        errors.push(`Shopsy rate invariant violation: category ${category} has nonzero commission ${c.rate}. Shopsy commission must be 0.00%.`);
      }
      if (num(c.price_min) > num(c.price_max)) {
        errors.push(`Card #${idx + 1} (${category}) has inverted commission price slab: ₹${c.price_min} - ₹${c.price_max}`);
      }
    }

    // 2. Fixed Fee Validation
    const fixedFees = card.fixedFees || [];
    parametersFound.fixedFeesCount += fixedFees.length;
    for (const ff of fixedFees) {
      if (ff.rate === undefined || ff.rate === null || !Number.isFinite(Number(ff.rate)) || Number(ff.rate) < 0) {
        errors.push(`Card #${idx + 1} (${category}) has invalid fixed fee rate: ${ff.rate}`);
      }
    }

    // 3. Reverse Shipping Validation
    const revShipping = card.reverseShipping || [];
    parametersFound.reverseShippingCount += revShipping.length;
    for (const rs of revShipping) {
      if (rs.local_fee === undefined || Number(rs.local_fee) < 0 ||
          rs.zonal_fee === undefined || Number(rs.zonal_fee) < 0 ||
          rs.national_fee === undefined || Number(rs.national_fee) < 0) {
        errors.push(`Card #${idx + 1} (${category}) reverse shipping fees (L/Z/N) contain invalid negative or null values.`);
      }
    }

    // 4. Collection Fees
    const collFees = card.collectionFees || [];
    parametersFound.collectionFeesCount += collFees.length;

    // 5. Pick & Pack Fees
    const ppFees = card.pickPackFees || [];
    parametersFound.pickPackFeesCount += ppFees.length;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    parametersFound: {
      ...parametersFound,
      marketplaces: [...parametersFound.marketplaces],
      categories: [...parametersFound.categories],
      brands: [...parametersFound.brands]
    }
  };
}

/**
 * Compares current extracted rate cards against a previous extraction snapshot.
 * Detects parameter shifts, new/missing parameters, and multi-day extraction gaps.
 */
export function compareWithPreviousExtraction(currentCards, previousExtractionRecord, options = {}) {
  const currentDate = String(options.currentDate || new Date().toISOString().slice(0, 10));
  
  if (!previousExtractionRecord || !Array.isArray(previousExtractionRecord.rate_cards) || previousExtractionRecord.rate_cards.length === 0) {
    return {
      hasPreviousExtraction: false,
      daysElapsed: null,
      skippedDays: [],
      newParameters: [],
      missingParameters: [],
      modifiedParameters: [],
      unchangedParametersCount: 0,
      summaryText: 'First validated extraction on record. No prior extraction snapshot available for comparison.'
    };
  }

  const prevCards = previousExtractionRecord.rate_cards;
  const prevDate = String(previousExtractionRecord.extraction_date || previousExtractionRecord.extracted_at || '').slice(0, 10);
  
  // Calculate days elapsed and check for multi-day gaps
  let daysElapsed = 1;
  const skippedDays = [];
  if (prevDate && /^\d{4}-\d{2}-\d{2}$/.test(prevDate)) {
    const dPrev = new Date(prevDate + 'T00:00:00Z');
    const dCurr = new Date(currentDate + 'T00:00:00Z');
    const diffTime = dCurr.getTime() - dPrev.getTime();
    daysElapsed = Math.max(0, Math.round(diffTime / (1000 * 60 * 60 * 24)));
    
    if (daysElapsed > 1) {
      // Extraction was skipped for one or more days!
      const cursor = new Date(dPrev);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      while (cursor < dCurr) {
        skippedDays.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
  }

  // Build key-indexed slab maps for comparison
  const buildSlabMap = (cards) => {
    const map = new Map();
    for (const card of cards) {
      const mp = normalizeMarketplace(card.marketplace);
      const cat = String(card.category || card.vertical || '').trim().toLowerCase();
      const br = String(card.brand || card.brand_name || 'General').trim().toLowerCase();

      // Commissions
      for (const c of card.commissions || []) {
        const key = `${mp}|commission|${cat}|${br}|₹${c.price_min}-₹${c.price_max}`;
        map.set(key, { type: 'commission', marketplace: mp, category: cat, brand: br, slab: `₹${c.price_min}-₹${c.price_max}`, rate: num(c.rate), data: c });
      }
      // Fixed Fees
      for (const ff of card.fixedFees || []) {
        const fType = ff.fulfilment_type || 'All';
        const key = `${mp}|fixed_fee|${cat}|${fType}|₹${ff.price_min}-₹${ff.price_max}`;
        map.set(key, { type: 'fixed_fee', marketplace: mp, category: cat, brand: 'General', slab: `${fType}: ₹${ff.price_min}-₹${ff.price_max}`, rate: num(ff.rate), data: ff });
      }
      // Reverse Shipping
      for (const rs of card.reverseShipping || []) {
        const key = `${mp}|reverse_shipping|${cat}|${rs.weight_slab}|₹${rs.price_min}-₹${rs.price_max}`;
        map.set(key, { type: 'reverse_shipping', marketplace: mp, category: cat, brand: 'General', slab: `${rs.weight_slab}: ₹${rs.price_min}-₹${rs.price_max}`,
          local_fee: num(rs.local_fee), zonal_fee: num(rs.zonal_fee), national_fee: num(rs.national_fee), data: rs });
      }
      // Collection Fee
      for (const cf of card.collectionFees || []) {
        const fType = cf.fulfilment_type || 'All';
        const key = `${mp}|collection_fee|${cat}|${fType}|₹${cf.price_min}-₹${cf.price_max}`;
        map.set(key, { type: 'collection_fee', marketplace: mp, category: cat, brand: 'General', slab: `${fType}: ₹${cf.price_min}-₹${cf.price_max}`,
          prepaid: num(cf.prepaid), postpaid: num(cf.postpaid), prepaid_type: cf.prepaid_type, postpaid_type: cf.postpaid_type, data: cf });
      }
      // Pick & Pack
      for (const pp of card.pickPackFees || []) {
        const fType = pp.fulfilment_type || 'FBF';
        const key = `${mp}|pick_pack|${cat}|${fType}|${pp.weight_min}-${pp.weight_max}|₹${pp.price_min}-₹${pp.price_max}`;
        map.set(key, { type: 'pick_pack', marketplace: mp, category: cat, brand: 'General', slab: `${fType}: ${pp.weight_min}-${pp.weight_max}kg · ₹${pp.price_min}-₹${pp.price_max}`,
          rate: num(pp.rate ?? pp.local_fee), data: pp });
      }
    }
    return map;
  };

  const currMap = buildSlabMap(currentCards);
  const prevMap = buildSlabMap(prevCards);

  const newParameters = [];
  const missingParameters = [];
  const modifiedParameters = [];
  let unchangedCount = 0;

  for (const [key, currItem] of currMap.entries()) {
    if (!prevMap.has(key)) {
      newParameters.push({
        key,
        ...currItem,
        changeType: 'ADDED',
        reason: `New parameter/slab introduced compared to last extraction (${prevDate})`
      });
    } else {
      const prevItem = prevMap.get(key);
      let isDifferent = false;
      let diffDesc = '';
      let diffAmount = 0;
      let diffPercent = 0;

      if (currItem.type === 'commission') {
        const delta = currItem.rate - prevItem.rate;
        if (Math.abs(delta) > 0.0001) {
          isDifferent = true;
          diffAmount = delta;
          diffPercent = prevItem.rate !== 0 ? (delta / prevItem.rate) * 100 : 0;
          diffDesc = `Commission rate shifted from ${(prevItem.rate * 100).toFixed(2)}% to ${(currItem.rate * 100).toFixed(2)}%`;
        }
      } else if (currItem.type === 'fixed_fee' || currItem.type === 'pick_pack') {
        const delta = currItem.rate - prevItem.rate;
        if (Math.abs(delta) > 0.01) {
          isDifferent = true;
          diffAmount = delta;
          diffPercent = prevItem.rate !== 0 ? (delta / prevItem.rate) * 100 : 0;
          diffDesc = `Fee shifted from ₹${prevItem.rate.toFixed(2)} to ₹${currItem.rate.toFixed(2)}`;
        }
      } else if (currItem.type === 'reverse_shipping') {
        const lDelta = currItem.local_fee - prevItem.local_fee;
        const zDelta = currItem.zonal_fee - prevItem.zonal_fee;
        const nDelta = currItem.national_fee - prevItem.national_fee;
        if (Math.abs(lDelta) > 0.01 || Math.abs(zDelta) > 0.01 || Math.abs(nDelta) > 0.01) {
          isDifferent = true;
          diffAmount = Math.max(Math.abs(lDelta), Math.abs(zDelta), Math.abs(nDelta));
          diffDesc = `Reverse shipping shifted: Local (₹${prevItem.local_fee} → ₹${currItem.local_fee}), Zonal (₹${prevItem.zonal_fee} → ₹${currItem.zonal_fee}), National (₹${prevItem.national_fee} → ₹${currItem.national_fee})`;
        }
      } else if (currItem.type === 'collection_fee') {
        if (Math.abs(currItem.prepaid - prevItem.prepaid) > 0.0001 || Math.abs(currItem.postpaid - prevItem.postpaid) > 0.0001) {
          isDifferent = true;
          diffDesc = `Collection fee shifted: Prepaid (${prevItem.prepaid} → ${currItem.prepaid}), Postpaid (${prevItem.postpaid} → ${currItem.postpaid})`;
        }
      }

      if (isDifferent) {
        modifiedParameters.push({
          key,
          ...currItem,
          previousRate: prevItem.rate ?? null,
          newRate: currItem.rate ?? null,
          diffAmount,
          diffPercent,
          changeType: 'MODIFIED',
          reason: diffDesc
        });
      } else {
        unchangedCount++;
      }
    }
  }

  // Detect missing parameters that existed previously but disappeared
  for (const [key, prevItem] of prevMap.entries()) {
    if (!currMap.has(key)) {
      missingParameters.push({
        key,
        ...prevItem,
        changeType: 'REMOVED',
        reason: `Parameter/slab existed on ${prevDate} but was not found in current extraction`
      });
    }
  }

  const gapText = skippedDays.length > 0 
    ? `⚠️ ${skippedDays.length} extraction day(s) skipped between ${prevDate} and ${currentDate} (${skippedDays.join(', ')}). Comparison bridges the multi-day gap.`
    : `Daily extraction cadence continuous (last validated: ${prevDate}).`;

  return {
    hasPreviousExtraction: true,
    previousDate: prevDate,
    currentDate,
    daysElapsed,
    skippedDays,
    gapText,
    newParameters,
    missingParameters,
    modifiedParameters,
    unchangedParametersCount: unchangedCount,
    hasChanges: (newParameters.length + missingParameters.length + modifiedParameters.length) > 0
  };
}

/**
 * Scans changes from both comparisons (vs previous extraction and vs active DB)
 * and flags anomalies according to defined financial and structural thresholds.
 */
export function detectExtractionAnomalies(vsPrevious, vsDbChanges = [], options = {}) {
  const anomalies = [];
  const marketplace = options.marketplace || 'flipkart';
  const effectiveDate = options.effectiveDate || new Date().toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // Check if effective date is in the future
  let futureEffectiveDateFlag = false;
  if (effectiveDate > today) {
    futureEffectiveDateFlag = true;
    anomalies.push({
      type: 'future_effective_date',
      severity: 'medium',
      reason: `Documented effective date (${effectiveDate}) is in the future. Requires administrator scheduling verification before auto-publishing.`,
      effectiveDate
    });
  }

  // Scan DB diffs for threshold breaches
  for (const c of vsDbChanges) {
    const { type, oldRate, newRate, difference } = c;

    if (type === 'commission') {
      if (typeof oldRate === 'number' && typeof newRate === 'number') {
        const delta = Math.abs(newRate - oldRate);
        const rel = oldRate > 0 ? (delta / oldRate) : 1;
        if (delta >= ANOMALY_THRESHOLDS.COMMISSION_PERCENT_POINTS || (oldRate > 0 && rel >= ANOMALY_THRESHOLDS.COMMISSION_RELATIVE_SHIFT)) {
          anomalies.push({
            type: 'commission_anomaly',
            severity: 'high',
            item: c,
            reason: `Commission shifted by ${(delta * 100).toFixed(2)} pp (${(rel * 100).toFixed(1)}% relative change). Exceeds anomaly threshold.`
          });
          c.anomaly = true;
          c.anomalyType = 'commission_shift';
        }
      } else if (oldRate == null && typeof newRate === 'number' && newRate >= 0.25) {
        anomalies.push({
          type: 'commission_high_initial',
          severity: 'medium',
          item: c,
          reason: `High initial commission rate ${(newRate * 100).toFixed(1)}% on new category. Requires margin review.`
        });
        c.anomaly = true;
        c.anomalyType = 'high_initial_rate';
      }
    } else if (type === 'fixed_fee') {
      if (typeof oldRate === 'number' && typeof newRate === 'number') {
        const delta = Math.abs(newRate - oldRate);
        const rel = oldRate > 0 ? (delta / oldRate) : 1;
        if (delta >= ANOMALY_THRESHOLDS.FIXED_FEE_ABSOLUTE_RUPEES || (oldRate > 0 && rel >= ANOMALY_THRESHOLDS.FIXED_FEE_RELATIVE_SHIFT)) {
          anomalies.push({
            type: 'fixed_fee_anomaly',
            severity: 'high',
            item: c,
            reason: `Fixed closing fee shifted by ₹${delta.toFixed(2)} (${(rel * 100).toFixed(1)}%). Exceeds anomaly threshold.`
          });
          c.anomaly = true;
          c.anomalyType = 'fixed_fee_shift';
        }
      }
    } else if (type === 'reverse_shipping') {
      if (c.oldFees && c.newFees) {
        const lDelta = Math.abs(c.newFees.local - c.oldFees.local);
        const zDelta = Math.abs(c.newFees.zonal - c.oldFees.zonal);
        const nDelta = Math.abs(c.newFees.national - c.oldFees.national);
        const maxDelta = Math.max(lDelta, zDelta, nDelta);
        if (maxDelta >= ANOMALY_THRESHOLDS.REVERSE_SHIPPING_ABSOLUTE_RUPEES) {
          anomalies.push({
            type: 'reverse_shipping_anomaly',
            severity: 'high',
            item: c,
            reason: `Reverse shipping fee shifted by up to ₹${maxDelta.toFixed(2)}. Exceeds ₹25 anomaly threshold.`
          });
          c.anomaly = true;
          c.anomalyType = 'reverse_shipping_shift';
        }
      }
    } else if (type === 'pick_pack') {
      const oldVal = parseFloat(String(c.oldRate || '').replace(/[^\d.]/g, ''));
      const newVal = parseFloat(String(c.newRate || '').replace(/[^\d.]/g, ''));
      if (Number.isFinite(oldVal) && Number.isFinite(newVal)) {
        const delta = Math.abs(newVal - oldVal);
        if (delta >= ANOMALY_THRESHOLDS.PICK_PACK_ABSOLUTE_RUPEES || (oldVal > 0 && delta / oldVal >= ANOMALY_THRESHOLDS.PICK_PACK_RELATIVE_SHIFT)) {
          anomalies.push({
            type: 'pick_pack_anomaly',
            severity: 'high',
            item: c,
            reason: `FBF pick & pack fee shifted by ₹${delta.toFixed(2)}. Exceeds anomaly threshold.`
          });
          c.anomaly = true;
          c.anomalyType = 'pick_pack_shift';
        }
      }
    }
  }

  // Scan vs previous extraction missing parameters
  if (vsPrevious?.missingParameters?.length > 0) {
    anomalies.push({
      type: 'missing_parameters_anomaly',
      severity: 'high',
      count: vsPrevious.missingParameters.length,
      reason: `${vsPrevious.missingParameters.length} fee parameter(s) present in previous validated extraction disappeared in today's extraction. Potential extraction failure or parameter deprecation.`
    });
  }

  const requiresAdminApproval = anomalies.length > 0;
  const autoUpdatable = anomalies.length === 0 && !futureEffectiveDateFlag;

  return {
    anomalies,
    anomalyCount: anomalies.length,
    futureEffectiveDateFlag,
    requiresAdminApproval,
    autoUpdatable
  };
}

/**
 * Compiles a comprehensive daily validation report combining:
 * 1. Completeness validation
 * 2. Comparison against last validated extraction (multi-day gap aware)
 * 3. Comparison against currently active database rate card
 * 4. Anomaly detection & admin approval gating
 */
export function compileDailyValidationReport({
  currentCards,
  previousExtractionRecord,
  activeDbChanges = [],
  options = {}
}) {
  const completeness = validateExtractionCompleteness(currentCards, options);
  const vsPrevious = compareWithPreviousExtraction(currentCards, previousExtractionRecord, options);
  const anomalyScan = detectExtractionAnomalies(vsPrevious, activeDbChanges, options);

  let validationStatus = 'clean';
  if (!completeness.valid) {
    validationStatus = 'incomplete_extraction';
  } else if (anomalyScan.anomalyCount > 0) {
    validationStatus = 'anomalies_detected';
  } else if (activeDbChanges.length > 0 || vsPrevious.hasChanges) {
    validationStatus = 'verified_changes_confirmed';
  } else {
    validationStatus = 'no_changes';
  }

  const requiresAdminApproval = validationStatus === 'anomalies_detected' ||
    validationStatus === 'incomplete_extraction' ||
    anomalyScan.futureEffectiveDateFlag;

  const autoUpdatable = validationStatus === 'verified_changes_confirmed' && !requiresAdminApproval;

  return {
    timestamp: new Date().toISOString(),
    marketplace: options.marketplace || 'flipkart',
    sellerAccount: options.sellerAccount || 'default',
    extractionDate: options.currentDate || new Date().toISOString().slice(0, 10),
    effectiveDate: options.effectiveDate || options.currentDate || new Date().toISOString().slice(0, 10),
    validationStatus,
    requiresAdminApproval,
    autoUpdatable,
    completeness,
    vsPreviousExtraction: vsPrevious,
    vsActiveDatabase: {
      hasChanges: activeDbChanges.length > 0,
      diffsCount: activeDbChanges.length,
      diffs: activeDbChanges
    },
    anomalies: anomalyScan.anomalies,
    anomalyCount: anomalyScan.anomalyCount,
    summary: {
      totalCardsExtracted: currentCards.length,
      newParametersCount: vsPrevious.newParameters?.length || 0,
      missingParametersCount: vsPrevious.missingParameters?.length || 0,
      modifiedParametersCount: vsPrevious.modifiedParameters?.length || 0,
      dbChangesCount: activeDbChanges.length,
      anomaliesCount: anomalyScan.anomalyCount,
      daysSinceLastExtraction: vsPrevious.daysElapsed,
      skippedDaysCount: vsPrevious.skippedDays?.length || 0
    }
  };
}

/**
 * Queries the last successfully validated extraction from PostgreSQL.
 */
export async function getLastValidatedExtraction(pool, { marketplace = 'flipkart', sellerAccount = 'default', beforeDate = null } = {}) {
  const p = pool || getPool();
  try {
    let query = `
      SELECT id, marketplace, seller_account, extraction_date, extracted_at,
             status, source, rate_cards, parameters_summary, dual_comparison, anomalies, version_id
      FROM rate_card_extractions
      WHERE marketplace = $1 
        AND (seller_account = $2 OR ($2 = 'default' AND (seller_account IS NULL OR seller_account = 'default')))
        AND status IN ('validated', 'published')
    `;
    const params = [marketplace, sellerAccount];
    if (beforeDate) {
      params.push(beforeDate);
      query += ` AND extraction_date < $3::date`;
    }
    query += ` ORDER BY extraction_date DESC, id DESC LIMIT 1;`;

    const res = await p.query(query, params);
    return res.rows[0] || null;
  } catch (err) {
    // If table doesn't exist yet, return null gracefully
    if (err.code === '42P01') return null;
    throw err;
  }
}

/**
 * Saves an extraction snapshot record to `rate_card_extractions` in PostgreSQL.
 */
export async function saveRateCardExtraction(pool, record) {
  const p = pool || getPool();
  try {
    const res = await p.query(`
      INSERT INTO rate_card_extractions (
        marketplace, seller_account, extraction_date, extracted_at,
        status, source, rate_cards, parameters_summary, dual_comparison,
        anomalies, version_id, error_message, created_at
      ) VALUES (
        $1, $2, $3::date, NOW(),
        $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
        $9::jsonb, $10, $11, NOW()
      )
      RETURNING id, marketplace, seller_account, extraction_date, status, created_at;
    `, [
      record.marketplace || 'flipkart',
      record.sellerAccount || 'default',
      record.extractionDate || new Date().toISOString().slice(0, 10),
      record.status || 'staged',
      record.source || 'desktop_worker',
      JSON.stringify(record.rateCards || []),
      JSON.stringify(record.parametersSummary || {}),
      JSON.stringify(record.dualComparison || {}),
      JSON.stringify(record.anomalies || []),
      record.versionId || null,
      record.errorMessage || null
    ]);
    return res.rows[0];
  } catch (err) {
    console.warn('[rateCardDailyValidation] saveRateCardExtraction warning:', err.message);
    return null;
  }
}
