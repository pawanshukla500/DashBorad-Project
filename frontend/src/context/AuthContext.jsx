import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { 
  auth, 
  prepareFirebaseSession,
  signInWithEmailAndPassword, 
  signOut as firebaseSignOut,
  updatePassword as firebaseUpdatePassword 
} from '../api/firebase';
import { formatAuthError } from '../utils/authErrors';
import { withNormalizedRole } from '../utils/roles';
import { invalidateApiReadCache } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const sessionFromFirebase = useCallback(async (firebaseUser, forceRefresh = false) => {
    const tokenResult = await firebaseUser.getIdTokenResult(forceRefresh);
    return withNormalizedRole({
      id: firebaseUser.uid,
      firebase_uid: firebaseUser.uid,
      email: firebaseUser.email || '',
      username: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
      role: tokenResult.claims.recon_role || 'viewer',
      authentication_provider: 'firebase',
    });
  }, []);

  // ── 1. Firebase owns login, token renewal, and session restoration ─────────
  useEffect(() => {
    let unsubscribe = () => {};
    let active = true;

    void prepareFirebaseSession().then(() => {
      unsubscribe = auth.onAuthStateChanged(async (firebaseUser) => {
        if (!active) return;
      if (firebaseUser) {
        try {
          // Render with the cached token's claims straight away; waiting for a
          // forced token refresh put a round trip to Google in front of every
          // app load. The API authorizes each request from its own verified
          // token, so this only affects what the UI shows for a moment.
          setUser(await sessionFromFirebase(firebaseUser, false));
        } catch (err) {
          console.warn('[Firebase session restore failed]', err.message);
          setUser(null);
        }
        // Then fetch current custom claims once in the background, so a role
        // changed by an admin (or migrated at backend startup) still applies.
        void sessionFromFirebase(firebaseUser, true)
          .then(fresh => {
            if (!active) return;
            // Only update the same, still signed-in user: a sign-out that
            // happened meanwhile must not be undone by this late result.
            setUser(previous => {
              if (!previous || previous.firebase_uid !== fresh.firebase_uid) return previous;
              return previous.role === fresh.role ? previous : fresh;
            });
          })
          .catch(err => console.warn('[Firebase claims refresh failed]', err.message));
      } else {
        setUser(null);
      }
      setLoading(false);
      });
    }).catch(error => {
      console.error('[Firebase session setup failed]', error.message);
      if (active) {
        setUser(null);
        setLoading(false);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [sessionFromFirebase]);

  // ── 2. Firebase Cloud Auth Login ──────────────────────────────────────────
  const handleLogin = async (email, password) => {
    try {
      console.log('[Auth] Attempting Firebase Cloud authentication...');
      const userCredential = await signInWithEmailAndPassword(auth, email.trim(), password);
      const firebaseUser = userCredential.user;

      // Force a refresh so roles written as Firebase custom claims are visible
      // immediately after an administrator updates access.
      setUser(await sessionFromFirebase(firebaseUser, true));
      return { success: true, provider: 'firebase' };
    } catch (err) {
      console.error('[Auth] Firebase Auth failed:', err.code || err.message);
      throw new Error(formatAuthError(err));
    }
  };

  // ── 3. Logout ────────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    try {
      await firebaseSignOut(auth);
    } catch (e) {
      console.warn('[Auth] Error signing out of Firebase:', e.message);
    }
    // Remove the token written by pre-Firebase-session versions of the app.
    localStorage.removeItem('token');
    invalidateApiReadCache();
    setUser(null);
  };

  // ── 4. Password Modification (Firebase Only) ────────────────────────────────
  const handlePasswordChange = async (newPassword) => {
    if (!newPassword || newPassword.length < 6) {
      throw new Error('Password must be at least 6 characters long');
    }

    if (auth.currentUser) {
      try {
        await firebaseUpdatePassword(auth.currentUser, newPassword);
        console.log('[Auth] Password successfully updated in Firebase');
      } catch (err) {
        console.warn('[Auth] Could not update password in Firebase:', err.message);
        throw new Error(formatAuthError(err));
      }
    } else {
      throw new Error('You must be logged in to change your password');
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, login: handleLogin, logout: handleLogout, changePassword: handlePasswordChange }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
