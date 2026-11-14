import { test, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLicense, createOpenLicense, type LicenseState } from '../src/main/license';

const config = { apiKey: 'k', projectId: 'p', clientId: 'cid', clientSecret: 'cs' };
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-13T00:00:00Z');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const seal = { encrypt: (s: string) => Buffer.from(`sealed:${s}`), decrypt: (b: Buffer) => b.toString().replace(/^sealed:/, '') };

/** Google + Firebase stand-in: one user whose Firestore row is `row` (null = none yet). Records every call. */
function fakeCloud(row: Record<string, unknown> | null, o: { down?: boolean; refreshRevoked?: boolean } = {}) {
  const calls: { url: string; method: string; body: string; auth: string | null }[] = [];
  let doc = row;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input), body = String(init?.body ?? ''), auth = new Headers(init?.headers).get('authorization');
    calls.push({ url, method: init?.method ?? 'GET', body, auth });
    if (o.down) throw new TypeError('fetch failed');
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ id_token: 'google-id' });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=k')) return json({ idToken: 'fb-id', refreshToken: 'r1', localId: 'u1', email: 'a@b.c' });
    if (url.startsWith('https://securetoken.googleapis.com/v1/token?key=k')) return o.refreshRevoked ? json({ error: { message: 'TOKEN_EXPIRED' } }, 400) : json({ id_token: 'fb-id2', refresh_token: 'r2', user_id: 'u1' });
    const fs = 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/';
    if (url === `${fs}users/u1`) return doc ? json({ fields: doc }) : json({ error: { status: 'NOT_FOUND' } }, 404);
    if (url === `${fs}users?documentId=u1`) { doc = JSON.parse(body).fields; return json({ fields: doc }); }
    if (url === `${fs}config/app`) return json({ fields: { buyInfo: { stringValue: 'Chuyển khoản rồi nhắn Zalo' } } });
    return json({}, 404);
  };
  return { fetch, calls, doc: () => doc };
}

/** The user finishes Google's page: the browser lands on our loopback address with a code. */
const browser = (code = 'c1') => async (url: string) => {
  const u = new URL(url);
  expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  await globalThis.fetch(`${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}`);
};

function make(cloud: ReturnType<typeof fakeCloud>, open = browser(), now = NOW) {
  const file = join(mkdtempSync(join(tmpdir(), 'tf-lic-')), 'license.bin');
  const seen: LicenseState[] = [];
  const lic = createLicense({ config, file, seal, openBrowser: (u) => void open(u), now: () => now, fetch: cloud.fetch as typeof fetch, onChange: (s) => seen.push(s) });
  return { lic, file, seen };
}

test('first Google sign-in registers the account as pending: no plan, the buy text is shown, nothing works yet', async () => {
  const cloud = fakeCloud(null);
  const { lic, file } = make(cloud);
  expect(lic.state()).toEqual({ status: 'signed_out' });
  await lic.signIn();
  expect(lic.state()).toEqual({ status: 'pending', email: 'a@b.c', buyInfo: 'Chuyển khoản rồi nhắn Zalo' });
  expect(lic.ok()).toBe(false);
  expect(cloud.doc()).toMatchObject({ email: { stringValue: 'a@b.c' }, status: { stringValue: 'pending' } }); // the only row the rules let a user write
  const token = cloud.calls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/token'))!;
  expect(token.body).toContain('code=c1');
  expect(token.body).toMatch(/code_verifier=[\w-]{43}/); // PKCE
  expect(cloud.calls.filter((c) => c.url.includes('firestore')).every((c) => c.auth === 'Bearer fb-id')).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe('sealed:r1'); // only the refresh token, sealed by the OS
});

test('an active plan with a future end date unlocks; past it, the gate closes at once', async () => {
  const until = new Date(NOW + DAY).toISOString();
  const cloud = fakeCloud({ email: { stringValue: 'a@b.c' }, status: { stringValue: 'active' }, plan: { stringValue: 'Gói tháng' }, until: { timestampValue: until } });
  let now = NOW;
  const file = join(mkdtempSync(join(tmpdir(), 'tf-lic-')), 'license.bin');
  const lic = createLicense({ config, file, seal, openBrowser: (u) => void browser()(u), now: () => now, fetch: cloud.fetch as typeof fetch, onChange: () => {} });
  await lic.signIn();
  expect(lic.state()).toMatchObject({ status: 'active', email: 'a@b.c', plan: 'Gói tháng', until: NOW + DAY });
  expect(lic.ok()).toBe(true);
  now = NOW + DAY + 1;
  expect(lic.ok()).toBe(false);
  await lic.check();
  expect(lic.state().status).toBe('expired');
});

test('a saved sign-in is checked again at start; offline blocks (the user asked: no use without the server)', async () => {
  const row = { email: { stringValue: 'a@b.c' }, status: { stringValue: 'active' } };
  const { lic, file } = make(fakeCloud(row));
  await lic.signIn();
  const again = createLicense({ config, file, seal, openBrowser: () => {}, now: () => NOW, fetch: fakeCloud(row).fetch as typeof fetch, onChange: () => {} });
  await again.check();
  expect(again.state()).toMatchObject({ status: 'active', email: 'a@b.c' }); // no end date: open-ended plan
  expect(readFileSync(file, 'utf8')).toBe('sealed:r2'); // the rotated refresh token is kept
  const off = createLicense({ config, file, seal, openBrowser: () => {}, now: () => NOW, fetch: fakeCloud(row, { down: true }).fetch as typeof fetch, onChange: () => {} });
  await off.check();
  expect(off.state()).toMatchObject({ status: 'offline', code: 'LICENSE_NETWORK' });
  expect(off.ok()).toBe(false);
  expect(existsSync(file)).toBe(true); // offline keeps the sign-in for when the network is back
});

test('blocked, revoked or signed out: the gate stays shut and a dead sign-in is forgotten', async () => {
  const blocked = make(fakeCloud({ email: { stringValue: 'a@b.c' }, status: { stringValue: 'blocked' } }));
  await blocked.lic.signIn();
  expect(blocked.lic.state().status).toBe('blocked');
  const odd = make(fakeCloud({ email: { stringValue: 'a@b.c' }, status: { stringValue: 'gold' } }));
  await odd.lic.signIn();
  expect(odd.lic.state().status).toBe('blocked'); // an unknown status never unlocks
  const revoked = createLicense({ config, file: blocked.file, seal, openBrowser: () => {}, now: () => NOW, fetch: fakeCloud(null, { refreshRevoked: true }).fetch as typeof fetch, onChange: () => {} });
  await revoked.check();
  expect(revoked.state()).toEqual({ status: 'signed_out' });
  expect(existsSync(blocked.file)).toBe(false);
  const out = make(fakeCloud({ status: { stringValue: 'active' } }));
  await out.lic.signIn();
  out.lic.signOut();
  expect(out.lic.state()).toEqual({ status: 'signed_out' });
  expect(existsSync(out.file)).toBe(false);
});

test('a callback with the wrong state is refused; a new sign-in replaces one left waiting', async () => {
  const cloud = fakeCloud(null);
  let first = '';
  const { lic } = make(cloud, async (u) => { first ||= u; });
  const p1 = lic.signIn();
  await new Promise((r) => setTimeout(r, 50));
  const r = await globalThis.fetch(`${new URL(first).searchParams.get('redirect_uri')}?code=x&state=forged`);
  expect(r.status).toBe(400);
  expect(lic.state().status).toBe('signing_in');
  const p2 = lic.signIn(); // the user pressed the button again: the first wait ends
  await expect(p1).rejects.toMatchObject({ code: 'LICENSE_CANCELLED' });
  await expect(globalThis.fetch(new URL(first).searchParams.get('redirect_uri')!)).rejects.toThrow(); // the old loopback port is closed
  void p2.catch(() => {});
  lic.signOut();
  await expect(p2).rejects.toMatchObject({ code: 'LICENSE_CANCELLED' });
});

test('without a Firebase config nothing is called and the app stays locked', async () => {
  const cloud = fakeCloud(null);
  const lic = createLicense({ config: { apiKey: '', projectId: '', clientId: '', clientSecret: '' }, file: join(mkdtempSync(join(tmpdir(), 'tf-lic-')), 'l.bin'), seal, openBrowser: () => {}, now: () => NOW, fetch: cloud.fetch as typeof fetch, onChange: () => {} });
  await expect(lic.signIn()).rejects.toMatchObject({ code: 'LICENSE_NOT_CONFIGURED' });
  expect(lic.ok()).toBe(false);
  expect(cloud.calls).toEqual([]);
});

test('sign-in turned off: the app is open with no account, and nothing is called', async () => {
  const lic = createOpenLicense();
  expect(lic.ok()).toBe(true);
  expect(lic.state()).toEqual({ status: 'active' });
  await lic.check(); await lic.signIn(); lic.signOut();
  expect(lic.ok()).toBe(true);
});
