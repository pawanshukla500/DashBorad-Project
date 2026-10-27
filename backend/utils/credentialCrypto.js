import crypto from 'crypto';

/**
 * ReconCentral Marketplace Credential Encryption Utility (AES-256-GCM)
 * 
 * Provides authenticated encryption for marketplace credentials (passwords, tokens, API secrets)
 * stored in PostgreSQL. Uses AES-256-GCM with a unique 12-byte initialization vector (IV)
 * per encryption and a 16-byte authentication tag to guarantee confidentiality and integrity.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits authentication tag

/**
 * Derives a deterministic 32-byte (256-bit) buffer key from the environment secret.
 * In production, strictly requires CREDENTIALS_ENCRYPTION_KEY, ENCRYPTION_KEY, or JWT_SECRET.
 */
export function getMasterKey() {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY 
    || process.env.ENCRYPTION_KEY 
    || process.env.JWT_SECRET;
  
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Production security violation: CREDENTIALS_ENCRYPTION_KEY, ENCRYPTION_KEY, or JWT_SECRET must be set for credential encryption.');
    }
    return crypto.createHash('sha256').update('reconcentral-credentials-master-aes256-encryption-key-secret').digest();
  }
  
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a plaintext string into a serialized string format: `ivHex:authTagHex:ciphertextHex`
 * 
 * @param {string} plaintext - Plaintext secret
 * @returns {string} Serialized encrypted payload
 */
export function encryptCredential(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    return null;
  }
  
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext}`;
}

/**
 * Resolves previous encryption keys configured in the environment keyring (e.g. during secret rotation).
 * Also supports legacy transition fallback when explicitly allowed or during non-production testing.
 * 
 * @returns {Buffer[]} Array of 32-byte key buffers
 */
export function getPreviousKeys() {
  const previousRaw = process.env.CREDENTIALS_PREVIOUS_KEYS 
    || process.env.PREVIOUS_ENCRYPTION_KEYS 
    || '';
  
  const keys = previousRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => crypto.createHash('sha256').update(s).digest());

  // Allow legacy key transition if explicitly enabled or in development/test
  if (process.env.ALLOW_LEGACY_CRYPTO_FALLBACK === 'true' || process.env.NODE_ENV !== 'production') {
    keys.push(crypto.createHash('sha256').update(LEGACY_FALLBACK_SECRET).digest());
  }

  return keys;
}

const LEGACY_FALLBACK_SECRET = 'reconcentral-credentials-master-aes256-encryption-key-secret';

/**
 * Attempts single AES-256-GCM payload decryption using the provided key buffer.
 * Returns decrypted utf8 string or null if deciphering/auth tag validation fails.
 */
function attemptAesGcmDecrypt(key, ivHex, authTagHex, ciphertextHex) {
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

/**
 * Decrypts a serialized payload formatted as `ivHex:authTagHex:ciphertextHex` and reports whether
 * the credential was decrypted using the active primary key or a keyring previous/legacy key.
 * 
 * @param {string} encryptedPayload - Serialized encrypted payload
 * @returns {{ plaintext: string|null, isCurrentKey: boolean }}
 */
export function decryptCredentialWithKeyInfo(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    return { plaintext: null, isCurrentKey: false };
  }
  
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    return { plaintext: null, isCurrentKey: false };
  }
  
  const [ivHex, authTagHex, ciphertextHex] = parts;
  if (!ivHex || !authTagHex || !ciphertextHex) {
    return { plaintext: null, isCurrentKey: false };
  }
  
  // 1. Resolve master key (throws directly if missing in production, preventing masked configuration errors)
  const primaryKey = getMasterKey();
  
  // 2. Attempt decryption using primary active key
  const decrypted = attemptAesGcmDecrypt(primaryKey, ivHex, authTagHex, ciphertextHex);
  if (decrypted !== null) {
    return { plaintext: decrypted, isCurrentKey: true };
  }
  
  // 3. Fallback to previous keys in keyring (or legacy fallback during migration)
  const previousKeys = getPreviousKeys();
  for (const prevKey of previousKeys) {
    if (primaryKey.equals(prevKey)) continue;
    const prevDecrypted = attemptAesGcmDecrypt(prevKey, ivHex, authTagHex, ciphertextHex);
    if (prevDecrypted !== null) {
      return { plaintext: prevDecrypted, isCurrentKey: false };
    }
  }
  
  return { plaintext: null, isCurrentKey: false };
}

/**
 * Decrypts a serialized payload formatted as `ivHex:authTagHex:ciphertextHex`.
 * Supports keyring rotation from previous environment keys as well as legacy transition fallback.
 * 
 * @param {string} encryptedPayload - Serialized encrypted payload
 * @returns {string|null} Decrypted plaintext string or null if invalid/corrupt
 */
export function decryptCredential(encryptedPayload) {
  const { plaintext } = decryptCredentialWithKeyInfo(encryptedPayload);
  return plaintext;
}

/**
 * Re-encrypts all stored marketplace account credentials using the active primary key.
 * Migrates records previously encrypted under an earlier environment key in the keyring or legacy key.
 * 
 * @param {import('pg').Pool|object} db - PostgreSQL pool or client
 * @returns {Promise<{ reencrypted: number, total: number }>}
 */
export async function reencryptMarketplaceCredentials(db) {
  if (!db || typeof db.query !== 'function') {
    return { reencrypted: 0, total: 0 };
  }

  const { rows } = await db.query(
    `SELECT id, password_encrypted FROM marketplace_accounts WHERE password_encrypted IS NOT NULL`
  );

  let reencrypted = 0;
  for (const row of rows) {
    const { plaintext, isCurrentKey } = decryptCredentialWithKeyInfo(row.password_encrypted);
    if (plaintext && !isCurrentKey) {
      const updatedCiphertext = encryptCredential(plaintext);
      // Concurrency guard: update only if stored ciphertext has not been concurrently changed
      const updateResult = await db.query(
        `UPDATE marketplace_accounts SET password_encrypted = $1, updated_at = NOW() WHERE id = $2 AND password_encrypted = $3`,
        [updatedCiphertext, row.id, row.password_encrypted]
      );
      if (updateResult && (updateResult.rowCount > 0 || updateResult.affectedRows > 0)) {
        reencrypted++;
      }
    }
  }

  return { reencrypted, total: rows.length };
}

/**
 * Returns a masked representation of the credential for UI listings.
 * 
 * @param {string} encryptedPayload - Serialized encrypted payload
 * @returns {string} Masked string (e.g. '••••••••') or empty string
 */
export function maskCredential(encryptedPayload) {
  return encryptedPayload ? '••••••••' : '';
}
