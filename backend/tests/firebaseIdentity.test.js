import { describe, expect, it } from 'vitest';
import { identityFromFirebaseToken } from '../utils/firebaseIdentity.js';
import { firebaseSessionFromToken } from '../utils/authMiddleware.js';

describe('Firebase identity extraction', () => {
  it('uses only claims from the verified token', () => {
    expect(identityFromFirebaseToken({
      uid: 'firebase-1',
      email: ' Admin@Example.com ',
      name: 'Admin User',
    })).toEqual({
      uid: 'firebase-1',
      email: 'admin@example.com',
      displayName: 'Admin User',
    });
  });

  it('rejects tokens without an email identity', () => {
    expect(() => identityFromFirebaseToken({ uid: 'firebase-1' })).toThrow(/UID and email/i);
  });

  it('builds an API session from Firebase claims without a database user lookup', () => {
    expect(firebaseSessionFromToken({
      uid: 'firebase-1',
      email: 'Admin@Example.com',
      name: 'Admin User',
      recon_role: 'admin',
    })).toEqual({
      id: 'firebase-1',
      firebase_uid: 'firebase-1',
      email: 'admin@example.com',
      username: 'Admin User',
      role: 'admin',
      authentication_provider: 'firebase',
    });
  });

  it('uses the least-privileged Firebase role when a role claim is missing or invalid', () => {
    expect(firebaseSessionFromToken({ uid: 'firebase-2', email: 'viewer@example.com' }).role).toBe('viewer');
    expect(firebaseSessionFromToken({ uid: 'firebase-3', email: 'viewer@example.com', recon_role: 'owner' }).role).toBe('viewer');
  });
});
