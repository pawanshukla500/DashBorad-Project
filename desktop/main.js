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
  deleteEncryptedCookies,
  clearEncryptedCookieSnapshot,
  decryptMarketplaceCredential,
  AUTHORIZED_ROLES, 
  FIREBASE_ROLE_CLAIM 
} from './authValidation.js';
import { verifyDesktopTokenAuthorization } from './authValidation.js';
import { focusBrowserPage, getBrowserRuntime, requireChromeExecutable, withBrowserTask } from './browserRuntime.js';
import { createSessionAccess, publicSession } from './sessionAccess.js';
import { createStagedExtractionState, normalizeScrapedCards, selectStagedCards } from './scrapeResults.js';
import { isDesktopReachableDbUrl, sanitizeSavedDbUrl, selectDesktopDatabaseUrlForSession, storedDatabaseUrlForRole } from './dbUrlGuard.js';
import { closeDesktopPool, setDesktopDatabaseAccess } from './db.js';
import { createStructuredLogger } from './structuredLogger.js';
import { captureScrapeFailure } from './scrapeDiagnostics.js';
import { scrapeFlipkartRateCards } from './portalScraper.js';
import { readSellerHubProfileState, writeSellerHubProfileState } from './portalProfileState.js';
import { invokeProgressSafely } from './safeProgress.js';
import { createWorkerEngine } from './workerEngine.js';
import { portalPartition, isFlipkartAuthenticated, FLIPKART_MANUAL_LOGIN_URL } from './portalSession.js';
import { waitForFlipkartAuthenticatedPage } from './portalLoginWaiter.js';
import { createEmbeddedPage, createEmbeddedRuntime, DEFAULT_EDGE_USER_AGENT } from './embeddedBrowser.js';
import { createManualLoginWindowManager, normalizeElectronSessionCookies } from './manualLoginWindow.js';
import { createExternalBrowserSession } from './externalBrowserSession.js';
import { missingFsnCategoriesForMarketplace, resolveFsnBackedScrapeVerticals, resolveScrapeVerticals } from './fsnPlan.js';
import { persistDesktopUserDataDirChoice, resolveFlipkartBrowserProfileDir } from './userDataPaths.js';
import {
  getActiveBackendUrl,
  getCandidateServers,
  fetchConfiguredVerticals,
  registerWorkerWithBackend,
  sendWorkerHeartbeat,
  claimNextWorkerJob,
  releaseClaimedWorkerJob,
  reportJobProgress,
  reportJobFailure,
  submitJobResults,
  fetchBrandCatalogFromApi,
  detectRateChangesViaApi,
  publishJobViaApi,
  reviewRatesViaApi, publishReviewedRatesViaApi
} from './workerClient.js';
import {
  getStagingDb,
  saveStagedJob,
  saveStagedObservations,
  getStagedObservations,
  markStagedJobStatus,
  clearStagedJob,
  stageReview, recoverReview, supersedeReviews
} from './localStaging.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { app, BrowserWindow, ipcMain, dialog, Notification, shell, safeStorage, session: electronSession } = require('electron');
const fs = require('fs');
const fsp = require('fs').promises;
const { Pool } = require('pg');

let mainWindow = null;
const smokeOutput = process.argv.find(arg => arg.startsWith('--ratecard-smoke-test='))?.slice('--ratecard-smoke-test='.length);
const userDataOverride = process.env.RECONCENTRAL_USER_DATA || process.env.RECON_USER_DATA_DIR;
if (smokeOutput) {
  const profile = path.resolve(`${smokeOutput}.profile`);
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
} else {
  app.setPath('userData', persistDesktopUserDataDirChoice());
}
const stagedExtraction = createStagedExtractionState();
const USER_DATA_DIR = app.getPath('userData');
process.env.RECON_USER_DATA_DIR = USER_DATA_DIR;
const FLIPKART_BROWSER_PROFILE_DIR = resolveFlipkartBrowserProfileDir({
  userDataDir: USER_DATA_DIR,
  allowLegacyProfile: !smokeOutput && !userDataOverride
});
process.env.RECON_FLIPKART_PROFILE_DIR = FLIPKART_BROWSER_PROFILE_DIR;
const CONFIG_FILE = path.join(USER_DATA_DIR, 'worker-config.json');
const SESSION_FILE = path.join(USER_DATA_DIR, 'auth-session.json');
const COOKIES_PATH = path.join(USER_DATA_DIR, 'cookies.json');
process.env.RECON_COOKIES_PATH = COOKIES_PATH;
const STAGING_DIR = path.join(USER_DATA_DIR, 'staging');
const DIAGNOSTICS_DIR = path.join(STAGING_DIR, 'diagnostics');
const desktopLogger = createStructuredLogger(DIAGNOSTICS_DIR);
desktopLogger.installConsoleBridge();
desktopLogger.info('app.started', 'Desktop worker started.', { version: app.getVersion(), platform: process.platform });

function persistReview(cards, session, coverage = null) {
  const id = `review-${Date.now()}-${require('crypto').randomUUID()}`;
  stageReview(getStagingDb(USER_DATA_DIR), id, session.user.firebase_uid, cards[0].marketplace, cards, { coverage });
  stagedExtraction.cards = cards;
  stagedExtraction.coverage = coverage;
  stagedExtraction.review = null;
}

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
    // Keep only Flipkart's encrypted snapshot on ReconCentral sign-out. The
    // persistent Flipkart partition is intentionally kept; Reset Cookies is
    // the explicit action that clears Seller Hub authentication.
    const cookiesDir = path.join(USER_DATA_DIR, 'cookies');
    const flipkartCookiesPath = getMarketplaceCookiesPath('flipkart_shopsy');
    if (fs.existsSync(cookiesDir)) {
      for (const name of fs.readdirSync(cookiesDir)) {
        const file = path.join(cookiesDir, name);
        if (file !== flipkartCookiesPath) {
          try { fs.unlinkSync(file); } catch {}
        }
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Default Configuration with Flipkart & Shopsy Verticals and Brands
// NOTE: Database credentials are never hardcoded in the installer bundle.
// They are securely provisioned over TLS upon successful Firebase authentication & role verification.
const CANDIDATE_API_SERVERS = getCandidateServers();

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
  if (['flipkart','shopsy','both','flipkart_shopsy'].includes(marketplace)) marketplace = 'flipkart_shopsy';
  const safeId = String(marketplace).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const dir = path.join(USER_DATA_DIR, 'cookies');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `cookies_${safeId}.json`);
}

function loadMarketplaceCookieSnapshot(filePath, marketplace, operation) {
  return loadEncryptedCookies(filePath, {
    onInvalidRecords: discardedRecords => desktopLogger.warn(
      'portal.cookies.invalid_records_skipped',
      'Ignored malformed saved cookie records before restoring the marketplace session.',
      { marketplace, operation, sourceFile: path.basename(filePath), discardedRecords }
    )
  });
}

function getMarketplaceBrowserProfilePath(marketplace = 'flipkart_shopsy') {
  const normalized = ['flipkart', 'shopsy', 'both', 'flipkart_shopsy'].includes(marketplace)
    ? 'flipkart_shopsy'
    : String(marketplace).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (normalized === 'flipkart_shopsy') return FLIPKART_BROWSER_PROFILE_DIR;
  return path.join(USER_DATA_DIR, 'browser-profiles', normalized);
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
  // Category scope is discovered from the authenticated backend at run time.
  selectedVerticals: [],
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
      if (parsed.databaseUrl) {
        parsed.databaseUrl = sanitizeSavedDbUrl(parsed.databaseUrl);
      }
      // The environment-derived default is sanitized too: a container-internal
      // DATABASE_URL (postgres:5432) must never reach the pool logic, even
      // when the config file is missing or predates the databaseUrl key.
      const effectiveDatabaseUrl = ('databaseUrl' in parsed && parsed.databaseUrl)
        ? parsed.databaseUrl
        : sanitizeSavedDbUrl(DEFAULT_CONFIG.databaseUrl);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        databaseUrl: effectiveDatabaseUrl,
        accounts: { ...DEFAULT_CONFIG.accounts, ...(parsed.accounts || {}) }
      };
    }
  } catch (err) {
    console.error('Failed to read config:', err);
  }
  return { ...DEFAULT_CONFIG, databaseUrl: sanitizeSavedDbUrl(DEFAULT_CONFIG.databaseUrl) };
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

// ── Auto-Update (GitHub Releases feed) ───────────────────────────────────────
// Keeps the installed desktop app on the latest published release: it checks
// shortly after launch and every 6 hours, downloads in the background, then
// notifies through an in-app banner and a native toast. The download is also
// applied automatically on the next quit if the user ignores the prompt.
const UPDATE_STATUS_CHANNEL = 'update-status';
let autoUpdater = null;         // electron-updater instance (packaged builds only)
let pendingUpdateVersion = '';   // version of the update currently being downloaded
let lastUpdateStatus = { status: 'idle' };

function broadcastUpdateStatus(status) {
  lastUpdateStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(UPDATE_STATUS_CHANNEL, status);
  }
}

function loadAutoUpdater() {
  // Updates ship only for packaged installs, and only for platforms a real
  // update feed is published for: the release workflow publishes the Windows
  // latest.yml feed (NSIS installer). Linux GUI packages are artifacts only —
  // there is no latest-linux.yml, so checking there would surface recurring
  // feed errors instead of updates.
  if (!app.isPackaged || process.platform !== 'win32') return null;
  try {
    return require('electron-updater').autoUpdater;
  } catch (err) {
    console.warn(`[AutoUpdate] Unavailable: ${err.message}`);
    return null;
  }
}

function checkForAppUpdate() {
  if (!autoUpdater) return Promise.resolve(false);
  // Failures also flow to the 'error' event; the catch keeps an offline
  // machine from surfacing an unhandled rejection at startup.
  return autoUpdater.checkForUpdates().then(() => true).catch((err) => {
    console.warn(`[AutoUpdate] Check failed: ${err.message}`);
    broadcastUpdateStatus({ status: 'error', message: err.message });
    return false;
  });
}

function setupAutoUpdate() {
  autoUpdater = loadAutoUpdater();
  if (!autoUpdater) return;

  autoUpdater.autoDownload = true;          // fetch in the background as soon as an update is found
  autoUpdater.autoInstallOnAppQuit = true;  // an ignored prompt still applies on the next quit

  autoUpdater.on('checking-for-update', () => broadcastUpdateStatus({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    pendingUpdateVersion = info?.version || '';
    broadcastUpdateStatus({ status: 'available', version: pendingUpdateVersion });
  });
  autoUpdater.on('update-not-available', () => broadcastUpdateStatus({ status: 'not-available' }));
  autoUpdater.on('download-progress', (progress) => broadcastUpdateStatus({
    status: 'downloading',
    version: pendingUpdateVersion,
    percent: Math.round(progress?.percent || 0)
  }));
  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdateVersion = info?.version || pendingUpdateVersion;
    broadcastUpdateStatus({ status: 'downloaded', version: pendingUpdateVersion });
    if (Notification.isSupported()) {
      new Notification({
        title: 'ReconCentral RateCard Worker — update ready',
        body: `Version ${pendingUpdateVersion} is downloaded. Restart the app to apply it.`
      }).show();
    }
  });
  autoUpdater.on('error', (err) => broadcastUpdateStatus({
    status: 'error',
    message: String(err?.message || err)
  }));

  // First check shortly after launch (after sign-in and UI settle), then every 6 hours.
  setTimeout(() => { checkForAppUpdate(); }, 10 * 1000);
  setInterval(() => { checkForAppUpdate(); }, 6 * 60 * 60 * 1000);
}

// Windows groups the app's native toasts (update ready, scheduled scrape
// done) under this identity; it must match build.appId in package.json.
app.setAppUserModelId('com.reconcentral.ratecardworker');

app.whenReady().then(async () => {
  createWindow();
  if (smokeOutput) {
    const { runPackagedSmoke } = await import('./packagedSmoke.js');
    await runPackagedSmoke({ app, window: mainWindow, output: path.resolve(smokeOutput), nativeImage: require('electron').nativeImage,
      getBounds: getMonitorViewBounds, setPage: page => { activeEmbeddedPage = page; } });
    return;
  }
  setupAutoUpdate();
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  try {
    const defaultCookiesPath = getMarketplaceCookiesPath('flipkart_shopsy');
    if (!fs.existsSync(defaultCookiesPath)) loadMarketplaceCookieSnapshot(defaultCookiesPath, 'flipkart_shopsy', 'startup_migration');
    if (!fs.existsSync(COOKIES_PATH)) loadMarketplaceCookieSnapshot(COOKIES_PATH, 'flipkart_shopsy', 'startup_migration');
  } catch {}

  try {
    const session = await authorizeSession();
    if (session?.authenticated) {
      saveAuthSession(session);
      startWorkerEngine(session).catch(e => console.warn('[Worker Engine] Startup engine error:', e.message));
    }
  } catch (err) {
    const fallbackSession = loadAuthSession();
    if (fallbackSession?.authenticated) {
      startWorkerEngine(fallbackSession).catch(() => {});
    }
  }

  // Start background scheduler check; a rejected run (e.g. token refresh
  // during a network outage) is logged, never surfaced as an unhandled rejection.
  setInterval(() => { checkDailySchedule().catch((err) => console.warn(`[Scheduler] Run skipped: ${err.message}`)); }, 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let allowQuitWithExternalBrowserClosed = false;
let externalBrowserShutdownPending = false;
app.on('before-quit', event => {
  if (allowQuitWithExternalBrowserClosed) return;
  if (externalBrowserShutdownPending) {
    event.preventDefault();
    return;
  }
  if (!externalBrowserSession.hasBrowser()) return;
  event.preventDefault();
  externalBrowserShutdownPending = true;
  externalBrowserSession.close({ reason: 'app-quit' }).then(() => {
    allowQuitWithExternalBrowserClosed = true;
    app.quit();
  }).catch(err => {
    externalBrowserShutdownPending = false;
    desktopLogger.error('portal.browser.shutdown_failed', err, {});
  });
});

// ── Distributed Worker Engine & Background Job Consumer ─────────────────────
let isWorkerExecutingJob = false;
const WORKER_ID = `worker-${process.platform}-${require('os').hostname().replace(/[^a-zA-Z0-9-]/g, '')}`;
const workerEngine = createWorkerEngine({
  getSession: async () => {
    const session = loadAuthSession();
    const payload = decodeJwtPayload(session?.idToken);
    return payload?.exp * 1000 > Date.now() + 30000 ? session : await authorizeSession();
  },
  register: session => registerWorkerWithBackend(session, { id: WORKER_ID,
    name: `${session.user?.name || 'Desktop'} (${require('os').hostname()})`, version: app.getVersion(),
    platform: process.platform, capabilities: ['flipkart','shopsy'], metadata: { arch: process.arch } }),
  heartbeat: (session, status) => sendWorkerHeartbeat(session, WORKER_ID, status),
  claim: session => claimNextWorkerJob(session, WORKER_ID),
  releaseClaim: (session, job) => releaseClaimedWorkerJob(session, job, WORKER_ID),
  execute: executeBackgroundWorkerJob,
  isBusy: () => withBrowserTask.busy || isWorkerExecutingJob,
  log: event => console.log(JSON.stringify({ ...event, worker: WORKER_ID }))
});
const startWorkerEngine = session => session?.authenticated ? workerEngine.start() : Promise.resolve();
const stopWorkerEngine = () => workerEngine.stop();

async function executeBackgroundWorkerJob(session, job) {
  let db = null;
  const authGeneration = stagedExtraction.authGeneration;

  try {
    isWorkerExecutingJob = true;
    db = getStagingDb(USER_DATA_DIR);
    saveStagedJob(db, {
      id: `job-${job.id}`,
      remote_job_id: job.id,
      marketplace: job.marketplace,
      seller_account: job.seller_account,
      status: 'claimed',
      parameters: job.parameters
    });

    await reportJobProgress(session, job.id, 10, 'Worker claimed job. Preparing browser extraction...');
    if (mainWindow) {
      mainWindow.webContents.send('scrape-progress', `📥 Processing remote web job #${job.id} (${job.marketplace})...`);
    }

    const scrapeRes = await withBrowserTask(async () => {
      return await executeScrapeProcess({
        marketplace: job.marketplace,
        seller_account: job.seller_account || job.parameters?.seller_account || 'default',
        scopeVerticals: job.parameters?.verticals,
        brand: job.parameters?.brand,
        requireCompleteCoverage: true,
        // Remote jobs use the persistent visible Chrome profile too, so an
        // expired Seller Hub session can be completed manually in-place.
        visible: true
      }, async (msg) => {
        if (mainWindow) mainWindow.webContents.send('scrape-progress', msg);
        try {
          await reportJobProgress(session, job.id, 40, msg);
        } catch (progErr) {
          if (progErr.message?.includes('409') || progErr.message?.includes('JOB_NOT_RUNNING')) {
            throw new Error('Job was cancelled by server');
          }
        }
      });
    });

    if (!scrapeRes.success) {
      throw new Error(scrapeRes.error || 'Scrape failed');
    }
    if (scrapeRes.coverage?.complete === false) {
      throw new Error(`Remote worker results were not submitted because configured categories have no database FSNs: ${scrapeRes.coverage.unavailableConfiguredVerticals.join(', ')}.`);
    }

    const normalizedCards = normalizeScrapedCards(scrapeRes.data);
    if (authGeneration !== stagedExtraction.authGeneration) throw new Error('The account changed during extraction. Results were not submitted.');

    // Stage in local SQLite
    saveStagedObservations(db, `job-${job.id}`, normalizedCards);
    markStagedJobStatus(db, `job-${job.id}`, 'staged_locally');
    await reportJobProgress(session, job.id, 80, 'Observations staged in SQLite. Submitting to ReconCentral...');

    // Recheck after awaited progress and again inside the client after URL discovery.
    if (authGeneration !== stagedExtraction.authGeneration) throw new Error('The account changed during extraction. Results were not submitted.');
    const submitRes = await submitJobResults(session, job.id, normalizedCards, WORKER_ID, () => authGeneration === stagedExtraction.authGeneration);
    markStagedJobStatus(db, `job-${job.id}`, 'completed');
    // Keep the durable local observations available for review and recovery.
    if (mainWindow) {
      mainWindow.webContents.send('scrape-progress', `✓ Remote job #${job.id} completed. Diff count: ${submitRes.diffResult?.diffCount || 0}`);
    }

  } catch (err) {
    console.error(`[Worker Engine] Job ${job.id} failed:`, err.message);
    if (db) {
      try { markStagedJobStatus(db, `job-${job.id}`, 'failed'); } catch {}
    }
    await reportJobFailure(session, job.id, err.message, 'SCRAPE_ERROR', WORKER_ID).catch(() => {});
  } finally {
    isWorkerExecutingJob = false;
  }
}

// ── Daily Scheduler ─────────────────────────────────────────────────────────
let lastRunDate = '';
async function checkDailySchedule() {
  // Scheduled extraction follows the same login and review gates as manual
  // runs. A session verification that REJECTS (token refresh during a network
  // outage) skips the run instead of surfacing as an unhandled rejection.
  let authorized = false;
  try {
    authorized = await authorizeSession();
  } catch (err) {
    console.warn(`[Scheduler] Session verification failed, skipping scheduled run: ${err.message}`);
    return;
  }
  if (withBrowserTask.busy || !authorized) return;
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
      stagedExtraction.coverage = null;
      stagedExtraction.review = null;
      supersedeReviews(getStagingDb(USER_DATA_DIR), loadAuthSession().user.firebase_uid);
      const jobAuthGeneration = stagedExtraction.authGeneration;
      const result = await withBrowserTask(() => executeScrapeProcess(config, (msg) => {
        if (mainWindow) mainWindow.webContents.send('scrape-progress', msg);
      }));

      // Re-verify the session AFTER the long browser run, then re-check the
      // generation: an account switch during that await must discard the results.
      const sessionStillValid = result.success && result.data?.length > 0 ? await authorizeSession() : false;
      if (sessionStillValid && jobAuthGeneration === stagedExtraction.authGeneration) {
        persistReview(normalizeScrapedCards(result.data), sessionStillValid, result.coverage || null);
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


// ── Live Browser Monitor & Embedded View Management ────────────────────────
let activeEmbeddedPage = null;
let activeExternalPage = null;
const externalBrowserSession = createExternalBrowserSession({
  onPage: page => { activeExternalPage = page; },
  onLifecycle: (event, details) => {
    const write = event === 'disconnected' ? desktopLogger.warn : desktopLogger.info;
    const { profileKey, ...context } = details || {};
    if (profileKey) context.profile = path.basename(profileKey);
    write.call(desktopLogger, `portal.browser.${event}`, 'External Seller Hub browser lifecycle.', context);
  }
});
let currentBrowserEngine = 'external'; // external Chrome owns the durable manual-login profile by default
let monitorState = {
  active: false,
  engine: 'external',
  visible: false,
  url: '',
  title: '',
  status: 'idle', // 'idle' | 'navigating' | 'extracting' | 'login_prompt' | 'completed' | 'error'
  marketplace: 'flipkart_shopsy',
  lastScreenshot: null,
  updatedAt: new Date().toISOString()
};

function broadcastMonitorState(patch = {}) {
  monitorState = { ...monitorState, ...patch, engine: patch.engine || currentBrowserEngine, updatedAt: new Date().toISOString() };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser-monitor-update', monitorState);
  }
}

function reportFlipkartLoginState(state, { marketplace = 'flipkart_shopsy', operation = 'manual_login', onProgress, profileDir } = {}) {
  const messages = {
    username: 'Seller Hub is waiting for the seller account ID, email, or phone number. Enter it and click Next.',
    password: 'Seller Hub is waiting for the account password. Submit using Login in the sign-in modal.',
    challenge: 'Seller Hub requested an extra verification step. Complete it manually in Chrome; extraction continues only after dashboard verification.',
    public_return_pending: 'Seller Hub returned to its public page. Checking whether sign-in is still completing in another tab...',
    public_return: 'Seller Hub returned to its public landing page after the sign-in form closed. No authenticated session was detected; nothing was staged.'
  };
  const message = messages[state?.stage];
  if (!message) return;
  if (state.stage === 'public_return' && state.returnConfirmed === true && profileDir) {
    try { writeSellerHubProfileState(profileDir, 'signed_out'); } catch (error) {
      desktopLogger.warn('portal.login.profile_state_write_failed', 'Could not record the Seller Hub signed-out state.', {
        marketplace, operation, errorName: error?.name || 'Error'
      });
    }
  }
  const context = {
    marketplace,
    operation,
    stage: state.stage,
    host: state.host,
    path: state.path,
    loginFormVisible: Boolean(state.loginFormVisible),
    challengeVisible: Boolean(state.challengeVisible)
  };
  const writer = state.stage === 'public_return' ? desktopLogger.warn : desktopLogger.info;
  writer.call(desktopLogger, 'portal.login.state', 'Observed Seller Hub sign-in progress.', context);
  broadcastMonitorState({
    active: true,
    status: 'login_prompt',
    engine: 'external',
    marketplace,
    url: `https://${state.host}${state.path}`,
    title: 'Seller Hub sign-in',
    progressMessage: message
  });
  try {
    if (typeof onProgress === 'function') {
      void invokeProgressSafely(onProgress, message, error => {
        desktopLogger.warn('portal.login.progress_callback_failed', 'Could not report Seller Hub sign-in progress.', {
          marketplace, operation, stage: state.stage, errorName: error?.name || 'Error'
        });
      });
    }
    else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('scrape-progress', message);
  } catch {}
}

let manualFlipkartLoginManager = null;
function getManualFlipkartLoginManager() {
  if (manualFlipkartLoginManager) return manualFlipkartLoginManager;
  const portalSession = electronSession.fromPartition(portalPartition('flipkart_shopsy'));
  manualFlipkartLoginManager = createManualLoginWindowManager({
    BrowserWindow,
    portalSession,
    isAuthenticated: async webContents => {
      if (!webContents || webContents.isDestroyed?.()) return false;
      try {
        return await webContents.executeJavaScript(`(${isFlipkartAuthenticated.toString()})()`, true) === true;
      } catch {
        return false;
      }
    },
    readCookies: async session => normalizeElectronSessionCookies(
      await session.cookies.get({ url: FLIPKART_MANUAL_LOGIN_URL })
    ),
    saveCookies: async cookies => {
      const marketplacePath = getMarketplaceCookiesPath('flipkart_shopsy');
      if (!cookies.length) {
        // A Seller Hub session can also live in persistent web storage. Never
        // retain an older encrypted cookie snapshot when the live store is empty.
        deleteEncryptedCookies(marketplacePath);
        deleteEncryptedCookies(COOKIES_PATH);
        writeSellerHubProfileState(getMarketplaceBrowserProfilePath('flipkart_shopsy'), 'signed_out');
        return;
      }
      saveEncryptedCookies(marketplacePath, cookies);
      saveEncryptedCookies(COOKIES_PATH, cookies);
      writeSellerHubProfileState(getMarketplaceBrowserProfilePath('flipkart_shopsy'), 'snapshot_available');
    },
    onState: state => {
      if (state.status === 'login_prompt') {
        try { activeEmbeddedPage?.setVisible(false); } catch {}
      } else if (state.status === 'completed') {
        try { activeEmbeddedPage?.setVisible(true); } catch {}
      }
      broadcastMonitorState(state);
      if (state.progressMessage && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scrape-progress', state.progressMessage);
      }
    },
    log: (level, event, details) => {
      const writer = desktopLogger[level] || desktopLogger.info;
      writer.call(desktopLogger, event, 'Manual Seller Hub login lifecycle.', details);
    }
  });
  return manualFlipkartLoginManager;
}

async function openManualFlipkartLogin({ onProgress = () => {}, waitMs } = {}) {
  const manager = getManualFlipkartLoginManager();
  onProgress(`Opening Seller Hub at ${FLIPKART_MANUAL_LOGIN_URL}. Click Login, complete sign-in manually, and leave the window open until the dashboard is verified.`);
  broadcastMonitorState({
    active: true,
    status: 'login_prompt',
    engine: 'manual-login-window',
    marketplace: 'flipkart_shopsy',
    url: FLIPKART_MANUAL_LOGIN_URL,
    title: 'Flipkart Seller Hub — Manual Sign-in'
  });
  const result = await manager.open({ waitMs });
  if (result.success) {
    onProgress(`✓ Seller Hub login verified. Persistent session saved (${result.cookiesCount} cookies captured).`);
  } else {
    onProgress(result.error || 'Seller Hub login is still pending in the separate sign-in window.');
  }
  return result;
}

let currentDockBounds = null;
function getMonitorViewBounds() {
  return currentDockBounds || { x: 0, y: 0, width: 0, height: 0 };
}
// ── Interactive Human Login Flow (Multi-Marketplace) ─────────────────────────
async function executeInteractiveLogin(marketplace = 'flipkart_shopsy') {
  const targetId = (typeof marketplace === 'string' ? marketplace : marketplace?.marketplace || marketplace?.id) || 'flipkart_shopsy';
  const mpConfig = SUPPORTED_MARKETPLACES.find(m => m.id === targetId || m.marketplace === targetId);
  if (!mpConfig) {
    const validIds = SUPPORTED_MARKETPLACES.map(m => m.id).join(', ');
    return { success: false, marketplace: targetId, error: `Unsupported marketplace channel: "${targetId}". Supported channels: ${validIds}` };
  }
  const cookiesPath = getMarketplaceCookiesPath(mpConfig.id);
  const isFlipkart = mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart';
  const manualLoginUrl = isFlipkart ? FLIPKART_MANUAL_LOGIN_URL : mpConfig.loginUrl;

  if ((mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart') && currentBrowserEngine === 'embedded') {
    // Flipkart and Shopsy share one durable Seller Hub session. Always give
    // the operator a clean root page in a visible window and leave every login
    // action (including the site's Login control and OTP prompts) manual.
    return {
      ...(await openManualFlipkartLogin({ waitMs: 5000 })),
      marketplace: mpConfig.id
    };
  }

  if (currentBrowserEngine === 'embedded' && mainWindow && !mainWindow.isDestroyed()) {
    broadcastMonitorState({ active: true, status: 'navigating', marketplace: mpConfig.id, url: manualLoginUrl });
    const partition = portalPartition(mpConfig.id);
    const page = createEmbeddedPage({
      window: mainWindow,
      partition,
      bounds: () => getMonitorViewBounds(),
      onState: state => broadcastMonitorState(state),
      visible: true
    });
    activeEmbeddedPage = page;
    try {
      if (fs.existsSync(cookiesPath)) {
        const existing = loadMarketplaceCookieSnapshot(cookiesPath, mpConfig.id, 'embedded_login');
        if (existing?.length) await page.setCookie(...existing);
      } else if (fs.existsSync(COOKIES_PATH) && (mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart')) {
        const existing = loadMarketplaceCookieSnapshot(COOKIES_PATH, mpConfig.id, 'embedded_login');
        if (existing?.length) await page.setCookie(...existing);
      }

      console.log(`[InteractiveLogin:Embedded] Opening ${mpConfig.name} at ${mpConfig.loginUrl}...`);
      try {
        await page.goto(manualLoginUrl, { waitUntil: 'load', timeout: 60000 });
      } catch (gotoErr) {
        if (!String(gotoErr?.message || '').includes('ERR_ABORTED')) throw gotoErr;
      }

      broadcastMonitorState({ status: 'login_prompt', url: page.url(), title: page.title() });

      const pollAuth = async () => {
        const deadline = Date.now() + 300000; // 5 minute human login window
        while (Date.now() < deadline) {
          let authState = false;
          try {
            authState = mpConfig.id === 'flipkart_shopsy' ? await page.evaluate(isFlipkartAuthenticated) : await page.evaluate((id) => {
              const href = window.location.href.toLowerCase();
              const body = document.body ? document.body.innerText.toLowerCase() : '';
              const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
              const hasLoginForm = Boolean(document.querySelector('form[action*="login"], form[action*="signin"]'));
              if (hasPasswordInput || hasLoginForm) return false;
              if (id.startsWith('myntra')) {
                return href.includes('partnerportal') && (href.includes('dashboard') || href.includes('home') || body.includes('logout') || body.includes('seller id'));
              }
              if (id === 'meesho') {
                const notLogin = !href.includes('/login') && !href.includes('auth');
                const onPanel = href.includes('supplier.meesho.com') && (
                  href.includes('/orders') || href.includes('/catalog') || href.includes('/payments') || href.includes('/returns') || href.includes('/dashboard') || href.includes('/home')
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
                const onStoreRoute = (href.includes('/store/') || href.includes('/admin/')) && (
                  href.includes('/home') || href.includes('/orders') || href.includes('/products') || href.includes('/settings') || href.includes('/analytics') || /\/store\/[a-zA-Z0-9\-_]+(\/?$|\?)/.test(href)
                );
                const hasAuthenticatedUi = Boolean(document.querySelector(
                  '#AppFrameMain, nav[aria-label*="Navigation" i], nav[aria-label*="Main" i], [data-portal-id], a[href*="logout"], button[class*="logout"], [aria-label*="log out" i], [aria-label*="Store menu" i], [aria-label*="Account menu" i]'
                ));
                const hasLogoutAction = body.includes('log out') || hasAuthenticatedUi;
                return href.includes('admin.shopify.com') && notLogin && (onStoreRoute || hasLogoutAction);
              }
              const notifBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
              const dontAllow = notifBtns.find(b => b.innerText?.trim().toLowerCase() === "don't allow");
              if (dontAllow) dontAllow.click();
              return href.includes('#dashboard') || href.includes('home-page') || href.includes('listings-management') || body.includes('seller dashboard') || body.includes('ethnicjunction') || body.includes('logout') || body.includes('seller hub');
            }, mpConfig.id);
          } catch {
            // Context destroyed during navigation or in-flight redirect; retry on next poll tick
          }

          if (authState) return true;
          broadcastMonitorState({ url: page.url(), title: page.title() });
          await new Promise((r) => setTimeout(r, 1500));
        }
        return false;
      };

      const loggedIn = await pollAuth();
      if (!loggedIn) throw new Error('Interactive login timed out after 5 minutes.');

      const cookies = await page.cookies();
      saveEncryptedCookies(cookiesPath, cookies);
      if (mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart') {
        saveEncryptedCookies(COOKIES_PATH, cookies);
      }
      broadcastMonitorState({ active: false, status: 'completed', url: page.url(), title: page.title() });
      await page.close();
      activeEmbeddedPage = null;
      return { success: true, marketplace: mpConfig.id, cookiesCount: cookies.length };
    } catch (err) {
      if (activeEmbeddedPage) {
        await activeEmbeddedPage.close().catch(() => {});
        activeEmbeddedPage = null;
      }
      broadcastMonitorState({ active: false, status: 'error', error: err.message });
      return { success: false, marketplace: mpConfig.id, error: err.message };
    }
  }

  // External Chrome runtime fallback
  const puppeteer = getBrowserRuntime();
  const profileDir = getMarketplaceBrowserProfilePath(mpConfig.id);
  const profileSessionState = readSellerHubProfileState(profileDir);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(profileDir), 0o700); } catch {}
  try { fs.chmodSync(profileDir, 0o700); } catch {}
  const browserLease = await externalBrowserSession.acquire(puppeteer, {
    executablePath: requireChromeExecutable(),
    headless: false,
    userDataDir: profileDir,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox', '--restore-last-session']
  }, { profileKey: profileDir, keepOpen: true });
  const { browser, page } = browserLease;

  try {
    const reportNavigation = async frame => {
      if (frame !== page.mainFrame()) return;
      const url = page.url();
      const title = await page.title().catch(() => '');
      broadcastMonitorState({ active: true, status: 'navigating', engine: 'external', marketplace: mpConfig.id, url, title });
      desktopLogger.info('portal.login.navigation', 'Manual marketplace sign-in navigated.', { marketplace: mpConfig.id, url });
    };
    page.on?.('framenavigated', reportNavigation);
    broadcastMonitorState({ active: true, status: 'login_prompt', engine: 'external', marketplace: mpConfig.id, url: manualLoginUrl, title: `Sign in to ${mpConfig.name}`, lastScreenshot: null });
    desktopLogger.info('portal.login.started', 'Opened the manual sign-in browser.', { marketplace: mpConfig.id, url: manualLoginUrl });

    if (['unknown', 'snapshot_available'].includes(profileSessionState) && fs.existsSync(cookiesPath)) {
      const existing = loadMarketplaceCookieSnapshot(cookiesPath, mpConfig.id, 'manual_login');
      if (existing && Array.isArray(existing) && existing.length > 0) {
        await page.setCookie(...existing);
      }
    } else if (['unknown', 'snapshot_available'].includes(profileSessionState) && fs.existsSync(COOKIES_PATH) && (mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart')) {
      const existing = loadMarketplaceCookieSnapshot(COOKIES_PATH, mpConfig.id, 'manual_login');
      if (existing && Array.isArray(existing) && existing.length > 0) {
        await page.setCookie(...existing);
      }
    }

    console.log(`[InteractiveLogin] Opening ${mpConfig.name} at ${manualLoginUrl}...`);
    try {
      // Seller Hub pages can keep long-polling connections open. Wait for the
      // document to load, then let the explicit authentication check drive the
      // manual sign-in lifecycle.
      await focusBrowserPage(page, {
        onViewport: viewport => desktopLogger.info(
          'portal.browser.viewport_adjusted',
          'Expanded the visible browser viewport for marketplace navigation.',
          { marketplace: mpConfig.id, engine: 'external', ...viewport }
        )
      });
      await page.goto(manualLoginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (gotoErr) {
      if (!String(gotoErr?.message || '').includes('ERR_ABORTED')) throw gotoErr;
    }

    console.log(`[InteractiveLogin] Waiting for ${mpConfig.name} authenticated navigation...`);
    let authenticatedPage = page;
    if (mpConfig.id === 'flipkart_shopsy') {
      authenticatedPage = await waitForFlipkartAuthenticatedPage(browser, {
        initialPage: page,
        timeoutMs: 30 * 60 * 1000,
        pollMs: 1000,
        onPage: candidate => {
          desktopLogger.info('portal.login.tab_observed', 'Seller Hub opened another Chrome tab during manual sign-in.', { marketplace: mpConfig.id });
          broadcastMonitorState({ active: true, status: 'login_prompt', engine: 'external', marketplace: mpConfig.id,
            url: candidate.url(), title: 'Seller Hub sign-in tab' });
        },
        onState: (_candidate, state) => reportFlipkartLoginState(state, {
          marketplace: mpConfig.id,
          operation: 'manual_login',
          onProgress,
          profileDir
        })
      });
      if (authenticatedPage !== page) await focusBrowserPage(authenticatedPage, {
        onViewport: viewport => desktopLogger.info(
          'portal.browser.viewport_adjusted',
          'Expanded the visible browser viewport for Seller Hub navigation.',
          { marketplace: mpConfig.id, engine: 'external', ...viewport }
        )
      });
      if (!externalBrowserSession.selectPage(profileDir, authenticatedPage)) {
        throw new Error('Seller Hub verified a different Chrome tab, but it could not be selected for the persistent session.');
      }
    } else await page.waitForFunction((id) => {
      const href = window.location.href.toLowerCase();
      const body = document.body ? document.body.innerText.toLowerCase() : '';
      const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
      const hasLoginForm = Boolean(document.querySelector('form[action*="login"], form[action*="signin"]'));

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
        const onStoreRoute = (href.includes('/store/') || href.includes('/admin/')) && (
          href.includes('/home') ||
          href.includes('/orders') ||
          href.includes('/products') ||
          href.includes('/settings') ||
          href.includes('/analytics') ||
          /\/store\/[a-zA-Z0-9\-_]+(\/?$|\?)/.test(href)
        );
        const hasAuthenticatedUi = Boolean(document.querySelector(
          '#AppFrameMain, nav[aria-label*="Navigation" i], nav[aria-label*="Main" i], [data-portal-id], a[href*="logout"], button[class*="logout"], [aria-label*="log out" i], [aria-label*="Store menu" i], [aria-label*="Account menu" i]'
        ));
        const hasLogoutAction = body.includes('log out') || hasAuthenticatedUi;
        return href.includes('admin.shopify.com') && notLogin && (onStoreRoute || hasLogoutAction);
      }
      return href.includes('#dashboard') || href.includes('listings-management') || body.includes('seller dashboard') || body.includes('ethnicjunction') || body.includes('logout') || body.includes('seller hub');
    }, { timeout: 30 * 60 * 1000, polling: 1000 }, mpConfig.id);

    const cookies = await authenticatedPage.cookies();
    if (mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart') {
      writeSellerHubProfileState(profileDir, 'authenticated');
    }
    saveEncryptedCookies(cookiesPath, cookies);
    if (mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart') {
      saveEncryptedCookies(COOKIES_PATH, cookies);
    }
    console.log(`[InteractiveLogin] Logged in to ${mpConfig.name} successfully! Saved and encrypted ${cookies.length} session cookies; authenticated browser remains open for the worker.`);

    broadcastMonitorState({ active: false, status: 'completed', engine: 'external', marketplace: mpConfig.id, url: authenticatedPage.url(), title: await authenticatedPage.title().catch(() => '') });
    desktopLogger.info('portal.login.authenticated', 'Manual Seller Hub sign-in verified; authenticated browser remains open for extraction.', { marketplace: mpConfig.id, cookieCount: cookies.length, profileRetained: true });
    return { success: true, marketplace: mpConfig.id, cookiesCount: cookies.length };
  } catch (err) {
    let screenshotPath = null;
    try {
      const page = (await browser?.pages?.())?.[0];
      if (page) {
        const diagnostic = await captureScrapeFailure(page, DIAGNOSTICS_DIR,
          { marketplace: mpConfig?.id || targetId, operation: 'manual_login' }, err);
        if (diagnostic.screenshot) screenshotPath = path.join(DIAGNOSTICS_DIR, diagnostic.screenshot);
      }
    } catch {}
    desktopLogger.error('portal.login.failed', err, { marketplace: mpConfig?.id || targetId, screenshotPath });
    broadcastMonitorState({ active: false, status: 'error', engine: 'external', marketplace: mpConfig?.id || targetId, error: err.message });
    return { success: false, marketplace: mpConfig?.id || targetId, error: err.message };
  }
}

// ── Automated Scraper Process (Supports Embedded Engine, In-View 2FA & 2-Attempt Retry) ──
function isPermanentScrapeError(err) {
  if (!err || !err.message) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('verticals selected') ||
         msg.includes('not implemented for') ||
         msg.includes('human login (2fa)') ||
         msg.includes('user cancelled') ||
         msg.includes('unauthorized');
}

async function executeScrapeProcess(config, onProgress) {
  let effectiveConfig = { ...loadConfig(), ...config };
  const session = loadAuthSession();
  const sellerAccount = String(effectiveConfig.seller_account || effectiveConfig.sellerAccount || 'default').trim() || 'default';
  // Keep the user's original selection stable across retries. Discovered
  // backend categories are written to effectiveConfig for the scraper, but
  // must not become explicit selections on the next attempt.
  const requestedVerticals = Array.isArray(effectiveConfig.scopeVerticals)
    ? [...effectiveConfig.scopeVerticals]
    : [];
  const MAX_ATTEMPTS = 2;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const backoffMs = 4000;
      onProgress(`⚠️ Extraction attempt 1 encountered a transient issue (${lastErr?.message || 'unknown'}). Retrying with backoff (${backoffMs}ms)...`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    try {
      // Keep API dataset discovery inside the retry boundary so transient
      // backend failures can use the configured second attempt.
      const configuredVerticalsPromise = requestedVerticals.length
        ? Promise.resolve([])
        : fetchConfiguredVerticals(session, effectiveConfig.marketplace, [], sellerAccount);
      const [catalogResult, configuredVerticals] = await Promise.all([
        fetchBrandCatalogFromApi(session, { marketplace: effectiveConfig.marketplace, sellerAccount }), configuredVerticalsPromise
      ]);
      const verticalSelection = resolveFsnBackedScrapeVerticals({
        requestedVerticals,
        configuredVerticals,
        catalog: catalogResult.catalog,
        marketplace: effectiveConfig.marketplace,
        brand: effectiveConfig.brand || 'all'
      });
      effectiveConfig.fsnCatalog = catalogResult.catalog;
      effectiveConfig.requiredVerticals = verticalSelection.requiredVerticals;
      effectiveConfig.scopeVerticals = verticalSelection.scopeVerticals;
      effectiveConfig.extractionCoverage = verticalSelection;
      if (verticalSelection.unavailableConfiguredVerticals.length) {
        desktopLogger.warn('scrape.catalog_categories_without_fsns',
          'Configured rate-card categories without database FSNs were excluded from the extraction and cannot be published.', {
            marketplace: effectiveConfig.marketplace || 'flipkart_shopsy',
            brand: effectiveConfig.brand || 'all',
            configuredCategories: verticalSelection.configuredVerticals,
            availableCategories: verticalSelection.availableVerticals,
            selectedCategories: verticalSelection.scopeVerticals,
            categories: verticalSelection.unavailableConfiguredVerticals,
            availableCategoryCount: verticalSelection.availableVerticals.length
          });
        onProgress(`⚠️ Configured categories without database FSNs were skipped and will block publication: ${verticalSelection.unavailableConfiguredVerticals.join(', ')}.`);
      }
      if (effectiveConfig.requireCompleteCoverage && !verticalSelection.complete) {
        throw new Error(`Extraction cannot start: configured categories have no database FSNs: ${verticalSelection.unavailableConfiguredVerticals.join(', ')}. Nothing was scraped or submitted.`);
      }

      if (currentBrowserEngine === 'embedded' && mainWindow && !mainWindow.isDestroyed()) {
        broadcastMonitorState({
          active: true,
          status: 'extracting',
          marketplace: effectiveConfig.marketplace || 'flipkart_shopsy',
          url: 'https://seller.flipkart.com'
        });
        const partition = portalPartition(effectiveConfig.marketplace || 'flipkart_shopsy');
        const baseRuntime = createEmbeddedRuntime({
          partition,
          window: mainWindow,
          bounds: () => getMonitorViewBounds(),
      onState: state => broadcastMonitorState(state)
        });
        const runtime = {
          ...baseRuntime,
          async launch(options = {}) {
            const browser = await baseRuntime.launch(options);
            activeEmbeddedPage = browser.page;
            const origClose = browser.close.bind(browser);
            browser.close = async () => {
              if (activeEmbeddedPage === browser.page) activeEmbeddedPage = null;
              await origClose();
            };
            return browser;
          }
        };

        const wrappedProgress = async (msg) => {
          await onProgress(msg);
          broadcastMonitorState({
            status: 'extracting',
            progressMessage: msg,
            url: activeEmbeddedPage ? activeEmbeddedPage.url() : monitorState.url
          });
        };

        const onSessionExpiry = async (page) => {
          broadcastMonitorState({
            active: true,
            status: 'login_prompt',
            url: page.url(),
            title: page.title()
          });
          onProgress('🔐 Seller Hub sign-in is required. Complete it manually in the separate window that opens at seller.flipkart.com.');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('browser-monitor-prompt-login', {
              marketplace: effectiveConfig.marketplace || 'flipkart_shopsy',
              url: page.url()
            });
          }
          const login = await openManualFlipkartLogin({ onProgress, waitMs: 30 * 60 * 1000 });
          if (!login.success || login.waitingForManualLogin) return false;
          broadcastMonitorState({ active: true, status: 'extracting', url: page.url(), title: page.title() });
          onProgress('✓ Manual Seller Hub login verified. The scraper is reusing the persistent authenticated session.');
          return true;
        };

        try {
          const scrapeRes = await scrapeFlipkartRateCards(effectiveConfig, {
            onProgress: wrappedProgress,
            cookiesPath: getMarketplaceCookiesPath('flipkart_shopsy'),
            fallbackCookiesPath: COOKIES_PATH,
            stagingDir: STAGING_DIR,
            runtime,
            onCookieDiagnostics: ({ sourceFile, discardedRecords }) => desktopLogger.warn(
              'portal.cookies.invalid_records_skipped',
              'Ignored malformed saved cookie records before restoring Seller Hub.',
              { marketplace: 'flipkart_shopsy', operation: 'embedded_scrape', sourceFile, discardedRecords }
            ),
            onSessionExpiry
          });
          activeEmbeddedPage = null;
          broadcastMonitorState({ active: false, status: scrapeRes.success ? 'completed' : 'error' });
          if (!scrapeRes.success && /HTTP 5\d\d|ERR_|timed? out|renderer|Missing rate responses/i.test(scrapeRes.error)) throw new Error(scrapeRes.error);
          return { ...scrapeRes, coverage: verticalSelection };
        } catch (err) {
          activeEmbeddedPage = null;
          broadcastMonitorState({ active: false, status: 'error', error: err.message });
          throw err;
        }
      }

      const externalSessionExpiry = async (page, { visible = false } = {}) => {
        if (!visible) return false;
        onProgress('🔐 Seller Hub sign-in is required. Complete it manually in the visible Seller Hub browser window.');
        try {
          const profileDir = getMarketplaceBrowserProfilePath('flipkart_shopsy');
          const authPage = await waitForFlipkartAuthenticatedPage(page.browser(), {
            initialPage: page,
            timeoutMs: 30 * 60 * 1000,
            pollMs: 1000,
            onPage: () => onProgress('Seller Hub opened another Chrome tab. Checking it for the authenticated dashboard.'),
            onState: (_candidate, state) => reportFlipkartLoginState(state, {
              marketplace: effectiveConfig.marketplace || 'flipkart_shopsy',
              operation: 'scrape_reauthentication',
              onProgress,
              profileDir
            })
          });
          if (!externalBrowserSession.selectPage(profileDir, authPage)) {
            throw new Error('Seller Hub verified a different Chrome tab, but it could not be selected for the persistent session.');
          }
          writeSellerHubProfileState(profileDir, 'authenticated');
          const cookies = await authPage.cookies();
          if (cookies.length) {
            saveEncryptedCookies(getMarketplaceCookiesPath('flipkart_shopsy'), cookies);
            saveEncryptedCookies(COOKIES_PATH, cookies);
            onProgress('✓ In-browser authentication complete. Session cookies encrypted and saved.');
          } else {
            deleteEncryptedCookies(getMarketplaceCookiesPath('flipkart_shopsy'));
            deleteEncryptedCookies(COOKIES_PATH);
            onProgress('✓ Seller Hub authentication verified without cookies. Removed stale cookie snapshots; the active browser session will continue.');
          }
          return authPage;
        } catch (loginError) {
          onProgress(`Manual Seller Hub sign-in did not complete: ${loginError.message}`);
          return false;
        }
      };

      const baseExternalRuntime = getBrowserRuntime();
      const externalRuntime = new Proxy(baseExternalRuntime, {
        get(target, property, receiver) {
          if (property === 'getPage') {
            return () => externalBrowserSession.getPage(getMarketplaceBrowserProfilePath('flipkart_shopsy'));
          }
          if (property !== 'launch') return Reflect.get(target, property, receiver);
          return async options => {
            const profileDir = getMarketplaceBrowserProfilePath('flipkart_shopsy');
            const browserLease = await externalBrowserSession.acquire(target, options, {
              profileKey: profileDir,
              keepOpen: options.headless === false
            });
            return browserLease.browser;
          };
        }
      });
      const externalProgress = async message => {
        await onProgress(message);
        broadcastMonitorState({
          active: true,
          status: 'extracting',
          engine: 'external',
          marketplace: effectiveConfig.marketplace || 'flipkart_shopsy',
          url: activeExternalPage?.url?.() || FLIPKART_MANUAL_LOGIN_URL,
          title: activeExternalPage ? await activeExternalPage.title().catch(() => '') : 'External Chrome rate-card worker',
          progressMessage: message
        });
      };

      const externalResult = await scrapeFlipkartRateCards(effectiveConfig, {
        onProgress: externalProgress,
        cookiesPath: getMarketplaceCookiesPath('flipkart_shopsy'),
        fallbackCookiesPath: COOKIES_PATH,
        stagingDir: STAGING_DIR,
        runtime: externalRuntime,
        browserProfileDir: getMarketplaceBrowserProfilePath('flipkart_shopsy'),
        onCookieDiagnostics: ({ sourceFile, discardedRecords }) => desktopLogger.warn(
          'portal.cookies.invalid_records_skipped',
          'Ignored malformed saved cookie records before restoring Seller Hub.',
          { marketplace: 'flipkart_shopsy', operation: 'scrape', sourceFile, discardedRecords }
        ),
        onSessionExpiry: externalSessionExpiry
      });
      broadcastMonitorState({
        active: false,
        status: externalResult.success ? 'completed' : 'error',
        engine: 'external',
        marketplace: effectiveConfig.marketplace || 'flipkart_shopsy',
        error: externalResult.success ? '' : externalResult.error
      });
      if (!externalResult.success && /HTTP 5\d\d|ERR_|timed? out|renderer|Missing rate responses/i.test(externalResult.error)) throw new Error(externalResult.error);
      return { ...externalResult, coverage: verticalSelection };
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS || isPermanentScrapeError(err)) {
        throw err;
      }
    }
  }
}

const authorizeSession = createSessionAccess({
  load: loadAuthSession, save: saveAuthSession,
  refresh: refreshFirebaseIdToken, verify: verifyDesktopTokenAuthorization,
  onAuthorized: (session) => setDesktopDatabaseAccess(session.user.role, storedDatabaseUrlForRole(session.user.role, loadConfig()))
});
const PUBLIC_CHANNELS = new Set([
  'auth-login', 'auth-get-session', 'auth-logout',
  'browser-monitor-set-dock-bounds', 'browser-monitor-set-visibility',
  'write-client-log', 'open-diagnostics',
  // Update lifecycle is app-level, not session/data-level: checking for a new
  // release and applying it must work before sign-in and can never touch
  // database or session data.
  'update-get-status', 'update-check', 'update-install'
]);
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
      desktopLogger.error('ipc.handler.failed', err, { channel });
      return { success: false, error: err.message };
    }
  });
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────
registerHandler('write-client-log', (e, entry = {}) => {
  const message = typeof entry.message === 'string' ? entry.message.slice(0, 2000) : '';
  if (!message) return { success: false, error: 'A short diagnostic message is required.' };
  const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info';
  desktopLogger.write(level, 'renderer.' + level, message, { source: 'desktop-ui' });
  return { success: true };
});
registerHandler('open-diagnostics', async () => {
  fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true, mode: 0o700 });
  const error = await shell.openPath(DIAGNOSTICS_DIR);
  return error ? { success: false, error } : { success: true, path: DIAGNOSTICS_DIR };
});
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

// ── Auto-Update IPC Handlers ─────────────────────────────────────────────────
registerHandler('update-get-status', () => ({ success: true, status: lastUpdateStatus }));
registerHandler('update-check', async () => {
  if (!autoUpdater) {
    return { success: false, error: 'Updates are only available in the installed desktop app.' };
  }
  // Progress and results arrive through update-status events; this only
  // reports whether a check actually ran.
  const started = await checkForAppUpdate();
  return started ? { success: true } : { success: false, error: 'Update check failed. It will be retried automatically.' };
});
registerHandler('update-install', () => {
  if (!autoUpdater) {
    return { success: false, error: 'Updates are only available in the installed desktop app.' };
  }
  if (lastUpdateStatus?.status !== 'downloaded') {
    return { success: false, error: 'No downloaded update is ready to install yet.' };
  }
  // Silent install that relaunches the app with the new version.
  autoUpdater.quitAndInstall(true, true);
  return { success: true };
});

// ── Live Browser Monitor & Automation Control Handlers ───────────────────────
registerHandler('browser-monitor-get-state', () => ({
  success: true,
  state: monitorState
}));

registerHandler('browser-monitor-screenshot', async () => {
  const activePage = activeEmbeddedPage || activeExternalPage;
  if (activePage && typeof activePage.screenshot === 'function') {
    try {
      const pngBuffer = await activePage.screenshot();
      const base64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;
      broadcastMonitorState({ lastScreenshot: base64 });
      return { success: true, screenshot: base64 };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: false, error: 'No active Seller Hub browser page to capture.' };
});

registerHandler('browser-monitor-set-visibility', (e, visible) => {
  const isVis = Boolean(visible);
  if (activeEmbeddedPage && typeof activeEmbeddedPage.setVisible === 'function') {
    activeEmbeddedPage.setVisible(isVis);
    if (isVis && typeof activeEmbeddedPage.layout === 'function') {
      activeEmbeddedPage.layout();
    }
  }
  broadcastMonitorState({ visible: isVis });
  return { success: true, visible: isVis };
});

registerHandler('browser-monitor-set-engine', (e, engine) => {
  // Flipkart login and extraction must share the same durable Chrome profile.
  // Do not route users back to the separate embedded Chromium partition.
  currentBrowserEngine = 'external';
  broadcastMonitorState({ engine: 'external' });
  return { success: true, engine: 'external' };
});

registerHandler('browser-monitor-set-dock-bounds', (e, rect) => {
  if (rect && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k]))) {
    const zoom = e.sender.getZoomFactor();
    const [width, height] = mainWindow.getContentSize();
    const x = Math.max(0, Math.min(width, Math.round(rect.x * zoom)));
    const y = Math.max(0, Math.min(height, Math.round(rect.y * zoom)));
    currentDockBounds = {
      x, y,
      width: Math.max(0, Math.min(width - x, Math.round(rect.width * zoom))),
      height: Math.max(0, Math.min(height - y, Math.round(rect.height * zoom)))
    };
    if (activeEmbeddedPage && typeof activeEmbeddedPage.layout === 'function') {
      activeEmbeddedPage.layout();
    }
  }
  return { success: true };
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

    // Cloud API worker engine handles all database access securely
    startWorkerEngine(session).catch(e => console.warn('[Worker Engine] Start error:', e.message));

    return { success: true, session: publicSession(session), databaseConfigured: true };
  } catch (err) {
    desktopLogger.error('auth.login_failed', err);
    return { success: false, error: err.message };
  }
});

registerHandler('get-marketplaces', () => {
  const list = SUPPORTED_MARKETPLACES.map(m => {
    const cookiesPath = getMarketplaceCookiesPath(m.id);
    let cookieCount = 0;
    let lastSavedAt = null;
    try {
      const stored = loadMarketplaceCookieSnapshot(cookiesPath, m.id, 'session_status');
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
  if (session) {
    saveAuthSession(session);
    if (!workerEngine.active && session.authenticated) {
      startWorkerEngine(session).catch(e => console.warn('[Worker Engine] Session restore start error:', e.message));
    }
  }
  return publicSession(session);
});
registerHandler('auth-logout', async () => {
  stopWorkerEngine();
  const cleared = clearAuthSession();
  await closeDesktopPool();
  setDesktopDatabaseAccess(null);
  try {
    const { session: electronSession } = require('electron');
    if (electronSession) {
      for (const mp of SUPPORTED_MARKETPLACES) {
        // Seller Hub sign-in is independent from the ReconCentral account.
        // Keep Flipkart and Shopsy authenticated across desktop sign-out.
        if (portalPartition(mp.id) === portalPartition('flipkart_shopsy')) continue;
        const part = electronSession.fromPartition(`persist:marketplace-${mp.id}`);
        if (part?.clearStorageData) {
          await part.clearStorageData({ storages: ['cookies'] }).catch(() => {});
        }
      }
    }
  } catch {}
  // An undeleted session file keeps working tokens on disk that session
  // restoration would sign straight back in with: never claim a clean
  // deauthorization when the removal failed.
  if (!cleared.success) {
    return {
      success: false,
      error: `Sign-out incomplete: the saved session could not be removed (${cleared.error}). Retry sign-out, or lock this PC until the session file can be deleted.`
    };
  }
  return { success: true };
});

registerHandler('auth-verify-db', async (e, dbUrl) => {
  const { testDatabaseConnection } = await import('./db.js');
  return await testDatabaseConnection(dbUrl || storedDatabaseUrlForRole(loadAuthSession()?.user?.role, loadConfig()));
});

registerHandler('test-db-connection', async (e, customUrl) => {
  const baseUrl = await getActiveBackendUrl(true);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { 'Accept': 'application/json' } });
    if (res.ok) {
      return { success: true, db: 'ReconCentral Cloud API', message: `Connected to ${baseUrl}` };
    }
    return { success: false, error: `ReconCentral API returned HTTP ${res.status}` };
  } catch (err) {
    return { success: false, error: `Cannot reach ReconCentral API at ${baseUrl}: ${err.message}` };
  }
});
registerHandler('interactive-login', async (e, marketplace) => {
  return await withBrowserTask(() => executeInteractiveLogin(marketplace));
});

registerHandler('clear-marketplace-session', async (e, marketplace) => {
  if (withBrowserTask.busy) {
    return { success: false, error: 'A browser task is running. Finish or stop it before purging session cookies.' };
  }
  return await withBrowserTask(async () => {
    const targetId = (typeof marketplace === 'string' ? marketplace : marketplace?.marketplace || marketplace?.id) || 'flipkart_shopsy';
    const isFlipkart = ['flipkart_shopsy','flipkart','shopsy','both'].includes(targetId);
    await externalBrowserSession.close({
      profileKey: getMarketplaceBrowserProfilePath(targetId),
      reason: 'cookie-reset'
    });
    const cookiesPath = getMarketplaceCookiesPath(targetId);
    clearEncryptedCookieSnapshot(cookiesPath);
    if (isFlipkart) {
      clearEncryptedCookieSnapshot(COOKIES_PATH);
    }
    let partitionErr = null;
    try {
      if (isFlipkart) manualFlipkartLoginManager?.close();
      const { session: electronSession } = require('electron');
      if (electronSession) {
        const part = electronSession.fromPartition(portalPartition(targetId));
        if (part?.clearStorageData) {
          await part.clearStorageData();
        }
      }
    } catch (err) {
      partitionErr = err.message;
    }
    try {
      const profilePath = getMarketplaceBrowserProfilePath(targetId);
      fs.rmSync(profilePath, { recursive: true, force: true });
      if (fs.existsSync(profilePath)) throw new Error('Could not remove the persistent marketplace browser profile.');
    }
    catch (err) { partitionErr = partitionErr || err.message; }
    if (partitionErr) {
      return { success: false, error: `Failed to clear in-memory partition cookies: ${partitionErr}` };
    }
    return { success: true, marketplace: targetId };
  });
});

registerHandler('start-scrape', async (e, options) => {
  if (withBrowserTask.busy) return { success: false, error: 'A browser task is already running.' };
  const startedAt = Date.now();
  const config = loadConfig();
  const selectedBrand = options?.brand || 'all';
  const verticalSelection = resolveScrapeVerticals({
    requestedVerticals: options?.verticals,
    configuredVerticals: [],
    brand: selectedBrand
  });
  const mergedOptions = {
    ...config,
    marketplace: options?.marketplace || config.marketplace,
    visible: options?.visible === true,
    brand: selectedBrand,
    scopeVerticals: verticalSelection.scopeVerticals,
    requiredVerticals: verticalSelection.requiredVerticals
  };
  desktopLogger.info('scrape.started', 'Seller Hub extraction started.', {
    marketplace: mergedOptions.marketplace, brand: mergedOptions.brand,
    mode: mergedOptions.visible ? 'visible' : 'background'
  });
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
  stagedExtraction.coverage = null;
  stagedExtraction.review = null;
  supersedeReviews(getStagingDb(USER_DATA_DIR), loadAuthSession().user.firebase_uid);
  const jobAuthGeneration = stagedExtraction.authGeneration;
  const result = await withBrowserTask(() => executeScrapeProcess(mergedOptions, (msg) => {
    desktopLogger.info('scrape.progress', msg, { marketplace: mergedOptions.marketplace });
    if (mainWindow) mainWindow.webContents.send('scrape-progress', msg);
  }));
  if (!result.success) {
    desktopLogger.error('scrape.failed', result.error || 'Extraction failed.', {
      marketplace: mergedOptions.marketplace, errorCode: result.errorCode || null, durationMs: Date.now() - startedAt
    });
    return result;
  }
  // Re-verify the signed-in account AFTER the long browser run, then re-check the
  // generation: an account switch during that await must discard the results.
  const sessionStillValid = await authorizeSession();
  if (!sessionStillValid || jobAuthGeneration !== stagedExtraction.authGeneration) {
    desktopLogger.warn('scrape.results_discarded', 'Account changed before extracted results could be staged.', {
      marketplace: mergedOptions.marketplace, durationMs: Date.now() - startedAt
    });
    return {
      success: false,
      error: 'The account changed or the session ended while the extraction was running. Results were discarded; run the extraction again.'
    };
  }
  try {
    persistReview(normalizeScrapedCards(result.data), sessionStillValid, result.coverage || null);
  } catch (stageErr) {
    desktopLogger.error('scrape.staging_failed', stageErr, {
      marketplace: mergedOptions.marketplace, observationCount: result.data?.length || 0,
      durationMs: Date.now() - startedAt
    });
    return { success: false, error: `Extraction review staging failed: ${stageErr.message}` };
  }
  desktopLogger.info('scrape.staged', 'Extraction passed validation and was saved for review.', {
    marketplace: mergedOptions.marketplace, observationCount: result.data?.length || 0,
    cardCount: stagedExtraction.cards.length, durationMs: Date.now() - startedAt,
    coverageComplete: result.coverage?.complete ?? true,
    unavailableConfiguredVerticals: result.coverage?.unavailableConfiguredVerticals || []
  });
  return { ...result, rateCards: stagedExtraction.cards };
});

// Brand & FSN Live Catalog Inspection (Via API)
registerHandler('get-brand-fsn-catalog', async () => {
  const session = loadAuthSession();
  try {
    const res = await fetchBrandCatalogFromApi(session);
    if (res && res.success && Array.isArray(res.catalog)) {
      return { success: true, catalog: res.catalog };
    }
    return { success: false, error: res?.error || 'Failed to fetch catalog from API', catalog: [] };
  } catch (err) {
    console.warn('[get-brand-fsn-catalog] API fetch error:', err.message);
    return { success: false, error: err.message, catalog: [] };
  }
});

// Full Brand-Wise Preview (Flipkart & Shopsy)
registerHandler('get-ratecard-preview', async (e, options = {}) => {
  if (!stagedExtraction.cards.length) {
    const session = loadAuthSession();
    const review = recoverReview(getStagingDb(USER_DATA_DIR), session.user.firebase_uid);
    if (review) {
      stagedExtraction.cards = review.cards;
      stagedExtraction.coverage = review.coverage || null;
    }
  }
  if (!stagedExtraction.cards.length) {
    return {
      success: false,
      rateCards: [],
      canSync: false,
      error: 'No successful local extraction is staged. Run the scraper before reviewing rate changes.'
    };
  }
  try {
    const sellerAccount = String(options.seller_account || 'default').trim() || 'default';
    if (!/^[a-z0-9][a-z0-9_-]{0,49}$/i.test(sellerAccount) || sellerAccount === 'all') {
      return { success: false, error: 'Choose one valid seller account for the rate review.' };
    }
    const rateCards = stagedExtraction.cards;
    const targetMp = String(options.marketplace || options.channel || 'flipkart').toLowerCase().trim();
    if (!['flipkart', 'shopsy'].includes(targetMp)) {
      return { success: false, error: 'Choose Flipkart or Shopsy for a separate rate review.' };
    }
    const filteredRateCards = filterRateCardsByChannel(targetMp, rateCards);
    const missingCategories = missingFsnCategoriesForMarketplace(stagedExtraction.coverage, targetMp);
    return {
      success: true,
      rateCards: filteredRateCards,
      canSync: stagedExtraction.cards.length > 0 && missingCategories.length === 0,
      coverage: stagedExtraction.coverage,
      missingFsnCategories: missingCategories
    };
  } catch (err) {
    desktopLogger.error('rate-review.preview_failed', err, {
      marketplace: options.marketplace || options.channel || 'flipkart'
    });
    return { success: false, error: err.message };
  }
});

// Change Detection against ReconCentral Cloud Backend API
registerHandler('detect-brand-rate-changes', async (e, submitted, options = {}) => {
  const cards = selectStagedCards(stagedExtraction.cards, submitted);
  if (!cards) return { success: false, error: 'Review a successful staged extraction first.' };
  if (new Set(cards.map(card => card.marketplace)).size !== 1) {
    return { success: false, error: 'Review Flipkart and Shopsy separately.' };
  }
  try {
    const sellerAccount = options.seller_account || 'default';
    const result = await reviewRatesViaApi(loadAuthSession(), cards, sellerAccount);
    stagedExtraction.review = { payload: JSON.stringify(cards), sellerAccount, fingerprints: result.fingerprints };
    desktopLogger.info('rate-review.compared', 'PostgreSQL comparison completed.', {
      marketplace: cards[0].marketplace, cardCount: cards.length,
      changeCount: result.changesCount, anomalyCount: result.anomaliesCount
    });
    return { success: true, ...result };
  } catch (err) {
    stagedExtraction.review = null;
    desktopLogger.error('rate-review.comparison_failed', err);
    return { success: false, error: err.message };
  }
});

registerHandler('sync-brand-rate-cards', async (e, submitted, options = {}) => {
  const authGeneration = stagedExtraction.authGeneration;
  const isCurrent = () => authGeneration === stagedExtraction.authGeneration;
  const cards = selectStagedCards(stagedExtraction.cards, submitted);
  const review = stagedExtraction.review;
  const missingCategories = missingFsnCategoriesForMarketplace(stagedExtraction.coverage, cards?.[0]?.marketplace);
  if (!cards || new Set(cards.map(card => card.marketplace)).size !== 1 ||
      !review || review.payload !== JSON.stringify(cards) || review.sellerAccount !== (options.seller_account || 'default')) {
    return { success: false, error: 'Review the selected staged cards against PostgreSQL before committing.' };
  }
  if (missingCategories.length) {
    return { success: false, error: `Publication blocked: configured categories have no database FSNs and were not extracted: ${missingCategories.join(', ')}.` };
  }
  try {
    const result = await publishReviewedRatesViaApi(loadAuthSession(), cards, review.fingerprints, review.sellerAccount, isCurrent);
    stagedExtraction.review = null;
    desktopLogger.info(result.updated ? 'rate-review.published' : 'rate-review.unchanged',
      result.message || 'Reviewed rates are unchanged.', {
        marketplace: cards[0].marketplace, cardCount: cards.length,
        changeCount: result.changesCount || 0, version: result.versionName || null
      });
    return { success: true, result };
  } catch (err) {
    desktopLogger.error('rate-review.publish_failed', err, { marketplace: cards[0].marketplace });
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
