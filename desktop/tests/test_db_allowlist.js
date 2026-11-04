import { ALLOWED_TABLES, READ_ONLY_TABLES, uploadTableUpdates } from '../db.js';

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  process.stdout.write(`[DB Allowlist Test] ${name} ... `);
  try {
    await fn();
    console.log('✓ PASS');
    passed++;
  } catch (err) {
    console.log(`✗ FAIL: ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function main() {
  await runTest('Covers every backend rate-card table in TABLE_MAP', () => {
    for (const table of [
      'rc_commission',
      'rc_fixed_fee',
      'rc_collection_fee',
      'rc_reverse_shipping',
      'rc_pick_pack',
      'rc_franchise_fee',
      'rate_card_versions',
    ]) {
      assert(ALLOWED_TABLES.has(table), `Allowlist is missing rate-card table "${table}"`);
    }
  });

  await runTest('Still guards non-rate tables behind the allowlist', () => {
    assert(!ALLOWED_TABLES.has('pg_shadow'), 'Arbitrary tables must stay blocked');
    assert(!ALLOWED_TABLES.has('worker_jobs'), 'Worker queue internals must stay blocked');
  });

  await runTest('Rate tables are read-only for desktop upserts (bypass-proof)', async () => {
    for (const table of ['rc_commission', 'rc_pick_pack', 'rc_franchise_fee', 'rate_card_versions']) {
      assert(READ_ONLY_TABLES.has(table), `Write guard is missing rate table "${table}"`);
      let error = null;
      try {
        await uploadTableUpdates(table, [{ id: 1, rate: 0 }]);
      } catch (err) {
        error = err;
      }
      assert(error && /read-only/.test(error.message), `Upsert to "${table}" must be refused before any database access`);
    }
  });

  await runTest('Non-rate tables still reject unknown names before connecting', async () => {
    let error = null;
    try {
      await uploadTableUpdates('pg_shadow', [{ id: 1 }]);
    } catch (err) {
      error = err;
    }
    assert(error && /not in the allowed update allowlist/.test(error.message), 'Unknown tables must stay blocked');
  });

  console.log(`\nDone: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
