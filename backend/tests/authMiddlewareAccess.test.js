import { describe, expect, it, vi } from 'vitest';

let decodedToken;
vi.mock('../utils/firebaseAdmin.js', () => ({
  auth: { verifyIdToken: vi.fn(async () => decodedToken) },
}));

const { authMiddleware, requireRole } = await import('../utils/authMiddleware.js');

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
