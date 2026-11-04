import { describe, it, expect } from 'vitest';
import {
  RATE_CARD_DIMENSIONAL_SCHEMA_VERSION,
  runRateCardDimensionalMigration,
} from '../db/rateCardDimensionalMigration.js';

// Guards the RATE_SCHEMA_NOT_READY publish blocker: the readiness gate in
// backend/services/rateCardPublisher.js refuses every publish until 5 unique
// indexes and 21 dimensional columns exist. jobs-1/jobs-2 provide
// rc_fixed_fee_uniq_active + rc_collection_fee_uniq_active; this migration
// must provide the remaining 3 index names and all 18 missing columns.
const GATE_INDEXES = [
  'rc_commission_uniq_portal_active',
  'rc_reverse_shipping_uniq_portal_active',
  'rc_pick_pack_uniq_portal_active',
];
const GATE_COLUMNS = {
  rc_reverse_shipping: [
    'weight_min', 'weight_max', 'base_weight', 'increment_weight',
    'local_additional_fee', 'zonal_additional_fee', 'national_additional_fee',
  ],
  rc_pick_pack: [
    'weight_min', 'weight_max', 'base_weight', 'increment_weight',
    'local_fee', 'zonal_fee', 'national_fee',
    'local_additional_fee', 'zonal_additional_fee', 'national_additional_fee',
    'price_scope',
  ],
};

async function captureMigration() {
  const statements = [];
  const tx = { query: async (sql) => { statements.push(sql); return { rows: [] }; } };
  const runVersionedMigration = async (pool, version, migrate) => {
    expect(version).toBe(RATE_CARD_DIMENSIONAL_SCHEMA_VERSION);
    await migrate(tx);
    return true;
  };
  const result = await runRateCardDimensionalMigration({}, runVersionedMigration);
  return { result, sql: statements.join('\n') };
}

describe('rate-card dimensional migration (jobs-3)', () => {
  it('runs under the jobs-3 version key and reports success', async () => {
    expect(RATE_CARD_DIMENSIONAL_SCHEMA_VERSION).toBe('2026.10.ratecard-worker-jobs-3');
    const { result } = await captureMigration();
    expect(result).toBe(true);
  });

  it('creates the portal-active unique indexes the publish gate requires', async () => {
    const { sql } = await captureMigration();
    for (const index of GATE_INDEXES) {
      expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${index}`);
    }
  });

  it('adds every dimensional column the publish gate counts', async () => {
    const { sql } = await captureMigration();
    for (const [table, columns] of Object.entries(GATE_COLUMNS)) {
      for (const column of columns) {
        expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`);
      }
    }
  });

  it('backfills pick-pack zonal/national fees from the flat rate', async () => {
    const { sql } = await captureMigration();
    expect(sql).toMatch(/UPDATE rc_pick_pack SET local_fee = rate WHERE local_fee IS NULL/);
    expect(sql).toMatch(/UPDATE rc_pick_pack SET zonal_fee = rate WHERE zonal_fee IS NULL/);
    expect(sql).toMatch(/UPDATE rc_pick_pack SET national_fee = rate WHERE national_fee IS NULL/);
    expect(sql).toMatch(/UPDATE rc_pick_pack SET price_scope = 'range' WHERE price_scope IS NULL/);
  });

  it('enforces the Shopsy 0% commission policy for new writes', async () => {
    const { sql } = await captureMigration();
    expect(sql).toContain('rc_commission_shopsy_zero_rate');
    expect(sql).toMatch(/CHECK \(marketplace <> 'shopsy' OR rate = 0\) NOT VALID/);
  });

  it('deduplicates active rows before creating unique indexes', async () => {
    const { sql } = await captureMigration();
    expect(sql).toMatch(/DELETE FROM rc_commission a USING rc_commission b/);
    expect(sql).toMatch(/DELETE FROM rc_reverse_shipping a USING rc_reverse_shipping b/);
    expect(sql).toMatch(/DELETE FROM rc_pick_pack a USING rc_pick_pack b/);
  });
});
