// Sign in with Google and the plan check. Google's page opens in the user's own browser (Google refuses embedded windows) and comes
// back to a one-shot 127.0.0.1 port (OAuth for installed apps, PKCE). Firebase Auth turns the Google ID token into a user; the plan is
// the Firestore row users/{uid} = { email, status: pending | active | blocked, plan?, until? }, edited by the admin in the Firebase
// console. A first sign-in creates the pending row (= registration); firebase/firestore.rules allow a user nothing else.
// Only the Firebase refresh token is kept, sealed by the OS (safeStorage), in <userData>/license.bin: never in the DB, a log or the renderer.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

export type LicenseConfig = { apiKey: string; projectId: string; clientId: string; clientSecret: string };
export type LicenseStatus = 'checking' | 'signed_out' | 'signing_in' | 'offline' | 'pending' | 'blocked' | 'expired' | 'active';
export type LicenseState = { status: LicenseStatus; email?: string; plan?: string; until?: number; buyInfo?: string; code?: string };

const coded = (code: string): Error => Object.assign(new Error(code), { code });
const b64url = (b: Buffer): string => b.toString('base64url');
type Field = { stringValue?: string; timestampValue?: string };

export function createLicense(o: {
  config: LicenseConfig; file: string; now: () => number; onChange: (s: LicenseState) => void; openBrowser: (url: string) => void;
  seal: { encrypt: (s: string) => Buffer; decrypt: (b: Buffer) => string }; fetch?: typeof fetch;
}) {
  const http = o.fetch ?? fetch;
  const c = o.config;
  let waiting: { server: Server; fail: (e: Error) => void } | null = null;
  const saved = (): string | null => { try { return o.seal.decrypt(readFileSync(o.file)); } catch { return null; } };
  let st: LicenseState = { status: saved() ? 'checking' : 'signed_out' }; // a saved sign-in: the screen waits for the first check()
  const set = (s: LicenseState): void => { st = s; o.onChange(s); };
  const keep = (refresh: string): void => writeFileSync(o.file, o.seal.encrypt(refresh), { mode: 0o600 });
  const forget = (): void => rmSync(o.file, { force: true });

  /** JSON of a Google/Firebase call; no network or a 5xx is LICENSE_NETWORK, any other refusal LICENSE_REJECTED (+ status). */
  const call = async (url: string, init: RequestInit = {}): Promise<{ status: number; j: Record<string, unknown> }> => {
    let r: Response;
    try { r = await http(url, { ...init, signal: AbortSignal.timeout(20_000) }); } catch { throw coded('LICENSE_NETWORK'); }
    if (r.status >= 500) throw coded('LICENSE_NETWORK');
    return { status: r.status, j: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> };
  };
  const form = (p: Record<string, string>): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p).toString() });
  const fsBase = `https://firestore.googleapis.com/v1/projects/${c.projectId}/databases/(default)/documents/`;

  /** The plan of a signed-in user; no row yet ⇒ this sign-in registers him (pending). */
  async function plan(idToken: string, uid: string, email: string): Promise<LicenseState> {
    const auth = { authorization: `Bearer ${idToken}` };
    let r = await call(`${fsBase}users/${uid}`, { headers: auth });
    if (r.status === 404) r = await call(`${fsBase}users?documentId=${uid}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { email: { stringValue: email }, status: { stringValue: 'pending' }, createdAt: { timestampValue: new Date(o.now()).toISOString() } } }) });
    if (r.status !== 200) throw coded('LICENSE_REJECTED');
    const f = (r.j.fields ?? {}) as Record<string, Field>;
    const until = f.until?.timestampValue ? Date.parse(f.until.timestampValue) : undefined;
    const s = f.status?.stringValue;
    const status: LicenseStatus = s === 'active' ? (until !== undefined && !(until > o.now()) ? 'expired' : 'active') : s === 'pending' ? 'pending' : 'blocked'; // an unknown status never unlocks
    const out: LicenseState = { status, email: f.email?.stringValue ?? email };
    if (f.plan?.stringValue) out.plan = f.plan.stringValue;
    if (until !== undefined) out.until = until;
    if (status !== 'active') { // how to buy: one text the admin edits in config/app, shown to whoever is not let in
      const b = await call(`${fsBase}config/app`, { headers: auth }).catch(() => null);
      const t = (b?.j.fields as Record<string, Field> | undefined)?.buyInfo?.stringValue;
      if (t) out.buyInfo = t;
    }
    return out;
  }

  /** Waits for Google's redirect on a fresh loopback port; resolves with the code. */
  function googleCode(): Promise<{ code: string; verifier: string; redirect: string }> {
    const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(16));
    return new Promise((resolve, reject) => {
      let redirect = '';
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', redirect);
        const code = u.searchParams.get('code');
        if (u.searchParams.get('state') !== state || !code) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Liên kết đăng nhập không hợp lệ.'); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<meta charset="utf-8"><p style="font:16px sans-serif">Đã đăng nhập. Bạn có thể đóng trang này và quay lại ToolFlow.</p>');
        done(); resolve({ code, verifier, redirect });
      });
      const timer = setTimeout(() => fail(coded('LICENSE_TIMEOUT')), 10 * 60_000);
      const done = (): void => { clearTimeout(timer); server.close(); server.closeAllConnections(); if (waiting?.server === server) waiting = null; };
      const fail = (e: Error): void => { done(); reject(e); };
      waiting = { server, fail };
      server.listen(0, '127.0.0.1', () => {
        redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, prompt: 'select_account' });
        o.openBrowser(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
      });
    });
  }

  const failed = (e: unknown): void => {
    const code = (e as { code?: string }).code ?? 'LICENSE_REJECTED';
    set(code === 'LICENSE_NETWORK' ? { status: 'offline', ...(st.email ? { email: st.email } : {}), code } : { status: 'signed_out', code });
  };

  return {
    state: (): LicenseState => st,
    /** The gate: an active plan whose end has not passed (checked on every call, not only at the last check). */
    ok: (): boolean => st.status === 'active' && !(st.until !== undefined && st.until <= o.now()),
    /** 'Đăng nhập bằng Google'. Pressed again while waiting: the first wait ends and a new page opens. */
    async signIn(): Promise<void> {
      if (!c.apiKey || !c.projectId || !c.clientId) throw coded('LICENSE_NOT_CONFIGURED');
      waiting?.fail(coded('LICENSE_CANCELLED'));
      set({ status: 'signing_in' });
      try {
        const g = await googleCode();
        const t = await call('https://oauth2.googleapis.com/token', form({ code: g.code, code_verifier: g.verifier, redirect_uri: g.redirect, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code' }));
        if (typeof t.j.id_token !== 'string') throw coded('LICENSE_REJECTED');
        const f = await call(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${c.apiKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ postBody: `id_token=${t.j.id_token}&providerId=google.com`, requestUri: 'http://localhost', returnSecureToken: true }) });
        const { idToken, refreshToken, localId, email } = f.j as Record<string, string>;
        if (!idToken || !refreshToken || !localId) throw coded('LICENSE_REJECTED');
        keep(refreshToken);
        set(await plan(idToken, localId, email ?? ''));
      } catch (e) {
        if ((e as { code?: string }).code !== 'LICENSE_CANCELLED') failed(e); // cancelled: the newer sign-in or the sign-out owns the state
        throw e;
      }
    },
    /** At start, every few minutes and on 'Kiểm tra lại': refresh the sign-in and read the plan again. */
    async check(): Promise<void> {
      const refresh = saved();
      if (!refresh || !c.apiKey) return set({ status: 'signed_out' });
      try {
        const r = await call(`https://securetoken.googleapis.com/v1/token?key=${c.apiKey}`, form({ grant_type: 'refresh_token', refresh_token: refresh }));
        const { id_token, refresh_token, user_id } = r.j as Record<string, string>;
        if (r.status !== 200 || !id_token || !user_id) { forget(); return set({ status: 'signed_out' }); } // revoked, disabled or deleted: sign in again
        if (refresh_token && refresh_token !== refresh) keep(refresh_token);
        set(await plan(id_token, user_id, st.email ?? ''));
      } catch (e) { failed(e); }
    },
    signOut(): void { waiting?.fail(coded('LICENSE_CANCELLED')); forget(); set({ status: 'signed_out' }); },
  };
}
export type License = ReturnType<typeof createLicense>;

/** Unpackaged test runs only (e2e, fake Flow): TOOLFLOW_FAKE_LICENSE is the state at start (default active), a sign-in goes to TOOLFLOW_FAKE_LICENSE_AFTER. */
export function createFakeLicense(start: string | undefined, after: string | undefined, onChange: (s: LicenseState) => void): License {
  const email = 'fake@example.invalid';
  const at = (status: string): LicenseState => (status === 'signed_out' ? { status } : { status: status as LicenseStatus, email, ...(status === 'active' ? {} : { buyInfo: 'Liên hệ để mua gói (thử)' }) });
  let st = at(start ?? 'active');
  const set = (s: LicenseState): void => { st = s; onChange(s); };
  return { state: () => st, ok: () => st.status === 'active', async signIn() { set(at(after ?? 'active')); }, async check() {}, signOut() { set(at('signed_out')); } };
}
