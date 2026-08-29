import { describe, expect, it, vi } from 'vitest';
import { IdentityConflictError, syncFirebaseUser } from '../services/userSync.js';

const identity = {
  uid: 'verified-uid',
  email: 'verified@example.com',
  displayName: 'Verified User',
};

describe('Firebase user synchronization', () => {
  it('creates new identities only as viewers', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 1, ...identity, role: 'viewer' }] }),
    };

    await syncFirebaseUser(pool, identity);
    const [insertSql, insertValues] = pool.query.mock.calls[2];
    expect(insertSql).toContain("VALUES ($1, $2, $3, 'viewer')");
    expect(insertValues).toEqual(['Verified User', 'verified@example.com', 'verified-uid']);
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
});
