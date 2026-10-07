import { beforeEach, describe, expect, it, vi } from 'vitest';

let decodedToken;
let firebaseUser;
vi.mock('../utils/firebaseAdmin.js', () => ({
  auth: {
    verifyIdToken: vi.fn(async () => decodedToken),
    getUser: vi.fn(async () => {
      if (firebaseUser instanceof Error) throw firebaseUser;
      return firebaseUser;
    }),
  },
}));

const { authMiddleware, forgetRevocationState, requireRole } = await import('../utils/authMiddleware.js');

beforeEach(() => {
  firebaseUser = { tokensValidAfterTime: null };
  forgetRevocationState();
});

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

const request = () => ({ headers: { authorization: 'Bearer token' } });

describe('authMiddleware — team directory boundary', () => {
  it('denies a valid Firebase token that carries no role claim', async () => {
    decodedToken = { uid: 'self-signup', email: 'stranger@example.com' };
    const res = response();
    const next = vi.fn();
    await authMiddleware(request(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.payload.code).toBe('ACCESS_NOT_GRANTED');
  });

  it('admits a token whose role claim is a known role', async () => {
    decodedToken = { uid: 'member', email: 'viewer@example.com', recon_role: 'viewer' };
    const req = request();
    const next = vi.fn();
    await authMiddleware(req, response(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.role).toBe('viewer');
  });

  it('keeps requireRole closed for claimless tokens even on viewer-level routes', async () => {
    decodedToken = { uid: 'self-signup', email: 'stranger@example.com', recon_role: 'owner' };
    const res = response();
    const next = vi.fn();
    await requireRole('viewer', 'analyst', 'operator', 'admin')(request(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe('authMiddleware — revoked sessions (role change / user removed)', () => {
  const issuedAt = Math.floor(Date.parse('2026-10-07T08:00:00Z') / 1000);

  it('refuses a token issued before the sessions were revoked', async () => {
    decodedToken = { uid: 'member', email: 'ops@example.com', recon_role: 'admin', auth_time: issuedAt };
    firebaseUser = { tokensValidAfterTime: '2026-10-07T09:00:00Z' };
    const res = response();
    const next = vi.fn();
    await authMiddleware(request(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.payload.code).toBe('SESSION_REVOKED');
  });

  it('admits a token issued after the revocation', async () => {
    decodedToken = { uid: 'member', email: 'ops@example.com', recon_role: 'viewer', auth_time: issuedAt + 7200 };
    firebaseUser = { tokensValidAfterTime: '2026-10-07T09:00:00Z' };
    const next = vi.fn();
    await authMiddleware(request(), response(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('refuses the token of a deleted user', async () => {
    decodedToken = { uid: 'gone', email: 'gone@example.com', recon_role: 'admin', auth_time: issuedAt };
    firebaseUser = Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
    const res = response();
    await authMiddleware(request(), res, vi.fn());
    expect(res.statusCode).toBe(401);
  });

  it('does not hold requests longer than the lookup timeout and reuses one lookup', async () => {
    const { auth } = await import('../utils/firebaseAdmin.js');
    auth.getUser.mockClear();
    decodedToken = { uid: 'slow', email: 'ops@example.com', recon_role: 'viewer', auth_time: issuedAt };
    auth.getUser.mockImplementationOnce(() => new Promise(() => {})); // Firebase never answers
    const started = Date.now();
    const nexts = [vi.fn(), vi.fn()];
    await Promise.all(nexts.map(next => authMiddleware(request(), response(), next)));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(nexts.every(next => next.mock.calls.length === 1)).toBe(true);
    expect(auth.getUser).toHaveBeenCalledTimes(1);
    await authMiddleware(request(), response(), vi.fn()); // cached for the window
    expect(auth.getUser).toHaveBeenCalledTimes(1);
  });

  it('keeps serving verified tokens when Firebase cannot be reached', async () => {
    decodedToken = { uid: 'member', email: 'ops@example.com', recon_role: 'viewer', auth_time: issuedAt };
    firebaseUser = Object.assign(new Error('network down'), { code: 'app/network-error' });
    const next = vi.fn();
    await authMiddleware(request(), response(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
