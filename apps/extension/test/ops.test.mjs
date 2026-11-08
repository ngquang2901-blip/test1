import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import '../epoch.js';
const makeEpochTracker = globalThis.makeEpochTracker;
import { OPS, validate, isAllowedDownloadUrl, forwardEvent } from '../ops.js';

const ok = (o, a = {}) => ({ id: 1, epoch: 2, op: o, args: a });

test('validate rejects unknown ops and malformed envelopes', () => {
  assert.ok(validate({ id: 1, epoch: 2, op: 'eval', args: {} }));
  assert.ok(validate({ id: 1, op: 'trusted', args: {} }), 'trusted without epoch');
  assert.ok(validate({ id: 1, epoch: 2, op: 'ping', args: 'x' }));
  assert.ok(validate({ id: 1, epoch: 2, op: 'ping', args: null }));
  assert.ok(validate({ epoch: 2, op: 'ping', args: {} }), 'missing id');
  assert.ok(validate(null));
  assert.equal(validate(ok('ping')), null);
});

test('OPS is the exact allowlist, no debugger-style ops', () => {
  assert.deepEqual(OPS, ['ping','state','prep','radios','click','fill','hit','trusted','net','file','open','reloadTab','download','downloads','account','arm','tabs','probe']);
  for (const bad of ['cdp', 'attach', 'debugger']) assert.ok(!OPS.includes(bad));
});

test('download only https on Flow content hosts', () => {
  for (const u of ['https://flow-content.google/video/x.mp4', 'https://lh3.googleusercontent.com/a?b=1'])
    assert.equal(validate(ok('download', { url: u })), null, u);
  for (const u of ['http://flow-content.google/x', 'https://evil.com/x', 'https://googleusercontent.com.evil.com/x',
    'https://notflow-content.google/x', 'https://flow-content.google.evil.com', 'https://x.googleusercontent.com.evil.com', 'https://flow-content.google' + '@evil.com/x', 'file:///etc/passwd', 'nonsense', undefined])
    assert.ok(validate(ok('download', { url: u })), String(u));
  assert.equal(isAllowedDownloadUrl('https://FLOW-CONTENT.google/x'), true);
  assert.equal(isAllowedDownloadUrl('https://a.b.googleusercontent.com/x'), true);
});

test('open only https://flow.google.com', () => {
  assert.equal(validate(ok('open', { url: 'https://flow.google.com/project/1' })), null);
  assert.ok(validate(ok('open', { url: 'https://evil.com/' })));
});

test('manifest: no debugger, exact permissions, key matches EXT_ID', () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(m.permissions, ['tabs', 'scripting', 'downloads', 'alarms']);
  const der = Buffer.from(m.key, 'base64');
  const id = createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  const ts = readFileSync(new URL('../../desktop/src/main/connector/ext-id.ts', import.meta.url), 'utf8');
  assert.equal(/EXT_ID = '([a-p]{32})'/.exec(ts)?.[1], id);
});

test('forwardEvent keeps own epoch; no epoch => not forwarded', () => {
  const m = forwardEvent(7, { type: 'sent', epoch: 3, request: 'r' });
  assert.deepEqual(m, { type: 'sent', tabId: 7, epoch: 3, request: 'r' });
  assert.deepEqual(forwardEvent(7, { type: 'response', epoch: 4, rpc: 'ogiZ0b', text: 't', request: 'r' }),
    { type: 'response', tabId: 7, epoch: 4, rpc: 'ogiZ0b', text: 't', request: 'r' });
  assert.equal(forwardEvent(7, { type: 'sent', request: 'r' }), null);
  assert.equal(forwardEvent(7, { type: 'sent', epoch: '3' }), null);
  assert.equal(forwardEvent(7, null), null);
});

test('epoch tracker: one epoch per click, ambiguity fails closed', () => {
  let t = makeEpochTracker();
  t.submit(5, true); assert.equal(t.send(), 5, 'click then send');
  assert.equal(t.send(), undefined, 'second send after one click');
  t = makeEpochTracker(); t.submit(5, true); t.submit(6, true);
  assert.equal(t.send(), undefined, 'two clicks before send: first');
  assert.equal(t.send(), undefined, 'two clicks before send: second');
  t = makeEpochTracker(); assert.equal(t.send(), undefined, 'send without click');
  t = makeEpochTracker(); t.submit(5, false); assert.equal(t.send(), undefined, 'uncalled submit does not arm');
  t = makeEpochTracker(); t.submit(5, true); t.submit(6, false); assert.equal(t.send(), 5, 'uncalled submit changes nothing');
  t = makeEpochTracker(); t.submit(5, true); t.send(); t.submit(6, true); assert.equal(t.send(), 6, 'next click after a send');
});

test('arm: tracker binds the user\'s send to the armed epoch, clear disarms, arming twice is ambiguous', () => {
  let t = makeEpochTracker(); t.submit(7, true); assert.equal(t.send(), 7, 'armed send carries the epoch');
  t = makeEpochTracker(); t.submit(7, true); t.clear(); assert.equal(t.send(), undefined, 'cleared: dropped');
  t = makeEpochTracker(); t.clear(); assert.equal(t.send(), undefined, 'clear while idle');
  t = makeEpochTracker(); t.submit(7, true); t.submit(8, true); assert.equal(t.send(), undefined, 'arm while pending is ambiguous');
  t = makeEpochTracker(); t.submit(7, true); t.clear(); t.submit(8, true); assert.equal(t.send(), 8, 're-arm after clear');
});

test('tracker counts every generate send (gen), ours or not, armed or not', () => {
  const t = makeEpochTracker();
  assert.equal(t.gen, 0);
  t.send(); t.submit(5, true); t.send(); t.submit(6, true); t.submit(7, true); t.send(); t.clear(); t.send();
  assert.equal(t.gen, 4);
});

test('validate arm: integer epoch or explicit null', () => {
  assert.equal(validate(ok('arm', { epoch: 5, tabId: 1 })), null);
  assert.equal(validate(ok('arm', { epoch: null, tabId: 1 })), null);
  for (const a of [{}, { epoch: '5' }, { epoch: 1.5 }, { epoch: undefined }, { tabId: 1 }]) assert.ok(validate(ok('arm', a)), JSON.stringify(a));
});

test('main-world fetch hook counts generate RPCs in gen (and only those)', async () => {
  class ET { addEventListener(t, l) { (this.h ??= {})[t] = l; } removeEventListener() {} dispatchEvent(e) { this.h?.[e.type]?.(e); } }
  const document = new ET(); document.querySelector = () => null;
  const win = { fetch: async () => ({ status: 200, clone: () => ({ text: async () => '' }) }) };
  const ctx = vm.createContext({ window: win, document, EventTarget: ET, HTMLButtonElement: class {}, XMLHttpRequest: class { open() {} send() {} },
    crypto: { randomUUID: () => 'u' }, CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o.detail; } }, globalThis: undefined });
  ctx.globalThis = ctx; vm.runInContext(readFileSync(new URL('../epoch.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(readFileSync(new URL('../main-world.js', import.meta.url), 'utf8'), ctx);
  let gen; document.addEventListener('toolflow:ping-result', (e) => { gen = JSON.parse(e.detail).gen; });
  const gens = async () => { document.dispatchEvent({ type: 'toolflow:ping' }); return gen; };
  assert.equal(await gens(), 0);
  await win.fetch('https://x/batchexecute?rpcids=ogiZ0b'); assert.equal(await gens(), 1, 'fetch generate');
  await win.fetch('https://x/batchexecute?rpcids=MZZa6b'); assert.equal(await gens(), 2);
  await win.fetch('https://x/batchexecute?rpcids=jwpduf'); assert.equal(await gens(), 2, 'non-generate rpc');
});

test('probe needs a selectors map of strings; tabs takes no args', () => {
  assert.equal(validate(ok('probe', { tabId: 1, selectors: { editor: 'a b' } })), null);
  for (const bad of [{}, { selectors: [] }, { selectors: { x: 1 } }, { selectors: { x: 'a'.repeat(300) } }, { selectors: 'x' }])
    assert.ok(validate(ok('probe', { tabId: 1, ...bad })), JSON.stringify(bad));
  assert.equal(validate(ok('tabs')), null);
});
