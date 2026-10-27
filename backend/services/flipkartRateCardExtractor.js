/**
 * Flipkart Rate Card Extractor Service
 * 
 * Automates rate card extraction for Flipkart & Shopsy seller hub.
 * Reuses saved cookies from .runtime/cookies.json or performs 2-step login.
 * Extracts: Commission, Fixed Fee, Collection Fee, Reverse Shipping Slabs.
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { getPool } from '../db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

puppeteer.use(StealthPlugin());

const COOKIES_PATH = path.join(__dirname, '../../.runtime/cookies.json');
const CAPTURES_DIR = path.join(__dirname, '../../.runtime/ratecard_captures');

// Chrome executable discovery
export function getChromeExecutablePath() {
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  return possiblePaths.find(p => {
    try {
      import('fs').then(fsSync => fsSync.existsSync(p));
      return true;
    } catch {
      return false;
    }
  }) || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

export async function saveCookies(page) {
  const cookies = await page.cookies();
  await fs.mkdir(path.dirname(COOKIES_PATH), { recursive: true });
  await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

export async function loadCookies(page) {
  try {
    const raw = await fs.readFile(COOKIES_PATH, 'utf8');
    const cookies = JSON.parse(raw);
    await page.setCookie(...cookies);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses raw HTML table structures from Flipkart Seller Hub Rate Card page
 */
export function parseRateCardTables(tables, vertical, effectiveDate) {
  const parsed = {
    vertical,
    effectiveDate,
    commissions: [],
    fixedFees: [],
    collectionFees: [],
    reverseShipping: []
  };

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

  for (const table of tables) {
    if (!table || table.length === 0) continue;
    const headerRow = table[0].join(' ').toLowerCase();

    // 1. Commission Table
    if (headerRow.includes('order item value') && headerRow.includes('fee charged')) {
      const hasPercent = table.some(row => row.some(cell => cell.includes('%')));
      if (hasPercent) {
        for (let r = 1; r < table.length; r++) {
          const row = table[r];
          if (row.length >= 2) {
            const range = parsePriceRange(row[0]);
            const rate = parseAmount(row[1]) / 100;
            parsed.commissions.push({
              price_min: range.min,
              price_max: range.max,
              rate
            });
          }
        }
      } else {
        // 2. Fixed Fee Table
        const tiers = ['Bronze', 'Silver', 'Gold', 'Diamond'];
        for (let r = 1; r < table.length; r++) {
          const row = table[r];
          if (row.length >= 2) {
            const range = parsePriceRange(row[0]);
            const fee = parseAmount(row[1]);
            for (const tier of tiers) {
              parsed.fixedFees.push({
                fulfilment_type: tier,
                price_min: range.min,
                price_max: range.max,
                rate: fee
              });
            }
          }
        }
      }
    }

    // 3. Collection Fee Table
    if (headerRow.includes('prepaid') && headerRow.includes('postpaid')) {
      for (let r = 1; r < table.length; r++) {
        const row = table[r];
        if (row.length >= 3) {
          const range = parsePriceRange(row[0]);
          const prepaid = parseAmount(row[1]);
          const postpaid = parseAmount(row[2]);
          const isPercent = row[1].includes('%') || row[2].includes('%');
          parsed.collectionFees.push({
            price_min: range.min,
            price_max: range.max,
            prepaid,
            postpaid,
            prepaid_type: isPercent ? 'percentage' : 'flat',
            postpaid_type: isPercent ? 'percentage' : 'flat',
            fulfilment_type: 'All'
          });
        }
      }
    }

    // 4. Reverse Shipping Table
    if (headerRow.includes('weight') && (headerRow.includes('local') || headerRow.includes('base rates'))) {
      let currentWeightSlab = '0kg-0.5kg';
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

          parsed.reverseShipping.push({
            weight_slab: currentWeightSlab,
            price_min: range.min,
            price_max: range.max,
            local_fee: localFee,
            zonal_fee: zonalFee,
            national_fee: nationalFee
          });
        }
      }
    }
  }

  return parsed;
}

/**
 * Get distinct Flipkart verticals present in the orders table
 */
export async function getFlipkartVerticals() {
  const pool = getPool();
  try {
    const res = await pool.query(`
      SELECT DISTINCT category 
      FROM orders 
      WHERE marketplace ILIKE '%flipkart%' 
        AND category IS NOT NULL 
        AND category != ''
      ORDER BY category
    `);
    const categories = res.rows.map(r => r.category);
    return categories.length > 0 ? categories : ['ethnic_set', 'kurta', 'sari', 'top', 'dress', 'dupatta', 'fabric'];
  } catch {
    return ['ethnic_set', 'kurta', 'sari', 'top', 'dress', 'dupatta', 'fabric'];
  }
}

/**
 * Main Scraper Worker Function
 */
export async function scrapeFlipkartRateCards(options = {}) {
  const {
    email = process.env.FLIPKART_EMAIL || 'Vbexports@outlook.com',
    password = process.env.FK_PASSWORD,
    headless = 'new',
    verticals = null,
    onProgress = null
  } = options;

  const log = (msg) => {
    console.log(`[FlipkartRateCard] ${msg}`);
    if (typeof onProgress === 'function') onProgress(msg);
  };

  await fs.mkdir(CAPTURES_DIR, { recursive: true });

  log('Launching browser with stealth capabilities...');
  const browser = await puppeteer.launch({
    executablePath: getChromeExecutablePath(),
    headless: headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1500,1000']
  });

  const allScrapedData = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1000 });

    log('Checking for active session cookies...');
    await loadCookies(page);

    await page.goto('https://seller.flipkart.com/index.html#dashboard/home-page', {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    const isLoggedIn = await page.evaluate(() => {
      return document.body.innerText.includes('EthnicJunction') || 
             document.body.innerText.includes('Seller Dashboard') ||
             document.body.innerText.includes('Logout');
    });

    if (!isLoggedIn) {
      log('No active session. Executing 2-step Flipkart login...');
      await page.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2', timeout: 45000 });
      
      // Click Login button
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const l = btns.find(b => b.innerText && b.innerText.trim() === 'Login');
        if (l) l.click();
      });

      await page.waitForSelector('input[name="username"]', { visible: true, timeout: 15000 });
      await page.type('input[name="username"]', email, { delay: 40 });

      // Click Next
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const next = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === 'next');
        if (next) next.click();
      });

      // Wait for password field
      await page.waitForSelector('input[name="password"], input[type="password"]', { visible: true, timeout: 15000 });
      await page.type('input[name="password"], input[type="password"]', password, { delay: 40 });

      // Click Login
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const login = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === 'login');
        if (login) login.click();
      });

      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null);
      await new Promise(r => setTimeout(r, 4000));
      await saveCookies(page);
      log('Authentication successful. Session cookies saved.');
    } else {
      log('Authenticated via active session cookies.');
      await saveCookies(page);
    }

    // Determine target verticals
    const targetVerticals = verticals || await getFlipkartVerticals();
    log(`Starting extraction for ${targetVerticals.length} verticals: ${targetVerticals.join(', ')}`);

    const effectiveDate = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < targetVerticals.length; i++) {
      const vert = targetVerticals[i];
      log(`[${i + 1}/${targetVerticals.length}] Extracting rate card for vertical: "${vert}"...`);

      // We extract both Seller Fulfillment (non-fbf) and Flipkart Fulfillment (fbf)
      for (const fulfillment of ['non-fbf', 'fbf']) {
        const queryObj = {
          marketplace: 'flipkart',
          fulfillment: fulfillment,
          date: `${effectiveDate} 12:00:00`,
          vertical: vert
        };

        const targetUrl = `https://seller.flipkart.com/index.html#dashboard/payments/rate-card?query=${encodeURIComponent(JSON.stringify(queryObj))}`;
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });
        await new Promise(r => setTimeout(r, 4500));

        const docData = await page.evaluate(() => {
          const tables = Array.from(document.querySelectorAll('table')).map(t => 
            Array.from(t.querySelectorAll('tr')).map(r => 
              Array.from(r.querySelectorAll('th, td')).map(c => c.innerText.trim())
            )
          );
          return { tables, rawText: document.body.innerText };
        });

        if (docData.tables.length > 2) {
          const parsed = parseRateCardTables(docData.tables, vert, effectiveDate);
          parsed.fulfilment_type = fulfillment === 'fbf' ? 'FBF' : 'NON_FBF';
          allScrapedData.push(parsed);
          log(`  Extracted: ${parsed.commissions.length} comm, ${parsed.fixedFees.length} fixed, ${parsed.reverseShipping.length} rev shipping slabs (${fulfillment})`);
        } else {
          log(`  Warning: No rate tables returned for ${vert} (${fulfillment})`);
        }
      }
    }

    // Save full staging capture to disk
    const captureFile = path.join(CAPTURES_DIR, `flipkart_ratecards_${Date.now()}.json`);
    await fs.writeFile(captureFile, JSON.stringify(allScrapedData, null, 2));
    log(`Saved complete staging rate cards to ${captureFile}`);

    return {
      success: true,
      count: allScrapedData.length,
      data: allScrapedData,
      captureFile
    };

  } catch (error) {
    log(`Extraction failed: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  } finally {
    await browser.close();
    log('Browser closed cleanly.');
  }
}
