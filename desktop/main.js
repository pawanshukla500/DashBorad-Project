const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { Pool } = require('pg');

let mainWindow = null;
const USER_DATA_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA_DIR, 'worker-config.json');
const COOKIES_PATH = path.join(USER_DATA_DIR, 'cookies.json');
const STAGING_DIR = path.join(USER_DATA_DIR, 'staging');

// Default Configuration
const DEFAULT_CONFIG = {
  marketplace: 'flipkart',
  email: 'Vbexports@outlook.com',
  password: '',
  databaseUrl: 'postgresql://pawanshukla:Xchange4SQL%24@200.141.1.119:5433/paymentapp',
  scheduledHour: 6, // 06:00 AM
  scheduledMinute: 0,
  autoSyncToDb: false,
  notificationEmail: 'payments@youthnic.shop',
  selectedVerticals: ['ethnic_set', 'kurta', 'sari', 'top', 'dress', 'dupatta', 'fabric']
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
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0f172a',
    title: 'ReconCentral RateCard Automation & Scraper Worker',
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

// ── Chrome Executable Discovery ──────────────────────────────────────────────
function getChromeExecutablePath() {
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  return possiblePaths.find(p => fs.existsSync(p)) || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

// ── Table Parsing Logic ──────────────────────────────────────────────────────
function parseRateCardTables(tables, vertical, effectiveDate) {
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

    // Wait until logged in (dashboard home page loaded)
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

// ── Automated Scraper Process ────────────────────────────────────────────────
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

  onProgress('Launching browser with stealth mode...');
  const browser = await puppeteer.launch({
    executablePath: getChromeExecutablePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1500,1000']
  });

  const scrapedItems = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1000 });

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

    const verticals = config.selectedVerticals?.length ? config.selectedVerticals : ['ethnic_set', 'kurta', 'sari', 'top', 'dress', 'dupatta', 'fabric'];
    const effectiveDate = new Date().toISOString().slice(0, 10);
    onProgress(`Extracting rate cards across ${verticals.length} verticals...`);

    for (let i = 0; i < verticals.length; i++) {
      const vert = verticals[i];
      onProgress(`[${i + 1}/${verticals.length}] Processing vertical: "${vert}"...`);

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
          scrapedItems.push(parsed);
          onProgress(`  ✓ ${vert} (${fulfillment}): ${parsed.commissions.length} comm, ${parsed.fixedFees.length} fixed, ${parsed.reverseShipping.length} rev shipping slabs.`);
        }
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

// ── Database Change Detection & Sync ─────────────────────────────────────────
async function executeChangeDetection(scrapedList, config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  const changes = [];
  try {
    for (const item of scrapedList) {
      const { vertical, commissions, fixedFees, reverseShipping } = item;

      // 1. Commission Diff
      const commRes = await pool.query(`
        SELECT price_min, price_max, rate FROM rc_commission
        WHERE marketplace = 'flipkart' AND seller_account = 'default' AND category = $1 AND end_date IS NULL
      `, [vertical]);

      for (const sc of commissions) {
        const match = commRes.rows.find(ac => 
          Math.abs(parseFloat(ac.price_min) - sc.price_min) < 0.01 &&
          Math.abs(parseFloat(ac.price_max) - sc.price_max) < 1.0
        );
        if (!match) {
          changes.push({
            type: 'Commission',
            category: vertical,
            slab: `₹${sc.price_min} - ₹${sc.price_max}`,
            oldRate: 'None',
            newRate: `${(sc.rate * 100).toFixed(1)}%`,
            status: 'New Slab'
          });
        } else if (Math.abs(parseFloat(match.rate) - sc.rate) > 0.0001) {
          changes.push({
            type: 'Commission',
            category: vertical,
            slab: `₹${sc.price_min} - ₹${sc.price_max}`,
            oldRate: `${(parseFloat(match.rate) * 100).toFixed(1)}%`,
            newRate: `${(sc.rate * 100).toFixed(1)}%`,
            status: 'Modified'
          });
        }
      }

      // 2. Fixed Fee Diff
      const fixedRes = await pool.query(`
        SELECT fulfilment_type, price_min, price_max, rate FROM rc_fixed_fee
        WHERE marketplace = 'flipkart' AND seller_account = 'default' AND category = $1 AND end_date IS NULL
      `, [vertical]);

      for (const sf of fixedFees) {
        const match = fixedRes.rows.find(af => 
          af.fulfilment_type === sf.fulfilment_type &&
          Math.abs(parseFloat(af.price_min) - sf.price_min) < 0.01
        );
        if (!match) {
          changes.push({
            type: 'Fixed Fee',
            category: vertical,
            slab: `${sf.fulfilment_type} (₹${sf.price_min} - ₹${sf.price_max})`,
            oldRate: 'None',
            newRate: `₹${sf.rate}`,
            status: 'New Slab'
          });
        } else if (Math.abs(parseFloat(match.rate) - sf.rate) > 0.01) {
          changes.push({
            type: 'Fixed Fee',
            category: vertical,
            slab: `${sf.fulfilment_type} (₹${sf.price_min} - ₹${sf.price_max})`,
            oldRate: `₹${parseFloat(match.rate)}`,
            newRate: `₹${sf.rate}`,
            status: 'Modified'
          });
        }
      }

      // 3. Reverse Shipping Diff
      const revRes = await pool.query(`
        SELECT weight_slab, price_min, price_max, local_fee, zonal_fee, national_fee FROM rc_reverse_shipping
        WHERE marketplace = 'flipkart' AND seller_account = 'default' AND category = $1 AND end_date IS NULL
      `, [vertical]);

      for (const sr of reverseShipping) {
        const match = revRes.rows.find(ar => 
          ar.weight_slab === sr.weight_slab &&
          Math.abs(parseFloat(ar.price_min) - sr.price_min) < 0.01
        );
        if (!match) {
          changes.push({
            type: 'Reverse Shipping',
            category: vertical,
            slab: `${sr.weight_slab} (₹${sr.price_min} - ₹${sr.price_max})`,
            oldRate: 'None',
            newRate: `L: ₹${sr.local_fee}, Z: ₹${sr.zonal_fee}, N: ₹${sr.national_fee}`,
            status: 'New Slab'
          });
        } else if (
          Math.abs(parseFloat(match.local_fee) - sr.local_fee) > 0.01 ||
          Math.abs(parseFloat(match.zonal_fee) - sr.zonal_fee) > 0.01 ||
          Math.abs(parseFloat(match.national_fee) - sr.national_fee) > 0.01
        ) {
          changes.push({
            type: 'Reverse Shipping',
            category: vertical,
            slab: `${sr.weight_slab} (₹${sr.price_min} - ₹${sr.price_max})`,
            oldRate: `L: ₹${match.local_fee}, Z: ₹${match.zonal_fee}, N: ₹${match.national_fee}`,
            newRate: `L: ₹${sr.local_fee}, Z: ₹${sr.zonal_fee}, N: ₹${sr.national_fee}`,
            status: 'Modified'
          });
        }
      }
    }
  } finally {
    await pool.end();
  }

  return changes;
}

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
      const { vertical, commissions, fixedFees, collectionFees, reverseShipping } = item;

      // Commissions
      if (commissions.length > 0) {
        await client.query(`
          UPDATE rc_commission SET end_date = $1, updated_at = NOW()
          WHERE marketplace = 'flipkart' AND seller_account = 'default' AND category = $2 AND end_date IS NULL
        `, [prevDate, vertical]);

        for (const c of commissions) {
          await client.query(`
            INSERT INTO rc_commission (category, marketplace, seller_account, price_min, price_max, rate, start_date, end_date, updated_at)
            VALUES ($1, 'flipkart', 'default', $2, $3, $4, $5, NULL, NOW())
          `, [vertical, c.price_min, c.price_max, c.rate, effectiveDate]);
        }
      }

      // Fixed Fees
      if (fixedFees.length > 0) {
        await client.query(`
          UPDATE rc_fixed_fee SET end_date = $1, updated_at = NOW()
          WHERE marketplace = 'flipkart' AND seller_account = 'default' AND category = $2 AND end_date IS NULL
        `, [prevDate, vertical]);

        for (const f of fixedFees) {
          await client.query(`
            INSERT INTO rc_fixed_fee (category, marketplace, seller_account, fulfilment_type, price_min, price_max, rate, start_date, end_date, updated_at)
            VALUES ($1, 'flipkart', 'default', $2, $3, $4, $5, $6, NULL, NOW())
          `, [vertical, f.fulfilment_type, f.price_min, f.price_max, f.rate, effectiveDate]);
        }
      }

      // Reverse Shipping
      if (reverseShipping.length > 0) {
        await client.query(`
          UPDATE rc_reverse_shipping SET end_date = $1, updated_at = NOW()
          WHERE marketplace = 'flipkart' AND seller_account = 'default' AND category = $2 AND end_date IS NULL
        `, [prevDate, vertical]);

        for (const r of reverseShipping) {
          await client.query(`
            INSERT INTO rc_reverse_shipping (category, marketplace, seller_account, weight_slab, price_min, price_max, local_fee, zonal_fee, national_fee, start_date, end_date, updated_at)
            VALUES ($1, 'flipkart', 'default', $2, $3, $4, $5, $6, $7, $8, NULL, NOW())
          `, [vertical, r.weight_slab, r.price_min, r.price_max, r.local_fee, r.zonal_fee, r.national_fee, effectiveDate]);
        }
      }
    }

    const versionName = `desktop-sync-${effectiveDate}-${Date.now().toString().slice(-4)}`;
    await client.query(`
      INSERT INTO rate_card_versions (marketplace, seller_account, version_name, status, effective_from, snapshot, created_at, published_at)
      VALUES ('flipkart', 'default', $1, 'published', $2, $3, NOW(), NOW())
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

ipcMain.handle('detect-changes', async (e, scrapedData) => {
  const config = loadConfig();
  try {
    const changes = await executeChangeDetection(scrapedData, config);
    return { success: true, changes };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sync-to-db', async (e, scrapedData) => {
  const config = loadConfig();
  try {
    const result = await executeDbSync(scrapedData, config);
    return { success: true, result };
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
