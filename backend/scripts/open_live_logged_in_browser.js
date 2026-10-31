/**
 * Open the same persistent Seller Hub profile used by the desktop app.
 * Sign-in stays manual. This helper never reads credentials, replays cookie
 * files, navigates to a deep link, or reports success without a verified UI.
 */
import puppeteer from 'puppeteer-extra';
import fs from 'node:fs';
import path from 'node:path';
import { getFlipkartBrowserProfileDir } from '../services/flipkartBrowserProfile.js';
import { getChromeExecutablePath } from '../services/flipkartRateCardExtractor.js';
import { FLIPKART_MANUAL_LOGIN_URL } from '../../desktop/portalSession.js';
import { waitForFlipkartAuthenticatedPage } from '../../desktop/portalLoginWaiter.js';

const profileDir = getFlipkartBrowserProfileDir();
fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(path.dirname(profileDir), 0o700); } catch {}
try { fs.chmodSync(profileDir, 0o700); } catch {}

const browser = await puppeteer.launch({
  executablePath: getChromeExecutablePath(),
  headless: false,
  userDataDir: profileDir,
  defaultViewport: null,
  args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox', '--restore-last-session']
});

const loginMonitorAbort = new AbortController();
let loginMonitor = null;
try {
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  await page.bringToFront();
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.goto(FLIPKART_MANUAL_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Seller Hub opened at https://seller.flipkart.com/. Click Login and sign in manually.');
  console.log('The desktop app reuses this persistent Chrome profile until Seller Hub signs out.');

  const observePage = candidate => {
    candidate.on('framenavigated', frame => {
      if (frame !== candidate.mainFrame()) return;
      try {
        const url = new URL(candidate.url());
        console.log(`Seller Hub navigation: ${url.hostname}${url.pathname}`);
      } catch {}
    });
  };
  observePage(page);
  loginMonitor = waitForFlipkartAuthenticatedPage(browser, {
    initialPage: page,
    pollMs: 1000,
    signal: loginMonitorAbort.signal,
    onPage: observePage
  }).then(authenticatedPage => {
    if (!loginMonitorAbort.signal.aborted) {
      console.log(`Seller Hub dashboard authentication verified in ${new URL(authenticatedPage.url()).hostname}; the persistent profile is ready for the desktop worker.`);
    }
  }).catch(error => {
    if (!loginMonitorAbort.signal.aborted) {
      console.error(`Seller Hub authentication could not be verified: ${error.message}`);
    }
  });
  await new Promise(resolve => browser.once('disconnected', resolve));
} finally {
  loginMonitorAbort.abort();
  await loginMonitor?.catch(() => {});
  await browser.close().catch(() => {});
}
