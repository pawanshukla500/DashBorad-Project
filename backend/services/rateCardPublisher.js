import { getPool } from '../db/index.js';
import { clearRateCardCache } from './rateCard.js';
import { forEachDbBatch } from '../utils/dbBatch.js';
import { compareScrapedRatesWithActive } from './rateCardCanonicalEngine.js';
import { RATE_TABLES, validateRateObservations, normalizeObservationRow, rateRowIdentity } from './rateCardObservationPlan.js';
import { assertRateObservationCoverage, loadRateCardCoverage } from './rateCardCoverage.js';

const before = date => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
};
const iso = date => date instanceof Date ? date.toISOString().slice(0, 10) : date;

export async function publishRateCardObservations(observations, options = {}) {
  const { marketplace = 'flipkart', sellerAccount = 'default', publishedBy,
    effectiveDate = observations?.[0]?.effectiveDate, jobId = null } = options;
  validateRateObservations(observations, { marketplace, complete: true });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate || '') ||
      new Date(`${effectiveDate}T00:00:00Z`).toISOString().slice(0, 10) !== effectiveDate ||
      observations.some(o => o.effectiveDate !== effectiveDate)) throw new Error('One valid extraction date is required.');
  if (!publishedBy) throw new Error('An authenticated reviewer is required.');
  const client = await (options.pool || getPool()).connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('lock_timeout', '5s', true)");
    await client.query("SELECT set_config('statement_timeout', '60s', true)");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('rate_card_publish_lock'))");
    if (options.requireConfiguredCoverage) {
      const coverage = await loadRateCardCoverage(client, { marketplace, sellerAccount, effectiveDate });
      const expectedVerticals = assertRateObservationCoverage(observations, coverage);
      validateRateObservations(observations, { marketplace, complete: true, expectedVerticals });
    }
    const plan = await compareScrapedRatesWithActive(observations, { marketplace, sellerAccount, effectiveDate, dbClient: client });
    if (!options.reviewFingerprint || plan.fingerprint !== options.reviewFingerprint) throw new Error('REVIEW_STALE: rates changed since review. Refresh and review again.');
    if (!plan.hasChanges) {
      await client.query('ROLLBACK');
      return { published: false, diffCount: 0, summary: plan.summary, message: 'Rates are unchanged.' };
    }
    // Pending source migrations are not live readiness. Refuse writes until
    // active-row uniqueness has been reviewed and applied to this database.
    const readiness = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
      AND indexdef LIKE 'CREATE UNIQUE INDEX%'
      AND indexname IN ('rc_commission_uniq_portal_active','rc_fixed_fee_uniq_active','rc_collection_fee_uniq_active','rc_reverse_shipping_uniq_portal_active','rc_pick_pack_uniq_portal_active')`);
    const columns = await client.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name IN ('rc_reverse_shipping','rc_pick_pack') AND column_name IN ('weight_min','weight_max','base_weight','increment_weight','local_fee','zonal_fee','national_fee','local_additional_fee','zonal_additional_fee','national_additional_fee','price_scope')`);
    if (readiness.rows.length !== 5 || columns.rows.length !== 21) throw new Error('RATE_SCHEMA_NOT_READY: dimensional fee columns or uniqueness indexes are missing. Review migrations before publishing.');

    for (const diff of plan.diffs) {
      const descriptor = RATE_TABLES.find(t => t.table === diff.table);
      const sameDay = diff.oldRow && iso(diff.oldRow.start_date) === effectiveDate;
      if (diff.oldRow) {
        if (sameDay && !diff.newRow) {
          await client.query(`DELETE FROM ${descriptor.table} WHERE id = $1`, [diff.oldRow.id]);
        } else if (sameDay) {
          await client.query(`UPDATE ${descriptor.table} SET ${descriptor.values.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
            [diff.oldRow.id, ...descriptor.values.map(k => diff.newRow[k])]);
        } else {
          await client.query(`UPDATE ${descriptor.table} SET end_date = $1, updated_at = NOW() WHERE id = $2`, [before(effectiveDate), diff.oldRow.id]);
        }
      }
      if (!diff.newRow || sameDay) continue;
      const row = diff.newRow;
      const keys = ['category', ...descriptor.keys];
      // Respect already scheduled periods for the exact same identity.
      const future = await client.query(`SELECT * FROM ${descriptor.table}
        WHERE marketplace = $1 AND COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2
          AND start_date > $3 AND category = $4`,
        [marketplace, sellerAccount, effectiveDate, row.category]);
      const identity = rateRowIdentity(descriptor, row);
      const next = future.rows.filter(raw => iso(raw.start_date) > effectiveDate &&
        rateRowIdentity(descriptor, normalizeObservationRow(descriptor, raw)) === identity)
        .map(raw => iso(raw.start_date)).sort()[0];
      const endDate = next ? before(next) : (iso(diff.oldRow?.end_date) || null);
      const columns = ['marketplace', 'seller_account', 'start_date', 'end_date', ...keys, ...descriptor.values];
      const values = [marketplace, sellerAccount, effectiveDate, endDate, ...keys.map(k => row[k]), ...descriptor.values.map(k => row[k])];
      await client.query(`INSERT INTO ${descriptor.table} (${columns.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`, values);
    }
    const versionName = `rc-${marketplace}-${effectiveDate}-${Date.now()}`;
    const snapshot = { effectiveDate, publishedBy, jobId, diffs: plan.diffs, summary: plan.summary };
    let version;
    await forEachDbBatch([snapshot], 5, async () => {
      version = await client.query(`INSERT INTO rate_card_versions (marketplace,seller_account,version_name,status,effective_from,snapshot,created_at,published_at)
        VALUES ($1,$2,$3,'published',$4,$5,NOW(),NOW()) RETURNING id,version_name`,
      [marketplace, sellerAccount, versionName, effectiveDate, JSON.stringify(snapshot)]);
    });
    await client.query('COMMIT');
    clearRateCardCache();
    return { published: true, versionId: version.rows[0]?.id, versionName,
      diffCount: plan.diffCount, summary: plan.summary };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}
