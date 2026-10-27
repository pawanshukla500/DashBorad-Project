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
 * Decrypts a serialized payload formatted as `ivHex:authTagHex:ciphertextHex`.
 * Throws on configuration error in production if master key is missing.
 * Supports legacy key fallback so existing credentials survive environment key configuration.
 * 
 * @param {string} encryptedPayload - Serialized encrypted payload
 * @returns {string|null} Decrypted plaintext string or null if invalid/corrupt
 */
export function decryptCredential(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    return null;
  }
  
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    return null;
  }
  
  const [ivHex, authTagHex, ciphertextHex] = parts;
  if (!ivHex || !authTagHex || !ciphertextHex) {
    return null;
  }
  
  // 1. Resolve master key (throws directly if missing in production, preventing masked configuration errors)
  const primaryKey = getMasterKey();
  
  // 2. Attempt decryption using primary environment-derived key
  const decrypted = attemptAesGcmDecrypt(primaryKey, ivHex, authTagHex, ciphertextHex);
  if (decrypted !== null) {
    return decrypted;
  }
  
  // 3. Fallback decryption for legacy credentials encrypted prior to environment key rotation
  const legacyKey = crypto.createHash('sha256').update(LEGACY_FALLBACK_SECRET).digest();
  if (!primaryKey.equals(legacyKey)) {
    const legacyDecrypted = attemptAesGcmDecrypt(legacyKey, ivHex, authTagHex, ciphertextHex);
    if (legacyDecrypted !== null) {
      return legacyDecrypted;
    }
  }
  
  return null;
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
