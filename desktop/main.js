import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { 
  decodeJwtPayload, 
  extractRoleFromToken, 
  isAuthorizedDesktopRole, 
  isAuthorizedMutationRole,
  validateDesktopTokenRole, 
  validateTokenRoleMatchesDatabase,
  filterRateCardsByChannel, 
  saveEncryptedCookies,
  loadEncryptedCookies,
  AUTHORIZED_ROLES, 
  FIREBASE_ROLE_CLAIM 
} from './authValidation.js';
import { verifyDesktopTokenAuthorization } from './authValidation.js';
import { getBrowserRuntime, requireChromeExecutable, withBrowserTask } from './browserRuntime.js';
import { createSessionAccess, publicSession } from './sessionAccess.js';
import { createStagedExtractionState, normalizeScrapedCards, selectStagedCards } from './scrapeResults.js';
import { isDesktopReachableDbUrl, sanitizeSavedDbUrl, selectDesktopDatabaseUrlForSession, storedDatabaseUrlForRole } from './dbUrlGuard.js';
import { closeDesktopPool, setDesktopDatabaseAccess } from './db.js';
import { scrapeFlipkartRateCards } from './portalScraper.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { app, BrowserWindow, ipcMain, dialog, Notification, shell, safeStorage } = require('electron');
const fs = require('fs');
const fsp = require('fs').promises;
const { Pool } = require('pg');

let mainWindow = null;
const stagedExtraction = createStagedExtractionState();
const USER_DATA_DIR = app.getPath('userData');
process.env.RECON_USER_DATA_DIR = USER_DATA_DIR;
const CONFIG_FILE = path.join(USER_DATA_DIR, 'worker-config.json');
const SESSION_FILE = path.join(USER_DATA_DIR, 'auth-session.json');
const COOKIES_PATH = path.join(USER_DATA_DIR, 'cookies.json');
process.env.RECON_COOKIES_PATH = COOKIES_PATH;
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
      const stored = JSON.parse(raw);
      const session = stored.encrypted ? JSON.parse(safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))) : stored;
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
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable. Authorization was not saved.');
    const encrypted = safeStorage.encryptString(JSON.stringify(sessionData)).toString('base64');
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ encrypted }), { mode: 0o600 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Staged extractions belong to the session that produced them. Any sign-out or
// sign-in drops them, and bumping the generation stops an in-flight scrape from
// staging results for a different account.
function clearAuthSession() {
  stagedExtraction.resetForAuthChange();
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
  // Role that provisioned databaseUrl. An analyst-provisioned URL is bound to
  // a read-only principal and must never be reused by privileged sessions.
  databaseUrlRole: '',
  scheduledHour: 6, // 06:00 AM
  scheduledMinute: 0,
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
      // Drop container-internal database URLs provisioned by old server builds (e.g. postgres:5432)
      if (parsed.databaseUrl) parsed.databaseUrl = sanitizeSavedDbUrl(parsed.databaseUrl);
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
    fs.mkdirSync(USER_DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f172a',
    title: 'ReconCentral Multi-Marketplace RateCard Automation & Scraper Worker',
    icon: path.join(__dirname, 'ui/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
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
  // Scheduled extraction follows the same login and review gates as manual runs.
  if (withBrowserTask.busy || !await authorizeSession()) return;
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
      if (withBrowserTask.busy) {
        if (mainWindow) mainWindow.webContents.send('scrape-progress', '⏰ Scheduled scrape skipped: another browser task is running.');
        return;
      }
      // A new run supersedes the previous staging; a failed run must not leave old cards syncable.
      stagedExtraction.cards = [];
      const jobAuthGeneration = stagedExtraction.authGeneration;
      const result = await withBrowserTask(() => executeScrapeProcess(config, (msg) => {
        if (mainWindow) mainWindow.webContents.send('scrape-progress', msg);
      }));

      // Re-verify the session AFTER the long browser run, then re-check the
      // generation: an account switch during that await must discard the results.
      const sessionStillValid = result.success && result.data?.length > 0 ? await authorizeSession() : false;
      if (sessionStillValid && jobAuthGeneration === stagedExtraction.authGeneration) {
        stagedExtraction.cards = normalizeScrapedCards(result.data);
        if (mainWindow) mainWindow.webContents.send('scrape-progress', 'Scheduled extraction staged. Review the results before database sync.');
      } else if (result.success && mainWindow) {
        mainWindow.webContents.send('scrape-progress', 'Scheduled extraction discarded: the account changed or the session ended during the run. Nothing was staged.');
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


// ── Interactive Human Login Flow (Multi-Marketplace) ─────────────────────────
async function executeInteractiveLogin(marketplace = 'flipkart_shopsy') {
  const puppeteer = getBrowserRuntime();

  const targetId = (typeof marketplace === 'string' ? marketplace : marketplace?.marketplace || marketplace?.id) || 'flipkart_shopsy';
  const mpConfig = SUPPORTED_MARKETPLACES.find(m => m.id === targetId || m.marketplace === targetId);
  if (!mpConfig) {
    const validIds = SUPPORTED_MARKETPLACES.map(m => m.id).join(', ');
    return { success: false, marketplace: targetId, error: `Unsupported marketplace channel: "${targetId}". Supported channels: ${validIds}` };
  }
  const cookiesPath = getMarketplaceCookiesPath(mpConfig.id);

  const browser = await puppeteer.launch({
    executablePath: requireChromeExecutable(),
    headless: false, // Visible window for human login / OTP
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    if (fs.existsSync(cookiesPath)) {
      const existing = loadEncryptedCookies(cookiesPath);
      if (existing && Array.isArray(existing) && existing.length > 0) {
        await page.setCookie(...existing);
      }
    } else if (fs.existsSync(COOKIES_PATH) && (mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart')) {
      const existing = loadEncryptedCookies(COOKIES_PATH);
      if (existing && Array.isArray(existing) && existing.length > 0) {
        await page.setCookie(...existing);
      }
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
    saveEncryptedCookies(cookiesPath, cookies);
    if (mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart') {
      saveEncryptedCookies(COOKIES_PATH, cookies);
    }
    console.log(`[InteractiveLogin] Logged in to ${mpConfig.name} successfully! Saved and encrypted ${cookies.length} session cookies in vault.`);

    await browser.close();
    return { success: true, marketplace: mpConfig.id, cookiesCount: cookies.length };
  } catch (err) {
    if (browser) await browser.close();
    return { success: false, marketplace: mpConfig?.id || targetId, error: err.message };
  }
}

// ── Automated Scraper Process (Supports Visible Chrome Mode) ──────────────────
async function executeScrapeProcess(config, onProgress) {
  return scrapeFlipkartRateCards(config, {
    onProgress,
    cookiesPath: getMarketplaceCookiesPath('flipkart_shopsy'),
    fallbackCookiesPath: COOKIES_PATH,
    stagingDir: STAGING_DIR
  });
}

const authorizeSession = createSessionAccess({
  load: loadAuthSession, save: saveAuthSession,
  refresh: refreshFirebaseIdToken, verify: verifyDesktopTokenAuthorization,
  onAuthorized: (session) => setDesktopDatabaseAccess(session.user.role, storedDatabaseUrlForRole(session.user.role, loadConfig()))
});
const PUBLIC_CHANNELS = new Set(['auth-login', 'auth-get-session', 'auth-logout']);
const MUTATION_CHANNELS = new Set(['save-config', 'sync-brand-rate-cards', 'upload-database-details']);

function registerHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame) {
      return { success: false, error: 'Untrusted desktop IPC sender.' };
    }
    try {
      if (!PUBLIC_CHANNELS.has(channel) && !await authorizeSession(MUTATION_CHANNELS.has(channel))) {
        return { success: false, error: 'Unauthorized: Sign in with an active ReconCentral account and the required role.' };
      }
      return await handler(event, ...args);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────
registerHandler('get-config', () => loadConfig());
registerHandler('save-config', (e, config) => {
  const stored = loadConfig();
  const merged = { ...stored, ...config };
  // A manually saved database URL is operator-entered: drop a stale analyst
  // read-only marker so the stored URL stays reusable by privileged roles.
  if (config && 'databaseUrl' in config && String(config.databaseUrl || '') !== String(stored.databaseUrl || '')) {
    merged.databaseUrlRole = '';
  }
  return saveConfig(merged);
});

// ── Authentication & Authorization IPC Handlers ─────────────────────────────
registerHandler('auth-login', async (e, { email, password, dbUrl }) => {
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
    let serverDatabaseUrl = '';
    let serverDatabaseAccess = '';

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
            serverDatabaseUrl = srvData.databaseUrl || '';
            serverDatabaseAccess = srvData.databaseAccess || '';
            const serverRole = String(srvData.user.role || '').trim().toLowerCase();
            if (serverRole === 'analyst') {
              // Do not retain a manually entered or legacy writer URL for analysts.
              provisionedDbUrl = '';
            } else if (srvData.databaseUrl && !dbUrl) {
              if (isDesktopReachableDbUrl(srvData.databaseUrl)) {
                provisionedDbUrl = srvData.databaseUrl;
              } else {
                // The API runs in Docker and may hand out its container-internal
                // DATABASE_URL (e.g. postgres:5432). Adopting it would brick DB
                // access with DNS errors, so it is ignored here.
                console.warn('[Desktop Auth] Ignored an unreachable database URL provisioned by the server. Set DESKTOP_DATABASE_URL on the API server, or configure the URL in Settings.');
              }
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
    const normalizedDbRole = String(dbUser.role || '').toLowerCase().trim();
    if (!authorizedRoles.includes(normalizedDbRole)) {
      return {
        success: false,
        error: `Access denied. Your role (${dbUser.role || 'viewer'}) is not authorized to operate rate card scrapers or synchronize database records. Contact an administrator.`
      };
    }

    // An analyst-provisioned read-only URL must never silently become a later
    // privileged session's URL: every write would fail on that principal.
    const sessionDatabaseUrl = selectDesktopDatabaseUrlForSession({
      role: normalizedDbRole,
      manualUrl: dbUrl,
      serverUrl: serverDatabaseUrl,
      serverAccess: serverDatabaseAccess
    }) || (normalizedDbRole === 'analyst' ? '' : storedDatabaseUrlForRole(normalizedDbRole, config));

    // Strict invariant: Ensure the session token carries a verified role claim matching the DB user's role
    let tokenMatch = validateTokenRoleMatchesDatabase(fbResult.idToken, normalizedDbRole);

    // If the token lacks the role claim OR doesn't match the DB user's role, attempt refresh
    if (!tokenMatch.valid && fbResult.refreshToken) {
      try {
        const refreshed = await refreshFirebaseIdToken(fbResult.refreshToken);
        if (refreshed && refreshed.idToken) {
          fbResult.idToken = refreshed.idToken;
          if (refreshed.refreshToken) fbResult.refreshToken = refreshed.refreshToken;
          tokenMatch = validateTokenRoleMatchesDatabase(fbResult.idToken, normalizedDbRole);
        }
      } catch (refErr) {
        console.warn('[Desktop Auth] Final token refresh warning:', refErr.message);
      }
    }

    if (!tokenMatch.valid) {
      return {
        success: false,
        error: `Authentication failed: The issued session token role ('${tokenMatch.tokenRole || 'none'}') does not match verified database role ('${normalizedDbRole}'). Please sign in through ReconCentral web app or verify user role in Admin Center.`
      };
    }

    const session = {
      authenticated: true,
      user: {
        id: dbUser.id,
        username: dbUser.username || userEmail.split('@')[0],
        email: dbUser.email || userEmail,
        role: normalizedDbRole,
        firebase_uid: firebaseUid
      },
      idToken: fbResult.idToken,
      refreshToken: fbResult.refreshToken,
      authorizedAt: new Date().toISOString()
    };

    if (normalizedDbRole === 'analyst' || (sessionDatabaseUrl && sessionDatabaseUrl !== config.databaseUrl)) {
      config.databaseUrl = sessionDatabaseUrl;
      // Remember which role provisioned this URL so a later session of a
      // different role cannot silently reuse it (analyst URLs are read-only).
      config.databaseUrlRole = sessionDatabaseUrl ? normalizedDbRole : '';
      const savedConfig = saveConfig(config);
      if (!savedConfig.success) return savedConfig;
    }
    stagedExtraction.resetForAuthChange();
    const savedSession = saveAuthSession(session);
    if (!savedSession.success) return savedSession;
    await closeDesktopPool();
    setDesktopDatabaseAccess(normalizedDbRole, sessionDatabaseUrl);

    // Honest signal for the UI: does the worker actually have a database URL?
    const databaseConfigured = Boolean(sessionDatabaseUrl);
    return { success: true, session: publicSession(session), databaseConfigured };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerHandler('get-marketplaces', () => {
  const list = SUPPORTED_MARKETPLACES.map(m => {
    const cookiesPath = getMarketplaceCookiesPath(m.id);
    let cookieCount = 0;
    let lastSavedAt = null;
    try {
      const stored = loadEncryptedCookies(cookiesPath);
      cookieCount = Array.isArray(stored) ? stored.length : 0;
      if (fs.existsSync(cookiesPath)) lastSavedAt = fs.statSync(cookiesPath).mtime.toISOString();
    } catch {}
    return {
      ...m,
      hasCookies: cookieCount > 0,
      cookieCount,
      lastSavedAt,
      cookiesPath
    };
  });
  return { success: true, marketplaces: list };
});

registerHandler('get-marketplace-accounts', async () => {
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

registerHandler('auth-get-session', async () => {
  const session = await authorizeSession();
  if (session) saveAuthSession(session);
  return publicSession(session);
});
registerHandler('auth-logout', async () => {
  clearAuthSession();
  await closeDesktopPool();
  setDesktopDatabaseAccess(null);
  return { success: true };
});

registerHandler('auth-verify-db', async (e, dbUrl) => {
  const { testDatabaseConnection } = await import('./db.js');
  return await testDatabaseConnection(dbUrl || storedDatabaseUrlForRole(loadAuthSession()?.user?.role, loadConfig()));
});

registerHandler('test-db-connection', async (e, dbUrl) => {
  const { testDatabaseConnection } = await import('./db.js');
  const result = await testDatabaseConnection(dbUrl || storedDatabaseUrlForRole(loadAuthSession()?.user?.role, loadConfig()));
  return { ...result, db: result.dbName };
});
registerHandler('interactive-login', async (e, marketplace) => {
  return await withBrowserTask(() => executeInteractiveLogin(marketplace));
});

registerHandler('start-scrape', async (e, options) => {
  if (withBrowserTask.busy) return { success: false, error: 'A browser task is already running.' };
  const config = loadConfig();
  const mergedOptions = { ...config, marketplace: options?.marketplace || config.marketplace, visible: options?.visible === true };
  const targetChannel = String(mergedOptions.marketplace || '').toLowerCase().trim();
  const mpConfig = SUPPORTED_MARKETPLACES.find(m => m.id === targetChannel || m.marketplace === targetChannel);
  if (mpConfig && !mpConfig.hasScraper) {
    return {
      success: false,
      error: `Scraper worker is not yet implemented for ${mpConfig.name}. Automated scrapers are currently active for Flipkart & Shopsy; other channels are scheduled for Phase 2.`
    };
  }
  // A new run supersedes the previous staging; a failed run must not leave old cards syncable.
  stagedExtraction.cards = [];
  const jobAuthGeneration = stagedExtraction.authGeneration;
  const result = await withBrowserTask(() => executeScrapeProcess(mergedOptions, (msg) => {
    if (mainWindow) mainWindow.webContents.send('scrape-progress', msg);
  }));
  if (!result.success) return result;
  // Re-verify the signed-in account AFTER the long browser run, then re-check the
  // generation: an account switch during that await must discard the results.
  const sessionStillValid = await authorizeSession();
  if (!sessionStillValid || jobAuthGeneration !== stagedExtraction.authGeneration) {
    return {
      success: false,
      error: 'The account changed or the session ended while the extraction was running. Results were discarded; run the extraction again.'
    };
  }
  try {
    stagedExtraction.cards = normalizeScrapedCards(result.data);
  } catch (stageErr) {
    return { success: false, error: `Extraction review staging failed: ${stageErr.message}` };
  }
  return { ...result, rateCards: stagedExtraction.cards };
});

// Brand & FSN Live Catalog Inspection
registerHandler('get-brand-fsn-catalog', async () => {
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { getRealTimeBrandFsnSamples } = await import('./rateCardService.js');
    const { getDesktopPool } = await import('./db.js');
    const pool = getDesktopPool(config.databaseUrl);
    const catalog = await getRealTimeBrandFsnSamples(pool);
    return { success: true, catalog };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Full Brand-Wise Preview (Flipkart & Shopsy)
registerHandler('get-ratecard-preview', async (e, options = {}) => {
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { buildBrandRateCardSet } = await import('./rateCardService.js');
    const { getDesktopPool } = await import('./db.js');
    // Staged extractions are reviewable without a database; templates need one.
    const rateCards = stagedExtraction.cards.length
      ? stagedExtraction.cards
      : await buildBrandRateCardSet(getDesktopPool(config.databaseUrl));
    const targetMp = options.marketplace || options.channel || '';
    const filteredRateCards = filterRateCardsByChannel(targetMp, rateCards);
    return { success: true, rateCards: filteredRateCards, canSync: stagedExtraction.cards.length > 0 };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Change Detection against PostgreSQL
registerHandler('detect-brand-rate-changes', async (e, brandRateCards) => {
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { detectBrandRateChanges } = await import('./rateCardService.js');
    const { getDesktopPool } = await import('./db.js');
    const pool = getDesktopPool(config.databaseUrl);
    const changes = await detectBrandRateChanges(brandRateCards, pool);
    return { success: true, changes };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Synchronize to Database
registerHandler('sync-brand-rate-cards', async (e, brandRateCards, options = {}) => {
  // The reviewed preview may be channel-filtered, so any exact subset of the staged cards is accepted.
  const cardsToSync = selectStagedCards(stagedExtraction.cards, brandRateCards);
  if (!cardsToSync) {
    return { success: false, error: 'Run a successful extraction and review its staged results before committing. Generated templates cannot be synced as live rates.' };
  }
  const session = loadAuthSession();
  if (!session || !session.authenticated || !isAuthorizedMutationRole(session?.user?.role)) {
    return { success: false, error: 'Unauthorized: Active ReconCentral operator or admin session required for database sync.' };
  }
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { syncBrandRateCardsToDatabase } = await import('./rateCardService.js');
    const { getDesktopPool } = await import('./db.js');
    const pool = getDesktopPool(config.databaseUrl);
    const result = await syncBrandRateCardsToDatabase(cardsToSync, { forceUpdate: true, ...options }, pool);
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Export 6-Sheet Desktop Excel (.xlsx)
registerHandler('export-desktop-excel', async (e, customPath) => {
  const session = loadAuthSession();
  if (!session || !session.authenticated || !isAuthorizedDesktopRole(session?.user?.role)) {
    return { success: false, error: 'Unauthorized: Active ReconCentral session required.' };
  }
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { generateBrandwiseRateCardExcel, DEFAULT_EXCEL_PATH } = await import('./excelExport.js');
    const { getDesktopPool } = await import('./db.js');
    const pool = getDesktopPool(config.databaseUrl);
    const targetPath = customPath || DEFAULT_EXCEL_PATH;
    const result = await generateBrandwiseRateCardExcel(targetPath, pool);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open File in Native App (Excel)
registerHandler('open-excel-file', async (e, targetPath) => {
  try {
    const { DEFAULT_EXCEL_PATH } = await import('./excelExport.js');
    let filePath = targetPath || DEFAULT_EXCEL_PATH;
    if (!fs.existsSync(filePath)) {
      const jsonAlt = filePath.replace(/\.xlsx$/, '.json');
      if (fs.existsSync(jsonAlt)) filePath = jsonAlt;
    }
    if (fs.existsSync(filePath)) {
      await shell.openPath(filePath);
      return { success: true, filePath };
    }
    return { success: false, error: `File not found on disk: ${filePath}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Extensible: Download Database Details (Orders, RateCards, Returns)
registerHandler('download-database-details', async (e, tableName, options = {}) => {
  const session = loadAuthSession();
  if (!session || !session.authenticated || !isAuthorizedDesktopRole(session?.user?.role)) {
    return { success: false, error: 'Unauthorized: Active ReconCentral operator or admin session required.' };
  }
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { downloadTableDetails, ALLOWED_TABLES } = await import('./db.js');
    const safeTable = typeof tableName === 'string' ? tableName.trim().toLowerCase() : '';
    if (!ALLOWED_TABLES.has(safeTable)) {
      throw new Error(`Table "${tableName}" is not allowed for desktop query.`);
    }
    const safeOptions = {
      filters: options?.filters && typeof options.filters === 'object' && !Array.isArray(options.filters) ? options.filters : {},
      orderBy: typeof options?.orderBy === 'string' ? options.orderBy.trim() : 'id DESC',
      limit: Math.min(Math.max(1, parseInt(options?.limit, 10) || 500), 5000)
    };
    const data = await downloadTableDetails(safeTable, safeOptions);
    return { success: true, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Extensible: Upload Database Updates / Upserts
registerHandler('upload-database-details', async (e, tableName, rows = [], keyColumns = ['id']) => {
  const session = loadAuthSession();
  if (!session || !session.authenticated || !isAuthorizedMutationRole(session?.user?.role)) {
    return { success: false, error: 'Unauthorized: Active ReconCentral operator or admin session required.' };
  }
  const config = loadConfig();
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  try {
    const { uploadTableUpdates, ALLOWED_TABLES } = await import('./db.js');
    const safeTable = typeof tableName === 'string' ? tableName.trim().toLowerCase() : '';
    if (!ALLOWED_TABLES.has(safeTable)) {
      throw new Error(`Table "${tableName}" is not allowed for desktop upload.`);
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return { success: true, updated: 0 };
    }
    const safeKeyColumns = (Array.isArray(keyColumns) ? keyColumns : ['id']).filter(k => typeof k === 'string');
    const result = await uploadTableUpdates(safeTable, rows, safeKeyColumns);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

registerHandler('export-file', async (e, format, data) => {
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
