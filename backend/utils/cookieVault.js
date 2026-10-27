import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encryptCredential, decryptCredential } from './credentialCrypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolves a safe writable user-data directory across Windows, Linux, and macOS.
 * Prioritizes RECON_USER_DATA_DIR (set by Electron app and desktop server).
 * Prevents any writes to installation directories (e.g. C:\Program Files).
 */
export function getResolvedUserDataDir() {
  if (process.env.RECON_USER_DATA_DIR) {
    return process.env.RECON_USER_DATA_DIR;
  }
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  
  if (isWin && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'ReconCentral RateCard Worker');
  }
  if (isMac && process.env.HOME) {
    return path.join(process.env.HOME, 'Library', 'Application Support', 'ReconCentral RateCard Worker');
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, '.config', 'reconcentral-ratecard-worker');
  }
  return path.join(__dirname, '../../.runtime');
}

/**
 * Resolves cookie vault file path for a given marketplace channel.
 */
export function getResolvedCookiesPath(channel = 'flipkart_shopsy') {
  if (process.env.RECON_COOKIES_PATH && (!channel || channel === 'flipkart_shopsy' || channel === 'flipkart')) {
    return process.env.RECON_COOKIES_PATH;
  }
  const userDir = getResolvedUserDataDir();
  const normalizedId = String(channel || 'flipkart_shopsy').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (normalizedId === 'flipkart_shopsy' || normalizedId === 'flipkart') {
    return path.join(userDir, 'cookies.json');
  }
  return path.join(userDir, `cookies_${normalizedId}.json`);
}

/**
 * Resolves captures directory inside safe user-data path.
 */
export function getResolvedCapturesDir() {
  const userDir = getResolvedUserDataDir();
  return path.join(userDir, 'ratecard_captures');
}

/**
 * Saves cookies encrypted with AES-256-GCM.
 */
export function saveEncryptedCookies(filePath, cookies) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const serialized = JSON.stringify(cookies, null, 2);
  const encrypted = encryptCredential(serialized);
  fs.writeFileSync(filePath, encrypted, 'utf8');
}

/**
 * Loads cookies with AES-256-GCM decryption, with legacy plaintext JSON fallback.
 */
export function loadEncryptedCookies(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    // Check if AES-256-GCM serialized format: ivHex:authTagHex:ciphertextHex
    if (raw.includes(':')) {
      try {
        const decrypted = decryptCredential(raw);
        if (decrypted) return JSON.parse(decrypted);
      } catch {}
    }
    // Fallback to plain JSON for existing unencrypted sessions
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
