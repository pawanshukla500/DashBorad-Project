import fs from 'node:fs';
import { FLIPKART_DASHBOARD_URL, FLIPKART_MANUAL_LOGIN_URL, isFlipkartAuthenticated } from './portalSession.js';
import { attachRateCardCapture } from './rateCardCapture.js';
import { parsePortalRateSnapshot } from './portalRates.js';
import { captureScrapeFailure } from './scrapeDiagnostics.js';
import path from 'node:path';
import { buildFsnPlan } from './fsnPlan.js';
import { canOpenVisibleBrowser, focusBrowserPage, getBrowserRuntime, requireChromeExecutable } from './browserRuntime.js';
import { getResolvedUserDataDir, loadEncryptedCookies, saveEncryptedCookies, deleteEncryptedCookies } from './cookieVault.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROFILE_SESSION_STORES = [
  path.join('Default', 'Network', 'Cookies'),
  path.join('Default', 'Cookies'),
  path.join('Default', 'Local Storage', 'leveldb', 'CURRENT')
];

function hasPersistentProfileSession(profileDir) {
  if (!profileDir) return false;
  return PROFILE_SESSION_STORES.some(relativePath => {
    try {
      const store = fs.statSync(path.join(profileDir, relativePath));
      return store.isFile() && store.size > 0;
    } catch {
      return false;
    }
  });
}

/**
 * Self-contained portal extraction for both Electron and the Linux server.
 * Runtime injection keeps the full extraction lifecycle testable offline.
 */
export async function scrapeFlipkartRateCards(config = {}, {
  onProgress = console.log,
  cookiesPath = path.join(getResolvedUserDataDir(), 'cookies', 'cookies_flipkart_shopsy.json'),
  fallbackCookiesPath = path.join(getResolvedUserDataDir(), 'cookies.json'),
  stagingDir = path.join(getResolvedUserDataDir(), 'staging'),
  runtime = getBrowserRuntime(),
  executablePath,
  browserProfileDir = config.browserProfileDir,
  delay = wait,
  onSessionExpiry,
  canShowBrowser = canOpenVisibleBrowser,
  browserRecoveryRegistry
} = {}) {
  const marketplace = config.marketplace || 'both';
  if (!['both', 'flipkart_shopsy', 'flipkart', 'shopsy'].includes(marketplace)) {
    return { success: false, error: `Automated scraping is not implemented for ${marketplace}.` };
  }
  let browser;
  let currentPage;
  let captureHandle;
  let browserRecoveryLease;
  let page;
  let safeGoto;
  const context = { marketplace, stage: 'launch' };
  try {
    const profileDir = browserProfileDir;
    // A failed first launch may leave an empty userDataDir behind. Treat only
    // actual Chromium cookie/local-storage stores as the profile source of
    // truth, so that directory cannot suppress a valid encrypted cookie import.
    const hasPersistentProfile = hasPersistentProfileSession(profileDir);
    if (profileDir && !runtime?.partition) fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const launchBrowser = async visible => {
      browser = await runtime.launch({
        executablePath: executablePath || (runtime?.partition ? undefined : requireChromeExecutable()),
        headless: visible ? false : 'new',
        defaultViewport: visible ? null : { width: 1500, height: 1000 },
        ...(!runtime?.partition && profileDir ? { userDataDir: profileDir } : {}),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          ...(profileDir ? ['--restore-last-session'] : []),
          ...(visible ? ['--start-maximized'] : ['--window-size=1500,1000'])
        ]
      });
      browserRecoveryLease = browserRecoveryRegistry?.track(browser, profileDir);
      const rawPage = (await browser.pages())[0] || await browser.newPage();
      currentPage = rawPage;
      captureHandle = attachRateCardCapture(rawPage);
      page = new Proxy(rawPage, { get(target, key) {
        const value = target[key];
        if (typeof value !== 'function') return value;
        if (!['goto', 'reload', 'evaluate', 'waitForSelector', 'type', 'setCookie'].includes(key)) return value.bind(target);
        return async (...args) => { await delay(1000); return value.apply(target, args); };
      }});
      if (visible) await focusBrowserPage(rawPage, { delay });
      safeGoto = async (targetUrl, options = {}) => {
        try {
          return await page.goto(targetUrl, { waitUntil: 'load', timeout: 35000, ...options });
        } catch (navErr) {
          const msg = String(navErr?.message || navErr);
          if (msg.includes('ERR_ABORTED') || navErr?.code === 'ERR_ABORTED' || navErr?.errno === -3) {
            return { ok: true, redirected: true };
          }
          if (msg.includes('quiet network state')) {
            return { ok: true, quietTimeout: true };
          }
          throw navErr;
        }
      };
    };
    await launchBrowser(Boolean(config.visible));
    const cookieFile = fs.existsSync(cookiesPath) ? cookiesPath : fallbackCookiesPath;
    // A persistent Chromium profile is the session source of truth. Replaying
    // an old cookie snapshot after a Seller Hub logout could silently undo it.
    // Import the encrypted snapshot only for a fresh non-Electron profile.
    if (!runtime?.partition && !hasPersistentProfile && fs.existsSync(cookieFile)) {
      const cookies = loadEncryptedCookies(cookieFile);
      if (cookies?.length) {
        await page.setCookie(...cookies);
      } else {
        deleteEncryptedCookies(cookieFile);
      }
    }
    // Always begin on the public Seller Hub landing page. The operator signs
    // in manually; only after verified authentication do we enter the portal.
    await onProgress('Connecting to Flipkart Seller Hub...');
    context.stage = 'authentication';
    await safeGoto(FLIPKART_MANUAL_LOGIN_URL, { waitUntil: 'load', timeout: 35000 });

    let authenticated = false;
    // A restored Chromium session can redirect asynchronously. Never delete a
    // cookie jar just because the first public-page check is not authenticated.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await page.evaluate(isFlipkartAuthenticated) === true) { authenticated = true; break; }
      await delay(1000);
    }
    if (!authenticated) {
      if (typeof onSessionExpiry !== 'function') throw new Error('Seller Hub login required. Open the manual sign-in window at seller.flipkart.com and retry.');
      let visibleForLogin = Boolean(config.visible || runtime?.partition);
      if (!visibleForLogin) {
        if (!canShowBrowser()) {
          throw new Error('Seller Hub login required. This worker has no desktop display for manual sign-in; start it in the desktop session and retry. Nothing was staged.');
        }
        captureHandle?.detach();
        captureHandle = null;
        if (browserRecoveryLease) await browserRecoveryLease.close();
        else await browser.close();
        browser = null;
        browserRecoveryLease = null;
        currentPage = null;
        await launchBrowser(true);
        visibleForLogin = true;
        await onProgress('Seller Hub session expired. Reopened the same persistent Chrome profile visibly for manual sign-in.');
        await safeGoto(FLIPKART_MANUAL_LOGIN_URL, { waitUntil: 'load', timeout: 35000 });
      }
      const resumed = await onSessionExpiry(page, { visible: visibleForLogin });
      if (!resumed) throw new Error('Manual Seller Hub login is incomplete. Nothing was staged.');
      const refreshedCookies = loadEncryptedCookies(cookiesPath) || loadEncryptedCookies(fallbackCookiesPath);
      if (refreshedCookies?.length) await page.setCookie(...refreshedCookies);
      await safeGoto(FLIPKART_DASHBOARD_URL, { waitUntil: 'load', timeout: 35000 });
      authenticated = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (await page.evaluate(isFlipkartAuthenticated) === true) { authenticated = true; break; }
        await delay(1000);
      }
      if (!authenticated) throw new Error('Seller Hub sign-in did not establish an authenticated dashboard session. Nothing was staged.');
    }
    const sessionCookies = await page.cookies();
    if (sessionCookies?.length) {
      saveEncryptedCookies(cookiesPath, sessionCookies);
      saveEncryptedCookies(fallbackCookiesPath, sessionCookies);
    } else {
      deleteEncryptedCookies(cookiesPath);
      deleteEncryptedCookies(fallbackCookiesPath);
    }
    const plan = buildFsnPlan(config.fsnCatalog, { marketplace, brand: config.brand, verticals: config.scopeVerticals, requiredVerticals: config.requiredVerticals });
    const effectiveDate = new Date().toISOString().slice(0, 10);
    const capture = captureHandle.capture;
    const data = [];
    const searchSelector = 'input[placeholder="Search Product vertical or FSN"]';
    for (const target of plan) {
      const { category: vertical, marketplace: queryMarketplace, sample_fsn: fsn, brand } = target;
      for (const fulfilment of ['non-fbf', 'fbf']) {
        const mode = fulfilment === 'fbf' ? 'FBF' : 'NON_FBF';
        Object.assign(context, { stage: 'fsn_search', vertical, brand, fsn, fulfilment: mode });
        const date = effectiveDate + ' 12:00:00';
        const query = { marketplace: queryMarketplace, fulfillment: fulfilment, date };
        await onProgress('Searching database FSN ' + fsn + ' / ' + brand + ' / ' + vertical + ' (' + mode + ')...');
        capture.reset();
        await safeGoto('https://seller.flipkart.com/index.html#dashboard/payments/rate-card?query=' + encodeURIComponent(JSON.stringify(query)), { waitUntil: 'load', timeout: 35000 });
        await page.waitForSelector(searchSelector, { visible: true, timeout: 30000 });
        // Puppeteer appends by default. Clear through the native input setter
        // before real typing so React observes the new FSN in both runtimes.
        await page.evaluate(selector => {
          const el = document.querySelector(selector);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, searchSelector);
        await page.type(searchSelector, fsn, { delay: 60 });
        // The observed widget submits on Enter; its search icon is hidden
        // after typing. Dispatch that observed widget event in both engines.
        const submitted = await page.evaluate(selector => {
          const input = document.querySelector(selector);
          if (!input) return false;
          input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', charCode: 13, keyCode: 13, which: 13, bubbles: true }));
          return true;
        }, searchSelector);
        if (submitted !== true) throw new Error('Seller Hub FSN search input disappeared. Nothing was staged.');
        let matched = false;
        for (let attempt = 0; attempt < 15; attempt++) {
          matched = await page.evaluate((expected, channel, fulfillment) => {
            try {
              const q = JSON.parse(decodeURIComponent(location.hash.split('?query=')[1] || ''));
              return q.fsn === expected && q.marketplace === channel && q.fulfillment === fulfillment;
            } catch { return false; }
          }, fsn, queryMarketplace, fulfilment);
          if (matched === true) break;
        }
        if (matched !== true) throw new Error('Seller Hub did not accept FSN search ' + fsn + '. Nothing was staged.');
        Object.assign(context, { stage: 'rate_responses' });
        const readSnapshot = () => capture.snapshot({ fsn, marketplace: queryMarketplace, fulfilment: mode, date });
        let snapshot;
        // Submitting an FSN normally starts fresh queries. Let those complete:
        // reloading immediately aborts their response bodies in real Electron.
        for (let attempt = 0; attempt < 10; attempt++) {
          await delay(1000);
          snapshot = readSnapshot();
          if (!snapshot.missing.length) break;
        }
        if (snapshot.missing.length) {
          // Recover mounted SPA panels that did not issue this search context.
          capture.reset();
          await page.reload({ waitUntil: 'load', timeout: 35000 });
          for (let attempt = 0; attempt < 30; attempt++) {
            await delay(1000);
            snapshot = readSnapshot();
            if (!snapshot.missing.length) break;
          }
        }
        if (snapshot.missing.length) throw new Error('Missing rate responses for ' + fsn + ' / ' + mode + ': ' + snapshot.missing.join(', ') + '. Nothing was staged.');
        data.push(parsePortalRateSnapshot(snapshot, { vertical, marketplace: queryMarketplace, fulfilment: mode, effectiveDate, brand, fsn, sku: target.sample_sku, orderCount: target.order_count }));
      }
    }
    if (data.length === 0) {
      throw new Error('No rate card tables found for any selected vertical. Nothing was staged.');
    }
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    const stagingFile = path.join(stagingDir, `ratecards_${Date.now()}.json`);
    fs.writeFileSync(stagingFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    return { success: true, data, stagingFile };
  } catch (error) {
    let diagnostic;
    try { diagnostic = await captureScrapeFailure(currentPage, path.join(stagingDir, 'diagnostics'), context, error); } catch {}
    return { success: false, error: error.message, errorCode: diagnostic?.code || 'EXTRACTION_REJECTED', diagnostic };
  } finally {
    captureHandle?.detach();
    if (browser) {
      if (browserRecoveryLease) await browserRecoveryLease.close();
      else await browser.close();
    }
  }
}
