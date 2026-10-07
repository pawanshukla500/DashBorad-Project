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

const { authMiddleware, forgetRevocationState, pruneRevocationCache, revocationCacheSize, requireRole } = await import('../utils/authMiddleware.js');

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

  it('does not let a lookup that started before a role change cache stale state', async () => {
    const { auth } = await import('../utils/firebaseAdmin.js');
    auth.getUser.mockClear();
    decodedToken = { uid: 'racer', email: 'ops@example.com', recon_role: 'admin', auth_time: issuedAt };
    let answer;
    auth.getUser.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const inFlight = authMiddleware(request(), response(), vi.fn());
    await new Promise(resolve => setTimeout(resolve, 10));
    forgetRevocationState('racer'); // the admin changed the role and revoked sessions
    answer({ tokensValidAfterTime: null }); // the old, pre-revocation answer arrives
    await inFlight;
    firebaseUser = { tokensValidAfterTime: '2026-10-07T09:00:00Z' };
    const res = response();
    await authMiddleware(request(), res, vi.fn());
    expect(auth.getUser).toHaveBeenCalledTimes(2); // looked up again, not served from the stale cache
    expect(res.statusCode).toBe(401);
  });

  const fillCache = async (count, prefix = 'u') => {
    firebaseUser = { tokensValidAfterTime: null };
    for (let i = 0; i < count; i++) {
      decodedToken = { uid: `${prefix}${i}`, email: `${prefix}${i}@example.com`, recon_role: 'viewer', auth_time: issuedAt };
      await authMiddleware(request(), response(), vi.fn());
    }
  };

  it('drops expired entries once the cache grows, at most once per cache window', async () => {
    await fillCache(520);
    expect(revocationCacheSize()).toBe(520);
    const later = Date.now() + 61_000;
    pruneRevocationCache(later);
    expect(revocationCacheSize()).toBe(0);
    await fillCache(520, 'v');
    pruneRevocationCache(later + 1_000); // within the window of the last sweep
    expect(revocationCacheSize()).toBe(520);
  });

  it("keeps a revoked user's state through a prune, so a Firebase outage still refuses the old token", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.parse('2026-10-07T10:00:00Z');
      vi.setSystemTime(start);
      const revokedAt = new Date(start - 10 * 60_000).toISOString();
      const oldToken = { uid: 'demoted', email: 'demoted@example.com', recon_role: 'admin', auth_time: Math.floor(Date.parse(revokedAt) / 1000) - 60 };
      decodedToken = oldToken;
      firebaseUser = { tokensValidAfterTime: revokedAt };
      const first = response();
      await authMiddleware(request(), first, vi.fn());
      expect(first.statusCode).toBe(401);
      await fillCache(520);
      vi.setSystemTime(start + 61_000); // every entry is now past the cache window
      pruneRevocationCache();
      expect(revocationCacheSize()).toBe(1); // only the revocation is kept
      decodedToken = oldToken;
      firebaseUser = Object.assign(new Error('network down'), { code: 'app/network-error' });
      const during = response();
      await authMiddleware(request(), during, vi.fn());
      expect(during.statusCode).toBe(401); // the outage fallback still knows the revocation
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps serving verified tokens when Firebase cannot be reached', async () => {
    decodedToken = { uid: 'member', email: 'ops@example.com', recon_role: 'viewer', auth_time: issuedAt };
    firebaseUser = Object.assign(new Error('network down'), { code: 'app/network-error' });
    const next = vi.fn();
    await authMiddleware(request(), response(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
