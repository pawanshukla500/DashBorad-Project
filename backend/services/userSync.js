export class IdentityConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdentityConflictError';
  }
}

export class AccessNotGrantedError extends Error {
  constructor(message = 'This account has not been granted access. Ask an administrator to add it in Admin Center.') {
    super(message);
    this.name = 'AccessNotGrantedError';
  }
}

// Link a Firebase identity to its team-directory row. Users are added by an
// admin (Admin Center creates the Firebase account, its role claim and the row
// together), so an unknown email is refused rather than provisioned, and a
// pre-created row is only claimed by a Firebase account that has proved it
// owns the email — otherwise an unverified sign-up could inherit its role.
export async function syncFirebaseUser(pool, { uid, email, displayName, emailVerified = false }) {
  let result = await pool.query('SELECT * FROM users WHERE firebase_uid = $1', [uid]);
  if (result.rows.length > 0) return result.rows[0];

  result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  const emailUser = result.rows[0];

  if (emailUser?.firebase_uid && emailUser.firebase_uid !== uid) {
    throw new IdentityConflictError('This email is already linked to another Firebase account');
  }

  if (!emailUser) throw new AccessNotGrantedError();
  if (!emailVerified) {
    throw new AccessNotGrantedError('Verify this email address with Firebase before it can be linked to its team-directory account.');
  }

  const updateResult = await pool.query(
    `UPDATE users
     SET firebase_uid = $1, username = COALESCE(NULLIF(username, ''), $2)
     WHERE id = $3
     RETURNING *`,
    [uid, displayName, emailUser.id],
  );
  return updateResult.rows[0];
}
