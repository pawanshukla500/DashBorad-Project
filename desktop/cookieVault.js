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

export const DEFAULT_MAX_COOKIE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // Session-vault retention; never extends portal cookie expiry

/**
 * Deletes encrypted cookies file from disk safely.
 */
export function deleteEncryptedCookies(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Removes a saved cookie snapshot and fails closed if an existing file remains.
 * Reset-session flows use this before deleting a browser profile so a stale
 * encrypted snapshot can never be silently restored on the next launch.
 */
export function clearEncryptedCookieSnapshot(filePath, { fsModule = fs, remove = deleteEncryptedCookies } = {}) {
  if (!filePath) throw new Error('Cookie snapshot path is required.');
  const exists = () => {
    try {
      fsModule.lstatSync(filePath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };
  if (!exists()) return true;
  remove(filePath);
  if (exists()) {
    throw new Error(`Could not remove the saved cookie snapshot ${path.basename(filePath)}.`);
  }
  return true;
}

/**
 * Checks if a cookie array or saved session has expired.
 */
export function areCookiesExpired(cookies, maxAgeMs = DEFAULT_MAX_COOKIE_AGE_MS, savedAt = null) {
  if (!Array.isArray(cookies) || cookies.length === 0) return true;
  if (savedAt && typeof savedAt === 'number' && (Date.now() - savedAt > maxAgeMs)) {
    return true;
  }
  const nowSec = Date.now() / 1000;
  // If the cookie jar contains pure session cookies (no expires or expires <= 0, or session === true),
  // they remain active and valid within the savedAt TTL window
  const hasPureSessionCookies = cookies.some(c => c && (!c.expires || c.expires <= 0 || c.session === true));
  if (hasPureSessionCookies) {
    return false;
  }
  // If all cookies are persistent, ensure at least one has not expired
  const persistentCookies = cookies.filter(c => c && typeof c.expires === 'number' && c.expires > 0);
  if (persistentCookies.length > 0) {
    const validCookies = persistentCookies.filter(c => c.expires > nowSec);
    if (validCookies.length === 0) return true;
  }
  return false;
}

function extractValidCookies(parsed, statMtimeMs, maxAgeMs) {
  if (!parsed) return null;
  let cookies = null;
  let savedAt = null;
  if (Array.isArray(parsed)) {
    cookies = parsed;
    savedAt = statMtimeMs;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.cookies)) {
    cookies = parsed.cookies;
    savedAt = typeof parsed.saved_at === 'number' ? parsed.saved_at : statMtimeMs;
  }
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) return null;
  if (areCookiesExpired(cookies, maxAgeMs, savedAt)) {
    return null;
  }
  return cookies.filter(c => c && (!c.expires || c.expires <= 0 || c.expires > Date.now() / 1000));
}

/**
 * Saves cookies encrypted with AES-256-GCM along with save timestamp.
 */
export function saveEncryptedCookies(filePath, cookies) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const payload = {
    saved_at: Date.now(),
    cookies: Array.isArray(cookies) ? cookies : []
  };
  const serialized = JSON.stringify(payload, null, 2);
  const encrypted = encryptVaultData(serialized);
  fs.writeFileSync(filePath, encrypted, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function isPlaintextCookieSnapshot(raw) {
  try {
    const parsed = JSON.parse(raw);
    const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies;
    return Array.isArray(cookies) && cookies.length > 0 && cookies.every(cookie =>
      cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string' && typeof cookie.domain === 'string'
    );
  } catch {
    return false;
  }
}

function isEncryptedVaultPayload(raw) {
  return /^[a-f0-9]{24}:[a-f0-9]{32}:[a-f0-9]+$/i.test(raw);
}

/**
 * Loads cookies with AES-256-GCM decryption, verifying expiration (30-day vault retention; portal expiry still applies).
 * Stale or expired cookies are purged immediately.
 */
export function loadEncryptedCookies(filePath, { maxAgeMs = DEFAULT_MAX_COOKIE_AGE_MS } = {}) {
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
            const stat = fs.statSync(cand);
            const raw = fs.readFileSync(cand, 'utf8').trim();
            if (!isEncryptedVaultPayload(raw)) {
              if (isPlaintextCookieSnapshot(raw)) {
                try { fs.unlinkSync(cand); } catch {}
              }
              continue;
            }
            let fallbackData = null;
            try {
              const dec = decryptVaultData(raw);
              if (dec) fallbackData = JSON.parse(dec);
            } catch {}
            const validCookies = extractValidCookies(fallbackData, stat?.mtimeMs || Date.now(), maxAgeMs);
            if (!validCookies) continue;
            try { saveEncryptedCookies(filePath, validCookies); } catch {}
            return validCookies;
          } catch {}
        }
      }
      return null;
    }
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    let parsed = null;
    // Check if AES-256-GCM serialized format: ivHex:authTagHex:ciphertextHex
    if (isEncryptedVaultPayload(raw)) {
      try {
        const decrypted = decryptVaultData(raw);
        if (decrypted) parsed = JSON.parse(decrypted);
      } catch {}
    }
    if (!parsed) {
      // Refuse unencrypted cookie JSON. The Chromium profile is the persistent
      // session source of truth; a plaintext snapshot must not be replayed.
      deleteEncryptedCookies(filePath);
      return null;
    }
    const validCookies = extractValidCookies(parsed, stat?.mtimeMs || Date.now(), maxAgeMs);
    if (!validCookies) {
      // Stale or expired: delete cookie file so it does not persist
      deleteEncryptedCookies(filePath);
      return null;
    }
    return validCookies;
  } catch {
    return null;
  }
}

/**
 * Decrypts marketplace account credentials encrypted with AES-256-GCM (format: ivHex:authTagHex:ciphertextHex).
 */
export function decryptMarketplaceCredential(payload) {
  if (!payload || typeof payload !== 'string' || !payload.includes(':')) return null;
  const parts = payload.split(':');
  if (parts.length !== 3) return null;
  const [ivHex, tagHex, dataHex] = parts;
  try {
    const secret = process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'reconcentral-credentials-master-aes256-encryption-key-secret';
    const key = crypto.createHash('sha256').update(secret).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(dataHex, 'hex', 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}
