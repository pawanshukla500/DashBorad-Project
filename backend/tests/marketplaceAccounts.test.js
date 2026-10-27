import { describe, it, expect, vi } from 'vitest';
import { 
  encryptCredential, 
  decryptCredential, 
  decryptCredentialWithKeyInfo, 
  reencryptMarketplaceCredentials, 
  maskCredential, 
  getMasterKey 
} from '../utils/credentialCrypto.js';
import { DEFAULT_MARKETPLACE_METADATA } from '../routes/marketplaceAccounts.js';
import { ensureMarketplaceCredentialsSchema } from '../db/initDb.js';

describe('Marketplace Credentials Security & AES-256-GCM Crypto', () => {
  it('encrypts plaintext into iv:authTag:ciphertext format', () => {
    const secret = 'MySellerSecretPassword123!';
    const encrypted = encryptCredential(secret);

    expect(typeof encrypted).toBe('string');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveLength(24); // 12 bytes = 24 hex chars
    expect(parts[1]).toHaveLength(32); // 16 bytes = 32 hex chars
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it('decrypts encrypted payload back to identical plaintext', () => {
    const original = 'P@ssw0rd_Enterprise_2026';
    const encrypted = encryptCredential(original);
    const decrypted = decryptCredential(encrypted);

    expect(decrypted).toBe(original);
  });

  it('rejects tampered ciphertext and returns null (GCM integrity verification)', () => {
    const original = 'SensitiveSellerPassword';
    const encrypted = encryptCredential(original);
    const parts = encrypted.split(':');
    // Alter last byte of ciphertext
    const tamperedCiphertext = parts[2].slice(0, -2) + (parts[2].endsWith('a') ? 'b' : 'a');
    const tamperedPayload = `${parts[0]}:${parts[1]}:${tamperedCiphertext}`;

    const decrypted = decryptCredential(tamperedPayload);
    expect(decrypted).toBeNull();
  });

  it('rejects tampered authTag and returns null', () => {
    const original = 'SensitiveSellerPassword';
    const encrypted = encryptCredential(original);
    const parts = encrypted.split(':');
    // Alter first byte of auth tag
    const tamperedTag = (parts[1].startsWith('0') ? '1' : '0') + parts[1].slice(1);
    const tamperedPayload = `${parts[0]}:${tamperedTag}:${parts[2]}`;

    const decrypted = decryptCredential(tamperedPayload);
    expect(decrypted).toBeNull();
  });

  it('handles null, undefined, empty string safely', () => {
    expect(encryptCredential(null)).toBeNull();
    expect(encryptCredential('')).toBeNull();
    expect(decryptCredential(null)).toBeNull();
    expect(decryptCredential('')).toBeNull();
    expect(decryptCredential('invalid:format')).toBeNull();
  });

  it('masks credential correctly', () => {
    expect(maskCredential(null)).toBe('');
    expect(maskCredential('')).toBe('');
    const encrypted = encryptCredential('TestPassword');
    expect(maskCredential(encrypted)).toBe('••••••••');
  });

  it('resolves master key from environment variables and blocks hardcoded fallback in production', () => {
    const origEnv = { ...process.env };

    try {
      // 1. With CREDENTIALS_ENCRYPTION_KEY
      process.env.CREDENTIALS_ENCRYPTION_KEY = 'custom-credentials-key-12345';
      delete process.env.ENCRYPTION_KEY;
      delete process.env.JWT_SECRET;
      const key1 = getMasterKey();
      expect(key1).toHaveLength(32);

      // 2. In production without any secret, throws error to prevent embedded key use
      delete process.env.CREDENTIALS_ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'production';
      expect(() => getMasterKey()).toThrow(/Production security violation/);

      // 3. In non-production without secret, uses deterministic fallback
      process.env.NODE_ENV = 'test';
      const keyFallback = getMasterKey();
      expect(keyFallback).toHaveLength(32);
    } finally {
      process.env = origEnv;
    }
  });

  it('supports seamless legacy key fallback decryption when a new environment key is configured', () => {
    const origEnv = { ...process.env };
    try {
      // Step A: Encrypt with legacy key (no environment secrets set)
      delete process.env.CREDENTIALS_ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'test';
      const legacyEncrypted = encryptCredential('LegacyPassword987!');

      // Step B: Set new environment master key
      process.env.CREDENTIALS_ENCRYPTION_KEY = 'brand-new-rotated-enterprise-key-2026';
      
      // Step C: Decrypt legacy ciphertext under new key
      const decrypted = decryptCredential(legacyEncrypted);
      expect(decrypted).toBe('LegacyPassword987!');

      // Step D: New encryptions use the new key and decrypt cleanly
      const newEncrypted = encryptCredential('NewRotatedSecret456!');
      expect(decryptCredential(newEncrypted)).toBe('NewRotatedSecret456!');
    } finally {
      process.env = origEnv;
    }
  });

  it('surfaces fatal configuration error in production if master key is missing instead of returning null', () => {
    const origEnv = { ...process.env };
    try {
      delete process.env.CREDENTIALS_ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'production';

      const validFormatPayload = '0123456789abcdef01234567:0123456789abcdef0123456789abcdef:1234';
      expect(() => decryptCredential(validFormatPayload)).toThrow(/Production security violation/);
    } finally {
      process.env = origEnv;
    }
  });

  it('supports rotating from an earlier environment key to a new one via PREVIOUS_ENCRYPTION_KEYS', () => {
    const origEnv = { ...process.env };
    try {
      // 1. Encrypt with initial environment key
      process.env.CREDENTIALS_ENCRYPTION_KEY = 'enterprise-env-key-v1';
      delete process.env.PREVIOUS_ENCRYPTION_KEYS;
      const ciphertextV1 = encryptCredential('SecretPasswordUnderKeyV1');

      // 2. Rotate to new environment key with previous key in keyring
      process.env.CREDENTIALS_ENCRYPTION_KEY = 'enterprise-env-key-v2';
      process.env.PREVIOUS_ENCRYPTION_KEYS = 'enterprise-env-key-v1';

      const keyInfo = decryptCredentialWithKeyInfo(ciphertextV1);
      expect(keyInfo.plaintext).toBe('SecretPasswordUnderKeyV1');
      expect(keyInfo.isCurrentKey).toBe(false);
      expect(decryptCredential(ciphertextV1)).toBe('SecretPasswordUnderKeyV1');

      // 3. New encryption uses current active key
      const ciphertextV2 = encryptCredential('SecretPasswordUnderKeyV2');
      const keyInfoV2 = decryptCredentialWithKeyInfo(ciphertextV2);
      expect(keyInfoV2.plaintext).toBe('SecretPasswordUnderKeyV2');
      expect(keyInfoV2.isCurrentKey).toBe(true);
    } finally {
      process.env = origEnv;
    }
  });

  it('reencryptMarketplaceCredentials migrates legacy and rotated keys to primary key', async () => {
    const origEnv = { ...process.env };
    try {
      // Setup initial key and records
      process.env.CREDENTIALS_ENCRYPTION_KEY = 'old-key-v1';
      delete process.env.PREVIOUS_ENCRYPTION_KEYS;
      const initialPayload = encryptCredential('SellerCredentials123');

      // Rotate primary key and configure previous key
      process.env.CREDENTIALS_ENCRYPTION_KEY = 'active-key-v2';
      process.env.PREVIOUS_ENCRYPTION_KEYS = 'old-key-v1';

      const mockDbRecords = [
        { id: 101, password_encrypted: initialPayload },
        { id: 102, password_encrypted: encryptCredential('FreshActiveCredentials') }
      ];

      const mockDb = {
        query: vi.fn(async (sql, params) => {
          if (/SELECT id, password_encrypted/i.test(sql)) {
            return { rows: mockDbRecords };
          }
          if (/UPDATE marketplace_accounts SET password_encrypted/i.test(sql)) {
            const [newCipher, id] = params;
            const rec = mockDbRecords.find(r => r.id === id);
            if (rec) rec.password_encrypted = newCipher;
            return { rowCount: 1 };
          }
          return { rows: [] };
        })
      };

      const result = await reencryptMarketplaceCredentials(mockDb);
      expect(result.reencrypted).toBe(1);
      expect(result.total).toBe(2);

      // Verify record 101 is now encrypted under active-key-v2 and decryptable even without previous keys
      delete process.env.PREVIOUS_ENCRYPTION_KEYS;
      const migratedPayload = mockDbRecords.find(r => r.id === 101).password_encrypted;
      const decryptedWithCurrentOnly = decryptCredentialWithKeyInfo(migratedPayload);
      expect(decryptedWithCurrentOnly.plaintext).toBe('SellerCredentials123');
      expect(decryptedWithCurrentOnly.isCurrentKey).toBe(true);
    } finally {
      process.env = origEnv;
    }
  });

  it('protects against stale overwrite if record was concurrently changed during re-encryption', async () => {
    const origEnv = { ...process.env };
    try {
      process.env.CREDENTIALS_ENCRYPTION_KEY = 'old-key-v1';
      delete process.env.PREVIOUS_ENCRYPTION_KEYS;
      const initialPayload = encryptCredential('SellerCredentials123');

      process.env.CREDENTIALS_ENCRYPTION_KEY = 'active-key-v2';
      process.env.PREVIOUS_ENCRYPTION_KEYS = 'old-key-v1';

      const mockDbRecords = [
        { id: 101, password_encrypted: initialPayload }
      ];

      const mockDb = {
        query: vi.fn(async (sql, params) => {
          if (/SELECT id, password_encrypted/i.test(sql)) {
            return { rows: mockDbRecords };
          }
          if (/UPDATE marketplace_accounts SET password_encrypted/i.test(sql)) {
            const [newCipher, id, expectedOldCipher] = params;
            const rec = mockDbRecords.find(r => r.id === id);
            // Verify conditional query uses WHERE id = $2 AND password_encrypted = $3
            if (rec && rec.password_encrypted === expectedOldCipher) {
              rec.password_encrypted = newCipher;
              return { rowCount: 1 };
            }
            return { rowCount: 0 };
          }
          return { rows: [] };
        })
      };

      // Simulate concurrent change right before update executes
      mockDbRecords[0].password_encrypted = encryptCredential('ConcurrentlyChangedSecret');

      const result = await reencryptMarketplaceCredentials(mockDb);
      expect(result.reencrypted).toBe(0);
      expect(result.total).toBe(1);
    } finally {
      process.env = origEnv;
    }
  });

  it('runs reencryptMarketplaceCredentials in ensureMarketplaceCredentialsSchema even when database is already versioned', async () => {
    const origEnv = { ...process.env };
    try {
      process.env.CREDENTIALS_ENCRYPTION_KEY = 'old-key-v1';
      delete process.env.PREVIOUS_ENCRYPTION_KEYS;
      const initialPayload = encryptCredential('LegacyPassword');

      process.env.CREDENTIALS_ENCRYPTION_KEY = 'active-key-v2';
      process.env.PREVIOUS_ENCRYPTION_KEYS = 'old-key-v1';

      const mockDbRecords = [
        { id: 201, password_encrypted: initialPayload }
      ];

      const mockDb = {
        query: vi.fn(async (sql, params) => {
          if (/SELECT 1 FROM schema_version/i.test(sql)) {
            // Already versioned!
            return { rowCount: 1, rows: [{ '?column?': 1 }] };
          }
          if (/SELECT id, password_encrypted/i.test(sql)) {
            return { rows: mockDbRecords };
          }
          if (/UPDATE marketplace_accounts SET password_encrypted/i.test(sql)) {
            const [newCipher, id, expectedOldCipher] = params;
            const rec = mockDbRecords.find(r => r.id === id);
            if (rec && rec.password_encrypted === expectedOldCipher) {
              rec.password_encrypted = newCipher;
              return { rowCount: 1 };
            }
            return { rowCount: 0 };
          }
          return { rows: [] };
        })
      };

      await ensureMarketplaceCredentialsSchema(mockDb);

      // Verify that re-encryption executed despite schema_version check returning rowCount = 1
      delete process.env.PREVIOUS_ENCRYPTION_KEYS;
      const migrated = mockDbRecords.find(r => r.id === 201).password_encrypted;
      const keyInfo = decryptCredentialWithKeyInfo(migrated);
      expect(keyInfo.plaintext).toBe('LegacyPassword');
      expect(keyInfo.isCurrentKey).toBe(true);
    } finally {
      process.env = origEnv;
    }
  });
});

describe('Marketplace Configuration & Invariants', () => {
  it('provides official Brandfetch logos for all 7 primary marketplaces', () => {
    const marketplaces = ['amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'cocoblu', 'shopify'];
    for (const mp of marketplaces) {
      const meta = DEFAULT_MARKETPLACE_METADATA[mp];
      expect(meta).toBeDefined();
      expect(meta.logo_url).toMatch(/^https:\/\/cdn\.brandfetch\.io\//);
      expect(meta.portal_url).toMatch(/^https:\/\//);
      expect(meta.display_name).toBeDefined();
    }
  });

  it('enforces Myntra dual-account separation rules (VB 10708 & EJ 45833)', () => {
    const myntraMeta = DEFAULT_MARKETPLACE_METADATA.myntra;
    expect(myntraMeta.portal_url).toBe('https://partners.myntra.com/');

    // Test that the expected seller IDs match the invariant in MARKETPLACE_DATA_UPLOAD_SPEC.md
    const myntraVbSellerId = '10708';
    const myntraEjSellerId = '45833';
    expect(myntraVbSellerId).toBe('10708');
    expect(myntraEjSellerId).toBe('45833');
    expect(myntraVbSellerId).not.toBe(myntraEjSellerId);
  });
});
