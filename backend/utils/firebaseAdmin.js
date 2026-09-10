import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import dotenv from 'dotenv';
dotenv.config();

let serviceAccount;
try {
  const jsonStr = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!jsonStr) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set in .env');
  }
  serviceAccount = JSON.parse(jsonStr);
} catch (error) {
  console.error('[Firebase Admin] Error reading service account JSON:', error.message);
}

let app;
if (serviceAccount && getApps().length === 0) {
  try {
    app = initializeApp({
      credential: cert(serviceAccount)
    });
    console.log('[Firebase Admin] Initialized successfully.');
  } catch (initErr) {
    console.error('[Firebase Admin] Initialization error:', initErr.message);
  }
} else if (getApps().length > 0) {
  app = getApps()[0];
}

export const auth = app
  ? getAuth(app)
  : {
      verifyIdToken: async () => {
        throw new Error('Firebase Admin is not configured (missing FIREBASE_SERVICE_ACCOUNT_JSON)');
      },
      createCustomToken: async () => {
        throw new Error('Firebase Admin is not configured (missing FIREBASE_SERVICE_ACCOUNT_JSON)');
      },
      getUser: async () => {
        throw new Error('Firebase Admin is not configured (missing FIREBASE_SERVICE_ACCOUNT_JSON)');
      },
      setCustomUserClaims: async () => {
        throw new Error('Firebase Admin is not configured (missing FIREBASE_SERVICE_ACCOUNT_JSON)');
      },
    };

