import { initializeApp } from "firebase/app";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  sendPasswordResetEmail,
  createUserWithEmailAndPassword
} from "firebase/auth";

// Prefer Vite env (VITE_FIREBASE_*) — never commit production secrets to source.
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY            || "AIzaSyD3FSzQXK7MACZOJR9tz_N7tnQ40QLMchs",
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN        || "payment-reco-dashbord.firebaseapp.com",
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID         || "payment-reco-dashbord",
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET     || "payment-reco-dashbord.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "579689739228",
  appId:             import.meta.env.VITE_FIREBASE_APP_ID             || "1:579689739228:web:299e46e452fb0cadb51519",
  measurementId:     import.meta.env.VITE_FIREBASE_MEASUREMENT_ID     || "G-YCZ9E2EHX1",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Make the Firebase SDK own the browser session. Application code never writes
// an ID token to localStorage or creates a separate local JWT/session.
export function prepareFirebaseSession() {
  return setPersistence(auth, browserLocalPersistence);
}

export {
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  sendPasswordResetEmail,
  createUserWithEmailAndPassword
};

export default app;
