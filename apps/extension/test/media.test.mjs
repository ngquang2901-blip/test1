import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../media-logic.js';
import { isAllowedDownloadUrl } from '../ops.js';
const M = globalThis.TFMedia;

// The real project listing (Zzl0ze) of the capture fixtures. Its content urls were cut out at capture time, so the test puts a
// made-up token in each (the layout is the real one: entry[5][5] is the content url, entry[7] exists for a video).
const record = JSON.parse(readFileSync(new URL('../../../packages/flow-protocol/test/fixtures/project-Zzl0ze.json', import.meta.url), 'utf8')).records.find((r) => r.phase === 'done');
const frames = (text) => text.split('\n').filter((l) => l[0] === '[').map((l) => JSON.parse(l));
const payload = JSON.parse(frames(record.res)[0].find((f) => f[1] === 'Zzl0ze')[2]);
const tok = (i) => `AbC-dEf_${String(i).padStart(4, '0')}${'x'.repeat(40)}`;
payload[2].forEach((e, i) => { if (Array.isArray(e[5])) e[5][5] = `https://lh3.googleusercontent.com/asb/${tok(i)}${i % 2 ? '=w400-h300' : ''}`; }); // measured live: /asb/<token>, with or without a size suffix
const envelope = (rpc, p) => `)]}'\n\n123\n${JSON.stringify([['wrb.fr', rpc, JSON.stringify(p), null, null, null, 'generic'], ['di', 12]])}\n25\n[["e",4,null,null,99]]\n`;
const videos = payload[2].map((e, i) => [e, i]).filter(([e]) => Array.isArray(e[7]));

test('listing: every video media gets its token; images and uploads are left out', () => {
  assert.ok(videos.length > 0 && videos.length < payload[2].length, 'the fixture has videos and other media');
  assert.deepEqual(M.videoTokens(envelope('Zzl0ze', payload), 'Zzl0ze'), videos.map(([e, i]) => [e[0], tok(i)]));
});

test('as29s: the answer is one media entry in the same layout', () => {
  const [e, i] = videos[0];
  assert.deepEqual(M.videoTokens(envelope('as29s', e), 'as29s'), [[e[0], tok(i)]]);
  const image = payload[2].find((x) => !Array.isArray(x[7]));
  assert.deepEqual(M.videoTokens(envelope('as29s', image), 'as29s'), []);
  assert.deepEqual(M.videoTokens(envelope('as29s', e), 'Zzl0ze'), [], 'read as the rpc it is, never guessed');
});

test('anything that is not a plain token on the content host teaches nothing', () => {
  const [e] = videos[0];
  const withUrl = (u) => { const c = structuredClone(e); c[5][5] = u; return M.videoTokens(envelope('as29s', c), 'as29s'); };
  for (const u of ['https://evil.example/asb/AbCdEfGhIjKlMnOpQrStUvWxYz=w1', 'http://lh3.googleusercontent.com/asb/AbCdEfGhIjKlMnOpQrStUvWxYz', 'https://lh3.googleusercontent.com/asb/a/../../x', 'https://lh3.googleusercontent.com/asb/AbCdEfGhIjKlMnOp%2F..%2Fx',
    'https://lh3.googleusercontent.com.evil.example/asb/AbCdEfGhIjKlMnOpQrStUvWxYz', 'https://lh3.googleusercontent.com/asb/short', 'https://lh3.googleusercontent.com/asb/AbCdEfGhIjKlMnOpQrStUvWxYz/extra',
    'https://lh3.googleusercontent.com/AbCdEfGhIjKlMnOpQrStUvWxYz', 'https://lh3.googleusercontent.com/other/AbCdEfGhIjKlMnOpQrStUvWxYz', null, 7])
    assert.deepEqual(withUrl(u), [], String(u));
  for (const text of ['', 'not json', ")]}'\n\n[[\"wrb.fr\",\"as29s\",\"{broken\"]]", envelope('as29s', null), envelope('as29s', [e[0]])]) assert.deepEqual(M.videoTokens(text, 'as29s'), []);
});

test('the MP4 address of a token is one the download op accepts', () => {
  const url = M.mp4(tok(1));
  assert.equal(url, `https://flow.google.com/asb/${tok(1)}=mm,22,15`); // measured in the spike: the thumbnail address with this suffix is the MP4
  assert.equal(isAllowedDownloadUrl(url), true);
});
