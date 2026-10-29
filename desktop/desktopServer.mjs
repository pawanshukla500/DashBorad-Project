#!/usr/bin/env node
/**
 * ReconCentral Desktop Control Center — Standalone Desktop Server & App Launcher
 * 
 * Cross-platform (Windows & Linux) desktop engine and REST API server for
 * Flipkart and Shopsy rate card extraction, change detection, and PostgreSQL synchronization.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { getBrowserRuntime, withBrowserTask } from './browserRuntime.js';
const puppeteer = getBrowserRuntime();

import { 
  decodeJwtPayload, 
  extractRoleFromToken, 
  isAuthorizedDesktopRole, 
  validateDesktopTokenRole, 
  validateTokenRoleMatchesDatabase,
  verifyFirebaseTokenCryptographically,
  verifyDesktopTokenAuthorization,
  filterRateCardsByChannel, 
  saveEncryptedCookies,
  loadEncryptedCookies,
  AUTHORIZED_ROLES, 
  FIREBASE_ROLE_CLAIM 
} from './authValidation.js';
import { createSessionAccess, publicSession } from './sessionAccess.js';
import { createStagedExtractionState, normalizeScrapedCards, selectStagedCards } from './scrapeResults.js';
import { isDesktopReachableDbUrl, sanitizeSavedDbUrl, selectDesktopDatabaseUrlForSession, storedDatabaseUrlForRole } from './dbUrlGuard.js';
import {
  authorizeDesktopRequest, bindBrowserSession, expiredBrowserCookie,
  isAllowedDesktopOrigin, isSameDesktopOrigin
} from './httpAccess.js';
import { scrapeFlipkartRateCards } from './portalScraper.js';
import { encryptVaultData, decryptVaultData } from './cookieVault.js';

let activeTokenVerifier = verifyDesktopTokenAuthorization;
export function setDesktopTokenVerifier(verifier) {
  activeTokenVerifier = typeof verifier === 'function' ? verifier : verifyDesktopTokenAuthorization;
}
export function resetDesktopTokenVerifier() {
  activeTokenVerifier = verifyDesktopTokenAuthorization;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment from backend/.env natively
const envPath = path.join(__dirname, '../backend/.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

import { 
  getRealTimeBrandFsnSamples, 
  buildBrandRateCardSet, 
  detectBrandRateChanges, 
  syncBrandRateCardsToDatabase 
} from './rateCardService.js';
import { 
  generateBrandwiseRateCardExcel, 
  DEFAULT_EXCEL_PATH 
} from './excelExport.js';
import { getChromeExecutablePath } from './chromeFinder.js';
import { getDesktopPool, closeDesktopPool, setDesktopDatabaseAccess } from './db.js';

function getPool() {
  return getDesktopPool(loadConfig().databaseUrl);
}

const PORT = 3388;
const UI_DIR = path.join(__dirname, 'ui');

function resolveUserDataDir() {
  if (process.env.RECONCENTRAL_USER_DATA) return process.env.RECONCENTRAL_USER_DATA;
  if (process.env.RECON_USER_DATA_DIR) return process.env.RECON_USER_DATA_DIR;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'ReconCentral RateCard Worker');
  }
  if (process.platform === 'linux' && process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'reconcentral-ratecard-worker');
  }
  if (process.platform === 'linux' && process.env.HOME) {
    return path.join(process.env.HOME, '.config', 'reconcentral-ratecard-worker');
  }
  return path.join(__dirname, '.runtime');
}

const USER_DATA_DIR = resolveUserDataDir();
process.env.RECON_USER_DATA_DIR = USER_DATA_DIR;
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

const CONFIG_FILE = path.join(USER_DATA_DIR, 'worker-config.json');
const SESSION_FILE = path.join(USER_DATA_DIR, 'auth-session.json');
const COOKIES_PATH = path.join(USER_DATA_DIR, 'cookies.json');
process.env.RECON_COOKIES_PATH = COOKIES_PATH;
const STAGING_DIR = path.join(USER_DATA_DIR, 'staging');
fs.mkdirSync(STAGING_DIR, { recursive: true });

function getMarketplaceCookiesPath(marketplace = 'flipkart_shopsy') {
  const safeId = String(marketplace).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const dir = path.join(USER_DATA_DIR, 'cookies');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `cookies_${safeId}.json`);
}

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

export function loadAuthSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      // Sealed sessions are decrypted with the AES-256-GCM vault key; legacy
      // plaintext files (older builds) still load so an upgrade never
      // silently signs the operator out.
      const session = raw?.encrypted ? JSON.parse(decryptVaultData(raw.encrypted) || 'null') : raw;
      if (session && session.user && session.authenticated) {
        return session;
      }
    }
  } catch (err) {}
  return { authenticated: false, user: null };
}

export function saveAuthSession(sessionData) {
  try {
    // The standalone worker has no Electron safeStorage, so the session
    // (idToken / refreshToken) is sealed with the AES-256-GCM vault using the
    // machine-local key. The 0600 permissions remain, but the tokens are no
    // longer readable by same-user processes or backups of the data directory.
    const sealed = encryptVaultData(JSON.stringify(sessionData));
    if (!sealed) return { success: false, error: 'Could not seal the session before writing it.' };
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ encrypted: sealed }, null, 2), { mode: 0o600 });
    fs.chmodSync(SESSION_FILE, 0o600);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

const stagedExtraction = createStagedExtractionState();

function clearAuthSession() {
  stagedExtraction.resetForAuthChange();
  disconnectTelemetryClients();
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// A local session file is a token store, not an authorization source. Every request
// is re-verified (signature + revocation + role) before any privileged work runs.
const authorizeSession = createSessionAccess({
  load: loadAuthSession,
  save: saveAuthSession,
  refresh: refreshFirebaseIdToken,
  verify: (token) => activeTokenVerifier(token),
  onAuthorized: (session) => setDesktopDatabaseAccess(session.user.role, storedDatabaseUrlForRole(session.user.role, loadConfig()))
});

const sseClients = new Set();
function disconnectTelemetryClients() {
  for (const client of sseClients) client.end();
  sseClients.clear();
}
let activeScrapeJob = {
  running: false,
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  progress: [],
  lastResult: null,
  error: null
};

function broadcastProgress(msg) {
  const entry = { message: msg, time: new Date().toLocaleTimeString() };
  if (activeScrapeJob.running) {
    activeScrapeJob.progress.push(entry);
    if (activeScrapeJob.progress.length > 500) activeScrapeJob.progress.shift();
  }
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Default Configuration
const DEFAULT_CONFIG = {
  marketplace: 'flipkart_shopsy', // 'flipkart_shopsy', 'myntra_vb', 'myntra_ej', 'meesho'
  email: 'Vbexports@outlook.com',
  password: process.env.FK_PASSWORD || '',
  apiServerUrl: process.env.API_SERVER_URL || 'https://payments.youthnic.shop',
  databaseUrl: process.env.DATABASE_URL || '',
  scheduledHour: 6,
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
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (parsed.apiServerUrl && parsed.apiServerUrl.includes('payment.youthnic.shop')) {
        parsed.apiServerUrl = parsed.apiServerUrl.replace('payment.youthnic.shop', 'payments.youthnic.shop');
      }
      // Drop container-internal database URLs provisioned by old server builds (e.g. postgres:5432)
      if (parsed.databaseUrl) parsed.databaseUrl = sanitizeSavedDbUrl(parsed.databaseUrl);
      // The environment-derived default is sanitized too: a container-internal
      // DATABASE_URL (postgres:5432) must never reach the pool logic, even
      // when the config file is missing or predates the databaseUrl key.
      const effectiveDatabaseUrl = 'databaseUrl' in parsed ? parsed.databaseUrl : sanitizeSavedDbUrl(DEFAULT_CONFIG.databaseUrl);
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

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    if (process.platform === 'linux') {
      try {
        const sysDir = '/etc/reconcentral-ratecard';
        if (fs.existsSync(sysDir)) {
          const sysFile = path.join(sysDir, 'worker-config.json');
          fs.writeFileSync(sysFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
          try { fs.chmodSync(sysFile, 0o600); } catch {}
        }
      } catch {}
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Cross-Platform File Launcher
function openFileCrossPlatform(filePath) {
  return new Promise((resolve, reject) => {
    if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.xlsx') {
      return reject(new Error('Only generated .xlsx workbooks may be opened.'));
    }
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const executable = isWin ? 'explorer.exe' : (isMac ? 'open' : 'xdg-open');
    execFile(executable, [path.resolve(filePath)], (err) => {
      if (err) reject(err);
      else resolve(filePath);
    });
  });
}

// ── HTTP Request Handler ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  // Validate Host header to prevent DNS rebinding attacks on local control port
  const host = req.headers.host || '';
  const isLoopbackHost = !host || /^localhost(:\d+)?$/i.test(host) || /^127\.0\.0\.1(:\d+)?$/i.test(host);
  if (!isLoopbackHost) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: Invalid Host header for desktop control server.' }));
    return;
  }

  // External web clients need an explicit verified bearer; cookies are only
  // accepted from the control center's exact origin.
  const origin = req.headers.origin || '';
  if (!isAllowedDesktopOrigin(req)) {
    return sendJson(403, { success: false, error: 'Forbidden: Untrusted desktop request origin.' });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health probe to verify active ReconCentral desktop server
  if (pathname === '/api/desktop/health' && req.method === 'GET') {
    return sendJson(200, {
      service: 'reconcentral-ratecard-desktop',
      version: '1.0.0',
      status: 'healthy'
    });
  }

  // Helper to parse JSON body
  const parseJsonBody = () => new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });

  // Auth gate for every non-public API route: verified session or 401.
  const requireDesktopAuth = async (mutation = false) => {
    const { session, error } = await authorizeDesktopRequest(req, {
      authorize: authorizeSession, verify: activeTokenVerifier, mutation
    });
    if (!session) {
      sendJson(401, {
        success: false,
        authenticated: false,
        error: `Unauthorized: ${error || 'An active ReconCentral session and matching browser session or bearer token are required.'}`
      });
      return null;
    }
    return session;
  };

  try {
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive'
      });
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    // ── 2. GET API Endpoints ─────────────────────────────────────────────────

    // GET /api/health
    if (pathname === '/api/health' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      const chromePath = getChromeExecutablePath();
      let dbConnected = false;
      try {
        const pool = getPool();
        const test = await pool.query('SELECT 1 as ok');
        dbConnected = test.rows?.[0]?.ok === 1;
      } catch {}

      return sendJson(200, {
        status: 'ok',
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        chromeExecutable: chromePath,
        chromeAvailable: fs.existsSync(chromePath),
        databaseConnected: dbConnected,
        activeScrapeJob: {
          running: activeScrapeJob.running,
          status: activeScrapeJob.status
        }
      });
    }

    // GET /api/auth/session (verified, refreshed, token-free projection)
    if (pathname === '/api/auth/session' && req.method === 'GET') {
      const session = await requireDesktopAuth();
      if (!session) return;
      return sendJson(200, publicSession(session));
    }

    // GET /api/config
    if (pathname === '/api/config' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      return sendJson(200, loadConfig());
    }


    // GET /api/catalog
    if (pathname === '/api/catalog' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      try {
        const pool = getPool();
        const catalog = await getRealTimeBrandFsnSamples(pool);
        return sendJson(200, { success: true, count: catalog.length, catalog });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // GET /api/preview (staged extraction first; templates are read-only)
    if (pathname === '/api/preview' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      try {
        // Staged extractions are reviewable without a database; templates need one.
        const rateCards = stagedExtraction.cards.length ? stagedExtraction.cards : await buildBrandRateCardSet(getPool());
        const targetMp = urlObj.searchParams.get('marketplace') || urlObj.searchParams.get('channel') || '';
        const filteredRateCards = filterRateCardsByChannel(targetMp, rateCards);
        return sendJson(200, { success: true, count: filteredRateCards.length, rateCards: filteredRateCards, canSync: stagedExtraction.cards.length > 0 });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // GET /api/active-rates
    if (pathname === '/api/active-rates' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      try {
        const pool = getPool();
        const [commRes, fixedRes, revRes] = await Promise.all([
          pool.query(`SELECT * FROM rc_commission WHERE end_date IS NULL ORDER BY marketplace, category, brand_name, price_min`),
          pool.query(`SELECT * FROM rc_fixed_fee WHERE end_date IS NULL ORDER BY marketplace, category, fulfilment_type, price_min`),
          pool.query(`SELECT * FROM rc_reverse_shipping WHERE end_date IS NULL ORDER BY marketplace, category, weight_slab, price_min`)
        ]);

        return sendJson(200, {
          success: true,
          counts: {
            commissions: commRes.rows.length,
            fixedFees: fixedRes.rows.length,
            reverseShipping: revRes.rows.length
          },
          rates: {
            commissions: commRes.rows,
            fixedFees: fixedRes.rows,
            reverseShipping: revRes.rows
          }
        });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // GET /api/diff
    if (pathname === '/api/diff' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      try {
        const pool = getPool();
        const rateCards = await buildBrandRateCardSet(pool);
        const changes = await detectBrandRateChanges(rateCards, pool);
        return sendJson(200, {
          success: true,
          inSync: changes.length === 0,
          changesCount: changes.length,
          changes
        });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // GET /api/scrape/status
    if (pathname === '/api/scrape/status' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      return sendJson(200, activeScrapeJob);
    }

    // GET /api/browser/state (Standalone Monitor Adapter)
    if (pathname === '/api/browser/state' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      const isScraping = Boolean(activeScrapeJob?.running);
      return sendJson(200, {
        success: true,
        state: {
          active: isScraping,
          status: isScraping ? 'extracting' : 'idle',
          engine: 'external',
          marketplace: 'flipkart_shopsy',
          url: isScraping ? 'https://seller.flipkart.com' : 'about:blank',
          title: isScraping ? 'External Chrome Automation' : 'Standalone Scraper Idle',
          progressMessage: activeScrapeJob?.progress || ''
        }
      });
    }

    // GET /api/browser/screenshot (Standalone Monitor Adapter)
    if (pathname === '/api/browser/screenshot' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      return sendJson(200, {
        success: false,
        error: 'Screenshot capture is only supported in the installed desktop app.'
      });
    }

    // GET /api/excel/status
    if (pathname === '/api/excel/status' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
      const exists = fs.existsSync(DEFAULT_EXCEL_PATH);
      let stats = null;
      if (exists) {
        const s = fs.statSync(DEFAULT_EXCEL_PATH);
        stats = {
          sizeBytes: s.size,
          lastModified: s.mtime.toISOString()
        };
      }
      return sendJson(200, {
        filePath: DEFAULT_EXCEL_PATH,
        exists,
        stats
      });
    }

    // ── 3. POST API Endpoints ────────────────────────────────────────────────

    // POST /api/auth/login
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      if (!isSameDesktopOrigin(req)) {
        return sendJson(403, { success: false, error: 'Sign in from the local desktop control center.' });
      }
      try {
        const body = await parseJsonBody();
        const { email, password, dbUrl } = body;
        if (!email || !password) {
          return sendJson(400, { success: false, error: 'Email and password are required.' });
        }

        let fbResult;
        try {
          fbResult = await authenticateWithFirebase(email, password);
        } catch (fbErr) {
          const msg = fbErr.message === 'INVALID_LOGIN_CREDENTIALS' || fbErr.message === 'EMAIL_NOT_FOUND' || fbErr.message === 'INVALID_PASSWORD'
            ? 'Invalid email or password.'
            : `Firebase Auth error: ${fbErr.message}`;
          return sendJson(401, { success: false, error: msg });
        }

        const firebaseUid = fbResult.localId;
        const userEmail = fbResult.email || email;
        const config = loadConfig();
        let dbUser = null;
        let serverDatabaseUrl = '';
        let serverDatabaseAccess = '';

        // 1. Query ReconCentral Backend Server across candidate endpoints with auto-failover
        for (const serverBase of CANDIDATE_API_SERVERS) {
          if (dbUser) break;
          const normalizedBase = serverBase.replace(/\/+$/, '').replace('payment.youthnic.shop', 'payments.youthnic.shop');
          try {
            let srvRes = await fetch(`${normalizedBase}/api/auth/desktop-login`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${fbResult.idToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              }
            });

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
                if (serverRole !== 'analyst' && srvData.databaseUrl && !dbUrl && !isDesktopReachableDbUrl(srvData.databaseUrl)) {
                  // The API runs in Docker and may hand out its container-internal
                  // DATABASE_URL (e.g. postgres:5432). Adopting it would brick DB
                  // access with DNS errors, so selectDesktopDatabaseUrlForSession ignores it.
                  console.warn('[desktopServer] Ignored an unreachable database URL provisioned by the server. Set DESKTOP_DATABASE_URL on the API server, or configure the URL in Settings.');
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
                    console.warn('[desktopServer] Custom token exchange warning:', ctErr.message);
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
                    console.warn('[desktopServer] Token refresh warning:', refreshErr.message);
                  }
                }

                // Fail closed: do not persist session if role-claim token renewal failed
                if (!tokenRenewed) {
                  return sendJson(401, {
                    success: false,
                    error: 'Failed to refresh authentication token with newly assigned desktop role claims. Please verify your network connection and try logging in again.'
                  });
                }
                break;
              }
            } else if (srvRes.status === 403) {
              const errData = await srvRes.json().catch(() => ({}));
              if (errData.code === 'ACCESS_NOT_GRANTED') {
                return sendJson(403, {
                  success: false,
                  error: `User account '${userEmail}' authenticated in Firebase, but has not been granted access in ReconCentral. Please contact an administrator to add your email in Admin Center.`
                });
              }
              if (errData.error && errData.error.includes('not authorized')) {
                return sendJson(403, { success: false, error: errData.error });
              }
            }
          } catch (srvErr) {
            console.warn(`[desktopServer] Candidate server ${normalizedBase} query failed:`, srvErr.message);
          }
        }

        // 2. Strict direct PostgreSQL verification only if candidate servers were unreachable
        if (!dbUser && firebaseUid) {
          try {
            const pool = getPool();
            const res = await pool.query(
              'SELECT id, username, email, role, firebase_uid FROM users WHERE firebase_uid = $1 LIMIT 1',
              [firebaseUid]
            );
            if (res.rows.length > 0) {
              dbUser = res.rows[0];
            }
          } catch (dbErr) {
            return sendJson(500, { success: false, error: `Database error: ${dbErr.message}` });
          }
        }

        if (!dbUser) {
          return sendJson(403, { success: false, error: `User authenticated in Firebase, but no corresponding account with verified UID was found in ReconCentral database (${userEmail}). Please sign in through ReconCentral web app first to link your account.` });
        }

        const authorizedRoles = ['admin', 'operator', 'analyst'];
        const normalizedDbRole = String(dbUser.role || '').toLowerCase().trim();
        if (!authorizedRoles.includes(normalizedDbRole)) {
          return sendJson(403, {
            success: false,
            error: `Access denied. Role (${dbUser.role || 'viewer'}) is not authorized to operate rate card scrapers or synchronize database records.`
          });
        }

        // An analyst-provisioned read-only URL must never silently become a
        // later privileged session's URL: every write would fail on that
        // read-only principal.
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
            console.warn('[desktopServer] Final token refresh warning:', refErr.message);
          }
        }

        if (!tokenMatch.valid) {
          return sendJson(403, {
            success: false,
            error: `Authentication failed: The issued session token role ('${tokenMatch.tokenRole || 'none'}') does not match verified database role ('${normalizedDbRole}'). Please sign in through ReconCentral web app or verify user permissions in Admin Center.`
          });
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
          // different role cannot silently reuse it (analyst URLs are
          // read-only); without the marker the next authorizeSession would
          // refuse the stored URL to the analyst that provisioned it.
          config.databaseUrlRole = sessionDatabaseUrl ? normalizedDbRole : '';
          const savedConfig = saveConfig(config);
          if (!savedConfig.success) return sendJson(500, savedConfig);
        }
        const bound = bindBrowserSession(session);
        const savedSession = saveAuthSession(bound.session);
        if (!savedSession.success) return sendJson(500, savedSession);
        stagedExtraction.resetForAuthChange();
        disconnectTelemetryClients();
        await closeDesktopPool();
        setDesktopDatabaseAccess(normalizedDbRole, sessionDatabaseUrl);
        res.setHeader('Set-Cookie', bound.cookie);

        // Honest signal for clients: does the worker actually have a database URL?
        const databaseConfigured = Boolean(sessionDatabaseUrl);
        return sendJson(200, { success: true, session: publicSession(bound.session), databaseConfigured });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // GET /api/desktop/marketplaces
    if (pathname === '/api/desktop/marketplaces' && req.method === 'GET') {
      if (!(await requireDesktopAuth())) return;
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
      return sendJson(200, { success: true, marketplaces: list });
    }

    // GET /api/desktop/marketplace-accounts
    if (pathname === '/api/desktop/marketplace-accounts' && req.method === 'GET') {
      const session = await requireDesktopAuth();
      if (!session) return;
      const config = loadConfig();

      for (const serverBase of CANDIDATE_API_SERVERS) {
        const normalizedBase = serverBase.replace(/\/+$/, '').replace('payment.youthnic.shop', 'payments.youthnic.shop');
        try {
          const res = await fetch(`${normalizedBase}/api/marketplace-accounts`, {
            headers: { 'Authorization': `Bearer ${session.idToken}`, 'Accept': 'application/json' }
          });
          if (res.ok) {
            const body = await res.json();
            const accounts = Array.isArray(body) ? body : (body.accounts || []);
            return sendJson(200, { success: true, accounts });
          }
        } catch {}
      }

      // Fallback to local database if candidate API servers are unreachable
      try {
        const pool = getPool();
        const { rows } = await pool.query(`
          SELECT id, marketplace, account_id, display_name, seller_id, login_id, password_encrypted, portal_url, logo_url, is_active
          FROM marketplace_accounts
          WHERE is_active = true OR account_id IN ('myntra_vb', 'myntra_ej')
          ORDER BY 
            CASE 
              WHEN marketplace = 'flipkart' THEN 1
              WHEN marketplace = 'amazon' THEN 2
              WHEN marketplace = 'myntra' AND account_id = 'myntra_vb' THEN 3
              WHEN marketplace = 'myntra' AND account_id = 'myntra_ej' THEN 4
              WHEN marketplace = 'ajio' THEN 5
              WHEN marketplace = 'meesho' THEN 6
              WHEN marketplace = 'cocoblu' THEN 7
              WHEN marketplace = 'shopify' THEN 8
              ELSE 9
            END,
            id ASC
        `);
        const accounts = rows.map(r => ({
          id: r.id,
          marketplace: r.marketplace,
          account_id: r.account_id,
          display_name: r.display_name,
          seller_id: r.seller_id,
          login_id: r.login_id || '',
          has_password: Boolean(r.password_encrypted),
          portal_url: r.portal_url || DEFAULT_MARKETPLACE_METADATA[r.marketplace]?.portal_url || '',
          logo_url: r.logo_url || DEFAULT_MARKETPLACE_METADATA[r.marketplace]?.logo_url || '',
          is_active: r.is_active
        }));
        return sendJson(200, { success: true, count: accounts.length, accounts });
      } catch (dbErr) {
        return sendJson(502, { success: false, error: 'Could not connect to ReconCentral API or Database to fetch marketplace accounts.' });
      }
    }

    // POST /api/auth/logout
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      // Sign-out is a local-state clearing operation and must complete even
      // when the stored session already expired or was revoked — otherwise a
      // dead session could never be removed from this machine. Only the
      // origin policy stays: a cross-site page must not be able to force it.
      const origin = String(req.headers.origin || '');
      if (origin && !isSameDesktopOrigin(req) && !isAllowedDesktopOrigin(req)) {
        return sendJson(403, { success: false, error: 'Cross-origin sign-out is not allowed.' });
      }
      const cleared = clearAuthSession();
      res.setHeader('Set-Cookie', expiredBrowserCookie);
      await closeDesktopPool();
      setDesktopDatabaseAccess(null);
      // An undeleted session file keeps working tokens on disk that session
      // restoration would sign straight back in with: never claim a clean
      // deauthorization when the removal failed.
      if (!cleared.success) {
        return sendJson(500, {
          success: false,
          error: `Sign-out incomplete: the saved session could not be removed (${cleared.error}). Retry sign-out, or lock this PC until the session file can be deleted.`
        });
      }
      return sendJson(200, { success: true });
    }

    // POST /api/auth/verify-db
    if (pathname === '/api/auth/verify-db' && req.method === 'POST') {
      if (!(await requireDesktopAuth())) return;
      const start = Date.now();
      try {
        const pool = getPool();
        const res = await pool.query(`
          SELECT 
            current_database() as db_name, 
            current_user as db_user, 
            version() as db_version, 
            (SELECT count(*) FROM users) as user_count,
            (SELECT count(*) FROM rc_commission WHERE end_date IS NULL) as active_rates_count
        `);
        const latency = Date.now() - start;
        return sendJson(200, {
          success: true,
          latencyMs: latency,
          dbName: res.rows[0].db_name,
          dbUser: res.rows[0].db_user,
          userCount: parseInt(res.rows[0].user_count, 10),
          activeRatesCount: parseInt(res.rows[0].active_rates_count, 10)
        });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message, latencyMs: Date.now() - start });
      }
    }

    // POST /api/config
    if (pathname === '/api/config' && req.method === 'POST') {
      if (!(await requireDesktopAuth(true))) return;
      const body = await parseJsonBody();
      // Merge over the stored config so a partial body cannot wipe marketplace,
      // vertical, brand, or provisioned settings. The dead autoSyncToDb toggle
      // (staging is always manual-review) is never persisted again.
      const stored = loadConfig();
      const merged = { ...stored, ...(body || {}) };
      delete merged.autoSyncToDb;
      // A manually saved database URL is operator-entered: drop a stale analyst
      // read-only marker so the stored URL stays reusable by privileged roles.
      if (body && 'databaseUrl' in body && String(body.databaseUrl || '') !== String(stored.databaseUrl || '')) {
        merged.databaseUrlRole = '';
      }
      const result = saveConfig(merged);
      return sendJson(200, result);
    }

    // POST /api/test-db
    if (pathname === '/api/test-db' && req.method === 'POST') {
      if (!(await requireDesktopAuth())) return;
      try {
        const pool = getPool();
        const testRes = await pool.query('SELECT NOW() as now, current_database() as db');
        return sendJson(200, { success: true, db: testRes.rows[0].db, time: testRes.rows[0].now });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // POST /api/detect-changes
    if (pathname === '/api/detect-changes' && req.method === 'POST') {
      if (!(await requireDesktopAuth())) return;
      let body = null;
      try {
        body = await parseJsonBody();
        const pool = getPool();
        const cardsToTest = body.rateCards?.length ? body.rateCards : await buildBrandRateCardSet(pool);
        const changes = await detectBrandRateChanges(cardsToTest, pool);
        return sendJson(200, { success: true, changesCount: changes.length, changes, dbAvailable: true });
      } catch (err) {
        // /api/preview can serve staged cards without a database; change
        // detection cannot. Keep the staged review visible with an explicit
        // dbAvailable:false (diffs unknowable, commit disabled) instead of
        // failing the request and clearing the reviewed preview.
        if (body?.rateCards?.length) {
          return sendJson(200, { success: true, changesCount: 0, changes: [], dbAvailable: false });
        }
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // POST /api/sync (only reviewed staged extractions may be committed)
    if (pathname === '/api/sync' && req.method === 'POST') {
      if (!(await requireDesktopAuth(true))) return;
      try {
        const body = await parseJsonBody();
        if (!stagedExtraction.cards.length) {
          return sendJson(409, { success: false, error: 'Run a successful extraction and review its staged results before committing. Generated templates cannot be synced as live rates.' });
        }
        // Every sync must carry the exact reviewed subset; a payload-less
        // request must not bypass the review step and commit all staged cards.
        const cardsToSync = body.rateCards?.length ? selectStagedCards(stagedExtraction.cards, body.rateCards) : null;
        if (!cardsToSync) {
          return sendJson(409, { success: false, error: 'Payload does not match the reviewed staged extraction. Review the staged results and commit the selected cards explicitly.' });
        }
        const pool = getPool();
        broadcastProgress('Initiating database synchronization with date auto-closing...');
        const result = await syncBrandRateCardsToDatabase(cardsToSync, { forceUpdate: true, ...body.options }, pool);
        broadcastProgress(`✓ ${result.message}`);
        return sendJson(200, { success: true, result });
      } catch (err) {
        broadcastProgress(`❌ Database sync failed: ${err.message}`);
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // POST /api/scrape/start
    if (pathname === '/api/scrape/start' && req.method === 'POST') {
      if (!(await requireDesktopAuth())) return;
      if (activeScrapeJob.running) {
        return sendJson(409, { success: false, error: 'A scraping job is already running.' });
      }
      // Browser tasks (scraping, interactive logins) share the cookie vault:
      // serialize them through the same gate the Electron IPC paths use.
      if (withBrowserTask.busy) {
        return sendJson(409, { success: false, error: 'A browser task is already running. Finish login or extraction before starting another.' });
      }

      const body = await parseJsonBody();
      const config = loadConfig();
      const targetMp = body.marketplace || config.marketplace || 'both';
      const normalizedChannel = String(targetMp).toLowerCase().trim();
      const mpConfig = SUPPORTED_MARKETPLACES.find(m => m.id === normalizedChannel || m.marketplace === normalizedChannel);
      const validFlipkartAliases = ['both', 'flipkart', 'shopsy', 'flipkart_shopsy'];

      if (!mpConfig && !validFlipkartAliases.includes(normalizedChannel)) {
        return sendJson(400, {
          success: false,
          error: `Unsupported marketplace: '${targetMp}'. Supported channels are: ${SUPPORTED_MARKETPLACES.map(m => m.id).join(', ')}.`
        });
      }

      if (mpConfig && !mpConfig.hasScraper) {
        return sendJson(400, {
          success: false,
          error: `Automated scraping is not yet implemented for ${mpConfig.name}. Automated scrapers are currently active for Flipkart & Shopsy. Use "🔑 Human Login (2FA)" to authorize and store your session for Phase 2.`
        });
      }
      const isVisible = body.mode === 'visible' || body.visible === true;
      const targetBrands = body.brands || config.selectedBrands;
      const targetVerticals = body.verticals || config.selectedVerticals;

      // Re-check after the body await: a request that raced past the earlier
      // checks while this body was parsing must not overwrite the running job.
      if (activeScrapeJob.running || withBrowserTask.busy) {
        return sendJson(409, { success: false, error: 'A scraping job is already running.' });
      }

      // A new run supersedes the previous staging; a failed run must not leave
      // old cards syncable. Wipe only once the request has been fully accepted.
      stagedExtraction.cards = [];
      const jobAuthGeneration = stagedExtraction.authGeneration;

      activeScrapeJob = {
        running: true,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        progress: [],
        lastResult: null,
        error: null,
        options: { marketplace: targetMp, visible: isVisible, brands: targetBrands, verticals: targetVerticals }
      };

      // Run scraping job asynchronously
      (async () => {
        try {
          broadcastProgress(`🚀 Scraper job initiated (${targetMp.toUpperCase()} | Mode: ${isVisible ? 'Visible Chrome' : 'Stealth'})...`);
          const result = await withBrowserTask(() => scrapeFlipkartRateCards(
            {
              marketplace: normalizedChannel,
              visible: isVisible,
              selectedVerticals: targetVerticals,
              email: config.email,
              password: config.password
            },
            { onProgress: broadcastProgress }
          ));

          if (result.success && jobAuthGeneration !== stagedExtraction.authGeneration) {
            result.success = false;
            result.error = 'The account changed while the extraction was running. Results were discarded; run the extraction again.';
          } else if (result.success) {
            try {
              stagedExtraction.cards = normalizeScrapedCards(result.data);
              result.rateCards = stagedExtraction.cards;
            } catch (stageErr) {
              result.success = false;
              result.error = `Extraction review staging failed: ${stageErr.message}`;
            }
          }
          activeScrapeJob.running = false;
          activeScrapeJob.status = result.success ? 'completed' : 'failed';
          activeScrapeJob.finishedAt = new Date().toISOString();
          activeScrapeJob.lastResult = result;
          broadcastProgress(`✓ Scraping job completed with status: ${activeScrapeJob.status}`);
        } catch (jobErr) {
          activeScrapeJob.running = false;
          activeScrapeJob.status = 'error';
          activeScrapeJob.finishedAt = new Date().toISOString();
          activeScrapeJob.error = jobErr.message;
          broadcastProgress(`❌ Scraping job encountered error: ${jobErr.message}`);
        }
      })();

      return sendJson(202, {
        success: true,
        message: 'Scraping job started successfully.',
        job: activeScrapeJob
      });
    }

    // POST /api/export-excel
    if (pathname === '/api/export-excel' && req.method === 'POST') {
      if (!(await requireDesktopAuth())) return;
      try {
        const body = await parseJsonBody();
        const pool = getPool();
        const targetPath = body.path || DEFAULT_EXCEL_PATH;
        broadcastProgress(`Generating multi-sheet Excel file at ${targetPath}...`);
        const result = await generateBrandwiseRateCardExcel(targetPath, pool);
        broadcastProgress(`✓ Excel generated: ${result.sheetsCount} sheets, ${result.totalRecords} records.`);
        return sendJson(200, { success: true, ...result });
      } catch (err) {
        broadcastProgress(`❌ Excel export failed: ${err.message}`);
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // POST /api/interactive-login (Standalone Puppeteer with Encrypted Cookie Vault Capture)
    if (pathname === '/api/interactive-login' && req.method === 'POST') {
      if (!(await requireDesktopAuth())) return;
      // Browser tasks (scraping, interactive logins) share the cookie vault:
      // serialize them through the same gate the Electron IPC paths use.
      if (withBrowserTask.busy) {
        return sendJson(409, { success: false, error: 'A browser task is already running. Finish login or extraction before starting another.' });
      }

      try {
        const body = await parseJsonBody();
        const targetId = (body.marketplace || body.id || 'flipkart_shopsy').toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const mpConfig = SUPPORTED_MARKETPLACES.find(m => m.id === targetId || m.marketplace === targetId) || SUPPORTED_MARKETPLACES[0];
        const portalUrl = mpConfig.loginUrl || mpConfig.portalUrl || body.portal_url || 'https://seller.flipkart.com/';
        const cookiesPath = getMarketplaceCookiesPath(mpConfig.id);
        const chromePath = getChromeExecutablePath();
        const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), `recon-login-${targetId}-`));

        broadcastProgress(`Launching interactive browser for ${mpConfig.name} at ${portalUrl}...`);

        // The browser slot is claimed synchronously right before the response:
        // withBrowserTask acquires in its synchronous prefix, so a request
        // that raced past the earlier busy check while its body was still
        // parsing gets an honest 409 instead of a false "launched" 200.
        if (withBrowserTask.busy) {
          try { fs.rmSync(tempProfileDir, { recursive: true, force: true }); } catch {}
          return sendJson(409, { success: false, error: 'A browser task is already running. Finish login or extraction before starting another.' });
        }
        withBrowserTask(async () => {
          let browser = null;
          try {
            browser = await puppeteer.launch({
              headless: false,
              executablePath: chromePath,
              userDataDir: tempProfileDir,
              defaultViewport: null,
              args: [
                '--no-first-run',
                '--no-default-browser-check',
                '--window-size=1280,800'
              ]
            });
            const pages = await browser.pages();
            const page = pages.length > 0 ? pages[0] : await browser.newPage();

            // Load existing encrypted session cookies if present
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

            await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            broadcastProgress(`✓ Browser window opened for ${mpConfig.name}. Please complete 2FA or human login in the window...`);

            await page.waitForFunction((id) => {
              const href = window.location.href.toLowerCase();
              const body = document.body ? document.body.innerText.toLowerCase() : '';
              const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
              if (hasPasswordInput) return false;
              const hasLoginForm = Boolean(document.querySelector('form[action*="login" i], form[action*="signin" i], form[action*="auth" i]'));
              if (hasLoginForm && (href.includes('/login') || href.includes('/auth') || href.includes('/signin'))) return false;

              if (id === 'myntra_vb' || id === 'myntra_ej') {
                return href.includes('partnerportal.myntra.com') && !href.includes('/login') && (href.includes('dashboard') || href.includes('home') || body.includes('logout'));
              }
              if (id === 'meesho') {
                return href.includes('supplier.meesho.com') && !href.includes('/login') && (href.includes('panel') || href.includes('dashboard') || body.includes('logout'));
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
              return href.includes('#dashboard') || body.includes('seller dashboard') || body.includes('ethnicjunction') || body.includes('logout');
            }, { timeout: 300000 }, mpConfig.id);

            const cookies = await page.cookies();
            saveEncryptedCookies(cookiesPath, cookies);
            if (mpConfig.id === 'flipkart_shopsy' || mpConfig.marketplace === 'flipkart') {
              saveEncryptedCookies(COOKIES_PATH, cookies);
            }
            broadcastProgress(`✓ Authentication detected! Encrypted and saved ${cookies.length} session cookies into vault.`);
          } catch (loginErr) {
            broadcastProgress(`❌ Interactive login error for ${mpConfig.name}: ${loginErr.message}`);
          } finally {
            if (browser) {
              await browser.close().catch(() => {});
            }
            try {
              fs.rmSync(tempProfileDir, { recursive: true, force: true });
            } catch {}
          }
          return { ran: true };
        }).then((gate) => {
          // Unreachable while the busy check above stays adjacent to the call,
          // kept as defense in depth: a lost race must never leave a temp
          // profile behind or stay silent about skipping the login.
          if (!gate || gate.ran !== true) {
            try { fs.rmSync(tempProfileDir, { recursive: true, force: true }); } catch {}
            broadcastProgress('⏳ Interactive login skipped: another browser task is already running. Finish it and try again.');
          }
        }).catch(() => {});

        return sendJson(200, { 
          success: true, 
          message: `Interactive login window launched for ${mpConfig.name}. Please complete login in the window. Cookies will be encrypted and saved to the cookie vault.`, 
          portal_url: portalUrl 
        });
      } catch (err) {
        broadcastProgress(`❌ Failed to launch browser: ${err.message}`);
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // POST /api/open-excel (Cross-Platform)
    if (pathname === '/api/open-excel' && req.method === 'POST') {
      if (!(await requireDesktopAuth())) return;
      const body = await parseJsonBody();
      const filePath = body.path || DEFAULT_EXCEL_PATH;
      try {
        await openFileCrossPlatform(filePath);
        broadcastProgress(`✓ Launched spreadsheet viewer with: ${filePath}`);
        return sendJson(200, { success: true, filePath });
      } catch (openErr) {
        return sendJson(404, { success: false, error: openErr.message });
      }
    }

    // ── 4. Static File Serving (desktop/ui) ──────────────────────────────────
    let filePath = path.normalize(path.join(UI_DIR, pathname === '/' ? 'index.html' : pathname));
    if (filePath !== UI_DIR && !filePath.startsWith(UI_DIR + path.sep)) {
      return sendJson(403, { success: false, error: 'Forbidden: Invalid static asset path.' });
    }
    if (!fs.existsSync(filePath)) {
      filePath = path.join(UI_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.json': 'application/json'
    };

    const mime = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);

  } catch (err) {
    console.error('Server error:', err);
    sendJson(500, { error: err.message });
  }
});

// Launch Chrome App (Cross-Platform)
function launchChromeApp() {
  const isLinux = process.platform === 'linux';
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

  // If running in headless Linux environment (no X11 / Wayland), do not spawn GUI
  if (isLinux && !hasDisplay) {
    console.log('[Launcher] Headless Linux detected (no DISPLAY or WAYLAND_DISPLAY).');
    console.log(`[Launcher] Access the Desktop Web Control Center at: http://localhost:${PORT}/index.html`);
    return;
  }

  const chromePath = getChromeExecutablePath();
  const appUrl = `http://localhost:${PORT}/index.html`;

  if (chromePath && fs.existsSync(chromePath)) {
    console.log(`[Launcher] Launching Desktop App Window via Chrome: ${chromePath}`);
    spawn(chromePath, [
      `--app=${appUrl}`,
      '--window-size=1360,900',
      '--disable-extensions'
    ], { detached: true, stdio: 'ignore' }).unref();
  } else {
    console.log(`[Launcher] Chrome executable not found at ${chromePath}. Opening default browser...`);
    const executable = process.platform === 'win32' ? 'rundll32.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', appUrl] : [appUrl];
    execFile(executable, args, () => {});
  }
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename));
if (isDirectRun) {
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Desktop Server] Port ${PORT} is already in use.`);
      // Verify whether the active listener is genuinely ReconCentral RateCard Server
      try {
        const probeRes = await fetch(`http://127.0.0.1:${PORT}/api/desktop/health`, {
          signal: AbortSignal.timeout(1500)
        });
        if (probeRes.ok) {
          const body = await probeRes.json().catch(() => ({}));
          if (body && body.service === 'reconcentral-ratecard-desktop') {
            console.log(`[Desktop Server] Verified active ReconCentral RateCard Server at http://127.0.0.1:${PORT}. Connecting UI.`);
            launchChromeApp();
            process.exit(0);
          }
        }
      } catch {}
      console.error(`[Desktop Server] Refusing to launch UI: Port ${PORT} is occupied by an unrecognized listener. Stop the competing process or specify a different PORT.`);
      process.exit(1);
    } else {
      console.error('[Desktop Server] Fatal server error:', err);
      process.exit(1);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('======================================================================');
    console.log(`⚡ ReconCentral RateCard Desktop Control Server running on port ${PORT}`);
    console.log(`Platform: ${process.platform} (${process.arch}) | Node: ${process.version}`);
    console.log(`Desktop UI URL: http://127.0.0.1:${PORT}`);
    console.log('======================================================================\n');
    launchChromeApp();
  });
}

export { server, PORT, SUPPORTED_MARKETPLACES, launchChromeApp };
