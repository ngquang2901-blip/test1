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

// Flow as measured live (2026-11-11): the model menu offers three models; only Nano Banana 2.1 has the thinking-level radios.
const MODELS = ['Nano Banana Pro', 'Nano Banana 2 Lite', 'Nano Banana 2.1'];
const panelOf = (w, model) => w.btns.filter((b) => model === 'Nano Banana 2.1' || !['Low', 'Medium', 'High'].includes(T.label(b.text))).map((b) => (b.role === 'radio' ? b : { ...b, text: `🍌 ${model} arrow_drop_down` }));

test('model: picked first (its option groups differ), then the radios; a model without a thinking level wants quality null', async () => {
  const w = world({ aspect: '4:3' });
  let model = 'Nano Banana 2.1';
  const picks = [];
  const want = { mode: 'Image', aspect: '9:16', quality: null, count: 'x1', model: 'Nano Banana Pro' };
  const r = await T.converge(want, () => panelOf(w, model), (b) => b.click(), { pickModel: async (l) => { picks.push(l); model = l; } });
  assert.deepEqual([r.ok, r.mismatches, r.current, picks], [true, [], want, ['Nano Banana Pro']]);
  assert.deepEqual(w.clicks, ['9:16', 'x1']); // radios only: the model went through pickModel
});

test('model: already the wanted one ⇒ the menu is never opened; a pick that does not take, or a thinking level the model lacks, is a mismatch', async () => {
  const w = world({});
  const picks = [];
  const same = await T.converge(WANT, () => panelOf(w, 'Nano Banana 2.1'), (b) => b.click(), { pickModel: async (l) => { picks.push(l); } });
  assert.deepEqual([same.ok, picks], [true, []]);
  const stuck = await T.converge({ ...WANT, model: 'Nano Banana Pro', quality: null }, () => panelOf(w, 'Nano Banana 2.1'), (b) => b.click(), { pickModel: async (l) => { picks.push(l); } });
  assert.deepEqual([stuck.ok, stuck.mismatches, picks], [false, ['quality', 'model'], ['Nano Banana Pro']]); // asked once, never in a loop
  const noLevel = await T.converge({ ...WANT, model: 'Nano Banana 2 Lite' }, () => panelOf(w, 'Nano Banana 2 Lite'), (b) => b.click());
  assert.deepEqual([noLevel.ok, noLevel.mismatches], [false, ['quality']]); // High wanted, the model has no such group
});

// The Video panel as measured live on 2026-11-11 (Vietnamese UI): mode, input type, two aspects, the model button, counts.
const VIDEO = [['mode', 'image Hình ảnh'], ['mode', 'videocam Video'], ['input', 'crop_free Khung hình'], ['input', 'chrome_extension Thành phần'], ['aspect', 'crop_16_9 16:9'], ['aspect', 'crop_9_16 9:16'], ['count', 'x1'], ['count', 'x2'], ['count', 'x3'], ['count', 'x4']];
function twoModes(start) { // one composer, two panels: the radios and the model on show follow the mode, each mode keeps its own model
  const st = { mode: 'Image', aspect: '16:9', quality: 'High', count: 'x2', input: 'Ingredients', models: { Image: 'Nano Banana 2.1', Video: 'Omni 1.2 Flash' }, ...start };
  const clicks = [];
  const radio = ([g, text]) => { const l = T.label(text); return { role: 'radio', text, get checked() { return String(st[g] === l); }, click() { clicks.push(l); st[g] = l; if (g === 'mode' && l === 'Video' && !['16:9', '9:16'].includes(st.aspect)) st.aspect = '16:9'; } }; };
  const buttons = () => [...(st.mode === 'Video' ? VIDEO : TABLE.map(([g, t]) => [g, t.replace('image Image', 'image Hình ảnh')])).map(radio), { role: undefined, text: `${st.models[st.mode]} arrow_drop_down`, checked: null }];
  return { st, clicks, buttons, pickModel: async (l) => { clicks.push(`MODEL ${l} in ${st.mode}`); st.models[st.mode] = l; } };
}

test('video: the mode is switched before the model is picked (each mode has its own model menu), then input type, aspect and count', async () => {
  const w = twoModes({});
  const want = { mode: 'Video', input: 'Ingredients', aspect: '9:16', quality: null, count: 'x1', model: 'Veo 3.1 - Lite' };
  const r = await T.converge(want, w.buttons, (b) => b.click(), { pickModel: w.pickModel });
  assert.deepEqual([r.ok, r.mismatches, r.current], [true, [], want]);
  assert.deepEqual(w.clicks, ['Video', 'MODEL Veo 3.1 - Lite in Video', '9:16', 'x1']);
  assert.equal(w.st.models.Image, 'Nano Banana 2.1'); // the image mode's model was not touched
  const frames = await T.converge({ ...want, input: 'Frames' }, w.buttons, (b) => b.click(), { pickModel: w.pickModel });
  assert.deepEqual([frames.ok, w.clicks.at(-1), w.st.input], [true, 'Frames', 'Frames']); // "Khung hình", picked by its label
});

test('input type: an image combo names none and the image panel has none; a video combo must name the one on show', async () => {
  const w = twoModes({});
  const image = await T.converge(WANT, w.buttons, (b) => b.click(), { pickModel: w.pickModel });
  assert.deepEqual([image.ok, w.clicks], [true, []]);
  const noInput = await T.converge({ mode: 'Video', aspect: '16:9', quality: null, count: 'x2', model: 'Omni 1.2 Flash' }, w.buttons, (b) => b.click(), { pickModel: w.pickModel });
  assert.deepEqual([noInput.ok, noInput.mismatches], [false, ['input']]); // fail closed: never send a video without knowing which input type is on
  const back = await T.converge(WANT, w.buttons, (b) => b.click(), { pickModel: w.pickModel }); // and back to the image combo
  assert.deepEqual([back.ok, back.current.model, 'input' in back.current], [true, 'Nano Banana 2.1', false]);
});

test('missing wanted option ⇒ mismatch, no throw', async () => {
  const w = world({});
  const r = await T.converge({ ...WANT, count: 'x9' }, () => w.btns, (b) => b.click());
  assert.deepEqual([r.ok, r.mismatches], [false, ['count']]);
});

test('ops: settings is an allowed op with the same validate rules', () => {
  assert.ok(OPS.includes('settings'));
  assert.equal(validate({ id: 1, epoch: 2, op: 'settings', args: { tabId: 1, ...WANT } }), null);
  assert.equal(validate({ id: 1, epoch: 2, op: 'settings', args: { tabId: 1, ...WANT, quality: null } }), null); // a model without a thinking level
  for (const bad of [{ quality: '' }, { quality: undefined }, { quality: 3 }, { model: null }, { count: null }]) assert.match(validate({ id: 1, epoch: 2, op: 'settings', args: { tabId: 1, ...WANT, ...bad } }), /settings needs/, JSON.stringify(bad));
  assert.equal(validate({ id: 1, epoch: 2, op: 'settings', args: { tabId: 1, ...WANT, mode: 'Video', quality: null, input: 'Frames' } }), null); // video: the input type that must be on
  for (const bad of [{ input: '' }, { input: 3 }, { input: null }]) assert.match(validate({ id: 1, epoch: 2, op: 'settings', args: { tabId: 1, ...WANT, ...bad } }), /settings needs/, JSON.stringify(bad));
  assert.ok(readFileSync(new URL('../sw.js', import.meta.url), 'utf8').includes("'settings'"));
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const iso = m.content_scripts.find((c) => c.js.includes('page-ops.js')).js;
  assert.ok(iso.indexOf('settings-logic.js') >= 0 && iso.indexOf('settings-logic.js') < iso.indexOf('page-ops.js'));
  assert.deepEqual(m.permissions, ['tabs', 'scripting', 'downloads', 'alarms', 'storage'] /* storage: one id per Chrome profile, nothing else */);
});

// ---- page-ops.js against a fake DOM ----
function page({ text = '', panel = false, start = {}, doubled = false, clearWorks = true, model = 'Nano Banana 2.1', models = MODELS } = {}) {
  const w = world(start);
  const dom = { open: panel, submitClicks: 0, text, w, model, menu: false, menuOpened: 0 };
  const el = (o) => ({ getAttribute: (n) => ({ role: o.role, 'aria-checked': o.checked })[n === 'aria-checked' ? 'aria-checked' : n] ?? null, innerText: o.text, click: o.click });
  // the role-less button opens the model menu (an overlay outside the panel); picking an item or clicking the backdrop closes it
  const radios = () => panelOf(w, dom.model).map((b) => el({ role: b.role, checked: b.checked, text: b.text, click: b.role === 'radio' ? () => b.click() : () => { dom.menu = true; dom.menuOpened++; } }));
  const overlay = { '[role="menu"] [role="menuitem"]': () => models.map((m) => ({ innerText: `🍌 ${m}`, click() { dom.model = m; dom.menu = false; } })), '.cdk-overlay-backdrop': () => [{ click() { dom.menu = false; } }] };
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
    querySelector: (s) => (SEL[s] ? SEL[s]() : null), querySelectorAll: (s) => (dom.menu && overlay[s] ? overlay[s]() : []),
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

test('settings op: the wanted model is picked from the menu by label; a model without a thinking level takes quality null', async () => {
  const p = page({ model: 'Nano Banana Pro', start: { aspect: '1:1' } });
  const back = (await p.call('settings', { tabId: 1, ...WANT })).result; // Pro shown, 2.1 wanted
  assert.deepEqual([back.ok, back.current, p.dom.model, p.dom.menu, p.dom.open], [true, WANT, 'Nano Banana 2.1', false, false]);
  const want = { mode: 'Image', aspect: '9:16', quality: null, count: 'x3', model: 'Nano Banana 2 Lite' };
  const lite = (await p.call('settings', { tabId: 1, ...want })).result;
  assert.deepEqual([lite.ok, lite.current, p.dom.model, p.dom.menuOpened], [true, want, 'Nano Banana 2 Lite', 2]);
  assert.equal((await p.call('settings', { tabId: 1, ...want })).result.ok, true);
  assert.equal(p.dom.menuOpened, 2); // already that model: the menu stays shut
  assert.equal(p.dom.submitClicks, 0);
});

test('settings op: a model the menu does not offer (or offers twice) ⇒ mismatch, nothing picked, menu and panel closed', async () => {
  const p = page({ model: 'Nano Banana Pro' });
  const r = (await p.call('settings', { tabId: 1, ...WANT, model: 'Imagen 9' })).result;
  assert.deepEqual([r.ok, r.mismatches.includes('model'), p.dom.model, p.dom.menu, p.dom.open], [false, true, 'Nano Banana Pro', false, false]);
  const twice = page({ model: 'Nano Banana Pro', models: ['Nano Banana 2.1', 'Nano Banana 2.1'] });
  const t = (await twice.call('settings', { tabId: 1, ...WANT })).result;
  assert.deepEqual([t.ok, twice.dom.model, twice.dom.menu], [false, 'Nano Banana Pro', false]); // never a guess between two
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
