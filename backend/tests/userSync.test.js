import { describe, expect, it, vi } from 'vitest';
import { AccessNotGrantedError, IdentityConflictError, syncFirebaseUser } from '../services/userSync.js';

const identity = {
  uid: 'verified-uid',
  email: 'verified@example.com',
  displayName: 'Verified User',
  emailVerified: true,
};

describe('Firebase user synchronization', () => {
  it('returns the directory row already linked to the Firebase UID', async () => {
    const pool = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 3, ...identity, firebase_uid: identity.uid, role: 'analyst' }] }),
    };

    const user = await syncFirebaseUser(pool, { ...identity, emailVerified: false });
    expect(user.role).toBe('analyst');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('refuses an email that is not in the team directory instead of provisioning a viewer', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    await expect(syncFirebaseUser(pool, identity)).rejects.toBeInstanceOf(AccessNotGrantedError);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls.some(([sql]) => /INSERT INTO users/i.test(sql))).toBe(false);
  });

  it('rejects an email already bound to another Firebase UID', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 1, email: identity.email, firebase_uid: 'other-uid' }] }),
    };

    await expect(syncFirebaseUser(pool, identity)).rejects.toBeInstanceOf(IdentityConflictError);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('binds a seeded user only when the verified email matches', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 9, email: identity.email, firebase_uid: null, role: 'admin' }] })
        .mockResolvedValueOnce({ rows: [{ id: 9, email: identity.email, firebase_uid: identity.uid, role: 'admin' }] }),
    };

    const user = await syncFirebaseUser(pool, identity);
    expect(user.role).toBe('admin');
    expect(pool.query.mock.calls[1][1]).toEqual(['verified@example.com']);
    expect(pool.query.mock.calls[2][1]).toEqual(['verified-uid', 'Verified User', 9]);
  });

  it('does not let an unverified sign-up claim a pre-created (e.g. seeded admin) row', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 9, email: identity.email, firebase_uid: null, role: 'admin' }] }),
    };

    await expect(syncFirebaseUser(pool, { ...identity, emailVerified: false }))
      .rejects.toBeInstanceOf(AccessNotGrantedError);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
