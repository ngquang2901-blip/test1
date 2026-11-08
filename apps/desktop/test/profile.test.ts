import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/main/db';
import { profile, selfCheck, type Probe } from '../src/main/profile';
import { autoAllowed, enableAuto, disableAuto } from '../src/main/account';

const now = Date.now();
const good = (): Probe => ({
  present: Object.fromEntries(Object.keys(profile.selectors).map((k) => [k, true])),
  listeners: 1, sawProjectLoad: true, extVersion: '1.0',
  ping: { xhrSend: true, xhrOpen: true, fetch: true, id: 'o1', seq: 1, dropped: 0, gen: 1, t: now, version: '1.0', email: 'a@x.com' },
});
const drift = (p: Probe) => selfCheck(p);

test('selfCheck ok', () => expect(selfCheck(good())).toEqual({ ok: true }));

test('each drift reason, collected together', () => {
  const p = good(); delete p.present.tile; p.present.submit = false;
  expect(drift(p)).toEqual({ ok: false, code: 'PROTOCOL_DRIFT', reasons: ['selector:submit', 'selector:tile'] });
  const l = good(); l.listeners = 2;
  expect(drift(l)).toEqual({ ok: false, code: 'PROTOCOL_DRIFT', reasons: ['listeners:2'] });
  const l0 = good(); l0.listeners = 0;
  expect(drift(l0)).toMatchObject({ reasons: ['listeners:0'] });
  const h = good(); h.ping.xhrSend = false;
  expect(drift(h)).toEqual({ ok: false, code: 'PROTOCOL_DRIFT', reasons: ['heartbeat:hook_xhr_send'] });
  const n = good(); n.sawProjectLoad = false;
  expect(drift(n)).toEqual({ ok: false, code: 'PROTOCOL_DRIFT', reasons: ['no_project_load'] });
  const all = good(); all.listeners = 3; all.sawProjectLoad = false; all.present.editor = false; all.ping.fetch = false;
  expect(drift(all)).toMatchObject({ reasons: ['selector:editor', 'listeners:3', 'heartbeat:hook_fetch', 'no_project_load'] });
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
  // Known gap (reported, extension untouched in P1): not yet in page-ops.js.
  const missing = Object.entries(profile.selectors).filter(([, s]) => !src.includes(s)).map(([k]) => k);
  expect(missing).toEqual(['clear', 'tile', 'assetSearch']);
  for (const id of Object.values(profile.rpc)) expect(mw).toContain(id);
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
});
