const AUTH_ERROR_MAP = {
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/user-disabled': 'This account has been disabled. Contact your administrator.',
  'auth/user-not-found': 'No account found with this email. Check the address or contact admin.',
  'auth/wrong-password': 'Incorrect password. Please try again or use Forgot Password.',
  'auth/invalid-credential': 'Invalid email or password. Please check your credentials.',
  'auth/too-many-requests': 'Too many failed attempts. Please wait a few minutes and try again.',
  'auth/network-request-failed': 'Network error. Check your internet connection and try again.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/operation-not-allowed': 'Email sign-in is not enabled. Contact your administrator.',
  'auth/requires-recent-login': 'For security, please sign out and sign in again before changing your password.',
};

export function formatAuthError(err) {
  if (!err) return 'Authentication failed. Please try again.';

  const code = err.code || '';
  if (AUTH_ERROR_MAP[code]) return AUTH_ERROR_MAP[code];

  const msg = (err.message || '').replace(/^Firebase:\s*/i, '').replace(/\s*\(auth\/[^)]+\)\.?$/, '').trim();
  if (msg && !msg.includes('auth/')) return msg;

  return 'Authentication failed. Please verify your credentials and try again.';
}
