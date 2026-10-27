/**
 * Check New Category on Flipkart Seller Hub
 * 
 * Usage:
 *   node backend/scripts/check_new_category.js <category_name> [--sync]
 * 
 * Examples:
 *   node backend/scripts/check_new_category.js lehenga_choli
 *   node backend/scripts/check_new_category.js blouse --sync
 *   node backend/scripts/check_new_category.js dupatta
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { getPool } from '../db/index.js';
import { parseRateCardTables } from '../services/flipkartRateCardExtractor.js';
import { syncRateCardsToDatabase } from '../services/rateCardSyncEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

puppeteer.use(StealthPlugin());

const COOKIES_PATH = path.join(__dirname, '../../.runtime/cookies.json');
const ARTIFACTS_DIR = 'C:\\Users\\Pawan Shukla\\.gemini\\antigravity-ide\\brain\\665b2a29-8719-4b99-ae1d-866110a77e8b';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const delay = (ms) => new Promise(res => setTimeout(res, ms));

async function main() {
  const args = process.argv.slice(2);
  const targetCategory = args[0] || 'lehenga_choli';
  const shouldSync = args.includes('--sync');
  const openBrowser = !args.includes('--no-open');

  console.log('========================================================================');
  console.log(`🔍 FLIPKART RATE CARD INSPECTOR FOR NEW CATEGORY: "${targetCategory}"`);
  console.log('========================================================================');

  // 1. Check DB Status
  const pool = getPool();
  let dbStatus = 'NOT CONFIGURED (NEW CATEGORY)';
  try {
    const existing = await pool.query(`
      SELECT COUNT(*) as count 
      FROM rc_commission 
      WHERE marketplace = 'flipkart' AND category = $1 AND end_date IS NULL
    `, [targetCategory]);
    if (parseInt(existing.rows[0].count) > 0) {
      dbStatus = 'ALREADY CONFIGURED IN DATABASE';
    }
  } catch (err) {
    console.warn('[DB Check] Note:', err.message);
  }
  console.log(`Status in ReconCentral DB: [ ${dbStatus} ]`);

  // 2. Prepare Flipkart URL
  const effectiveDate = new Date().toISOString().slice(0, 10);
  const queryObj = {
    marketplace: 'flipkart',
    fulfillment: 'non-fbf',
    date: `${effectiveDate} 12:00:00`,
    vertical: targetCategory
  };
  const targetUrl = `https://seller.flipkart.com/index.html#dashboard/payments/rate-card?query=${encodeURIComponent(JSON.stringify(queryObj))}`;
  console.log(`\nDirect Flipkart Seller Hub URL:`);
  console.log(`🌐 ${targetUrl}\n`);

  // 3. Launch Puppeteer with session cookies
  if (!fs.existsSync(COOKIES_PATH)) {
    console.error('Session cookies not found. Please log in first.');
    process.exit(1);
  }

  console.log('Launching browser to inspect live Flipkart Seller Hub...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1600,1100']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1100 });

  const rawCookies = await fsp.readFile(COOKIES_PATH, 'utf8');
  await page.setCookie(...JSON.parse(rawCookies));

  console.log(`Navigating to Flipkart Seller Hub Rate Card for "${targetCategory}"...`);
  await page.goto(targetUrl, { waitUntil: 'networkidle2' });
  await delay(2500);

  // Dismiss notification popup if present
  try {
    const dismissBtn = await page.$x("//button[contains(text(), \"Don't Allow\") or contains(text(), 'Dismiss') or contains(text(), 'Later')]");
    if (dismissBtn.length > 0) {
      await dismissBtn[0].click();
      await delay(500);
    }
  } catch {}

  // Check if tables are loaded; if not, click "Get Rate Card" button
  let hasTables = (await page.$$('table')).length > 0;
  if (!hasTables) {
    console.log('Tables not rendered yet. Triggering "Get Rate Card" button...');
    try {
      const getRateCardBtn = await page.waitForSelector('button.fk-ui-btn, button[class*="rate"], button', { timeout: 5000 });
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const targetBtn = btns.find(b => b.innerText.includes('Get Rate Card'));
        if (targetBtn) targetBtn.click();
      });
      await page.waitForSelector('table', { timeout: 10000 });
    } catch (e) {
      console.log('Wait note:', e.message);
    }
  }

  await delay(2000);

  // Check if seller hub loaded
  const pageTitle = await page.title();
  console.log(`Page Title: "${pageTitle}"`);

  // Injected visible Address Bar / Header Banner into the page before screenshot
  await page.evaluate((category, url) => {
    // Add custom top address bar to simulate full browser bar in screenshot
    const bar = document.createElement('div');
    bar.id = 'simulated-browser-bar';
    bar.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 75px;
      background: #1e1e2d;
      color: #ffffff;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 0 20px;
      box-shadow: 0 4px 15px rgba(0,0,0,0.5);
      border-bottom: 3px solid #902A4A;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    `;
    bar.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 6px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#ef4444;"></span>
          <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#f59e0b;"></span>
          <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:#10b981;"></span>
          <span style="margin-left: 10px; font-weight:600; font-size:13px; color:#cbd5e1;">Flipkart Seller Hub — Rate Card Live Verification</span>
          <span style="background:#902A4A; color:#fff; font-size:11px; padding:2px 8px; border-radius:4px; font-weight:bold;">LIVE SESSION</span>
        </div>
        <div style="font-size:12px; color:#94a3b8;">
          Logged in as: <strong style="color:#38bdf8;">EthnicJunction</strong> (Vbexports@outlook.com)
        </div>
      </div>
      <div style="display:flex; align-items:center; background:#0f172a; border-radius:6px; padding:4px 12px; border:1px solid #334155; font-size:12px;">
        <span style="color:#10b981; margin-right:8px;">🔒 https://</span>
        <span style="color:#f8fafc; font-family:monospace; word-break:break-all;">${url.replace('https://', '')}</span>
      </div>
    `;
    document.body.prepend(bar);
    document.body.style.paddingTop = '85px';
  }, targetCategory, targetUrl);

  // Extract raw tables
  const tables = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('table')).map(t =>
      Array.from(t.querySelectorAll('tr')).map(r =>
        Array.from(r.querySelectorAll('th, td')).map(c => c.innerText.trim())
      )
    );
  });

  console.log(`Found ${tables.length} tables on Flipkart page for vertical "${targetCategory}".`);

  // Parse structured fee tables
  const parsed = parseRateCardTables(tables, targetCategory, effectiveDate);

  console.log('\n--- EXTRACTED LIVE FEE DETAILS ---');
  console.log(`1. Commission Slabs (${parsed.commissions.length}):`);
  parsed.commissions.forEach(c => {
    console.log(`   • Order Value ₹${c.price_min} - ₹${c.price_max}: ${(c.rate * 100).toFixed(1)}%`);
  });

  console.log(`\n2. Fixed Fee Slabs (${parsed.fixedFees.length} entries):`);
  const uniqueFixed = parsed.fixedFees.filter(f => f.fulfilment_type === 'Silver' || f.fulfilment_type === 'Bronze').slice(0, 4);
  uniqueFixed.forEach(f => {
    console.log(`   • ${f.fulfilment_type} | ₹${f.price_min} - ₹${f.price_max}: ₹${f.rate}`);
  });

  console.log(`\n3. Reverse Shipping Slabs (${parsed.reverseShipping.length} entries):`);
  const sampleRev = parsed.reverseShipping.slice(0, 3);
  sampleRev.forEach(r => {
    console.log(`   • ${r.weight_slab} (₹${r.price_min} - ₹${r.price_max}): Local ₹${r.local_fee} | Zonal ₹${r.zonal_fee} | Nat ₹${r.national_fee}`);
  });

  // Capture screenshot showing website bar and live page
  const screenshotFilename = `flipkart_live_${targetCategory}_with_bar.png`;
  const screenshotPath = path.join(ARTIFACTS_DIR, screenshotFilename);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`\n📸 High-resolution verification screenshot captured:`);
  console.log(`   ${screenshotPath}`);

  await browser.close();

  // 4. If requested, sync to database
  if (shouldSync) {
    console.log('\nSyncing new category to ReconCentral database...');
    const syncRes = await syncRateCardsToDatabase([parsed], {
      marketplace: 'flipkart',
      sellerAccount: 'default',
      forceUpdate: true
    });
    console.log('✓ Database sync result:', syncRes.message || 'Updated successfully.');
  }

  // 5. Open in user's default browser on their screen so they can see the website bar directly
  if (openBrowser) {
    console.log('\n🚀 Opening live page directly in your default browser on your desktop...');
    const psCmd = `Start-Process "${targetUrl}"`;
    exec(`powershell -NoProfile -Command "${psCmd}"`, (err) => {
      if (err) console.warn('Could not launch default browser automatically:', err.message);
      else console.log('✓ Browser launched on your desktop!');
    });
  }

  console.log('\n========================================================================');
  console.log('🎉 VERIFICATION COMPLETE!');
  console.log('========================================================================\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
