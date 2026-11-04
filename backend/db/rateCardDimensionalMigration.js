/**
 * Rate-card dimensional fee migration (`2026.10.ratecard-worker-jobs-3`).
 *
 * The publish readiness gate in `backend/services/rateCardPublisher.js`
 * requires 5 active-row unique indexes and 21 dimensional columns across
 * `rc_reverse_shipping` / `rc_pick_pack` before any scraped observation can
 * be published. Earlier migrations created the base tables but never added
 * these columns, so every publish attempt failed with RATE_SCHEMA_NOT_READY.
 * This migration closes that gap: additive, idempotent, and safe to re-run.
 *
 * Invoked from `ensureRateCardWorkerSchema()` in `./initDb.js`, which passes
 * its local `runVersionedMigration` runner to avoid a circular import.
 */
export const RATE_CARD_DIMENSIONAL_SCHEMA_VERSION = '2026.10.ratecard-worker-jobs-3';

export async function runRateCardDimensionalMigration(pool, runVersionedMigration) {
  return runVersionedMigration(pool, RATE_CARD_DIMENSIONAL_SCHEMA_VERSION, async (tx) => {
    // 1. Dimensional fee columns (all nullable at first so existing rows survive).
    await tx.query(`
      ALTER TABLE rc_reverse_shipping ADD COLUMN IF NOT EXISTS weight_min NUMERIC(10,3);
      ALTER TABLE rc_reverse_shipping ADD COLUMN IF NOT EXISTS weight_max NUMERIC(10,3);
      ALTER TABLE rc_reverse_shipping ADD COLUMN IF NOT EXISTS base_weight NUMERIC(10,3);
      ALTER TABLE rc_reverse_shipping ADD COLUMN IF NOT EXISTS increment_weight NUMERIC(10,3);
      ALTER TABLE rc_reverse_shipping ADD COLUMN IF NOT EXISTS local_additional_fee NUMERIC(10,2);
      ALTER TABLE rc_reverse_shipping ADD COLUMN IF NOT EXISTS zonal_additional_fee NUMERIC(10,2);
      ALTER TABLE rc_reverse_shipping ADD COLUMN IF NOT EXISTS national_additional_fee NUMERIC(10,2);

      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS weight_min NUMERIC(10,3);
      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS weight_max NUMERIC(10,3);
      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS base_weight NUMERIC(10,3);
      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS increment_weight NUMERIC(10,3);
      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS local_fee NUMERIC(10,2);
      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS zonal_fee NUMERIC(10,2);
      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS national_fee NUMERIC(10,2);
      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS local_additional_fee NUMERIC(10,2);
      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS zonal_additional_fee NUMERIC(10,2);
      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS national_additional_fee NUMERIC(10,2);
      ALTER TABLE rc_pick_pack ADD COLUMN IF NOT EXISTS price_scope TEXT;
    `);

    // 2. Backfill NULLs. Pick-pack zonal/national fees inherit the flat rate so
    // legacy single-rate rows keep pricing identically through the read path
    // (`local_fee ?? rate` in `services/rateCard.js`).
    await tx.query(`
      UPDATE rc_reverse_shipping SET weight_min = 0 WHERE weight_min IS NULL;
      UPDATE rc_reverse_shipping SET base_weight = 0 WHERE base_weight IS NULL;
      UPDATE rc_reverse_shipping SET increment_weight = 0 WHERE increment_weight IS NULL;
      UPDATE rc_reverse_shipping SET local_additional_fee = 0 WHERE local_additional_fee IS NULL;
    `);

    // Derive the weight ceiling from the stored slab exactly like the app
    // matcher (reverseWeightUpperBound): last number, grams→kg. weight_min
    // stays 0 so the matcher filter behaves as it did with NULLs.
    // Unparseable slabs fall back to 999999 below.
    await tx.query(`
      UPDATE rc_reverse_shipping r
      SET weight_max = p.upper
      FROM (
        SELECT id,
          CASE WHEN weight_slab ~* '(^|[^a-z])g([^a-z]|$)|gm'
            THEN nums[cardinality(nums)] / 1000
            ELSE nums[cardinality(nums)] END AS upper
        FROM (
          SELECT id, weight_slab, array_agg(match[1]::numeric ORDER BY ord) AS nums
          FROM rc_reverse_shipping,
            regexp_matches(weight_slab, '(\\d+(?:\\.\\d+)?)', 'g') WITH ORDINALITY AS m(match, ord)
          WHERE weight_max IS NULL
          GROUP BY id, weight_slab
        ) s
        WHERE cardinality(nums) > 0
      ) p
      WHERE r.id = p.id;
    `);
    await tx.query(`
      UPDATE rc_reverse_shipping SET weight_max = 999999 WHERE weight_max IS NULL;
      UPDATE rc_reverse_shipping SET zonal_additional_fee = 0 WHERE zonal_additional_fee IS NULL;
      UPDATE rc_reverse_shipping SET national_additional_fee = 0 WHERE national_additional_fee IS NULL;

      UPDATE rc_pick_pack SET weight_min = 0 WHERE weight_min IS NULL;
      UPDATE rc_pick_pack SET weight_max = 999999 WHERE weight_max IS NULL;
      UPDATE rc_pick_pack SET base_weight = 0 WHERE base_weight IS NULL;
      UPDATE rc_pick_pack SET increment_weight = 0 WHERE increment_weight IS NULL;
      UPDATE rc_pick_pack SET local_fee = rate WHERE local_fee IS NULL;
      UPDATE rc_pick_pack SET zonal_fee = rate WHERE zonal_fee IS NULL;
      UPDATE rc_pick_pack SET national_fee = rate WHERE national_fee IS NULL;
      UPDATE rc_pick_pack SET local_additional_fee = 0 WHERE local_additional_fee IS NULL;
      UPDATE rc_pick_pack SET zonal_additional_fee = 0 WHERE zonal_additional_fee IS NULL;
      UPDATE rc_pick_pack SET national_additional_fee = 0 WHERE national_additional_fee IS NULL;
      UPDATE rc_pick_pack SET price_scope = 'range' WHERE price_scope IS NULL;
    `);

    // 3. Defaults for future writes.
    await tx.query(`
      ALTER TABLE rc_reverse_shipping ALTER COLUMN weight_min SET DEFAULT 0;
      ALTER TABLE rc_reverse_shipping ALTER COLUMN weight_max SET DEFAULT 999999;
      ALTER TABLE rc_reverse_shipping ALTER COLUMN base_weight SET DEFAULT 0;
      ALTER TABLE rc_reverse_shipping ALTER COLUMN increment_weight SET DEFAULT 0;
      ALTER TABLE rc_reverse_shipping ALTER COLUMN local_additional_fee SET DEFAULT 0;
      ALTER TABLE rc_reverse_shipping ALTER COLUMN zonal_additional_fee SET DEFAULT 0;
      ALTER TABLE rc_reverse_shipping ALTER COLUMN national_additional_fee SET DEFAULT 0;

      ALTER TABLE rc_pick_pack ALTER COLUMN weight_min SET DEFAULT 0;
      ALTER TABLE rc_pick_pack ALTER COLUMN weight_max SET DEFAULT 999999;
      ALTER TABLE rc_pick_pack ALTER COLUMN base_weight SET DEFAULT 0;
      ALTER TABLE rc_pick_pack ALTER COLUMN increment_weight SET DEFAULT 0;
      ALTER TABLE rc_pick_pack ALTER COLUMN local_fee SET DEFAULT 0;
      ALTER TABLE rc_pick_pack ALTER COLUMN zonal_fee SET DEFAULT 0;
      ALTER TABLE rc_pick_pack ALTER COLUMN national_fee SET DEFAULT 0;
      ALTER TABLE rc_pick_pack ALTER COLUMN local_additional_fee SET DEFAULT 0;
      ALTER TABLE rc_pick_pack ALTER COLUMN zonal_additional_fee SET DEFAULT 0;
      ALTER TABLE rc_pick_pack ALTER COLUMN national_additional_fee SET DEFAULT 0;
      ALTER TABLE rc_pick_pack ALTER COLUMN price_scope SET DEFAULT 'range';
    `);

    // 4. Deduplicate active rows (keep newest ID), then create the exact unique
    // index names the publish readiness gate requires.
    await tx.query(`
      DELETE FROM rc_commission a USING rc_commission b
      WHERE a.id < b.id
        AND a.marketplace = b.marketplace
        AND a.seller_account = b.seller_account
        AND a.category = b.category
        AND COALESCE(a.brand_name, '') = COALESCE(b.brand_name, '')
        AND a.start_date = b.start_date
        AND a.price_min = b.price_min
        AND a.price_max = b.price_max
        AND a.end_date IS NULL AND b.end_date IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS rc_commission_uniq_portal_active
        ON rc_commission (marketplace, seller_account, category, COALESCE(brand_name, ''), start_date, price_min, price_max)
        WHERE end_date IS NULL;

      DELETE FROM rc_reverse_shipping a USING rc_reverse_shipping b
      WHERE a.id < b.id
        AND a.marketplace = b.marketplace
        AND a.seller_account = b.seller_account
        AND a.category = b.category
        AND COALESCE(a.weight_slab, '') = COALESCE(b.weight_slab, '')
        AND a.start_date = b.start_date
        AND a.price_min = b.price_min
        AND a.price_max = b.price_max
        AND a.end_date IS NULL AND b.end_date IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS rc_reverse_shipping_uniq_portal_active
        ON rc_reverse_shipping (marketplace, seller_account, category, COALESCE(weight_slab, ''), start_date, price_min, price_max)
        WHERE end_date IS NULL;

      DELETE FROM rc_pick_pack a USING rc_pick_pack b
      WHERE a.id < b.id
        AND a.marketplace = b.marketplace
        AND a.seller_account = b.seller_account
        AND a.category = b.category
        AND COALESCE(a.fulfilment_type, '') = COALESCE(b.fulfilment_type, '')
        AND a.start_date = b.start_date
        AND a.price_min = b.price_min
        AND a.price_max = b.price_max
        AND a.end_date IS NULL AND b.end_date IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS rc_pick_pack_uniq_portal_active
        ON rc_pick_pack (marketplace, seller_account, category, COALESCE(fulfilment_type, ''), start_date, price_min, price_max)
        WHERE end_date IS NULL;
    `);

    // 5. Shopsy marketplace commission is 0% by policy (see the observation
    // validator). Enforce it for new writes without validating legacy rows.
    // The end_date escape keeps historical closes working: closing a row
    // rewrites it, so a legacy nonzero Shopsy rate must stay closable — only
    // open (end_date IS NULL) Shopsy rows are held to 0%.
    await tx.query(`
      DO $$ BEGIN
        ALTER TABLE rc_commission
          ADD CONSTRAINT rc_commission_shopsy_zero_rate
          CHECK (marketplace <> 'shopsy' OR rate = 0 OR end_date IS NOT NULL) NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }, { lockTimeout: '5s' });
}
