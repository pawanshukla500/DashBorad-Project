#!/usr/bin/env node
/**
 * ReconCentral Desktop Control Center — Standalone Desktop Server & App Launcher
 * 
 * Runs a local server and launches Google Chrome in frameless native App Mode (--app=...).
 * Works on any Windows / Linux workstation without needing full Electron compilation.
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
import { getPool } from '../backend/db/index.js';

const PORT = 3388;
const UI_DIR = path.join(__dirname, 'ui');
const CONFIG_FILE = path.join(__dirname, 'worker-config.json');

const sseClients = new Set();

function broadcastProgress(msg) {
  const data = `data: ${JSON.stringify({ message: msg, time: new Date().toLocaleTimeString() })}\n\n`;
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
  marketplace: 'both',
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

// ── HTTP Request Handler ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    // 2. API Routes
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(200, loadConfig());
    }

    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await parseJsonBody();
      const result = saveConfig(body);
      return sendJson(200, result);
    }

    if (pathname === '/api/test-db' && req.method === 'POST') {
      try {
        const pool = getPool();
        const testRes = await pool.query('SELECT NOW() as now, current_database() as db');
        return sendJson(200, { success: true, db: testRes.rows[0].db, time: testRes.rows[0].now });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    if (pathname === '/api/catalog' && req.method === 'GET') {
      try {
        const pool = getPool();
        const catalog = await getRealTimeBrandFsnSamples(pool);
        return sendJson(200, { success: true, catalog });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    if (pathname === '/api/preview' && req.method === 'GET') {
      try {
        const pool = getPool();
        const rateCards = await buildBrandRateCardSet(pool);
        return sendJson(200, { success: true, rateCards });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    if (pathname === '/api/detect-changes' && req.method === 'POST') {
      try {
        const body = await parseJsonBody();
        const pool = getPool();
        const changes = await detectBrandRateChanges(body.rateCards || [], pool);
        return sendJson(200, { success: true, changes });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    if (pathname === '/api/sync' && req.method === 'POST') {
      try {
        const body = await parseJsonBody();
        const pool = getPool();
        broadcastProgress('Starting database synchronization with auto-closing...');
        const result = await syncBrandRateCardsToDatabase(body.rateCards || [], { forceUpdate: true }, pool);
        broadcastProgress(`✓ ${result.message}`);
        return sendJson(200, { success: true, result });
      } catch (err) {
        broadcastProgress(`❌ Database sync failed: ${err.message}`);
        return sendJson(500, { success: false, error: err.message });
      }
    }

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

    if (pathname === '/api/open-excel' && req.method === 'POST') {
      const body = await parseJsonBody();
      const filePath = body.path || DEFAULT_EXCEL_PATH;
      if (fs.existsSync(filePath)) {
        exec(`start "" "${filePath}"`);
        broadcastProgress(`✓ Launched Microsoft Excel with ${filePath}`);
        return sendJson(200, { success: true, filePath });
      } else {
        return sendJson(404, { success: false, error: 'File does not exist: ' + filePath });
      }
    }

    // 3. Static File Serving (desktop/ui)
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

// Launch Chrome App
function launchChromeApp() {
  const possibleChromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser'
  ];

  const chromePath = possibleChromePaths.find(p => fs.existsSync(p));
  const appUrl = `http://localhost:${PORT}/index.html`;

  if (chromePath) {
    console.log(`[Launcher] Launching Desktop App Window via Chrome: ${chromePath}`);
    spawn(chromePath, [
      `--app=${appUrl}`,
      '--window-size=1360,900',
      '--disable-extensions'
    ], { detached: true, stdio: 'ignore' }).unref();
  } else {
    console.log(`[Launcher] Chrome executable not found. Opening default browser to: ${appUrl}`);
    exec(`start ${appUrl}`);
  }
}

server.listen(PORT, () => {
  console.log('================================================================');
  console.log(`⚡ ReconCentral RateCard Desktop Control Server running on port ${PORT}`);
  console.log(`Desktop UI URL: http://localhost:${PORT}`);
  console.log('================================================================\n');
  launchChromeApp();
});
