import test from 'node:test';
import assert from 'node:assert/strict';
import '../gem-logic.js';
import { OPS, validate, gemFetchOp } from '../ops.js';
const G = globalThis.TFGem;

const TURN = '9ab3cde45f01a2b7', CONV = '0c1d2e3f4a5b6c7d';

test('a query is ours only when its text is exactly the prompt (whitespace aside)', () => {
  const p = 'a single ripe mango on a white plate';
  assert.equal(G.ownsQuery(p, p), true);
  assert.equal(G.ownsQuery(`  ${p.replace(/ /g, '\u00a0 ')}\n`, p), true);
  assert.equal(G.ownsQuery(p + p, p), false); // a draft the page restored in front of ours (seen live)
  assert.equal(G.ownsQuery(`please ${p}`, p), false);
  assert.equal(G.ownsQuery('', ''), false);
});

test('media id: turn id + image number, and back; anything else is refused', () => {
  assert.equal(G.mediaId(TURN, 2), `${TURN}-2`);
  assert.deepEqual(G.parseMediaId(`${TURN}-2`), { turn: TURN, n: 2 });
  for (const bad of [TURN, `${TURN}-0`, `${TURN}-100`, `${TURN}-1/..`, `r_${TURN}-1`, '6af47c4e-cf14-83ec-9fd1-7ccae249b4ef-1', '', null]) assert.equal(G.parseMediaId(bad), null);
});

test('conversation id from the path: /app/<hex> only', () => {
  assert.equal(G.convOf(`/app/${CONV}`), CONV);
  for (const p of ['/app', '/app/', `/app/${CONV}/x`, `/gem/${CONV}`, '/app/../x', '']) assert.equal(G.convOf(p), null);
});

test('a download is Gemini\'s own only as measured: a blob, an image, named Gemini_Generated_Image_…', () => {
  const own = { referrer: '', url: 'blob:null/1b2c3d', mime: 'image/png', filename: 'Gemini_Generated_Image_6l02yb6l02yb6l02.png' };
  assert.equal(G.isGeminiDownload(own), true);
  assert.equal(G.isGeminiDownload({ ...own, filename: '/home/u/Downloads/Gemini_Generated_Image_abc.jpg', mime: 'image/jpeg' }), true);
  for (const it of [{ ...own, url: 'https://evil.example/Gemini_Generated_Image_x.png' }, { ...own, mime: 'text/html' }, { ...own, mime: 'application/zip' }, { ...own, filename: 'holiday.png' }, { ...own, filename: 'x/Gemini_Generated_Image_/holiday.png' }, { url: 'blob:https://chatgpt.com/1', mime: 'image/png', filename: 'image.png' }, {}])
    assert.equal(G.isGeminiDownload(it), false, JSON.stringify(it));
});

test('validate: the Gemini ops take a tab, and a prompt / conversation / media id of the right shape', () => {
  const m = (op, args) => validate({ id: 1, epoch: 1, op, args });
  for (const op of ['gemTabs', 'gemNew', 'gemOpen', 'gemLook', 'gemState', 'gemMode', 'gemPrep', 'gemSend', 'gemTurns', 'gemFetch']) assert.ok(OPS.includes(op), op);
  for (const op of ['gemMenu', 'gemTool', 'gemArea', 'gemConv']) assert.ok(!OPS.includes(op), `spike op ${op} is gone`);
  assert.equal(m('gemTabs', {}), null);
  assert.equal(m('gemPrep', { tabId: 3, prompt: 'a cat' }), null);
  assert.match(m('gemSend', { tabId: 3 }), /prompt/);
  assert.match(m('gemState', {}), /tabId/);
  assert.equal(m('gemOpen', { tabId: 3, conv: CONV }), null);
  assert.match(m('gemOpen', { tabId: 3, conv: '../x' }), /conversation/);
  assert.equal(m('gemFetch', { tabId: 3, mediaId: `${TURN}-1`, filename: 'a_b.bin' }), null);
  assert.match(m('gemFetch', { tabId: 3, mediaId: TURN, filename: 'a_b.bin' }), /gemFetch/);
  assert.match(m('gemFetch', { tabId: 3, mediaId: `${TURN}-1`, filename: '../a.bin' }), /gemFetch/);
});

// a Chrome whose page click starts a download a moment later
const chromeWith = (o) => {
  const calls = [], names = new Set();
  const fire = (item) => { let s; for (const l of names) l(item, (x) => { s = x; }); return s; };
  return { calls, fire, names,
    tabs: { get: async () => ({ url: o.url ?? 'https://gemini.google.com/app/x' }),
      sendMessage: async (tabId, msg) => { calls.push(['msg', tabId, msg]); if (o.throws) throw new Error('no receiver'); if (o.reply?.ok && o.item) setTimeout(() => calls.push(['suggest', fire(o.item)]), 5); return o.reply; } },
    downloads: { onDeterminingFilename: { addListener: (l) => names.add(l), removeListener: (l) => names.delete(l) } } };
};
const ITEM = { id: 31, referrer: '', url: 'blob:null/1b2c3d', mime: 'image/png', filename: 'Gemini_Generated_Image_6l02yb6l02yb6l02.png' };

test('gemFetch: the page presses its own full-size download; that download is named into ToolFlow-tmp and its id comes back; no listener is left behind', async () => {
  const c = chromeWith({ reply: { ok: true }, item: ITEM });
  assert.deepEqual(await gemFetchOp(c, { tabId: 3, mediaId: `${TURN}-1`, filename: 'att_med.bin' }, 500), { ok: true, downloadId: 31 });
  assert.deepEqual(c.calls[0], ['msg', 3, { tf: 'gemDownload', mediaId: `${TURN}-1` }]);
  assert.deepEqual(c.calls[1], ['suggest', { filename: 'ToolFlow-tmp/att_med.bin', conflictAction: 'uniquify' }]);
  assert.equal(c.names.size, 0);
});

test('gemFetch: a download from somewhere else while waiting keeps its own name; no download in time is DOWNLOAD_NOT_STARTED', async () => {
  const c = chromeWith({ reply: { ok: true }, item: { id: 9, referrer: 'https://other.example/', url: 'https://other.example/file.zip', mime: 'application/zip', filename: 'file.zip' } });
  assert.deepEqual(await gemFetchOp(c, { tabId: 3, mediaId: `${TURN}-1`, filename: 'att_med.bin' }, 60), { ok: false, code: 'DOWNLOAD_NOT_STARTED', seen: ['https://other.example https://other.example application/zip aaaa.aaa'] }); // where it came from: host only
  assert.deepEqual(c.calls[1], ['suggest', undefined]); // the user's own download was not renamed
  assert.equal(c.names.size, 0);
});

test('gemFetch: refuses a tab that is not Gemini; a missing image is NOT_FOUND and nothing waits', async () => {
  const a = { tabId: 3, mediaId: `${TURN}-1`, filename: 'att_med.bin' };
  const other = chromeWith({ url: 'https://chatgpt.com/c/x', reply: { ok: true } });
  assert.deepEqual(await gemFetchOp(other, a, 60), { ok: false, code: 'NOT_GEMINI_TAB' });
  assert.equal(other.calls.length, 0);
  assert.deepEqual(await gemFetchOp(chromeWith({ reply: { code: 'NOT_FOUND' } }), a, 60), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await gemFetchOp(chromeWith({ throws: true }), a, 60), { ok: false, code: 'NO_CONTENT_SCRIPT' });
});

test('gemFetch: two requests at once run one after the other, so each download gets its own name', async () => {
  const order = [];
  const mk = (id, name) => { const c = chromeWith({ reply: { ok: true }, item: { ...ITEM, id } }); const send = c.tabs.sendMessage; c.tabs.sendMessage = async (...x) => { order.push(`start ${name}`); return send(...x); }; return c; };
  const a = mk(1, 'a'), b = mk(2, 'b');
  const [ra, rb] = await Promise.all([gemFetchOp(a, { tabId: 3, mediaId: `${TURN}-1`, filename: 'a.bin' }, 500).then((r) => { order.push('done a'); return r; }), gemFetchOp(b, { tabId: 3, mediaId: `${TURN}-2`, filename: 'b.bin' }, 500).then((r) => { order.push('done b'); return r; })]);
  assert.deepEqual([ra, rb], [{ ok: true, downloadId: 1 }, { ok: true, downloadId: 2 }]);
  assert.deepEqual(order, ['start a', 'done a', 'start b', 'done b']);
});
