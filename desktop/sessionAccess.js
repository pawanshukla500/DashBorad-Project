import { decodeJwtPayload, isAuthorizedDesktopRole, isAuthorizedMutationRole } from './authValidation.js';

export function publicSession(session) {
  return session?.authenticated
    ? { authenticated: true, user: session.user, authorizedAt: session.authorizedAt }
    : { authenticated: false, user: null };
}

export function createSessionAccess({ load, save, refresh, verify, onAuthorized, now = Date.now }) {
  // A local session file is a token store, not an authorization source.
  return async function authorize(mutation = false) {
    let session = load();
    if (!session?.authenticated || !session.idToken) return null;
    const originalToken = session.idToken;
    const payload = decodeJwtPayload(session.idToken);
    if (!payload?.exp || payload.exp * 1000 <= now() + 30000) {
      const renewed = await refresh(session.refreshToken);
      if (!renewed?.idToken) return null;
      session = { ...session, ...renewed };
    }
    const result = await verify(session.idToken);
    const uid = result.verifiedPayload?.uid || result.verifiedPayload?.sub;
    if (!result.authorized || !uid || uid !== session.user?.firebase_uid ||
        result.role !== session.user?.role || !isAuthorizedDesktopRole(result.role) ||
        (mutation && !isAuthorizedMutationRole(result.role))) return null;
    // Logout while a network verification is in flight must not restore a session.
    if (load()?.idToken !== originalToken) return null;
    if (session.idToken !== originalToken && !save(session).success) return null;
    if (onAuthorized) await onAuthorized(session);
    return session;
  };
}
