import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManualLoginWindowManager, normalizeElectronSessionCookies } from '../manualLoginWindow.js';
import { FLIPKART_DASHBOARD_URL, FLIPKART_MANUAL_LOGIN_URL, inspectFlipkartLoginState } from '../portalSession.js';
import { waitForFlipkartAuthenticatedPage } from '../portalLoginWaiter.js';
import { scrapeFlipkartRateCards } from '../portalScraper.js';
import { readSellerHubProfileState, writeSellerHubProfileState } from '../portalProfileState.js';
import { invokeProgressSafely } from '../safeProgress.js';
import { clearEncryptedCookieSnapshot, saveEncryptedCookies } from '../cookieVault.js';
import { persistDesktopUserDataDirChoice, resolveDesktopUserDataDir, resolveFlipkartBrowserProfileDir } from '../userDataPaths.js';

test('desktop app and standalone login helper share one Windows Seller Hub profile', () => {
  const appData = path.join(os.tmpdir(), 'shared-seller-hub-roaming');
  const legacyProfile = path.join(appData, 'reconcentral-ratecard-worker', 'browser-profiles', 'flipkart_shopsy');
  const legacyCookieStore = path.join(legacyProfile, 'Default', 'Network', 'Cookies');
  const canonicalProfile = path.join(appData, 'ReconCentral RateCard Worker', 'browser-profiles', 'flipkart_shopsy');
  const existing = new Set([legacyCookieStore]);
  const env = { APPDATA: appData };
  const userDataDir = resolveDesktopUserDataDir({ env, platform: 'win32' });
  const desktopProfile = resolveFlipkartBrowserProfileDir({ userDataDir, env, platform: 'win32', allowLegacyProfile: true, existsSync: value => existing.has(value) });
  const helperProfile = resolveFlipkartBrowserProfileDir({ env, platform: 'win32', existsSync: value => existing.has(value) });

  assert.equal(userDataDir, path.join(appData, 'ReconCentral RateCard Worker'));
  assert.equal(desktopProfile, legacyProfile);
  assert.equal(helperProfile, desktopProfile);
  existing.add(path.join(canonicalProfile, 'Default', 'Cookies'));
  assert.equal(resolveFlipkartBrowserProfileDir({ userDataDir, env, platform: 'win32', allowLegacyProfile: true, existsSync: value => existing.has(value) }), canonicalProfile);
});

test('Windows upgrades keep the existing desktop auth, config, and review data root', () => {
  const appData = path.join(os.tmpdir(), 'rcw-windows-data-root-fixture');
  const legacy = path.join(appData, 'reconcentral-ratecard-worker');
  const canonical = path.join(appData, 'ReconCentral RateCard Worker');
  const existing = new Set([
    path.join(legacy, 'auth-session.json'),
    path.join(legacy, 'worker-config.json'),
    path.join(legacy, 'staging.db'),
    path.join(canonical, 'cookies.json'),
    path.join(legacy, 'browser-profiles', 'flipkart_shopsy', 'Default', 'Network', 'Cookies')
  ]);
  const userDataDir = resolveDesktopUserDataDir({
    env: { APPDATA: appData },
    platform: 'win32',
    existsSync: value => existing.has(value),
    readFileSync: () => ''
  });

  assert.equal(userDataDir, legacy, 'new cookie snapshots alone must not displace the established app state');
  assert.equal(resolveFlipkartBrowserProfileDir({
    userDataDir,
    env: { APPDATA: appData },
    platform: 'win32',
    allowLegacyProfile: true,
    existsSync: value => existing.has(value)
  }), path.join(legacy, 'browser-profiles', 'flipkart_shopsy'),
  'the migrated app data root must continue using the established Seller Hub profile');
});

test('the selected Windows data root remains stable after sign-out removes its auth session', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-windows-root-sticky-'));
  const legacy = path.join(appData, 'reconcentral-ratecard-worker');
  const canonical = path.join(appData, 'ReconCentral RateCard Worker');
  const marker = path.join(canonical, '.desktop-user-data-root');
  const env = { APPDATA: appData };

  try {
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'auth-session.json'), 'encrypted-fixture');
    fs.writeFileSync(path.join(legacy, 'worker-config.json'), '{}');

    assert.equal(persistDesktopUserDataDirChoice({ env, platform: 'win32' }), legacy);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'legacy');

    fs.unlinkSync(path.join(legacy, 'auth-session.json'));
    assert.equal(resolveDesktopUserDataDir({ env, platform: 'win32' }), legacy,
      'sign-out must keep the selected root even when it removes the auth session');
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(appData));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture cleanup must stay inside the OS temp directory');
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test('Windows data-root selection prefers current app state and user overrides stay isolated', () => {
  const appData = path.join(os.tmpdir(), 'rcw-windows-root-precedence');
  const legacy = path.join(appData, 'reconcentral-ratecard-worker');
  const canonical = path.join(appData, 'ReconCentral RateCard Worker');
  const existing = new Set([
    path.join(legacy, 'auth-session.json'),
    path.join(legacy, 'worker-config.json'),
    path.join(legacy, 'staging.db'),
    path.join(canonical, 'auth-session.json'),
    path.join(canonical, 'worker-config.json')
  ]);
  const existsSync = value => existing.has(value) || value === legacy || value === canonical;
  const readFileSync = () => '';
  const sessionTimes = new Map([
    [path.join(legacy, 'auth-session.json'), 10],
    [path.join(canonical, 'auth-session.json'), 20]
  ]);
  const statSync = value => {
    if (!sessionTimes.has(value)) throw Object.assign(new Error('missing fixture metadata'), { code: 'ENOENT' });
    return { mtimeMs: sessionTimes.get(value) };
  };

  assert.equal(resolveDesktopUserDataDir({ env: { APPDATA: appData }, platform: 'win32', existsSync, readFileSync, statSync }), canonical,
    'the newest canonical auth session must win even when legacy contains more app-state files');
  sessionTimes.set(path.join(legacy, 'auth-session.json'), 30);
  assert.equal(resolveDesktopUserDataDir({ env: { APPDATA: appData }, platform: 'win32', existsSync, readFileSync, statSync }), legacy,
    'the newest legacy auth session must win when it was the last one written');
  assert.equal(resolveDesktopUserDataDir({
    env: { APPDATA: appData, RECONCENTRAL_USER_DATA: path.join(appData, 'isolated') },
    platform: 'win32', existsSync, readFileSync
  }), path.join(appData, 'isolated'), 'explicit test/portable data overrides must bypass migration selection');
});

test('a stale Windows legacy-root marker is repaired before the app selects canonical state', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-windows-root-repair-'));
  const legacy = path.join(appData, 'reconcentral-ratecard-worker');
  const canonical = path.join(appData, 'ReconCentral RateCard Worker');
  const marker = path.join(canonical, '.desktop-user-data-root');
  const env = { APPDATA: appData };

  try {
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(marker, 'legacy\n');
    assert.equal(persistDesktopUserDataDirChoice({ env, platform: 'win32' }), canonical);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'canonical');

    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'auth-session.json'), 'old-session');
    assert.equal(resolveDesktopUserDataDir({ env, platform: 'win32' }), canonical,
      'a returning legacy directory must not switch roots after canonical state has been selected');
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(appData));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture cleanup must stay inside the OS temp directory');
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test('Windows marker write failures are reported without exposing data paths', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-windows-root-write-failure-'));
  const legacy = path.join(appData, 'reconcentral-ratecard-worker');
  const env = { APPDATA: appData };
  const warnings = [];

  try {
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'auth-session.json'), 'encrypted-fixture');
    const selected = persistDesktopUserDataDirChoice({
      env,
      platform: 'win32',
      writeFileSync: () => { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); },
      warn: message => warnings.push(JSON.parse(message))
    });

    assert.equal(selected, legacy);
    assert.deepEqual(warnings, [{
      level: 'warn',
      event: 'windows_desktop_user_data_marker_write_failed',
      code: 'EACCES'
    }]);
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(appData));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture cleanup must stay inside the OS temp directory');
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test('Linux keeps its existing XDG data root without writing a Windows marker', () => {
  const home = path.join(os.tmpdir(), 'rcw-linux-data-root-home');
  const expected = path.join(home, '.config', 'reconcentral-ratecard-worker');
  const env = { HOME: home };

  assert.equal(resolveDesktopUserDataDir({ env, platform: 'linux' }), expected);
  assert.equal(persistDesktopUserDataDirChoice({ env, platform: 'linux' }), expected);
});

test('external browser viewport only asks for sign-in when the portal state requires it', () => {
  const renderer = fs.readFileSync(new URL('../ui/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /const loginRequired = state\.status === 'login_prompt'/);
  assert.match(renderer, /const working = state\.status === 'extracting' \|\| state\.status === 'navigating'/);
});

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.url = '';
    this.listeners = new Map();
    this.webContents = {
      listeners: new Map(),
      on: (event, callback) => this.webContents.listeners.set(event, callback),
      getURL: () => this.url,
      getTitle: () => 'Fake Seller Hub',
      setWindowOpenHandler: callback => { this.popupHandler = callback; }
    };
  }
  on(event, callback) { this.listeners.set(event, callback); }
  loadURL(url) { this.url = url; this.loadedUrl = url; return Promise.resolve(); }
  isDestroyed() { return Boolean(this.destroyed); }
  show() {}
  focus() {}
  close() { this.destroyed = true; this.listeners.get('closed')?.(); }
}

function manualLoginHarness({ authenticated = false } = {}) {
  const windows = [];
  const saved = [];
  let poll;
  let timeout;
  class BrowserWindow extends FakeWindow {
    constructor(options) { super(options); windows.push(this); }
  }
  const portalSession = { id: 'persist:marketplace-flipkart_shopsy' };
  const manager = createManualLoginWindowManager({
    BrowserWindow,
    portalSession,
    isAuthenticated: async () => authenticated,
    readCookies: async () => [{ name: 'seller_session', value: 'redacted-test-value', domain: '.flipkart.com', session: true }],
    saveCookies: async cookies => saved.push(cookies),
    setIntervalFn: callback => { poll = callback; return 1; },
    clearIntervalFn: () => {},
    setTimeoutFn: callback => { timeout = callback; return 2; },
    clearTimeoutFn: () => {}
  });
  return {
    manager, windows, saved, portalSession,
    setAuthenticated(value) { authenticated = value; },
    poll: () => poll?.(),
    timeout: () => timeout?.()
  };
}

test('Seller Hub login watcher follows authentication into another tab in the same profile', async () => {
  let now = 0;
  let pageReads = 0;
  const observed = [];
  const publicPage = {
    isClosed: () => false,
    evaluate: async () => false,
    url: () => FLIPKART_MANUAL_LOGIN_URL
  };
  const authenticatedPage = {
    isClosed: () => false,
    evaluate: async () => true,
    url: () => FLIPKART_DASHBOARD_URL
  };
  const browser = {
    pages: async () => (++pageReads < 2 ? [publicPage] : [publicPage, authenticatedPage])
  };

  const result = await waitForFlipkartAuthenticatedPage(browser, {
    initialPage: publicPage,
    timeoutMs: 3000,
    pollMs: 1000,
    now: () => now,
    wait: async milliseconds => { now += milliseconds; },
    onPage: page => observed.push(page)
  });

  assert.equal(result, authenticatedPage, 'the authenticated Seller Hub tab must be returned');
  assert.deepEqual(observed, [authenticatedPage], 'new tabs in the persistent profile must be observed');
  assert.equal(pageReads, 2, 'all open Chrome pages must be polled after the one-second interval');
});

test('Seller Hub login watcher preserves caller-supplied authentication probes', async () => {
  let legacyChecks = 0;
  const page = {
    isClosed: () => false,
    evaluate: async fn => fn === inspectFlipkartLoginState
      ? { surface: 'flipkart', authenticated: false, loginFormVisible: false, challengeVisible: false, publicLanding: false }
      : (++legacyChecks, true)
  };
  const result = await waitForFlipkartAuthenticatedPage({ pages: async () => [page] }, {
    initialPage: page,
    timeoutMs: 1000,
    pollMs: 1000,
    isAuthenticated: () => true
  });

  assert.equal(result, page);
  assert.equal(legacyChecks, 1, 'custom probes remain a supported override after state inspection');
});

test('Seller Hub login watcher ignores unrelated non-landing tabs after login returns public', async () => {
  let now = 0;
  let loginReads = 0;
  const states = [
    { surface:'flipkart', stage:'username', authenticated:false, loginFormVisible:true, challengeVisible:false, publicLanding:false },
    { surface:'flipkart', stage:'public', authenticated:false, loginFormVisible:false, challengeVisible:false, publicLanding:true }
  ];
  const loginPage = {
    isClosed: () => false,
    evaluate: async fn => fn === inspectFlipkartLoginState
      ? states[Math.min(loginReads++, states.length - 1)]
      : false
  };
  const retainedDashboardTab = {
    isClosed: () => false,
    evaluate: async fn => fn === inspectFlipkartLoginState
      ? { surface:'flipkart', stage:'portal', authenticated:false, loginFormVisible:false, challengeVisible:false, publicLanding:false }
      : false
  };

  await assert.rejects(
    waitForFlipkartAuthenticatedPage({ pages: async () => [loginPage, retainedDashboardTab] }, {
      initialPage: loginPage,
      timeoutMs: 10000,
      pollMs: 1000,
      publicReturnGraceMs: 2000,
      now: () => now,
      wait: async milliseconds => { now += milliseconds; }
    }),
    /returned to its public landing page.*Nothing was staged/
  );
});

test('a retained public tab cannot fail a cross-tab sign-in that is still in progress', async () => {
  let now = 0;
  let loginReads = 0;
  const loginStates = [
    { surface:'flipkart', stage:'username', authenticated:false, loginFormVisible:true, challengeVisible:false, publicLanding:false },
    { surface:'flipkart', stage:'portal', authenticated:false, loginFormVisible:false, challengeVisible:false, publicLanding:false }
  ];
  const loginPage = {
    isClosed: () => false,
    evaluate: async fn => fn === inspectFlipkartLoginState
      ? loginStates[Math.min(loginReads++, loginStates.length - 1)]
      : false
  };
  const retainedPublicPage = {
    isClosed: () => false,
    evaluate: async fn => fn === inspectFlipkartLoginState
      ? { surface:'flipkart', stage:'public', authenticated:false, loginFormVisible:false, challengeVisible:false, publicLanding:true }
      : false
  };

  await assert.rejects(
    waitForFlipkartAuthenticatedPage({ pages: async () => [loginPage, retainedPublicPage] }, {
      initialPage: loginPage,
      timeoutMs: 3000,
      pollMs: 1000,
      publicReturnGraceMs: 1000,
      now: () => now,
      wait: async milliseconds => { now += milliseconds; }
    }),
    error => /timed out/.test(error.message) && !/returned to its public landing page/.test(error.message)
  );
});

test('progress reporting contains rejected callbacks without an unhandled rejection', async () => {
  const failures = [];
  const completed = await invokeProgressSafely(
    async () => { throw Object.assign(new Error('fixture rejection'), { name: 'FixtureError' }); },
    'checking login',
    error => failures.push(error.name)
  );

  assert.equal(completed, false);
  assert.deepEqual(failures, ['FixtureError']);
  assert.equal(await invokeProgressSafely(() => {}, 'sync progress'), true);
});

test('Seller Hub login watcher explains when no authenticated dashboard appears', async () => {
  let now = 0;
  const publicPage = { isClosed: () => false, evaluate: async () => false };
  await assert.rejects(
    waitForFlipkartAuthenticatedPage({ pages: async () => [publicPage] }, {
      initialPage: publicPage,
      timeoutMs: 1000,
      pollMs: 1000,
      now: () => now,
      wait: async milliseconds => { now += milliseconds; }
    }),
    /No authenticated dashboard was detected in any open Chrome tab/
  );
});

test('Seller Hub login watcher reports a stable return to the public page after the login form closes', async () => {
  let now = 0;
  let reads = 0;
  const states = [
    { surface:'flipkart', stage:'username', authenticated:false, loginFormVisible:true, challengeVisible:false, publicLanding:false },
    { surface:'flipkart', stage:'password', authenticated:false, loginFormVisible:true, challengeVisible:false, publicLanding:false },
    { surface:'flipkart', stage:'public', authenticated:false, loginFormVisible:false, challengeVisible:false, publicLanding:true },
    { surface:'flipkart', stage:'public', authenticated:false, loginFormVisible:false, challengeVisible:false, publicLanding:true },
    { surface:'flipkart', stage:'public', authenticated:false, loginFormVisible:false, challengeVisible:false, publicLanding:true },
    { surface:'flipkart', stage:'public', authenticated:false, loginFormVisible:false, challengeVisible:false, publicLanding:true }
  ];
  const publicPage = {
    isClosed: () => false,
    evaluate: async fn => fn === inspectFlipkartLoginState
      ? states[Math.min(reads++, states.length - 1)]
      : false
  };
  const intervals = [];
  const progress = [];

  await assert.rejects(
    waitForFlipkartAuthenticatedPage({ pages: async () => [publicPage] }, {
      initialPage: publicPage,
      timeoutMs: 10000,
      pollMs: 1000,
      publicReturnGraceMs: 2000,
      now: () => now,
      wait: async milliseconds => { intervals.push(milliseconds); now += milliseconds; },
      onState: (_page, state) => progress.push(state.stage)
    }),
    /returned to its public landing page.*Nothing was staged/
  );

  assert.ok(progress.includes('username'));
  assert.ok(progress.includes('password'));
  assert.ok(progress.includes('public_return'));
  assert.ok(intervals.length > 0 && intervals.every(milliseconds => milliseconds >= 1000),
    'login state checks must remain at least one second apart');
});

test('Seller Hub login watcher keeps waiting when a verification prompt is visible', async () => {
  let now = 0;
  let reads = 0;
  const states = [
    { surface:'flipkart', stage:'username', authenticated:false, loginFormVisible:true, challengeVisible:false, publicLanding:false },
    { surface:'flipkart', stage:'challenge', authenticated:false, loginFormVisible:false, challengeVisible:true, publicLanding:false }
  ];
  const publicPage = {
    isClosed: () => false,
    evaluate: async fn => fn === inspectFlipkartLoginState
      ? states[Math.min(reads++, states.length - 1)]
      : false
  };

  await assert.rejects(
    waitForFlipkartAuthenticatedPage({ pages: async () => [publicPage] }, {
      initialPage: publicPage,
      timeoutMs: 2000,
      pollMs: 1000,
      now: () => now,
      wait: async milliseconds => { now += milliseconds; }
    }),
    error => /No authenticated dashboard was detected/.test(error.message) && !/returned to its public landing page/.test(error.message)
  );
});

test('Seller Hub login watcher cancels its one-second readiness wait when Chrome closes', async () => {
  const controller = new AbortController();
  const publicPage = { isClosed: () => false, evaluate: async () => false };
  const monitoring = waitForFlipkartAuthenticatedPage({ pages: async () => [publicPage] }, {
    initialPage: publicPage,
    timeoutMs: 30 * 60 * 1000,
    pollMs: 1000,
    signal: controller.signal
  });

  controller.abort();
  await assert.rejects(monitoring, error => error.name === 'AbortError');
});

test('Seller Hub login watcher rejects promptly when its Chromium browser disconnects', async () => {
  const browser = new EventEmitter();
  const publicPage = { isClosed: () => false, evaluate: async () => false };
  browser.pages = async () => [publicPage];

  const monitoring = waitForFlipkartAuthenticatedPage(browser, {
    initialPage: publicPage,
    timeoutMs: 30 * 60 * 1000,
    pollMs: 1000
  });
  await new Promise(resolve => setImmediate(resolve));
  browser.emit('disconnected');

  await assert.rejects(monitoring, /Chrome was closed while waiting for Seller Hub sign-in/);
  assert.equal(browser.listenerCount('disconnected'), 0, 'disconnect listeners must be removed after cancellation');
});

test('manual Seller Hub window opens only at the root and saves cookies after manual authentication', async () => {
  const harness = manualLoginHarness();
  const completion = harness.manager.open({ waitMs: 5000 });
  await Promise.resolve();

  assert.equal(harness.windows.length, 1);
  assert.equal(harness.windows[0].loadedUrl, FLIPKART_MANUAL_LOGIN_URL);
  assert.equal(harness.windows[0].options.webPreferences.session, harness.portalSession);
  assert.equal(harness.manager.getWindow(), harness.windows[0]);
  assert.equal(harness.windows[0].popupHandler({ url: 'https://accounts.flipkart.com/login' }).action, 'allow');
  assert.equal(harness.windows[0].popupHandler({ url: 'https://example.org/login' }).action, 'deny');

  harness.setAuthenticated(true);
  await harness.poll();
  const result = await completion;
  assert.equal(result.success, true);
  assert.equal(result.persistentSession, true);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.windows[0].isDestroyed(), false, 'the manual session window remains open after verification');
});

test('desktop and standalone worker use the same persistent external Chrome profile for Seller Hub', () => {
  const mainSource = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const scraperSource = fs.readFileSync(new URL('../portalScraper.js', import.meta.url), 'utf8');
  const externalBrowserSource = fs.readFileSync(new URL('../externalBrowserSession.js', import.meta.url), 'utf8');
  const standaloneSource = fs.readFileSync(new URL('../desktopServer.mjs', import.meta.url), 'utf8');
  const browserRuntimeSource = fs.readFileSync(new URL('../browserRuntime.js', import.meta.url), 'utf8');
  const monitorHtml = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const rendererSource = fs.readFileSync(new URL('../ui/renderer.js', import.meta.url), 'utf8');
  const workerEntry = mainSource.slice(mainSource.indexOf('async function executeBackgroundWorkerJob'), mainSource.indexOf('// ── Daily Scheduler'));
  const standaloneWorker = standaloneSource.slice(standaloneSource.indexOf('const serverWorker = createWorkerEngine'), standaloneSource.indexOf('const sseClients = new Set()'));
  const monitorLoginStart = rendererSource.indexOf("const btnLogin = document.getElementById('btn-monitor-login')");
  const monitorLoginEnd = rendererSource.indexOf('const btnTestOpen', monitorLoginStart);
  const monitorLoginHandler = rendererSource.slice(monitorLoginStart, monitorLoginEnd);
  const sellerHubLoginStart = rendererSource.indexOf("btnInteractiveLogin?.addEventListener('click'");
  const sellerHubLoginEnd = rendererSource.indexOf('// Reset session cookies', sellerHubLoginStart);
  const sellerHubLoginHandler = rendererSource.slice(sellerHubLoginStart, sellerHubLoginEnd);
  const externalExpiryStart = mainSource.indexOf('const externalSessionExpiry = async (page,');
  const externalRuntimeStart = mainSource.indexOf('const baseExternalRuntime', externalExpiryStart);
  const externalExpiryHandler = mainSource.slice(externalExpiryStart, externalRuntimeStart);
  const clearSessionStart = standaloneSource.indexOf("if (pathname === '/api/clear-session'");
  const clearSessionEnd = standaloneSource.indexOf('// POST /api/open-excel', clearSessionStart);
  const clearSessionRoute = standaloneSource.slice(clearSessionStart, clearSessionEnd);
  const standaloneLoginStart = standaloneSource.indexOf("if (pathname === '/api/interactive-login'");
  const standaloneLoginEnd = standaloneSource.indexOf("if (pathname === '/api/clear-session'", standaloneLoginStart);
  const standaloneLoginRoute = standaloneSource.slice(standaloneLoginStart, standaloneLoginEnd);
  const desktopResetStart = mainSource.indexOf("registerHandler('clear-marketplace-session'");
  const desktopResetEnd = mainSource.indexOf("registerHandler('start-scrape'", desktopResetStart);
  const desktopResetHandler = mainSource.slice(desktopResetStart, desktopResetEnd);

  assert.match(mainSource, /let currentBrowserEngine = 'external'/);
  assert.match(mainSource, /externalBrowserSession\.acquire\(puppeteer,[\s\S]*?keepOpen: true/,
    'manual sign-in must retain the authenticated external Chrome process');
  assert.match(mainSource, /externalBrowserSession\.acquire\(target, options,[\s\S]*?keepOpen: options\.headless === false/,
    'scrapes must reuse a retained Seller Hub browser profile');
  assert.match(externalBrowserSource, /if \(keepOpen && retained === entry\) return/,
    'scrape cleanup must not close a retained login browser');
  assert.match(mainSource, /app\.on\('before-quit'[\s\S]*?externalBrowserSession\.close\(\{ reason: 'app-quit' \}\)/,
    'app shutdown must flush and close the retained browser cleanly');
  const shutdownHandler = mainSource.slice(mainSource.indexOf("app.on('before-quit'"), mainSource.indexOf('// ── Distributed Worker Engine'));
  assert.match(shutdownHandler, /externalBrowserSession\.close\(\{ reason: 'app-quit' \}\)\.then\([\s\S]*?\.catch\(err => \{[\s\S]*?externalBrowserShutdownPending = false/,
    'a failed browser close must keep the app open so the user can retry cleanup');
  assert(!shutdownHandler.includes('.finally('), 'shutdown must not quit after a rejected browser close');
  assert.match(scraperSource, /--restore-last-session/,
    'Chromium must restore the saved profile session after a clean app restart');
  assert.match(mainSource, /const profileSessionState = readSellerHubProfileState\(profileDir\);[\s\S]*?snapshot_available[\s\S]*?fs\.existsSync\(cookiesPath\)/,
    'desktop sign-in must restore encrypted cookies for an unknown profile even when Chromium initialized generic stores');
  assert.match(standaloneSource, /const profileSessionState = readSellerHubProfileState\(profileDir\);[\s\S]*?snapshot_available[\s\S]*?fs\.existsSync\(cookiesPath\)/,
    'standalone sign-in must use the same verified-session marker for cookie handoff');
  assert.match(scraperSource, /snapshot_available[\s\S]*?fs\.existsSync\(cookieFile\)/,
    'scrape startup must restore the cookie snapshot for legacy profiles without a verified state marker');
  assert.match(scraperSource, /Checking the saved Seller Hub session[\s\S]*?safeGoto\(FLIPKART_DASHBOARD_URL/,
    'the public landing page must be followed by a same-origin dashboard session check');
  assert.match(mainSource, /invokeProgressSafely\(onProgress, message/,
    'async progress callbacks must be observed without creating unhandled rejections');
  assert.match(mainSource, /userDataDir: profileDir/);
  assert.match(mainSource, /page\.goto\(manualLoginUrl, \{ waitUntil: 'domcontentloaded'/);
  const externalLoginStart = mainSource.indexOf('const browserLease = await externalBrowserSession.acquire');
  const externalLoginEnd = mainSource.indexOf("registerHandler('interactive-login'", externalLoginStart);
  const externalLoginFlow = mainSource.slice(externalLoginStart, externalLoginEnd);
  assert(externalLoginFlow.indexOf('await focusBrowserPage(page)') < externalLoginFlow.indexOf('await page.goto(manualLoginUrl'),
    'restored external Seller Hub tabs must be brought forward before manual login navigation');
  assert(standaloneLoginRoute.indexOf('await focusBrowserPage(page)') < standaloneLoginRoute.indexOf('await page.goto(portalUrl'),
    'standalone manual sign-in must foreground the selected restored tab before navigation');
  assert.match(browserRuntimeSource, /await delay\(1000\);\s*await page\.bringToFront\(\);[\s\S]*?await delay\(1000\)/,
    'foregrounding must keep one-second interaction gaps around the selected page activation');
  assert.match(mainSource, /timeoutMs: 30 \* 60 \* 1000/,
    'manual login and visible reauthentication must allow time for the operator to sign in');
  assert.match(mainSource, /async function openManualFlipkartLogin\(\{ onProgress = \(\) => \{\}, waitMs \} = \{\}\)/);
  assert.match(mainSource, /manager\.open\(\{ waitMs \}\)/);
  assert.match(mainSource, /captureScrapeFailure\(page, DIAGNOSTICS_DIR,[\s\S]*?operation: 'manual_login'/,
    'manual-login failures must use the redacted, bounded diagnostic screenshot path');
  assert.match(externalExpiryHandler, /async \(page, \{ visible = false \} = \{\}\) => \{\s*if \(!visible\) return false;/,
    'external reauthentication must only wait on a visible browser page');
  assert.match(externalExpiryHandler, /onState: \(_candidate, state\) => reportFlipkartLoginState\(state,[\s\S]*?operation: 'scrape_reauthentication'/,
    'scrape-time reauthentication must report the observed username, password, challenge, and public-return states');
  assert(!externalExpiryHandler.includes('openManualFlipkartLogin'), 'external Chrome reauthentication must not switch to a separate Electron storage partition');
  assert.match(externalExpiryHandler, /if \(cookies\.length\)[\s\S]*?deleteEncryptedCookies\(getMarketplaceCookiesPath\('flipkart_shopsy'\)\)/,
    'visible reauthentication must remove stale cookie snapshots when the authenticated browser has no cookies');
  assert.match(workerEntry, /visible: true/);
  assert.match(standaloneSource, /userDataDir: profileDir/);
  assert.match(standaloneSource, /mpConfig\.id === 'flipkart_shopsy'[\s\S]*?FLIPKART_MANUAL_LOGIN_URL/);
  assert.match(standaloneWorker, /visible: canOpenVisibleBrowser\(\)/);
  assert.match(standaloneWorker, /onSessionExpiry: async page/);
  assert.match(standaloneWorker, /waitForFlipkartAuthenticatedPage\(page\.browser\(\), \{[\s\S]*?pollMs: 1000/);
  assert.match(standaloneWorker, /if \(cookies\.length\)[\s\S]*?deleteEncryptedCookies\(getMarketplaceCookiesPath\('flipkart_shopsy'\)\)/,
    'standalone reauthentication must remove stale snapshots when the authenticated browser has no cookies');
  assert.match(standaloneSource, /version: DESKTOP_VERSION/);
  assert(!monitorHtml.includes('value="embedded"'), 'the monitor must not let users select a separate embedded session');
  assert(monitorLoginHandler.includes("triggerInteractiveLogin('flipkart_shopsy')"), 'the live-browser sign-in button must always open Flipkart Seller Hub');
  assert(sellerHubLoginHandler.includes("const selectedVal = selectEl?.value || 'flipkart_shopsy'"), 'the selected-portal sign-in action must retain its requested marketplace');
  assert(sellerHubLoginHandler.includes("getAttribute('data-portal')"), 'the selected-portal sign-in action must use the selected channel URL');
  assert(monitorHtml.includes('Open Selected Portal Sign-in') && monitorHtml.includes('selected marketplace portal'), 'the generic sign-in action must be labeled for all supported portal channels');
  assert(clearSessionRoute.indexOf('await parseJsonBody()') < clearSessionRoute.indexOf('if (withBrowserTask.busy)'),
    'the session clear route must recheck browser activity after parsing the request body');
  assert(clearSessionRoute.includes('const cleared = await withBrowserTask(async () =>'),
    'session profile deletion must hold the shared browser task lock');
  assert(clearSessionRoute.indexOf('withBrowserTask(async () =>') < clearSessionRoute.indexOf('fs.rmSync'),
    'the worker profile must be deleted only after acquiring the browser task lock');
  assert(clearSessionRoute.indexOf('await standaloneBrowserRecovery.closeProfile(profilePath)') < clearSessionRoute.indexOf('fs.rmSync(profilePath'),
    'failed standalone browser handles must be retried before deleting their locked profile');
  assert.match(standaloneLoginRoute, /standaloneBrowserRecovery\.track\(browser, profileDir\)/,
    'standalone interactive-login browsers must be registered for failed-close recovery');
  assert.match(standaloneSource, /browserRecoveryRegistry: standaloneBrowserRecovery/,
    'standalone scraping browsers must share the recovery registry used by profile reset');
  assert.match(clearSessionRoute, /const profilePath = getMarketplaceBrowserProfilePath\(targetId\)[\s\S]*?clearEncryptedCookieSnapshot\(getMarketplaceCookiesPath\(targetId\)\)[\s\S]*?fs\.rmSync/,
    'standalone reset must delete the selected marketplace profile after clearing its cookie snapshot');
  assert.match(clearSessionRoute, /if \(isFlipkart\) \{\s*clearEncryptedCookieSnapshot\(COOKIES_PATH\)/,
    'standalone reset must retain the legacy cookie cleanup only for Flipkart');
  const standaloneProfileCleanup = clearSessionRoute.slice(clearSessionRoute.indexOf('fs.rmSync(profilePath'), clearSessionRoute.indexOf('return { success: true'));
  assert(!standaloneProfileCleanup.includes('if (isFlipkart)'), 'standalone reset must delete profiles for every marketplace');
  assert.match(clearSessionRoute, /if \(fs\.existsSync\(profilePath\)\) throw/,
    'standalone reset must fail if browser-profile removal did not take effect');
  assert.match(desktopResetHandler, /clearEncryptedCookieSnapshot\(cookiesPath\)[\s\S]*?const profilePath = getMarketplaceBrowserProfilePath\(targetId\)[\s\S]*?fs\.rmSync/,
    'desktop reset must delete the selected marketplace profile after clearing its cookie snapshot');
  assert.match(desktopResetHandler, /if \(isFlipkart\) \{\s*clearEncryptedCookieSnapshot\(COOKIES_PATH\)/,
    'desktop reset must retain the legacy cookie cleanup only for Flipkart');
  const desktopProfileCleanup = desktopResetHandler.slice(desktopResetHandler.indexOf('const profilePath'), desktopResetHandler.indexOf('if (partitionErr)'));
  assert(!desktopProfileCleanup.includes('if (isFlipkart)'), 'desktop reset must delete profiles for every marketplace');
  const desktopBrowserClose = desktopResetHandler.slice(desktopResetHandler.indexOf('const isFlipkart'), desktopResetHandler.indexOf('const cookiesPath'));
  assert(desktopBrowserClose.includes('await externalBrowserSession.close({') && desktopBrowserClose.includes("reason: 'cookie-reset'"),
    'desktop reset must close the selected retained browser for every marketplace');
  assert(!desktopBrowserClose.includes('if (isFlipkart)'), 'retained browser cleanup must cover every marketplace');
  assert.match(desktopResetHandler, /if \(fs\.existsSync\(profilePath\)\) throw/,
    'desktop reset must fail if browser-profile removal did not take effect');
});

test('manual sign-in timeout leaves its window and authentication watcher available to the worker', async () => {
  const harness = manualLoginHarness();
  const completion = harness.manager.open({ waitMs: 5000 });
  await Promise.resolve();
  harness.timeout();
  const pending = await completion;
  assert.equal(pending.waitingForManualLogin, true);
  assert.equal(harness.manager.getWindow(), harness.windows[0]);

  harness.setAuthenticated(true);
  await harness.poll();
  assert.equal(harness.saved.length, 1);
});

test('closing a manual sign-in window cancels an in-flight authentication check before cookies are saved', async () => {
  const windows = [];
  const saved = [];
  let resolveAuthentication;
  let markAuthenticationStarted;
  const authenticationStarted = new Promise(resolve => { markAuthenticationStarted = resolve; });
  const authentication = new Promise(resolve => { resolveAuthentication = resolve; });
  class BrowserWindow extends FakeWindow {
    constructor(options) { super(options); windows.push(this); }
  }
  const manager = createManualLoginWindowManager({
    BrowserWindow,
    portalSession: { id: 'persist:marketplace-flipkart_shopsy' },
    isAuthenticated: async () => { markAuthenticationStarted(); return authentication; },
    readCookies: async () => [{ name: 'session', value: 'should-not-be-saved', domain: '.flipkart.com' }],
    saveCookies: async cookies => saved.push(cookies),
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    setTimeoutFn: () => 2,
    clearTimeoutFn: () => {}
  });

  const completion = manager.open({ waitMs: 5000 });
  await authenticationStarted;
  manager.close();
  const cancelled = await completion;
  assert.equal(cancelled.success, false);
  resolveAuthentication(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.length, 0, 'a cancelled watcher must not restore cookies after Reset Cookies or sign-out');
  assert.equal(windows[0].isDestroyed(), true);
});

test('reset refuses success when an existing encrypted cookie snapshot cannot be removed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-cookie-clear-'));
  const cookiePath = path.join(tempDir, 'cookies_flipkart_shopsy.json');
  fs.writeFileSync(cookiePath, 'encrypted fixture');
  try {
    assert.throws(() => clearEncryptedCookieSnapshot(cookiePath, { remove: () => false }), /Could not remove the saved cookie snapshot/);
    assert.equal(fs.existsSync(cookiePath), true, 'failed removal must leave the session profile untouched for a truthful retry');
    assert.equal(clearEncryptedCookieSnapshot(cookiePath), true);
    assert.equal(fs.existsSync(cookiePath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Electron cookies are normalized for encrypted snapshots without extending their expiry', () => {
  const normalized = normalizeElectronSessionCookies([
    { name: 'session', value: 'x', domain: '.flipkart.com', path: '/', session: true, sameSite: 'no_restriction', secure: true },
    { name: 'remember', value: 'y', domain: '.flipkart.com', expirationDate: 2000000000, sameSite: 'lax' }
  ]);
  assert.deepEqual(normalized[0], {
    name: 'session', value: 'x', domain: '.flipkart.com', path: '/', secure: true,
    httpOnly: false, session: true, sameSite: 'None'
  });
  assert.equal(normalized[1].expires, 2000000000);
  assert.equal(normalized[1].sameSite, 'Lax');
});

test('scraping opens Seller Hub root, verifies dashboard session, and requires auth before extraction', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-manual-login-'));
  const cookiePath = path.join(tempDir, 'cookies.json');
  const navigations = [];
  let currentUrl = 'about:blank';
  let loggedIn = false;
  const page = {
    on() {}, off() {},
    goto: async url => { currentUrl = url; navigations.push(url); },
    reload: async () => {},
    setCookie: async () => {},
    waitForSelector: async () => {},
    type: async () => {},
    cookies: async () => [{ name: 'session', value: 'saved', domain: '.flipkart.com' }],
    url: () => currentUrl,
    title: () => 'Seller Hub',
    screenshot: async () => Buffer.from('test screenshot'),
    evaluate: async (fn, ...args) => {
      if (fn.name === 'isFlipkartAuthenticated') return loggedIn && currentUrl.includes('#dashboard');
      if (fn.toString().includes('KeyboardEvent')) return true;
      if (fn.toString().includes('q.fsn === expected')) return true;
      return [];
    }
  };
  const browser = { pages: async () => [page], newPage: async () => page, close: async () => {} };
  const runtime = { partition: 'persist:test', launch: async () => browser };
  try {
    const result = await scrapeFlipkartRateCards({
      marketplace: 'flipkart',
      fsnCatalog: [{ marketplace: 'flipkart', category: 'kurta', brand: 'Fixture', sample_fsn: 'ABCDEFGHIJKLMNOP' }],
      scopeVerticals: ['kurta'],
      requiredVerticals: ['kurta']
    }, {
      runtime,
      cookiesPath: cookiePath,
      fallbackCookiesPath: path.join(tempDir, 'fallback.json'),
      stagingDir: path.join(tempDir, 'staging'),
      delay: async () => {},
      onProgress: () => {},
      onSessionExpiry: async () => {
        loggedIn = true;
        saveEncryptedCookies(cookiePath, [{ name: 'session', value: 'saved', domain: '.flipkart.com' }]);
        return true;
      }
    });

    assert.equal(navigations[0], FLIPKART_MANUAL_LOGIN_URL);
    assert(navigations.includes(FLIPKART_DASHBOARD_URL));
    assert.equal(result.success, false, 'no fee responses were provided, so the extraction must be rejected');
    assert.match(result.error, /Missing rate responses/);
    assert.equal(fs.existsSync(result.stagingFile || ''), false, 'incomplete extraction must not be staged');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a slowly hydrating Seller Hub dashboard is accepted before manual sign-in is requested', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-slow-dashboard-'));
  let currentUrl = '';
  let authChecks = 0;
  let reauthenticationPrompts = 0;
  const page = {
    on() {}, off() {},
    goto: async url => { currentUrl = url; },
    reload: async () => {},
    waitForSelector: async () => {},
    type: async () => {},
    cookies: async () => [],
    url: () => currentUrl,
    title: () => 'Seller Hub',
    screenshot: async () => Buffer.from('test screenshot'),
    evaluate: async (fn) => {
      if (fn.name === 'inspectFlipkartLoginState') {
        authChecks++;
        const authenticated = authChecks >= 8;
        return { surface:'flipkart', stage:authenticated ? 'authenticated' : 'portal', authenticated, loginFormVisible:false, challengeVisible:false, publicLanding:false };
      }
      if (fn.toString().includes('KeyboardEvent')) return true;
      if (fn.toString().includes('q.fsn === expected')) return true;
      return [];
    }
  };
  const runtime = { partition: 'persist:test', launch: async () => ({ pages: async () => [page], newPage: async () => page, close: async () => {} }) };
  try {
    const result = await scrapeFlipkartRateCards({
      marketplace: 'flipkart',
      fsnCatalog: [{ marketplace:'flipkart', category:'kurta', brand:'Fixture', sample_fsn:'ABCDEFGHIJKLMNOP' }],
      scopeVerticals: ['kurta'],
      requiredVerticals: ['kurta']
    }, {
      runtime,
      cookiesPath: path.join(tempDir, 'cookies.json'),
      fallbackCookiesPath: path.join(tempDir, 'fallback.json'),
      stagingDir: path.join(tempDir, 'staging'),
      delay: async () => {},
      onProgress: () => {},
      onSessionExpiry: async () => { reauthenticationPrompts++; return false; }
    });

    assert.equal(authChecks, 8, 'the session check should continue beyond five transient misses');
    assert.equal(reauthenticationPrompts, 0, 'slow dashboard hydration must not trigger a false sign-in prompt');
    assert.equal(result.success, false, 'the fixture provides no actual rate-card responses');
    assert.match(result.error, /Missing rate responses/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('visible external scraping activates its Seller Hub tab before navigating', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-visible-tab-'));
  const actions = [];
  let currentUrl = 'about:blank';
  const page = {
    on() {}, off() {},
    bringToFront: async () => actions.push('bring-to-front'),
    goto: async url => { actions.push('navigate'); currentUrl = url; },
    setCookie: async () => {},
    evaluate: async fn => fn.name === 'isFlipkartAuthenticated' ? false : [],
    cookies: async () => [],
    url: () => currentUrl,
    title: () => 'Seller Hub',
    screenshot: async () => Buffer.from('test screenshot')
  };
  const browser = { pages: async () => [page], close: async () => {} };
  const runtime = { launch: async () => browser };
  try {
    const result = await scrapeFlipkartRateCards({ marketplace: 'flipkart', visible: true }, {
      runtime,
      executablePath: 'test-chrome',
      browserProfileDir: path.join(tempDir, 'profile'),
      cookiesPath: path.join(tempDir, 'cookies.json'),
      fallbackCookiesPath: path.join(tempDir, 'fallback.json'),
      stagingDir: path.join(tempDir, 'staging'),
      delay: async ms => actions.push(`wait:${ms}`),
      onProgress: () => {},
      onSessionExpiry: async () => false
    });

    assert.equal(result.success, false, 'the fixture remains logged out and must stop before extraction');
    assert.equal(actions[0], 'wait:1000', 'visible Chromium waits before its first page interaction');
    assert.equal(actions[1], 'bring-to-front', 'the selected Seller Hub page is made the visible Chrome tab');
    assert(actions.indexOf('bring-to-front') < actions.indexOf('navigate'));
    assert.equal(actions[2], 'wait:1000', 'navigation retains the sequential interaction delay');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('headless session expiry reopens the same persistent Chrome profile visibly before manual sign-in', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-visible-reauth-'));
  const profileDir = path.join(tempDir, 'profile');
  const urls = ['', ''];
  const pages = urls.map((_url, index) => ({
    on() {}, off() {},
    goto: async url => { urls[index] = url; },
    setCookie: async () => {},
    evaluate: async fn => fn.name === 'isFlipkartAuthenticated' ? urls[index].includes('#dashboard') && index === 1 : [],
    cookies: async () => [],
    url: () => urls[index],
    title: () => 'Seller Hub',
    screenshot: async () => Buffer.from('test screenshot')
  }));
  const browsers = pages.map(page => ({ pages: async () => [page], newPage: async () => page, close: async function () { this.closed = true; } }));
  const launchOptions = [];
  let callbackVisibility;
  const runtime = {
    launch: async options => {
      launchOptions.push(options);
      if (launchOptions.length === 2) assert.equal(browsers[0].closed, true, 'headless Chrome must release the profile before visible relaunch');
      return browsers[launchOptions.length - 1];
    }
  };
  try {
    const result = await scrapeFlipkartRateCards({ marketplace: 'flipkart', fsnCatalog: [], scopeVerticals: [], requiredVerticals: [] }, {
      runtime,
      executablePath: 'test-chrome',
      browserProfileDir: profileDir,
      cookiesPath: path.join(tempDir, 'cookies.json'),
      fallbackCookiesPath: path.join(tempDir, 'fallback.json'),
      stagingDir: path.join(tempDir, 'staging'),
      delay: async () => {},
      onProgress: () => {},
      canShowBrowser: () => true,
      onSessionExpiry: async (page, state) => {
        assert.equal(page.url(), FLIPKART_MANUAL_LOGIN_URL, 'manual sign-in must use the relaunched external Chrome page at the Seller Hub root');
        callbackVisibility = state.visible;
        return true;
      }
    });
    assert.equal(launchOptions.length, 2);
    assert.equal(launchOptions[0].headless, 'new');
    assert.equal(launchOptions[1].headless, false);
    assert.equal(launchOptions[0].userDataDir, profileDir);
    assert.equal(launchOptions[1].userDataDir, profileDir);
    assert.equal(callbackVisibility, true);
    assert.equal(urls[1], FLIPKART_DASHBOARD_URL, 'the scraper should enter the dashboard only after the root-page sign-in callback succeeds');
    assert.match(result.error, /No database FSNs are available/i, 'the test stops before scraping because it has no catalog rows');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('headless session expiry fails promptly when no desktop display is available', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-no-display-reauth-'));
  let launches = 0;
  let expiryCallbackCalled = false;
  let currentUrl = '';
  const page = {
    on() {}, off() {},
    goto: async url => { currentUrl = url; },
    setCookie: async () => {},
    evaluate: async fn => fn.name === 'isFlipkartAuthenticated' ? false : [],
    cookies: async () => [],
    url: () => currentUrl,
    title: () => 'Signed out',
    screenshot: async () => Buffer.from('test screenshot')
  };
  const browser = { pages: async () => [page], newPage: async () => page, close: async () => {} };
  try {
    const result = await scrapeFlipkartRateCards({ marketplace: 'flipkart' }, {
      runtime: { launch: async () => { launches++; return browser; } },
      executablePath: 'test-chrome',
      browserProfileDir: path.join(tempDir, 'profile'),
      cookiesPath: path.join(tempDir, 'cookies.json'),
      fallbackCookiesPath: path.join(tempDir, 'fallback.json'),
      stagingDir: path.join(tempDir, 'staging'),
      delay: async () => {},
      onProgress: () => {},
      canShowBrowser: () => false,
      onSessionExpiry: async () => { expiryCallbackCalled = true; return true; }
    });
    assert.equal(launches, 1);
    assert.equal(expiryCallbackCalled, false);
    assert.match(result.error, /no desktop display/i);
    assert.equal(fs.existsSync(result.stagingFile || ''), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('an initialized legacy profile with no verified state still imports encrypted cookies', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-empty-profile-'));
  const profileDir = path.join(tempDir, 'profile');
  const cookiePath = path.join(tempDir, 'cookies.json');
  fs.mkdirSync(profileDir);
  const cookieStore = path.join(profileDir, 'Default', 'Network', 'Cookies');
  fs.mkdirSync(path.dirname(cookieStore), { recursive: true });
  fs.writeFileSync(cookieStore, 'initialized-without-seller-session');
  saveEncryptedCookies(cookiePath, [{ name: 'valid-session', value: 'restorable', domain: '.flipkart.com' }]);
  let launchedWith;
  let setCookieCalls = 0;
  let currentUrl = '';
  const page = {
    on() {}, off() {},
    goto: async url => { currentUrl = url; },
    setCookie: async () => { setCookieCalls++; },
    evaluate: async fn => fn.name === 'inspectFlipkartLoginState'
      ? { surface:'flipkart', stage:'public', authenticated:false, loginFormVisible:false, challengeVisible:false, publicLanding:true }
      : false,
    url: () => currentUrl,
    title: () => 'Signed out',
    screenshot: async () => Buffer.from('test screenshot')
  };
  const browser = { pages: async () => [page], newPage: async () => page, close: async () => {} };
  const runtime = { launch: async options => { launchedWith = options; return browser; } };
  try {
    const result = await scrapeFlipkartRateCards({ marketplace: 'flipkart', browserProfileDir: profileDir }, {
      runtime,
      executablePath: 'test-chrome',
      browserProfileDir: profileDir,
      cookiesPath: cookiePath,
      fallbackCookiesPath: path.join(tempDir, 'fallback.json'),
      stagingDir: path.join(tempDir, 'staging'),
      delay: async () => {},
      onProgress: () => {}
    });
    assert.equal(launchedWith.userDataDir, profileDir);
    assert(launchedWith.args.includes('--restore-last-session'), 'existing profiles must restore their saved Seller Hub session on launch');
    assert.equal(setCookieCalls, 1, 'an initialized generic Chromium store must not block a valid cookie snapshot');
    assert.equal(result.success, false);
    assert.match(result.error, /login required/i);
    assert.equal(readSellerHubProfileState(profileDir), 'signed_out',
      'a visible public login landing must suppress automatic replay of an expired snapshot');
    assert.equal(fs.existsSync(cookiePath), true,
      'confirmed sign-out must retain the encrypted cookie snapshot for recovery');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('an ambiguous dashboard redirect preserves the verified profile and encrypted cookies', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-transient-session-'));
  const profileDir = path.join(tempDir, 'profile');
  const cookiePath = path.join(tempDir, 'cookies.json');
  fs.mkdirSync(profileDir, { recursive: true });
  writeSellerHubProfileState(profileDir, 'authenticated');
  saveEncryptedCookies(cookiePath, [{ name: 'session', value: 'fixture', domain: '.flipkart.com' }]);
  let currentUrl = '';
  let inspections = 0;
  const page = {
    on() {}, off() {},
    goto: async url => { currentUrl = url; },
    setCookie: async () => {},
    evaluate: async fn => {
      if (fn.name === 'inspectFlipkartLoginState') {
        inspections++;
        return { surface:'flipkart', stage:'portal', authenticated:false, loginFormVisible:false, challengeVisible:false, publicLanding:false };
      }
      return false;
    },
    url: () => currentUrl,
    title: () => 'Seller Hub loading',
    screenshot: async () => Buffer.from('test screenshot')
  };
  const browser = { pages: async () => [page], newPage: async () => page, close: async () => {} };
  const runtime = { launch: async () => browser };
  try {
    const result = await scrapeFlipkartRateCards({ marketplace: 'flipkart', browserProfileDir: profileDir }, {
      runtime,
      executablePath: 'test-chrome',
      browserProfileDir: profileDir,
      cookiesPath: cookiePath,
      fallbackCookiesPath: path.join(tempDir, 'fallback.json'),
      stagingDir: path.join(tempDir, 'staging'),
      delay: async () => {},
      onProgress: () => {}
    });

    assert.equal(result.success, false);
    assert.match(result.error, /login required/i);
    assert.equal(inspections, 15, 'session validation should allow an approximately 30-second hydration window');
    assert.equal(readSellerHubProfileState(profileDir), 'authenticated',
      'an unrecognized redirect must not overwrite the last verified session state');
    assert.equal(fs.existsSync(cookiePath), true,
      'a transient redirect must not delete the encrypted cookie snapshot');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a confirmed signed-out browser profile is not overwritten by stale cookie snapshots', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-profile-session-'));
  const profileDir = path.join(tempDir, 'profile');
  const cookiePath = path.join(tempDir, 'cookies.json');
  const cookieStore = path.join(profileDir, 'Default', 'Network', 'Cookies');
  fs.mkdirSync(path.dirname(cookieStore), { recursive: true });
  fs.writeFileSync(cookieStore, 'chromium-cookie-store');
  writeSellerHubProfileState(profileDir, 'signed_out');
  saveEncryptedCookies(cookiePath, [{ name: 'old-session', value: 'expired', domain: '.flipkart.com' }]);
  let launchedWith;
  let setCookieCalls = 0;
  let currentUrl = '';
  const page = {
    on() {}, off() {},
    goto: async url => { currentUrl = url; },
    setCookie: async () => { setCookieCalls++; },
    evaluate: async fn => fn.name === 'isFlipkartAuthenticated' ? false : [],
    url: () => currentUrl,
    title: () => 'Signed out',
    screenshot: async () => Buffer.from('test screenshot')
  };
  const browser = { pages: async () => [page], newPage: async () => page, close: async () => {} };
  const runtime = { launch: async options => { launchedWith = options; return browser; } };
  try {
    const result = await scrapeFlipkartRateCards({ marketplace: 'flipkart', browserProfileDir: profileDir }, {
      runtime,
      executablePath: 'test-chrome',
      browserProfileDir: profileDir,
      cookiesPath: cookiePath,
      fallbackCookiesPath: path.join(tempDir, 'fallback.json'),
      stagingDir: path.join(tempDir, 'staging'),
      delay: async () => {},
      onProgress: () => {}
    });
    assert.equal(launchedWith.userDataDir, profileDir);
    assert.equal(setCookieCalls, 0, 'stale cookie snapshots must not restore a logged-out session');
    assert.equal(result.success, false);
    assert.match(result.error, /login required/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
