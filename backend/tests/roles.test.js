import { describe, expect, it, vi } from 'vitest';
import { mutationAccessGuard, normalizedRole, rateCardAccessGuard, requireRole } from '../utils/authMiddleware.js';

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

describe('role authorization', () => {
  it('maps legacy users to operator access', () => {
    expect(normalizedRole('user')).toBe('operator');
  });

  it('allows only configured roles', () => {
    const next = vi.fn();
    const res = response();
    requireRole('admin')({ user: { role: 'viewer' } }, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows operators to mutate uploads but reserves deletes for admins', () => {
    const operatorNext = vi.fn();
    mutationAccessGuard({ method: 'POST', user: { role: 'operator' } }, response(), operatorNext);
    expect(operatorNext).toHaveBeenCalledOnce();

    const res = response();
    mutationAccessGuard({ method: 'DELETE', user: { role: 'operator' } }, res, vi.fn());
    expect(res.statusCode).toBe(403);
  });

  it('keeps rate calculations readable while protecting configuration writes', () => {
    const calculateNext = vi.fn();
    rateCardAccessGuard(
      { method: 'POST', path: '/calculate', user: { role: 'viewer' } },
      response(),
      calculateNext
    );
    expect(calculateNext).toHaveBeenCalledOnce();

    const res = response();
    rateCardAccessGuard(
      { method: 'POST', path: '/config/commission', user: { role: 'operator' } },
      res,
      vi.fn()
    );
    expect(res.statusCode).toBe(403);
  });
});
