import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits authentication tag

/**
 * Resolves a safe writable user-data directory across Windows, Linux, and macOS.
 * Prioritizes RECON_USER_DATA_DIR (set by Electron app and desktop server).
 * Prevents any writes to installation directories (e.g. C:\Program Files or /opt).
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
  return path.join(__dirname, '.runtime');
}

/**
 * Gets or provisions a secure per-installation 256-bit encryption key.
 * 1. Checks CREDENTIALS_ENCRYPTION_KEY / ENCRYPTION_KEY / JWT_SECRET.
 * 2. If absent, checks or provisions a machine-local, cryptographically random key
 *    stored in `<USER_DATA_DIR>/.vault_key` with strict permissions (0o600).
 * This guarantees that every desktop install has a distinct, secret key not found in source code.
 */
export function getVaultMasterKey() {
  const envSecret = process.env.CREDENTIALS_ENCRYPTION_KEY 
    || process.env.ENCRYPTION_KEY 
    || process.env.JWT_SECRET;
  
  if (envSecret && String(envSecret).trim()) {
    return crypto.createHash('sha256').update(String(envSecret).trim()).digest();
  }

  const userDir = getResolvedUserDataDir();
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  const keyFilePath = path.join(userDir, '.vault_key');
  try {
    if (fs.existsSync(keyFilePath)) {
      const storedKey = fs.readFileSync(keyFilePath, 'utf8').trim();
      if (storedKey && storedKey.length >= 32) {
        return crypto.createHash('sha256').update(storedKey).digest();
      }
    }
  } catch {}

  // Generate a fresh cryptographically random 256-bit key using exclusive atomic creation ('wx')
  const randomSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyFilePath, randomSecret, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return crypto.createHash('sha256').update(randomSecret).digest();
  } catch (err) {
    if (err.code === 'EEXIST') {
      try {
        const storedKey = fs.readFileSync(keyFilePath, 'utf8').trim();
        if (storedKey && storedKey.length >= 32) {
          return crypto.createHash('sha256').update(storedKey).digest();
        }
      } catch {}
    }
    throw new Error(`Failed to persist encryption key to ${keyFilePath}: ${err.message}`);
  }
}

/**
 * Encrypts data using AES-256-GCM with unique IV and authentication tag.
 */
export function encryptVaultData(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  const key = getVaultMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext}`;
}

/**
 * Decrypts AES-256-GCM data.
 */
export function decryptVaultData(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') return null;
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) return null;
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = getVaultMasterKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
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
  const encrypted = encryptVaultData(serialized);
  fs.writeFileSync(filePath, encrypted, 'utf8');
}

/**
 * Loads cookies with AES-256-GCM decryption, with legacy plaintext JSON fallback.
 */
export function loadEncryptedCookies(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      const candidates = [
        path.join(path.dirname(filePath), 'cookies.json'),
        path.join(path.dirname(filePath), '..', 'cookies.json'),
        path.join(process.cwd(), '.runtime', path.basename(filePath)),
        path.join(process.cwd(), '.runtime', 'cookies.json'),
        path.join(__dirname, '..', '.runtime', 'cookies.json'),
        path.join(__dirname, '.runtime', 'cookies.json')
      ];
      for (const cand of candidates) {
        if (cand !== filePath && fs.existsSync(cand)) {
          try {
            const raw = fs.readFileSync(cand, 'utf8').trim();
            if (raw) {
              let fallbackCookies = null;
              if (raw.includes(':')) {
                try {
                  const dec = decryptVaultData(raw);
                  if (dec) fallbackCookies = JSON.parse(dec);
                } catch {}
              }
              if (!fallbackCookies) {
                try {
                  fallbackCookies = JSON.parse(raw);
                } catch {}
              }
              if (Array.isArray(fallbackCookies) && fallbackCookies.length > 0) {
                try {
                  saveEncryptedCookies(filePath, fallbackCookies);
                } catch {}
                return fallbackCookies;
              }
            }
          } catch {}
        }
      }
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    // Check if AES-256-GCM serialized format: ivHex:authTagHex:ciphertextHex
    if (raw.includes(':')) {
      try {
        const decrypted = decryptVaultData(raw);
        if (decrypted) return JSON.parse(decrypted);
      } catch {}
    }
    // Fallback to plain JSON for existing unencrypted sessions
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
