import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  type Auth,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

/**
 * ============================================================================
 *  FIREBASE BOOTSTRAP (Auth + Firestore)
 * ============================================================================
 *
 * Reads the project config from VITE_FIREBASE_* env vars (see SETUP.md), the same
 * pattern as VITE_ANTHROPIC_API_KEY. The whole feature is OPTIONAL: until the user fills
 * those vars in `.env.local`, `firebaseEnabled` is false and `auth`/`db` are null, so the
 * login modal still shows (with a "not configured" note) and Guest keeps the app usable.
 *
 * Setup checklist (do this in the Firebase console — see README "Sign-in setup"):
 *   1. Create a project → Add app → Web → copy the firebaseConfig values.
 *   2. Authentication → Sign-in method → enable Email/Password.
 *   3. Firestore Database → Create (production mode) with a rule restricting users/{uid}
 *      to its owner (see README).
 *   4. Paste the values into .env.local as VITE_FIREBASE_* and restart the dev server.
 */

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/** True only when the required config (apiKey, authDomain, projectId, appId) is present. */
export const firebaseEnabled: boolean = Boolean(
  config.apiKey && config.authDomain && config.projectId && config.appId,
);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

if (firebaseEnabled) {
  app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);
  // Remember the session across visits/reloads (the default for web, set explicitly so
  // the "stay signed in" behaviour is intentional and obvious).
  void setPersistence(auth, browserLocalPersistence);
}

export { auth, db };
