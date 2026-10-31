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
import { FLIPKART_MANUAL_LOGIN_URL, isFlipkartAuthenticated } from '../../desktop/portalSession.js';

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

let verificationTimer = null;
try {
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  await page.bringToFront();
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.goto(FLIPKART_MANUAL_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Seller Hub opened at https://seller.flipkart.com/. Click Login and sign in manually.');
  console.log('The desktop app reuses this persistent Chrome profile until Seller Hub signs out.');

  let authenticatedReported = false;
  let verifying = false;
  const verifySession = async () => {
    if (verifying) return;
    verifying = true;
    try {
      if (!authenticatedReported && await page.evaluate(isFlipkartAuthenticated)) {
        authenticatedReported = true;
        console.log('Seller Hub dashboard authentication verified; the persistent profile is ready for the desktop worker.');
      }
    } catch {} finally { verifying = false; }
  };
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    const url = new URL(page.url());
    console.log(`Seller Hub navigation: ${url.hostname}${url.pathname}`);
  });
  await verifySession();
  verificationTimer = setInterval(verifySession, 1000);
  await new Promise(resolve => browser.once('disconnected', resolve));
} finally {
  if (verificationTimer) clearInterval(verificationTimer);
  await browser.close().catch(() => {});
}
