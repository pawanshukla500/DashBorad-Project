import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptCredential } from '../utils/credentialCrypto.js';

let mockAccounts = [];
let currentUserRole = 'admin';

vi.mock('../db/index.js', () => ({
  isDbConfigured: async () => true,
  getPool: () => ({
    query: vi.fn(async (sql, params) => {
      if (/WHERE id = \$1/i.test(sql)) {
        const found = mockAccounts.filter(a => a.id === Number(params[0]) || a.id === params[0]);
        return { rows: found };
      }
      if (/SELECT[\s\S]*FROM marketplace_accounts/i.test(sql)) {
        return { rows: mockAccounts };
      }
      if (/INSERT INTO marketplace_accounts/i.test(sql)) {
        const newAcc = {
          id: mockAccounts.length + 1,
          marketplace: params[0],
          account_id: params[1],
          display_name: params[2],
          seller_id: params[3],
          login_id: params[4],
          password_encrypted: params[5],
          portal_url: params[6],
          logo_url: params[7],
          auth_type: params[8],
          metadata: JSON.parse(params[9] || '{}'),
          is_active: params[10],
          updated_by: params[11],
          updated_at: new Date().toISOString(),
        };
        const existingIdx = mockAccounts.findIndex(a => a.marketplace === newAcc.marketplace && a.account_id === newAcc.account_id);
        if (existingIdx >= 0) {
          mockAccounts[existingIdx] = { ...mockAccounts[existingIdx], ...newAcc, id: mockAccounts[existingIdx].id };
          return { rows: [mockAccounts[existingIdx]] };
        }
        mockAccounts.push(newAcc);
        return { rows: [newAcc] };
      }
      if (/UPDATE marketplace_accounts SET is_active = false/i.test(sql)) {
        const acc = mockAccounts.find(a => a.id === Number(params[1]));
        if (acc) acc.is_active = false;
        return { rowCount: 1 };
      }
      return { rows: [] };
    }),
  }),
}));

vi.mock('../utils/authMiddleware.js', () => ({
  requireRole: (...allowedRoles) => (req, res, next) => {
    if (allowedRoles.includes(currentUserRole)) {
      req.user = { role: currentUserRole, username: 'tester', email: 'test@example.com' };
      return next();
    }
    return res.status(403).json({ error: `Access denied. Required role: ${allowedRoles.join(' or ')}` });
  },
  requireAdmin: (req, res, next) => {
    if (currentUserRole === 'admin') {
      req.user = { role: 'admin', username: 'admin', email: 'admin@example.com' };
      return next();
    }
    return res.status(403).json({ error: 'Access denied. Required role: admin' });
  },
}));

const { default: marketplaceAccountsRouter } = await import('../routes/marketplaceAccounts.js');

let server;
let baseUrl;

beforeEach(async () => {
  currentUserRole = 'admin';
  mockAccounts = [
    {
      id: 1,
      marketplace: 'flipkart',
      account_id: 'default',
      display_name: 'Flipkart',
      seller_id: null,
      login_id: 'flipkart_user',
      password_encrypted: encryptCredential('fkSecret123'),
      portal_url: 'https://seller.flipkart.com/',
      logo_url: 'https://cdn.brandfetch.io/idWdImNSUt/w/128/h/128/fallback/lettermark/icon.webp',
      auth_type: 'password',
      metadata: {},
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      updated_by: 'admin',
    },
    {
      id: 2,
      marketplace: 'myntra',
      account_id: 'myntra_vb',
      display_name: 'Myntra (VB)',
      seller_id: '10708',
      login_id: 'myntra_vb_user',
      password_encrypted: encryptCredential('vbPass456'),
      portal_url: 'https://partners.myntra.com/',
      logo_url: 'https://cdn.brandfetch.io/idDW82Qwj2/w/128/h/128/fallback/lettermark/icon.webp',
      auth_type: 'password',
      metadata: {},
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      updated_by: 'admin',
    },
    {
      id: 3,
      marketplace: 'myntra',
      account_id: 'myntra_ej',
      display_name: 'Myntra (EJ)',
      seller_id: '45833',
      login_id: 'myntra_ej_user',
      password_encrypted: encryptCredential('ejPass789'),
      portal_url: 'https://partners.myntra.com/',
      logo_url: 'https://cdn.brandfetch.io/idDW82Qwj2/w/128/h/128/fallback/lettermark/icon.webp',
      auth_type: 'password',
      metadata: {},
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      updated_by: 'admin',
    },
  ];

  const app = express();
  app.use(express.json());
  app.use('/api/marketplace-accounts', marketplaceAccountsRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/marketplace-accounts`;
});

afterEach(() => new Promise(resolve => server.close(resolve)));

describe('Marketplace Accounts REST API Endpoints', () => {
  it('GET /api/marketplace-accounts returns list with masked passwords and logos', async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accounts).toHaveLength(3);

    const fk = data.accounts.find(a => a.marketplace === 'flipkart');
    expect(fk.has_password).toBe(true);
    expect(fk.password_masked).toBe('••••••••');
    // Ensure plaintext password is NOT in response
    expect(fk.password).toBeUndefined();
    expect(fk.password_encrypted).toBeUndefined();
    expect(fk.logo_url).toContain('cdn.brandfetch.io');
  });

  it('GET /api/marketplace-accounts/:id/reveal reveals decrypted password to authorized operator', async () => {
    currentUserRole = 'operator';
    const res = await fetch(`${baseUrl}/2/reveal`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(2);
    expect(data.account_id).toBe('myntra_vb');
    expect(data.password).toBe('vbPass456');
  });

  it('GET /api/marketplace-accounts/:id/reveal refuses viewers without permission', async () => {
    currentUserRole = 'viewer';
    const res = await fetch(`${baseUrl}/2/reveal`);
    expect(res.status).toBe(403);
  });

  it('POST /api/marketplace-accounts enforces Myntra dual-account seller IDs (VB 10708, EJ 45833)', async () => {
    currentUserRole = 'admin';
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketplace: 'myntra',
        account_id: 'myntra_vb',
        display_name: 'Myntra (VB)',
        login_id: 'new_vb_login',
        password: 'newSecretPassword!',
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.account.seller_id).toBe('10708');

    // Reveal to ensure password was encrypted and decrypts properly
    const revealRes = await fetch(`${baseUrl}/2/reveal`);
    const revealData = await revealRes.json();
    expect(revealData.password).toBe('newSecretPassword!');
  });
});
