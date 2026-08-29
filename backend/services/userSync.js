export class IdentityConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdentityConflictError';
  }
}

export async function syncFirebaseUser(pool, { uid, email, displayName }) {
  let result = await pool.query('SELECT * FROM users WHERE firebase_uid = $1', [uid]);
  if (result.rows.length > 0) return result.rows[0];

  result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  const emailUser = result.rows[0];

  if (emailUser?.firebase_uid && emailUser.firebase_uid !== uid) {
    throw new IdentityConflictError('This email is already linked to another Firebase account');
  }

  if (emailUser) {
    const updateResult = await pool.query(
      `UPDATE users
       SET firebase_uid = $1, username = COALESCE(NULLIF(username, ''), $2)
       WHERE id = $3
       RETURNING *`,
      [uid, displayName, emailUser.id],
    );
    return updateResult.rows[0];
  }

  const insertResult = await pool.query(
    `INSERT INTO users (username, email, firebase_uid, role)
     VALUES ($1, $2, $3, 'viewer')
     RETURNING *`,
    [displayName, email, uid],
  );
  return insertResult.rows[0];
}
