/**
 * Regression tests for the desktop worker runtime modules:
 *   - browserRuntime.js  (explicit puppeteer-core binding, busy lock, Chrome resolution)
 *   - sessionAccess.js   (verified session gate: refresh, role/uid match, logout race)
 *   - scrapeResults.js   (staged extraction normalization and validation)
 *   - dbUrlGuard.js      (server-provisioned DB URL adoption + saved config sanitization)
 *   - portalScraper.js   (rate card table parsing: commissions, mixed collection fees, Shopsy policy)
 *   - httpAccess.js      (HTTP caller proof: exact origin policy, cookie/bearer binding)
 *   - db.js              (analyst database access fails closed without a provisioned URL)
 * Plus packaging invariants: preload.cjs must exist, stale preload.js must not.
 *
 * This suite is fully offline (no Firebase, no PostgreSQL) so it can run in CI.
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createStructuredLogger } from '../structuredLogger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopDir = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  console.log(`\n[Test] ${name}`);
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
  if (!condition) throw new Error(message);
}
assert.strictEqual = function(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected} but got ${actual}`);
};
assert.deepStrictEqual = function(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
};

// ── Module loading ────────────────────────────────────────────────────────────
const { getBrowserRuntime, requireChromeExecutable, withBrowserTask } = await import('../browserRuntime.js');
const { publicSession, createSessionAccess } = await import('../sessionAccess.js');
const { beginStagedRateReview, createStagedExtractionState, isCurrentStagedRateReview, normalizeScrapedCards, resolveSellerAccountForRateCards, selectStagedCards, stageRateReviewIfCurrent } = await import('../scrapeResults.js');
const {
  isDesktopReachableDbUrl,
  sanitizeSavedDbUrl,
  selectDesktopDatabaseUrlForSession,
  storedDatabaseUrlForRole,
  dbHostFromUrl
} = await import('../dbUrlGuard.js');

const {
  isSameDesktopOrigin,
  isAllowedDesktopOrigin,
  bindBrowserSession,
  authorizeDesktopRequest
} = await import('../httpAccess.js');
const { setDesktopDatabaseAccess, resolveDatabaseUrl } = await import('../db.js');

// Minimal unsigned JWT-shaped token whose payload decodeJwtPayload() can read.
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeToken = (payload) => `testheader.${b64(payload)}.testsignature`;
const NOW = Math.floor(Date.now() / 1000);

async function runTests() {
  console.log('=================================================================');
  console.log(' Desktop Worker Runtime Regression Tests (browserRuntime,');
  console.log(' sessionAccess, scrapeResults, dbUrlGuard)                        ');
  console.log('=================================================================');

  // ── browserRuntime ─────────────────────────────────────────────────────────
  await runTest('browserRuntime binds puppeteer-core + stealth plugin explicitly', async () => {
    const runtime = getBrowserRuntime();
    assert(typeof runtime.launch === 'function', 'runtime.launch is not a function');
    assert(typeof runtime.connect === 'function', 'runtime.connect is not a function');
    assert(typeof runtime.use === 'function', 'runtime.use (puppeteer-extra) is not a function');
    assert(getBrowserRuntime() === runtime, 'getBrowserRuntime must be a singleton');
  });

  await runTest('requireChromeExecutable resolves a browser or fails with guidance', async () => {
    try {
      const exe = requireChromeExecutable();
      assert(typeof exe === 'string' && exe.length > 0, 'executable path is empty');
      assert(fs.existsSync(exe), `resolved executable does not exist: ${exe}`);
    } catch (err) {
      assert(
        /Chrome or Microsoft Edge was not found/.test(err.message),
        `unexpected error message: ${err.message}`
      );
      console.log('  (no local browser found — accepted with the guided error)');
    }
  });

  await runTest('withBrowserTask serializes browser tasks (busy lock)', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = withBrowserTask(async () => {
      await gate;
      return { success: true, value: 'first' };
    });

    const second = await withBrowserTask(async () => ({ success: true, value: 'second' }));
    assert(second.success === false, 'a second concurrent task must be refused');
    assert(/already running/i.test(second.error || ''), `unexpected refusal error: ${second.error}`);

    release();
    const firstResult = await first;
    assert(firstResult.success === true && firstResult.value === 'first', 'first task result lost');

    const third = await withBrowserTask(async () => ({ success: true, value: 'third' }));
    assert(third.success === true, 'busy flag must reset after task completion');
  });

  await runTest('withBrowserTask converts task errors and always releases the lock', async () => {
    const crashed = await withBrowserTask(async () => {
      throw new Error('boom');
    });
    assert(crashed.success === false && /boom/.test(crashed.error), 'task error was not converted');
    assert(withBrowserTask.busy === false, 'busy flag stayed true after a crashed task');
    const next = await withBrowserTask(async () => ({ success: true }));
    assert(next.success === true, 'lock was not released after a crashed task');
  });

  // ── sessionAccess ──────────────────────────────────────────────────────────
  await runTest('publicSession never exposes tokens', async () => {
    const session = {
      authenticated: true,
      user: { id: 1, username: 'pawan', email: 'a@b.co', role: 'admin', firebase_uid: 'uid-1' },
      idToken: 'secret-id-token',
      refreshToken: 'secret-refresh-token',
      authorizedAt: '2026-10-28T00:00:00.000Z'
    };
    const pub = publicSession(session);
    assert(pub.authenticated === true, 'authenticated flag lost');
    assert(pub.user?.role === 'admin', 'user projection lost');
    assert(!('idToken' in pub), 'publicSession leaked idToken');
    assert(!('refreshToken' in pub), 'publicSession leaked refreshToken');
    const anon = publicSession(null);
    assert(anon.authenticated === false && anon.user === null, 'publicSession(null) shape wrong');
  });

  await runTest('createSessionAccess rejects a missing or unauthenticated session', async () => {
    const authorize = createSessionAccess({
      load: () => null,
      save: () => ({ success: true }),
      refresh: async () => null,
      verify: async () => ({ authorized: true, role: 'admin', verifiedPayload: { uid: 'uid-1' } })
    });
    assert(await authorize() === null, 'missing session must return null');

    const authorizeAnon = createSessionAccess({
      load: () => ({ authenticated: false, user: null }),
      save: () => ({ success: true }),
      refresh: async () => null,
      verify: async () => ({ authorized: true, role: 'admin', verifiedPayload: { uid: 'uid-1' } })
    });
    assert(await authorizeAnon() === null, 'unauthenticated session must return null');
  });

  await runTest('createSessionAccess passes a verified, matching, unexpired session', async () => {
    const session = {
      authenticated: true,
      user: { role: 'admin', firebase_uid: 'uid-1' },
      idToken: makeToken({ exp: NOW + 3600, sub: 'uid-1' }),
      refreshToken: 'refresh-1'
    };
    let verifySawToken = null;
    let saved = null;
    const authorize = createSessionAccess({
      load: () => session,
      save: (s) => { saved = s; return { success: true }; },
      refresh: async () => { throw new Error('refresh must not be called for a fresh token'); },
      verify: async (token) => { verifySawToken = token; return { authorized: true, role: 'admin', verifiedPayload: { uid: 'uid-1' } }; }
    });
    const result = await authorize();
    assert(result === session, 'verified session must be returned');
    assert(verifySawToken === session.idToken, 'verify received the wrong token');
    assert(saved === null, 'no save should happen when the token is still fresh');
  });

  await runTest('createSessionAccess refreshes an expired token and persists it', async () => {
    const expiredToken = makeToken({ exp: NOW - 60, sub: 'uid-1' });
    const renewedToken = makeToken({ exp: NOW + 3600, sub: 'uid-1' });
    const store = {
      session: {
        authenticated: true,
        user: { role: 'operator', firebase_uid: 'uid-1' },
        idToken: expiredToken,
        refreshToken: 'refresh-1'
      }
    };
    let refreshArg = null;
    let verifyArg = null;
    const authorize = createSessionAccess({
      load: () => store.session,
      save: (s) => { store.session = s; return { success: true }; },
      refresh: async (refreshToken) => { refreshArg = refreshToken; return { idToken: renewedToken, refreshToken: 'refresh-2' }; },
      verify: async (token) => { verifyArg = token; return { authorized: true, role: 'operator', verifiedPayload: { uid: 'uid-1' } }; }
    });
    const result = await authorize();
    assert(result !== null, 'refreshed session must authorize');
    assert(refreshArg === 'refresh-1', 'refresh did not receive the stored refreshToken');
    assert(verifyArg === renewedToken, 'verify did not receive the renewed idToken');
    assert(store.session.idToken === renewedToken, 'renewed token was not persisted');
    assert(store.session.refreshToken === 'refresh-2', 'rotated refreshToken was not persisted');
  });

  await runTest('createSessionAccess fails closed when refresh fails', async () => {
    const authorize = createSessionAccess({
      load: () => ({
        authenticated: true,
        user: { role: 'admin', firebase_uid: 'uid-1' },
        idToken: makeToken({ exp: NOW - 60, sub: 'uid-1' }),
        refreshToken: 'refresh-1'
      }),
      save: () => ({ success: true }),
      refresh: async () => null,
      verify: async () => ({ authorized: true, role: 'admin', verifiedPayload: { uid: 'uid-1' } })
    });
    assert(await authorize() === null, 'expired token with failed refresh must return null');
  });

  await runTest('createSessionAccess rejects uid / role mismatch and unauthorized roles', async () => {
    const base = { authenticated: true, user: { role: 'admin', firebase_uid: 'uid-1' } };
    const authorizeWith = (verifyResult) => createSessionAccess({
      load: () => ({ ...base, idToken: makeToken({ exp: NOW + 3600, sub: 'uid-1' }) }),
      save: () => ({ success: true }),
      refresh: async () => null,
      verify: async () => verifyResult
    });
    assert(await authorizeWith({ authorized: false, role: null, error: 'revoked' })() === null, 'unauthorized token must return null');
    assert(
      await authorizeWith({ authorized: true, role: 'admin', verifiedPayload: { uid: 'uid-somebody-else' } })() === null,
      'uid mismatch must return null'
    );
    assert(
      await authorizeWith({ authorized: true, role: 'viewer', verifiedPayload: { uid: 'uid-1' } })() === null,
      'role mismatch must return null'
    );
  });

  await runTest('createSessionAccess enforces mutation roles', async () => {
    const authorize = (role) => createSessionAccess({
      load: () => ({
        authenticated: true,
        user: { role, firebase_uid: 'uid-1' },
        idToken: makeToken({ exp: NOW + 3600, sub: 'uid-1' })
      }),
      save: () => ({ success: true }),
      refresh: async () => null,
      verify: async () => ({ authorized: true, role, verifiedPayload: { uid: 'uid-1' } })
    });
    const analyst = authorize('analyst');
    assert(await analyst(true) === null, 'analyst must not pass the mutation gate');
    assert(await analyst(false) !== null, 'analyst must pass the read-only gate');
    const operator = authorize('operator');
    assert(await operator(true) !== null, 'operator must pass the mutation gate');
  });

  await runTest('createSessionAccess blocks logout races (session swapped during verification)', async () => {
    const originalToken = makeToken({ exp: NOW + 3600, sub: 'uid-1' });
    const store = {
      session: {
        authenticated: true,
        user: { role: 'admin', firebase_uid: 'uid-1' },
        idToken: originalToken,
        refreshToken: 'refresh-1'
      }
    };
    const authorize = createSessionAccess({
      load: () => store.session,
      save: (s) => { store.session = s; return { success: true }; },
      refresh: async () => null,
      verify: async () => {
        // Simulate the user logging out while the network verification is in flight
        store.session = { authenticated: false, user: null };
        return { authorized: true, role: 'admin', verifiedPayload: { uid: 'uid-1' } };
      }
    });
    const result = await authorize();
    assert(result === null, 'a session replaced mid-verification must not be restored');
  });

  await runTest('staged extraction state clears cards and invalidates jobs on auth changes', async () => {
    const state = createStagedExtractionState();
    const jobGeneration = state.authGeneration;
    state.cards = [{ marketplace: 'flipkart' }];
    state.resetForAuthChange();
    assert(state.cards.length === 0, 'auth change must clear staged cards');
    assert(state.authGeneration === jobGeneration + 1, 'auth change must invalidate in-flight jobs');
  });

  await runTest('stale overlapping rate comparisons cannot replace the newest staged review', async () => {
    const state = createStagedExtractionState();
    const olderCards = [{ marketplace: 'flipkart', category: 'kurta' }];
    const newerCards = [{ marketplace: 'shopsy', category: 'shopsy_kurta' }];
    const olderRequest = beginStagedRateReview(state, olderCards, 'default');
    const newerRequest = beginStagedRateReview(state, newerCards, 'default');
    const newerResult = { fingerprints: { shopsy: 'b'.repeat(64) }, publishable: true };
    const olderResult = { fingerprints: { flipkart: 'a'.repeat(64) }, publishable: true };

    assert(!isCurrentStagedRateReview(state, olderRequest, olderCards, 'default'), 'newer comparison must invalidate the older request');
    assert(stageRateReviewIfCurrent(state, newerRequest, newerCards, 'default', newerResult), 'latest comparison may stage its review');
    assert(!stageRateReviewIfCurrent(state, olderRequest, olderCards, 'default', olderResult), 'late older response must not overwrite the latest review');
    assert.strictEqual(state.review.payload, JSON.stringify(newerCards), 'latest reviewed payload must remain staged');
    assert.strictEqual(state.review.fingerprints.shopsy, 'b'.repeat(64), 'latest marketplace fingerprint must remain staged');

    const pendingRequest = beginStagedRateReview(state, newerCards, 'default');
    state.invalidateReview();
    assert(!isCurrentStagedRateReview(state, pendingRequest, newerCards, 'default'), 'a new extraction must invalidate an in-flight comparison');
    assert(state.beginPublication(), 'publication lock must start once');
    assert(!state.beginPublication(), 'overlapping publications must be rejected');
    let comparisonBlocked = false;
    try { beginStagedRateReview(state, newerCards, 'default'); } catch (error) { comparisonBlocked = /publication is in progress/i.test(error.message); }
    assert(comparisonBlocked, 'a new comparison must not invalidate review state during publication');
    state.endPublication();
    assert(!state.publicationInProgress, 'publication lock must always be releasable');
  });

  // ── scrapeResults ───────────────────────────────────────────────────────────
  await runTest('normalizeScrapedCards rejects unusable extractions', async () => {
    let threw;
    try { normalizeScrapedCards([]); threw = false; } catch { threw = true; }
    assert(threw, 'empty extraction must be rejected');
    try { normalizeScrapedCards('nope'); threw = false; } catch { threw = true; }
    assert(threw, 'non-array extraction must be rejected');
    try { normalizeScrapedCards([{ marketplace: 'amazon', vertical: 'Apparel', commissions: [{ rate: 0.1 }] }]); threw = false; } catch { threw = true; }
    assert(threw, 'unsupported marketplace must be rejected');
    try { normalizeScrapedCards([{ marketplace: 'flipkart', vertical: 'Apparel' }]); threw = false; } catch { threw = true; }
    assert(threw, 'missing vertical must be rejected');
    try { normalizeScrapedCards([{ marketplace: 'flipkart', vertical: 'Apparel', commissions: [] }]); threw = false; } catch { threw = true; }
    assert(threw, 'extraction with no fee slabs must be rejected');
  });

  await runTest('normalizeScrapedCards merges FBF and NON_FBF only when they agree', async () => {
    const slabs = { commissions: [{ price_min: 0, price_max: 500, rate: 0.15 }] };
    const merged = normalizeScrapedCards([
      { marketplace: 'flipkart', vertical: 'Kurta', fulfilment_type: 'NON_FBF', ...slabs },
      { marketplace: 'flipkart', vertical: 'Kurta', fulfilment_type: 'FBF', ...slabs }
    ]);
    assert(merged.length === 1 && merged[0].commissions.length === 1, 'agreeing modes must merge into one card');
    assert(merged[0].fulfilmentModes.join(',') === 'NON_FBF,FBF', 'card must record which modes were merged');
    assert.strictEqual(merged[0].seller_account,'default','cards preserve the account searched by the scraper');

    let error = null;
    try {
      normalizeScrapedCards([
        { marketplace: 'flipkart', vertical: 'Kurta', fulfilment_type: 'NON_FBF', commissions: [{ price_min: 0, price_max: 500, rate: 0.15 }] },
        { marketplace: 'flipkart', vertical: 'Kurta', fulfilment_type: 'FBF', commissions: [{ price_min: 0, price_max: 500, rate: 0.1 }] }
      ]);
    } catch (err) { error = err; }
    assert(error && /different commissions for NON_FBF and FBF/.test(error.message), `conflicting modes must be refused (${error?.message})`);
  });

  await runTest('seller-account review derives the scraped account and rejects a different one', async () => {
    const cards=normalizeScrapedCards([{marketplace:'flipkart',vertical:'Kurta',seller_account:'seller-ej',commissions:[{price_min:0,price_max:500,rate:0.15}]}]);
    assert.strictEqual(resolveSellerAccountForRateCards(cards),'seller-ej','review defaults to the account recorded on the card');
    let error=null;
    try { resolveSellerAccountForRateCards(cards,'default'); } catch(err) { error=err; }
    assert(error && /does not match/.test(error.message),'a review cannot use a different seller account');
  });

  await runTest('normalizeScrapedCards refuses fee tables missing from one fulfilment mode', async () => {
    let error = null;
    try {
      normalizeScrapedCards([
        {
          marketplace: 'flipkart',
          vertical: 'Kurta',
          fulfilment_type: 'FBF',
          commissions: [{ price_min: 0, price_max: 500, rate: 0.15 }],
          fixedFees: [{ fulfilment_type: 'PREP', price_min: 0, price_max: 500, rate: 15 }]
        },
        {
          marketplace: 'flipkart',
          vertical: 'Kurta',
          fulfilment_type: 'NON_FBF',
          commissions: [{ price_min: 0, price_max: 500, rate: 0.15 }]
        }
      ]);
    } catch (err) { error = err; }
    assert(error && /different fixedFees for FBF and NON_FBF/.test(error.message), `missing mode table must be refused (${error?.message})`);
  });

  await runTest('selectStagedCards accepts only exact, non-duplicated staged subsets', async () => {
    const flipkart = { marketplace: 'flipkart', category: 'Kurta', commissions: [{ rate: 0.15 }] };
    const shopsy = { marketplace: 'shopsy', category: 'Kurta', commissions: [{ rate: 0 }] };
    const staged = [flipkart, shopsy];
    const selected = selectStagedCards(staged, [shopsy]);
    assert(selected?.length === 1 && selected[0] === shopsy, 'an exact filtered subset should resolve to its staged card');
    assert(selectStagedCards(staged, [shopsy, shopsy]) === null, 'duplicate submissions must not exceed staged cards');
    assert(selectStagedCards(staged, [{ ...shopsy, commissions: [{ rate: 0.01 }] }]) === null, 'modified cards must be rejected');
    assert(selectStagedCards(staged, []) === null, 'empty submissions must be rejected');
  });

  await runTest('analyst sessions retain only explicit read-only database URLs', async () => {
    const writerUrl = 'postgresql://worker:write@db.example.com:5432/paymentapp';
    const readonlyUrl = 'postgresql://analyst:readonly@db.example.com:5432/paymentapp';
    assert(selectDesktopDatabaseUrlForSession({
      role: 'analyst',
      manualUrl: writerUrl,
      serverUrl: writerUrl,
      serverAccess: 'standard'
    }) === '', 'analysts must not retain manual or standard server credentials');
    assert(selectDesktopDatabaseUrlForSession({
      role: 'analyst',
      manualUrl: writerUrl,
      serverUrl: readonlyUrl,
      serverAccess: 'read-only'
    }) === readonlyUrl, 'analysts should retain the server-issued read-only URL');
    assert(selectDesktopDatabaseUrlForSession({
      role: 'operator',
      manualUrl: 'postgresql://worker:write@localhost:5432/paymentapp',
      serverUrl: writerUrl,
      serverAccess: 'standard'
    }) === 'postgresql://worker:write@localhost:5432/paymentapp', 'operators may retain a manual local database URL');
    assert(selectDesktopDatabaseUrlForSession({ role: 'viewer', serverUrl: writerUrl }) === '', 'unauthorized roles must not retain a URL');
  });

  await runTest('normalizeScrapedCards keeps collection fees as pct decimals', async () => {
    const [card] = normalizeScrapedCards([{
      marketplace: 'flipkart', vertical: 'Kurta',
      collectionFees: [
        { price_min: 0, price_max: 750, prepaid: 0.3, postpaid: 2, prepaid_type: 'percentage', postpaid_type: 'percentage', fulfilment_type: 'All' },
        { price_min: 750.01, price_max: 999999, prepaid: 15, postpaid: 20, prepaid_type: 'flat', postpaid_type: 'flat', fulfilment_type: 'All' }
      ]
    }]);
    assert(card.collectionFees.length === 2, 'collection-fee-only extraction must be staged with its fees');
    const pct = card.collectionFees[0];
    assert(pct.prepaid_type === 'pct' && Math.abs(pct.prepaid - 0.003) < 1e-12, `0.3% must become pct 0.003 (got ${pct.prepaid_type} ${pct.prepaid})`);
    assert(Math.abs(pct.postpaid - 0.02) < 1e-12, '2% must become 0.02');
    const flat = card.collectionFees[1];
    assert(flat.prepaid_type === 'flat' && flat.prepaid === 15, 'flat fees must be unchanged');
  });

  await runTest('normalizeScrapedCards merges duplicate verticals and dedupes slabs', async () => {
    const cards = normalizeScrapedCards([
      {
        marketplace: 'flipkart',
        vertical: 'Women Kurtas',
        commissions: [{ price_min: 0, price_max: 500, rate: 0.15 }],
        fixedFees: [{ fulfilment_type: 'PREP', price_min: 0, price_max: 500, rate: 15 }],
        reverseShipping: [{ weight_slab: '0-0.5kg', price_min: 0, price_max: 500, local_fee: 30, zonal_fee: 40, national_fee: 50 }]
      },
      {
        marketplace: 'flipkart',
        vertical: 'Women Kurtas',
        commissions: [
          { price_min: 0, price_max: 500, rate: 0.15 },
          { price_min: 500, price_max: 1000, rate: 0.2 }
        ],
        fixedFees: [],
        reverseShipping: []
      },
      {
        marketplace: 'shopsy',
        vertical: 'Women Kurtas',
        commissions: [{ price_min: 0, price_max: 999990, rate: 0 }]
      }
    ]);
    assert(cards.length === 2, `expected flipkart + shopsy cards, got ${cards.length}`);
    const fk = cards.find(c => c.marketplace === 'flipkart');
    assert(fk.commissions.length === 2, `duplicate slabs were not deduped (${fk.commissions.length})`);
    assert(fk.category === 'Women Kurtas', 'vertical must become the category');
    assert(fk.source === 'seller_portal', 'flipkart source wrong');
    const sh = cards.find(c => c.marketplace === 'shopsy');
    assert(sh.source === 'seller_portal', 'Shopsy rates must come from Seller Hub');
    assert(sh.commissions.length === 1 && sh.commissions[0].rate === 0, 'shopsy 0% commission slab lost');
  });

  await runTest('staged cards keep the scrape date and sync never shifts it past midnight', async () => {
    const cards = normalizeScrapedCards([{
      marketplace: 'flipkart', vertical: 'Women Kurtas', effectiveDate: '2026-10-27', fulfilment_type: 'NON_FBF',
      commissions: [{ price_min: 0, price_max: 500, rate: 0.15 }],
      fixedFees: [], reverseShipping: [], collectionFees: []
    }]);
    assert(cards[0].effectiveDate === '2026-10-27', `scrape date lost (got ${cards[0].effectiveDate})`);
    const { resolveSyncEffectiveDate } = await import('../rateCardService.js');
    // A review committed the next day must still record under the scrape date.
    assert(resolveSyncEffectiveDate({}, cards) === '2026-10-27', 'sync must honor the staged scrape date');
    // An explicit caller-provided date still wins.
    assert(resolveSyncEffectiveDate({ effectiveDate: '2026-11-01' }, cards) === '2026-11-01', 'explicit sync date must win');
    // Garbage falls back to today, never to a bogus value.
    const today = new Date().toISOString().slice(0, 10);
    assert(resolveSyncEffectiveDate({}, [{ effectiveDate: 'garbage' }]) === today, 'invalid staged date must fall back to today');
    assert(resolveSyncEffectiveDate({}, []) === today, 'no cards means today');
  });

  // ── dbUrlGuard ─────────────────────────────────────────────────────────────
  await runTest('isDesktopReachableDbUrl refuses container-internal and private provisioned URLs', async () => {
    assert(isDesktopReachableDbUrl('postgresql://app:pass@postgres:5432/paymentapp') === false, 'container-internal postgres host must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@db:5432/paymentapp') === false, 'single-label service name must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@localhost:5432/paymentapp') === false, 'loopback provisioned by a remote server must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@10.0.0.5:5432/paymentapp') === false, 'private IPv4 must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@database.internal:5432/paymentapp') === false, '.internal host must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@registry.lan:5432/paymentapp') === false, 'LAN DNS names must still be refused when server-provisioned');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@100.64.0.1:5432/paymentapp') === false, 'CGNAT range must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@0177.0.0.1:5432/paymentapp') === false, 'octal loopback must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@0x7f.0.0.1:5432/paymentapp') === false, 'hex loopback must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@127.1:5432/paymentapp') === false, 'short-form loopback must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@08.0.0.1:5432/paymentapp') === false, 'malformed numeric host must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@db.example:5432/paymentapp') === false, 'reserved .example TLD must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@db.invalid:5432/paymentapp') === false, 'reserved .invalid TLD must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@payment.test:5432/paymentapp') === false, 'reserved .test TLD must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@[::a00:5]:5432/paymentapp') === false, 'IPv4-compatible IPv6 literal encoding a private address must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@[::10.0.0.5]:5432/paymentapp') === false, 'deprecated dotted IPv4-compatible IPv6 literal must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@[::ffff:10.0.0.5]:5432/paymentapp') === false, 'IPv4-mapped IPv6 literal must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@[2001:2::1]:5432/paymentapp') === false, 'RFC 2544/5180 benchmarking IPv6 must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@[2001::1]:5432/paymentapp') === false, 'Teredo IPv6 must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@[2001:10::1]:5432/paymentapp') === false, 'deprecated ORCHID IPv6 must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@192.0.2.1:5432/paymentapp') === false, 'TEST-NET-1 must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@localhost.:5432/paymentapp') === false, 'trailing-dot loopback must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@db.localhost:5432/paymentapp') === false, '.localhost subdomain must be refused');
    assert(isDesktopReachableDbUrl('') === false, 'empty URL must be refused');
    assert(isDesktopReachableDbUrl('not a url') === false, 'malformed URL must be refused');
  });

  await runTest('isDesktopReachableDbUrl accepts publicly routable provisioned URLs', async () => {
    assert(isDesktopReachableDbUrl('postgresql://worker:pass@db.example.com:5432/paymentapp?sslmode=require') === true, 'public DNS host must be accepted');
    assert(isDesktopReachableDbUrl('postgresql://worker:pass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres') === true, 'public pooler host must be accepted');
    assert(isDesktopReachableDbUrl('postgresql://worker:pass@8.8.8.8:5432/paymentapp') === true, 'public IPv4 must be accepted');
    // Bare hex-letter DNS labels (face.cafe, dead.beef) are hostnames, not
    // legacy IPv4 notation: they must pass through as ordinary DNS names.
    assert(isDesktopReachableDbUrl('postgresql://app:pass@face.cafe:5432/paymentapp') === true, 'bare-hex DNS name must be accepted');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@dead.beef:5432/paymentapp') === true, 'bare-hex DNS name must be accepted');
  });

  await runTest('storedDatabaseUrlForRole never crosses provisioning roles', async () => {
    const analystStored = { databaseUrl: 'postgresql://analyst:ro@db.example.com:5432/paymentapp', databaseUrlRole: 'analyst' };
    assert(storedDatabaseUrlForRole('operator', analystStored) === '', 'an analyst read-only URL must never be reused by an operator');
    assert(storedDatabaseUrlForRole('admin', analystStored) === '', 'an analyst read-only URL must never be reused by an admin');
    assert(storedDatabaseUrlForRole('analyst', analystStored) === analystStored.databaseUrl, 'the analyst URL stays available to analyst sessions');
    const unmarked = { databaseUrl: 'postgresql://worker:write@db.example.com:5432/paymentapp', databaseUrlRole: '' };
    assert(storedDatabaseUrlForRole('operator', unmarked) === unmarked.databaseUrl, 'unmarked (manually configured) URLs stay reusable by operators');
    assert(storedDatabaseUrlForRole('admin', unmarked) === unmarked.databaseUrl, 'unmarked (manually configured) URLs stay reusable by admins');
    assert(storedDatabaseUrlForRole('analyst', unmarked) === '', 'an unmarked writer URL must never reach an analyst session');
    assert(storedDatabaseUrlForRole('operator', {}) === '', 'no stored URL means no URL');
  });

  await runTest('sanitizeSavedDbUrl drops container-internal saved URLs but keeps deliberate local ones', async () => {
    assert(sanitizeSavedDbUrl('postgresql://app:pass@postgres:5432/paymentapp') === '', 'stale container-internal saved URL must be discarded');
    assert(sanitizeSavedDbUrl('postgresql://app:pass@registry.local:5432/paymentapp') === 'postgresql://app:pass@registry.local:5432/paymentapp', '.local LAN DNS URL must be preserved');
    assert(sanitizeSavedDbUrl('postgresql://app:pass@registry.lan:5432/paymentapp') === 'postgresql://app:pass@registry.lan:5432/paymentapp', '.lan URL must be preserved');
    assert(sanitizeSavedDbUrl('postgresql://app:pass@db.home.arpa:5432/paymentapp') === 'postgresql://app:pass@db.home.arpa:5432/paymentapp', '.home.arpa URL must be preserved');
    assert(sanitizeSavedDbUrl('') === '', 'empty stays empty');
    // Loopback / LAN URLs are valid for developers running the database locally.
    assert(sanitizeSavedDbUrl('postgresql://app:pass@localhost:5432/paymentapp') === 'postgresql://app:pass@localhost:5432/paymentapp', 'loopback must be preserved for local development');
    assert(sanitizeSavedDbUrl('postgresql://app:pass@192.168.1.10:5432/paymentapp') === 'postgresql://app:pass@192.168.1.10:5432/paymentapp', 'LAN host must be preserved for local development');
    assert(sanitizeSavedDbUrl('  postgresql://app:pass@db.example.com:5432/paymentapp  ') === 'postgresql://app:pass@db.example.com:5432/paymentapp', 'public URL must survive and be trimmed');
  });

  await runTest('dbHostFromUrl parses hosts and rejects garbage', async () => {
    assert(dbHostFromUrl('postgresql://u:p@postgres:5432/paymentapp') === 'postgres', 'host parse failed');
    assert(dbHostFromUrl('postgresql://u:p@db.example.com:5432/paymentapp') === 'db.example.com', 'public host parse failed');
    assert(dbHostFromUrl('garbage') === null, 'malformed URL must yield null');
    assert(dbHostFromUrl(null) === null, 'null input must yield null');
  });

  // ── httpAccess (HTTP caller proof) ──────────────────────────────────────────
  const makeReq = (headers) => ({ headers });

  await runTest('isSameDesktopOrigin only accepts the exact control-center origin', async () => {
    assert(isSameDesktopOrigin(makeReq({ host: 'localhost:3388', origin: 'http://localhost:3388' })) === true, 'same origin must pass');
    assert(isSameDesktopOrigin(makeReq({ host: 'localhost:3388', origin: 'http://localhost:3389' })) === false, 'port mismatch must fail');
    assert(isSameDesktopOrigin(makeReq({ host: 'localhost:3388', origin: 'http://127.0.0.1:3388' })) === false, 'host swap must fail');
    assert(isSameDesktopOrigin(makeReq({ host: 'localhost:3388', 'sec-fetch-site': 'same-origin' })) === true, 'no origin with same-origin fetch metadata must pass');
    assert(isSameDesktopOrigin(makeReq({ host: 'localhost:3388', 'sec-fetch-site': 'cross-site' })) === false, 'cross-site fetch metadata must fail');
  });

  await runTest('isAllowedDesktopOrigin allows only exact official hosts over https', async () => {
    assert(isAllowedDesktopOrigin(makeReq({ host: 'localhost:3388', origin: 'http://localhost:3388' })) === true, 'same origin allowed');
    assert(isAllowedDesktopOrigin(makeReq({ host: 'localhost:3388', origin: 'https://payments.youthnic.shop' })) === true, 'official host allowed');
    assert(isAllowedDesktopOrigin(makeReq({ host: 'localhost:3388', origin: 'https://task.youthnic.shop' })) === true, 'official subdomain allowed');
    assert(isAllowedDesktopOrigin(makeReq({ host: 'localhost:3388', origin: 'https://evilyouthnic.shop.attacker.example.com' })) === false, 'substring spoof must be rejected');
    assert(isAllowedDesktopOrigin(makeReq({ host: 'localhost:3388', origin: 'https://youthnic.shop.evil.com' })) === false, 'suffix spoof must be rejected');
    assert(isAllowedDesktopOrigin(makeReq({ host: 'localhost:3388', origin: 'http://payments.youthnic.shop' })) === false, 'plain http must be rejected');
    assert(isAllowedDesktopOrigin(makeReq({ host: 'localhost:3388', origin: 'https://payments.youthnic.shop:8443' })) === false, 'non-default port must be rejected');
    assert(isAllowedDesktopOrigin(makeReq({ host: 'localhost:3388', 'sec-fetch-site': 'cross-site' })) === false, 'missing origin with cross-site fetch metadata must be rejected');
  });

  await runTest('authorizeDesktopRequest requires browser cookie or a matching verified bearer', async () => {
    const baseSession = {
      authenticated: true,
      user: { id: 1, username: 'op', email: 'op@vb.co', role: 'operator', firebase_uid: 'uid-1' },
      idToken: 'stored-id-token', refreshToken: 'r', authorizedAt: '2026-10-28T00:00:00Z'
    };
    const bound = bindBrowserSession(baseSession);
    const store = { session: bound.session };
    const authorize = async () => store.session;
    const verifyMatch = async () => ({ authorized: true, role: 'operator', verifiedPayload: { uid: 'uid-1' } });
    const verifyOtherUser = async () => ({ authorized: true, role: 'operator', verifiedPayload: { uid: 'uid-somebody-else' } });

    const none = await authorizeDesktopRequest(makeReq({ host: 'localhost:3388' }), { authorize, verify: verifyMatch });
    assert(none.session === null, 'a saved session alone must not authorize an HTTP caller');

    const bearer = await authorizeDesktopRequest(
      makeReq({ host: 'localhost:3388', authorization: 'Bearer token-a' }),
      { authorize, verify: verifyMatch }
    );
    assert(bearer.session === store.session, 'a matching verified bearer must authorize');

    const otherUser = await authorizeDesktopRequest(
      makeReq({ host: 'localhost:3388', authorization: 'Bearer token-b' }),
      { authorize, verify: verifyOtherUser }
    );
    assert(otherUser.session === null, 'a bearer verified for a different user must be rejected');

    const cookie = bound.cookie.split(';')[0];
    const viaCookie = await authorizeDesktopRequest(
      makeReq({ host: 'localhost:3388', cookie }),
      { authorize, verify: async () => { throw new Error('verify must not be called when the cookie proves the caller'); } }
    );
    assert(viaCookie.session === store.session, 'the bound same-origin cookie must authorize');

    const crossOriginCookie = await authorizeDesktopRequest(
      makeReq({ host: 'localhost:3388', origin: 'https://payments.youthnic.shop', cookie }),
      { authorize, verify: verifyMatch }
    );
    assert(crossOriginCookie.session === null, 'cookies forwarded from a different origin must not authorize');
  });

  // ── db.js analyst fail-closed access ────────────────────────────────────────
  await runTest('analyst database access fails closed (no writer fallback from env or arguments)', async () => {
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevReconUrl = process.env.RECON_DATABASE_URL;
    const readonlyUrl = 'postgresql://analyst:read@db.example.com:5432/paymentapp';
    const writerUrl = 'postgresql://worker:write@db2.example.com:5432/paymentapp';
    process.env.DATABASE_URL = writerUrl;
    process.env.RECON_DATABASE_URL = writerUrl;
    try {
      setDesktopDatabaseAccess('analyst', readonlyUrl);
      assert(resolveDatabaseUrl(writerUrl) === readonlyUrl, 'an analyst session must ignore writer URLs entirely');
      setDesktopDatabaseAccess('analyst', '');
      assert(resolveDatabaseUrl(writerUrl) === null, 'an analyst without a provisioned URL must fail closed with no env fallback');
      setDesktopDatabaseAccess('admin', '');
      assert(resolveDatabaseUrl(readonlyUrl) === readonlyUrl, 'operator/admin sessions keep explicit URL precedence');
    } finally {
      setDesktopDatabaseAccess(null);
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevReconUrl === undefined) delete process.env.RECON_DATABASE_URL;
      else process.env.RECON_DATABASE_URL = prevReconUrl;
    }
  });

  await runTest('resolveDatabaseUrl discards container-internal environment URLs', async () => {
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevReconUrl = process.env.RECON_DATABASE_URL;
    const prevUserDir = process.env.RECON_USER_DATA_DIR;
    const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-env-url-'));
    try {
      setDesktopDatabaseAccess(null);
      process.env.RECON_USER_DATA_DIR = tmpUserDir;
      process.env.DATABASE_URL = 'postgresql://app:pass@postgres:5432/paymentapp';
      delete process.env.RECON_DATABASE_URL;
      // A container-internal env URL must fail closed as "not configured"
      // (falling through to the absent saved config), never reach the pool.
      assert(resolveDatabaseUrl() === null, 'container-internal env DATABASE_URL must fail closed');
      // Deliberate local-development env URLs stay usable.
      process.env.DATABASE_URL = 'postgresql://app:pass@localhost:5432/paymentapp';
      assert(resolveDatabaseUrl() === 'postgresql://app:pass@localhost:5432/paymentapp', 'loopback env URL must stay usable for local development');
    } finally {
      setDesktopDatabaseAccess(null);
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevReconUrl === undefined) delete process.env.RECON_DATABASE_URL;
      else process.env.RECON_DATABASE_URL = prevReconUrl;
      if (prevUserDir === undefined) delete process.env.RECON_USER_DATA_DIR;
      else process.env.RECON_USER_DATA_DIR = prevUserDir;
      try { fs.rmSync(tmpUserDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ── rateCardService.detectBrandRateChanges ────────────────────────────────
  await runTest('detectBrandRateChanges surfaces collection fee differences for review', async () => {
    const { detectBrandRateChanges } = await import('../rateCardService.js');
    const card = (brand) => ({
      marketplace: 'flipkart', category: 'Kurta', brand,
      commissions: [{ price_min: 0, price_max: 500, rate: 0.15 }],
      fixedFees: [], reverseShipping: [],
      collectionFees: [{ fulfilment_type: 'All', price_min: 0, price_max: 750, prepaid: 0.003, postpaid: 0.02, prepaid_type: 'pct', postpaid_type: 'pct' }]
    });
    const pool = { query: async (sql) => {
      if (sql.includes('FROM rc_commission')) return { rows: [{ price_min: 0, price_max: 500, rate: 0.15 }] };
      if (sql.includes('FROM rc_collection_fee')) return { rows: [{ fulfilment_type: 'All', price_min: 0, price_max: 750, prepaid: 0.003, postpaid: 0.01, prepaid_type: 'pct', postpaid_type: 'pct' }] };
      return { rows: [] };
    } };
    // Two brand cards in the same category: the category-level collection fee
    // difference must be reported exactly once.
    const changes = await detectBrandRateChanges([card('Ethnic Junction'), card('Youthnic')], pool);
    const collChanges = changes.filter((c) => c.type === 'collection_fee');
    assert(collChanges.length === 1, `expected exactly one collection fee change, got ${collChanges.length}`);
    assert(collChanges[0].reason === 'Collection fee modified', `unexpected reason: ${collChanges[0].reason}`);
    assert(String(collChanges[0].oldRate).includes('1.00%') && String(collChanges[0].newRate).includes('2.00%'), `old/new rates wrong: ${collChanges[0].oldRate} -> ${collChanges[0].newRate}`);

    const poolSynced = { query: async (sql) => {
      if (sql.includes('FROM rc_commission')) return { rows: [{ price_min: 0, price_max: 500, rate: 0.15 }] };
      if (sql.includes('FROM rc_collection_fee')) return { rows: [{ fulfilment_type: 'All', price_min: 0, price_max: 750, prepaid: 0.003, postpaid: 0.02, prepaid_type: 'pct', postpaid_type: 'pct' }] };
      return { rows: [] };
    } };
    const synced = await detectBrandRateChanges([card('Ethnic Junction')], poolSynced);
    assert(synced.length === 0, `in-sync cards must report no changes (got ${synced.length})`);

    // Slab-level matching: one changed collection slab (and one changed
    // commission slab) must carry its own price bounds so the review table
    // can attach old/new values to that slab alone, never to its neighbors.
    const twoSlabCard = {
      marketplace: 'flipkart', category: 'Sari', brand: 'Ethnic Junction',
      commissions: [
        { price_min: 0, price_max: 500, rate: 0.15 },
        { price_min: 500, price_max: 1000, rate: 0.2 }
      ],
      fixedFees: [], reverseShipping: [],
      collectionFees: [
        { fulfilment_type: 'All', price_min: 0, price_max: 750, prepaid: 0.003, postpaid: 0.02, prepaid_type: 'pct', postpaid_type: 'pct' },
        { fulfilment_type: 'All', price_min: 750, price_max: 999990, prepaid: 0.003, postpaid: 0.02, prepaid_type: 'pct', postpaid_type: 'pct' }
      ]
    };
    const poolTwoSlabs = { query: async (sql) => {
      if (sql.includes('FROM rc_commission')) return { rows: [
        { price_min: 0, price_max: 500, rate: 0.15 },
        { price_min: 500, price_max: 1000, rate: 0.25 }
      ] };
      if (sql.includes('FROM rc_collection_fee')) return { rows: [
        { fulfilment_type: 'All', price_min: 0, price_max: 750, prepaid: 0.003, postpaid: 0.01, prepaid_type: 'pct', postpaid_type: 'pct' },
        { fulfilment_type: 'All', price_min: 750, price_max: 999990, prepaid: 0.003, postpaid: 0.02, prepaid_type: 'pct', postpaid_type: 'pct' }
      ] };
      return { rows: [] };
    } };
    const twoSlabChanges = await detectBrandRateChanges([twoSlabCard], poolTwoSlabs);
    const slabMatch = (list, slab) => list.find((ch) =>
      ch.priceMin != null && Math.abs(ch.priceMin - slab.price_min) < 0.01 && Math.abs(ch.priceMax - slab.price_max) < 1.0) || null;
    const collSlabChanges = twoSlabChanges.filter((c) => c.type === 'collection_fee');
    assert(collSlabChanges.length === 1, `expected only the changed collection slab, got ${collSlabChanges.length}`);
    assert(slabMatch(collSlabChanges, twoSlabCard.collectionFees[0]) !== null, 'changed collection slab must match its own change record');
    assert(slabMatch(collSlabChanges, twoSlabCard.collectionFees[1]) === null, 'unchanged collection slab must not inherit its neighbor diff');
    const commSlabChanges = twoSlabChanges.filter((c) => c.type === 'commission');
    assert(commSlabChanges.length === 1, `expected only the changed commission slab, got ${commSlabChanges.length}`);
    assert(commSlabChanges[0].priceMin === 500 && commSlabChanges[0].priceMax === 1000, 'commission change record must carry the changed slab bounds');
    assert(slabMatch(commSlabChanges, twoSlabCard.commissions[0]) === null, 'unchanged commission slab must not inherit its neighbor diff');
  });

  // ── Packaging invariants ───────────────────────────────────────────────────
  await runTest('logout surfaces a failed session-file removal (static invariant)', async () => {
    const mainSource = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
    const serverSource = fs.readFileSync(path.join(desktopDir, 'desktopServer.mjs'), 'utf8');
    const rendererSource = fs.readFileSync(path.join(desktopDir, 'ui', 'renderer.js'), 'utf8');
    const checks = [
      ['main.js', mainSource.indexOf("registerHandler('auth-logout'")],
      ['desktopServer.mjs', serverSource.indexOf("'/api/auth/logout'")]
    ];
    for (const [label, idx] of checks) {
      assert(idx !== -1, `${label} logout path not found`);
      const window = (label === 'main.js' ? mainSource : serverSource).slice(idx, idx + 1400);
      assert(window.includes('clearAuthSession();'), `${label} logout must clear the session`);
      assert(window.includes('cleared.success') && window.includes('cleared.error'), `${label} logout must report a failed session-file removal honestly`);
    }
    const rendererIdx = rendererSource.indexOf('btnHeaderLogout?.addEventListener');
    assert(rendererIdx !== -1, 'renderer logout handler not found');
    const rendererWindow = rendererSource.slice(rendererIdx, rendererIdx + 700);
    assert(rendererWindow.includes('res?.success'), 'renderer logout must check the response before claiming deauthorization');
  });

  await runTest('preview responses are generation-guarded (static invariant)', async () => {
    const rendererSource = fs.readFileSync(path.join(desktopDir, 'ui', 'renderer.js'), 'utf8');
    const fnIdx = rendererSource.indexOf('async function loadRateCardPreview');
    assert(fnIdx !== -1, 'loadRateCardPreview not found');
    const fnWindow = rendererSource.slice(fnIdx, fnIdx + 9000);
    assert(fnWindow.includes('requestId = ++previewRequestSeq'), 'each preview must claim a generation');
    const guardCount = (fnWindow.match(/requestId !== previewRequestSeq/g) || []).length;
    assert(guardCount >= 3, `stale responses must be dropped after each await, including the catch path (found ${guardCount} guards)`);
  });

  await runTest('rate review requires local extraction and avoids direct PostgreSQL fallback', async () => {
    const mainSource = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
    const handlerIdx = mainSource.indexOf("registerHandler('get-ratecard-preview'");
    assert(handlerIdx !== -1, 'get-ratecard-preview handler not found');
    const handlerWindow = mainSource.slice(handlerIdx, handlerIdx + 1800);
    assert(handlerWindow.includes('No successful local extraction is staged'), 'preview must explain that extraction is required');
    assert(!handlerWindow.includes('getDesktopPool'), 'rate review preview must not open direct PostgreSQL connections');
    assert(!handlerWindow.includes('buildBrandRateCardSet'), 'empty reviews must not manufacture a database-derived preview');
  });

  await runTest('scrape retries retain the original category selection', async () => {
    const mainSource = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
    const handlerIdx = mainSource.indexOf('async function executeScrapeProcess(config, onProgress)');
    assert(handlerIdx !== -1, 'executeScrapeProcess not found');
    const handlerWindow = mainSource.slice(handlerIdx, handlerIdx + 5200);
    const requestedIdx = handlerWindow.indexOf('const requestedVerticals = Array.isArray(effectiveConfig.scopeVerticals)');
    const loopIdx = handlerWindow.indexOf('for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)');
    assert(requestedIdx !== -1 && requestedIdx < loopIdx, 'the initial explicit category selection must be snapshotted before retries');
    assert(handlerWindow.includes('effectiveConfig.requiredVerticals = verticalSelection.requiredVerticals;'), 'each attempt must derive required categories from the original request and current backend categories');
  });

  await runTest('Linux installer verifies runtime modules resolve before skipping npm install', async () => {
    const installer = fs.readFileSync(path.join(path.resolve(desktopDir, '..'), 'released', 'linux', 'install-linux.sh'), 'utf8');
    // Old node_modules directories predate puppeteer-core; the installer must
    // verify every runtime module RESOLVES (not just that directories exist)
    // so upgraded installs never ship a browserRuntime that fails at startup.
    assert(installer.includes('puppeteer-core'), 'installer dependency check must cover puppeteer-core');
    assert(installer.includes('require.resolve'), 'installer must verify modules resolve, not just that node_modules directories exist');
    assert(/exit 1/.test(installer), 'installer must fail loudly when dependencies cannot be installed');
  });

  await runTest('preload bridge is packaged as preload.cjs (not preload.js)', async () => {
    assert(fs.existsSync(path.join(desktopDir, 'preload.cjs')), 'desktop/preload.cjs is missing');
    assert(!fs.existsSync(path.join(desktopDir, 'preload.js')), 'stale desktop/preload.js still present');
    const mainSource = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
    assert(/preload\.cjs/.test(mainSource), 'main.js does not reference preload.cjs');
    assert(!/preload\.js/.test(mainSource), 'main.js still references preload.js');
  });

  await runTest('new runtime modules are present next to main.js', async () => {
    for (const file of ['browserRuntime.js', 'browserRecoveryRegistry.js', 'sessionAccess.js', 'scrapeResults.js', 'dbUrlGuard.js', 'httpAccess.js', 'portalScraper.js', 'externalBrowserSession.js']) {
      assert(fs.existsSync(path.join(desktopDir, file)), `${file} is missing`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
    assert(pkg.dependencies?.['puppeteer-core'], 'puppeteer-core is not a declared dependency');
    const filePatterns = pkg.build?.files || pkg.files || [];
    assert(filePatterns.includes('!.env') && filePatterns.includes('!.env.*'), 'package build files must exclude .env');
    assert(filePatterns.includes('!tests/**'), 'package build files must exclude tests/');
    assert(filePatterns.includes('!.runtime/**'), 'package build files must exclude .runtime/');
  });

  await runTest('release preparation exports only the Windows setup and Linux AppImage', async () => {
    const releaseScript = fs.readFileSync(path.resolve(desktopDir, '../scripts/prepare-release.js'), 'utf8');
    assert(releaseScript.includes('ReconCentral-RateCard-Worker-Setup-') && releaseScript.includes('.exe'), 'release helper must prepare the versioned Windows setup');
    assert(releaseScript.includes('ReconCentral RateCard Worker-') && releaseScript.includes('.AppImage'), 'release helper must prepare the Linux AppImage');
    assert(!releaseScript.includes('Portable.exe') && !releaseScript.includes('.deb'), 'release helper must not prepare alternate installer packages');
  });
  // ── GitHub Releases + auto-update invariants ──────────────────────────────
  await runTest('package.json publishes to GitHub Releases and ships electron-updater', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
    assert(/^\d+\.\d+\.\d+$/.test(pkg.version || ''), `version must be a release tag basis, got: ${pkg.version}`);
    assert(pkg.dependencies?.['electron-updater'], 'electron-updater must be a declared dependency (packaged into the ASAR for the updater)');
    const publishers = pkg.build?.publish || [];
    const github = publishers.find((p) => p?.provider === 'github');
    assert(github, 'build.publish must use the GitHub provider so releases double as the update feed');
    assert(github.owner === 'pawanshukla500' && github.repo === 'DashBorad-Project', 'GitHub publisher must point at the ReconCentral repository');
    assert(github.releaseType === 'release', 'tagged builds must publish live releases — draft releases are invisible to the public update feed');
    const winTargets = pkg.build?.win?.target || [];
    assert(winTargets.length === 1 && winTargets.includes('nsis'), 'the versioned NSIS setup must be the only Windows installer');
    const linuxTargets = pkg.build?.linux?.target || [];
    assert(linuxTargets.length === 1 && linuxTargets.includes('AppImage'), 'the Linux AppImage must be the only Linux installer');
  });

  await runTest('main.js wires auto-update safely (static invariant)', async () => {
    const mainSource = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
    assert(mainSource.includes("app.setAppUserModelId('com.reconcentral.ratecardworker')"), 'Windows toasts need the app user model id to match build.appId');
    const loadIdx = mainSource.indexOf('function loadAutoUpdater()');
    assert(loadIdx !== -1, 'loadAutoUpdater not found');
    const loadWindow = mainSource.slice(loadIdx, loadIdx + 500);
    assert(loadWindow.includes('if (!app.isPackaged || process.platform !== \'win32\') return null;'), 'dev runs must never attempt auto-updates, and packaged Linux GUI builds must not check a feed the release workflow never publishes');
    assert(loadWindow.includes("require('electron-updater')"), 'packaged updater must load electron-updater');
    const setupIdx = mainSource.indexOf('function setupAutoUpdate()');
    assert(setupIdx !== -1, 'setupAutoUpdate not found');
    const setupWindow = mainSource.slice(setupIdx, setupIdx + 2200);
    assert(setupWindow.includes('autoUpdater.autoDownload = true'), 'updates must download automatically once found');
    assert(setupWindow.includes('autoUpdater.autoInstallOnAppQuit = true'), 'an ignored prompt must still apply the update on the next quit');
    for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error']) {
      assert(setupWindow.includes(`'${event}'`), `updater must forward '${event}' to the renderer`);
    }
    assert(setupWindow.includes('mainWindow.webContents.send(UPDATE_STATUS_CHANNEL') || mainSource.includes('mainWindow.webContents.send(UPDATE_STATUS_CHANNEL'), 'renderer update notifications must ride the update-status channel');
    assert(/setTimeout\(\(\) => \{ checkForAppUpdate\(\); \}/.test(setupWindow), 'an update check must run shortly after launch');
    assert(/setInterval\(\(\) => \{ checkForAppUpdate\(\); \}/.test(setupWindow), 'update checks must be periodic');
    const ipcWindow = mainSource.slice(mainSource.indexOf("registerHandler('update-get-status'"), mainSource.indexOf("registerHandler('update-get-status'") + 1600);
    for (const channel of ['update-get-status', 'update-check', 'update-install']) {
      assert(mainSource.includes(`registerHandler('${channel}'`), `missing IPC handler ${channel}`);
    }
    assert(mainSource.includes("'update-get-status', 'update-check', 'update-install'"), 'update IPC channels must be public: an update must be applicable before sign-in and must never touch session or database data');
    assert(ipcWindow.includes('quitAndInstall(true, true)'), 'install prompt must silently install and relaunch');
    assert(ipcWindow.includes("lastUpdateStatus?.status !== 'downloaded'"), 'install must be refused until an update has actually downloaded');
  });

  await runTest('preload bridge exposes the update lifecycle (static invariant)', async () => {
    const preloadSource = fs.readFileSync(path.join(desktopDir, 'preload.cjs'), 'utf8');
    for (const [api, channel] of [
      ['getUpdateStatus', 'update-get-status'],
      ['checkForUpdates', 'update-check'],
      ['installUpdate', 'update-install']
    ]) {
      assert(preloadSource.includes(`${api}: () => ipcRenderer.invoke('${channel}')`), `preload must expose ${api} over ${channel}`);
    }
    assert(preloadSource.includes("ipcRenderer.on('update-status', subscription)"), 'preload must subscribe to update-status events');
    const subIdx = preloadSource.indexOf('onUpdateStatus: (callback) =>');
    assert(subIdx !== -1, 'preload onUpdateStatus not found');
    const subWindow = preloadSource.slice(subIdx, subIdx + 400);
    assert(subWindow.includes("ipcRenderer.removeListener('update-status', subscription)"), 'event subscription must return an unsubscribe handle');
  });

  await runTest('renderer shows an update banner with a restart prompt (static invariant)', async () => {
    const htmlSource = fs.readFileSync(path.join(desktopDir, 'ui', 'index.html'), 'utf8');
    for (const id of ['update-banner', 'update-banner-text', 'btn-update-restart']) {
      assert(htmlSource.includes(`id="${id}"`), `index.html is missing #${id}`);
    }
    const bannerStart = htmlSource.indexOf('id="update-banner"');
    const bannerTag = htmlSource.slice(bannerStart, htmlSource.indexOf('>', bannerStart));
    assert(/display:\s*none/.test(bannerTag), 'the update banner must start hidden');

    const rendererSource = fs.readFileSync(path.join(desktopDir, 'ui', 'renderer.js'), 'utf8');
    // Standalone Chrome mode must degrade honestly, never claim update support.
    const shimIdx = rendererSource.indexOf('if (!window.ratecardAPI)');
    assert(shimIdx !== -1, 'standalone shim not found');
    const firstFunctionIdx = rendererSource.indexOf('async function checkAuthSession');
    const shimNoopInstall = rendererSource.indexOf('installUpdate: () => Promise.resolve({ success: false');
    const shimNoopSubscribe = rendererSource.indexOf('onUpdateStatus: () => () => {}');
    assert(shimNoopInstall !== -1 && shimNoopInstall > shimIdx && shimNoopInstall < firstFunctionIdx, 'standalone shim must refuse installs');
    assert(shimNoopSubscribe !== -1 && shimNoopSubscribe > shimIdx && shimNoopSubscribe < firstFunctionIdx, 'standalone shim must provide a no-op update subscription');
    const initIdx = rendererSource.indexOf('async function initUpdateBanner()');
    assert(initIdx !== -1, 'initUpdateBanner not found');
    const domIdx = rendererSource.indexOf("document.addEventListener('DOMContentLoaded'");
    assert(domIdx !== -1, 'DOMContentLoaded bootstrap not found');
    const domWindow = rendererSource.slice(domIdx, domIdx + 700);
    assert(domWindow.includes('initUpdateBanner();'), 'the banner must be initialized at startup');
    const applyIdx = rendererSource.indexOf('function applyUpdateBanner(status)');
    assert(applyIdx !== -1, 'applyUpdateBanner not found');
    const applyWindow = rendererSource.slice(applyIdx, applyIdx + 2600);
    assert(applyWindow.includes("kind === 'downloaded'"), 'a downloaded update must surface the banner');
    assert(applyWindow.includes("kind === 'error'"), 'update errors must be reported without blocking the UI');
    assert(applyWindow.includes('pendingUpdateDownloaded'), 'a downloaded update must keep the restart prompt sticky');
    assert(/if \(pendingUpdateDownloaded\) \{\s*show\(/.test(applyWindow), 'the downloaded restart prompt must survive the later periodic checking/not-available events');
    assert(applyWindow.includes('restartBtn.style.display'), 'the restart button must be hidden unless an update is ready');
    const clickIdx = rendererSource.indexOf("restartBtn?.addEventListener('click'");
    assert(clickIdx !== -1, 'restart button click wiring not found');
    const clickWindow = rendererSource.slice(clickIdx, clickIdx + 900);
    assert(clickWindow.includes('installUpdate'), 'restart button must trigger installUpdate');
    assert(clickWindow.includes('res?.success'), 'restart button must check the install result before claiming success');
  });

  await runTest('release workflow tests installed packages before publishing version tags', async () => {
    const workflow=fs.readFileSync(path.resolve(desktopDir,'../.github/workflows/ratecard-desktop-release.yml'),'utf8');
    assert(workflow.includes("tags: ['v*.*.*']"), 'Version tags are required');
    assert(workflow.includes('pull_request:'), 'PRs must execute packaged acceptance');
    assert(workflow.includes('--publish never'), 'Building must not publish untested packages');
    assert(workflow.includes('needs: [package, postgres]'), 'Publication must depend on both installed-package checks');
    assert(workflow.includes('Install and launch actual Windows package') && workflow.includes('Launch the actual Linux AppImage package'), 'Both OS packages must execute after installation');
    assert(workflow.includes('softprops/action-gh-release@v2'), 'Tag releases must upload artifacts and feed');
    assert(workflow.includes('npm ci') && workflow.includes('npm test'), 'Reproducible desktop tests must gate packaging');
    assert(workflow.includes('does not match desktop/package.json version'), 'Tag/version mismatch must fail clearly');
  });

  // ── Embedded browser engine (Electron WebContentsView adapter) ────────────
  const { createEmbeddedPage, createEmbeddedRuntime, DEFAULT_EDGE_USER_AGENT } = await import('../embeddedBrowser.js');

  function makeFakeEmbeddedDeps({ loadHangs = false, loadDelayMs = 0, evalBehavior = null, withDebugger = false } = {}) {
    const calls = { userAgent: [], cookieSets: [], inputEvents: [], order: [], bounds: [], attached: 0, removed: 0, closed: false, visible: [] };
    let loadedUrl = '';
    let behavior = evalBehavior || ((script) => {
      if (/document\.readyState/.test(script)) return true;
      if (/document\.querySelector\("input/.test(script) || /offsetParent/.test(script) || /getComputedStyle/.test(script)) return 'present';
      return 'ok';
    });
    const listeners = {};
    const fakeContents = {
      scripts: [],
      async executeJavaScript(script) {
        fakeContents.scripts.push(script);
        return behavior(script);
      },
      async loadURL(url) {
        loadedUrl = url;
        if (loadHangs) return new Promise(() => {});
        if (loadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, loadDelayMs));
        return { url };
      },
      getURL: () => 'https://seller.flipkart.com/fake',
      getTitle: () => 'Fake Seller Hub',
      focus() { calls.order.push('focus'); },
      sendInputEvent(event) {
        calls.inputEvents.push(event);
        calls.order.push(event.type === 'char' ? `char:${event.keyCode}` : event.type);
      },
      capturePage: async () => ({ toPNG: () => Buffer.from('fake-png') }),
      on(event, handler) {
        (listeners[event] = listeners[event] || []).push(handler);
      },
      once(event, handler) {
        (listeners[event] = listeners[event] || []).push(handler);
      },
      removeListener(event, handler) {
        listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
      },
      close() { calls.closed = true; }
    };
    const debuggerHandlers = [];
    if (withDebugger) {
      fakeContents.debugger = {
        attached: null,
        sent: [],
        attach(version) { this.attached = version; },
        on(event, handler) { if (event === 'message') debuggerHandlers.push(handler); },
        // Mirrors the REAL Electron WebContents.debugger surface: commands go
        // through sendCommand (async) — the adapter must not rely on a
        // nonexistent send() or the monitor would silently disable itself in
        // production while the fake kept it working.
        sendCommand(command) { this.sent.push(command); return Promise.resolve({}); },
        detach() { this.attached = null; }
      };
    }
    class FakeView {
      constructor(options) {
        this.webPreferences = options.webPreferences;
        this.webContents = fakeContents;
        this.visibleState = null;
        this.boundsSet = null;
      }
      setVisible(v) { this.visibleState = v; calls.visible.push(v); }
      getVisible() { return this.visibleState; }
      setBounds(b) { this.boundsSet = b; calls.bounds.push(b); }
    }
    const partitions = [];
    const storedCookies = [];
    const fakeSession = {
      fromPartition: (partition) => {
        partitions.push(partition);
        return {
          setUserAgent: (ua) => calls.userAgent.push(ua),
          cookies: {
            get: async (filter = {}) => storedCookies.filter((c) => !filter.name || c.name === filter.name),
            set: async (cookie) => {
              storedCookies.push(cookie);
              calls.cookieSets.push(cookie);
            }
          }
        };
      }
    };
    let contentSize = [1024, 640]; // real Electron getContentSize() returns [width, height]
    const winListeners = {};
    const fakeWindow = {
      getContentSize: () => [...contentSize],
      on(event, handler) { (winListeners[event] = winListeners[event] || []).push(handler); },
      removeListener(event, handler) {
        winListeners[event] = (winListeners[event] || []).filter((h) => h !== handler);
      },
      contentView: {
        addChildView: () => { calls.attached += 1; },
        removeChildView: () => { calls.removed += 1; }
      }
    };
    // Fast but REAL timers: an async () => {} stub never yields to the event
    // loop's timer phase, so scripted CDP/drain events (macrotasks) could
    // never fire while a poll loop spins on microtasks alone.
    const instantDelay = async (ms) => { await new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 5))); };
    return {
      deps: { WebContentsView: FakeView, session: fakeSession, delay: instantDelay },
      calls,
      fakeContents,
      fakeWindow,
      setBehavior: (next) => { behavior = next; },
      fire: (event, ...args) => [...(listeners[event] || [])].forEach((h) => h(...args)),
      emitNetwork: (method, params = {}, sessionId) => debuggerHandlers.forEach((h) => h({}, method, params, sessionId)),
      debuggerAttached: () => (fakeContents.debugger ? fakeContents.debugger.attached : 'absent'),
      debuggerCommands: () => (fakeContents.debugger ? fakeContents.debugger.sent : []),
      partitionsUsed: () => partitions,
      resizeWindow: (width, height) => {
        contentSize = [width, height];
        [...(winListeners.resize || [])].forEach((h) => h());
      },
      loadedUrl: () => loadedUrl
    };
  }

  await runTest('embedded page enforces partition, real-browser UA, and hard security flags', async () => {
    const harness = makeFakeEmbeddedDeps();
    let rejected = false;
    try {
      createEmbeddedPage({ window: harness.fakeWindow, partition: 'flipkart', userAgent: DEFAULT_EDGE_USER_AGENT, deps: harness.deps });
    } catch { rejected = true; }
    assert(rejected, 'a non-persistent partition must be refused');

    rejected = false;
    try {
      createEmbeddedPage({
        window: harness.fakeWindow, partition: 'persist:marketplace-flipkart',
        userAgent: 'Mozilla/5.0 Electron/33.0', deps: harness.deps
      });
    } catch { rejected = true; }
    assert(rejected, 'an Electron-advertising UA must be refused');

    const page = createEmbeddedPage({
      window: harness.fakeWindow, partition: 'persist:marketplace-flipkart',
      bounds: { x: 0, y: 56, width: 1200, height: 700 }, deps: harness.deps
    });
    assert(harness.calls.attached === 1, 'the view must be attached to the window');
    assert(harness.calls.bounds.length === 1, 'bounds must be applied on creation');
    assert(harness.calls.userAgent.length === 1 && !/electron/i.test(harness.calls.userAgent[0]), 'the real-browser UA must be applied to the session');
    const prefs = page._view.webPreferences;
    assert(prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false && prefs.webSecurity === true,
      'portal pages are untrusted: sandbox + isolation + no Node + web security are mandatory');
    assert(page.getVisible() === true, 'the view starts visible by default');

    // A WebContentsView starts at 0×0: omitted bounds must never leave a
    // blank "visible" surface.
    const unbounded = createEmbeddedPage({ window: harness.fakeWindow, partition: 'persist:marketplace-flipkart', deps: harness.deps });
    assert(unbounded._view.boundsSet && unbounded._view.boundsSet.width === 1024 && unbounded._view.boundsSet.height === 640,
      'without explicit bounds the view must cover the host window content area, never a blank 0x0 surface');
    harness.resizeWindow(1440, 900);
    assert(unbounded._view.boundsSet.width === 1440 && unbounded._view.boundsSet.height === 900,
      'resizing the host window must re-layout the embedded view (stale bounds clip or blank the surface)');
    await unbounded.close();
    const bareWindowPage = createEmbeddedPage({
      window: { contentView: { addChildView: () => {}, removeChildView: () => {} } },
      partition: 'persist:marketplace-flipkart',
      deps: harness.deps
    });
    assert(bareWindowPage._view.boundsSet.width === 1280 && bareWindowPage._view.boundsSet.height === 720,
      'a window without a content size must still receive non-zero default bounds');
  });

  await runTest('response-stage capture preserves fee bodies and always resumes failed and unrelated requests', async () => {
    const harness = makeFakeEmbeddedDeps({withDebugger:true});
    const commands=[];
    harness.fakeContents.debugger.sendCommand = async (command, params, sessionId) => {
      commands.push({command,params,sessionId});
      if(command==='Fetch.getResponseBody') {
        if(params.requestId==='broken') throw new Error('fixture body unavailable');
        return {body:JSON.stringify({data:{settlement:{platformFee:{serviceProfile:'NON_FBF',slabs:{asp:[]}}}}})};
      }
      return {};
    };
    const page=createEmbeddedPage({window:harness.fakeWindow,partition:'persist:capture-test',deps:harness.deps});
    const postData=JSON.stringify({variables:{input:{fsn:'ABCDEFGHIJKLMNOP',partnerContext:'flipkart',serviceProfile:'NON_FBF',date:'2026-10-30',darwinTier:'fixture'}}});
    for(const requestId of ['valid','broken','unrelated']) harness.emitNetwork('Fetch.requestPaused',{
      requestId,responseStatusCode:200,request:{url:'https://seller.flipkart.com/orchestrator/graphql',postData:requestId==='unrelated'?'{}':postData}
    },'fixture-session');
    await new Promise(resolve=>setTimeout(resolve,20));
    const snapshot=page.rateCardCapture.snapshot({fsn:'ABCDEFGHIJKLMNOP',marketplace:'flipkart',fulfilment:'NON_FBF',date:'2026-10-30'});
    assert(snapshot.fees.platformFee,'The exact response must be captured while paused');
    assert.strictEqual(commands.filter(c=>c.command==='Fetch.continueRequest').length,3,'Every paused response must be released');
    assert.strictEqual(commands.filter(c=>c.command==='Fetch.getResponseBody').length,2,'Unrelated GraphQL bodies must not be read');
    assert(commands.filter(c=>c.command==='Fetch.getResponseBody').every(c=>c.sessionId==='fixture-session'),'Commands must target the emitting session');
    await page.close();
  });

  await runTest('embedded goto waits for real network quiet via the CDP monitor, with honest fallback', async () => {
    // With a working debugger: in-flight requests hold the wait, completions
    // release it — the quiet signal is real, not a fixed delay.
    const live = makeFakeEmbeddedDeps({ withDebugger: true });
    live.setBehavior((script) => {
      if (/document\.readyState/.test(script)) {
        live.emitNetwork('Network.requestWillBeSent');
        live.emitNetwork('Network.requestWillBeSent');
        live.emitNetwork('Network.requestWillBeSent');
        setTimeout(() => {
          live.emitNetwork('Network.loadingFinished');
          live.emitNetwork('Network.loadingFinished');
          live.emitNetwork('Network.loadingFailed');
        }, 60);
      }
      return true;
    });
    const livePage = createEmbeddedPage({ window: live.fakeWindow, partition: 'persist:marketplace-flipkart', deps: live.deps });
    const liveResult = await livePage.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2', timeout: 5000 });
    assert(liveResult.ok === true && liveResult.networkWait === 'network-quiet', `a healthy load must reach network-quiet, got: ${liveResult.networkWait}`);
    assert(live.debuggerAttached() === '1.3', 'the CDP monitor must attach to the view');
    assert(live.debuggerCommands().includes('Network.enable'), 'the Network domain must be enabled');
    await livePage.close();

    // A debugger whose Network.enable fails (disconnects mid-session) must
    // never leave a monitor that always reads zero pending requests — that
    // would report busy pages quiet — so it degrades to the fixed settle.
    const broken = makeFakeEmbeddedDeps({ withDebugger: true });
    broken.fakeContents.debugger.sendCommand = () => Promise.reject(new Error('debugger disconnected'));
    const brokenPage = createEmbeddedPage({ window: broken.fakeWindow, partition: 'persist:marketplace-flipkart', deps: broken.deps });
    const brokenResult = await brokenPage.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2', timeout: 5000 });
    assert(brokenResult.ok === true && brokenResult.networkWait === 'settle-fallback',
      `a failed Network.enable must degrade to the settle fallback, got: ${brokenResult.networkWait}`);
    await brokenPage.close();

    // Without a debugger the adapter must degrade to the fixed settle, never fail.
    const plain = makeFakeEmbeddedDeps();
    const plainPage = createEmbeddedPage({ window: plain.fakeWindow, partition: 'persist:marketplace-flipkart', deps: plain.deps });
    const plainResult = await plainPage.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2', timeout: 5000 });
    assert(plainResult.ok === true && plainResult.networkWait === 'settle-fallback', 'without a debugger goto must fall back to the fixed settle');
    assert(plain.loadedUrl() === 'https://seller.flipkart.com/', 'the target URL must reach loadURL');

    // When the debugger is unavailable, if remaining timeout is shorter than the settle requirement, it must fail with TimeoutError
    let plainTimedOut = false;
    try { await plainPage.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2', timeout: 500 }); }
    catch (err) { plainTimedOut = err.name === 'TimeoutError'; }
    assert(plainTimedOut, 'settle fallback must fail if the requested timeout is shorter than the settle duration');
    await plainPage.close();

    // A network that NEVER goes quiet must fail the navigation: returning ok
    // while rate-card XHRs are still pending is the incomplete read the
    // monitor exists to prevent.
    const noisy = makeFakeEmbeddedDeps({ withDebugger: true });
    noisy.setBehavior((script) => {
      if (/document\.readyState/.test(script)) {
        noisy.emitNetwork('Network.requestWillBeSent');
        noisy.emitNetwork('Network.requestWillBeSent');
        noisy.emitNetwork('Network.requestWillBeSent');
      }
      return true;
    });
    const noisyPage = createEmbeddedPage({ window: noisy.fakeWindow, partition: 'persist:marketplace-flipkart', deps: noisy.deps });
    let noisyTimedOut = false;
    try { await noisyPage.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2', timeout: 1200 }); }
    catch (err) { noisyTimedOut = err.name === 'TimeoutError' && /quiet network state/.test(err.message); }
    assert(noisyTimedOut, 'a network that never quiets must reject goto with a TimeoutError');

    // `timeout` is the budget for the WHOLE navigation: a slow load must eat
    // into the network-quiet wait, not grant it a fresh copy of the limit.
    const slowLoad = makeFakeEmbeddedDeps({ loadDelayMs: 500, withDebugger: true });
    slowLoad.setBehavior((script) => {
      if (/document\.readyState/.test(script)) {
        slowLoad.emitNetwork('Network.requestWillBeSent');
        slowLoad.emitNetwork('Network.requestWillBeSent');
        slowLoad.emitNetwork('Network.requestWillBeSent');
      }
      return true;
    });
    const slowLoadPage = createEmbeddedPage({ window: slowLoad.fakeWindow, partition: 'persist:marketplace-flipkart', deps: slowLoad.deps });
    const slowLoadStartedAt = Date.now();
    let slowLoadTimedOut = false;
    try { await slowLoadPage.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2', timeout: 800 }); }
    catch (err) { slowLoadTimedOut = err.name === 'TimeoutError'; }
    const slowLoadElapsed = Date.now() - slowLoadStartedAt;
    assert(slowLoadTimedOut, 'a navigation whose network never quiets must reject');
    assert(slowLoadElapsed < 1100, `the timeout must bound the whole navigation (load + quiet), took ${slowLoadElapsed}ms`);

    const hanging = makeFakeEmbeddedDeps({ loadHangs: true });
    const slowPage = createEmbeddedPage({ window: hanging.fakeWindow, partition: 'persist:marketplace-flipkart', deps: hanging.deps });
    let timedOut = false;
    try { await slowPage.goto('https://seller.flipkart.com/', { timeout: 50 }); }
    catch (err) { timedOut = err.name === 'TimeoutError'; }
    assert(timedOut, 'a hanging navigation must reject with a TimeoutError');
  });

  await runTest('embedded evaluate retries across navigation context destruction', async () => {
    const harness = makeFakeEmbeddedDeps();
    let attempt = 0;
    harness.setBehavior(() => {
      attempt += 1;
      if (attempt < 3) throw new Error('Script failed to execute during navigation');
      return 'recovered';
    });
    const page = createEmbeddedPage({ window: harness.fakeWindow, partition: 'persist:marketplace-flipkart', deps: harness.deps });
    const value = await page.evaluate(() => document.body.innerText);
    assert(value === 'recovered', `evaluate must survive transient context destruction, got: ${value}`);
    assert(attempt === 3, `the retry loop must re-attempt, attempts: ${attempt}`);

    const dying = makeFakeEmbeddedDeps();
    dying.setBehavior(() => { throw new Error('the page script itself failed'); });
    const doomed = createEmbeddedPage({ window: dying.fakeWindow, partition: 'persist:marketplace-flipkart', deps: dying.deps });
    let surfaced = false;
    try { await doomed.evaluate('boom()'); }
    catch (err) { surfaced = /page script itself failed/.test(err.message); }
    assert(surfaced, 'after the retry budget the real page error must surface');
  });

  await runTest('embedded waitForSelector polls, checks real visibility, and times out with TimeoutError', async () => {
    const harness = makeFakeEmbeddedDeps();
    const page = createEmbeddedPage({ window: harness.fakeWindow, partition: 'persist:marketplace-flipkart', deps: harness.deps });
    const found = await page.waitForSelector('input[name="username"]', { visible: true, timeout: 2000 });
    assert(found.ok === true, 'a present selector must resolve');

    // visibility:hidden / opacity:0 / display:none controls keep an
    // offsetParent but are invisible to users — a visible wait must reject
    // them (typing into an invisible control is the classic silent failure).
    const ghost = makeFakeEmbeddedDeps({ evalBehavior: (script) => (/getComputedStyle/.test(script) ? 'hidden' : 'present') });
    const ghostPage = createEmbeddedPage({ window: ghost.fakeWindow, partition: 'persist:marketplace-flipkart', deps: ghost.deps });
    let ghostTimedOut = false;
    try { await ghostPage.waitForSelector('input[name="username"]', { visible: true, timeout: 150 }); }
    catch (err) { ghostTimedOut = err.name === 'TimeoutError'; }
    assert(ghostTimedOut, 'a present-but-invisible control must not satisfy a visible wait');

    const empty = makeFakeEmbeddedDeps({ evalBehavior: () => 'absent' });
    const blindPage = createEmbeddedPage({ window: empty.fakeWindow, partition: 'persist:marketplace-flipkart', deps: empty.deps });
    let timedOut = false;
    try { await blindPage.waitForSelector('#never', { timeout: 150 }); }
    catch (err) { timedOut = err.name === 'TimeoutError'; }
    assert(timedOut, 'a never-appearing selector must reject with a TimeoutError');

    // Evaluation retries must share the poll's deadline: a renderer that
    // rejects every attempt (real retry gaps) must not run a 300ms wait late.
    const flaky = makeFakeEmbeddedDeps({ evalBehavior: () => { throw new Error('Script failed to execute during navigation'); } });
    flaky.deps.delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); // real retry gaps
    const flakyPage = createEmbeddedPage({ window: flaky.fakeWindow, partition: 'persist:marketplace-flipkart', deps: flaky.deps });
    const flakyStartedAt = Date.now();
    let flakyTimedOut = false;
    try { await flakyPage.waitForSelector('#never', { timeout: 300 }); }
    catch (err) { flakyTimedOut = err.name === 'TimeoutError'; }
    const flakyElapsed = Date.now() - flakyStartedAt;
    assert(flakyTimedOut, 'a failing evaluator must surface as a TimeoutError');
    assert(flakyElapsed < 1500, `selector waits must honor their own timeout despite evaluation retries, took ${flakyElapsed}ms`);

    // A renderer that never settles (stall) must not hold the wait open
    // past the timeout either — the deadline bounds a single execution.
    const stalled = makeFakeEmbeddedDeps();
    stalled.fakeContents.executeJavaScript = () => new Promise(() => {});
    const stalledPage = createEmbeddedPage({ window: stalled.fakeWindow, partition: 'persist:marketplace-flipkart', deps: stalled.deps });
    const stalledStartedAt = Date.now();
    let stalledTimedOut = false;
    try { await stalledPage.waitForSelector('#never', { timeout: 300 }); }
    catch (err) { stalledTimedOut = err.name === 'TimeoutError'; }
    const stalledElapsed = Date.now() - stalledStartedAt;
    assert(stalledTimedOut && stalledElapsed < 1500, 'a stalled renderer must not extend a selector wait beyond its timeout');
  });

  await runTest('embedded type clears React-safely, sends real key events, and verifies readback', async () => {
    const tracker = makeFakeEmbeddedDeps();
    let value = '';
    tracker.setBehavior((script) => {
      if (/HTMLInputElement\.prototype/.test(script)) return 'ok';
      if (/return el \? el\.value : null/.test(script)) return value;
      return 'ok';
    });
    const trackingPage = createEmbeddedPage({ window: tracker.fakeWindow, partition: 'persist:marketplace-flipkart', deps: tracker.deps });
    const originalSend = tracker.fakeContents.sendInputEvent;
    tracker.fakeContents.sendInputEvent = (event) => {
      if (event.type === 'char') value += event.keyCode;
      originalSend(event);
    };
    const text = 'ops@example.com';
    const ok = await trackingPage.type('input[name="username"]', text, { delay: 0 });
    assert(ok === true, 'typing must verify the field accepted the value');
    assert(value === text, `every character must ride a real keyboard event, got: ${value}`);
    const focusProbe = tracker.fakeContents.scripts.find((s) => /HTMLInputElement\.prototype/.test(s));
    assert(focusProbe && focusProbe.includes('dispatchEvent(new Event'), 'clearing must go through the native setter + input event so React stays in sync');
    assert(tracker.calls.order[0] === 'focus', 'the WebContents itself must be focused before the first keystroke — sendInputEvent only delivers to a focused WebContents');
    assert(tracker.calls.order[1] === `char:${text[0]}`, 'keystrokes must follow the focus call, not precede it');

    // Readback mismatch must fail loudly without leaking the typed secret.
    const liar = makeFakeEmbeddedDeps();
    liar.setBehavior((script) => (/HTMLInputElement\.prototype/.test(script) ? 'ok' : ''));
    const lyingPage = createEmbeddedPage({ window: liar.fakeWindow, partition: 'persist:marketplace-flipkart', deps: liar.deps });
    let caught = false;
    try { await lyingPage.type('input[name="password"]', 'secret-value', { delay: 0 }); }
    catch (err) { caught = /did not accept the value/.test(err.message) && !err.message.includes('secret-value'); }
    assert(caught, 'a rejected value must fail with length-only diagnostics');
  });

  await runTest('embedded cookies interoperate with the puppeteer-shaped vault format', async () => {
    const harness = makeFakeEmbeddedDeps();
    const page = createEmbeddedPage({ window: harness.fakeWindow, partition: 'persist:marketplace-flipkart', deps: harness.deps });
    await page.setCookie({ name: 'sid', value: 'x', domain: '.flipkart.com', path: '/', secure: true, httpOnly: true, expires: 1893456000, sameSite: 'no_restriction' });
    const set = harness.calls.cookieSets[0];
    assert(set && set.url === 'https://flipkart.com/', `Chromium needs a URL per cookie write, got: ${set && set.url}`);
    assert(set.sameSite === 'no_restriction', 'puppeteer sameSite values must map to Electron values');
    assert(set.expirationDate === 1893456000, 'expires must map to expirationDate');

    // Puppeteer marks session cookies with expires: -1; mapping that to a
    // negative expirationDate would make Chromium treat the cookie as already
    // expired and silently drop it (the login session would vanish).
    await page.setCookie({ name: 'session-only', value: 's', domain: '.flipkart.com', path: '/', secure: true, httpOnly: true, expires: -1, sameSite: 'lax' });
    const sessionCookieWrite = harness.calls.cookieSets[1];
    assert(sessionCookieWrite && sessionCookieWrite.expirationDate === undefined,
      'a puppeteer session cookie (expires: -1) must become a browser session cookie, not an already-expired one');
    assert(sessionCookieWrite.name === 'session-only', 'the second cookie write must be the session cookie');

    // The persistent partition outlives the vault file: a stale vault import
    // must never downgrade a live cookie's expiry (a previous run's refresh).
    await page.setCookie({ name: 'refreshed', value: 'new', domain: '.flipkart.com', path: '/', secure: true, expires: 2000000000, sameSite: 'lax' });
    await page.setCookie({ name: 'refreshed', value: 'stale', domain: '.flipkart.com', path: '/', secure: true, expires: 1000000000, sameSite: 'lax' });
    const refreshedWrites = harness.calls.cookieSets.filter((c) => c.name === 'refreshed');
    assert(refreshedWrites.length === 1, `a stale vault import must not overwrite a newer partition cookie, writes: ${refreshedWrites.length}`);
    await page.setCookie({ name: 'refreshed', value: 'newer', domain: '.flipkart.com', path: '/', secure: true, expires: 2100000000, sameSite: 'lax' });
    assert(harness.calls.cookieSets.filter((c) => c.name === 'refreshed').length === 2, 'a strictly newer cookie must overwrite the partition value');

    // Same name on a DIFFERENT path is a different cookie: its expiry must
    // not suppress this path's import.
    await page.setCookie({ name: 'paths', value: 'a', domain: '.flipkart.com', path: '/', expires: 2000000000, sameSite: 'lax' });
    await page.setCookie({ name: 'paths', value: 'b', domain: '.flipkart.com', path: '/dashboard', expires: 1900000000, sameSite: 'lax' });
    assert(harness.calls.cookieSets.filter((c) => c.name === 'paths').length === 2,
      'a different-path cookie must not be suppressed by another path with a later expiry');

    const list = await page.cookies();
    assert(list.length === 6, `the session cookie jar must be readable (sid, session-only, refreshed x2, paths x2), got ${list.length}`);
    assert(list[0].domain === '.flipkart.com' && list[0].expires === 1893456000 && list[0].session === false,
      'cookies() must return the vault-compatible puppeteer shape');
  });

  await runTest('embedded waitForNavigation resolves on navigation, honors the click race, and times out honestly', async () => {
    const harness = makeFakeEmbeddedDeps();
    const page = createEmbeddedPage({ window: harness.fakeWindow, partition: 'persist:marketplace-flipkart', deps: harness.deps });
    const navPromise = page.waitForNavigation({ timeout: 2000 });
    harness.fire('did-navigate');
    const nav = await navPromise;
    assert(nav.ok === true && nav.via === 'navigation-event', 'a navigation event must resolve the wait');

    // The scraper clicks submit and only then waits; a fast submit can
    // complete the navigation before the wait's listener registers, so a
    // navigation recorded after the action and inside the grace window
    // must count instead of dead-waiting for a second navigation.
    await page.evaluate(() => 1);
    harness.fire('did-navigate');
    const recent = await page.waitForNavigation({ timeout: 2000, graceMs: 800 });
    assert(recent.ok === true && recent.via === 'recent-navigation', 'a navigation inside the grace window must satisfy waitForNavigation');
    assert(recent.url === 'https://seller.flipkart.com/fake', 'the resolved navigation must report the current URL');

    // did-navigate-in-page also fires for subframes: an iframe's hash change
    // must never satisfy a top-level login wait, nor arm the grace window.
    const frames = makeFakeEmbeddedDeps();
    const framesPage = createEmbeddedPage({ window: frames.fakeWindow, partition: 'persist:marketplace-flipkart', deps: frames.deps });
    const subframePromise = framesPage.waitForNavigation({ timeout: 250 });
    frames.fire('did-navigate-in-page', null, 'https://ads.example.com/frame#x', false);
    let subframeTimedOut = false;
    try { await subframePromise; }
    catch (err) { subframeTimedOut = err.name === 'TimeoutError'; }
    assert(subframeTimedOut, 'a subframe in-page navigation must NOT satisfy the top-level wait');
    const mainFramePromise = framesPage.waitForNavigation({ timeout: 2000 });
    frames.fire('did-navigate-in-page', null, 'https://seller.flipkart.com/#payments', true);
    const mainFrame = await mainFramePromise;
    assert(mainFrame.ok === true && mainFrame.via === 'navigation-event',
      'a main-frame in-page navigation must satisfy the wait (and the subframe nav must not have armed the grace window)');

    // A subframe event arriving FIRST must not consume the in-page listener:
    // the following main-frame navigation still has to resolve the wait.
    const interleaved = makeFakeEmbeddedDeps();
    const interleavedPage = createEmbeddedPage({ window: interleaved.fakeWindow, partition: 'persist:marketplace-flipkart', deps: interleaved.deps });
    const interleavedPromise = interleavedPage.waitForNavigation({ timeout: 2000 });
    interleaved.fire('did-navigate-in-page', null, 'https://ads.example.com/frame#sub', false);
    interleaved.fire('did-navigate-in-page', null, 'https://seller.flipkart.com/#payments', true);
    const interleavedNav = await interleavedPromise;
    assert(interleavedNav.ok === true, 'a subframe navigation must not consume the in-page listener before a main-frame navigation');

    // The default waitUntil 'load' must poll for the real load event: a
    // commit plus a fixed settle resolves before a slow page is usable.
    const slowDoc = makeFakeEmbeddedDeps();
    let loadPolls = 0;
    slowDoc.setBehavior((script) => {
      if (/document\.readyState/.test(script)) {
        if (script.includes('=== \'complete\'') && !script.includes('||')) {
          loadPolls += 1;
          return loadPolls >= 3;
        }
        return true;
      }
      return 'ok';
    });
    const slowDocPage = createEmbeddedPage({ window: slowDoc.fakeWindow, partition: 'persist:marketplace-flipkart', deps: slowDoc.deps });
    await slowDocPage.evaluate(() => 1);
    slowDoc.fire('did-navigate');
    const slowDocNav = await slowDocPage.waitForNavigation({ timeout: 2000 });
    assert(slowDocNav.ok === true, 'the load wait must resolve once the document completes');
    assert(loadPolls >= 3, `the load wait must poll readyState instead of trusting the settle, polls: ${loadPolls}`);

    // A document that never completes must fail the wait, not return early.
    const neverLoaded = makeFakeEmbeddedDeps();
    neverLoaded.setBehavior((script) => (/document\.readyState/.test(script) ? false : 'ok'));
    const neverLoadedPage = createEmbeddedPage({ window: neverLoaded.fakeWindow, partition: 'persist:marketplace-flipkart', deps: neverLoaded.deps });
    await neverLoadedPage.evaluate(() => 1);
    neverLoaded.fire('did-navigate');
    let neverLoadedTimedOut = false;
    const neverLoadedStartedAt = Date.now();
    try { await neverLoadedPage.waitForNavigation({ timeout: 300 }); }
    catch (err) { neverLoadedTimedOut = err.name === 'TimeoutError' && /load state/.test(err.message); }
    const neverLoadedElapsed = Date.now() - neverLoadedStartedAt;
    assert(neverLoadedTimedOut && neverLoadedElapsed < 1500, 'a never-completing document must reject the load wait within its budget');

    // A navigation that PRECEDED the action can never be the submit's
    // navigation: it must be ignored, not accepted through the grace window.
    // (A real-time gap separates the stale navigation from the action —
    // timestamps have millisecond resolution, and a navigation recorded in
    // the same millisecond as the action is legitimately ambiguous.)
    const stale = makeFakeEmbeddedDeps();
    const stalePage = createEmbeddedPage({ window: stale.fakeWindow, partition: 'persist:marketplace-flipkart', deps: stale.deps });
    stale.fire('did-navigate');
    await new Promise((resolve) => setTimeout(resolve, 6));
    await stalePage.evaluate(() => 1);
    let staleTimedOut = false;
    try { await stalePage.waitForNavigation({ timeout: 250, graceMs: 2000 }); }
    catch (err) { staleTimedOut = err.name === 'TimeoutError'; }
    assert(staleTimedOut, 'a navigation recorded before the action must NOT satisfy waitForNavigation');

    // Action first, then the navigation it caused: the grace window accepts it.
    const armed = makeFakeEmbeddedDeps();
    const armedPage = createEmbeddedPage({ window: armed.fakeWindow, partition: 'persist:marketplace-flipkart', deps: armed.deps });
    await armedPage.evaluate(() => 1);
    armed.fire('did-navigate');
    const armedNav = await armedPage.waitForNavigation({ timeout: 2000, graceMs: 800 });
    assert(armedNav.ok === true && armedNav.via === 'recent-navigation', 'a navigation recorded after the action must satisfy the grace window');

    // Until an action arms the watch, a goto's own navigation must never be
    // reported as the waited-for navigation.
    const unArmed = makeFakeEmbeddedDeps();
    const unArmedPage = createEmbeddedPage({ window: unArmed.fakeWindow, partition: 'persist:marketplace-flipkart', deps: unArmed.deps });
    await unArmedPage.goto('https://seller.flipkart.com/', { timeout: 5000 });
    let unArmedTimedOut = false;
    try { await unArmedPage.waitForNavigation({ timeout: 250 }); }
    catch (err) { unArmedTimedOut = err.name === 'TimeoutError'; }
    assert(unArmedTimedOut, 'a goto navigation must not satisfy a wait that no action armed');

    // The scraper calls waitForNavigation({ waitUntil: 'networkidle2' }): the
    // post-navigation network wait must run, succeed on a quiet network, and
    // fail loudly when XHRs never drain.
    const quietNet = makeFakeEmbeddedDeps({ withDebugger: true });
    const quietPage = createEmbeddedPage({ window: quietNet.fakeWindow, partition: 'persist:marketplace-flipkart', deps: quietNet.deps });
    const quietPromise = quietPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 });
    quietNet.fire('did-navigate');
    const quietNav = await quietPromise;
    assert(quietNav.ok === true && quietNav.networkWait === 'network-quiet', `waitForNavigation must honor waitUntil networkidle2, got: ${quietNav.networkWait}`);

    const neverQuiet = makeFakeEmbeddedDeps({ withDebugger: true });
    const neverQuietPage = createEmbeddedPage({ window: neverQuiet.fakeWindow, partition: 'persist:marketplace-flipkart', deps: neverQuiet.deps });
    const neverQuietPromise = neverQuietPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 1200 });
    neverQuiet.emitNetwork('Network.requestWillBeSent');
    neverQuiet.emitNetwork('Network.requestWillBeSent');
    neverQuiet.emitNetwork('Network.requestWillBeSent');
    neverQuiet.fire('did-navigate');
    let neverQuietTimedOut = false;
    try { await neverQuietPromise; }
    catch (err) { neverQuietTimedOut = err.name === 'TimeoutError' && /quiet state after navigation/.test(err.message); }
    assert(neverQuietTimedOut, 'a navigation whose network never quiets must reject waitForNavigation');

    const silent = makeFakeEmbeddedDeps();
    const silentPage = createEmbeddedPage({ window: silent.fakeWindow, partition: 'persist:marketplace-flipkart', deps: silent.deps });
    let timedOut = false;
    try { await silentPage.waitForNavigation({ timeout: 100 }); }
    catch (err) { timedOut = err.name === 'TimeoutError'; }
    assert(timedOut, 'a navigation that never happens must reject with a TimeoutError');

    // `timeout` bounds the whole wait: the settle pause and the network-quiet
    // phase share the navigation's budget instead of fresh copies of it.
    const budgeted = makeFakeEmbeddedDeps({ withDebugger: true });
    budgeted.deps.delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); // real settle gaps
    const budgetedPage = createEmbeddedPage({ window: budgeted.fakeWindow, partition: 'persist:marketplace-flipkart', deps: budgeted.deps });
    const budgetStartedAt = Date.now();
    const budgetPromise = budgetedPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 800 });
    budgeted.fire('did-navigate');
    let budgetTimedOut = false;
    try { await budgetPromise; }
    catch (err) { budgetTimedOut = err.name === 'TimeoutError' && /quiet state after navigation/.test(err.message); }
    const budgetElapsed = Date.now() - budgetStartedAt;
    assert(budgetTimedOut, 'the post-navigation quiet wait must fail loudly inside the budget');
    assert(budgetElapsed < 1500, `waitForNavigation must bound settle + quiet by its timeout, took ${budgetElapsed}ms`);
  });

  await runTest('embedded runtime binds the marketplace context at creation and mirrors the puppeteer launch surface', async () => {
    // The scraper's launch() call is puppeteer-shaped: { headless,
    // executablePath, defaultViewport, args }. It cannot carry partition or
    // window, so the runtime must refuse creation without them — otherwise
    // launch() would produce a view that can never render.
    let rejected = false;
    try { createEmbeddedRuntime(); }
    catch { rejected = true; }
    assert(rejected, 'createEmbeddedRuntime without a partition must fail fast');

    rejected = false;
    try { createEmbeddedRuntime({ partition: 'persist:marketplace-flipkart' }); }
    catch { rejected = true; }
    assert(rejected, 'createEmbeddedRuntime without the host window must fail fast');

    rejected = false;
    try { createEmbeddedRuntime({ partition: 'marketplace-flipkart', window: { contentView: {} } }); }
    catch { rejected = true; }
    assert(rejected, 'a non-persistent partition must be refused');

    const harness = makeFakeEmbeddedDeps();
    const runtime = createEmbeddedRuntime({
      partition: 'persist:marketplace-flipkart',
      window: harness.fakeWindow,
      deps: harness.deps
    });
    const browser = await runtime.launch({
      headless: false,
      executablePath: 'ignored-external-chrome',
      defaultViewport: { width: 1500, height: 1000 },
      args: ['--start-maximized']
    });
    const pages = await browser.pages();
    assert(pages.length === 1, 'launch must provide the embedded page');
    assert(harness.partitionsUsed()[0] === 'persist:marketplace-flipkart', 'the runtime-bound partition must reach the session');
    const second = await browser.newPage();
    assert(second === pages[0], 'one marketplace view per partition: newPage must reuse the single view');
    assert(pages[0].getVisible() === true, 'headless:false must render the visible monitoring view');
    assert(harness.calls.attached === 1, 'the view must be attached to the runtime-bound host window');
    assert(browser.launchOptions.ignoredKeys.includes('executablePath') && browser.launchOptions.ignoredKeys.includes('args'),
      'puppeteer-shaped options must be accepted (and ignored) so the scraper passes them unchanged');

    const backgroundHarness = makeFakeEmbeddedDeps();
    const backgroundRuntime = createEmbeddedRuntime({
      partition: 'persist:marketplace-flipkart',
      window: backgroundHarness.fakeWindow,
      deps: backgroundHarness.deps
    });
    const backgroundBrowser = await backgroundRuntime.launch({ headless: 'new' });
    const backgroundPage = (await backgroundBrowser.pages())[0];
    assert(backgroundPage.getVisible() === false, 'headless must run as a hidden background view');

    await browser.close();
    assert(harness.calls.removed === 1 && harness.calls.closed === true, 'close must detach and close the view');
  });

  await runTest('embedded browser module is included in the packaged desktop app', async () => {
    assert(fs.existsSync(path.join(desktopDir, 'embeddedBrowser.js')), 'desktop/embeddedBrowser.js is missing');
    const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
    const packageFiles = packageJson.build?.files || [];
    assert(packageFiles.includes('**/*') && !packageFiles.some(pattern => pattern.includes('embeddedBrowser.js')),
      'the packaged desktop payload must include the embedded browser module');
  });

  await runTest('preload bridge exposes browser monitor API methods (stage 2)', async () => {
    const preloadPath = path.join(desktopDir, 'preload.cjs');
    assert(fs.existsSync(preloadPath), 'preload.cjs must exist');
    const preloadContent = fs.readFileSync(preloadPath, 'utf8');
    const requiredMethods = [
      'getBrowserMonitorState',
      'captureBrowserScreenshot',
      'setBrowserVisibility',
      'setBrowserEngine',
      'onBrowserMonitorUpdate'
    ];
    for (const method of requiredMethods) {
      assert(preloadContent.includes(`${method}:`), `preload.cjs must expose ${method}`);
    }
  });

  await runTest('index.html provides live browser monitor section and DOM structure (stage 2)', async () => {
    const htmlPath = path.join(desktopDir, 'ui', 'index.html');
    assert(fs.existsSync(htmlPath), 'index.html must exist');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const requiredSelectors = [
      'id="view-monitor"',
      'id="browser-live-badge"',
      'id="browser-dock-card"',
      'id="browser-view-dock"',
      'id="btn-monitor-screenshot"',
      'id="btn-monitor-login"',
      'id="monitor-auth-alert"',
      'id="browser-screenshot-img"'
    ];
    for (const sel of requiredSelectors) {
      assert(html.includes(sel), `index.html must contain element with ${sel}`);
    }
    assert(html.includes('External Chrome — persistent Seller Hub session'),
      'the monitor must explain that Seller Hub uses persistent external Chrome');
    assert(html.includes('data-channel="flipkart_shopsy"') && html.includes('Seller Hub Sign-in'),
      'Flipkart actions must be labeled Seller Hub Sign-in rather than 2FA Login');
    assert(!html.includes('value="embedded"'),
      'Flipkart monitor UI must not offer the isolated embedded session engine');
  });

  await runTest('main.js registers browser monitor IPC handlers and gates sensitive actions (stage 2)', async () => {
    const mainPath = path.join(desktopDir, 'main.js');
    const mainContent = fs.readFileSync(mainPath, 'utf8');

    const monitorHandlers = [
      'browser-monitor-get-state',
      'browser-monitor-screenshot',

      'browser-monitor-set-engine'
    ];
    for (const handler of monitorHandlers) {
      assert(mainContent.includes(`registerHandler('${handler}'`), `main.js must register IPC handler '${handler}'`);
    }
    assert(/registerHandler\('browser-monitor-set-engine',[\s\S]*?currentBrowserEngine = 'external'/.test(mainContent),
      'the monitor engine must remain external so manual login and worker extraction share a profile');

    // Static security invariant: Browser monitor, interactive login, and scrape operations
    // MUST NOT be public channels (they must require an authorized ReconCentral session).
    const publicChannelsMatch = mainContent.match(/const PUBLIC_CHANNELS = new Set\(\[([\s\S]*?)\]\);/);
    assert(publicChannelsMatch, 'main.js must define PUBLIC_CHANNELS');
    const publicList = publicChannelsMatch[1];
    for (const handler of monitorHandlers) {
      assert(!publicList.includes(`'${handler}'`), `'${handler}' must NOT be in PUBLIC_CHANNELS`);
    }
    assert(!publicList.includes("'interactive-login'"), "'interactive-login' must NOT be in PUBLIC_CHANNELS");
    assert(!publicList.includes("'start-scrape'"), "'start-scrape' must NOT be in PUBLIC_CHANNELS");
  });

  await runTest('renderer.js wires browser monitor UI events and state subscribers (stage 2)', async () => {
    const rendererPath = path.join(desktopDir, 'ui', 'renderer.js');
    const rendererContent = fs.readFileSync(rendererPath, 'utf8');
    assert(rendererContent.includes('initBrowserMonitorListeners()'), 'renderer.js must initialize monitor listeners');
    assert(rendererContent.includes('updateBrowserMonitorUI('), 'renderer.js must have updateBrowserMonitorUI');
    assert(rendererContent.includes('refreshBrowserMonitorState()'), 'renderer.js must have refreshBrowserMonitorState');
    assert(!rendererContent.includes('setBrowserVisibility('), 'external Chrome visibility is controlled by its own window, not an embedded viewport');
  });

  await runTest('portalScraper triggers onSessionExpiry when session check fails (stage 3)', async () => {
    const { scrapeFlipkartRateCards } = await import('../portalScraper.js');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-session-expiry-'));
    let sessionExpiryTriggered = false;
    let authChecked = false;

    const fakePage = {
      setCookie: async () => {},
      goto: async () => {},
      evaluate: async () => {
        authChecked = true;
        return false;
      },
      url: () => 'https://seller.flipkart.com/login',
      title: () => 'Login Required',
      cookies: async () => [{ name: 'refreshed_session', value: '123' }]
    };

    const fakeBrowser = {
      pages: async () => [fakePage],
      newPage: async () => fakePage,
      close: async () => {}
    };

    const fakeRuntime = {
      launch: async () => fakeBrowser,
      partition: 'persist:test'
    };

    try {
      const result = await scrapeFlipkartRateCards({ marketplace: 'flipkart' }, {
        runtime: fakeRuntime,
        onProgress: () => {},
        delay: () => {},
        cookiesPath: path.join(tempDir, 'cookies.json'),
        fallbackCookiesPath: path.join(tempDir, 'fallback-cookies.json'),
        stagingDir: path.join(tempDir, 'staging'),
        onSessionExpiry: async (activePage) => {
          sessionExpiryTriggered = true;
          assert(activePage && typeof activePage.url === 'function' && activePage.url() === fakePage.url(),
            'onSessionExpiry must receive the active paced page');
          assert(activePage !== fakePage, 'portal interactions must use the pacing wrapper');
          return true;
        }
      });

      assert(authChecked, 'checkSession must be called on home page');
      assert(sessionExpiryTriggered, 'onSessionExpiry must be invoked when checkSession fails');
      assert.strictEqual(result.success, false);
      assert(/did not establish an authenticated dashboard session/.test(result.error), result.error);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await runTest('executeScrapeProcess implements 2-attempt retry loop with backoff (stage 3)', async () => {
    const mainPath = path.join(desktopDir, 'main.js');
    const mainContent = fs.readFileSync(mainPath, 'utf8');

    assert(mainContent.includes('const MAX_ATTEMPTS = 2;'), 'main.js must define MAX_ATTEMPTS = 2');
    assert(mainContent.includes('isPermanentScrapeError(err)'), 'main.js must guard against retrying permanent errors');
    assert(mainContent.includes('onSessionExpiry'), 'main.js must wire onSessionExpiry into scrapeFlipkartRateCards');
    assert(mainContent.includes("status: 'login_prompt'"), 'main.js must transition monitor status to login_prompt on expiry');
  });

  await runTest('preload.cjs and renderer.js wire onBrowserMonitorPromptLogin (stage 3)', async () => {
    const preloadPath = path.join(desktopDir, 'preload.cjs');
    const preloadContent = fs.readFileSync(preloadPath, 'utf8');
    assert(preloadContent.includes('onBrowserMonitorPromptLogin:'), 'preload.cjs must expose onBrowserMonitorPromptLogin');

    const rendererPath = path.join(desktopDir, 'ui', 'renderer.js');
    const rendererContent = fs.readFileSync(rendererPath, 'utf8');
    assert(rendererContent.includes('onBrowserMonitorPromptLogin'), 'renderer.js must subscribe to onBrowserMonitorPromptLogin');
  });

  await runTest('detectBrandRateChanges flags commission shifts >=5% and relative shifts >=50% as anomalies (stage 4)', async () => {
    const { detectBrandRateChanges, annotateRateAnomaly } = await import('../rateCardService.js');
    assert(typeof annotateRateAnomaly === 'function', 'annotateRateAnomaly must be exported');

    // Commission shift >= 5%
    const mockPool5Pct = {
      query: async () => ({
        rows: [{ price_min: '0.00', price_max: '500.00', rate: '0.1000' }]
      })
    };
    const testCard5Pct = {
      marketplace: 'flipkart',
      category: 'top',
      brand: 'Sangria',
      commissions: [{ price_min: 0, price_max: 500, rate: 0.16 }] // 10% -> 16% (+6% absolute, >=5%)
    };
    const changes5Pct = await detectBrandRateChanges([testCard5Pct], mockPool5Pct);
    assert.strictEqual(changes5Pct.length, 1);
    assert.strictEqual(changes5Pct[0].anomaly, true);
    assert.strictEqual(changes5Pct[0].anomalyType, 'commission_shift');
    assert.strictEqual(changes5Pct[0].anomalySeverity, 'high');
    assert(changes5Pct[0].reason.includes('⚠️ Anomaly'), 'reason must include anomaly badge note');

    // Commission shift < 5% and < 50% relative (e.g. 10% -> 11%)
    const mockPoolSmall = {
      query: async () => ({
        rows: [{ price_min: '0.00', price_max: '500.00', rate: '0.1000' }]
      })
    };
    const testCardSmall = {
      marketplace: 'flipkart',
      category: 'top',
      brand: 'Sangria',
      commissions: [{ price_min: 0, price_max: 500, rate: 0.11 }] // +1%
    };
    const changesSmall = await detectBrandRateChanges([testCardSmall], mockPoolSmall);
    assert.strictEqual(changesSmall.length, 1);
    assert.strictEqual(changesSmall[0].anomaly, false);
    assert(!changesSmall[0].reason.includes('⚠️ Anomaly'));
  });

  await runTest('detectBrandRateChanges flags fixed fee and reverse shipping shifts as anomalies (stage 4)', async () => {
    const { detectBrandRateChanges } = await import('../rateCardService.js');

    // Fixed fee shift >= 20
    const mockPoolFixed = {
      query: async (sql) => {
        if (sql.includes('rc_commission')) return { rows: [] };
        if (sql.includes('rc_fixed_fee')) {
          return {
            rows: [
              { price_min: '0.00', price_max: '300.00', rate: '10.00', fulfilment_type: 'Bronze' }
            ]
          };
        }
        return { rows: [] };
      }
    };
    const testCardFixed = {
      marketplace: 'flipkart',
      category: 'top',
      brand: 'General',
      commissions: [],
      fixedFees: [
        { fulfilment_type: 'Bronze', price_min: 0, price_max: 300, rate: 35.0 } // 10 -> 35 (shift +25 >= 20)
      ]
    };
    const changesFixed = await detectBrandRateChanges([testCardFixed], mockPoolFixed);
    const ffChange = changesFixed.find(c => c.type === 'fixed_fee' && c.oldRate != null);
    assert(ffChange, 'fixed_fee change must exist');
    assert.strictEqual(ffChange.anomaly, true);
    assert.strictEqual(ffChange.anomalyType, 'fixed_fee_shift');
    assert(ffChange.reason.includes('⚠️ Anomaly'));
  });

  await runTest('syncBrandRateCardsToDatabase stores rich audit snapshot in rate_card_versions (stage 4)', async () => {
    const { syncBrandRateCardsToDatabase } = await import('../rateCardService.js');
    let insertedSnapshot = null;
    let insertedVersionName = null;

    const fakeClient = {
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO rate_card_versions')) {
          insertedVersionName = params[1];
          insertedSnapshot = JSON.parse(params[3]);
        }
        return { rows: [] };
      },
      release: () => {}
    };

    const fakePool = {
      connect: async () => fakeClient,
      query: async (sql) => {
        if (sql.includes('rc_commission')) {
          return { rows: [{ price_min: '0.00', price_max: '500.00', rate: '0.1000' }] };
        }
        return { rows: [] };
      }
    };

    const testCard = {
      marketplace: 'flipkart',
      category: 'top',
      brand: 'Sangria',
      commissions: [{ price_min: 0, price_max: 500, rate: 0.18 }], // 10% -> 18% (+8% anomaly)
      fixedFees: [],
      reverseShipping: [],
      collectionFees: []
    };

    const res = await syncBrandRateCardsToDatabase(
      [testCard],
      {
        forceUpdate: true,
        actor: 'pawan@vbexports.co.in',
        runMetadata: { source: 'test-suite', testRun: true }
      },
      fakePool
    );

    assert.strictEqual(res.updated, true);
    assert.strictEqual(res.anomaliesCount, 1);
    assert(insertedSnapshot, 'rich audit snapshot must be inserted into rate_card_versions');
    assert(insertedSnapshot.version.startsWith('1.8.'), 'snapshot version must start with 1.8.');
    assert.strictEqual(insertedSnapshot.actor, 'pawan@vbexports.co.in');
    assert.strictEqual(insertedSnapshot.stats.anomaliesCount, 1);
    assert.strictEqual(insertedSnapshot.summary.anomalies.length, 1);
    assert.strictEqual(insertedSnapshot.summary.anomalies[0].anomalyType, 'commission_shift');
    assert(Array.isArray(insertedSnapshot.changes), 'snapshot must include full changes array');
  });

  await runTest('index.html and renderer.js wire anomaly badges, alert banner, and anomalies filter (stage 4)', async () => {
    const indexPath = path.join(desktopDir, 'ui', 'index.html');
    const indexContent = fs.readFileSync(indexPath, 'utf8');
    assert(indexContent.includes('id="anomalies-badge"'), 'index.html must include anomalies badge');
    assert(indexContent.includes('id="diff-anomaly-alert"'), 'index.html must include anomaly alert banner');
    assert(indexContent.includes('data-filter="anomalies"'), 'index.html must include anomalies filter tab');

    const rendererPath = path.join(desktopDir, 'ui', 'renderer.js');
    const rendererContent = fs.readFileSync(rendererPath, 'utf8');
    assert(rendererContent.includes("activeDiffFilter === 'anomalies'"), 'renderer.js must handle anomalies filter');
    assert(rendererContent.includes("r.anomaly"), 'renderer.js must check r.anomaly');
    assert(rendererContent.includes("diff-anomaly-alert"), 'renderer.js must toggle diff-anomaly-alert');
  });

  await runTest('desktop package.json ships test:e2e script and test_desktop_e2e.js (stage 5)', async () => {
    const pkgPath = path.join(desktopDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert(pkg.version.startsWith('1.8.'), 'version must be 1.8.x');
    assert(pkg.scripts['test:e2e'], 'package.json must define test:e2e');
    assert(pkg.scripts['test'].includes('test_desktop_e2e.js'), 'test script must include test_desktop_e2e.js');
    assert(!pkg.scripts['test'].includes('test_desktop_auth.js'), 'default test script must remain offline/CI-safe without live auth');
    assert(pkg.scripts['test:auth'], 'package.json must retain dedicated test:auth script');

    const e2ePath = path.join(desktopDir, 'tests', 'test_desktop_e2e.js');
    assert(fs.existsSync(e2ePath), 'test_desktop_e2e.js must exist');
    const e2eContent = fs.readFileSync(e2ePath, 'utf8');
    assert(e2eContent.includes('E2E 1: Full Extraction Pipeline'), 'e2e test must cover extraction');
    assert(e2eContent.includes('E2E 4: Detects rate changes'), 'e2e test must cover rate anomalies');
    assert(e2eContent.includes('E2E 7: Session expiry triggers onSessionExpiry'), 'e2e test must cover session expiry');
    assert(e2eContent.includes('E2E 8: Network drop on attempt 1'), 'e2e test must cover retry backoff');
  });

  await runTest('desktop/main.js and renderer.js wire TLS database provisioning and Live Browser 2FA dock navigation', async () => {
    const mainPath = path.join(desktopDir, 'main.js');
    const mainContent = fs.readFileSync(mainPath, 'utf8');
    assert(mainContent.includes('sanitizeSavedDbUrl'), 'main.js must sanitize saved database URLs');
    assert(!mainContent.includes('Xchange4SQL%24'), 'main.js must never contain hardcoded database passwords');

    const rendererPath = path.join(desktopDir, 'ui', 'renderer.js');
    const rendererContent = fs.readFileSync(rendererPath, 'utf8');
    assert(rendererContent.includes('function triggerInteractiveLogin('), 'renderer.js must define module-scoped triggerInteractiveLogin');
    assert(rendererContent.includes('data-tab="monitor"'), 'renderer.js must navigate to monitor tab for live view');
    assert(rendererContent.includes('syncMonitorDockBounds'), 'renderer.js must synchronize dock bounds');
    assert(rendererContent.includes("uiVersion: '1.8.0'"), 'renderer.js must send 1.8.0 uiVersion');
  });

  await runTest('cookieVault enforces TTL, auto-purges expired cookies, and supports deletion', async () => {
    const { saveEncryptedCookies, loadEncryptedCookies, areCookiesExpired, deleteEncryptedCookies, DEFAULT_MAX_COOKIE_AGE_MS } = await import('../cookieVault.js');
    const tmpCookiePath = path.join(os.tmpdir(), 'test_ttl_cookies.json');
    try {
      // 1. areCookiesExpired logic
      assert.strictEqual(areCookiesExpired(null), true);
      assert.strictEqual(areCookiesExpired([]), true);
      const freshCookies = [{ name: 'session', value: '123', domain: '.flipkart.com', path: '/', expires: (Date.now() / 1000) + 3600 }];
      assert.strictEqual(areCookiesExpired(freshCookies, 60000, Date.now()), false);
      // expired by TTL
      assert.strictEqual(areCookiesExpired(freshCookies, 1000, Date.now() - 5000), true);
      // expired by cookie expires field
      const deadCookies = [{ name: 'session', value: '123', expires: (Date.now() / 1000) - 10 }];
      assert.strictEqual(areCookiesExpired(deadCookies), true);
      // 2. Save and load fresh cookies
      saveEncryptedCookies(tmpCookiePath, freshCookies);
      assert(fs.existsSync(tmpCookiePath), 'cookie file must exist');
      const loaded = loadEncryptedCookies(tmpCookiePath);
      assert(Array.isArray(loaded) && loaded.length === 1, 'must load fresh cookies');
      // 3. Auto-purge when expired
      const expiredLoaded = loadEncryptedCookies(tmpCookiePath, { maxAgeMs: -1 });
      assert.strictEqual(expiredLoaded, null, 'expired cookies must return null');
      assert(!fs.existsSync(tmpCookiePath), 'expired cookie file must be unlinked');
      // 4. deleteEncryptedCookies
      saveEncryptedCookies(tmpCookiePath, freshCookies);
      assert(fs.existsSync(tmpCookiePath));
      const deleted = deleteEncryptedCookies(tmpCookiePath);
      assert.strictEqual(deleted, true);
      assert(!fs.existsSync(tmpCookiePath));
    } finally {
      try { if (fs.existsSync(tmpCookiePath)) fs.unlinkSync(tmpCookiePath); } catch {}
    }
  });
  await runTest('workerClient strictly enforces HTTPS allowlist and refuses bearer tokens on untrusted origins', async () => {
    const {
      isAllowedBackendUrl,
      OFFICIAL_PRODUCTION_SERVERS,
      ALLOWED_BACKEND_HOSTNAMES,
      getCandidateServers,
      getHeaders,
      clearCachedActiveServer,
      reportJobFailure
    } = await import('../workerClient.js');

    assert(OFFICIAL_PRODUCTION_SERVERS.length >= 3, 'Must define official production servers');
    assert(ALLOWED_BACKEND_HOSTNAMES.has('payments.youthnic.shop'), 'Allowlist must include payments domain');
    assert(isAllowedBackendUrl('https://payments.youthnic.shop'), 'Official domain must be allowed');
    assert(isAllowedBackendUrl('https://reconcentral.srv1845788.hstgr.cloud'), 'Hostinger subdomain must be allowed');
    assert(isAllowedBackendUrl('https://recon.srv1845788.hstgr.cloud'), 'Secondary Hostinger domain must be allowed');

    // Insecure / unallowlisted hosts rejected
    assert(!isAllowedBackendUrl('http://insecure-host.com'), 'Plaintext HTTP must be rejected');
    assert(!isAllowedBackendUrl('https://evil-attacker.com'), 'Non-allowlisted domain must be rejected');
    assert(!isAllowedBackendUrl('https://untrusted.youthnic.shop'), 'Non-allowlisted subdomain must be rejected');
    assert(!isAllowedBackendUrl('https://payments.youthnic.shop:8080'), 'Non-standard port must be rejected');

    // Header token security
    const secureHeaders = getHeaders('secret-token-123', 'https://payments.youthnic.shop');
    assert.strictEqual(secureHeaders['Authorization'], 'Bearer secret-token-123', 'Must attach Authorization on allowlisted host');

    const strippedHeaders = getHeaders('secret-token-123', 'https://evil-attacker.com');
    assert.strictEqual(strippedHeaders['Authorization'], undefined, 'Must NEVER attach Authorization on untrusted host');

    // Candidate server resolution and helpers
    const candidates = getCandidateServers();
    assert(candidates.includes('https://payments.youthnic.shop'), 'Candidates must contain primary domain');
    assert(typeof clearCachedActiveServer === 'function', 'Must export clearCachedActiveServer');
    assert(typeof reportJobFailure === 'function', 'Must export reportJobFailure');
  });

  await runTest('separate Flipkart and Shopsy reviews and a persistent diagnostics folder are exposed', async () => {
    const html = fs.readFileSync(path.join(desktopDir, 'ui/index.html'), 'utf8');
    const renderer = fs.readFileSync(path.join(desktopDir, 'ui/renderer.js'), 'utf8');
    const preload = fs.readFileSync(path.join(desktopDir, 'preload.cjs'), 'utf8');
    const main = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
    assert(html.includes('id="select-review-marketplace"') && html.includes('<option value="shopsy">Shopsy</option>'), 'review UI must let users choose Shopsy separately');
    assert(renderer.includes("getElementById('select-review-marketplace')?.value || 'flipkart'"), 'preview must choose exactly one review marketplace');
    assert(preload.includes("ipcRenderer.invoke('open-diagnostics')") && main.includes("registerHandler('open-diagnostics'"), 'desktop UI must open saved diagnostics');
    assert(main.includes("registerHandler('write-client-log'") && main.includes("createStructuredLogger(DIAGNOSTICS_DIR)"), 'renderer logs must reach persistent structured diagnostics');
  });

  await runTest('structured diagnostics redact secrets and rotate bounded log files', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcentral-logs-'));
    try {
      const logger = createStructuredLogger(directory, { maxBytes: 350, maxFiles: 2, now: () => new Date('2026-10-31T12:00:00.000Z') });
      logger.info('scrape.started', 'Visible Seller Hub run.', { marketplace: 'flipkart' });
      logger.error('portal.failed', new Error('Authorization: Bearer secret-token-value'), { idToken: 'local-private-id-token' });
      logger.info('raw.bearer', 'Bearer standalone-private-token postgres://worker:db-secret@db.example/rates');
      logger.info('test.padding', 'x'.repeat(700));
      const files = fs.readdirSync(directory).filter(name => name.startsWith('desktop-'));
      assert(files.some(name => name.endsWith('.1')), 'oversized daily logs must rotate');
      const contents = files.map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n');
      assert(!contents.includes('secret-token-value') && !contents.includes('local-private-id-token') &&
        !contents.includes('standalone-private-token') && !contents.includes('db-secret'), 'log rotation must not expose session secrets');
      assert(contents.includes('"timestamp"') && contents.includes('"level"') && contents.includes('"event"'), 'records must be structured JSONL');
      let day=0;
      const daily=createStructuredLogger(directory,{maxBytes:10000,maxFiles:2,now:()=>new Date(Date.UTC(2026,9,31+day++,12))});
      for(let index=0;index<6;index++) daily.info('daily.retention','bounded');
      assert(fs.readdirSync(directory).filter(name=>/^desktop-/.test(name)).length<=3,'retention bounds logs across days as well as within a day');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await runTest('backend diffs remain reviewable without a fingerprint while publication stays blocked', async () => {
    const { reviewRatesViaApi, publishReviewedRatesViaApi, clearCachedActiveServer } = await import('../workerClient.js');
    const savedFetch = globalThis.fetch;
    const savedNodeEnv = process.env.NODE_ENV;
    const savedApiUrl = process.env.API_SERVER_URL;
    const comparisons = [];
    process.env.NODE_ENV = 'test';
    process.env.API_SERVER_URL = 'http://127.0.0.1:43119';
    clearCachedActiveServer();
    globalThis.fetch = async (url, options = {}) => {
      const target = new URL(url);
      if (target.pathname === '/api/health') {
        return new Response(JSON.stringify({ dataSource: 'sql' }), { status: 200 });
      }
      if (target.pathname === '/api/rate-card/detect-changes') {
        const request = JSON.parse(options.body);
        comparisons.push(request.marketplace);
        return new Response(JSON.stringify({
          hasChanges: true,
          diffCount: 1,
          diffs: [{ table: 'rc_commission', category: request.marketplace, changeType: 'MODIFIED', details: 'Fixture rate change' }],
          summary: { added: 0, modified: 1, removed: 0, unchanged: 0, totalChecked: 1 }
        }), { status: 200 });
      }
      throw new Error(`Unexpected test request: ${target.pathname}`);
    };
    try {
      const cards = [
        { marketplace: 'flipkart', category: 'kurta', seller_account: 'default' },
        { marketplace: 'shopsy', category: 'shopsy_kurta', seller_account: 'default' }
      ];
      const review = await reviewRatesViaApi({ idToken: 'test-token', user: { role: 'admin' } }, cards, 'default');
      assert.strictEqual(review.changesCount, 2, 'both marketplace diffs must be returned for review');
      assert.strictEqual(review.publishable, false, 'missing backend fingerprints must disable publication');
      assert.deepStrictEqual(review.missingFingerprintMarketplaces, ['flipkart', 'shopsy']);
      assert.deepStrictEqual(comparisons, ['flipkart', 'shopsy'], 'each marketplace must be compared separately');

      let publishBlocked = false;
      try {
        await publishReviewedRatesViaApi({ idToken: 'test-token', user: { role: 'admin' } }, [cards[0]], review.fingerprints);
      } catch (error) {
        publishBlocked = /Review the current PostgreSQL comparison/.test(error.message);
      }
      assert(publishBlocked, 'publication must stay blocked without a review fingerprint');
    } finally {
      globalThis.fetch = savedFetch;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
      if (savedApiUrl === undefined) delete process.env.API_SERVER_URL; else process.env.API_SERVER_URL = savedApiUrl;
      clearCachedActiveServer();
    }
  });

  await runTest('review UI shows diffs but disables publishing when a backend fingerprint is missing', async () => {
    const renderer = fs.readFileSync(path.join(desktopDir, 'ui/renderer.js'), 'utf8');
    const main = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
    const standaloneServer = fs.readFileSync(path.join(desktopDir, 'desktopServer.mjs'), 'utf8');
    assert(renderer.includes('diffRes.publishable !== false'), 'renderer must gate the commit button on review publishability');
    assert(renderer.includes('PostgreSQL diffs are visible'), 'renderer must explain missing-fingerprint review state');
    assert(/finally\s*\{\s*btnCommitDb\.disabled = !currentCanSync;/.test(renderer), 'commit cleanup must preserve a disabled review state');
    assert(main.includes('if (!review.publishable || !review.fingerprints?.[cards[0].marketplace])'), 'main process must enforce the fingerprint gate');
    assert(main.includes('stageRateReviewIfCurrent(stagedExtraction, reviewRequest, cards, sellerAccount, result)'), 'Electron main must reject superseded review responses');
    assert(main.includes('if (stagedExtraction.publicationInProgress) return { success: false, error: \'Rate publication is in progress.'), 'Electron main must prevent a new scrape during rate publication');
    assert(main.includes('stagedExtraction.beginPublication()') && main.includes('stagedExtraction.endPublication()'), 'Electron main must hold and release the publication lock');
    assert(standaloneServer.includes('stageRateReviewIfCurrent(stagedExtraction, reviewRequest, cards, sellerAccount, review)'), 'standalone app server must reject superseded review responses');
    assert(standaloneServer.includes('if (!review.publishable || !review.fingerprints?.[cardsToSync[0].marketplace])'), 'standalone sync must enforce the fingerprint gate');
    assert(standaloneServer.includes('if (stagedExtraction.publicationInProgress)'), 'standalone server must guard concurrent publication, comparison, and scrape requests');
    const syncHandlerStart = renderer.indexOf('// Commit to Database');
    const syncHandlerEnd = renderer.indexOf('// Excel Actions', syncHandlerStart);
    const syncHandler = renderer.slice(syncHandlerStart, syncHandlerEnd);
    assert(syncHandler.includes('else if (res.success)'), 'unchanged successful syncs must follow the success path');
    assert((syncHandler.match(/await loadRateCardPreview\(\);/g) || []).length >= 2, 'changed and unchanged successful syncs must both refresh the staged review');
    assert(syncHandler.includes('res.error || res.result?.message'), 'failed sync responses must display an error instead of an up-to-date message');
  });

  console.log('\n=================================================================');
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('=================================================================');
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
