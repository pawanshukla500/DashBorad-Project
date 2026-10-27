import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let decodedToken;
let directory;
const setFirebaseRole = vi.fn(async () => {});

vi.mock('../utils/firebaseAdmin.js', () => ({
  auth: { 
    verifyIdToken: vi.fn(async () => decodedToken),
    createCustomToken: vi.fn(async () => 'mock-custom-token')
  },
}));
vi.mock('../services/firebaseRoleClaims.js', () => ({
  FIREBASE_ROLE_CLAIM: 'recon_role',
  setFirebaseRole: (...args) => setFirebaseRole(...args),
}));
vi.mock('../db/index.js', () => ({
  isDbConfigured: async () => true,
  getPool: () => ({
    query: vi.fn(async (sql, params) => {
      if (/WHERE firebase_uid = \$1/.test(sql)) return { rows: directory.filter(u => u.firebase_uid === params[0]) };
      if (/WHERE LOWER\(email\)/.test(sql)) return { rows: directory.filter(u => u.email === params[0]) };
      if (/^\s*UPDATE users/.test(sql)) return { rows: [{ ...directory.find(u => u.id === params[2]), firebase_uid: params[0] }] };
      return { rows: [] };
    }),
  }),
}));

const { default: authRouter } = await import('../routes/auth.js');

let server;
let baseUrl;
beforeEach(async () => {
  setFirebaseRole.mockClear();
  directory = [{ id: 7, email: 'ops@example.com', username: 'Ops', role: 'operator', firebase_uid: null }];
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;
});
afterEach(() => new Promise(resolve => server.close(resolve)));

const syncUser = () => fetch(`${baseUrl}/sync-user`, { method: 'POST', headers: { Authorization: 'Bearer token' } });

describe('POST /api/auth/sync-user', () => {
  it('links a verified email to its directory row and sets the role claim on that Firebase UID', async () => {
    decodedToken = { uid: 'fb-7', email: 'ops@example.com', email_verified: true };
    const response = await syncUser();
    expect(response.status).toBe(200);
    expect((await response.json()).user.role).toBe('operator');
    expect(setFirebaseRole).toHaveBeenCalledWith('fb-7', 'operator');
  });

  it('refuses an email that is not in the team directory', async () => {
    decodedToken = { uid: 'fb-x', email: 'stranger@example.com', email_verified: true };
    const response = await syncUser();
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('ACCESS_NOT_GRANTED');
    expect(setFirebaseRole).not.toHaveBeenCalled();
  });

  it('refuses to link an unverified email to a pre-created row', async () => {
    decodedToken = { uid: 'fb-attacker', email: 'ops@example.com', email_verified: false };
    const response = await syncUser();
    expect(response.status).toBe(403);
    expect(setFirebaseRole).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/desktop-login', () => {
  const desktopLogin = (headers = { Authorization: 'Bearer token' }) => 
    fetch(`${baseUrl}/desktop-login`, { method: 'POST', headers });

  it('authorizes operator, syncs user, sets role claim, and returns databaseUrl', async () => {
    decodedToken = { uid: 'fb-7', email: 'ops@example.com', email_verified: true };
    const response = await desktopLogin();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.user.role).toBe('operator');
    expect(data.databaseUrl).toBeDefined();
    expect(setFirebaseRole).toHaveBeenCalledWith('fb-7', 'operator');
  });

  it('refuses viewer role from desktop login with 403', async () => {
    directory = [{ id: 8, email: 'viewer@example.com', username: 'ViewOnly', role: 'viewer', firebase_uid: null }];
    decodedToken = { uid: 'fb-8', email: 'viewer@example.com', email_verified: true };
    const response = await desktopLogin();
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain('not authorized to operate desktop scraper');
  });

  it('refuses unknown email with 403 ACCESS_NOT_GRANTED', async () => {
    decodedToken = { uid: 'fb-x', email: 'stranger@example.com', email_verified: true };
    const response = await desktopLogin();
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('ACCESS_NOT_GRANTED');
  });

  it('returns 401 when Authorization header is missing', async () => {
    const response = await desktopLogin({});
    expect(response.status).toBe(401);
  });
});

