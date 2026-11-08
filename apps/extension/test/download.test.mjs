import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { OPS, validate, shapeDownload, fetchMediaOp, downloadsOp, validTmpName } from '../ops.js';

const ID = '3f2b9c1e-1111-4222-8333-444455556666';
const SRC = 'https://flow-content.google/image/3f2b9c1e?sig=SECRETSIG';
const env = (o) => ({ id: 1, epoch: 2, op: o[0], args: o[1] });

test('allowlist: the raw-url download op is gone; locate, fetchMedia and downloads are in', () => {
  assert.ok(!OPS.includes('download'));
  for (const op of ['locate', 'fetchMedia', 'downloads']) assert.ok(OPS.includes(op), op);
  assert.match(validate(env(['download', { url: SRC, filename: 'x' }])), /op not allowed/);
});

test('validate: locate / fetchMedia / downloads arguments', () => {
  assert.equal(validate(env(['locate', { tabId: 1, mediaId: ID }])), null);
  assert.equal(validate(env(['fetchMedia', { tabId: 1, mediaId: ID, filename: `${ID}_${ID}.bin` }])), null);
  for (const a of [{ tabId: 1 }, { mediaId: ID }, { tabId: 1, mediaId: 'a"] , img[x' }, { tabId: 1, mediaId: ID.toUpperCase() + 'x' }, { tabId: '1', mediaId: ID }])
    assert.ok(validate(env(['locate', a])), JSON.stringify(a));
  for (const filename of ['../x.bin', 'a/b.bin', 'a\\b.bin', '..', '.hidden', '', 'x'.repeat(121), 'C:x', undefined])
    assert.ok(validate(env(['fetchMedia', { tabId: 1, mediaId: ID, filename }])), String(filename));
  assert.ok(validate(env(['fetchMedia', { tabId: 1, mediaId: ID, url: SRC }])), 'no filename');
  assert.equal(validate(env(['downloads', { id: 5 }])), null);
  assert.equal(validate(env(['downloads', { filenamePrefix: `${ID}_${ID}` }])), null);
  for (const a of [{}, { id: '5' }, { filenamePrefix: '../' }, { filenamePrefix: '' }, { query: { limit: 5 } }])
    assert.ok(validate(env(['downloads', a])), JSON.stringify(a));
  assert.equal(validTmpName('ok-1_2.bin'), true);
  assert.equal(validTmpName('a..b.bin'), false);
});

test('shapeDownload keeps the five fields and drops every url', () => {
  const r = shapeDownload({ id: 4, state: 'complete', filename: '/home/u/Downloads/ToolFlow-tmp/x.bin', fileSize: 12, mime: 'image/png', error: undefined, url: SRC, finalUrl: SRC, referrer: SRC });
  assert.deepEqual(r, { id: 4, state: 'complete', filename: '/home/u/Downloads/ToolFlow-tmp/x.bin', fileSize: 12, mime: 'image/png', error: null });
  assert.ok(!JSON.stringify(r).includes('http'));
  assert.equal(shapeDownload({ id: 1, state: 'interrupted', error: 'NETWORK_FAILED' }).error, 'NETWORK_FAILED');
});

function chromeFake({ reply, downloadId = 7, search = [] } = {}) {
  const calls = { sent: [], download: [], search: [] };
  return { calls, tabs: { sendMessage: async (tab, m) => { calls.sent.push([tab, m]); if (reply instanceof Error) throw reply; return reply; } },
    downloads: { download: async (o) => { calls.download.push(o); if (downloadId instanceof Error) throw downloadId; return downloadId; }, search: async (q) => { calls.search.push(q); return search; } } };
}

test('fetchMedia: asks the tab for the src internally, downloads into ToolFlow-tmp, the url never comes back', async () => {
  const c = chromeFake({ reply: { src: SRC } });
  const r = await fetchMediaOp(c, { tabId: 3, mediaId: ID, filename: 'a_b.bin' });
  assert.deepEqual(r, { ok: true, downloadId: 7 });
  assert.deepEqual(c.calls.sent, [[3, { tf: 'src', mediaId: ID }]]);
  assert.deepEqual(c.calls.download, [{ url: SRC, filename: 'ToolFlow-tmp/a_b.bin', conflictAction: 'uniquify' }]);
  assert.ok(!JSON.stringify(r).includes('SECRETSIG'));
});

test('fetchMedia failures return codes only (no url, no message)', async () => {
  const a = { tabId: 3, mediaId: ID, filename: 'a.bin' };
  assert.deepEqual(await fetchMediaOp(chromeFake({ reply: { code: 'AMBIGUOUS' } }), a), { ok: false, code: 'AMBIGUOUS' });
  assert.deepEqual(await fetchMediaOp(chromeFake({ reply: { code: 'NOT_FOUND' } }), a), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await fetchMediaOp(chromeFake({ reply: new Error('no receiver ' + SRC) }), a), { ok: false, code: 'NO_CONTENT_SCRIPT' });
  const evil = chromeFake({ reply: { src: 'https://evil.example/x.png' } });
  assert.deepEqual(await fetchMediaOp(evil, a), { ok: false, code: 'SRC_NOT_ALLOWED' });
  assert.equal(evil.calls.download.length, 0, 'a foreign host is never fetched');
  const refused = await fetchMediaOp(chromeFake({ reply: { src: SRC }, downloadId: new Error('Invalid URL ' + SRC) }), a);
  assert.deepEqual(refused, { ok: false, code: 'DOWNLOAD_REFUSED' });
  assert.deepEqual(await fetchMediaOp(chromeFake({ reply: { src: SRC }, downloadId: null }), a), { ok: false, code: 'DOWNLOAD_REFUSED' });
});

test('downloads op: by id or by tmp-folder prefix; results are shaped', async () => {
  const raw = [{ id: 9, state: 'in_progress', filename: '/d/ToolFlow-tmp/p.bin', fileSize: -1, mime: '', url: SRC, finalUrl: SRC }];
  let c = chromeFake({ search: raw });
  assert.deepEqual(await downloadsOp(c, { id: 9 }), [{ id: 9, state: 'in_progress', filename: '/d/ToolFlow-tmp/p.bin', fileSize: -1, mime: '', error: null }]);
  assert.deepEqual(c.calls.search, [{ id: 9 }]);
  c = chromeFake({ search: raw });
  await downloadsOp(c, { filenamePrefix: 'a.b_c' });
  assert.equal(new RegExp(c.calls.search[0].filenameRegex).test('/d/ToolFlow-tmp/a.b_c (1).bin'), true);
  assert.equal(new RegExp(c.calls.search[0].filenameRegex).test('/d/ToolFlow-tmp/aXb_c.bin'), false, 'the dot is literal');
  assert.equal(new RegExp(c.calls.search[0].filenameRegex).test('/d/Other/a.b_c.bin'), false);
});

// ---- page-ops.js: locate / src against a fake DOM ----
function page(imgs) {
  let listener;
  const document = {
    createElement: () => ({}), documentElement: { append() {} }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, body: { innerText: '' },
    querySelector: () => null,
    querySelectorAll: (sel) => { const m = /^img\[data-media-id="([^"]*)"\]$/.exec(sel); return m ? imgs.filter((i) => i.id === m[1]) : []; },
  };
  const ctx = vm.createContext({ document, CSS: { escape: (s) => s }, chrome: { runtime: { id: 'me', getManifest: () => ({ version: 't' }), onMessage: { addListener: (f) => { listener = f; } }, sendMessage: async () => {} } }, setTimeout, clearTimeout, Date, JSON, Promise, Set });
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.runInContext(readFileSync(new URL('../page-ops.js', import.meta.url), 'utf8'), ctx);
  const ask = (m, sender = { id: 'me' }) => new Promise((res) => { const keep = listener(m, sender, (r) => res(JSON.parse(JSON.stringify(r)))); if (!keep) setTimeout(() => res('no-reply'), 20); });
  return { op: (op, args) => ask({ tf: 'op', op, args }), src: (mediaId, sender) => ask({ tf: 'src', mediaId }, sender) };
}
const img = (id, extra = {}) => ({ id, src: SRC, naturalWidth: 1024, naturalHeight: 768, complete: true, ...extra });

test('locate: exactly one tile; reports size only, never the url', async () => {
  const p = page([img(ID), img('aaaaaaaa-1111-4222-8333-444455556666')]);
  const r = await p.op('locate', { tabId: 1, mediaId: ID });
  assert.deepEqual(r, { result: { ok: true, w: 1024, h: 768, complete: true } });
  assert.deepEqual(Object.keys(r.result).sort(), ['complete', 'h', 'ok', 'w']);
  assert.ok(!JSON.stringify(r).includes('http') && !JSON.stringify(r).includes('SECRETSIG'));
});

test('locate: NOT_FOUND, AMBIGUOUS, bad id', async () => {
  assert.deepEqual((await page([]).op('locate', { tabId: 1, mediaId: ID })).result, { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual((await page([img(ID), img(ID)]).op('locate', { tabId: 1, mediaId: ID })).result, { ok: false, code: 'AMBIGUOUS' });
  assert.deepEqual((await page([img(ID)]).op('locate', { tabId: 1, mediaId: 'x"] img' })).result, { ok: false, code: 'BAD_ID' });
});

test('internal src message: only from our own extension, only for exactly one tile', async () => {
  assert.deepEqual(await page([img(ID)]).src(ID), { src: SRC });
  assert.deepEqual(await page([img(ID), img(ID)]).src(ID), { code: 'AMBIGUOUS' });
  assert.deepEqual(await page([]).src(ID), { code: 'NOT_FOUND' });
  assert.deepEqual(await page([img(ID, { src: '' })]).src(ID), { code: 'NOT_FOUND' });
  assert.equal(await page([img(ID)]).src(ID, { id: 'someone-else' }), 'no-reply');
});

test('wiring: sw.js routes locate to the page and fetchMedia/downloads to ops.js; src is not an op', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /PAGE_OPS = new Set\([^)]*'locate'/);
  assert.match(sw, /case 'fetchMedia': return fetchMediaOp\(chrome/);
  assert.match(sw, /case 'downloads': return downloadsOp\(chrome/);
  assert.ok(!/case 'download':/.test(sw));
  assert.ok(!OPS.includes('src'));
});
