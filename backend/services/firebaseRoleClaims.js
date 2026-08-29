import { auth } from '../utils/firebaseAdmin.js';
import { normalizedRole } from '../utils/accessRole.js';

// A namespaced custom claim keeps authorization in Firebase and avoids
// colliding with claims another Firebase integration may use.
export const FIREBASE_ROLE_CLAIM = 'recon_role';

export async function setFirebaseRole(firebaseUid, role) {
  const uid = String(firebaseUid || '').trim();
  if (!uid) throw new Error('Firebase UID is required to set a role');

  const firebaseUser = await auth.getUser(uid);
  const nextRole = normalizedRole(role);
  if (firebaseUser.customClaims?.[FIREBASE_ROLE_CLAIM] === nextRole) return nextRole;

  await auth.setCustomUserClaims(uid, {
    ...(firebaseUser.customClaims || {}),
    [FIREBASE_ROLE_CLAIM]: nextRole,
  });
  return nextRole;
}

// One-time/startup backfill for existing local directory entries. This is not
// part of request authentication: a database delay must never prevent a valid
// Firebase session from reaching the API.
export async function syncFirebaseRoleClaims(pool) {
  const { rows } = await pool.query(`
    SELECT firebase_uid, role
    FROM users
    WHERE firebase_uid IS NOT NULL AND TRIM(firebase_uid) <> ''
  `);

  const outcome = { checked: rows.length, updated: 0, unchanged: 0, skipped: 0 };
  for (const row of rows) {
    try {
      const firebaseUser = await auth.getUser(row.firebase_uid);
      const nextRole = normalizedRole(row.role);
      if (firebaseUser.customClaims?.[FIREBASE_ROLE_CLAIM] === nextRole) {
        outcome.unchanged++;
        continue;
      }
      await auth.setCustomUserClaims(row.firebase_uid, {
        ...(firebaseUser.customClaims || {}),
        [FIREBASE_ROLE_CLAIM]: nextRole,
      });
      outcome.updated++;
    } catch (error) {
      // A deleted/disabled Firebase user must not stop application startup.
      outcome.skipped++;
      console.warn('[firebase roles] Could not sync a directory entry:', error.message);
    }
  }
  return outcome;
}
