import fs from 'node:fs';
import { FLIPKART_DASHBOARD_URL, FLIPKART_MANUAL_LOGIN_URL, inspectFlipkartLoginState, isFlipkartAuthenticated } from './portalSession.js';
import { attachRateCardCapture } from './rateCardCapture.js';
import { parsePortalRateSnapshot } from './portalRates.js';
import { captureScrapeFailure } from './scrapeDiagnostics.js';
import path from 'node:path';
import { buildFsnPlan } from './fsnPlan.js';
import { canOpenVisibleBrowser, focusBrowserPage, getBrowserRuntime, requireChromeExecutable } from './browserRuntime.js';
import { getResolvedUserDataDir, loadEncryptedCookies, saveEncryptedCookies, deleteEncryptedCookies } from './cookieVault.js';
import { readSellerHubProfileState, writeSellerHubProfileState } from './portalProfileState.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SESSION_AUTH_CHECK_ATTEMPTS = 15;

async function waitForSellerHubDashboard(page, delay) {
  let inspection = null;
  for (let attempt = 0; attempt < SESSION_AUTH_CHECK_ATTEMPTS; attempt++) {
    let authenticated = false;
    try {
      const current = await page.evaluate(inspectFlipkartLoginState);
      if (current && typeof current === 'object' && current.surface === 'flipkart') {
        inspection = current;
        authenticated = current.authenticated === true;
      } else {
        authenticated = await page.evaluate(isFlipkartAuthenticated) === true;
      }
    } catch {
      // A renderer may be changing routes while Seller Hub redirects.
    }
    if (authenticated) return { authenticated: true, inspection };
    if (attempt + 1 < SESSION_AUTH_CHECK_ATTEMPTS) await delay(1000);
  }
  return { authenticated: false, inspection };
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
  browserRecoveryRegistry,
  onCookieDiagnostics = () => {}
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
    const wrapPage = rawPage => new Proxy(rawPage, { get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (!['goto', 'reload', 'evaluate', 'waitForSelector', 'type', 'setCookie'].includes(key)) return value.bind(target);
      return async (...args) => { await delay(1000); return value.apply(target, args); };
    }});
    const attachPage = rawPage => {
      captureHandle?.detach?.();
      currentPage = rawPage;
      captureHandle = attachRateCardCapture(rawPage);
      page = wrapPage(rawPage);
    };
    const readCookieSnapshot = file => loadEncryptedCookies(file, {
      onInvalidRecords: discardedRecords => {
        try { onCookieDiagnostics({ sourceFile: path.basename(file), discardedRecords }); } catch {}
      }
    });
    // Chromium creates cookie/local-storage files before a seller signs in.
    // Only a verified profile session or an explicit sign-out can suppress
    // cookie handoff. This also migrates older initialized profiles and allows
    // a fresh Electron login snapshot to reach external Chrome.
    const profileSessionState = readSellerHubProfileState(profileDir);
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
      let preferredPage = null;
      try { preferredPage = await runtime?.getPage?.(browser); } catch {}
      const pages = await browser.pages();
      const preferredIsOpen = preferredPage && pages.includes(preferredPage) &&
        !(typeof preferredPage.isClosed === 'function' && preferredPage.isClosed());
      const rawPage = preferredIsOpen ? preferredPage : (pages[0] || await browser.newPage());
      attachPage(rawPage);
      if (visible) await focusBrowserPage(rawPage, {
        delay,
        onViewport: viewport => onProgress(
          `Expanded visible Seller Hub browser to ${viewport.width}x${viewport.height} for the desktop sign-in controls.`
        )
      });
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
    // A confirmed profile session remains authoritative after sign-out. For
    // older/unknown profiles or a fresh snapshot from the in-app login window,
    // restore encrypted cookies even if Chromium initialized generic stores.
    let snapshotImported = false;
    if (!runtime?.partition && ['unknown', 'snapshot_available'].includes(profileSessionState) && fs.existsSync(cookieFile)) {
      const cookies = readCookieSnapshot(cookieFile);
      if (cookies?.length) {
        await page.setCookie(...cookies);
        snapshotImported = true;
      } else {
        deleteEncryptedCookies(cookieFile);
      }
    }
    // Begin on the public landing page for manual sign-in, then probe the
    // same-origin dashboard to validate the saved session before extraction.
    await onProgress('Connecting to Flipkart Seller Hub...');
    context.stage = 'authentication';
    await safeGoto(FLIPKART_MANUAL_LOGIN_URL, { waitUntil: 'load', timeout: 35000 });
    // The public landing page is intentionally not an authentication signal.
    // Probe the same-origin dashboard route so a persisted session can be
    // recognized even when Seller Hub leaves the public page open at `/`.
    await onProgress('Checking the saved Seller Hub session...');
    await safeGoto(FLIPKART_DASHBOARD_URL, { waitUntil: 'load', timeout: 35000 });

    // Seller Hub can take several seconds to hydrate or finish a redirect.
    // Retry for about 30 seconds (including the one-second page interaction
    // pause), and preserve the saved session unless sign-in is visibly required.
    let { authenticated, inspection: sessionInspection } = await waitForSellerHubDashboard(page, delay);
    if (!runtime?.partition && profileDir) {
      if (authenticated) {
        writeSellerHubProfileState(profileDir, 'authenticated');
      } else if ((profileSessionState === 'authenticated' || snapshotImported) &&
          sessionInspection?.surface === 'flipkart' && !sessionInspection.challengeVisible &&
          (sessionInspection.publicLanding || sessionInspection.loginFormVisible)) {
        // The visible login page is positive evidence of sign-out. Keep the
        // encrypted snapshot for recovery, but stop replaying it automatically.
        writeSellerHubProfileState(profileDir, 'signed_out');
      }
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
      const resumedPage = resumed && typeof resumed === 'object'
        ? (typeof resumed.goto === 'function' ? resumed : resumed.page)
        : null;
      if (resumedPage && resumedPage !== currentPage) attachPage(resumedPage);
      const refreshedCookies = readCookieSnapshot(cookiesPath) || readCookieSnapshot(fallbackCookiesPath);
      if (refreshedCookies?.length) await page.setCookie(...refreshedCookies);
      await safeGoto(FLIPKART_DASHBOARD_URL, { waitUntil: 'load', timeout: 35000 });
      ({ authenticated, inspection: sessionInspection } = await waitForSellerHubDashboard(page, delay));
      if (!authenticated) throw new Error('Seller Hub sign-in did not establish an authenticated dashboard session. Nothing was staged.');
      if (!runtime?.partition && profileDir) writeSellerHubProfileState(profileDir, 'authenticated');
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
        data.push(parsePortalRateSnapshot(snapshot, { vertical, portalVertical: vertical, marketplace: queryMarketplace, fulfilment: mode, effectiveDate, brand, fsn, sku: target.sample_sku, orderCount: target.order_count,
          sellerAccount: config.seller_account || config.sellerAccount || 'default' }));
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
