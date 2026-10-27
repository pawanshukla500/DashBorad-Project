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
 */
function getMasterKey() {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY 
    || process.env.ENCRYPTION_KEY 
    || process.env.JWT_SECRET 
    || 'reconcentral-credentials-master-aes256-encryption-key-secret';
  
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
 * Decrypts a serialized payload formatted as `ivHex:authTagHex:ciphertextHex`.
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
  
  try {
    const key = getMasterKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // Decryption or authentication failed (e.g., ciphertext tampered with, wrong key)
    return null;
  }
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
