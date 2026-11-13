// The Firebase project that holds the accounts (see docs/dang-nhap-google.md). Not secrets: a Firebase web API key and a Google
// OAuth client of type "Desktop app" ship inside every copy of the app; what protects the data is firebase/firestore.rules.
import type { LicenseConfig } from './license';

export const LICENSE_CONFIG: LicenseConfig = { apiKey: '', projectId: '', clientId: '', clientSecret: '' };
