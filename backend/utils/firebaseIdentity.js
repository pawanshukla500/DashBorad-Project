export function identityFromFirebaseToken(decodedToken = {}) {
  const uid = String(decodedToken.uid || '').trim();
  const email = String(decodedToken.email || '').trim().toLowerCase();
  if (!uid || !email) {
    throw new Error('Firebase token must contain a UID and email address');
  }

  return {
    uid,
    email,
    displayName: String(decodedToken.name || email.split('@')[0]).trim(),
  };
}
