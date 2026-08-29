import express from 'express';
import { getPool } from '../db/index.js';
import { authMiddleware, requireAdmin, VALID_ROLES, normalizedRole } from '../utils/authMiddleware.js';
import { auth } from '../utils/firebaseAdmin.js';
import { identityFromFirebaseToken } from '../utils/firebaseIdentity.js';
import { IdentityConflictError, syncFirebaseUser } from '../services/userSync.js';
import { setFirebaseRole } from '../services/firebaseRoleClaims.js';

const router = express.Router();

// ── 1. Firebase Session Sync ────────────────────────────────────────────────
router.post('/sync-user', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Firebase token for sync' });
    }
    const token = authHeader.split(' ')[1];

    let identity;
    try {
      const decodedToken = await auth.verifyIdToken(token);
      identity = identityFromFirebaseToken(decodedToken);
    } catch (err) {
      return res.status(403).json({ error: 'Invalid Firebase token for sync' });
    }

    const pool = getPool();
    const { uid, email, displayName } = identity;
    const user = await syncFirebaseUser(pool, { uid, email, displayName });
    await setFirebaseRole(uid, user.role);

    // No local JWT is returned because the frontend relies solely on Firebase tokens now.
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: normalizedRole(user.role),
      },
    });
  } catch (err) {
    if (err instanceof IdentityConflictError) {
      return res.status(409).json({ error: err.message });
    }
    console.error('[auth/sync-user error]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 3. Current Firebase session ────────────────────────────────────────────
// Authentication and authorization are already complete in authMiddleware.
// Do not query PostgreSQL here: this route must stay available when reporting
// data is busy or the database is reconnecting.
router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ── 5. User Management (Admin Only): Read list of users ──────────────────────
router.get('/users', requireAdmin, async (req, res) => {
  const pool = getPool();
  try {
    const result = await pool.query('SELECT id, username, email, role, firebase_uid, created_at FROM users ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('[auth/get-users error]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 5. User Management (Admin Only): Create a new user ───────────────────────
router.post('/users', requireAdmin, async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!email || !username || !role || !password) {
    return res.status(400).json({ error: 'Username, email, password, and role are required' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const pool = getPool();
  try {
    const cleanEmail = email.trim().toLowerCase();
    
    // Check if user already exists
    const check = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [cleanEmail]);
    if (check.rows.length > 0) {
      return res.status(400).json({ error: 'A user with this email already exists in Postgres' });
    }

    // 1. Create user in Firebase Auth
    let firebaseUser;
    try {
      firebaseUser = await auth.createUser({
        email: cleanEmail,
        password,
        displayName: username.trim(),
      });
    } catch (fbErr) {
      return res.status(400).json({ error: 'Firebase error: ' + fbErr.message });
    }

    // 2. Firebase custom claims are the authorization source. The SQL row is
    // only the team-directory/audit mirror, never a login prerequisite.
    try {
      await setFirebaseRole(firebaseUser.uid, role);
    } catch (claimError) {
      try { await auth.deleteUser(firebaseUser.uid); } catch {}
      return res.status(502).json({ error: `Firebase role setup failed: ${claimError.message}` });
    }

    // 3. Create user in PostgreSQL with firebase_uid
    const result = await pool.query(
      `INSERT INTO users (username, email, firebase_uid, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, role, created_at, firebase_uid`,
      [username.trim(), cleanEmail, firebaseUser.uid, role]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[auth/create-user error]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 7. User Management (Admin Only): Update user roles/access ────────────────
router.put('/users/:id/role', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;
  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const pool = getPool();
  try {
    const target = await pool.query(
      'SELECT id, firebase_uid FROM users WHERE id = $1',
      [id]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.rows[0].firebase_uid === req.user.firebase_uid) {
      return res.status(400).json({ error: 'You cannot change your own administrator access' });
    }
    if (!target.rows[0].firebase_uid) {
      return res.status(409).json({ error: 'This directory entry has no Firebase account and cannot receive an access role.' });
    }

    await setFirebaseRole(target.rows[0].firebase_uid, role);
    const result = await pool.query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, email, role, firebase_uid',
      [role, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[auth/update-role error]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 7. User Management (Admin Only): Delete user ─────────────────────────────
router.delete('/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  const pool = getPool();
  try {
    const target = await pool.query(
      'SELECT id, username, email, firebase_uid FROM users WHERE id = $1',
      [id]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const deletedUser = target.rows[0];

    if (deletedUser.firebase_uid === req.user.firebase_uid) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    // Firebase is authoritative, so revoke the account before removing its
    // local directory mirror. A Firebase failure leaves the user untouched.
    if (deletedUser.firebase_uid) {
      try {
        await auth.deleteUser(deletedUser.firebase_uid);
      } catch (fbErr) {
        return res.status(502).json({ error: `Firebase account removal failed: ${fbErr.message}` });
      }
    }
    await pool.query('DELETE FROM users WHERE id = $1', [id]);

    res.json({ success: true, message: 'User deleted successfully', user: deletedUser });
  } catch (err) {
    console.error('[auth/delete-user error]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
