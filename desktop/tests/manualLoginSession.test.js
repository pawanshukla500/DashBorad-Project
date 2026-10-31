import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManualLoginWindowManager, normalizeElectronSessionCookies } from '../manualLoginWindow.js';
import { FLIPKART_DASHBOARD_URL, FLIPKART_MANUAL_LOGIN_URL } from '../portalSession.js';
import { scrapeFlipkartRateCards } from '../portalScraper.js';
import { clearEncryptedCookieSnapshot, saveEncryptedCookies } from '../cookieVault.js';

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
  assert.match(scraperSource, /--restore-last-session/,
    'Chromium must restore the saved profile session after a clean app restart');
  assert.match(mainSource, /userDataDir: profileDir/);
  assert.match(mainSource, /page\.goto\(manualLoginUrl, \{ waitUntil: 'domcontentloaded'/);
  assert.match(mainSource, /const timeoutMs = 30 \* 60 \* 1000/);
  assert.match(mainSource, /async function openManualFlipkartLogin\(\{ onProgress = \(\) => \{\}, waitMs \} = \{\}\)/);
  assert.match(mainSource, /manager\.open\(\{ waitMs \}\)/);
  assert.match(mainSource, /captureScrapeFailure\(page, DIAGNOSTICS_DIR,[\s\S]*?operation: 'manual_login'/,
    'manual-login failures must use the redacted, bounded diagnostic screenshot path');
  assert.match(externalExpiryHandler, /async \(page, \{ visible = false \} = \{\}\) => \{\s*if \(!visible\) return false;/,
    'external reauthentication must only wait on a visible browser page');
  assert(!externalExpiryHandler.includes('openManualFlipkartLogin'), 'external Chrome reauthentication must not switch to a separate Electron storage partition');
  assert.match(externalExpiryHandler, /if \(cookies\.length\)[\s\S]*?deleteEncryptedCookies\(getMarketplaceCookiesPath\('flipkart_shopsy'\)\)/,
    'visible reauthentication must remove stale cookie snapshots when the authenticated browser has no cookies');
  assert.match(workerEntry, /visible: true/);
  assert.match(standaloneSource, /userDataDir: profileDir/);
  assert.match(standaloneSource, /mpConfig\.id === 'flipkart_shopsy'[\s\S]*?FLIPKART_MANUAL_LOGIN_URL/);
  assert.match(standaloneWorker, /visible: canOpenVisibleBrowser\(\)/);
  assert.match(standaloneWorker, /onSessionExpiry: async page/);
  assert.match(standaloneWorker, /page\.waitForFunction\(isFlipkartAuthenticated, \{ timeout: 30 \* 60 \* 1000/);
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
  assert.match(clearSessionRoute, /clearEncryptedCookieSnapshot\(getMarketplaceCookiesPath\(targetId\)\)[\s\S]*?clearEncryptedCookieSnapshot\(COOKIES_PATH\)[\s\S]*?fs\.rmSync/,
    'standalone reset must verify both cookie snapshots are removed before deleting the persistent profile');
  assert.match(clearSessionRoute, /if \(fs\.existsSync\(profilePath\)\) throw/,
    'standalone reset must fail if browser-profile removal did not take effect');
  assert.match(desktopResetHandler, /clearEncryptedCookieSnapshot\(cookiesPath\)[\s\S]*?clearEncryptedCookieSnapshot\(COOKIES_PATH\)[\s\S]*?fs\.rmSync/,
    'desktop reset must verify both cookie snapshots are removed before deleting the persistent profile');
  assert.match(desktopResetHandler, /externalBrowserSession\.close\([\s\S]*?reason: 'cookie-reset'[\s\S]*?fs\.rmSync/,
    'desktop reset must close the profile owner before deleting its browser data');
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

test('scraping starts at the Seller Hub root, then enters the dashboard only after manual login succeeds', async () => {
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

test('an empty directory from a failed Chrome launch still imports encrypted cookies', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-empty-profile-'));
  const profileDir = path.join(tempDir, 'profile');
  const cookiePath = path.join(tempDir, 'cookies.json');
  fs.mkdirSync(profileDir);
  saveEncryptedCookies(cookiePath, [{ name: 'valid-session', value: 'restorable', domain: '.flipkart.com' }]);
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
    assert(launchedWith.args.includes('--restore-last-session'), 'existing profiles must restore their saved Seller Hub session on launch');
    assert.equal(setCookieCalls, 1, 'a directory without Chromium session stores must not block the valid cookie snapshot');
    assert.equal(result.success, false);
    assert.match(result.error, /login required/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('an existing persistent browser profile is not overwritten by stale cookie snapshots after Seller Hub logout', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-profile-session-'));
  const profileDir = path.join(tempDir, 'profile');
  const cookiePath = path.join(tempDir, 'cookies.json');
  const cookieStore = path.join(profileDir, 'Default', 'Network', 'Cookies');
  fs.mkdirSync(path.dirname(cookieStore), { recursive: true });
  fs.writeFileSync(cookieStore, 'chromium-cookie-store');
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
