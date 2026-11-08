import { test, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/main/db';
import { profile, selfCheck, type Probe } from '../src/main/profile';
import { autoAllowed, autoGate, enableAuto, disableAuto } from '../src/main/account';

const now = Date.now();
const good = (): Probe => ({
  present: Object.fromEntries(Object.keys(profile.selectors).map((k) => [k, true])),
  listeners: 1, sawProjectLoad: true, extVersion: '1.0',
  ping: { xhrSend: true, xhrOpen: true, fetch: true, id: 'o1', seq: 1, dropped: 0, gen: 1, t: now, version: '1.0', email: 'a@x.com' },
});

test('selfCheck ok', () => expect(selfCheck(good())).toEqual({ ok: true }));

test('each drift reason, collected together', () => {
  const p = good(); p.present.editor = false; p.present.submit = false;
  expect(selfCheck(p)).toEqual({ ok: false, code: 'PROTOCOL_DRIFT', reasons: ['selector:editor', 'selector:submit'] });
  const l = good(); l.listeners = 2;
  expect(selfCheck(l)).toEqual({ ok: false, code: 'PROTOCOL_DRIFT', reasons: ['listeners:2'] });
  const l0 = good(); l0.listeners = 0;
  expect(selfCheck(l0)).toMatchObject({ reasons: ['listeners:0'] });
  const h = good(); h.ping.xhrSend = false;
  expect(selfCheck(h)).toEqual({ ok: false, code: 'PROTOCOL_DRIFT', reasons: ['heartbeat:hook_xhr_send'] });
  const n = good(); n.sawProjectLoad = false;
  expect(selfCheck(n)).toEqual({ ok: false, code: 'PROTOCOL_DRIFT', reasons: ['no_project_load'] });
  const all = good(); all.listeners = 3; all.sawProjectLoad = false; all.present.editor = false; all.ping.fetch = false;
  expect(selfCheck(all)).toMatchObject({ reasons: ['selector:editor', 'listeners:3', 'heartbeat:hook_fetch', 'no_project_load'] });
});

test('version mismatch / missing ⇒ RELOAD_TAB, wins over drift', () => {
  const p = good(); p.ping.version = '0.9'; p.listeners = 0; p.sawProjectLoad = false;
  expect(selfCheck(p)).toEqual({ ok: false, code: 'CONFIG_INCOMPLETE', reasons: ['RELOAD_TAB'] });
  const q = good(); delete (q.ping as Partial<typeof q.ping>).version;
  expect(selfCheck(q)).toEqual({ ok: false, code: 'CONFIG_INCOMPLETE', reasons: ['RELOAD_TAB'] });
});

test('drift guard: extension still hardcodes the profile selectors and rpc ids', () => {
  const src = readFileSync(join(__dirname, '../../extension/page-ops.js'), 'utf8').replace(/\\"/g, '"');
  const mw = readFileSync(join(__dirname, '../../extension/main-world.js'), 'utf8');
  // Known gap (extension untouched in P1): P2 closes it by moving these into page-ops.js.
  const missing = Object.entries(profile.selectors).filter(([, s]) => !src.includes(s)).map(([k]) => k);
  expect(missing).toEqual(['tile', 'assetSearch']);
  for (const id of Object.values(profile.rpc)) expect(mw).toContain(id);
});

test('selfCheck requires only idle selectors (selfCheck list)', () => {
  for (const k of profile.selfCheck) expect(Object.keys(profile.selectors)).toContain(k);
  const p = good();
  for (const k of ['creditWarning', 'chip', 'tile', 'assetSearch', 'assetItem', 'clear']) p.present[k] = false;
  expect(selfCheck(p)).toEqual({ ok: true });
  p.present.editor = false;
  expect(selfCheck(p)).toEqual({ ok: false, code: 'PROTOCOL_DRIFT', reasons: ['selector:editor'] });
  const q = good(); q.present = undefined as unknown as Probe['present'];
  expect(selfCheck(q)).toMatchObject({ reasons: ['selector:editor', 'selector:submit'] });
});

test('ping missing / empty versions ⇒ RELOAD_TAB without throwing', () => {
  const reload = { ok: false, code: 'CONFIG_INCOMPLETE', reasons: ['RELOAD_TAB'] };
  for (const v of [undefined, null]) {
    const p = good(); p.ping = v as unknown as Probe['ping'];
    expect(selfCheck(p)).toEqual(reload);
  }
  const e = good(); e.extVersion = ''; expect(selfCheck(e)).toEqual(reload);
  const f = good(); f.ping.version = ''; expect(selfCheck(f)).toEqual(reload);
  const g = good(); g.ping.version = ''; g.extVersion = ''; expect(selfCheck(g)).toEqual(reload);
});

test('account auto switch', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  expect(autoAllowed(db, null)).toBe(false);
  expect(autoAllowed(db, '')).toBe(false);
  expect(autoAllowed(db, 'a@x.com')).toBe(false);
  expect(() => enableAuto(db, ' ', 1)).toThrow();
  expect(() => enableAuto(db, 'a@x.com', 1.5)).toThrow();
  enableAuto(db, 'A@x.com', 123);
  expect(autoAllowed(db, 'a@x.com')).toBe(true);
  expect(autoAllowed(db, ' A@X.com ')).toBe(true);
  expect(autoAllowed(db, 'b@x.com')).toBe(false);
  expect(db.prepare('select ack_at a from account_setting where email=?').get('a@x.com')).toEqual({ a: 123 });
  // fits runner's option via a one-line closure (Task 11 wires it)
  const opt: (e: string | null) => boolean = (e) => autoAllowed(db, e);
  expect(opt('a@x.com')).toBe(true);
  disableAuto(db, 'A@x.com');
  expect(opt('a@x.com')).toBe(false);
  expect(db.prepare('select ack_at a, auto_enabled e from account_setting').get()).toEqual({ a: 123, e: 0 });
  enableAuto(db, 'a@x.com', 456);
  expect(autoAllowed(db, 'a@x.com')).toBe(true);
  expect(db.prepare('select ack_at a from account_setting where email=?').get('a@x.com')).toEqual({ a: 456 });
});

// AC-18: a bad profile blocks, it is never half-used
import { validateProfile } from '../src/main/profile';
const clone = () => JSON.parse(JSON.stringify(profile));
test('validateProfile: good profile passes', () => expect(validateProfile(profile)).toBeNull());
test('validateProfile: missing selector key / wrong type / empty / bad selfCheck / bad rpc', () => {
  const m = clone(); delete m.selectors.tile;
  expect(validateProfile(m)).toContain('tile');
  const t = clone(); t.selectors.editor = 5;
  expect(validateProfile(t)).toContain('editor');
  const e = clone(); e.selectors.submit = '';
  expect(validateProfile(e)).toContain('submit');
  const s = clone(); s.selfCheck = ['editor', 'nope'];
  expect(validateProfile(s)).toContain('nope');
  const r = clone(); delete r.rpc.poll;
  expect(validateProfile(r)).toContain('poll');
  const v = clone(); v.version = 3;
  expect(validateProfile(v)).toContain('version');
  for (const x of [null, 'x', [], {}]) expect(validateProfile(x)).not.toBeNull();
});
test('invalid profile ⇒ CONFIG_INCOMPLETE PROFILE_INVALID, even with a healthy probe', () => {
  const bad = clone(); delete bad.selectors.tile;
  expect(selfCheck(good(), bad)).toEqual({ ok: false, code: 'CONFIG_INCOMPLETE', reasons: ['PROFILE_INVALID:profiles/flow.json'] });
});

test('autoGate: invalid profile or opted-out account ⇒ no auto', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  enableAuto(db, 'a@x.com', 1);
  expect(autoGate(db, 'a@x.com', null)).toBe(true);
  expect(autoGate(db, 'a@x.com', 'selectors')).toBe(false);
  expect(autoGate(db, 'b@x.com', null)).toBe(false);
});

test('validateProfile: combos must be a non-empty array of complete combos', () => {
  for (const bad of [undefined, [], {}, [null], [{}], [{ kind: 'image', mode: 'Image', model: 'm', aspect: '16:9', quality: 'High' }], [{ kind: 'image', mode: 'Image', model: 'm', aspect: '16:9', quality: 'High', count: 0 }], [{ kind: 'image', mode: 'Image', model: '', aspect: '16:9', quality: 'High', count: 2 }], [{ kind: 'image', mode: 'Image', model: 'm', aspect: '16:9', quality: 'High', count: '2' }]]) {
    const c = clone(); c.combos = bad;
    expect(validateProfile(c), JSON.stringify(bad)).toBe('combos');
  }
  const d = clone(); delete d.combos;
  expect(validateProfile(d)).toBe('combos');
});
