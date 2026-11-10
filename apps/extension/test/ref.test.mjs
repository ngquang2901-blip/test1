import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../ref-logic.js';
import { OPS, validate } from '../ops.js';
const R = globalThis.TFRef;

const NAME = 'tf-1a2b3c4d-mhx9k2a1.png';
const item = (text, log, id) => ({ text, click: () => log.push(id) });

test('matchByName: prefix match on the first 20 chars, because the list truncates long names', () => {
  assert.equal(R.prefix(NAME), NAME.slice(0, 20));
  assert.deepEqual(R.matchByName(['tf-1a2b3c4d-mhx9k… Image'], NAME), { n: 0, i: -1 }); // shown shorter than the 20-char prefix: no match is claimed
  assert.deepEqual(R.matchByName(['tf-1a2b3c4d-mhx9k2a1.p… Image'], NAME), { n: 1, i: 0 });
  assert.deepEqual(R.matchByName([`${NAME}\nImage`], NAME), { n: 1, i: 0 });
});

test('matchByName: selects by text wherever the item sits, never by index', () => {
  const other = 'tf-99999999-mhx9k2a1.png Image';
  for (const list of [[other, `${NAME} Image`, 'x Image'], [`${NAME} Image`, other], ['x', other, `${NAME} Image`]]) {
    const r = R.matchByName(list, NAME);
    assert.equal(r.n, 1);
    assert.equal(list[r.i].startsWith(NAME), true);
  }
});

test('matchByName: zero and many matches are reported as such; identical-bytes assets differ in the prefix', () => {
  assert.deepEqual(R.matchByName(['a', 'b'], NAME), { n: 0, i: -1 });
  assert.deepEqual(R.matchByName([`${NAME} Image`, `${NAME} Image`], NAME), { n: 2, i: -1 });
  assert.deepEqual(R.matchByName(['tf-1a2b3c4e-mhx9k2a1.png Image'], NAME), { n: 0, i: -1 });
});

test('newChip: exactly one new uuid; none, two, or removals are not a success', () => {
  assert.deepEqual(R.newChip(['a'], ['a', 'b']), { ok: true, added: 'b' });
  assert.deepEqual(R.newChip([], ['b']), { ok: true, added: 'b' });
  assert.equal(R.newChip(['a'], ['a']).ok, false);
  assert.equal(R.newChip(['a'], ['a', 'b', 'c']).ok, false);
  assert.equal(R.newChip(['a', 'b'], ['b']).ok, false);
  assert.equal(R.newChip(['a'], ['a', undefined]).ok, false, 'a chip without a parsable uuid is no proof');
});

test('plusIndex: icon text add or aria-label add*, exactly one, else fail closed', () => {
  assert.equal(R.plusIndex([{ text: 'send', label: '' }, { text: ' add ', label: '' }]), 1);
  assert.equal(R.plusIndex([{ text: '', label: 'Add media' }, { text: 'tune', label: '' }]), 0);
  assert.equal(R.plusIndex([{ text: 'add', label: '' }, { text: '', label: 'Add media' }]), -1);
  assert.equal(R.plusIndex([{ text: 'send', label: 'Gửi' }]), -1);
  assert.equal(R.plusIndex([]), -1);
});

// A tiny Flow: popover, search filter, library, chips. Time advances only through `tick`.
function world({ library, hideUntil = 0, chipAfter = 0, noAdd = false, extra = false, placeholder = 0, addReadyAfter = 0 }) {
  const w = { open: false, query: '', picked: null, chips: ['old'], clicks: [], polls: 0, pending: null };
  const tick = async () => {
    w.polls++;
    if (w.pending && --w.pending.left <= 0) { w.chips.push(...(placeholder ? [undefined] : w.pending.add)); w.settle = placeholder ? { left: placeholder, to: w.pending.add[0] } : null; w.pending = null; }
    else if (w.settle && --w.settle.left <= 0) { w.chips = w.chips.map((c) => c ?? w.settle.to); w.settle = null; } // Flow shows the chip first, its image src (the uuid) a bit later
  };
  const env = {
    chips: () => [...w.chips],
    isOpen: () => w.open,
    open: async () => { w.open = true; return true; },
    close: () => { w.open = false; },
    setSearch: (q) => { w.query = q; },
    items: () => (w.polls < hideUntil ? [] : library.map((l) => item(l.name + ' Image', w.clicks, l.name))),
    addButton: () => (w.clicks.length && !noAdd ? { click: () => { w.addClicks = (w.addClicks || 0) + 1; if (w.polls < addReadyAfter) return; const l = library.find((x) => x.name === w.clicks.at(-1)); w.pending = { left: chipAfter + 1, add: extra ? [l.uuid, 'surprise'] : [l.uuid] }; } } : null),
  };
  const until = async (fn, ms) => { for (let k = 0; k <= ms / 150; k++) { const v = fn(); if (v) return v; await tick(); } return null; };
  return { w, env, until };
}
const LIB = [{ name: 'tf-99999999-mhx9k2a1.png', uuid: 'u-other' }, { name: NAME, uuid: 'u-mine' }, { name: 'zzz.png', uuid: 'u-z' }];
const run = (x) => R.attach(x.env, NAME, { until: x.until });

test('attach: picks the right item among others, adds one chip, closes the popover', async () => {
  const x = world({ library: LIB });
  assert.deepEqual(await run(x), { ok: true, chips: ['old', 'u-mine'], added: 'u-mine' });
  assert.deepEqual(x.w.clicks, [NAME]);
  assert.equal(x.w.open, false);
});

test('attach: chip shows up before its image src is readable: waits for the uuid, still ok', async () => {
  const x = world({ library: LIB, placeholder: 6 });
  assert.deepEqual(await run(x), { ok: true, chips: ['old', 'u-mine'], added: 'u-mine' });
});

test('attach: Add button is a no-op for a fresh upload: re-clicks until the chip exists, adds exactly one', async () => {
  const x = world({ library: LIB, addReadyAfter: 40 });
  assert.deepEqual(await run(x), { ok: true, chips: ['old', 'u-mine'], added: 'u-mine' });
  assert.ok(x.w.addClicks > 1);
  assert.equal(x.w.chips.filter((c) => c === 'u-mine').length, 1);
});

test('attach: a chip that exists but is not readable yet is NEVER re-clicked (no double add)', async () => {
  const x = world({ library: LIB, placeholder: 40 });
  assert.equal((await run(x)).added, 'u-mine');
  assert.equal(x.w.addClicks, 1);
});

test('attach: item appears late and the chip a few seconds later: still ok', async () => {
  const x = world({ library: LIB, hideUntil: 10, chipAfter: 20 });
  assert.equal((await run(x)).added, 'u-mine');
});

test('attach: not found ⇒ NOT_FOUND, nothing clicked, popover closed', async () => {
  const x = world({ library: LIB.filter((l) => l.name !== NAME) });
  assert.deepEqual(await run(x), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(x.w.clicks, []);
  assert.equal(x.w.open, false);
});

test('attach: two items match ⇒ AMBIGUOUS, nothing clicked', async () => {
  const x = world({ library: [...LIB, { name: NAME, uuid: 'u-dup' }] });
  assert.deepEqual(await run(x), { ok: false, code: 'AMBIGUOUS' });
  assert.deepEqual(x.w.clicks, []);
});

test('attach: no chip appears ⇒ NO_CHIP; two chips appear ⇒ NO_CHIP; no Add to prompt button ⇒ NO_ADD', async () => {
  assert.deepEqual(await run(world({ library: LIB, chipAfter: 10_000 })), { ok: false, code: 'NO_CHIP' });
  assert.deepEqual(await run(world({ library: LIB, extra: true })), { ok: false, code: 'NO_CHIP' });
  assert.deepEqual(await run(world({ library: LIB, noAdd: true })), { ok: false, code: 'NO_ADD' });
});

test('attach: popover already open is not toggled shut before use', async () => {
  const x = world({ library: LIB }); x.w.open = true;
  let opened = 0; const o = x.env.open; x.env.open = async () => (opened++, o());
  assert.equal((await run(x)).ok, true);
  assert.equal(opened, 0);
});

test('op attach: allowlisted and validated (name string 1..200)', () => {
  assert.ok(OPS.includes('attach'));
  const ok = (a) => validate({ id: 1, epoch: 2, op: 'attach', args: a });
  assert.equal(ok({ tabId: 1, name: NAME }), null);
  for (const bad of [{}, { name: '' }, { name: 5 }, { name: 'x'.repeat(201) }, { name: null }]) assert.ok(ok(bad), JSON.stringify(bad));
  assert.equal(ok({ name: 'x'.repeat(200) }), null);
});

test('wiring: sw forwards attach to the page; ref-logic loads before page-ops; page-ops never touches submit in attach', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /PAGE_OPS = new Set\(\[[^\]]*'attach'/);
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const js = m.content_scripts.find((c) => c.js.includes('page-ops.js')).js;
  assert.ok(js.indexOf('ref-logic.js') >= 0 && js.indexOf('ref-logic.js') < js.indexOf('page-ops.js'));
  assert.deepEqual(m.permissions, ['tabs', 'scripting', 'downloads', 'alarms']);
  const po = readFileSync(new URL('../page-ops.js', import.meta.url), 'utf8');
  const body = po.slice(po.indexOf('async attach('), po.indexOf('async attach(') + 1800);
  assert.ok(body.includes('TFRef.attach'));
  assert.ok(!body.includes('SUBMIT'));
});

test('the library confirm button is found in English and in Vietnamese (as seen live), nothing else', () => {
  const R = globalThis.TFRef;
  for (const t of ['Add to prompt', 'Thêm vào câu lệnh', '  Thêm vào\n câu lệnh ']) assert.equal(R.isAddLabel(t), true, t);
  for (const t of ['Thêm', 'Add', 'Tải nội dung lên', '', null]) assert.equal(R.isAddLabel(t), false, String(t));
});
