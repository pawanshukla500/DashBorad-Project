-- Approval required. This file is intentionally NOT wired into application
-- startup and does NOT change CURRENT_SCHEMA_VERSION. Run once, in a reviewed
-- maintenance window, after inspecting duplicate-rate findings. It deletes no
-- rates; index creation aborts the whole transaction if duplicates exist.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('rate_card_publish_lock'));

ALTER TABLE rc_reverse_shipping
  ADD COLUMN IF NOT EXISTS weight_min NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS weight_max NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS base_weight NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS increment_weight NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS local_additional_fee NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS zonal_additional_fee NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS national_additional_fee NUMERIC(12,2);

ALTER TABLE rc_pick_pack
  ADD COLUMN IF NOT EXISTS weight_min NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS weight_max NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS base_weight NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS increment_weight NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS local_fee NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS zonal_fee NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS national_fee NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS local_additional_fee NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS zonal_additional_fee NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS national_additional_fee NUMERIC(12,2);

CREATE UNIQUE INDEX IF NOT EXISTS rc_commission_uniq_active ON rc_commission
  (marketplace,seller_account,category,COALESCE(brand_name,''),start_date,price_min,price_max) WHERE end_date IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rc_fixed_fee_uniq_active ON rc_fixed_fee
  (marketplace,seller_account,category,COALESCE(fulfilment_type,''),start_date,price_min,price_max) WHERE end_date IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rc_collection_fee_uniq_active ON rc_collection_fee
  (marketplace,seller_account,category,COALESCE(fulfilment_type,''),start_date,price_min,price_max) WHERE end_date IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rc_reverse_shipping_uniq_portal_active ON rc_reverse_shipping
  (marketplace,seller_account,category,weight_slab,start_date,price_min,price_max) WHERE end_date IS NULL;

-- The previous index cannot represent two weight slabs at the same order value.
DROP INDEX IF EXISTS rc_pick_pack_uniq_active;
DROP INDEX IF EXISTS rc_pick_pack_uniq_period;
CREATE UNIQUE INDEX IF NOT EXISTS rc_pick_pack_uniq_portal_active ON rc_pick_pack
  (marketplace,seller_account,category,COALESCE(fulfilment_type,''),COALESCE(weight_min,0),COALESCE(weight_max,999999),start_date,price_min,price_max) WHERE end_date IS NULL;
COMMIT;
