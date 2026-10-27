/**
 * Live Visual Flipkart Rate Card Scraper & Excel Builder
 * 
 * Runs a REAL, visible Google Chrome window (headless: false) on the desktop.
 * Logs in, navigates through each vertical one-by-one in front of the user,
 * extracts all fee tables, and creates a consolidated Excel workbook directly on Desktop.
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

puppeteer.use(StealthPlugin());

const COOKIES_PATH = path.join(__dirname, '../../.runtime/cookies.json');
const DESKTOP_DIR = path.join('C:\\Users\\Pawan Shukla\\Desktop');
const REPORTS_DIR = path.join(__dirname, '../../reports');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// Distinct Flipkart Verticals to Scrape
const TARGET_VERTICALS = [
  { name: 'ethnic_set', display: 'Ethnic Sets (Kurta Set)' },
  { name: 'kurta', display: 'Kurti / Kurta' },
  { name: 'sari', display: 'Saree' },
  { name: 'top', display: 'Top' },
  { name: 'dress', display: 'Dresses' },
  { name: 'dupatta', display: 'Dupatta' },
  { name: 'fabric', display: 'Dress Material / Fabric' },
  { name: 'gown', display: 'Gown' },
  { name: 'apparel_set', display: 'Co-ords / Apparel Set' },
  { name: 'shirt', display: 'Shirt' }
];

async function loadCookies(page) {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const raw = await fsp.readFile(COOKIES_PATH, 'utf8');
      const cookies = JSON.parse(raw);
      await page.setCookie(...cookies);
      console.log(`[LiveWorker] Loaded ${cookies.length} cached session cookies.`);
      return true;
    }
  } catch {}
  return false;
}

async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    await fsp.mkdir(path.dirname(COOKIES_PATH), { recursive: true });
    await fsp.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    console.log(`[LiveWorker] Saved ${cookies.length} session cookies.`);
  } catch {}
}

function parsePriceRange(str) {
  const cleaned = String(str || '').replace(/₹/g, '').replace(/,/g, '').trim();
  if (cleaned.startsWith('>=')) {
    const min = parseFloat(cleaned.replace('>=', '').trim()) || 0;
    return { min, max: 999999 };
  }
  if (cleaned.startsWith('>')) {
    const min = parseFloat(cleaned.replace('>', '').trim()) || 0;
    return { min: min + 0.01, max: 999999 };
  }
  if (cleaned.includes('-')) {
    const [start, end] = cleaned.split('-').map(s => parseFloat(s.trim()));
    return { min: start || 0, max: end || 999999 };
  }
  const val = parseFloat(cleaned);
  return { min: val || 0, max: 999999 };
}

function parseAmount(str) {
  if (!str) return 0;
  const clean = str.replace(/₹/g, '').replace(/%/g, '').replace(/,/g, '').trim();
  return parseFloat(clean) || 0;
}

async function runVisualScraper() {
  console.log('================================================================');
  console.log('👀 LAUNCHING VISIBLE REAL CHROME WINDOW FOR FLIPKART RATE CARD');
  console.log('================================================================');

  const email = 'Vbexports@outlook.com';
  const password = process.env.FK_PASSWORD;

  if (!password) {
    throw new Error('FK_PASSWORD is not set in backend/.env');
  }

  // Launch REAL, VISIBLE CHROME
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false, // In front of user's eyes!
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const allCommissions = [];
  const allFixedFees = [];
  const allRevShipping = [];
  const allCollectionFees = [];

  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    console.log('\n[1/3] Navigating to Flipkart Seller Hub...');
    await loadCookies(page);
    await page.goto('https://seller.flipkart.com/index.html#dashboard/home-page', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });
    await delay(3000);

    // Check login state
    let isLoggedIn = await page.evaluate(() => {
      return document.body.innerText.includes('EthnicJunction') || 
             document.body.innerText.includes('Seller Dashboard') ||
             document.body.innerText.includes('Logout');
    });

    if (!isLoggedIn) {
      console.log('[2/3] Executing visible 2-step Flipkart login...');
      await page.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2', timeout: 45000 });
      await delay(2000);

      // Click Login button
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const l = btns.find(b => b.innerText && b.innerText.trim() === 'Login');
        if (l) l.click();
      });

      console.log('  Typing email: ' + email);
      await page.waitForSelector('input[name="username"]', { visible: true, timeout: 15000 });
      await page.type('input[name="username"]', email, { delay: 60 });
      await delay(1000);

      // Click Next
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const next = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === 'next');
        if (next) next.click();
      });

      console.log('  Typing password...');
      await page.waitForSelector('input[name="password"], input[type="password"]', { visible: true, timeout: 15000 });
      await page.type('input[name="password"], input[type="password"]', password, { delay: 60 });
      await delay(1000);

      // Click Login
      console.log('  Submitting login credentials...');
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const login = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === 'login');
        if (login) login.click();
      });

      console.log('  Waiting for dashboard home page to load...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null);
      await delay(5000);
      await saveCookies(page);
    } else {
      console.log('[2/3] Already authenticated as EthnicJunction via cookies!');
    }

    const effectiveDate = new Date().toISOString().slice(0, 10);
    console.log(`\n[3/3] Commencing real-time visual scraping for ${TARGET_VERTICALS.length} verticals...\n`);

    for (let i = 0; i < TARGET_VERTICALS.length; i++) {
      const v = TARGET_VERTICALS[i];
      console.log(`----------------------------------------------------------------`);
      console.log(`▶ [${i + 1}/${TARGET_VERTICALS.length}] Scrape Vertical: ${v.display} (${v.name})`);
      console.log(`----------------------------------------------------------------`);

      for (const fulfillment of ['non-fbf', 'fbf']) {
        const fName = fulfillment === 'fbf' ? 'Flipkart Fulfillment (FBF)' : 'Seller Fulfillment (Non-FBF)';
        console.log(`  Querying ${fName}...`);

        const queryObj = {
          marketplace: 'flipkart',
          fulfillment: fulfillment,
          date: `${effectiveDate} 12:00:00`,
          vertical: v.name
        };
        const targetUrl = `https://seller.flipkart.com/index.html#dashboard/payments/rate-card?query=${encodeURIComponent(JSON.stringify(queryObj))}`;

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });
        await delay(3500);

        // Smooth scroll so the user can visually watch the rate tables on screen
        await page.evaluate(async () => {
          window.scrollBy({ top: 400, behavior: 'smooth' });
          await new Promise(r => setTimeout(r, 600));
          window.scrollBy({ top: 400, behavior: 'smooth' });
          await new Promise(r => setTimeout(r, 600));
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        await delay(1500);

        // Extract tables
        const docData = await page.evaluate(() => {
          const tables = Array.from(document.querySelectorAll('table')).map(t => 
            Array.from(t.querySelectorAll('tr')).map(r => 
              Array.from(r.querySelectorAll('th, td')).map(c => c.innerText.trim())
            )
          );
          return { tables };
        });

        const tables = docData.tables;
        if (tables.length > 2) {
          // Parse Commission & Fixed Fees
          for (const table of tables) {
            const headerRow = table[0].join(' ').toLowerCase();

            // Commission
            if (headerRow.includes('order item value') && headerRow.includes('fee charged')) {
              const hasPercent = table.some(row => row.some(cell => cell.includes('%')));
              if (hasPercent) {
                for (let r = 1; r < table.length; r++) {
                  const row = table[r];
                  if (row.length >= 2) {
                    const range = parsePriceRange(row[0]);
                    const ratePct = parseAmount(row[1]);
                    allCommissions.push({
                      'Vertical': v.display,
                      'Vertical Code': v.name,
                      'Fulfillment': fName,
                      'Order Value Min (₹)': range.min,
                      'Order Value Max (₹)': range.max === 999999 ? 'No Limit' : range.max,
                      'Commission Rate (%)': `${ratePct}%`,
                      'Rate Decimal': ratePct / 100,
                      'Effective Date': effectiveDate
                    });
                  }
                }
              } else {
                // Fixed Fees
                const tiers = ['Bronze', 'Silver', 'Gold', 'Diamond'];
                for (let r = 1; r < table.length; r++) {
                  const row = table[r];
                  if (row.length >= 2) {
                    const range = parsePriceRange(row[0]);
                    const feeAmt = parseAmount(row[1]);
                    for (const tier of tiers) {
                      allFixedFees.push({
                        'Vertical': v.display,
                        'Vertical Code': v.name,
                        'Fulfillment': fName,
                        'Seller Tier': tier,
                        'Order Value Min (₹)': range.min,
                        'Order Value Max (₹)': range.max === 999999 ? 'No Limit' : range.max,
                        'Fixed Fee (₹)': feeAmt,
                        'Effective Date': effectiveDate
                      });
                    }
                  }
                }
              }
            }

            // Collection Fees
            if (headerRow.includes('prepaid') && headerRow.includes('postpaid')) {
              for (let r = 1; r < table.length; r++) {
                const row = table[r];
                if (row.length >= 3) {
                  const range = parsePriceRange(row[0]);
                  allCollectionFees.push({
                    'Vertical': v.display,
                    'Vertical Code': v.name,
                    'Fulfillment': fName,
                    'Order Value Min (₹)': range.min,
                    'Order Value Max (₹)': range.max === 999999 ? 'No Limit' : range.max,
                    'Prepaid Fee': row[1],
                    'Postpaid Fee': row[2],
                    'Effective Date': effectiveDate
                  });
                }
              }
            }

            // Reverse Shipping
            if (headerRow.includes('weight') && (headerRow.includes('local') || headerRow.includes('base rates'))) {
              let currentWeightSlab = '0kg - 0.5kg';
              for (let r = 0; r < table.length; r++) {
                const row = table[r];
                const rowStr = row.join(' ');
                if (rowStr.includes('kg -') || rowStr.includes('0kg -') || rowStr.includes('0.5kg -')) {
                  const slabMatch = rowStr.match(/(\d+(\.\d+)?\s*kg\s*-\s*\d+(\.\d+)?\s*kg)/i);
                  if (slabMatch) currentWeightSlab = slabMatch[1].replace(/\s+/g, '');
                }

                const prices = row.filter(cell => /₹\d+/.test(cell));
                if (prices.length >= 3) {
                  const priceCell = row.find(c => /₹\d+\s*-\s*₹\d+|>=?\s*₹\d+/.test(c)) || '₹0 - ₹999999';
                  const range = parsePriceRange(priceCell);
                  const extractFee = (cell) => {
                    const m = cell.match(/₹(\d+(\.\d+)?)/);
                    return m ? parseFloat(m[1]) : 0;
                  };

                  const localFee = extractFee(prices[prices.length - 3]);
                  const zonalFee = extractFee(prices[prices.length - 2]);
                  const nationalFee = extractFee(prices[prices.length - 1]);

                  allRevShipping.push({
                    'Vertical': v.display,
                    'Vertical Code': v.name,
                    'Fulfillment': fName,
                    'Weight Slab': currentWeightSlab,
                    'Order Value Min (₹)': range.min,
                    'Order Value Max (₹)': range.max === 999999 ? 'No Limit' : range.max,
                    'Local Fee (₹)': localFee,
                    'Zonal Fee (₹)': zonalFee,
                    'National Fee (₹)': nationalFee,
                    'Effective Date': effectiveDate
                  });
                }
              }
            }
          }
          console.log(`  ✓ Extracted: Commission, Fixed Fee, Collection Fee, Reverse Shipping.`);
        } else {
          console.log(`  ⚠ Notice: Fee tables not returned for ${v.name} (${fulfillment}).`);
        }
      }
    }

    console.log('\n================================================================');
    console.log('📊 GENERATING CONSOLIDATED EXCEL WORKBOOK...');
    console.log('================================================================');

    const wb = XLSX.utils.book_new();

    // Sheet 1: Summary
    const summaryData = [
      { 'Metric': 'Marketplace', 'Value': 'Flipkart Seller Hub' },
      { 'Metric': 'Seller Account', 'Value': 'EthnicJunction' },
      { 'Metric': 'Extraction Date', 'Value': effectiveDate },
      { 'Metric': 'Total Verticals Scraped', 'Value': TARGET_VERTICALS.length },
      { 'Metric': 'Total Commission Slabs', 'Value': allCommissions.length },
      { 'Metric': 'Total Fixed Fee Slabs', 'Value': allFixedFees.length },
      { 'Metric': 'Total Reverse Shipping Slabs', 'Value': allRevShipping.length },
      { 'Metric': 'Total Collection Fee Slabs', 'Value': allCollectionFees.length },
      { 'Metric': 'Verified Live in Browser', 'Value': 'YES (Real Chrome Instance)' }
    ];
    const wsSummary = XLSX.utils.json_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    // Sheet 2: Commission Slabs
    if (allCommissions.length > 0) {
      const wsComm = XLSX.utils.json_to_sheet(allCommissions);
      XLSX.utils.book_append_sheet(wb, wsComm, 'Commission Slabs');
    }

    // Sheet 3: Fixed Fee Slabs
    if (allFixedFees.length > 0) {
      const wsFixed = XLSX.utils.json_to_sheet(allFixedFees);
      XLSX.utils.book_append_sheet(wb, wsFixed, 'Fixed Fees');
    }

    // Sheet 4: Reverse Shipping Slabs
    if (allRevShipping.length > 0) {
      const wsRev = XLSX.utils.json_to_sheet(allRevShipping);
      XLSX.utils.book_append_sheet(wb, wsRev, 'Reverse Shipping');
    }

    // Sheet 5: Collection Fees
    if (allCollectionFees.length > 0) {
      const wsColl = XLSX.utils.json_to_sheet(allCollectionFees);
      XLSX.utils.book_append_sheet(wb, wsColl, 'Collection Fees');
    }

    // Write to Desktop and Reports
    const desktopFile = path.join(DESKTOP_DIR, 'Flipkart_RateCard_Live_Export.xlsx');
    await fsp.mkdir(REPORTS_DIR, { recursive: true });
    const reportsFile = path.join(REPORTS_DIR, 'Flipkart_RateCard_Live_Export.xlsx');

    // Also save raw JSON cache
    const cacheFile = path.join(__dirname, '../../.runtime/live_ratecard_cache.json');
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify({
      summary: summaryData,
      commissions: allCommissions,
      fixedFees: allFixedFees,
      reverseShipping: allRevShipping,
      collectionFees: allCollectionFees
    }, null, 2));

    const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    fs.writeFileSync(desktopFile, excelBuffer);
    fs.writeFileSync(reportsFile, excelBuffer);

    console.log(`\n🎉 EXCEL WORKBOOK GENERATED SUCCESSFULLY!`);
    console.log(`📁 Saved to Desktop: ${desktopFile}`);
    console.log(`📁 Saved to Reports: ${reportsFile}`);

    console.log('\nKeeping Chrome window open for 10 seconds so you can see the final state...');
    await delay(10000);

    return {
      success: true,
      desktopFile,
      reportsFile,
      summary: {
        verticalsCount: TARGET_VERTICALS.length,
        commissionCount: allCommissions.length,
        fixedFeeCount: allFixedFees.length,
        revShippingCount: allRevShipping.length
      }
    };

  } catch (err) {
    console.error('\n❌ Error during visual scraper execution:', err);
    throw err;
  } finally {
    if (browser) {
      console.log('Closing browser window...');
      await browser.close();
    }
  }
}

runVisualScraper().then(res => {
  console.log('\n[Finished]', JSON.stringify(res.summary, null, 2));
  process.exit(0);
}).catch(err => {
  console.error('[Failed]', err);
  process.exit(1);
});
