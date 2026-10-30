import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  getStagingDb,
  saveStagedJob,
  saveStagedObservations,
  getStagedObservations,
  markStagedJobStatus,
  clearStagedJob,
  closeStagingDb
} from '../localStaging.js';

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  process.stdout.write(`[Staging Test] ${name} ... `);
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
  const tmpDir = path.join(os.tmpdir(), `rc-staging-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    let db = getStagingDb(tmpDir);

    await runTest('Initializes SQLite staging database with WAL mode', () => {
      assert(db !== null, 'DB instance should not be null');
      const mode = db.pragma('journal_mode', { simple: true });
      assert(mode === 'wal', `Expected WAL journal mode, got ${mode}`);
    });

    await runTest('Saves staged job and observations to disk', () => {
      saveStagedJob(db, {
        id: 'job-101',
        remote_job_id: 1234,
        marketplace: 'flipkart',
        seller_account: 'default',
        status: 'staged',
        parameters: { verticals: ['kurta', 'gown'] }
      });

      const observations = [
        {
          vertical: 'kurta',
          fulfilment_type: 'Bronze',
          commissions: [{ rate: 0.12, price_min: 0, price_max: 1500 }],
          fixedFees: [{ rate: 10, price_min: 0, price_max: 1500 }]
        },
        {
          vertical: 'gown',
          fulfilment_type: 'Bronze',
          commissions: [{ rate: 0.15, price_min: 0, price_max: 1500 }],
          fixedFees: [{ rate: 10, price_min: 0, price_max: 1500 }]
        }
      ];

      saveStagedObservations(db, 'job-101', observations);

      const staged = getStagedObservations(db, 'job-101');
      assert(staged.length === 2, `Expected 2 observations, got ${staged.length}`);
      assert(staged[0].vertical === 'kurta', `First vertical should be kurta`);
      assert(staged[0].commissions[0].rate === 0.12, `Rate should be 0.12`);
      assert(staged[1].vertical === 'gown', `Second vertical should be gown`);

      // Verify physical file was written to disk
      const stagingFilePath = path.join(tmpDir, 'staging.db');
      assert(fs.existsSync(stagingFilePath), 'staging.db file must exist on disk');
      const stats = fs.statSync(stagingFilePath);
      assert(stats.size > 0, `staging.db must have non-zero size, got ${stats.size} bytes`);
    });

    await runTest('Survives database close and reload from disk (crash resilience)', () => {
      closeStagingDb();
      // Reopen fresh from the same directory
      const reopenedDb = getStagingDb(tmpDir);
      const staged = getStagedObservations(reopenedDb, 'job-101');
      assert(staged.length === 2, `Expected 2 observations preserved after reload, got ${staged.length}`);
      assert(staged[0].vertical === 'kurta', `Preserved vertical should be kurta`);
      db = reopenedDb;
    });

    await runTest('Updates job status and clears completed job', () => {
      markStagedJobStatus(db, 'job-101', 'submitted');
      clearStagedJob(db, 'job-101');
      const stagedAfter = getStagedObservations(db, 'job-101');
      assert(stagedAfter.length === 0, `Observations should be cleared after completion`);
    });

    closeStagingDb();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\nStaging tests summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
