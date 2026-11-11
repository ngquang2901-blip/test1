import test from 'node:test';
import assert from 'node:assert/strict';
import '../gpt-logic.js';
import { OPS, validate, gptFetchOp } from '../ops.js';
const G = globalThis.TFGpt;

const MSG = '6af47c4e-cf14-83ec-9fd1-7ccae249b4ef';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('image mode label: the measured English item, with its description after it; nothing else', () => {
  assert.equal(G.isModeLabel('Create image Visualize anything'), true);
  assert.equal(G.isModeLabel('  create   image'), true);
  for (const t of ['Add photos & files Upload from computer', 'Web search', 'Sketch Draw and attach an image', '', null]) assert.equal(G.isModeLabel(t), false);
});

test('a bubble is ours only on an exact match: the prompt, or one known pill label then the prompt', () => {
  const p = 'a single ripe mango on a white plate';
  assert.equal(G.ownsBubble(`Create image ${p}`, p), true);
  assert.equal(G.ownsBubble(`Create image\n${p}  `, p), true); // the pill is its own element: whitespace between them varies
  assert.equal(G.ownsBubble(p, p), true);
  assert.equal(G.ownsBubble(`Tạo ảnh ${p}`, p, ['Tạo ảnh']), true); // a label the page itself names on the pill
  assert.equal(G.ownsBubble(`Tạo ảnh ${p}`, p), false);
  assert.equal(G.ownsBubble(`Create image ${p} and a spoon`, p), false);
  assert.equal(G.ownsBubble(`please draw ${p}`, p), false); // the user's own message ending with our words
  assert.equal(G.ownsBubble('Create image', ''), false);
});

test('media id: assistant message id + image number, and back; anything else is refused', () => {
  assert.equal(G.mediaId(MSG, 2), `${MSG}-2`);
  assert.deepEqual(G.parseMediaId(`${MSG}-2`), { msgId: MSG, n: 2 });
  for (const bad of [MSG, `${MSG}-0`, `${MSG}-100`, `${MSG}-1/..`, `x${MSG}-1`, '', null]) assert.equal(G.parseMediaId(bad), null);
});

test('conversation id from the path: /c/<uuid> only', () => {
  assert.equal(G.convOf(`/c/${MSG}`), MSG);
  for (const p of ['/', `/c/local-chatgpt%3A${MSG}`, `/c/${MSG}/x`, `/g/${MSG}`, '']) assert.equal(G.convOf(p), null);
});

test('only the bytes of an image may go to the browser download: no http address, no html', () => {
  assert.equal(G.isImageDataUrl(PNG), true);
  for (const bad of ['https://chatgpt.com/x.png', 'blob:https://chatgpt.com/abc', 'data:text/html;base64,PGI+', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png,raw', '', null]) assert.equal(G.isImageDataUrl(bad), false);
});

test('validate: the ChatGPT ops take a tab, and a prompt / conversation / media id of the right shape', () => {
  const m = (op, args) => validate({ id: 1, epoch: 1, op, args });
  for (const op of ['gptTabs', 'gptNew', 'gptOpen', 'gptFront', 'gptLook', 'gptState', 'gptMode', 'gptPrep', 'gptSend', 'gptTurns', 'gptFetch']) assert.ok(OPS.includes(op), op);
  for (const op of ['gptPlus', 'gptFind', 'gptPick', 'gptImgs']) assert.ok(!OPS.includes(op), `spike op ${op} is gone`);
  assert.equal(m('gptTabs', {}), null);
  assert.equal(m('gptPrep', { tabId: 3, prompt: 'a cat' }), null);
  assert.match(m('gptPrep', { tabId: 3, prompt: '' }), /prompt/);
  assert.match(m('gptSend', { tabId: 3 }), /prompt/);
  assert.match(m('gptTurns', { tabId: 3, prompt: 'x'.repeat(20001) }), /prompt/);
  assert.equal(m('gptOpen', { tabId: 3, conv: MSG }), null);
  assert.match(m('gptOpen', { tabId: 3, conv: 'https://evil.example/' }), /conversation/);
  assert.equal(m('gptFetch', { tabId: 3, mediaId: `${MSG}-1`, filename: 'a_b.bin' }), null);
  assert.match(m('gptFetch', { tabId: 3, mediaId: MSG, filename: 'a_b.bin' }), /gptFetch/);
  assert.match(m('gptFetch', { tabId: 3, mediaId: `${MSG}-1`, filename: '../a.bin' }), /gptFetch/);
  assert.match(m('gptState', {}), /tabId/);
  assert.match(m('gptFront', {}), /tabId/);
  assert.equal(m('gptFront', { tabId: 3 }), null);
  assert.equal(m('gptFront', { tabId: 3, raise: true }), null);
  assert.match(m('gptFront', { tabId: 3, raise: 'yes' }), /raise/);
});

const chromeWith = (o) => {
  const calls = [];
  return { calls,
    tabs: { get: async () => ({ url: o.url ?? 'https://chatgpt.com/c/x' }), sendMessage: async (tabId, msg) => { calls.push(['msg', tabId, msg]); if (o.throws) throw new Error('no receiver'); return o.reply; } },
    downloads: { download: async (d) => { calls.push(['download', d]); return o.downloadId ?? 7; } } };
};

test('gptFetch: the page answers with the image bytes, which go to chrome.downloads under ToolFlow-tmp; the result is the download id only', async () => {
  const c = chromeWith({ reply: { src: PNG } });
  assert.deepEqual(await gptFetchOp(c, { tabId: 3, mediaId: `${MSG}-1`, filename: 'att_med.bin' }), { ok: true, downloadId: 7 });
  assert.deepEqual(c.calls[0], ['msg', 3, { tf: 'gptSrc', mediaId: `${MSG}-1` }]);
  assert.deepEqual(c.calls[1], ['download', { url: PNG, filename: 'ToolFlow-tmp/att_med.bin', conflictAction: 'uniquify' }]);
});

test('gptFetch: refuses a tab that is not ChatGPT, an answer that is not image bytes, and reports a missing image as NOT_FOUND', async () => {
  const a = { tabId: 3, mediaId: `${MSG}-1`, filename: 'att_med.bin' };
  const other = chromeWith({ url: 'https://flow.google.com/project/x', reply: { src: PNG } });
  assert.deepEqual(await gptFetchOp(other, a), { ok: false, code: 'NOT_CHATGPT_TAB' });
  assert.equal(other.calls.length, 0);
  for (const src of ['https://files.example/x.png', 'blob:https://chatgpt.com/abc', 'data:text/html;base64,PGI+']) {
    const c = chromeWith({ reply: { src } });
    assert.deepEqual(await gptFetchOp(c, a), { ok: false, code: 'SRC_NOT_ALLOWED' });
    assert.equal(c.calls.filter((x) => x[0] === 'download').length, 0);
  }
  assert.deepEqual(await gptFetchOp(chromeWith({ reply: { code: 'NOT_FOUND' } }), a), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await gptFetchOp(chromeWith({ reply: undefined }), a), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await gptFetchOp(chromeWith({ throws: true }), a), { ok: false, code: 'NO_CONTENT_SCRIPT' });
});
