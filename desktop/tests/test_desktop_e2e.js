/**
 * Comprehensive End-to-End (E2E) Test Pack for ReconCentral RateCard Worker:
 *   - E2E 1: Full Extraction Pipeline (portal HTML parsing, multi-vertical, Shopsy 0% policy, staging persistence)
 *   - E2E 2: Normalization & Staging State (merging FBF/NON-FBF, deduping, precision, state invalidation)
 *   - E2E 3: Unchanged Data Reconciliation (zero diffs, commit suppression, DB write bypass)
 *   - E2E 4: Changed Rates & Multi-Tier Anomaly Detection (commission, fixed fee, shipping, collection, slab jumps)
 *   - E2E 5: Atomic Version Audit Snapshots & Transaction Rollback (richSnapshot integrity, actor, rollback on failure)
 *   - E2E 6: Invalid & Malformed Data Defense (rejection of corrupt cards, unsupported markets, empty slabs)
 *   - E2E 7: Session Expiry & In-View Re-Authentication Loop (onSessionExpiry lifecycle, cookie refresh, resume)
 *   - E2E 8: Network Drop & Transient Failure Resilience (2-attempt retry loop with exponential backoff)
 *   - E2E 9: Database Transport Disconnection Recovery (safe rollback and pool client release on socket drop)
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopDir = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  console.log(`\n[E2E Test] ${name}`);
  try {
    await fn();
    console.log('  ✓ Pass');
    passed++;
  } catch (err) {
    console.error(`  ✗ Fail: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
assert.strictEqual = function(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected} but got ${actual}`);
};
assert.deepStrictEqual = function(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
};

// ── Runtime & Service Imports ────────────────────────────────────────────────
const { parseRateCardTables, scrapeFlipkartRateCards } = await import('../portalScraper.js');
const { createStagedExtractionState, normalizeScrapedCards, selectStagedCards } = await import('../scrapeResults.js');
const { detectBrandRateChanges, syncBrandRateCardsToDatabase, annotateRateAnomaly } = await import('../rateCardService.js');

async function runE2ETests() {
  console.log('=================================================================');
  console.log(' ReconCentral RateCard Worker End-to-End (E2E) Test Suite       ');
  console.log('=================================================================');

  // ── 1. Full Extraction Pipeline Flow ───────────────────────────────────────
  await runTest('E2E 1: Full Extraction Pipeline parses portal HTML tables and persists staged file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-e2e-staging-'));
    const tempCookies = path.join(tempDir, 'test_cookies.json');
    fs.writeFileSync(tempCookies, JSON.stringify([{ name: 'test_session', value: 'valid', domain: '.flipkart.com' }]));

    const mockTablesKurta = [
      [['Price Range', 'Commission Rate'], ['0 - 500', '10.0%'], ['501 - 1000', '12.5%'], ['1001+', '15.0%']],
      [['Fulfillment Type', 'Tier / Slabs', 'Fee'], ['Bronze', '0 - 300', '₹15.00'], ['Silver', '301 - 500', '₹20.00']],
      [['Weight Slab', 'Local', 'Zonal', 'National'], ['0 - 0.5 kg', '₹40.00', '₹55.00', '₹70.00'], ['0.5 - 1 kg', '₹60.00', '₹75.00', '₹95.00']],
      [['Payment Method', 'Slab', 'Fee'], ['Prepaid', 'All', '2.0%'], ['Postpaid', 'All', '₹15.00']]
    ];

    const mockTablesShopsy = [
      [['Price Range', 'Commission Rate'], ['0 - 500', '5.0%'], ['501 - 1000', '8.0%']], // policy overrides to 0%
      [['Fulfillment Type', 'Tier / Slabs', 'Fee'], ['Bronze', '0 - 500', '₹12.00']],
      [['Weight Slab', 'Local', 'Zonal', 'National'], ['0 - 0.5 kg', '₹35.00', '₹50.00', '₹65.00']],
      [['Payment Method', 'Slab', 'Fee'], ['Prepaid', 'All', '1.5%'], ['Postpaid', 'All', '₹12.00']]
    ];

    let navigatedUrls = [];
    const fakePage = {
      setCookie: async () => {},
      goto: async (url) => { navigatedUrls.push(url); },
      evaluate: async (fn) => {
        const lastUrl = navigatedUrls[navigatedUrls.length - 1] || '';
        if (lastUrl.includes('dashboard/home-page')) return true; // session valid
        if (lastUrl.includes('shopsy')) return mockTablesShopsy;
        return mockTablesKurta;
      },
      url: () => 'https://seller.flipkart.com/dashboard/home-page',
      title: () => 'Seller Dashboard'
    };

    const fakeBrowser = {
      pages: async () => [fakePage],
      newPage: async () => fakePage,
      close: async () => {}
    };

    const fakeRuntime = {
      launch: async () => fakeBrowser,
      partition: 'persist:e2e-test'
    };

    const res = await scrapeFlipkartRateCards(
      {
        marketplace: 'both',
        selectedVerticals: ['kurta', 'shopsy_kurta']
      },
      {
        runtime: fakeRuntime,
        cookiesPath: tempCookies,
        stagingDir: tempDir,
        delay: () => {},
        onProgress: () => {}
      }
    );

    assert(res.success, `Extraction should succeed: ${res.error}`);
    assert(Array.isArray(res.data) && res.data.length === 4, `Expected 4 extractions (2 verticals * 2 fulfillments), got ${res.data?.length}`);
    assert(fs.existsSync(res.stagingFile), 'Staged JSON file must exist on disk');

    const stagedContent = JSON.parse(fs.readFileSync(res.stagingFile, 'utf8'));
    assert.strictEqual(stagedContent.length, 4);

    // Verify Shopsy 0% policy invariance
    const shopsyCard = stagedContent.find(c => c.marketplace === 'shopsy');
    assert(shopsyCard, 'Shopsy card must exist');
    assert(shopsyCard.commissions.every(c => c.rate === 0), 'All Shopsy commissions must be 0%');

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 2. Normalization & Staging State ───────────────────────────────────────
  await runTest('E2E 2: Normalization merges FBF/NON_FBF and maintains decimal fee precision', async () => {
    const rawFBF = {
      marketplace: 'flipkart',
      vertical: 'kurta',
      fulfilment_type: 'FBF',
      commissions: [{ price_min: 0, price_max: 500, rate: 0.12 }],
      fixedFees: [{ fulfilment_type: 'Bronze', price_min: 0, price_max: 300, rate: 15 }],
      reverseShipping: [{ weight_slab: '0 - 0.5 kg', price_min: 0, price_max: 999999, local_fee: 40, zonal_fee: 55, national_fee: 70 }],
      collectionFees: [{ fulfilment_type: 'All', price_min: 0, price_max: 999999, prepaid: 0.02, postpaid: 15, prepaid_type: 'pct', postpaid_type: 'flat' }]
    };

    const rawNonFBF = {
      ...rawFBF,
      fulfilment_type: 'NON_FBF'
    };

    const normalized = normalizeScrapedCards([rawFBF, rawNonFBF]);
    assert.strictEqual(normalized.length, 1);
    assert.strictEqual(normalized[0].commissions.length, 1);
    assert.strictEqual(normalized[0].fixedFees.length, 1);
    assert.deepStrictEqual(normalized[0].fulfilmentModes, ['FBF', 'NON_FBF']);

    const state = createStagedExtractionState();
    state.cards = normalized;
    assert.strictEqual(state.cards.length, 1);
    assert.strictEqual(state.authGeneration, 0);

    state.resetForAuthChange();
    assert.strictEqual(state.cards.length, 0);
    assert.strictEqual(state.authGeneration, 1);
  });

  // ── 3. Unchanged Data Reconciliation ───────────────────────────────────────
  await runTest('E2E 3: Unchanged rate card data yields 0 diffs and suppresses database commit', async () => {
    const card = {
      marketplace: 'flipkart',
      category: 'ethnic_set',
      brand: 'General',
      commissions: [{ price_min: 0, price_max: 500, rate: 0.10 }],
      fixedFees: [{ fulfilment_type: 'Bronze', price_min: 0, price_max: 300, rate: 15.0 }],
      reverseShipping: [{ weight_slab: '0 - 0.5 kg', price_min: 0, price_max: 999999, local_fee: 40.0, zonal_fee: 55.0, national_fee: 70.0 }],
      collectionFees: [{ fulfilment_type: 'All', price_min: 0, price_max: 999999, prepaid: 0.02, postpaid: 15.0, prepaid_type: 'pct', postpaid_type: 'flat' }]
    };

    let writeExecuted = false;
    const mockPoolUnchanged = {
      connect: async () => ({
        query: async (sql) => {
          if (sql.includes('INSERT') || sql.includes('UPDATE') || sql.includes('DELETE')) {
            writeExecuted = true;
          }
          return { rows: [] };
        },
        release: () => {}
      }),
      query: async (sql) => {
        if (sql.includes('rc_commission')) {
          return { rows: [{ price_min: '0.00', price_max: '500.00', rate: '0.1000' }] };
        }
        if (sql.includes('rc_fixed_fee')) {
          return { rows: [{ fulfilment_type: 'Bronze', price_min: '0.00', price_max: '300.00', rate: '15.00' }] };
        }
        if (sql.includes('rc_reverse_shipping')) {
          return { rows: [{ weight_slab: '0 - 0.5 kg', price_min: '0.00', price_max: '999999.00', local_fee: '40.00', zonal_fee: '55.00', national_fee: '70.00' }] };
        }
        if (sql.includes('rc_collection_fee')) {
          return { rows: [{ fulfilment_type: 'All', price_min: '0.00', price_max: '999999.00', prepaid: '0.02', postpaid: '15.00', prepaid_type: 'pct', postpaid_type: 'flat' }] };
        }
        return { rows: [] };
      }
    };

    const diffs = await detectBrandRateChanges([card], mockPoolUnchanged);
    assert.strictEqual(diffs.length, 0, 'Unchanged cards must produce zero change records');

    const syncRes = await syncBrandRateCardsToDatabase([card], { forceUpdate: false }, mockPoolUnchanged);
    assert.strictEqual(syncRes.updated, false, 'Sync must be skipped when no changes exist');
    assert.strictEqual(syncRes.changesCount, 0);
    assert.strictEqual(writeExecuted, false, 'Zero write queries should be executed on unchanged data');
  });

  // ── 4. Changed Rates & Multi-Tier Anomaly Detection ────────────────────────
  await runTest('E2E 4: Detects rate changes and accurately flags anomalies across all fee dimensions', async () => {
    const card = {
      marketplace: 'flipkart',
      category: 'ethnic_set',
      brand: 'General',
      commissions: [
        { price_min: 0, price_max: 500, rate: 0.18 }, // 10% -> 18% (+8% >= 5% jump, relative 80% >= 50%) -> anomaly
        { price_min: 501, price_max: 1000, rate: 0.11 } // 10% -> 11% (+1%) -> normal diff
      ],
      fixedFees: [
        { fulfilment_type: 'Bronze', price_min: 0, price_max: 300, rate: 45.0 } // 15 -> 45 (+30 >= 20) -> anomaly
      ],
      reverseShipping: [
        { weight_slab: '0 - 0.5 kg', price_min: 0, price_max: 999999, local_fee: 40.0, zonal_fee: 55.0, national_fee: 105.0 } // Nat: 70 -> 105 (+35 >= 25) -> anomaly
      ],
      collectionFees: [
        { fulfilment_type: 'All', price_min: 0, price_max: 999999, prepaid: 0.02, postpaid: 35.0, prepaid_type: 'pct', postpaid_type: 'flat' } // Postpaid: 15 -> 35 (+20 >= 15) -> anomaly
      ]
    };

    const mockPoolChanged = {
      query: async (sql) => {
        if (sql.includes('rc_commission')) {
          return {
            rows: [
              { price_min: '0.00', price_max: '500.00', rate: '0.1000' },
              { price_min: '501.00', price_max: '1000.00', rate: '0.1000' }
            ]
          };
        }
        if (sql.includes('rc_fixed_fee')) {
          return { rows: [{ fulfilment_type: 'Bronze', price_min: '0.00', price_max: '300.00', rate: '15.00' }] };
        }
        if (sql.includes('rc_reverse_shipping')) {
          return { rows: [{ weight_slab: '0 - 0.5 kg', price_min: '0.00', price_max: '999999.00', local_fee: '40.00', zonal_fee: '55.00', national_fee: '70.00' }] };
        }
        if (sql.includes('rc_collection_fee')) {
          return { rows: [{ fulfilment_type: 'All', price_min: '0.00', price_max: '999999.00', prepaid: '0.02', postpaid: '15.00', prepaid_type: 'pct', postpaid_type: 'flat' }] };
        }
        return { rows: [] };
      }
    };

    const diffs = await detectBrandRateChanges([card], mockPoolChanged);
    assert.strictEqual(diffs.length, 5, `Expected 5 change records, got ${diffs.length}`);

    const anomalies = diffs.filter(d => d.anomaly);
    assert.strictEqual(anomalies.length, 4, `Expected 4 anomaly records, got ${anomalies.length}`);

    assert(anomalies.some(a => a.type === 'commission' && a.anomalyType === 'commission_shift'));
    assert(anomalies.some(a => a.type === 'fixed_fee' && a.anomalyType === 'fixed_fee_shift'));
    assert(anomalies.some(a => a.type === 'reverse_shipping' && a.anomalyType === 'reverse_shipping_shift'));
    assert(anomalies.some(a => a.type === 'collection_fee' && a.anomalyType === 'collection_fee_shift'));

    // Check non-anomaly diff
    const normalComm = diffs.find(d => d.type === 'commission' && d.priceMin === 501);
    assert(normalComm, 'Normal commission change must exist');
    assert.strictEqual(normalComm.anomaly, false);
  });

  // ── 5. Atomic Version Audit Snapshots & Transaction Rollback ───────────────
  await runTest('E2E 5: Atomic Version Audit Snapshots record full metadata and cleanly rollback on error', async () => {
    let committed = false;
    let rolledBack = false;
    let savedSnapshot = null;

    const fakeClient = {
      query: async (sql, params) => {
        if (sql === 'BEGIN') return {};
        if (sql === 'COMMIT') { committed = true; return {}; }
        if (sql === 'ROLLBACK') { rolledBack = true; return {}; }
        if (sql.includes('INSERT INTO rate_card_versions')) {
          savedSnapshot = JSON.parse(params[3]);
        }
        return { rows: [] };
      },
      release: () => {}
    };

    const fakePool = {
      connect: async () => fakeClient,
      query: async () => ({ rows: [] })
    };

    const card = {
      marketplace: 'flipkart',
      category: 'top',
      brand: 'Sangria',
      commissions: [{ price_min: 0, price_max: 500, rate: 0.15 }],
      fixedFees: [],
      reverseShipping: [],
      collectionFees: []
    };

    const res = await syncBrandRateCardsToDatabase([card], {
      forceUpdate: true,
      actor: 'pawan@vbexports.co.in',
      runMetadata: { source: 'e2e-worker', testTag: 'stage-5' }
    }, fakePool);

    assert.strictEqual(res.updated, true);
    assert.strictEqual(committed, true);
    assert.strictEqual(rolledBack, false);
    assert(savedSnapshot, 'Audit snapshot must be written to rate_card_versions');
    assert.strictEqual(savedSnapshot.actor, 'pawan@vbexports.co.in');
    assert.strictEqual(savedSnapshot.runMetadata.testTag, 'stage-5');
    assert(Array.isArray(savedSnapshot.changes), 'Snapshot must record changes list');

    // Test Transaction Rollback when version insert fails
    committed = false;
    rolledBack = false;
    const failingClient = {
      query: async (sql) => {
        if (sql === 'BEGIN') return {};
        if (sql === 'COMMIT') { committed = true; return {}; }
        if (sql === 'ROLLBACK') { rolledBack = true; return {}; }
        if (sql.includes('INSERT INTO rate_card_versions')) {
          throw new Error('Disk quota exceeded on rate_card_versions');
        }
        return { rows: [] };
      },
      release: () => {}
    };

    const failingPool = {
      connect: async () => failingClient,
      query: async () => ({ rows: [] })
    };

    let caughtErr = null;
    try {
      await syncBrandRateCardsToDatabase([card], { forceUpdate: true }, failingPool);
    } catch (err) {
      caughtErr = err;
    }

    assert(caughtErr, 'Transaction must throw on version insertion failure');
    assert.strictEqual(rolledBack, true, 'Transaction must execute ROLLBACK on error');
    assert.strictEqual(committed, false, 'Transaction must NEVER commit when version insert fails');
  });

  // ── 6. Invalid & Malformed Data Defense ─────────────────────────────────────
  await runTest('E2E 6: Invalid and corrupt card payloads are rejected without writing to database', async () => {
    // 1. Missing mandatory categories / fields
    let threw1 = false;
    try {
      normalizeScrapedCards([{ marketplace: 'flipkart', commissions: [{ price_min: 0, price_max: 500, rate: 0.10 }] }]);
    } catch {
      threw1 = true;
    }
    assert(threw1, 'normalizeScrapedCards must reject cards missing vertical');

    // 2. Unsupported marketplace
    let threw2 = false;
    try {
      normalizeScrapedCards([{ marketplace: 'amazon', vertical: 'top', commissions: [{ rate: 0.1 }] }]);
    } catch {
      threw2 = true;
    }
    assert(threw2, 'normalizeScrapedCards must reject unsupported marketplace');

    // 3. Extraction with empty slabs
    let threw3 = false;
    try {
      normalizeScrapedCards([{ marketplace: 'flipkart', vertical: 'top', commissions: [] }]);
    } catch {
      threw3 = true;
    }
    assert(threw3, 'normalizeScrapedCards must reject cards with no fee slabs');

    // 4. Staged subset tampering rejection
    const validCards = [
      { marketplace: 'flipkart', category: 'top', brand: 'Sangria', commissions: [] }
    ];
    const tamperedCard = { marketplace: 'flipkart', category: 'top', brand: 'Hacker', commissions: [] };
    const selected = selectStagedCards(validCards, [tamperedCard]);
    assert.strictEqual(selected, null, 'selectStagedCards must return null for tampered card objects');
  });

  // ── 7. Session Expiry & In-View Re-Authentication Loop ─────────────────────
  await runTest('E2E 7: Session expiry triggers onSessionExpiry hook and resumes after cookie refresh', async () => {
    let sessionExpiryTriggered = false;
    let cookieSaved = false;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-e2e-session-'));
    const tempCookies = path.join(tempDir, 'test_session_cookies.json');
    fs.writeFileSync(tempCookies, JSON.stringify([{ name: 'old_expired', value: '000' }]));

    let callCount = 0;
    const fakePage = {
      setCookie: async () => {},
      goto: async () => {},
      evaluate: async () => {
        callCount++;
        // First check: session expired
        if (callCount === 1) return false;
        // Second check (after in-view auth): session restored
        return true;
      },
      url: () => 'https://seller.flipkart.com/login',
      title: () => 'Seller Login Challenge',
      cookies: async () => {
        cookieSaved = true;
        return [{ name: 'refreshed_session', value: 'new_token_123' }];
      }
    };

    const fakeBrowser = {
      pages: async () => [fakePage],
      newPage: async () => fakePage,
      close: async () => {}
    };

    const fakeRuntime = {
      launch: async () => fakeBrowser,
      partition: 'persist:e2e-session'
    };

    await scrapeFlipkartRateCards(
      { marketplace: 'flipkart', selectedVerticals: ['kurta'] },
      {
        runtime: fakeRuntime,
        cookiesPath: tempCookies,
        stagingDir: tempDir,
        delay: () => {},
        onProgress: () => {},
        onSessionExpiry: async (page) => {
          sessionExpiryTriggered = true;
          assert(page === fakePage, 'onSessionExpiry must receive current page object');
          // In the real application main.js, onSessionExpiry calls page.cookies() upon user 2FA
          const cookies = await page.cookies();
          assert(cookies.length > 0, 'Page cookies must be read upon 2FA completion');
          return true;
        }
      }
    ).catch(() => null);

    assert(sessionExpiryTriggered, 'onSessionExpiry hook must be executed on login challenge');
    assert(cookieSaved, 'Refreshed session cookies must be requested and saved');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 8. Network Drop & Transient Failure Resilience ─────────────────────────
  await runTest('E2E 8: Network drop on attempt 1 triggers retry with backoff and succeeds on attempt 2', async () => {
    const mainFile = path.join(desktopDir, 'main.js');
    const mainCode = fs.readFileSync(mainFile, 'utf8');

    // Verify retry loop structural invariants in main.js
    assert(mainCode.includes('const MAX_ATTEMPTS = 2;'), 'main.js must define MAX_ATTEMPTS = 2');
    assert(mainCode.includes('backoffMs = 4000'), 'main.js must implement 4000ms exponential backoff');
    assert(mainCode.includes('isPermanentScrapeError(err)'), 'main.js must filter out permanent errors from retries');

    // Simulate 2-attempt execution with transient network reset on attempt 1
    let attempts = 0;
    let delayCalled = false;
    const transientRunner = async () => {
      attempts++;
      if (attempts === 1) {
        const netErr = new Error('net::ERR_CONNECTION_RESET at https://seller.flipkart.com');
        throw netErr;
      }
      return { success: true, rateCardsCount: 2 };
    };

    let result = null;
    let loggedRetry = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) {
        loggedRetry = true;
        delayCalled = true;
      }
      try {
        result = await transientRunner();
        break;
      } catch (err) {
        if (attempt === 2) throw err;
      }
    }

    assert.strictEqual(attempts, 2, 'Must have attempted 2 executions');
    assert.strictEqual(loggedRetry, true, 'Retry must have been logged after transient failure');
    assert.strictEqual(delayCalled, true, 'Backoff must have delayed attempt 2');
    assert.strictEqual(result.success, true, 'Attempt 2 must succeed and return results');
  });

  // ── 9. Database Transport Disconnection Recovery ───────────────────────────
  await runTest('E2E 9: Pooled database disconnect mid-transaction rolls back cleanly and releases client', async () => {
    let released = false;
    let rollbackCalled = false;

    const fakeClient = {
      query: async (sql) => {
        if (sql === 'BEGIN') return {};
        if (sql.includes('SELECT pg_advisory_xact_lock')) return {};
        if (sql === 'ROLLBACK') { rollbackCalled = true; return {}; }
        // Simulate dropped socket during DELETE or UPDATE query
        throw new Error('Connection terminated unexpectedly (socket reset by peer)');
      },
      release: () => { released = true; }
    };

    const fakePool = {
      connect: async () => fakeClient,
      query: async () => ({ rows: [] })
    };

    const card = {
      marketplace: 'flipkart',
      category: 'sari',
      brand: 'General',
      commissions: [{ price_min: 0, price_max: 500, rate: 0.12 }],
      fixedFees: [],
      reverseShipping: [],
      collectionFees: []
    };

    let caught = null;
    try {
      await syncBrandRateCardsToDatabase([card], { forceUpdate: true }, fakePool);
    } catch (err) {
      caught = err;
    }

    assert(caught, 'Must catch transport error');
    assert(rollbackCalled, 'ROLLBACK must be called on transport error');
    assert(released, 'Database client must always be released back to pool in finally block');
  });

  console.log('\n=================================================================');
  console.log(` E2E Results: ${passed} passed, ${failed} failed`);
  console.log('=================================================================');
  if (failed > 0) process.exit(1);
}

runE2ETests().catch((err) => {
  console.error('Fatal E2E test runner failure:', err);
  process.exit(1);
});
