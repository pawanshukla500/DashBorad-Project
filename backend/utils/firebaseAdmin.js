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
  app = initializeApp({
    credential: cert(serviceAccount)
  });
  console.log('[Firebase Admin] Initialized successfully.');
}

export const auth = getAuth(app);
