/**
 * Regression tests for the desktop worker runtime modules:
 *   - browserRuntime.js  (explicit puppeteer-core binding, busy lock, Chrome resolution)
 *   - sessionAccess.js   (verified session gate: refresh, role/uid match, logout race)
 *   - scrapeResults.js   (staged extraction normalization and validation)
 *   - dbUrlGuard.js      (server-provisioned DB URL adoption + saved config sanitization)
 * Plus packaging invariants: preload.cjs must exist, stale preload.js must not.
 *
 * This suite is fully offline (no Firebase, no PostgreSQL) so it can run in CI.
 */
import path from 'path';
import fs from 'fs';
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
const { normalizeScrapedCards } = await import('../scrapeResults.js');
const { isDesktopReachableDbUrl, sanitizeSavedDbUrl, dbHostFromUrl } = await import('../dbUrlGuard.js');

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

  // ── dbUrlGuard ─────────────────────────────────────────────────────────────
  await runTest('isDesktopReachableDbUrl refuses container-internal and private provisioned URLs', async () => {
    assert(isDesktopReachableDbUrl('postgresql://app:pass@postgres:5432/paymentapp') === false, 'container-internal postgres host must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@db:5432/paymentapp') === false, 'single-label service name must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@localhost:5432/paymentapp') === false, 'loopback provisioned by a remote server must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@10.0.0.5:5432/paymentapp') === false, 'private IPv4 must be refused');
    assert(isDesktopReachableDbUrl('postgresql://app:pass@database.internal:5432/paymentapp') === false, '.internal host must be refused');
    assert(isDesktopReachableDbUrl('') === false, 'empty URL must be refused');
    assert(isDesktopReachableDbUrl('not a url') === false, 'malformed URL must be refused');
  });

  await runTest('isDesktopReachableDbUrl accepts publicly routable provisioned URLs', async () => {
    assert(isDesktopReachableDbUrl('postgresql://worker:pass@db.example.com:5432/paymentapp?sslmode=require') === true, 'public DNS host must be accepted');
    assert(isDesktopReachableDbUrl('postgresql://worker:pass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres') === true, 'public pooler host must be accepted');
    assert(isDesktopReachableDbUrl('postgresql://worker:pass@8.8.8.8:5432/paymentapp') === true, 'public IPv4 must be accepted');
  });

  await runTest('sanitizeSavedDbUrl drops container-internal saved URLs but keeps deliberate local ones', async () => {
    assert(sanitizeSavedDbUrl('postgresql://app:pass@postgres:5432/paymentapp') === '', 'stale container-internal saved URL must be discarded');
    assert(sanitizeSavedDbUrl('postgresql://app:pass@registry.local:5432/paymentapp') === '', '.local saved URL must be discarded');
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

  // ── Packaging invariants ───────────────────────────────────────────────────
  await runTest('preload bridge is packaged as preload.cjs (not preload.js)', async () => {
    assert(fs.existsSync(path.join(desktopDir, 'preload.cjs')), 'desktop/preload.cjs is missing');
    assert(!fs.existsSync(path.join(desktopDir, 'preload.js')), 'stale desktop/preload.js still present');
    const mainSource = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
    assert(/preload\.cjs/.test(mainSource), 'main.js does not reference preload.cjs');
    assert(!/preload\.js/.test(mainSource), 'main.js still references preload.js');
  });

  await runTest('new runtime modules are present next to main.js', async () => {
    for (const file of ['browserRuntime.js', 'sessionAccess.js', 'scrapeResults.js', 'dbUrlGuard.js']) {
      assert(fs.existsSync(path.join(desktopDir, file)), `${file} is missing`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
    assert(pkg.dependencies?.['puppeteer-core'], 'puppeteer-core is not a declared dependency');
    const filePatterns = pkg.build?.files || pkg.files || [];
    assert(filePatterns.includes('!.env') && filePatterns.includes('!.env.*'), 'package build files must exclude .env');
    assert(filePatterns.includes('!tests/**'), 'package build files must exclude tests/');
    assert(filePatterns.includes('!.runtime/**'), 'package build files must exclude .runtime/');
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
