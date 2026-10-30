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
import { compareScrapedRatesWithActive } from './rateCardCanonicalEngine.js';

export async function publishRateCardObservations(observations, options = {}) {
  const {
    marketplace = 'flipkart',
    sellerAccount = 'default',
    effectiveDate = new Date().toISOString().slice(0, 10),
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
      if (hasCommissionDiff && obs.commissions?.length > 0) {
        // Auto-close previous active records
        await client.query(`
          UPDATE rc_commission
          SET end_date = $1, updated_at = NOW()
          WHERE marketplace = $2 AND seller_account = $3 AND category = $4
            AND (end_date IS NULL OR end_date >= $5)
        `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);

        for (const comm of obs.commissions) {
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
            comm.price_min || 0,
            comm.price_max || 999999,
            comm.rate || 0
          ]);
        }
      }

      // B. Fixed Fees
      if (hasFixedFeeDiff && obs.fixedFees?.length > 0) {
        await client.query(`
          UPDATE rc_fixed_fee
          SET end_date = $1, updated_at = NOW()
          WHERE marketplace = $2 AND seller_account = $3 AND category = $4
            AND (end_date IS NULL OR end_date >= $5)
        `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);

        for (const ff of obs.fixedFees) {
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
            ff.price_min || 0,
            ff.price_max || 999999,
            ff.rate || 0
          ]);
        }
      }

      // C. Collection Fees
      if (hasCollFeeDiff && obs.collectionFees?.length > 0) {
        await client.query(`
          UPDATE rc_collection_fee
          SET end_date = $1, updated_at = NOW()
          WHERE marketplace = $2 AND seller_account = $3 AND category = $4
            AND (end_date IS NULL OR end_date >= $5)
        `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);

        for (const cf of obs.collectionFees) {
          await client.query(`
            INSERT INTO rc_collection_fee (category, fulfilment_type, marketplace, seller_account, start_date, end_date, price_min, price_max, prepaid, postpaid, updated_at)
            VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, NOW())
            ON CONFLICT (marketplace, seller_account, category, COALESCE(fulfilment_type, ''), start_date, end_date, price_min, price_max)
            DO UPDATE SET prepaid = EXCLUDED.prepaid, postpaid = EXCLUDED.postpaid, updated_at = NOW()
          `, [
            category,
            cf.fulfilment_type || 'All',
            marketplace,
            sellerAccount,
            effectiveDate,
            cf.price_min || 0,
            cf.price_max || 999999,
            cf.prepaid || 0,
            cf.postpaid || 0
          ]);
        }
      }

      // D. Reverse Shipping
      if (hasRevShipDiff && obs.reverseShipping?.length > 0) {
        await client.query(`
          UPDATE rc_reverse_shipping
          SET end_date = $1, updated_at = NOW()
          WHERE marketplace = $2 AND seller_account = $3 AND category = $4
            AND (end_date IS NULL OR end_date >= $5)
        `, [previousEndDate, marketplace, sellerAccount, category, effectiveDate]);

        for (const rs of obs.reverseShipping) {
          await client.query(`
            INSERT INTO rc_reverse_shipping (category, weight_slab, marketplace, seller_account, start_date, end_date, price_min, price_max, local_fee, zonal_fee, national_fee, updated_at)
            VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, NOW())
          `, [
            category,
            rs.weight_slab || '0kg-0.5kg',
            marketplace,
            sellerAccount,
            effectiveDate,
            rs.price_min || 0,
            rs.price_max || 999999,
            rs.local_fee || 0,
            rs.zonal_fee || 0,
            rs.national_fee || 0
          ]);
        }
      }
    }

    // 3. Create Immutable Version Snapshot in rate_card_versions
    const versionName = `rc-${marketplace}-${effectiveDate}-${Date.now().toString().slice(-6)}`;
    const snapshotPayload = {
      marketplace,
      sellerAccount,
      effectiveDate,
      publishedBy,
      jobId,
      diffCount: diffResult.diffCount,
      diffs: diffResult.diffs,
      summary: diffResult.summary,
      affectedCategories: Array.from(affectedCategories)
    };

    await client.query(`
      INSERT INTO rate_card_versions (marketplace, seller_account, version_name, status, effective_from, snapshot, created_at, published_at)
      VALUES ($1, $2, $3, 'published', $4, $5, NOW(), NOW())
    `, [marketplace, sellerAccount, versionName, effectiveDate, JSON.stringify(snapshotPayload)]);

    // 4. Update worker_jobs record if jobId provided
    if (jobId) {
      await client.query(`
        UPDATE worker_jobs
        SET status = 'published', diff_summary = $1, updated_at = NOW()
        WHERE id = $2
      `, [JSON.stringify(snapshotPayload), jobId]);
    }

    await client.query('COMMIT');
    clearRateCardCache();

    return {
      published: true,
      versionName,
      changesCount: diffResult.diffCount,
      diffs: diffResult.diffs,
      summary: diffResult.summary,
      affectedCategories: Array.from(affectedCategories)
    };

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

