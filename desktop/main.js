import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs').promises;
const { Pool } = require('pg');

let mainWindow = null;
const USER_DATA_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA_DIR, 'worker-config.json');
const COOKIES_PATH = path.join(USER_DATA_DIR, 'cookies.json');
const STAGING_DIR = path.join(USER_DATA_DIR, 'staging');

// Default Configuration with Flipkart & Shopsy Verticals and Brands
const DEFAULT_CONFIG = {
  marketplace: 'both', // 'flipkart', 'shopsy', or 'both'
  email: 'Vbexports@outlook.com',
  password: '',
  databaseUrl: 'postgresql://pawanshukla:Xchange4SQL%24@200.141.1.119:5433/paymentapp',
  scheduledHour: 6, // 06:00 AM
  scheduledMinute: 0,
  autoSyncToDb: false,
  notificationEmail: 'payments@youthnic.shop',
  selectedBrands: ['Ethnic Junction', 'Youthnic', 'Sangria', 'Divastri', 'General'],
  selectedVerticals: [
    'ethnic_set', 'kurta', 'sari', 'top', 'dress', 'dupatta', 'fabric',
    'blouse', 'lehenga_choli', 'gown', 'shopsy_kurta', 'shopsy_ethnic_set'
  ]
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('Failed to read config:', err);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#0f172a',
    title: 'ReconCentral RateCard Automation & Scraper Worker (Flipkart & Shopsy)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  // Start background scheduler check
  setInterval(checkDailySchedule, 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Daily Scheduler ─────────────────────────────────────────────────────────
let lastRunDate = '';
async function checkDailySchedule() {
  const config = loadConfig();
  const now = new Date();
  const currentDateStr = now.toISOString().slice(0, 10);

  if (lastRunDate !== currentDateStr &&
      now.getHours() === config.scheduledHour &&
      now.getMinutes() === config.scheduledMinute) {
    lastRunDate = currentDateStr;
    console.log(`[Scheduler] Starting scheduled daily rate card scrape for ${currentDateStr}...`);
    
    if (mainWindow) {
      mainWindow.webContents.send('scrape-progress', '⏰ Daily scheduled scrape started automatically.');
    }

    try {
      const result = await executeScrapeProcess(config, (msg) => {
        if (mainWindow) mainWindow.webContents.send('scrape-progress', msg);
      });

      if (config.autoSyncToDb && result.success && result.data?.length > 0) {
        await executeDbSync(result.data, config);
      }

      if (Notification.isSupported()) {
        new Notification({
          title: 'ReconCentral RateCard Scraper',
          body: `Daily scrape completed. ${result.data?.length || 0} verticals processed.`
        }).show();
      }
    } catch (err) {
      console.error('[Scheduler] Error:', err);
    }
  }
}

function getChromeExecutablePath() {
  const isWin = process.platform === 'win32';
  const localAppData = process.env.LOCALAPPDATA || '';

  const winPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];

  const linuxPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ];

  const possiblePaths = isWin ? winPaths : linuxPaths;
  const found = possiblePaths.find(p => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  if (found) return found;
  return isWin ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome';
}

// ── Table Parsing Logic with Shopsy Fee Rules ────────────────────────────────
function parseRateCardTables(tables, vertical, effectiveDate, marketplace = 'flipkart') {
  const isShopsy = marketplace === 'shopsy' || vertical.toLowerCase().startsWith('shopsy_');
  const parsed = {
    marketplace: isShopsy ? 'shopsy' : 'flipkart',
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

  // Shopsy Specific Rules:
  // 1. Commission is 0% across all slabs
  // 2. Fixed closing fee: ₹0 for 0-1500, ₹10 for 1501+
  // 3. Reverse shipping: 0-0.5kg & 0.5-1kg slabs
  if (isShopsy) {
    parsed.commissions.push({
      price_min: 0,
      price_max: 999999,
      rate: 0.0
    });

    const tiers = ['Bronze', 'Silver', 'Gold', 'Diamond'];
    for (const tier of tiers) {
      parsed.fixedFees.push(
        { fulfilment_type: tier, price_min: 0, price_max: 1500, rate: 0 },
        { fulfilment_type: tier, price_min: 1501, price_max: 999999, rate: 10 }
      );
    }

    parsed.reverseShipping.push(
      { weight_slab: '0kg-0.5kg', price_min: 0, price_max: 500, local_fee: 122, zonal_fee: 142, national_fee: 182 },
      { weight_slab: '0kg-0.5kg', price_min: 501, price_max: 1000, local_fee: 147, zonal_fee: 167, national_fee: 207 },
      { weight_slab: '0kg-0.5kg', price_min: 1001, price_max: 999999, local_fee: 157, zonal_fee: 177, national_fee: 217 },
      { weight_slab: '0.5kg-1kg', price_min: 0, price_max: 500, local_fee: 152, zonal_fee: 177, national_fee: 227 },
      { weight_slab: '0.5kg-1kg', price_min: 501, price_max: 1000, local_fee: 177, zonal_fee: 202, national_fee: 252 },
      { weight_slab: '0.5kg-1kg', price_min: 1001, price_max: 999999, local_fee: 187, zonal_fee: 212, national_fee: 262 }
    );

    return parsed;
  }

  // Standard Flipkart parsing
  for (const table of tables) {
    if (!table || table.length === 0) continue;
    const headerRow = table[0].join(' ').toLowerCase();

    // Commission Table
    if (headerRow.includes('order item value') && headerRow.includes('fee charged')) {
      const hasPercent = table.some(row => row.some(cell => cell.includes('%')));
      if (hasPercent) {
        for (let r = 1; r < table.length; r++) {
          const row = table[r];
          if (row.length >= 2) {
            const range = parsePriceRange(row[0]);
            parsed.commissions.push({
              price_min: range.min,
              price_max: range.max,
              rate: parseAmount(row[1]) / 100
            });
          }
        }
      } else {
        // Fixed Fee Table
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

    // Collection Fee Table
    if (headerRow.includes('prepaid') && headerRow.includes('postpaid')) {
      for (let r = 1; r < table.length; r++) {
        const row = table[r];
        if (row.length >= 3) {
          const range = parsePriceRange(row[0]);
          const isPercent = row[1].includes('%') || row[2].includes('%');
          parsed.collectionFees.push({
            price_min: range.min,
            price_max: range.max,
            prepaid: parseAmount(row[1]),
            postpaid: parseAmount(row[2]),
            prepaid_type: isPercent ? 'percentage' : 'flat',
            postpaid_type: isPercent ? 'percentage' : 'flat',
            fulfilment_type: 'All'
          });
        }
      }
    }

    // Reverse Shipping Table
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

          parsed.reverseShipping.push({
            weight_slab: currentWeightSlab,
            price_min: range.min,
            price_max: range.max,
            local_fee: extractFee(prices[prices.length - 3]),
            zonal_fee: extractFee(prices[prices.length - 2]),
            national_fee: extractFee(prices[prices.length - 1])
          });
        }
      }
    }
  }

  return parsed;
}

// ── Interactive Human Login Flow ─────────────────────────────────────────────
async function executeInteractiveLogin(marketplace) {
  let puppeteer, StealthPlugin;
  try {
    puppeteer = require('puppeteer-extra');
    StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  } catch {
    puppeteer = require('../backend/node_modules/puppeteer-extra');
    StealthPlugin = require('../backend/node_modules/puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  }

  const browser = await puppeteer.launch({
    executablePath: getChromeExecutablePath(),
    headless: false, // Visible window for human login / OTP
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox']
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    if (fs.existsSync(COOKIES_PATH)) {
      const raw = fs.readFileSync(COOKIES_PATH, 'utf8');
      await page.setCookie(...JSON.parse(raw));
    }

    console.log('[InteractiveLogin] Opening Flipkart Seller Hub...');
    await page.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2' });

    console.log('[InteractiveLogin] Waiting for seller dashboard navigation or user login...');
    await page.waitForFunction(() => {
      return window.location.href.includes('#dashboard') || 
             document.body.innerText.includes('Seller Dashboard') ||
             document.body.innerText.includes('EthnicJunction') ||
             document.body.innerText.includes('Logout');
    }, { timeout: 300000 }); // 5 minute window for user to log in or enter OTP

    const cookies = await page.cookies();
    fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    console.log(`[InteractiveLogin] Logged in successfully! Saved ${cookies.length} session cookies.`);

    await browser.close();
    return { success: true, cookiesCount: cookies.length };
  } catch (err) {
    if (browser) await browser.close();
    return { success: false, error: err.message };
  }
}

// ── Automated Scraper Process (Supports Visible Chrome Mode) ──────────────────
async function executeScrapeProcess(config, onProgress) {
  let puppeteer, StealthPlugin;
  try {
    puppeteer = require('puppeteer-extra');
    StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  } catch {
    puppeteer = require('../backend/node_modules/puppeteer-extra');
    StealthPlugin = require('../backend/node_modules/puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  }

  const isVisible = Boolean(config.visible);
  onProgress(isVisible 
    ? 'Launching Google Chrome in VISIBLE interactive mode (live tour)...' 
    : 'Launching browser with stealth mode...');

  const browser = await puppeteer.launch({
    executablePath: getChromeExecutablePath(),
    headless: isVisible ? false : 'new',
    defaultViewport: isVisible ? null : { width: 1500, height: 1000 },
    args: isVisible 
      ? ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'] 
      : ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1500,1000']
  });

  const scrapedItems = [];

  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    if (!isVisible) await page.setViewport({ width: 1500, height: 1000 });

    if (fs.existsSync(COOKIES_PATH)) {
      const raw = fs.readFileSync(COOKIES_PATH, 'utf8');
      await page.setCookie(...JSON.parse(raw));
      onProgress('Loaded cached session cookies.');
    }

    onProgress('Verifying Seller Hub login session...');
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
      if (!config.password) {
        throw new Error('Not logged in and no password configured. Please click "Interactive Login" or configure FK_PASSWORD.');
      }
      onProgress('Session expired. Executing automated 2-step login...');
      await page.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2', timeout: 45000 });
      
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const l = btns.find(b => b.innerText && b.innerText.trim() === 'Login');
        if (l) l.click();
      });

      await page.waitForSelector('input[name="username"]', { visible: true, timeout: 15000 });
      await page.type('input[name="username"]', config.email, { delay: 40 });

      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const next = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === 'next');
        if (next) next.click();
      });

      await page.waitForSelector('input[name="password"], input[type="password"]', { visible: true, timeout: 15000 });
      await page.type('input[name="password"], input[type="password"]', config.password, { delay: 40 });

      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const login = btns.find(b => b.innerText && b.innerText.trim().toLowerCase() === 'login');
        if (login) login.click();
      });

      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null);
      await new Promise(r => setTimeout(r, 4000));
      
      const cookies = await page.cookies();
      fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
      onProgress('Login successful. Session cookies saved.');
    } else {
      onProgress('Authentication verified via active cookies.');
    }

    const targetMarketplace = config.marketplace || 'both';
    let verticals = config.selectedVerticals?.length ? config.selectedVerticals : [
      'ethnic_set', 'kurta', 'sari', 'top', 'fabric', 'blouse', 'lehenga_choli', 'gown', 'shopsy_kurta', 'shopsy_ethnic_set'
    ];

    if (targetMarketplace === 'shopsy') {
      verticals = verticals.filter(v => v.startsWith('shopsy_'));
      if (verticals.length === 0) verticals = ['shopsy_kurta', 'shopsy_ethnic_set'];
    } else if (targetMarketplace === 'flipkart') {
      verticals = verticals.filter(v => !v.startsWith('shopsy_'));
    }

    const effectiveDate = new Date().toISOString().slice(0, 10);
    onProgress(`Extracting rate cards across ${verticals.length} verticals (${targetMarketplace.toUpperCase()})...`);

    for (let i = 0; i < verticals.length; i++) {
      const vert = verticals[i];
      const isShopsyVertical = vert.startsWith('shopsy_');
      onProgress(`[${i + 1}/${verticals.length}] Processing vertical: "${vert}" (${isShopsyVertical ? 'SHOPSY' : 'FLIPKART'})...`);

      for (const fulfillment of ['non-fbf', 'fbf']) {
        const queryObj = {
          marketplace: isShopsyVertical ? 'shopsy' : 'flipkart',
          fulfillment: fulfillment,
          date: `${effectiveDate} 12:00:00`,
          vertical: vert
        };
        const targetUrl = `https://seller.flipkart.com/index.html#dashboard/payments/rate-card?query=${encodeURIComponent(JSON.stringify(queryObj))}`;
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });
        await new Promise(r => setTimeout(r, isVisible ? 3000 : 2000));

        const docData = await page.evaluate(() => {
          const tables = Array.from(document.querySelectorAll('table')).map(t => 
            Array.from(t.querySelectorAll('tr')).map(r => 
              Array.from(r.querySelectorAll('th, td')).map(c => c.innerText.trim())
            )
          );
          return { tables, rawText: document.body.innerText };
        });

        const parsed = parseRateCardTables(docData.tables, vert, effectiveDate, isShopsyVertical ? 'shopsy' : 'flipkart');
        parsed.fulfilment_type = fulfillment === 'fbf' ? 'FBF' : 'NON_FBF';
        scrapedItems.push(parsed);
        onProgress(`  ✓ ${vert} (${fulfillment}): ${parsed.commissions.length} comm, ${parsed.fixedFees.length} fixed, ${parsed.reverseShipping.length} rev shipping slabs.`);
      }
    }

    // Save temporary staging file
    const stagingFile = path.join(STAGING_DIR, `ratecards_${Date.now()}.json`);
    fs.writeFileSync(stagingFile, JSON.stringify(scrapedItems, null, 2));
    onProgress(`Scraping complete. Staged ${scrapedItems.length} rate card entries in ${stagingFile}.`);

    return {
      success: true,
      data: scrapedItems,
      stagingFile
    };

  } catch (err) {
    onProgress(`Scraping error: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// ── Database Change Detection & Sync (PostgreSQL Constraint-Safe) ─────────────
async function executeDbSync(scrapedList, config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  const effectiveDate = new Date().toISOString().slice(0, 10);
  const prevDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  try {
    await client.query('BEGIN');

    for (const item of scrapedList) {
      const { marketplace, vertical, commissions, fixedFees, reverseShipping } = item;
      const mp = marketplace || (vertical.startsWith('shopsy_') ? 'shopsy' : 'flipkart');

      // 1. Commissions (Clean idempotent replace for today, auto-close prior)
      if (commissions.length > 0) {
        await client.query(`
          DELETE FROM rc_commission 
          WHERE marketplace = $1 AND category = $2 AND start_date = $3::date AND end_date IS NULL
        `, [mp, vertical, effectiveDate]);

        await client.query(`
          UPDATE rc_commission SET end_date = $1::date, updated_at = NOW()
          WHERE marketplace = $2 AND category = $3 AND start_date < $4::date AND (end_date IS NULL OR end_date >= $4::date)
        `, [prevDate, mp, vertical, effectiveDate]);

        for (const c of commissions) {
          await client.query(`
            INSERT INTO rc_commission (category, marketplace, seller_account, price_min, price_max, rate, start_date, end_date, updated_at)
            VALUES ($1, $2, 'default', $3, $4, $5, $6::date, NULL, NOW())
          `, [vertical, mp, c.price_min, c.price_max, c.rate, effectiveDate]);
        }
      }

      // 2. Fixed Fees (Clean idempotent replace for today, auto-close prior)
      if (fixedFees.length > 0) {
        await client.query(`
          DELETE FROM rc_fixed_fee 
          WHERE marketplace = $1 AND category = $2 AND start_date = $3::date AND end_date IS NULL
        `, [mp, vertical, effectiveDate]);

        await client.query(`
          UPDATE rc_fixed_fee SET end_date = $1::date, updated_at = NOW()
          WHERE marketplace = $2 AND category = $3 AND start_date < $4::date AND (end_date IS NULL OR end_date >= $4::date)
        `, [prevDate, mp, vertical, effectiveDate]);

        for (const f of fixedFees) {
          await client.query(`
            INSERT INTO rc_fixed_fee (category, marketplace, seller_account, fulfilment_type, price_min, price_max, rate, start_date, end_date, updated_at)
            VALUES ($1, $2, 'default', $3, $4, $5, $6, $7::date, NULL, NOW())
          `, [vertical, mp, f.fulfilment_type, f.price_min, f.price_max, f.rate, effectiveDate]);
        }
      }

      // 3. Reverse Shipping (Clean idempotent replace for today, auto-close prior)
      if (reverseShipping.length > 0) {
        await client.query(`
          DELETE FROM rc_reverse_shipping 
          WHERE marketplace = $1 AND category = $2 AND start_date = $3::date AND end_date IS NULL
        `, [mp, vertical, effectiveDate]);

        await client.query(`
          UPDATE rc_reverse_shipping SET end_date = $1::date, updated_at = NOW()
          WHERE marketplace = $2 AND category = $3 AND start_date < $4::date AND (end_date IS NULL OR end_date >= $4::date)
        `, [prevDate, mp, vertical, effectiveDate]);

        for (const r of reverseShipping) {
          await client.query(`
            INSERT INTO rc_reverse_shipping (category, marketplace, seller_account, weight_slab, price_min, price_max, local_fee, zonal_fee, national_fee, start_date, end_date, updated_at)
            VALUES ($1, $2, 'default', $3, $4, $5, $6, $7, $8, $9::date, NULL, NOW())
          `, [vertical, mp, r.weight_slab, r.price_min, r.price_max, r.local_fee, r.zonal_fee, r.national_fee, effectiveDate]);
        }
      }
    }

    const versionName = `desktop-sync-${effectiveDate}-${Date.now().toString().slice(-4)}`;
    await client.query(`
      INSERT INTO rate_card_versions (marketplace, seller_account, version_name, status, effective_from, snapshot, created_at, published_at)
      VALUES ('flipkart_shopsy_desktop', 'default', $1, 'published', $2::date, $3, NOW(), NOW())
    `, [versionName, effectiveDate, JSON.stringify({ syncedBy: 'Desktop Worker', itemsCount: scrapedList.length })]);

    await client.query('COMMIT');
    return { success: true, versionName };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (e, config) => saveConfig(config));

ipcMain.handle('test-db-connection', async (e, dbUrl) => {
  try {
    const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    const res = await pool.query('SELECT NOW() as now, current_database() as db');
    await pool.end();
    return { success: true, db: res.rows[0].db, time: res.rows[0].now };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('interactive-login', async (e, marketplace) => {
  return await executeInteractiveLogin(marketplace);
});

ipcMain.handle('start-scrape', async (e, options) => {
  const config = loadConfig();
  const mergedOptions = { ...config, ...options };
  return await executeScrapeProcess(mergedOptions, (msg) => {
    if (mainWindow) mainWindow.webContents.send('scrape-progress', msg);
  });
});

// Brand & FSN Live Catalog Inspection
ipcMain.handle('get-brand-fsn-catalog', async () => {
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { getRealTimeBrandFsnSamples } = await import('../backend/services/brandRateCardService.js');
    const { getPool } = await import('../backend/db/index.js');
    const pool = getPool();
    const catalog = await getRealTimeBrandFsnSamples(pool);
    return { success: true, catalog };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Full Brand-Wise Preview (Flipkart & Shopsy)
ipcMain.handle('get-ratecard-preview', async (e, options = {}) => {
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { buildBrandRateCardSet } = await import('../backend/services/brandRateCardService.js');
    const { getPool } = await import('../backend/db/index.js');
    const pool = getPool();
    const rateCards = await buildBrandRateCardSet(pool);
    return { success: true, rateCards };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Change Detection against PostgreSQL
ipcMain.handle('detect-brand-rate-changes', async (e, brandRateCards) => {
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { detectBrandRateChanges } = await import('../backend/services/brandRateCardService.js');
    const { getPool } = await import('../backend/db/index.js');
    const pool = getPool();
    const changes = await detectBrandRateChanges(brandRateCards, pool);
    return { success: true, changes };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Synchronize to Database
ipcMain.handle('sync-brand-rate-cards', async (e, brandRateCards, options = {}) => {
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { syncBrandRateCardsToDatabase } = await import('../backend/services/brandRateCardService.js');
    const { getPool } = await import('../backend/db/index.js');
    const pool = getPool();
    const result = await syncBrandRateCardsToDatabase(brandRateCards, { forceUpdate: true, ...options }, pool);
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Export 6-Sheet Desktop Excel (.xlsx)
ipcMain.handle('export-desktop-excel', async (e, customPath) => {
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { generateBrandwiseRateCardExcel, DEFAULT_EXCEL_PATH } = await import('../backend/services/brandwiseExcelExport.js');
    const { getPool } = await import('../backend/db/index.js');
    const pool = getPool();
    const targetPath = customPath || DEFAULT_EXCEL_PATH;
    const result = await generateBrandwiseRateCardExcel(targetPath, pool);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open File in Native App (Excel)
ipcMain.handle('open-excel-file', async (e, targetPath) => {
  try {
    const { DEFAULT_EXCEL_PATH } = await import('../backend/services/brandwiseExcelExport.js');
    const filePath = targetPath || DEFAULT_EXCEL_PATH;
    if (fs.existsSync(filePath)) {
      await shell.openPath(filePath);
      return { success: true, filePath };
    }
    return { success: false, error: `File not found on disk: ${filePath}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('export-file', async (e, format, data) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Scraped Rate Cards',
    defaultPath: `ratecards_export_${Date.now()}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  });

  if (filePath) {
    fs.writeFileSync(filePath, format === 'json' ? JSON.stringify(data, null, 2) : String(data));
    return { success: true, filePath };
  }
  return { success: false };
});
