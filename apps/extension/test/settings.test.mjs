import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../settings-logic.js';
import { OPS, validate } from '../ops.js';
const T = globalThis.TFSettings;

// Buttons exactly as observed live (docs/app/evidence/flow-composer-dom.md); text starts with a Material icon name.
const TABLE = [
  ['mode', 'image Image'], ['mode', 'videocam Video'],
  ['aspect', 'crop_16_9 16:9'], ['aspect', 'crop_landscape 4:3'], ['aspect', 'crop_square 1:1'], ['aspect', 'crop_portrait 3:4'], ['aspect', 'crop_9_16 9:16'],
  ['quality', 'Low'], ['quality', 'Medium'], ['quality', 'High'],
  ['count', 'x1'], ['count', 'x2'], ['count', 'x3'], ['count', 'x4'],
];
const WANT = { mode: 'Image', aspect: '16:9', quality: 'High', count: 'x2', model: 'Nano Banana 2.1' };

// A panel whose radios behave like Flow: checked state per group; `jump(group, label, st)` lets a click move another group (Q-31).
function world(start, jump = () => {}, model = '🍌 Nano Banana 2.1 arrow_drop_down') {
  const st = { mode: 'Image', aspect: '16:9', quality: 'High', count: 'x2', ...start };
  const clicks = [];
  const btns = TABLE.map(([g, text]) => {
    const l = T.label(text);
    return { role: 'radio', text, get checked() { return String(st[g] === l); }, click() { clicks.push(l); st[g] = l; jump(g, l, st); } };
  });
  btns.splice(7, 0, { role: undefined, text: model, checked: null, click() { clicks.push('MODEL'); } }); // the dropdown sits between aspect and quality, role-less
  return { st, clicks, btns };
}

test('label normalization drops only the leading icon token', () => {
  const t = Object.fromEntries(TABLE.map(([, x]) => [x, T.label(x)]));
  assert.deepEqual(t, { 'image Image': 'Image', 'videocam Video': 'Video', 'crop_16_9 16:9': '16:9', 'crop_landscape 4:3': '4:3', 'crop_square 1:1': '1:1', 'crop_portrait 3:4': '3:4', 'crop_9_16 9:16': '9:16', Low: 'Low', Medium: 'Medium', High: 'High', x1: 'x1', x2: 'x2', x3: 'x3', x4: 'x4' });
  assert.equal(T.modelLabel('🍌 Nano Banana 2.1 arrow_drop_down'), 'Nano Banana 2.1');
  assert.equal(T.modelLabel('🍌 Nano Banana 2.1 arrow_drop_…'), 'Nano Banana 2.1');
});

test('a Vietnamese Flow panel (as seen live) reads as the same combo, and converge clicks the Vietnamese radio', async () => {
  const VI = { 'image Image': 'image Hình ảnh', Low: 'Thấp', Medium: 'Trung bình', High: 'Cao' };
  const w = world({ quality: 'Low' })
  for (const b of w.btns) b.text = VI[b.text] ?? b.text;
  assert.deepEqual(T.read(w.btns).current, { mode: 'Image', aspect: '16:9', quality: 'Low', count: 'x2', model: 'Nano Banana 2.1' });
  const r = await T.converge(WANT, () => w.btns, (b) => b.click());
  assert.equal(r.ok, true);
  assert.deepEqual(w.clicks, ['High']);
  assert.equal(T.label('videocam Video'), 'Video');
});

test('group detection by label, model dropdown separate, checked read per group', () => {
  const w = world({ aspect: '9:16', count: 'x4' });
  assert.deepEqual(T.read(w.btns).current, { mode: 'Image', aspect: '9:16', quality: 'High', count: 'x4', model: 'Nano Banana 2.1' });
  assert.deepEqual(T.mismatches(T.read(w.btns).current, WANT), ['aspect', 'count']);
});

test('already matching ⇒ no clicks', async () => {
  const w = world({});
  const r = await T.converge(WANT, () => w.btns, (b) => b.click());
  assert.deepEqual(r, { ok: true, current: WANT, mismatches: [] });
  assert.deepEqual(w.clicks, []);
});

test('selects by label, never by index (shuffled order still works)', async () => {
  const w = world({ mode: 'Video', aspect: '1:1', quality: 'Low', count: 'x1' });
  w.btns.reverse();
  const r = await T.converge(WANT, () => w.btns, (b) => b.click());
  assert.equal(r.ok, true);
  assert.deepEqual(w.clicks.sort(), ['16:9', 'High', 'Image', 'x2']);
});

test('jump after click: every click re-reads, later pass fixes the group that moved', async () => {
  // clicking a count resets quality to Low; clicking a mode resets aspect to 1:1
  const w = world({ mode: 'Video', quality: 'Low', count: 'x1' }, (g, l, st) => { if (g === 'count') st.quality = 'Low'; if (g === 'mode') st.aspect = '1:1'; });
  let reads = 0;
  const r = await T.converge(WANT, () => (reads++, w.btns), (b) => b.click());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.current, WANT);
  assert.ok(reads > w.clicks.length, 'a read after every click');
});

test('a group that never sticks is reported, within 3 passes', async () => {
  const w = world({ count: 'x1' }, (g, l, st) => { if (g === 'count') st.count = 'x1'; });
  const r = await T.converge(WANT, () => w.btns, (b) => b.click());
  assert.deepEqual([r.ok, r.mismatches, r.current.count], [false, ['count'], 'x1']);
  assert.equal(w.clicks.filter((c) => c === 'x2').length, 3);
});

test('model mismatch is reported and never clicked', async () => {
  const w = world({}, () => {}, '🍌 Nano Banana Pro arrow_drop_down');
  const r = await T.converge(WANT, () => w.btns, (b) => b.click());
  assert.deepEqual([r.ok, r.mismatches, r.current.model], [false, ['model'], 'Nano Banana Pro']);
  assert.ok(!w.clicks.includes('MODEL'));
});

test('missing wanted option ⇒ mismatch, no throw', async () => {
  const w = world({});
  const r = await T.converge({ ...WANT, count: 'x9' }, () => w.btns, (b) => b.click());
  assert.deepEqual([r.ok, r.mismatches], [false, ['count']]);
});

test('ops: settings is an allowed op with the same validate rules', () => {
  assert.ok(OPS.includes('settings'));
  assert.equal(validate({ id: 1, epoch: 2, op: 'settings', args: { tabId: 1, ...WANT } }), null);
  assert.ok(readFileSync(new URL('../sw.js', import.meta.url), 'utf8').includes("'settings'"));
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const iso = m.content_scripts.find((c) => c.js.includes('page-ops.js')).js;
  assert.ok(iso.indexOf('settings-logic.js') >= 0 && iso.indexOf('settings-logic.js') < iso.indexOf('page-ops.js'));
  assert.deepEqual(m.permissions, ['tabs', 'scripting', 'downloads', 'alarms', 'storage'] /* storage: one id per Chrome profile, nothing else */);
});

// ---- page-ops.js against a fake DOM ----
function page({ text = '', panel = false, start = {}, doubled = false, clearWorks = true, model } = {}) {
  const w = world(start, () => {}, model);
  const dom = { open: panel, submitClicks: 0, text, w };
  const el = (o) => ({ getAttribute: (n) => ({ role: o.role, 'aria-checked': o.checked })[n === 'aria-checked' ? 'aria-checked' : n] ?? null, innerText: o.text, click: o.click });
  const radios = () => w.btns.map((b) => el({ role: b.role, checked: b.checked, text: b.text, click: () => b.click() }));
  const trigger = { innerText: 'trigger', click() { dom.open = !dom.open; } };
  const ed = { focus() {}, get innerText() { return dom.text; } };
  const clear = { click() { if (clearWorks) dom.text = ''; } };
  const submit = { disabled: false, click() { dom.submitClicks++; }, closest: () => submit, contains: () => false };
  const SEL = {
    'flow-prompt-box .ProseMirror[contenteditable="true"]': () => ed, 'flow-prompt-box button[type="submit"]': () => submit,
    'flow-prompt-box button.settings-trigger-button': () => trigger, 'button.clear-button': () => (dom.text.trim() ? clear : null),
    'flow-prompt-box-settings': () => (dom.open ? { querySelectorAll: () => radios() } : null),
  };
  let listener;
  const document = {
    createElement: () => ({}), documentElement: { append() {} }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, body: { innerText: '' },
    querySelector: (s) => (SEL[s] ? SEL[s]() : null), querySelectorAll: () => [],
    execCommand: (_c, _u, t) => { dom.text += doubled ? t + t : t; return true; },
  };
  const ctx = vm.createContext({ document, chrome: { runtime: { getManifest: () => ({ version: 't' }), onMessage: { addListener: (f) => { listener = f; } }, sendMessage: async () => {} } }, setTimeout, clearTimeout, Date, JSON, Promise, Set });
  ctx.globalThis = ctx; ctx.window = ctx;
  for (const f of ['../settings-logic.js', '../page-ops.js']) vm.runInContext(readFileSync(new URL(f, import.meta.url), 'utf8'), ctx);
  const call = (op, args) => new Promise((res) => listener({ tf: 'op', op, args }, null, (r) => res(JSON.parse(JSON.stringify(r)))));
  return { dom, call, w };
}

test('settings op: opens the closed panel, converges, closes, never submits', async () => {
  const p = page({ start: { mode: 'Video', aspect: '4:3', count: 'x1', quality: 'Low' } });
  const r = (await p.call('settings', { tabId: 1, ...WANT })).result;
  assert.deepEqual([r.ok, r.mismatches, r.current], [true, [], WANT]);
  assert.equal(p.dom.open, false);
  assert.equal(p.dom.submitClicks, 0);
});

test('settings op: model mismatch ⇒ ok false, reported, nothing else broken', async () => {
  const p = page({ model: '🍌 Nano Banana Pro arrow_drop_down' });
  const r = (await p.call('settings', { tabId: 1, ...WANT })).result;
  assert.deepEqual([r.ok, r.mismatches, p.dom.open], [false, ['model'], false]);
});

test('prep: stale text is cleared first, then the prompt is typed and matches', async () => {
  const p = page({ text: 'old stale prompt' });
  const r = (await p.call('prep', { prompt: 'nova prompt' })).result;
  assert.deepEqual([r.ok, r.textMatches, p.dom.text], [true, true, 'nova prompt']);
});

test('prep: clear failure ⇒ {ok:false, log:[clear failed]} and nothing typed', async () => {
  const p = page({ text: 'old', clearWorks: false });
  const r = (await p.call('prep', { prompt: 'nova prompt' })).result;
  assert.deepEqual([r.ok, r.log], [false, ['clear failed']]);
  assert.equal(p.dom.text, 'old');
});

test('prep: doubled typing ⇒ textMatches false and ok false', async () => {
  const p = page({ doubled: true });
  const r = (await p.call('prep', { prompt: 'nova prompt' })).result;
  assert.deepEqual([r.ok, r.textMatches], [false, false]);
});

test('prep: empty composer is not cleared (no clear button exists)', async () => {
  const p = page({});
  const r = (await p.call('prep', { prompt: 'abc' })).result;
  assert.deepEqual([r.ok, r.textMatches], [true, true]);
});
