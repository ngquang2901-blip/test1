// Values electron-vite inlines into the main process from apps/desktop/.env.local (see license-config.ts)
interface ImportMetaEnv {
  readonly MAIN_VITE_FIREBASE_API_KEY?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
