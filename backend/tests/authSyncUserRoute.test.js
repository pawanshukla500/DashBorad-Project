import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let decodedToken;
let directory;
const setFirebaseRole = vi.fn(async () => {});

vi.mock('../utils/firebaseAdmin.js', () => ({
  auth: { 
    verifyIdToken: vi.fn(async () => decodedToken),
    createCustomToken: vi.fn(async () => 'mock-custom-token'),
    getUser: vi.fn(async () => ({}))
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

// The routes verify the analyst principal server-side before provisioning it.
// Keep the real (pure) provisioning logic; only stub the live-connection check.
const verifyAnalystPrincipal = vi.fn(async () => true);
vi.mock('../utils/desktopProvisioning.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    verifyAnalystPrincipalIsReadOnly: (...args) => verifyAnalystPrincipal(...args),
  };
});

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
    expect(data.databaseAccess).toBe('standard');
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

  it('never leaks a container-internal DATABASE_URL to desktop clients', async () => {
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevDesktopDatabaseUrl = process.env.DESKTOP_DATABASE_URL;
    process.env.DESKTOP_DATABASE_URL = '';
    process.env.DATABASE_URL = 'postgresql://app:pass@postgres:5432/paymentapp';
    try {
      decodedToken = { uid: 'fb-7', email: 'ops@example.com', email_verified: true };
      const response = await desktopLogin();
      expect(response.status).toBe(200);
      expect((await response.json()).databaseUrl).toBe('');
    } finally {
      process.env.DATABASE_URL = prevDatabaseUrl;
      process.env.DESKTOP_DATABASE_URL = prevDesktopDatabaseUrl;
    }
  });

  it('provisions DESKTOP_DATABASE_URL so desktop login auto-configures the database', async () => {
    const prevDesktopDatabaseUrl = process.env.DESKTOP_DATABASE_URL;
    process.env.DESKTOP_DATABASE_URL = 'postgresql://worker:pass@db.example.com:5432/paymentapp';
    try {
      decodedToken = { uid: 'fb-7', email: 'ops@example.com', email_verified: true };
      const response = await desktopLogin();
      expect(response.status).toBe(200);
      expect((await response.json()).databaseUrl).toBe('postgresql://worker:pass@db.example.com:5432/paymentapp');
    } finally {
      process.env.DESKTOP_DATABASE_URL = prevDesktopDatabaseUrl;
    }
  });

  it('does not provision raw database credentials to analyst desktop sessions', async () => {
    const previousUrl = process.env.DESKTOP_DATABASE_URL;
    const previousAnalystUrl = process.env.DESKTOP_ANALYST_DATABASE_URL;
    process.env.DESKTOP_DATABASE_URL = 'postgresql://worker:pass@db.example.com:5432/paymentapp';
    process.env.DESKTOP_ANALYST_DATABASE_URL = '';
    directory = [{ id: 9, email: 'analyst@example.com', username: 'Analyst', role: 'analyst', firebase_uid: null }];
    decodedToken = { uid: 'fb-analyst', email: 'analyst@example.com', email_verified: true };
    try {
      const response = await desktopLogin();
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.user.role).toBe('analyst');
      expect(data.databaseUrl).toBe('');
      expect(data.databaseAccess).toBe('read-only');
    } finally {
      process.env.DESKTOP_DATABASE_URL = previousUrl;
      process.env.DESKTOP_ANALYST_DATABASE_URL = previousAnalystUrl;
    }
  });

  it('provisions an analyst only the separate read-only database URL', async () => {
    const previousUrl = process.env.DESKTOP_DATABASE_URL;
    const previousAnalystUrl = process.env.DESKTOP_ANALYST_DATABASE_URL;
    const readonlyUrl = 'postgresql://analyst:readonly@db.example.com:5432/paymentapp';
    process.env.DESKTOP_DATABASE_URL = 'postgresql://worker:write@db.example.com:5432/paymentapp';
    process.env.DESKTOP_ANALYST_DATABASE_URL = readonlyUrl;
    directory = [{ id: 9, email: 'analyst@example.com', username: 'Analyst', role: 'analyst', firebase_uid: null }];
    decodedToken = { uid: 'fb-analyst-readonly', email: 'analyst@example.com', email_verified: true };
    try {
      const response = await desktopLogin();
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.databaseUrl).toBe(readonlyUrl);
      expect(data.databaseAccess).toBe('read-only');
      expect(verifyAnalystPrincipal).toHaveBeenCalledWith(readonlyUrl);
    } finally {
      process.env.DESKTOP_DATABASE_URL = previousUrl;
      process.env.DESKTOP_ANALYST_DATABASE_URL = previousAnalystUrl;
      verifyAnalystPrincipal.mockClear();
    }
  });

  it('withholds the analyst URL when the principal fails server-side read-only verification (fail-closed)', async () => {
    const previousUrl = process.env.DESKTOP_DATABASE_URL;
    const previousAnalystUrl = process.env.DESKTOP_ANALYST_DATABASE_URL;
    process.env.DESKTOP_DATABASE_URL = 'postgresql://worker:write@db.example.com:5432/paymentapp';
    process.env.DESKTOP_ANALYST_DATABASE_URL = 'postgresql://analyst:writer@db.example.com:5432/paymentapp';
    directory = [{ id: 9, email: 'analyst@example.com', username: 'Analyst', role: 'analyst', firebase_uid: null }];
    decodedToken = { uid: 'fb-analyst-writer', email: 'analyst@example.com', email_verified: true };
    verifyAnalystPrincipal.mockResolvedValueOnce(false);
    try {
      const response = await desktopLogin();
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.databaseUrl).toBe('');
      expect(data.databaseAccess).toBe('read-only');
    } finally {
      process.env.DESKTOP_DATABASE_URL = previousUrl;
      process.env.DESKTOP_ANALYST_DATABASE_URL = previousAnalystUrl;
      verifyAnalystPrincipal.mockClear();
    }
  });
});

describe('GET /api/auth/desktop-config', () => {
  it('does not provision raw database credentials to analyst desktop sessions', async () => {
    const previousUrl = process.env.DESKTOP_DATABASE_URL;
    const previousAnalystUrl = process.env.DESKTOP_ANALYST_DATABASE_URL;
    process.env.DESKTOP_DATABASE_URL = 'postgresql://worker:pass@db.example.com:5432/paymentapp';
    process.env.DESKTOP_ANALYST_DATABASE_URL = '';
    decodedToken = {
      uid: 'fb-analyst-config',
      email: 'analyst@example.com',
      recon_role: 'analyst',
      iat: Math.floor(Date.now() / 1000)
    };
    try {
      const response = await fetch(`${baseUrl}/desktop-config`, {
        headers: { Authorization: 'Bearer token' }
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.user.role).toBe('analyst');
      expect(data.databaseUrl).toBe('');
      expect(data.databaseAccess).toBe('read-only');
    } finally {
      process.env.DESKTOP_DATABASE_URL = previousUrl;
      process.env.DESKTOP_ANALYST_DATABASE_URL = previousAnalystUrl;
    }
  });

  it('uses the analyst read-only URL on the token-backed configuration endpoint', async () => {
    const previousUrl = process.env.DESKTOP_DATABASE_URL;
    const previousAnalystUrl = process.env.DESKTOP_ANALYST_DATABASE_URL;
    const readonlyUrl = 'postgresql://analyst:readonly@db.example.com:5432/paymentapp';
    process.env.DESKTOP_DATABASE_URL = 'postgresql://worker:write@db.example.com:5432/paymentapp';
    process.env.DESKTOP_ANALYST_DATABASE_URL = readonlyUrl;
    decodedToken = {
      uid: 'fb-analyst-config-readonly',
      email: 'analyst@example.com',
      recon_role: 'analyst',
      iat: Math.floor(Date.now() / 1000)
    };
    try {
      const response = await fetch(`${baseUrl}/desktop-config`, {
        headers: { Authorization: 'Bearer token' }
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.databaseUrl).toBe(readonlyUrl);
      expect(data.databaseAccess).toBe('read-only');
    } finally {
      process.env.DESKTOP_DATABASE_URL = previousUrl;
      process.env.DESKTOP_ANALYST_DATABASE_URL = previousAnalystUrl;
    }
  });
});

