#!/usr/bin/env node
/**
 * ReconCentral Desktop Control Center — Standalone Desktop Server & App Launcher
 * 
 * Cross-platform (Windows & Linux) desktop engine and REST API server for
 * Flipkart and Shopsy rate card extraction, change detection, and PostgreSQL synchronization.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';

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
} from '../backend/services/brandRateCardService.js';
import { 
  generateBrandwiseRateCardExcel, 
  DEFAULT_EXCEL_PATH 
} from '../backend/services/brandwiseExcelExport.js';
import { getChromeExecutablePath, scrapeFlipkartRateCards } from '../backend/services/flipkartRateCardExtractor.js';
import { getPool } from '../backend/db/index.js';
import { decryptCredential } from '../backend/utils/credentialCrypto.js';
import { DEFAULT_MARKETPLACE_METADATA } from '../backend/routes/marketplaceAccounts.js';

const PORT = 3388;
const UI_DIR = path.join(__dirname, 'ui');

function resolveUserDataDir() {
  if (process.env.RECONCENTRAL_USER_DATA) return process.env.RECONCENTRAL_USER_DATA;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'reconcentral-ratecard-worker');
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
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

const CONFIG_FILE = path.join(USER_DATA_DIR, 'worker-config.json');
const SESSION_FILE = path.join(USER_DATA_DIR, 'auth-session.json');
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

function loadAuthSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, 'utf8');
      const session = JSON.parse(raw);
      if (session && session.user && session.authenticated) {
        return session;
      }
    }
  } catch (err) {}
  return { authenticated: false, user: null };
}

function saveAuthSession(sessionData) {
  try {
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

const sseClients = new Set();
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
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
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

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Cross-Platform File Launcher
function openFileCrossPlatform(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const cmd = isWin ? `start "" "${filePath}"` : (isMac ? `open "${filePath}"` : `xdg-open "${filePath}"`);
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve(filePath);
    });
  });
}

// ── HTTP Request Handler ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  // CORS headers for local API consumers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. SSE Stream for Live Telemetry
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Helper to parse JSON body
  const parseJsonBody = () => new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });

  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {
    // ── 2. GET API Endpoints ─────────────────────────────────────────────────

    // GET /api/health
    if (pathname === '/api/health' && req.method === 'GET') {
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

    // GET /api/auth/session
    if (pathname === '/api/auth/session' && req.method === 'GET') {
      return sendJson(200, loadAuthSession());
    }

    // GET /api/config
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(200, loadConfig());
    }


    // GET /api/catalog
    if (pathname === '/api/catalog' && req.method === 'GET') {
      try {
        const pool = getPool();
        const catalog = await getRealTimeBrandFsnSamples(pool);
        return sendJson(200, { success: true, count: catalog.length, catalog });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // GET /api/preview
    if (pathname === '/api/preview' && req.method === 'GET') {
      try {
        const pool = getPool();
        const rateCards = await buildBrandRateCardSet(pool);
        const targetMp = (urlObj.searchParams.get('marketplace') || urlObj.searchParams.get('channel') || '').toLowerCase().trim();
        let filteredRateCards = rateCards;
        if (targetMp && targetMp !== 'both' && targetMp !== 'all' && targetMp !== 'flipkart_shopsy') {
          filteredRateCards = rateCards.filter(rc => (rc.marketplace || '').toLowerCase() === targetMp);
        }
        return sendJson(200, { success: true, count: filteredRateCards.length, rateCards: filteredRateCards });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // GET /api/active-rates
    if (pathname === '/api/active-rates' && req.method === 'GET') {
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
      return sendJson(200, activeScrapeJob);
    }

    // GET /api/excel/status
    if (pathname === '/api/excel/status' && req.method === 'GET') {
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
        let provisionedDbUrl = dbUrl;

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
                if (srvData.customToken && !tokenRenewed) {
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
        if (!authorizedRoles.includes(dbUser.role)) {
          return sendJson(403, {
            success: false,
            error: `Access denied. Role (${dbUser.role || 'viewer'}) is not authorized to operate rate card scrapers or synchronize database records.`
          });
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

        return sendJson(200, { success: true, session });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // GET /api/desktop/marketplaces
    if (pathname === '/api/desktop/marketplaces' && req.method === 'GET') {
      const list = SUPPORTED_MARKETPLACES.map(m => {
        const cookiesPath = getMarketplaceCookiesPath(m.id);
        const hasCookies = fs.existsSync(cookiesPath);
        return {
          ...m,
          hasCookies,
          cookiesPath
        };
      });
      return sendJson(200, { success: true, marketplaces: list });
    }

    // GET /api/desktop/marketplace-accounts
    if (pathname === '/api/desktop/marketplace-accounts' && req.method === 'GET') {
      const session = loadAuthSession();
      const config = loadConfig();
      if (!session || !session.idToken) {
        return sendJson(401, { success: false, error: 'Not authenticated with ReconCentral.' });
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
      clearAuthSession();
      return sendJson(200, { success: true });
    }

    // POST /api/auth/verify-db
    if (pathname === '/api/auth/verify-db' && req.method === 'POST') {
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
      const body = await parseJsonBody();
      const result = saveConfig(body);
      return sendJson(200, result);
    }

    // POST /api/test-db
    if (pathname === '/api/test-db' && req.method === 'POST') {
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
      try {
        const body = await parseJsonBody();
        const pool = getPool();
        const cardsToTest = body.rateCards?.length ? body.rateCards : await buildBrandRateCardSet(pool);
        const changes = await detectBrandRateChanges(cardsToTest, pool);
        return sendJson(200, { success: true, changesCount: changes.length, changes });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // POST /api/sync
    if (pathname === '/api/sync' && req.method === 'POST') {
      try {
        const body = await parseJsonBody();
        const pool = getPool();
        broadcastProgress('Initiating database synchronization with date auto-closing...');
        const cardsToSync = body.rateCards?.length ? body.rateCards : await buildBrandRateCardSet(pool);
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
      if (activeScrapeJob.running) {
        return sendJson(409, { success: false, error: 'A scraping job is already running.' });
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
          const result = await scrapeFlipkartRateCards({
            email: config.email,
            password: config.password,
            headless: isVisible ? false : 'new',
            verticals: targetVerticals,
            onProgress: broadcastProgress
          });

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

    // POST /api/interactive-login
    if (pathname === '/api/interactive-login' && req.method === 'POST') {
      try {
        const body = await parseJsonBody();
        const targetId = (body.marketplace || body.id || 'flipkart_shopsy').toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const mpConfig = SUPPORTED_MARKETPLACES.find(m => m.id === targetId || m.marketplace === targetId) || SUPPORTED_MARKETPLACES[0];
        const portalUrl = mpConfig.loginUrl || mpConfig.portalUrl || body.portal_url || 'https://seller.flipkart.com/';
        const chromePath = getChromeExecutablePath();
        const channelProfileDir = path.join(USER_DATA_DIR, 'chrome-profiles', targetId);
        if (!fs.existsSync(channelProfileDir)) {
          fs.mkdirSync(channelProfileDir, { recursive: true });
        }

        broadcastProgress(`Launching interactive browser for ${mpConfig.name} at ${portalUrl}...`);
        const args = [
          `--user-data-dir=${channelProfileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          portalUrl
        ];
        const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
        child.unref();

        broadcastProgress(`✓ Browser window opened for ${mpConfig.name}. Please complete 2FA or human login in the window.`);
        return sendJson(200, { success: true, message: `Browser launched successfully for ${mpConfig.name}`, portal_url: portalUrl });
      } catch (err) {
        broadcastProgress(`❌ Failed to launch browser: ${err.message}`);
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // POST /api/open-excel (Cross-Platform)
    if (pathname === '/api/open-excel' && req.method === 'POST') {
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
    let filePath = path.join(UI_DIR, pathname === '/' ? 'index.html' : pathname);
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
    openFileCrossPlatform(appUrl).catch(() => null);
  }
}

server.listen(PORT, () => {
  console.log('======================================================================');
  console.log(`⚡ ReconCentral RateCard Desktop Control Server running on port ${PORT}`);
  console.log(`Platform: ${process.platform} (${process.arch}) | Node: ${process.version}`);
  console.log(`Desktop UI URL: http://localhost:${PORT}`);
  console.log('======================================================================\n');
  launchChromeApp();
});
