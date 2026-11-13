// The Firebase project that holds the accounts (see docs/dang-nhap-google.md). The key and the Google OAuth client of type
// "Desktop app" ship inside every installed copy (what protects the data is firebase/firestore.rules), but they stay out of
// the public repo: electron-vite inlines them at build time from apps/desktop/.env.local, which is never committed.
import type { LicenseConfig } from './license';

export const LICENSE_CONFIG: LicenseConfig = {
  apiKey: import.meta.env.MAIN_VITE_FIREBASE_API_KEY ?? '',
  projectId: 'toolflow-ce107',
  clientId: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ?? '',
  clientSecret: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? '',
};
