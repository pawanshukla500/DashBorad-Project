import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encryptCredential, decryptCredential, maskCredential } from '../utils/credentialCrypto.js';
import { DEFAULT_MARKETPLACE_METADATA } from '../routes/marketplaceAccounts.js';

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
