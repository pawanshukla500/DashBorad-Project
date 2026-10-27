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

const PORT = 3388;
const UI_DIR = path.join(__dirname, 'ui');
const CONFIG_FILE = path.join(__dirname, 'worker-config.json');
const STAGING_DIR = path.join(__dirname, 'staging');

fs.mkdirSync(STAGING_DIR, { recursive: true });

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
  marketplace: 'both', // 'flipkart', 'shopsy', or 'both'
  email: 'Vbexports@outlook.com',
  password: process.env.FK_PASSWORD || '',
  databaseUrl: process.env.DATABASE_URL || '',
  scheduledHour: 6,
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
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
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
        return sendJson(200, { success: true, count: rateCards.length, rateCards });
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
