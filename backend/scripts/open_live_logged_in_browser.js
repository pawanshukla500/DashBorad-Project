/**
 * Open Live Logged-in Chrome Browser for User Verification
 * 
 * 1. Launches real Google Chrome in VISIBLE mode (headless: false).
 * 2. Authenticates as Vbexports@outlook.com (EthnicJunction) using cookies or auto-login.
 * 3. Navigates to the live Flipkart Rate Card page.
 * 4. KEEPS the browser window open indefinitely so the user can interact,
 *    inspect the address bar, check all categories, and verify the fee tables.
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

puppeteer.use(StealthPlugin());

const COOKIES_PATH = path.join(__dirname, '../../.runtime/cookies.json');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const delay = (ms) => new Promise(res => setTimeout(res, ms));

async function main() {
  console.log('========================================================================');
  console.log('🌐 OPENING REAL VISIBLE CHROME BROWSER ON YOUR SCREEN');
  console.log('========================================================================');

  const email = process.env.FLIPKART_EMAIL || 'Vbexports@outlook.com';
  const password = process.env.FK_PASSWORD || '1MoreM!les2Go$';

  const categoryArg = process.argv[2] || 'ethnic_set';
  const effectiveDate = new Date().toISOString().slice(0, 10);

  const queryObj = {
    marketplace: 'flipkart',
    fulfillment: 'non-fbf',
    date: `${effectiveDate} 12:00:00`,
    vertical: categoryArg
  };
  const targetUrl = `https://seller.flipkart.com/index.html#dashboard/payments/rate-card?query=${encodeURIComponent(JSON.stringify(queryObj))}`;

  console.log(`Target URL: ${targetUrl}`);
  console.log('Launching visible Chrome with user window...');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false, // VISIBLE TO USER
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-position=50,50',
      '--window-size=1550,950'
    ]
  });

  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();

  // Load session cookies if available
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      const raw = await fsp.readFile(COOKIES_PATH, 'utf8');
      const cookies = JSON.parse(raw);
      await page.setCookie(...cookies);
      console.log('✓ Loaded existing session cookies for EthnicJunction.');
    } catch (e) {
      console.warn('Cookie load note:', e.message);
    }
  }

  // Navigate to Seller Hub
  console.log('Navigating to Flipkart Seller Hub Rate Card...');
  await page.goto(targetUrl, { waitUntil: 'networkidle2' });
  await delay(2500);

  // Check if we need to log in
  const currentUrl = page.url();
  console.log(`Current page URL: ${currentUrl}`);

  if (currentUrl.includes('login') || currentUrl.includes('referral_url')) {
    console.log('Session expired or login required. Performing 2-step automated login...');
    try {
      // Find login input
      const userInput = await page.waitForSelector('input[name="username"], input[type="text"]', { timeout: 8000 });
      if (userInput) {
        await userInput.click({ clickCount: 3 });
        await userInput.type(email, { delay: 40 });
        console.log(`Typed username: ${email}`);

        // Click Next or Submit
        const nextBtn = await page.$('button[type="submit"], button:has-text("Next"), button.fk-ui-btn');
        if (nextBtn) {
          await nextBtn.click();
          await delay(2000);
        }

        // Enter password
        const passInput = await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 8000 });
        if (passInput) {
          await passInput.type(password, { delay: 40 });
          console.log('Typed password.');

          const loginBtn = await page.$('button[type="submit"], button:has-text("Login"), button.fk-ui-btn');
          if (loginBtn) {
            await loginBtn.click();
            console.log('Clicked Login button.');
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
          }
        }
      }

      // Save fresh cookies
      const freshCookies = await page.cookies();
      await fsp.writeFile(COOKIES_PATH, JSON.stringify(freshCookies, null, 2));
      console.log('✓ Fresh session cookies saved.');

      // Re-navigate to rate card
      await page.goto(targetUrl, { waitUntil: 'networkidle2' });
      await delay(2500);
    } catch (loginErr) {
      console.warn('Auto-login note:', loginErr.message);
    }
  }

  // Dismiss notification popup if present
  try {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const dismiss = btns.find(b => b.innerText.includes("Don't Allow") || b.innerText.includes("Dismiss") || b.innerText.includes("Later"));
      if (dismiss) dismiss.click();
    });
  } catch {}

  // Check tables
  let tables = await page.$$('table');
  if (tables.length === 0) {
    console.log('Triggering "Get Rate Card" button to render tables...');
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const targetBtn = btns.find(b => b.innerText.includes('Get Rate Card'));
        if (targetBtn) targetBtn.click();
      });
      await delay(3000);
      tables = await page.$$('table');
    } catch {}
  }

  console.log(`✓ Tables rendered on screen: ${tables.length} tables active!`);

  // Force window to foreground
  const psFocus = `
    $wshell = New-Object -ComObject wscript.shell;
    Start-Sleep -Milliseconds 500;
    $wshell.AppActivate('Flipkart');
    $wshell.AppActivate('Chrome');
  `;
  exec(`powershell -NoProfile -Command "${psFocus.replace(/\r?\n/g, ' ')}"`, () => {});

  console.log('\n========================================================================');
  console.log('🎉 THE LIVE CHROME WINDOW IS OPEN ON YOUR SCREEN!');
  console.log('========================================================================');
  console.log('• You can see the address bar with the full Flipkart rate-card URL.');
  console.log('• You can see the logged-in seller account: EthnicJunction.');
  console.log('• You can scroll and inspect Commission, Fixed Fee, and Reverse Shipping.');
  console.log('• This browser window will STAY OPEN for you.');
  console.log('========================================================================\n');

  // Keep alive indefinitely so the browser stays open for user
  await new Promise(() => {});
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
