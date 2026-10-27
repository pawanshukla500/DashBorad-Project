import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { 
  decodeJwtPayload, 
  extractRoleFromToken, 
  isAuthorizedDesktopRole, 
  validateDesktopTokenRole, 
  filterRateCardsByChannel, 
  AUTHORIZED_ROLES, 
  FIREBASE_ROLE_CLAIM 
} from './authValidation.js';

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
const SESSION_FILE = path.join(USER_DATA_DIR, 'auth-session.json');
const COOKIES_PATH = path.join(USER_DATA_DIR, 'cookies.json');
const STAGING_DIR = path.join(USER_DATA_DIR, 'staging');

const FIREBASE_API_KEY = process.env.VITE_FIREBASE_API_KEY || 'AIzaSyD3FSzQXK7MACZOJR9tz_N7tnQ40QLMchs';

async function authenticateWithFirebase(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const data = await response.json();
  if (!response.ok) {
    const errorMsg = data?.error?.message || 'Authentication failed';
    throw new Error(errorMsg);
  }
  return data;
}

async function exchangeFirebaseCustomToken(customToken) {
  if (!customToken) return null;
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true })
  });
  if (response.ok) {
    const data = await response.json();
    return {
      idToken: data.idToken,
      refreshToken: data.refreshToken
    };
  }
  return null;
}

async function refreshFirebaseIdToken(refreshToken) {
  if (!refreshToken) return null;
  const url = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
  });
  if (response.ok) {
    const data = await response.json();
    return {
      idToken: data.id_token || data.access_token,
      refreshToken: data.refresh_token
    };
  }
  return null;
}

function loadAuthSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, 'utf8');
      const session = JSON.parse(raw);
      if (session && session.user && session.authenticated) {
        return session;
      }
    }
  } catch (err) {
    console.error('Failed to read auth session:', err);
  }
  return { authenticated: false, user: null };
}

function saveAuthSession(sessionData) {
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function clearAuthSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Default Configuration with Flipkart & Shopsy Verticals and Brands
// NOTE: Database credentials are never hardcoded in the installer bundle.
// They are securely provisioned over TLS upon successful Firebase authentication & role verification.
const CANDIDATE_API_SERVERS = [
  process.env.API_SERVER_URL,
  'https://payments.youthnic.shop',
  'https://reconcentral.srv1845788.hstgr.cloud',
  'https://recon.srv1845788.hstgr.cloud',
  'http://localhost:3001'
].filter(Boolean);

const SUPPORTED_MARKETPLACES = [
  {
    id: 'flipkart_shopsy',
    name: 'Flipkart & Shopsy',
    marketplace: 'flipkart',
    portalUrl: 'https://seller.flipkart.com',
    loginUrl: 'https://seller.flipkart.com/',
    dashboardUrl: 'https://seller.flipkart.com/index.html#dashboard/home-page',
    rateCardUrl: 'https://seller.flipkart.com/index.html#dashboard/payments/rate-card',
    defaultAccount: 'Vbexports@outlook.com',
    hasScraper: true,
    description: 'Flipkart Seller Hub fee tiers (Commission, Fixed, Collection, Reverse Shipping)'
  },
  {
    id: 'myntra_vb',
    name: 'Myntra (VB Exports - 10708)',
    marketplace: 'myntra',
    account_id: 'myntra_vb',
    sellerId: '10708',
    portalUrl: 'https://partnerportal.myntra.com',
    loginUrl: 'https://partnerportal.myntra.com/',
    dashboardUrl: 'https://partnerportal.myntra.com/dashboard',
    rateCardUrl: 'https://partnerportal.myntra.com/rate-card',
    defaultAccount: 'returnorders@vbexports.co.in',
    hasScraper: false,
    description: 'Myntra Partner Portal for VB Exports (Seller ID 10708) — 2FA Session Linked (Rate card scraping scheduled for Phase 2)'
  },
  {
    id: 'myntra_ej',
    name: 'Myntra (Ethnic Junction - 45833)',
    marketplace: 'myntra',
    account_id: 'myntra_ej',
    sellerId: '45833',
    portalUrl: 'https://partnerportal.myntra.com',
    loginUrl: 'https://partnerportal.myntra.com/',
    dashboardUrl: 'https://partnerportal.myntra.com/dashboard',
    rateCardUrl: 'https://partnerportal.myntra.com/rate-card',
    defaultAccount: 'returnorders@vbexports.co.in',
    hasScraper: false,
    description: 'Myntra Partner Portal for Ethnic Junction (Seller ID 45833) — 2FA Session Linked (Rate card scraping scheduled for Phase 2)'
  },
  {
    id: 'meesho',
    name: 'Meesho Supplier Panel',
    marketplace: 'meesho',
    account_id: 'meesho',
    portalUrl: 'https://supplier.meesho.com',
    loginUrl: 'https://supplier.meesho.com/panel/v2/new/login',
    dashboardUrl: 'https://supplier.meesho.com/panel/v2/new/home',
    rateCardUrl: 'https://supplier.meesho.com/panel/v2/new/growth/rate-card',
    defaultAccount: 'returnorders@vbexports.co.in',
    hasScraper: false,
    description: 'Meesho Supplier Panel — 2FA Session Linked (Rate card scraping scheduled for Phase 2)'
  },
  {
    id: 'amazon',
    name: 'Amazon Seller Central',
    marketplace: 'amazon',
    account_id: 'amazon',
    portalUrl: 'https://sellercentral.amazon.in/',
    loginUrl: 'https://sellercentral.amazon.in/',
    dashboardUrl: 'https://sellercentral.amazon.in/',
    rateCardUrl: 'https://sellercentral.amazon.in/help/hub/reference/G200336920',
    defaultAccount: 'returnorders@vbexports.co.in',
    hasScraper: false,
    description: 'Amazon IN Seller Central'
  },
  {
    id: 'ajio',
    name: 'Reliance Retail (AJIO)',
    marketplace: 'ajio',
    account_id: 'ajio',
    portalUrl: 'https://supplier.ajio.com/',
    loginUrl: 'https://supplier.ajio.com/',
    dashboardUrl: 'https://supplier.ajio.com/',
    rateCardUrl: 'https://supplier.ajio.com/',
    defaultAccount: 'returnorders@vbexports.co.in',
    hasScraper: false,
    description: 'Reliance Retail (AJIO) Supplier Hub'
  },
  {
    id: 'cocoblu',
    name: 'Cocoblu Retails',
    marketplace: 'cocoblu',
    account_id: 'cocoblu',
    portalUrl: 'https://cocoblu.biz/',
    loginUrl: 'https://cocoblu.biz/',
    dashboardUrl: 'https://cocoblu.biz/',
    rateCardUrl: 'https://cocoblu.biz/',
    defaultAccount: 'returnorders@vbexports.co.in',
    hasScraper: false,
    description: 'Cocoblu Retails Portal'
  },
  {
    id: 'shopify',
    name: 'Shopify Admin',
    marketplace: 'shopify',
    account_id: 'shopify',
    portalUrl: 'https://admin.shopify.com/',
    loginUrl: 'https://admin.shopify.com/',
    dashboardUrl: 'https://admin.shopify.com/',
    rateCardUrl: 'https://admin.shopify.com/',
    defaultAccount: 'returnorders@vbexports.co.in',
    hasScraper: false,
    description: 'Shopify Admin Center'
  }
];

function getMarketplaceCookiesPath(marketplace = 'flipkart_shopsy') {
  const safeId = String(marketplace).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const dir = path.join(USER_DATA_DIR, 'cookies');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `cookies_${safeId}.json`);
}

const DEFAULT_CONFIG = {
  marketplace: 'flipkart_shopsy', // 'flipkart_shopsy', 'myntra_vb', 'myntra_ej', 'meesho'
  email: 'Vbexports@outlook.com',
  password: '',
  apiServerUrl: process.env.API_SERVER_URL || 'https://payments.youthnic.shop',
  databaseUrl: process.env.DATABASE_URL || '',
  scheduledHour: 6, // 06:00 AM
  scheduledMinute: 0,
  autoSyncToDb: false,
  notificationEmail: 'payments@youthnic.shop',
  selectedBrands: ['Ethnic Junction', 'Youthnic', 'Sangria', 'Divastri', 'General'],
  selectedVerticals: [
    'ethnic_set', 'kurta', 'sari', 'top', 'dress', 'dupatta', 'fabric',
    'blouse', 'lehenga_choli', 'gown', 'shopsy_kurta', 'shopsy_ethnic_set'
  ],
  accounts: {
    flipkart_shopsy: { email: 'Vbexports@outlook.com', portalUrl: 'https://seller.flipkart.com' },
    myntra_vb: { email: 'returnorders@vbexports.co.in', sellerId: '10708', portalUrl: 'https://partnerportal.myntra.com' },
    myntra_ej: { email: 'returnorders@vbexports.co.in', sellerId: '45833', portalUrl: 'https://partnerportal.myntra.com' },
    meesho: { email: 'returnorders@vbexports.co.in', portalUrl: 'https://supplier.meesho.com' }
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Auto-heal old typo in apiServerUrl
      if (parsed.apiServerUrl && parsed.apiServerUrl.includes('payment.youthnic.shop')) {
        parsed.apiServerUrl = parsed.apiServerUrl.replace('payment.youthnic.shop', 'payments.youthnic.shop');
      }
      return { 
        ...DEFAULT_CONFIG, 
        ...parsed, 
        accounts: { ...DEFAULT_CONFIG.accounts, ...(parsed.accounts || {}) } 
      };
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
    title: 'ReconCentral Multi-Marketplace RateCard Automation & Scraper Worker',
    icon: path.join(__dirname, 'ui/icon.png'),
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

// ── Interactive Human Login Flow (Multi-Marketplace) ─────────────────────────
async function executeInteractiveLogin(marketplace = 'flipkart_shopsy') {
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

  const targetId = (typeof marketplace === 'string' ? marketplace : marketplace?.marketplace || marketplace?.id) || 'flipkart_shopsy';
  const mpConfig = SUPPORTED_MARKETPLACES.find(m => m.id === targetId || m.marketplace === targetId);
  if (!mpConfig) {
    const validIds = SUPPORTED_MARKETPLACES.map(m => m.id).join(', ');
    return { success: false, marketplace: targetId, error: `Unsupported marketplace channel: "${targetId}". Supported channels: ${validIds}` };
  }
  const cookiesPath = getMarketplaceCookiesPath(mpConfig.id);

  const browser = await puppeteer.launch({
    executablePath: getChromeExecutablePath(),
    headless: false, // Visible window for human login / OTP
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    if (fs.existsSync(cookiesPath)) {
      const raw = fs.readFileSync(cookiesPath, 'utf8');
      await page.setCookie(...JSON.parse(raw));
    } else if (fs.existsSync(COOKIES_PATH) && (mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart')) {
      const raw = fs.readFileSync(COOKIES_PATH, 'utf8');
      await page.setCookie(...JSON.parse(raw));
    }

    console.log(`[InteractiveLogin] Opening ${mpConfig.name} at ${mpConfig.loginUrl}...`);
    await page.goto(mpConfig.loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log(`[InteractiveLogin] Waiting for ${mpConfig.name} authenticated navigation...`);
    await page.waitForFunction((id) => {
      const href = window.location.href.toLowerCase();
      const body = document.body ? document.body.innerText.toLowerCase() : '';
      const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
      const hasLoginForm = Boolean(document.querySelector('form[action*="login"], form[action*="signin"]'));

      // If the page is still presenting a password field or login form, it is NOT authenticated yet
      if (hasPasswordInput || hasLoginForm) return false;

      if (id.startsWith('myntra')) {
        return href.includes('partnerportal') && (href.includes('dashboard') || href.includes('home') || body.includes('logout') || body.includes('seller id'));
      }
      if (id === 'meesho') {
        const notLogin = !href.includes('/login') && !href.includes('auth');
        const onPanel = href.includes('supplier.meesho.com') && (
          href.includes('/orders') || 
          href.includes('/catalog') || 
          href.includes('/payments') || 
          href.includes('/returns') || 
          href.includes('/dashboard') || 
          href.includes('/home')
        );
        const hasAuthText = body.includes('logout') || body.includes('sign out') || body.includes('seller id');
        return notLogin && (onPanel || hasAuthText);
      }
      if (id === 'amazon') {
        return href.includes('sellercentral.amazon.in') && !href.includes('/signin') && (href.includes('home') || href.includes('dashboard') || body.includes('sign out') || body.includes('logout'));
      }
      if (id === 'ajio') {
        return href.includes('supplier.ajio.com') && !href.includes('/login') && (href.includes('dashboard') || href.includes('home') || body.includes('logout'));
      }
      if (id === 'cocoblu') {
        const notLogin = !href.includes('/login') && !href.includes('/auth') && !href.includes('/signin');
        const onAuthRoute = href.includes('/dashboard') || href.includes('/orders') || href.includes('/vendor') || href.includes('/portal') || href.includes('/reports');
        const hasLogoutAction = body.includes('logout') || body.includes('sign out') || Boolean(document.querySelector('a[href*="logout"], button[class*="logout"]'));
        return href.includes('cocoblu.biz') && notLogin && (onAuthRoute || hasLogoutAction);
      }
      if (id === 'shopify') {
        const notLogin = !href.includes('/login') && !href.includes('/auth') && !href.includes('/signin') && !href.includes('/signup');
        // Matches /store/<store_name> (root store dashboard), /store/<store_name>/home, /orders, /products, /settings, /analytics
        const onStoreRoute = (href.includes('/store/') || href.includes('/admin/')) && (
          href.includes('/home') ||
          href.includes('/orders') ||
          href.includes('/products') ||
          href.includes('/settings') ||
          href.includes('/analytics') ||
          /\/store\/[a-zA-Z0-9\-_]+(\/?$|\?)/.test(href)
        );
        // Robust post-login indicators: Polaris navigation, AppFrame, account menu, or logout button
        const hasAuthenticatedUi = Boolean(document.querySelector(
          '#AppFrameMain, nav[aria-label*="Navigation" i], nav[aria-label*="Main" i], [data-portal-id], a[href*="logout"], button[class*="logout"], [aria-label*="log out" i], [aria-label*="Store menu" i], [aria-label*="Account menu" i]'
        ));
        const hasLogoutAction = body.includes('log out') || hasAuthenticatedUi;
        return href.includes('admin.shopify.com') && notLogin && (onStoreRoute || hasLogoutAction);
      }
      return href.includes('#dashboard') || body.includes('seller dashboard') || body.includes('ethnicjunction') || body.includes('logout');
    }, { timeout: 300000 }, mpConfig.id);

    const cookies = await page.cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
    if (mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart') {
      fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    }
    console.log(`[InteractiveLogin] Logged in to ${mpConfig.name} successfully! Saved ${cookies.length} session cookies.`);

    await browser.close();
    return { success: true, marketplace: mpConfig.id, cookiesCount: cookies.length };
  } catch (err) {
    if (browser) await browser.close();
    return { success: false, marketplace: mpConfig?.id || targetId, error: err.message };
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

  const targetChannel = (typeof config.marketplace === 'string' ? config.marketplace : config.marketplace?.id || config.marketplace?.marketplace) || 'flipkart_shopsy';
  const mpConfig = SUPPORTED_MARKETPLACES.find(m => m.id === targetChannel || m.marketplace === targetChannel);
  if (!mpConfig) {
    const validIds = SUPPORTED_MARKETPLACES.map(m => m.id).join(', ');
    return { success: false, error: `Unsupported scraping channel: "${targetChannel}". Supported channels: ${validIds}` };
  }
  if (!mpConfig.hasScraper) {
    return {
      success: false,
      error: `Scraper worker is not yet implemented for ${mpConfig.name}. Automated scrapers are currently active for Flipkart & Shopsy, Myntra VB (10708), Myntra EJ (45833), and Meesho.`
    };
  }
  const cookiesPath = getMarketplaceCookiesPath(mpConfig.id);

  const isVisible = Boolean(config.visible);
  onProgress(isVisible 
    ? `Launching Google Chrome in VISIBLE interactive mode for ${mpConfig.name}...` 
    : `Launching browser with stealth mode for ${mpConfig.name}...`);

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
    if (mpConfig.id === 'myntra_vb' || mpConfig.id === 'myntra_ej' || mpConfig.id === 'meesho') {
      onProgress(`Targeting marketplace channel: ${mpConfig.name}`);
      if (!fs.existsSync(cookiesPath)) {
        onProgress(`⚠️ No saved session cookies found for ${mpConfig.name} at: ${cookiesPath}`);
        onProgress(`Please click "🔑 Human Login (2FA)" to authorize your ${mpConfig.name} account.`);
        await browser.close();
        return {
          success: false,
          error: `Authentication required for ${mpConfig.name}. Please click "Human Login (2FA)" first.`
        };
      }

      onProgress(`✓ Loaded session cookies vault for ${mpConfig.name}.`);
      onProgress(`Connecting to ${mpConfig.name} at ${mpConfig.loginUrl}...`);

      const pages = await browser.pages();
      const page = pages[0] || await browser.newPage();
      const rawCookies = fs.readFileSync(cookiesPath, 'utf8');
      await page.setCookie(...JSON.parse(rawCookies));
      await page.goto(mpConfig.loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

      // Rigorous authentication verification on target portal
      onProgress(`Verifying authenticated session for ${mpConfig.name}...`);
      let isAuthenticated = false;
      try {
        isAuthenticated = await page.waitForFunction((id) => {
          const href = window.location.href.toLowerCase();
          const body = document.body ? document.body.innerText.toLowerCase() : '';
          if (id.startsWith('myntra')) {
            const onPortal = href.includes('partnerportal') || href.includes('myntra');
            const hasAuthIndicator = href.includes('dashboard') || href.includes('home') || body.includes('logout') || body.includes('seller id');
            const notOnLogin = !href.includes('login') && !body.includes('sign in to your account');
            return onPortal && hasAuthIndicator && notOnLogin;
          }
          if (id === 'meesho') {
            const notLogin = !href.includes('/login') && !href.includes('auth');
            const onPanel = href.includes('supplier.meesho.com') && (
              href.includes('/orders') || 
              href.includes('/catalog') || 
              href.includes('/payments') || 
              href.includes('/returns') || 
              href.includes('/dashboard') || 
              href.includes('/home')
            );
            const hasAuthText = body.includes('logout') || body.includes('sign out') || body.includes('seller id');
            return notLogin && (onPanel || hasAuthText);
          }
          return false;
        }, { timeout: 20000 }, mpConfig.id);
      } catch (authTimeoutErr) {
        isAuthenticated = false;
      }

      if (!isAuthenticated) {
        onProgress(`❌ Session verification failed: Saved session cookies for ${mpConfig.name} have expired or are invalid.`);
        onProgress(`Please click "🔑 Human Login (2FA)" to re-authenticate ${mpConfig.name}.`);
        await browser.close();
        return {
          success: false,
          error: `Session for ${mpConfig.name} is expired or invalid. Please re-authenticate via Human Login (2FA).`
        };
      }

      onProgress(`✓ Authenticated session confirmed on ${mpConfig.name}.`);
      onProgress(`Extracting active rate card profiles for ${mpConfig.name}...`);

      let channelRateCards = [];
      try {
        if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
        const { getPool } = await import('../backend/db/index.js');
        const { buildBrandRateCardSet } = await import('../backend/services/brandRateCardService.js');
        const pool = getPool();
        const allRateCards = await buildBrandRateCardSet(pool);
        if (mpConfig.id === 'myntra_vb') {
          channelRateCards = allRateCards.filter(r => r.marketplace.toLowerCase() === 'myntra_vb' || (r.marketplace.toLowerCase() === 'myntra' && String(r.seller_id) === '10708'));
        } else if (mpConfig.id === 'myntra_ej') {
          channelRateCards = allRateCards.filter(r => r.marketplace.toLowerCase() === 'myntra_ej' || (r.marketplace.toLowerCase() === 'myntra' && String(r.seller_id) === '45833'));
        } else if (mpConfig.id === 'meesho') {
          channelRateCards = allRateCards.filter(r => r.marketplace.toLowerCase() === 'meesho');
        }
      } catch (poolErr) {
        console.warn(`[executeScrapeProcess] Could not load database rate cards for ${mpConfig.id}:`, poolErr.message);
      }

      const stagingFile = path.join(STAGING_DIR, `${mpConfig.id}_session_verified.json`);
      fs.mkdirSync(STAGING_DIR, { recursive: true });
      fs.writeFileSync(stagingFile, JSON.stringify({ 
        marketplace: mpConfig.id, 
        name: mpConfig.name, 
        verifiedAt: new Date().toISOString(),
        rateCardsCount: channelRateCards.length,
        rateCards: channelRateCards
      }, null, 2));

      await browser.close();
      return {
        success: true,
        data: channelRateCards,
        count: channelRateCards.length,
        stagingFile,
        message: `Verified authenticated session and staged ${channelRateCards.length} rate profiles for ${mpConfig.name}.`
      };
    }

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    if (!isVisible) await page.setViewport({ width: 1500, height: 1000 });

    const activeCookieFile = fs.existsSync(cookiesPath) ? cookiesPath : COOKIES_PATH;
    if (fs.existsSync(activeCookieFile)) {
      const raw = fs.readFileSync(activeCookieFile, 'utf8');
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

// ── Authentication & Authorization IPC Handlers ─────────────────────────────
ipcMain.handle('auth-login', async (e, { email, password, dbUrl }) => {
  try {
    if (!email || !password) {
      return { success: false, error: 'Email and password are required.' };
    }

    let fbResult;
    try {
      fbResult = await authenticateWithFirebase(email, password);
    } catch (fbErr) {
      const msg = fbErr.message === 'INVALID_LOGIN_CREDENTIALS' || fbErr.message === 'EMAIL_NOT_FOUND' || fbErr.message === 'INVALID_PASSWORD'
        ? 'Invalid email or password.'
        : `Firebase Auth error: ${fbErr.message}`;
      return { success: false, error: msg };
    }

    const firebaseUid = fbResult.localId;
    const userEmail = fbResult.email || email;
    const config = loadConfig();

    let dbUser = null;
    let provisionedDbUrl = dbUrl;

    // 1. Attempt to obtain verified authorization & database config across candidate ReconCentral endpoints with auto-failover
    for (const serverBase of CANDIDATE_API_SERVERS) {
      if (dbUser) break;
      const normalizedBase = serverBase.replace(/\/+$/, '').replace('payment.youthnic.shop', 'payments.youthnic.shop');
      try {
        // Try dedicated desktop-login endpoint first (handles user sync, role claims, and DB provisioning)
        let srvRes = await fetch(`${normalizedBase}/api/auth/desktop-login`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${fbResult.idToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        // Fallback to desktop-config endpoint if older version deployed
        if (!srvRes.ok && srvRes.status === 404) {
          srvRes = await fetch(`${normalizedBase}/api/auth/desktop-config`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${fbResult.idToken}`,
              'Accept': 'application/json'
            }
          });
        }

        if (srvRes.ok) {
          const srvData = await srvRes.json();
          if (srvData && srvData.success && srvData.user) {
            dbUser = srvData.user;
            if (srvData.databaseUrl && !dbUrl) {
              provisionedDbUrl = srvData.databaseUrl;
            }
            config.apiServerUrl = normalizedBase;
            saveConfig(config);

            // Reissue fresh ID token carrying newly updated role claim
            let tokenRenewed = false;
            if (srvData.customToken) {
              try {
                const customAuth = await exchangeFirebaseCustomToken(srvData.customToken);
                if (customAuth && customAuth.idToken) {
                  fbResult.idToken = customAuth.idToken;
                  if (customAuth.refreshToken) fbResult.refreshToken = customAuth.refreshToken;
                  tokenRenewed = true;
                }
              } catch (ctErr) {
                console.warn('[Desktop Auth] Custom token exchange warning:', ctErr.message);
              }
            }

            if (!tokenRenewed && fbResult.refreshToken) {
              try {
                const refreshed = await refreshFirebaseIdToken(fbResult.refreshToken);
                if (refreshed && refreshed.idToken) {
                  fbResult.idToken = refreshed.idToken;
                  if (refreshed.refreshToken) fbResult.refreshToken = refreshed.refreshToken;
                  tokenRenewed = true;
                }
              } catch (refreshErr) {
                console.warn('[Desktop Auth] Token refresh warning:', refreshErr.message);
              }
            }

            // Fail closed: do not persist session if role-claim token renewal failed
            if (!tokenRenewed) {
              return {
                success: false,
                error: 'Failed to refresh authentication token with newly assigned desktop role claims. Please verify your network connection and try logging in again.'
              };
            }
            break;
          }
        } else if (srvRes.status === 403) {
          const errData = await srvRes.json().catch(() => ({}));
          if (errData.code === 'ACCESS_NOT_GRANTED') {
            return {
              success: false,
              error: `User account '${userEmail}' authenticated in Firebase, but has not been granted access in ReconCentral. Please contact an administrator to add your email in Admin Center.`
            };
          }
          if (errData.error && errData.error.includes('not authorized')) {
            return { success: false, error: errData.error };
          }
        }
      } catch (srvErr) {
        console.warn(`[Desktop Auth] Candidate server ${normalizedBase} query failed:`, srvErr.message);
      }
    }

    // 2. Strict direct PostgreSQL verification only if candidate servers were unreachable
    const targetDbUrl = provisionedDbUrl || config.databaseUrl;
    if (!dbUser && targetDbUrl && firebaseUid) {
      const pool = new Pool({
        connectionString: targetDbUrl,
        ssl: { rejectUnauthorized: false }
      });
      try {
        const res = await pool.query(
          'SELECT id, username, email, role, firebase_uid FROM users WHERE firebase_uid = $1 LIMIT 1',
          [firebaseUid]
        );
        if (res.rows.length > 0) {
          dbUser = res.rows[0];
        }
      } catch (dbErr) {
        await pool.end();
        return { success: false, error: `Database connection error: ${dbErr.message}` };
      }
      await pool.end();
    }

    if (!dbUser) {
      return { success: false, error: `User authenticated in Firebase, but no corresponding account with verified UID was found in ReconCentral database (${userEmail}). Please sign in through ReconCentral web app first to link your account.` };
    }

    const authorizedRoles = ['admin', 'operator', 'analyst'];
    if (!authorizedRoles.includes(dbUser.role)) {
      return {
        success: false,
        error: `Access denied. Your role (${dbUser.role || 'viewer'}) is not authorized to operate rate card scrapers or synchronize database records. Contact an administrator.`
      };
    }

    // Strict invariant: Ensure the session token carries a verified role claim before persisting
    let tokenValidation = validateDesktopTokenRole(fbResult.idToken);

    // If the token lacks the role claim, attempt to refresh via refreshToken
    if (!tokenValidation.authorized && fbResult.refreshToken) {
      try {
        const refreshed = await refreshFirebaseIdToken(fbResult.refreshToken);
        if (refreshed && refreshed.idToken) {
          fbResult.idToken = refreshed.idToken;
          if (refreshed.refreshToken) fbResult.refreshToken = refreshed.refreshToken;
          tokenValidation = validateDesktopTokenRole(fbResult.idToken);
        }
      } catch (refErr) {
        console.warn('[Desktop Auth] Final token refresh warning:', refErr.message);
      }
    }

    if (!tokenValidation.authorized) {
      return {
        success: false,
        error: `Authentication failed: The issued session token does not carry the required role claim (${dbUser.role}). Please sign in through ReconCentral web app or verify user role in Admin Center.`
      };
    }

    const session = {
      authenticated: true,
      user: {
        id: dbUser.id,
        username: dbUser.username || userEmail.split('@')[0],
        email: dbUser.email || userEmail,
        role: dbUser.role,
        firebase_uid: firebaseUid
      },
      idToken: fbResult.idToken,
      refreshToken: fbResult.refreshToken,
      authorizedAt: new Date().toISOString()
    };

    saveAuthSession(session);

    if (provisionedDbUrl && provisionedDbUrl !== config.databaseUrl) {
      config.databaseUrl = provisionedDbUrl;
      saveConfig(config);
    }

    return { success: true, session };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-marketplaces', () => {
  const list = SUPPORTED_MARKETPLACES.map(m => {
    const cookiesPath = getMarketplaceCookiesPath(m.id);
    const hasCookies = fs.existsSync(cookiesPath);
    return {
      ...m,
      hasCookies,
      cookiesPath
    };
  });
  return { success: true, marketplaces: list };
});

ipcMain.handle('get-marketplace-accounts', async () => {
  const session = loadAuthSession();
  const config = loadConfig();
  if (!session || !session.idToken) {
    return { success: false, error: 'Not authenticated with ReconCentral.' };
  }

  for (const serverBase of CANDIDATE_API_SERVERS) {
    const normalizedBase = serverBase.replace(/\/+$/, '').replace('payment.youthnic.shop', 'payments.youthnic.shop');
    try {
      const res = await fetch(`${normalizedBase}/api/marketplace-accounts`, {
        headers: { 'Authorization': `Bearer ${session.idToken}`, 'Accept': 'application/json' }
      });
      if (res.ok) {
        const body = await res.json();
        const accounts = Array.isArray(body) ? body : (body.accounts || []);
        return { success: true, accounts };
      }
    } catch {}
  }

  return { success: false, error: 'Could not connect to ReconCentral API to fetch marketplace accounts.' };
});

ipcMain.handle('auth-get-session', () => loadAuthSession());
ipcMain.handle('auth-logout', () => clearAuthSession());

ipcMain.handle('auth-verify-db', async (e, dbUrl) => {
  const config = loadConfig();
  const targetDb = dbUrl || config.databaseUrl;
  const start = Date.now();
  try {
    const pool = new Pool({ connectionString: targetDb, ssl: { rejectUnauthorized: false } });
    const res = await pool.query(`
      SELECT 
        current_database() as db_name, 
        current_user as db_user, 
        version() as db_version, 
        (SELECT count(*) FROM users) as user_count,
        (SELECT count(*) FROM rc_commission WHERE end_date IS NULL) as active_rates_count
    `);
    const latency = Date.now() - start;
    await pool.end();
    return {
      success: true,
      latencyMs: latency,
      dbName: res.rows[0].db_name,
      dbUser: res.rows[0].db_user,
      userCount: parseInt(res.rows[0].user_count, 10),
      activeRatesCount: parseInt(res.rows[0].active_rates_count, 10)
    };
  } catch (err) {
    return { success: false, error: err.message, latencyMs: Date.now() - start };
  }
});

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
    const targetMp = options.marketplace || options.channel || '';
    const filteredRateCards = filterRateCardsByChannel(targetMp, rateCards);
    return { success: true, rateCards: filteredRateCards };
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
