import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { OPS, validate, isAllowedDownloadUrl } from '../ops.js';

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
  assert.deepEqual(OPS, ['ping','state','prep','radios','click','fill','hit','trusted','net','file','open','reloadTab','download','downloads','account']);
  for (const bad of ['cdp', 'attach', 'debugger']) assert.ok(!OPS.includes(bad));
});

test('download only https on Flow content hosts', () => {
  for (const u of ['https://flow-content.google/video/x.mp4', 'https://lh3.googleusercontent.com/a?b=1'])
    assert.equal(validate(ok('download', { url: u })), null, u);
  for (const u of ['http://flow-content.google/x', 'https://evil.com/x', 'https://googleusercontent.com.evil.com/x',
    'https://notflow-content.google/x', 'file:///etc/passwd', 'nonsense', undefined])
    assert.ok(validate(ok('download', { url: u })), String(u));
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
