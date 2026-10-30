/**
 * Rate Card Safe Publisher
 * 
 * Safely publishes validated rate card diffs to PostgreSQL rc_* tables.
 * Strict zero-change invariant:
 * If no genuine rate changes exist, returns published = false and performs
 * ZERO database modifications.
 */
import { getPool } from '../db/index.js';
import { clearRateCardCache } from './rateCard.js';
import { dayBefore } from '../routes/rateCard.js';
import { compareScrapedRatesWithActive, roundCurrency, roundRate } from './rateCardCanonicalEngine.js';

export async function publishRateCardObservations(observations, options = {}) {
  const {
    marketplace = 'flipkart',
    sellerAccount = 'default',
    effectiveDate = (Array.isArray(observations) && (observations.find(o => o.effectiveDate || o.source_effective_date)?.effectiveDate || observations.find(o => o.source_effective_date)?.source_effective_date)) || new Date().toISOString().slice(0, 10),
    publishedBy = 'system',
    jobId = null
  } = options;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // Lock publication to prevent concurrent race conditions
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('rate_card_publish_lock'))`);
    await client.query(`SELECT set_config('lock_timeout', '5s', true)`);
    await client.query(`SELECT set_config('statement_timeout', '60s', true)`);

    // 1. Run canonical comparison against active rules inside transaction
    const diffResult = await compareScrapedRatesWithActive(observations, {
      marketplace,
      sellerAccount,
      effectiveDate,
      dbClient: client
    });

    if (!diffResult.hasChanges) {
      await client.query('ROLLBACK');
      return {
        published: false,
        message: 'Zero rate changes detected against active rate cards. Database unchanged.',
        diffCount: 0,
        summary: diffResult.summary
      };
    }

    const previousEndDate = dayBefore(effectiveDate);
    const affectedCategories = new Set(diffResult.diffs.map(d => d.category));

    // Track which categories have already been auto-closed in this publish run,
    // ensuring multiple observations for the same category never re-close newly inserted rows.
    const closedCommissions = new Set();
    const closedFixedFees = new Set();
    const closedCollFees = new Set();
    const closedRevShip = new Set();

    // 2. Publish scoped changes only for affected categories
    for (const obs of observations) {
      const category = obs.vertical || obs.category;
      if (!category || !affectedCategories.has(category)) continue;

      const categoryDiffs = diffResult.diffs.filter(d => d.category === category);
      const hasCommissionDiff = categoryDiffs.some(d => d.table === 'rc_commission');
      const hasFixedFeeDiff = categoryDiffs.some(d => d.table === 'rc_fixed_fee');
      const hasCollFeeDiff = categoryDiffs.some(d => d.table === 'rc_collection_fee');
      const hasRevShipDiff = categoryDiffs.some(d => d.table === 'rc_reverse_shipping');

      // A. Commissions
      if (hasCommissionDiff) {
        if (!closedCommissions.has(category)) {
          await client.query(`
            UPDATE rc_commission
            SET end_date = $1, updated_at = NOW()
            WHERE marketplace = $2 AND seller_account = $3 AND category = $4
              AND (end_date IS NULL OR end_date >= $5)
          `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);
          closedCommissions.add(category);
        }

        for (const comm of (obs.commissions || [])) {
          await client.query(`
            INSERT INTO rc_commission (category, brand_name, marketplace, seller_account, start_date, end_date, price_min, price_max, rate, updated_at)
            VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, NOW())
            ON CONFLICT (marketplace, seller_account, category, COALESCE(brand_name, ''), start_date, end_date, price_min, price_max)
            DO UPDATE SET rate = EXCLUDED.rate, updated_at = NOW()
          `, [
            category,
            comm.brand_name || null,
            marketplace,
            sellerAccount,
            effectiveDate,
            roundCurrency(comm.price_min || 0),
            roundCurrency(comm.price_max || 999999),
            roundRate(comm.rate || 0)
          ]);
        }
      }

      // B. Fixed Fees
      if (hasFixedFeeDiff) {
        if (!closedFixedFees.has(category)) {
          await client.query(`
            UPDATE rc_fixed_fee
            SET end_date = $1, updated_at = NOW()
            WHERE marketplace = $2 AND seller_account = $3 AND category = $4
              AND (end_date IS NULL OR end_date >= $5)
          `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);
          closedFixedFees.add(category);
        }

        for (const ff of (obs.fixedFees || [])) {
          await client.query(`
            INSERT INTO rc_fixed_fee (category, fulfilment_type, marketplace, seller_account, start_date, end_date, price_min, price_max, rate, updated_at)
            VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, NOW())
            ON CONFLICT (marketplace, seller_account, category, COALESCE(fulfilment_type, ''), start_date, end_date, price_min, price_max)
            DO UPDATE SET rate = EXCLUDED.rate, updated_at = NOW()
          `, [
            category,
            ff.fulfilment_type || 'All',
            marketplace,
            sellerAccount,
            effectiveDate,
            roundCurrency(ff.price_min || 0),
            roundCurrency(ff.price_max || 999999),
            roundCurrency(ff.rate || 0)
          ]);
        }
      }

      // C. Collection Fees (includes explicit prepaid_type & postpaid_type)
      if (hasCollFeeDiff) {
        if (!closedCollFees.has(category)) {
          await client.query(`
            UPDATE rc_collection_fee
            SET end_date = $1, updated_at = NOW()
            WHERE marketplace = $2 AND seller_account = $3 AND category = $4
              AND (end_date IS NULL OR end_date >= $5)
          `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);
          closedCollFees.add(category);
        }

        for (const cf of (obs.collectionFees || [])) {
          const prepaidType = (cf.prepaid_type || 'pct').toLowerCase() === 'pct' ? 'pct' : 'flat';
          const postpaidType = (cf.postpaid_type || 'flat').toLowerCase() === 'pct' ? 'pct' : 'flat';
          const prepaidVal = prepaidType === 'pct' ? roundRate(cf.prepaid) : roundCurrency(cf.prepaid);
          const postpaidVal = postpaidType === 'pct' ? roundRate(cf.postpaid) : roundCurrency(cf.postpaid);

          await client.query(`
            INSERT INTO rc_collection_fee (
              category, fulfilment_type, marketplace, seller_account,
              start_date, end_date, price_min, price_max,
              prepaid, postpaid, prepaid_type, postpaid_type, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11, NOW())
            ON CONFLICT (marketplace, seller_account, category, COALESCE(fulfilment_type, ''), start_date, end_date, price_min, price_max)
            DO UPDATE SET
              prepaid = EXCLUDED.prepaid,
              postpaid = EXCLUDED.postpaid,
              prepaid_type = EXCLUDED.prepaid_type,
              postpaid_type = EXCLUDED.postpaid_type,
              updated_at = NOW()
          `, [
            category,
            cf.fulfilment_type || 'All',
            marketplace,
            sellerAccount,
            effectiveDate,
            roundCurrency(cf.price_min || 0),
            roundCurrency(cf.price_max || 999999),
            prepaidVal,
            postpaidVal,
            prepaidType,
            postpaidType
          ]);
        }
      }

      // D. Reverse Shipping
      if (hasRevShipDiff) {
        if (!closedRevShip.has(category)) {
          await client.query(`
            UPDATE rc_reverse_shipping
            SET end_date = $1, updated_at = NOW()
            WHERE marketplace = $2 AND seller_account = $3 AND category = $4
              AND (end_date IS NULL OR end_date >= $5)
          `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);
          closedRevShip.add(category);
        }

        for (const rs of (obs.reverseShipping || [])) {
          await client.query(`
            INSERT INTO rc_reverse_shipping (category, weight_slab, marketplace, seller_account, start_date, end_date, price_min, price_max, local_fee, zonal_fee, national_fee, updated_at)
            VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, NOW())
          `, [
            category,
            (rs.weight_slab || '0kg-0.5kg').toLowerCase(),
            marketplace,
            sellerAccount,
            effectiveDate,
            roundCurrency(rs.price_min || 0),
            roundCurrency(rs.price_max || 999999),
            roundCurrency(rs.local_fee || 0),
            roundCurrency(rs.zonal_fee || 0),
            roundCurrency(rs.national_fee || 0)
          ]);
        }
      }
    }

    // 3. Create Immutable Version Snapshot in rate_card_versions
    const versionName = `v${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-flipkart-${Date.now().toString().slice(-4)}`;
    const snapshotPayload = {
      effectiveDate,
      diffSummary: diffResult.summary,
      affectedCategories: Array.from(affectedCategories),
      publishedBy: String(publishedBy || 'system'),
      jobId,
      notes: `Published via ReconCentral Canonical Publisher (Job #${jobId || 'direct'})`,
      publishedAt: new Date().toISOString()
    };

    const verRes = await client.query(`
      INSERT INTO rate_card_versions (marketplace, seller_account, version_name, status, effective_from, snapshot, created_at, published_at)
      VALUES ($1, $2, $3, 'published', $4, $5, NOW(), NOW())
      RETURNING id, version_name
    `, [
      marketplace,
      sellerAccount,
      versionName,
      effectiveDate,
      JSON.stringify(snapshotPayload)
    ]);

    await client.query('COMMIT');

    // Invalidate in-memory calculation cache
    clearRateCardCache();

    return {
      published: true,
      versionId: verRes.rows[0]?.id,
      versionName: verRes.rows[0]?.version_name,
      diffCount: diffResult.diffCount,
      affectedCategories: Array.from(affectedCategories),
      summary: diffResult.summary
    };

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
