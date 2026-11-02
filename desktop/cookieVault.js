import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import properLockfile from 'proper-lockfile';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits authentication tag
const COOKIE_SNAPSHOT_LOCK_OPTIONS = { realpath: false, stale: 5000, update: 2500 };
const COOKIE_SNAPSHOT_LOCK_WAIT_MS = 6500;
const activeAsyncCookieSnapshotLocks = new Map();
const asyncCookieSnapshotQueues = new Map();

function cookieVaultBusyError(filePath) {
  const error = new Error(`A cookie snapshot operation is already in progress for ${path.basename(filePath)}.`);
  error.code = 'COOKIE_VAULT_BUSY';
  return error;
}

function getCookieVaultGroup(filePath) {
  const filename = path.basename(path.resolve(filePath)).toLowerCase();
  if (['cookies.json', 'cookies_flipkart.json', 'cookies_shopsy.json', 'cookies_flipkart_shopsy.json'].includes(filename)) {
    return 'flipkart_shopsy';
  }
  const match = /^cookies_([a-z0-9_-]+)\.json$/.exec(filename);
  return (match?.[1] || filename.replace(/\.[^.]+$/, '') || 'default').replace(/[^a-z0-9_-]/g, '_');
}

function getCookieVaultStatePaths(filePath) {
  const resolvedPath = path.resolve(filePath);
  const userDataDir = path.resolve(getResolvedUserDataDir());
  const isInUserData = resolvedPath === userDataDir || resolvedPath.startsWith(`${userDataDir}${path.sep}`);
  const stateDir = isInUserData ? userDataDir : path.dirname(resolvedPath);
  const group = getCookieVaultGroup(resolvedPath);
  return {
    stateDir,
    group,
    lockPath: path.join(stateDir, `.cookie-vault-${group}`),
    generationPath: path.join(stateDir, `.cookie-vault-${group}.generation.json`)
  };
}

export function getCookieVaultLockPath(filePath) {
  return getCookieVaultStatePaths(filePath).lockPath;
}

function withCookieSnapshotLock(filePath, action) {
  const { stateDir, lockPath } = getCookieVaultStatePaths(filePath);
  if (activeAsyncCookieSnapshotLocks.has(path.resolve(lockPath))) {
    throw cookieVaultBusyError(filePath);
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const deadline = Date.now() + COOKIE_SNAPSHOT_LOCK_WAIT_MS;
  let release;

  while (!release) {
    try {
      release = properLockfile.lockSync(lockPath, COOKIE_SNAPSHOT_LOCK_OPTIONS);
    } catch (error) {
      if (error?.code !== 'ELOCKED') throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the cookie snapshot lock: ${path.basename(filePath)}`);
      Atomics.wait(waitCell, 0, 0, 25);
    }
  }

  try {
    return action();
  } finally {
    release();
  }
}

async function withCookieSnapshotLockAsync(filePath, action) {
  const { stateDir, lockPath } = getCookieVaultStatePaths(filePath);
  const resolvedLockPath = path.resolve(lockPath);
  // Synchronous vault operations must fail fast while this async lock is held.
  // Their Atomics.wait retry loop would otherwise block this event loop and
  // prevent the async owner from completing and releasing the lock.
  activeAsyncCookieSnapshotLocks.set(resolvedLockPath, (activeAsyncCookieSnapshotLocks.get(resolvedLockPath) || 0) + 1);
  const previous = asyncCookieSnapshotQueues.get(resolvedLockPath) || Promise.resolve();
  let releaseQueue;
  const queued = new Promise(resolve => { releaseQueue = resolve; });
  asyncCookieSnapshotQueues.set(resolvedLockPath, queued);
  const deadline = Date.now() + COOKIE_SNAPSHOT_LOCK_WAIT_MS;
  let release;

  try {
    await previous;
    fs.mkdirSync(stateDir, { recursive: true });
    while (!release) {
      try {
        release = await properLockfile.lock(lockPath, COOKIE_SNAPSHOT_LOCK_OPTIONS);
      } catch (error) {
        if (error?.code !== 'ELOCKED') throw error;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for the cookie snapshot lock: ${path.basename(filePath)}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }

    return await action();
  } finally {
    try {
      if (release) await release();
    } finally {
      releaseQueue();
      if (asyncCookieSnapshotQueues.get(resolvedLockPath) === queued) {
        asyncCookieSnapshotQueues.delete(resolvedLockPath);
      }
      const remaining = (activeAsyncCookieSnapshotLocks.get(resolvedLockPath) || 1) - 1;
      if (remaining > 0) activeAsyncCookieSnapshotLocks.set(resolvedLockPath, remaining);
      else activeAsyncCookieSnapshotLocks.delete(resolvedLockPath);
    }
  }
}

function readCookieVaultGeneration(filePath) {
  const { generationPath } = getCookieVaultStatePaths(filePath);
  try {
    const state = JSON.parse(fs.readFileSync(generationPath, 'utf8'));
    if (!Number.isSafeInteger(state?.generation) || state.generation < 0) {
      throw new Error('Cookie vault generation state is invalid.');
    }
    return state.generation;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function writeCookieVaultGeneration(filePath, generation) {
  const { stateDir, generationPath } = getCookieVaultStatePaths(filePath);
  fs.mkdirSync(stateDir, { recursive: true });
  const temporaryPath = path.join(stateDir, `.${path.basename(generationPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify({ generation, updated_at: Date.now() }), {
      encoding: 'utf8', mode: 0o600, flag: 'wx'
    });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, generationPath);
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {}
  }
}

/** Capture the session generation before opening a browser or beginning login. */
export function getCookieVaultGeneration(filePath) {
  return withCookieSnapshotLock(filePath, () => readCookieVaultGeneration(filePath));
}

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

function readPersistedVaultKey(keyFilePath, attempts = 100, retryDelayMs = 10) {
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const storedKey = fs.readFileSync(keyFilePath, 'utf8').trim();
      if (/^[a-f0-9]{64}$/i.test(storedKey)) return crypto.createHash('sha256').update(storedKey).digest();
    } catch (error) {
      if (!['ENOENT', 'EBUSY'].includes(error?.code)) throw error;
    }
    if (attempt + 1 < attempts) Atomics.wait(waitCell, 0, 0, retryDelayMs);
  }
  return null;
}

/**
 * Gets or provisions a secure per-installation 256-bit encryption key.
 * A local vault must not depend on backend environment secrets: the Electron app
 * and standalone worker can share this user-data directory while loading different
 * environments. A machine-local, cryptographically random key is stored in
 * `<USER_DATA_DIR>/.vault_key` with strict permissions (0o600).
 */
export function getVaultMasterKey() {
  const userDir = getResolvedUserDataDir();
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  const keyFilePath = path.join(userDir, '.vault_key');
  if (fs.existsSync(keyFilePath)) {
    const persistedKey = readPersistedVaultKey(keyFilePath);
    if (persistedKey) return persistedKey;
    throw new Error(`Vault key remained incomplete after waiting for concurrent initialization: ${keyFilePath}`);
  }

  // Generate a fresh cryptographically random 256-bit key using exclusive atomic creation ('wx')
  const randomSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyFilePath, randomSecret, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return crypto.createHash('sha256').update(randomSecret).digest();
  } catch (err) {
    if (err.code === 'EEXIST') {
      const persistedKey = readPersistedVaultKey(keyFilePath);
      if (persistedKey) return persistedKey;
      throw new Error(`Vault key remained incomplete after concurrent initialization: ${keyFilePath}`);
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

function decryptVaultPayloadWithKey(encryptedPayload, key) {
  const [ivHex, authTagHex, ciphertextHex] = encryptedPayload.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertextHex, 'hex', 'utf8') + decipher.final('utf8');
}

function legacyVaultKeys() {
  const secrets = [process.env.CREDENTIALS_ENCRYPTION_KEY, process.env.ENCRYPTION_KEY, process.env.JWT_SECRET]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return [...new Set(secrets)].map(secret => crypto.createHash('sha256').update(secret).digest());
}

/**
 * Decrypts AES-256-GCM data. Legacy environment-derived keys are read-only
 * fallbacks so old snapshots remain readable; all new writes use the local key.
 */
export function decryptVaultData(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') return null;
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) return null;
  try {
    return decryptVaultPayloadWithKey(encryptedPayload, getVaultMasterKey());
  } catch (primaryError) {
    for (const key of legacyVaultKeys()) {
      try {
        const plaintext = decryptVaultPayloadWithKey(encryptedPayload, key);
        return plaintext;
      } catch {}
    }
    throw primaryError;
  }
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
function deleteEncryptedCookiesUnlocked(filePath) {
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
export function clearEncryptedCookieSnapshots(filePaths, { fsModule = fs, remove = deleteEncryptedCookiesUnlocked, clearProfile } = {}) {
  const targets = [...new Set((Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean).map(file => path.resolve(file)))];
  if (targets.length === 0) throw new Error('At least one cookie snapshot path is required.');
  const { lockPath } = getCookieVaultStatePaths(targets[0]);
  if (targets.some(target => getCookieVaultStatePaths(target).lockPath !== lockPath)) {
    throw new Error('Cookie snapshots from different marketplace sessions cannot be cleared together.');
  }

  return withCookieSnapshotLock(targets[0], () => {
    writeCookieVaultGeneration(targets[0], readCookieVaultGeneration(targets[0]) + 1);
    for (const target of targets) {
      const exists = () => {
        try {
          fsModule.lstatSync(target);
          return true;
        } catch (error) {
          if (error?.code === 'ENOENT') return false;
          throw error;
        }
      };
      if (exists()) remove(target);
      if (exists()) throw new Error(`Could not remove the saved cookie snapshot ${path.basename(target)}.`);
    }
    if (typeof clearProfile === 'function') clearProfile();
    return true;
  });
}

export async function clearEncryptedCookieSnapshotsAsync(filePaths, { clearProfile } = {}) {
  const targets = [...new Set((Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean).map(file => path.resolve(file)))];
  if (targets.length === 0) throw new Error('At least one cookie snapshot path is required.');
  const { lockPath } = getCookieVaultStatePaths(targets[0]);
  if (targets.some(target => getCookieVaultStatePaths(target).lockPath !== lockPath)) {
    throw new Error('Cookie snapshots from different marketplace sessions cannot be cleared together.');
  }

  return withCookieSnapshotLockAsync(targets[0], async () => {
    writeCookieVaultGeneration(targets[0], readCookieVaultGeneration(targets[0]) + 1);
    for (const target of targets) {
      try {
        await fs.promises.unlink(target);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      try {
        await fs.promises.lstat(target);
        throw new Error(`Could not remove the saved cookie snapshot ${path.basename(target)}.`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (typeof clearProfile === 'function') await clearProfile();
    return true;
  });
}

export function clearEncryptedCookieSnapshot(filePath, options = {}) {
  if (!filePath) throw new Error('Cookie snapshot path is required.');
  return clearEncryptedCookieSnapshots([filePath], options);
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

export function deleteEncryptedCookies(filePath, { expectedGeneration } = {}) {
  if (!filePath) return false;
  try {
    return withCookieSnapshotLock(filePath, () => {
      if (expectedGeneration !== undefined && readCookieVaultGeneration(filePath) !== expectedGeneration) return false;
      return deleteEncryptedCookiesUnlocked(filePath);
    });
  } catch {
    return false;
  }
}

function normalizeCookieForImport(cookie) {
  if (!cookie || typeof cookie.name !== 'string' || !cookie.name.trim() || typeof cookie.value !== 'string') return null;

  const domain = typeof cookie?.domain === 'string' ? cookie.domain.trim().replace(/^\./, '') : '';
  const validDomain = domain && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(domain);
  const urlValue = typeof cookie?.url === 'string' ? cookie.url.trim() : '';
  let validUrl = '';
  try {
    const url = new URL(urlValue);
    if (['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password) validUrl = urlValue;
  } catch {}

  if (!validDomain && !validUrl) return null;
  const normalized = { ...cookie };
  if (validDomain) normalized.domain = cookie.domain.trim();
  else delete normalized.domain;
  if (validUrl) normalized.url = validUrl;
  else delete normalized.url;
  if (typeof normalized.path === 'string' && !normalized.path.startsWith('/')) normalized.path = '/';
  return normalized;
}

function extractValidCookies(parsed, statMtimeMs, maxAgeMs, onInvalidRecords = () => {}) {
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
  const unexpired = cookies.filter(c => c && (!c.expires || c.expires <= 0 || c.expires > Date.now() / 1000));
  const normalized = unexpired.map(normalizeCookieForImport);
  const valid = normalized.filter(Boolean);
  const discardedRecords = normalized.length - valid.length;
  if (discardedRecords > 0) {
    try { onInvalidRecords(discardedRecords); } catch {}
  }
  return valid.length ? valid : null;
}

/**
 * Saves cookies encrypted with AES-256-GCM along with save timestamp.
 */
export function saveEncryptedCookies(filePath, cookies, { expectedGeneration } = {}) {
  return withCookieSnapshotLock(filePath, () => {
    const generation = readCookieVaultGeneration(filePath);
    if (expectedGeneration !== undefined && expectedGeneration !== generation) {
      const error = new Error('Seller Hub session changed while this browser was active. Reopen Seller Hub after resetting the session.');
      error.code = 'COOKIE_VAULT_GENERATION_CHANGED';
      throw error;
    }
    writeEncryptedCookiePayload(filePath, {
      saved_at: Date.now(),
      cookie_vault_generation: generation,
      cookies: Array.isArray(cookies) ? cookies : []
    });
    return true;
  });
}

function writeEncryptedCookiePayload(filePath, payload) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const serialized = JSON.stringify(payload, null, 2);
  const encrypted = encryptVaultData(serialized);
  const temporaryPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, encrypted, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {}
  }
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

function legacyCookieCandidates(filePath) {
  return [...new Set([
    path.join(path.dirname(filePath), 'cookies.json'),
    path.join(path.dirname(filePath), '..', 'cookies.json'),
    path.join(process.cwd(), '.runtime', path.basename(filePath)),
    path.join(process.cwd(), '.runtime', 'cookies.json'),
    path.join(__dirname, '..', '.runtime', 'cookies.json'),
    path.join(__dirname, '.runtime', 'cookies.json')
  ].map(candidate => path.resolve(candidate)))];
}

function removePlaintextCookieFallbacks(filePath, candidates) {
  const target = path.resolve(filePath);
  for (const candidate of candidates) {
    if (candidate === target || !fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, 'utf8').trim();
      if (!isEncryptedVaultPayload(raw) && isPlaintextCookieSnapshot(raw)) fs.unlinkSync(candidate);
    } catch {}
  }
}

/**
 * Loads cookies with AES-256-GCM decryption, verifying expiration (30-day vault retention; portal expiry still applies).
 * Stale or expired cookies are purged immediately.
 */
export function loadEncryptedCookies(filePath, {
  maxAgeMs = DEFAULT_MAX_COOKIE_AGE_MS,
  onInvalidRecords = () => {}
} = {}) {
  try {
    return withCookieSnapshotLock(filePath, () => loadEncryptedCookiesUnlocked(filePath, {
      maxAgeMs,
      onInvalidRecords,
      generation: readCookieVaultGeneration(filePath)
    }));
  } catch (error) {
    if (error?.code === 'COOKIE_VAULT_BUSY') throw error;
    return null;
  }
}

function loadEncryptedCookiesUnlocked(filePath, {
  maxAgeMs = DEFAULT_MAX_COOKIE_AGE_MS,
  onInvalidRecords = () => {},
  generation = readCookieVaultGeneration(filePath)
} = {}) {
  try {
    const candidates = legacyCookieCandidates(filePath);
    // Purge plaintext legacy files even if the requested encrypted target
    // exists; a valid target must not leave an unused plaintext copy behind.
    removePlaintextCookieFallbacks(filePath, candidates);
    if (!fs.existsSync(filePath)) {
      for (const cand of candidates) {
        if (cand !== path.resolve(filePath) && fs.existsSync(cand)) {
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
            if (!fallbackData || !isCookieVaultGenerationCurrent(fallbackData, generation)) continue;
            const validCookies = extractValidCookies(fallbackData, stat?.mtimeMs || Date.now(), maxAgeMs, onInvalidRecords);
            if (!validCookies) continue;
            // Reads never rewrite a cookie file: another process may have
            // saved a newer login while this legacy snapshot was being read.
            if (fs.existsSync(filePath)) {
              return loadEncryptedCookiesUnlocked(filePath, { maxAgeMs, onInvalidRecords, generation });
            }
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
      deleteEncryptedCookiesUnlocked(filePath);
      return null;
    }
    if (!isCookieVaultGenerationCurrent(parsed, generation)) {
      deleteEncryptedCookiesUnlocked(filePath);
      return null;
    }
    const validCookies = extractValidCookies(parsed, stat?.mtimeMs || Date.now(), maxAgeMs, onInvalidRecords);
    if (!validCookies) {
      // Stale or expired: delete cookie file so it does not persist
      deleteEncryptedCookiesUnlocked(filePath);
      return null;
    }
    return validCookies;
  } catch {
    return null;
  }
}

function isCookieVaultGenerationCurrent(payload, generation) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return generation === 0;
  const savedGeneration = payload.cookie_vault_generation;
  if (savedGeneration === undefined) return generation === 0;
  return Number.isSafeInteger(savedGeneration) && savedGeneration === generation;
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
