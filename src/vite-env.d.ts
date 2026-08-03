/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Anthropic API key for client-side constraint parsing (see backend/README.md). */
  readonly VITE_ANTHROPIC_API_KEY?: string;
  /** Google Gemini API key for the Facade-mode AI renderer (Gemini 2.5 Flash Image). */
  readonly VITE_GEMINI_API_KEY?: string;
  /** Firebase web-app config for sign-in + per-account saving (see SETUP.md). */
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
