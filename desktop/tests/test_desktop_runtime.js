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

// ── Module loading ────────────────────────────────────────────────────────────
const { getBrowserRuntime, requireChromeExecutable, withBrowserTask } = await import('../browserRuntime.js');
const { publicSession, createSessionAccess } = await import('../sessionAccess.js');
const { createStagedExtractionState, normalizeScrapedCards, selectStagedCards } = await import('../scrapeResults.js');
const {
  isDesktopReachableDbUrl,
  sanitizeSavedDbUrl,
  selectDesktopDatabaseUrlForSession,
  storedDatabaseUrlForRole,
  dbHostFromUrl
} = await import('../dbUrlGuard.js');
const { parseRateCardTables } = await import('../portalScraper.js');
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

    let error = null;
    try {
      normalizeScrapedCards([
        { marketplace: 'flipkart', vertical: 'Kurta', fulfilment_type: 'NON_FBF', commissions: [{ price_min: 0, price_max: 500, rate: 0.15 }] },
        { marketplace: 'flipkart', vertical: 'Kurta', fulfilment_type: 'FBF', commissions: [{ price_min: 0, price_max: 500, rate: 0.1 }] }
      ]);
    } catch (err) { error = err; }
    assert(error && /different commissions for NON_FBF and FBF/.test(error.message), `conflicting modes must be refused (${error?.message})`);
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
        reverseShipping: [{ weight_slab: '0-0.5kg', price_min: 0, price_max: 500, local_fee: 30 }]
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
    assert(sh.source === 'shopsy_policy', 'shopsy source wrong');
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

  // ── portalScraper.parseRateCardTables ───────────────────────────────────────
  await runTest('parseRateCardTables classifies commission tables as percentage or fixed fee', async () => {
    const percentage = parseRateCardTables([
      [
        ['Order Item Value', 'Fee charged as % of Order item value'],
        ['₹0 - ₹500', '15%'],
        ['₹501 - ₹1000', '20.5%']
      ]
    ], 'kurta', '2026-10-28', 'flipkart');
    assert(percentage.commissions.length === 2, 'commission slabs were not parsed');
    assert(Math.abs(percentage.commissions[0].rate - 0.15) < 1e-12, '15% must be stored as 0.15');
    assert(Math.abs(percentage.commissions[1].rate - 0.205) < 1e-12, '20.5% must be stored as 0.205');
    assert(percentage.fixedFees.length === 0, 'a percentage table must not produce fixed fees');

    const fixed = parseRateCardTables([
      [
        ['Order Item Value', 'Fee charged'],
        ['₹0 - ₹500', '₹15'],
        ['₹501 - ₹1000', '₹25']
      ]
    ], 'kurta', '2026-10-28', 'flipkart');
    assert(fixed.commissions.length === 0, 'a flat-fee table must not produce commission slabs');
    assert(fixed.fixedFees.length === 8, `4 tiers x 2 slabs of fixed fees expected (got ${fixed.fixedFees.length})`);
    assert(fixed.fixedFees.every(f => ['Bronze', 'Silver', 'Gold', 'Diamond'].includes(f.fulfilment_type)), 'fixed fee tier labels wrong');
    assert(fixed.fixedFees[0].rate === 15, 'flat fee amount wrong');
  });

  await runTest('parseRateCardTables classifies prepaid and postpaid collection fees independently', async () => {
    // Regression: a flat ₹15 prepaid fee combined with a 0.3% postpaid fee used to
    // be mis-typed as percentages for BOTH columns.
    const parsed = parseRateCardTables([
      [
        ['Order Item Value', 'Prepaid', 'Postpaid'],
        ['₹0 - ₹750', '₹15', '0.3%']
      ]
    ], 'kurta', '2026-10-28', 'flipkart');
    assert(parsed.collectionFees.length === 1, 'collection fee row not parsed');
    const fee = parsed.collectionFees[0];
    assert(fee.prepaid === 15 && fee.prepaid_type === 'flat', `flat prepaid must stay ₹15 flat (got ${fee.prepaid_type} ${fee.prepaid})`);
    assert(Math.abs(fee.postpaid - 0.3) < 1e-12 && fee.postpaid_type === 'percentage', `percent postpaid must stay 0.3 percentage (got ${fee.postpaid_type} ${fee.postpaid})`);
    assert(fee.price_min === 0 && fee.price_max === 750, 'collection price range wrong');
  });

  await runTest('parseRateCardTables encodes the fixed Shopsy policy (0% commission)', async () => {
    const parsed = parseRateCardTables([], 'shopsy_kurta', '2026-10-28', 'shopsy');
    assert(parsed.marketplace === 'shopsy', 'marketplace wrong');
    assert(parsed.commissions.length === 1 && parsed.commissions[0].rate === 0, 'Shopsy commission must be exactly one 0% slab');
    assert(parsed.fixedFees.length === 8, `4 tiers x 2 slabs expected (got ${parsed.fixedFees.length})`);
    const zeroFee = parsed.fixedFees.filter(f => f.price_max === 1500);
    const tenFee = parsed.fixedFees.filter(f => f.price_min === 1501);
    assert(zeroFee.length === 4 && zeroFee.every(f => f.rate === 0), '₹0-1500 slab must be free');
    assert(tenFee.length === 4 && tenFee.every(f => f.rate === 10), '₹1501+ slab must be ₹10');
    assert(parsed.reverseShipping.length === 6, 'Shopsy reverse shipping must have 6 slabs');
    const first = parsed.reverseShipping[0];
    assert(
      first.weight_slab === '0kg-0.5kg' && first.price_min === 0 && first.price_max === 500 &&
      first.local_fee === 122 && first.zonal_fee === 142 && first.national_fee === 182,
      '0kg-0.5kg / ₹0-500 reverse shipping slab wrong'
    );
  });

  await runTest('parseRateCardTables parses reverse shipping weight slabs', async () => {
    const parsed = parseRateCardTables([
      [
        ['Weight slab 0kg - 0.5kg', 'Local', 'Zonal', 'National'],
        ['₹0 - ₹500', '₹30', '₹45', '₹60'],
        ['₹501 - ₹1000', '₹35', '₹50', '₹65']
      ]
    ], 'kurta', '2026-10-28', 'flipkart');
    assert(parsed.reverseShipping.length === 2, 'reverse shipping rows not parsed');
    assert(parsed.reverseShipping[0].weight_slab === '0kg-0.5kg', 'weight slab label wrong');
    assert(parsed.reverseShipping[0].price_min === 0 && parsed.reverseShipping[0].price_max === 500, 'price range wrong');
    assert(
      parsed.reverseShipping[0].local_fee === 30 && parsed.reverseShipping[0].zonal_fee === 45 && parsed.reverseShipping[0].national_fee === 60,
      'local/zonal/national fees wrong'
    );
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
    const fnWindow = rendererSource.slice(fnIdx, fnIdx + 3400);
    assert(fnWindow.includes('requestId = ++previewRequestSeq'), 'each preview must claim a generation');
    const guardCount = (fnWindow.match(/requestId !== previewRequestSeq/g) || []).length;
    assert(guardCount >= 3, `stale responses must be dropped after each await, including the catch path (found ${guardCount} guards)`);
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
    for (const file of ['browserRuntime.js', 'sessionAccess.js', 'scrapeResults.js', 'dbUrlGuard.js', 'httpAccess.js', 'portalScraper.js']) {
      assert(fs.existsSync(path.join(desktopDir, file)), `${file} is missing`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
    assert(pkg.dependencies?.['puppeteer-core'], 'puppeteer-core is not a declared dependency');
    const filePatterns = pkg.build?.files || pkg.files || [];
    assert(filePatterns.includes('!.env') && filePatterns.includes('!.env.*'), 'package build files must exclude .env');
    assert(filePatterns.includes('!tests/**'), 'package build files must exclude tests/');
    assert(filePatterns.includes('!.runtime/**'), 'package build files must exclude .runtime/');
  });

  await runTest('Linux release payload ships every local module the entry points import', async () => {
    const releaseScript = fs.readFileSync(path.resolve(desktopDir, '../scripts/prepare-release.js'), 'utf8');
    const shipped = new Set([...releaseScript.matchAll(/'([\w.-]+\.(?:m?js|cjs))'/g)].map((m) => m[1]));
    const visited = new Set();
    const queue = ['desktopServer.mjs', 'worker.js', 'main.js'];
    while (queue.length) {
      const file = queue.shift();
      if (visited.has(file)) continue;
      visited.add(file);
      const source = fs.readFileSync(path.join(desktopDir, file), 'utf8');
      for (const [, dep] of source.matchAll(/(?:from\s+|import\(\s*)'\.\/([\w.-]+\.m?js)'/g)) queue.push(dep);
    }
    const missing = [...visited].filter((file) => !shipped.has(file));
    assert(missing.length === 0, `prepare-release.js omits: ${missing.join(', ')}`);
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
    assert(winTargets.includes('nsis'), 'NSIS installer target is required (the only Windows target that auto-updates)');
    assert(winTargets.includes('portable'), 'portable Windows target is required');
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
    assert(applyWindow.includes('restartBtn.style.display'), 'the restart button must be hidden unless an update is ready');
    const clickIdx = rendererSource.indexOf("restartBtn?.addEventListener('click'");
    assert(clickIdx !== -1, 'restart button click wiring not found');
    const clickWindow = rendererSource.slice(clickIdx, clickIdx + 900);
    assert(clickWindow.includes('installUpdate'), 'restart button must trigger installUpdate');
    assert(clickWindow.includes('res?.success'), 'restart button must check the install result before claiming success');
  });

  await runTest('release workflow publishes real releases on version tags (static invariant)', async () => {
    const workflowPath = path.join(path.resolve(desktopDir, '..'), '.github', 'workflows', 'ratecard-desktop-release.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    assert(workflow.includes("- 'v*.*.*'"), 'the workflow must trigger on version tags');
    assert(workflow.includes("startsWith(github.ref, 'refs/tags/') && 'always' || 'never'"), 'publishing must happen on tags only');
    assert(workflow.includes('--publish "$env:PUBLISH_MODE"'), 'Windows builds must let electron-builder publish (it uploads latest.yml, the update feed)');
    assert(workflow.includes('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), 'electron-builder needs GH_TOKEN to publish the release');
    assert(workflow.includes('latest.yml'), 'the Windows artifact set must include latest.yml');
    assert(workflow.includes('needs.build-windows.result == \'success\''), 'Linux assets must only attach after the release exists — attaching to a missing release would create an update feed with no installer');
    assert(workflow.includes('softprops/action-gh-release@v2'), 'Linux packages attach via softprops/action-gh-release');
    assert(workflow.includes('npm ci'), 'CI builds must be reproducible (npm ci against the lockfile)');
    assert(workflow.includes('${GITHUB_REF_NAME#v}'), 'tag builds must refuse a tag that does not match desktop/package.json\'s version');
    assert(/does not match desktop\/package\.json version/.test(workflow), 'the tag/version guard must fail the build with a clear error');
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
