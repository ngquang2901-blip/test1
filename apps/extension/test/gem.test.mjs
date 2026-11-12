import test from 'node:test';
import assert from 'node:assert/strict';
import '../gem-logic.js';
import { OPS, validate, gemFetchOp } from '../ops.js';
const G = globalThis.TFGem;

const TURN = '9ab3cde45f01a2b7', CONV = '0c1d2e3f4a5b6c7d';
const FULL = 'https://lh3.googleusercontent.com/rd-gg/AbC-dEf_0123456789=s0-d-I?alr=yes'; // the shape measured; the real one is ~1450 chars

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

test('a turn is finished when the page is idle and it shows its action row; a turn with no image at all is finished as soon as the page is idle (seen live: an answer that stayed empty)', () => {
  const idle = { waiting: false, busy: false, generating: false };
  assert.equal(G.turnDone({ ...idle, actions: true, imageEls: 1 }), true);
  assert.equal(G.turnDone({ ...idle, actions: false, imageEls: 1 }), false); // an image is there but the page has not closed the answer: more may come
  assert.equal(G.turnDone({ ...idle, actions: false, imageEls: 0 }), true); // empty answer, nothing running: the runner's own waits decide what it means
  assert.equal(G.turnDone({ ...idle, actions: true, imageEls: 0 }), true); // a text answer
  for (const k of ['waiting', 'busy', 'generating']) for (const actions of [true, false]) assert.equal(G.turnDone({ ...idle, [k]: true, actions, imageEls: 0 }), false, k);
});

test('conversation id from the path: /app/<hex> only', () => {
  assert.equal(G.convOf(`/app/${CONV}`), CONV);
  for (const p of ['/app', '/app/', `/app/${CONV}/x`, `/gem/${CONV}`, '/app/../x', '']) assert.equal(G.convOf(p), null);
});

test('the page\'s own copy of a download is known as measured: a blob, an image, named Gemini_Generated_Image_…', () => {
  const own = { referrer: '', url: 'blob:null/1b2c3d', mime: 'image/png', filename: 'Gemini_Generated_Image_6l02yb6l02yb6l02.png' };
  assert.equal(G.isGeminiDownload(own), true);
  assert.equal(G.isGeminiDownload({ ...own, filename: '/home/u/Downloads/Gemini_Generated_Image_abc.jpg', mime: 'image/jpeg' }), true);
  for (const it of [{ ...own, url: 'https://evil.example/Gemini_Generated_Image_x.png' }, { ...own, mime: 'text/html' }, { ...own, mime: 'application/zip' }, { ...own, filename: 'holiday.png' }, { ...own, filename: 'x/Gemini_Generated_Image_/holiday.png' }, { url: 'blob:https://chatgpt.com/1', mime: 'image/png', filename: 'image.png' }, {}])
    assert.equal(G.isGeminiDownload(it), false, JSON.stringify(it));
});

test('the full-size file is the big thing the page fetched from Google\'s image host under /rd-gg/ (a reopened conversation) or /rd-gg-dl/ (an image just made), nothing else', () => {
  assert.equal(G.isFullSizeUrl(FULL), true);
  assert.equal(G.isFullSizeUrl('https://lh3.googleusercontent.com/rd-gg-dl/AbC-dEf_0123456789=s0-d-I?alr=yes'), true);
  assert.equal(G.isFullSizeUrl('https://lh3.googleusercontent.com/rd-gg-other/abc=s0-d-I'), false);
  // measured: the 1024 px preview comes from the same place and is big too; only its size option differs
  for (const tail of ['=s1024-rw', '=s2048-rw', '=d-I', '=s0', '=s0-rw', '', '=s0-d-I/x']) assert.equal(G.isFullSizeUrl(`https://lh3.googleusercontent.com/rd-gg-dl/AbC-dEf_0123456789${tail}?alr=yes`), false, tail);
  assert.equal(G.isFullSizeUrl('https://lh3.googleusercontent.com/rd-gg-dl/AbC=s0-d?alr=yes'), true);
  assert.equal(G.isFullSize({ name: 'https://lh3.googleusercontent.com/rd-gg-dl/AbC=s1024-rw?alr=yes', encodedBodySize: 648928 }), false);
  assert.equal(G.isFullSizeUrl('https://work.fife.usercontent.google.com/rd-gg-dl/abc'), false); // a step on the way
  assert.equal(G.isFullSizeUrl('https://lh3.googleusercontent.com/gg-dl/abc'), false);
  assert.equal(G.isFullSizeUrl('https://lh5.googleusercontent.com/rd-gg/abc=s0-d-I'), true);
  for (const u of ['http://lh3.googleusercontent.com/rd-gg/abc=s0-d-I', 'https://lh3.google.com/rd-gg/abc=s0-d-I?alr=yes', 'https://lh3.googleusercontent.com/gg/abc=d-I?alr=yes', 'https://lh3.googleusercontent.com.evil.example/rd-gg/abc=s0-d-I', 'https://evil.example/rd-gg/abc=s0-d-I', 'https://user@lh3.googleusercontent.com/rd-gg/abc=s0-d-I', 'https://lh3.googleusercontent.com:8443/rd-gg/abc=s0-d-I', 'blob:https://gemini.google.com/1', 'data:image/png;base64,AAAA', '', null, 5])
    assert.equal(G.isFullSizeUrl(u), false, String(u));
  assert.equal(G.isFullSize({ name: FULL, encodedBodySize: 9205714 }), true);
  assert.equal(G.isFullSize({ name: FULL, encodedBodySize: 1192 }), false); // the small answers on the way to it carry the next address, not the image
  assert.equal(G.isFullSize({ name: FULL, encodedBodySize: 0 }), false);
  assert.equal(G.isFullSize({ name: 'https://lh3.google.com/rd-gg/abc=s0-d-I', encodedBodySize: 9205714 }), false);
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
  // aspect ratio: the five the page offers; reference image: a small set of image types under a flat name
  assert.equal(m('gemMode', { tabId: 3 }), null);
  for (const a of ['1:1', '9:16', '3:4', '4:3', '16:9']) assert.equal(m('gemMode', { tabId: 3, aspect: a }), null, a);
  for (const a of ['21:9', '', 'crop_16_9', 5, null]) assert.match(m('gemMode', { tabId: 3, aspect: a }), /aspect/, String(a));
  const f = { tabId: 3, name: 'ref-1.png', mime: 'image/png', b64: 'iVBORw0KGgo=' };
  assert.ok(OPS.includes('gemAttach'));
  assert.equal(m('gemAttach', f), null);
  assert.equal(m('gemAttach', { ...f, clear: true }), null);
  for (const bad of [{ name: '../x.png' }, { name: '' }, { mime: 'image/svg+xml' }, { mime: 'text/html' }, { b64: '' }, { b64: 'not base64 !' }, { b64: 5 }, { clear: 'yes' }]) assert.match(m('gemAttach', { ...f, ...bad }), /gemAttach/, JSON.stringify(bad));
  assert.equal(m('gemSend', { tabId: 3, prompt: 'a cat', refs: 2 }), null);
  for (const refs of [-1, 11, 1.5, '2']) assert.match(m('gemSend', { tabId: 3, prompt: 'a cat', refs }), /refs/, String(refs));
});

test('aspect ratios are known by the icon of their menu entry, the same in every UI language', () => {
  assert.deepEqual(G.ASPECT_ICONS, { '1:1': 'crop_square', '9:16': 'crop_9_16', '3:4': 'crop_portrait', '4:3': 'crop_landscape', '16:9': 'crop_16_9' });
  assert.equal(G.MAX_REFS, 10);
});

// a Chrome whose page click starts a download a moment later
// A stand-in for chrome.*: the tab answers the press with `reply`. Like the browser, it asks the filename listeners about every download a
// little after it began, and (measured) forgets download()'s own filename once such a listener exists: the server's name stays unless one suggests.
const chromeWith = (o) => {
  const calls = [], names = new Set();
  const fire = (item) => { for (const l of [...names]) l(item, (x) => calls.push(['suggest', item.id, x])); };
  let next = o.id ?? 31;
  return { calls, names, fire,
    tabs: { get: async () => ({ url: o.url ?? 'https://gemini.google.com/app/x' }),
      sendMessage: async (tabId, msg) => { calls.push(['msg', tabId, msg]); if (o.throws) throw new Error('no receiver'); return o.reply; } },
    downloads: { onDeterminingFilename: { addListener: (l) => names.add(l), removeListener: (l) => names.delete(l) },
      download: async (q) => { calls.push(['download', q]); if (o.refuse) throw new Error('refused ' + q.url); const id = next++; setTimeout(() => fire({ id, url: q.url, mime: 'image/png', filename: 'upsampled_img_1.png' }), 8); return id; },
      cancel: async (id) => { calls.push(['cancel', id]); }, erase: async (q) => { calls.push(['erase', q]); } } };
};
const A = { tabId: 3, mediaId: `${TURN}-1`, filename: 'att_med.bin' };
const PAGE_COPY = { id: 77, referrer: '', url: 'blob:null/1b2c3d', mime: 'image/png', filename: 'Gemini_Generated_Image_6l02yb6l02yb6l02.png' };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('gemFetch: the tab presses its own full-size download and says where the page got the file; the extension downloads that itself into ToolFlow-tmp', async () => {
  const c = chromeWith({ reply: { url: FULL } });
  assert.deepEqual(await gemFetchOp(c, A, 40), { ok: true, downloadId: 31 });
  await tick(15);
  assert.deepEqual(c.calls, [['msg', 3, { tf: 'gemDownload', mediaId: `${TURN}-1` }], ['download', { url: FULL, filename: 'ToolFlow-tmp/att_med.bin', conflictAction: 'uniquify' }],
    ['suggest', 31, { filename: 'ToolFlow-tmp/att_med.bin', conflictAction: 'uniquify' }]]); // named when the browser asks: its own filename option does not hold
});

test('gemFetch: the copy the page starts by itself is cancelled and forgotten, during the fetch and a moment after; any other download is left alone; then no listener stays', async () => {
  const c = chromeWith({ reply: { url: FULL } });
  const p = gemFetchOp(c, A, 40);
  await tick(0);
  c.fire(PAGE_COPY); // while we work
  c.fire({ id: 9, referrer: 'https://other.example/', url: 'https://other.example/file.zip', mime: 'application/zip', filename: 'file.zip' }); // the user's own
  await p; await tick();
  c.fire({ ...PAGE_COPY, id: 78 }); // a moment after
  await tick();
  assert.deepEqual(c.calls.filter((x) => x[0] === 'cancel' || x[0] === 'erase'), [['cancel', 77], ['erase', { id: 77 }], ['cancel', 78], ['erase', { id: 78 }]]); // never the zip
  assert.deepEqual(c.calls.filter((x) => x[0] === 'suggest').map((x) => x[1]), [31]); // only our own download was named
  await tick(60);
  assert.equal(c.names.size, 0);
  c.fire({ ...PAGE_COPY, id: 79 });
  assert.equal(c.calls.some((x) => x[1] === 79), false);
});

test('gemFetch: refuses a tab that is not Gemini, an address that is not the image host (its host comes back, never the address), and a browser that will not download', async () => {
  const other = chromeWith({ url: 'https://chatgpt.com/c/x', reply: { url: FULL } });
  assert.deepEqual(await gemFetchOp(other, A, 20), { ok: false, code: 'NOT_GEMINI_TAB' });
  assert.equal(other.calls.length, 0);
  const evil = chromeWith({ reply: { url: 'https://evil.example/rd-gg/secret-token' } });
  assert.deepEqual(await gemFetchOp(evil, A, 20), { ok: false, code: 'SRC_NOT_ALLOWED', host: 'evil.example' });
  assert.equal(evil.calls.some((x) => x[0] === 'download'), false);
  const r = await gemFetchOp(chromeWith({ reply: { url: FULL }, refuse: true }), A, 20);
  assert.deepEqual(r, { ok: false, code: 'DOWNLOAD_REFUSED' }); // the browser's message can echo the address: never forwarded
});

test('gemFetch: what the tab could not do comes back as its code: no such image, button busy, full-size file never seen, no content script', async () => {
  for (const code of ['NOT_FOUND', 'BUSY', 'NO_FULL_SIZE']) assert.deepEqual(await gemFetchOp(chromeWith({ reply: { code } }), A, 20), { ok: false, code });
  assert.deepEqual(await gemFetchOp(chromeWith({ reply: undefined }), A, 20), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await gemFetchOp(chromeWith({ throws: true }), A, 20), { ok: false, code: 'NO_CONTENT_SCRIPT' });
});

test('gemFetch: two requests at once run one after the other (one press at a time on the page), each with one listener', async () => {
  const order = [];
  const c = chromeWith({});
  let most = 0;
  c.tabs.sendMessage = async (t, m) => { const n = m.mediaId.slice(-1); order.push(`press ${n}`); most = Math.max(most, c.names.size); await tick(); order.push(`answer ${n}`); return { url: FULL + n }; };
  const [ra, rb] = await Promise.all([gemFetchOp(c, { ...A, filename: 'a.bin' }, 200), gemFetchOp(c, { ...A, mediaId: `${TURN}-2`, filename: 'b.bin' }, 200)]);
  assert.deepEqual([ra.ok, rb.ok], [true, true]);
  assert.deepEqual(order, ['press 1', 'answer 1', 'press 2', 'answer 2']);
  assert.equal(most, 1); // the second request took over from the first one's lingering listener
  await tick(30);
  assert.deepEqual(c.calls.filter((x) => x[0] === 'suggest').map((x) => [x[1], x[2].filename]), [[31, 'ToolFlow-tmp/a.bin'], [32, 'ToolFlow-tmp/b.bin']]); // the first was asked about after the second had begun: still its own name
});
