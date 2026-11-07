import { test, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initial, type AttemptState } from '@toolflow/flow-protocol/attempt';
import { openDb, type Db } from '../src/main/db';
import { enqueueBatch } from '../src/main/batch';
import { createFakeDriver, type FakeScript } from '../src/main/fake-driver';
import type { DriverEvent, FlowDriver } from '../src/main/driver';
import { createRunner, batchStatus, type Runner } from '../src/main/runner';

const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(script: FakeScript, o: { kind?: 'image' | 'video'; n: number; speed?: 'default' | 'fast'; tabs?: string[]; mode?: 'auto' | 'manual'; auto?: boolean; hold?: boolean; check?: FlowDriver['checkBeforeClick']; afterPrepare?: (db: Db, runner: Runner) => void; corruptSent?: boolean; noListener?: boolean; deadObserver?: boolean; slowClick?: boolean }) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  const clock = { t: Date.now(), now() { return this.t; } };
  const fake = createFakeDriver(script);
  const cbs = new Set<(e: DriverEvent) => void>();
  const held: DriverEvent[] = [];
  const gate = { hold: !!o.hold };
  const gateClick: { open: () => void; p: Promise<void> } = (() => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { open, p }; })();
  let listenerless = !!o.noListener;
  const obs = { dead: !!o.deadObserver };
  fake.onEvent((e0) => { const e = o.corruptSent && e0.type === 'sent' ? { ...e0, request: 'garbage' } : e0; return (gate.hold && e.type === 'response' ? held.push(e) : cbs.forEach((cb) => cb(e))); });
  const driver: FlowDriver & { ledger: typeof fake.ledger; emit: typeof fake.emit } = {
    ...fake,
    click: async (tab, epoch) => {
      if (listenerless) { listenerless = false; return { found: true, disabled: false, listeners: 0, called: 0 }; }
      if (o.slowClick) await gateClick.p;
      return fake.click(tab, epoch);
    },
    ping: async () => ({ ...(await fake.ping('x')), t: clock.now(), ...(obs.dead ? { xhrSend: false } : {}) }), // the observer ping must look fresh to the fake clock
    prepare: async (tab, p) => { const r = await fake.prepare(tab, p); o.afterPrepare?.(db, runner); return r; },
    checkBeforeClick: o.check ?? fake.checkBeforeClick,
    onEvent: (cb) => { cbs.add(cb); return () => cbs.delete(cb); },
  };
  const kind = o.kind ?? 'image';
  const { batchId } = enqueueBatch(db, {
    commandId: 'c', kind, projectId: 'p', settings: {}, mode: o.mode ?? 'auto',
    prompts: Array.from({ length: o.n }, (_, i) => `prompt ${i}`), refs: Array.from({ length: o.n }, () => []),
  });
  const runner = createRunner({ db, driver, clock, tabs: o.tabs ?? ['t1'], speed: o.speed ?? 'default', autoAllowed: () => o.auto ?? true });
  const step = async (n = 1) => { for (let i = 0; i < n; i++) { await runner.tick(); await flush(); } };
  const release = () => { gate.hold = false; held.splice(0).forEach((e) => cbs.forEach((cb) => cb(e))); };
  const states = () => (db.prepare('select a.id, a.state_json j from item i join attempt a on a.id=i.attempt_id order by i.ord').all() as { id: string; j: string }[])
    .map((r) => ({ id: r.id, ...(JSON.parse(r.j) as AttemptState) }));
  const deliver = (e: DriverEvent) => cbs.forEach((cb) => cb(e));
  return { db, obs, clock, driver, runner, batchId, step, release, states, held, deliver, openClick: gateClick.open };
}
const count = (item: string, rs: { item: string }[]) => rs.filter((s) => s.item === item).length;
const batchRow = (db: Db, id: string) => db.prepare('select status from batch where id=?').get(id) as { status: string };

test('image batch respects cap 12 and sends next after sent', async () => {
  const t = rig(Array(20).fill('image-ok'), { n: 20, hold: true });
  t.runner.start(t.batchId);
  await t.step();
  expect(t.driver.ledger.clicks).toBe(1);
  await t.step(); // sent of 1 arrived, response still held: next is clicked now
  expect(t.driver.ledger.clicks).toBe(2);
  expect(t.states()[0].request).not.toBeNull();
  expect(t.states()[0].item).toBe('submitting');
  let max = 0;
  for (let i = 0; i < 30; i++) { await t.step(); max = Math.max(max, t.runner.inFlight().image); }
  expect(max).toBe(12);
  expect(t.driver.ledger.clicks).toBe(12);
  t.release();
  for (let i = 0; i < 40; i++) { await t.step(); expect(t.runner.inFlight().image).toBeLessThanOrEqual(12); }
  expect(t.driver.ledger.clicks).toBe(20);
  expect(count('ready', t.states())).toBe(20);
  expect(batchStatus(t.db, t.batchId)).toBe('completed');
});

test('video waits for receipt per tab', async () => {
  const t = rig(['video-ok', 'video-ok', 'video-ok'], { n: 3, kind: 'video', hold: true });
  t.runner.start(t.batchId);
  await t.step(3);
  expect(t.driver.ledger.clicks).toBe(1);
  t.release();
  await t.step();
  expect(t.driver.ledger.clicks).toBe(2);
  expect(t.states()[0].item).toBe('generating');
});

test('fast mode uses 4 tabs and caps 20/30', async () => {
  const f = rig(Array(6).fill('image-ok'), { n: 6, speed: 'fast', tabs: ['t1', 't2', 't3', 't4', 't5'], hold: true });
  f.runner.start(f.batchId);
  await f.step();
  expect(f.driver.ledger.clicks).toBe(4);
  expect(f.runner.caps()).toEqual({ image: 30, video: 20 });
  const d = rig(Array(6).fill('image-ok'), { n: 6, tabs: ['t1', 't2'], hold: true });
  d.runner.start(d.batchId);
  await d.step();
  expect(d.driver.ledger.clicks).toBe(1);
  expect(d.runner.caps()).toEqual({ image: 12, video: 8 });
});

test('throttle halves cap and resends same attempt after backoff', async () => {
  const t = rig(['throttled', 'image-ok', 'image-ok'], { n: 2 });
  t.runner.start(t.batchId);
  await t.step(2);
  expect(t.driver.ledger.clicks).toBe(1);
  expect(t.runner.caps().image).toBe(6);
  const first = t.states()[0];
  expect(first.item).toBe('queued');
  t.clock.t += 29_999;
  await t.step();
  expect(t.driver.ledger.clicks).toBe(1);
  t.clock.t += 1;
  await t.step();
  expect(t.driver.ledger.clicks).toBe(2);
  const intents = (id: string) => (t.db.prepare("select count(*) c from journal_event where attempt_id=? and type='intent'").get(id) as { c: number }).c;
  expect(intents(first.id)).toBe(2);
  await t.step(4);
  expect(t.driver.ledger.clicks).toBe(3); // 2 attempts + 1 resend
  expect(count('ready', t.states())).toBe(2);
  expect(intents(t.states()[1].id)).toBe(1);
});

test('pause fences new clicks but follows sent ones', async () => {
  const t = rig(Array(3).fill('image-ok'), { n: 3, hold: true });
  t.runner.start(t.batchId);
  await t.step();
  t.runner.pause(t.batchId);
  await t.step(3);
  expect(t.driver.ledger.clicks).toBe(1);
  t.release();
  await t.step();
  expect(t.states()[0].item).toBe('ready');
  expect(t.driver.ledger.clicks).toBe(1);
  expect(batchStatus(t.db, t.batchId)).toBe('paused');
  t.runner.resume(t.batchId);
  await t.step(5);
  expect(t.driver.ledger.clicks).toBe(3);
});

test('stop cancels unsent only', async () => {
  const t = rig(Array(7).fill('image-ok'), { n: 7, hold: true });
  t.runner.start(t.batchId);
  await t.step(2);
  expect(t.driver.ledger.clicks).toBe(2);
  t.runner.stop(t.batchId);
  expect(count('cancelled', t.states())).toBe(5);
  t.release();
  await t.step(3);
  const s = t.states();
  expect(count('ready', s)).toBe(2);
  expect(count('cancelled', s)).toBe(5);
  expect(t.driver.ledger.clicks).toBe(2);
  expect(batchStatus(t.db, t.batchId)).toBe('stopped');
});

test('intent write failure blocks click', async () => {
  const t = rig(['image-ok', 'image-ok'], { n: 2, afterPrepare: (db) => { db.pragma('query_only = ON'); } });
  t.runner.start(t.batchId);
  await t.step(2);
  expect(t.driver.ledger.clicks).toBe(0);
  expect(t.runner.lastError(t.batchId)).toBe('STORAGE_UNAVAILABLE');
  t.db.pragma('query_only = OFF');
  await t.step(); // flushes the pause that could not be written while the DB was read-only
  expect(batchRow(t.db, t.batchId).status).toBe('paused');
  expect(t.states()[0].item).toBe('preparing');
  expect(t.driver.ledger.clicks).toBe(0);
});

test('connector drop during click is uncertain', async () => {
  const t = rig(['drop', 'image-ok'], { n: 2 });
  t.runner.start(t.batchId);
  await t.step(3);
  const a = t.states()[0];
  expect(a.item).toBe('needs_review');
  expect(a.stage).toBe('uncertain');
  expect(a.creditSpent).toBe(true);
  expect(t.db.prepare('select project_id, attempt_id from target_block').all()).toEqual([{ project_id: 'p', attempt_id: a.id }]);
  expect(t.driver.ledger.clicks).toBe(1);
  expect(batchStatus(t.db, t.batchId)).toBe('needs_review');
});

test('batch status follows 02 §5', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  const run = (items: string[], o: { stop?: boolean; status?: string }) => {
    const { batchId } = enqueueBatch(db, { commandId: `c${Math.random()}`, kind: 'image', projectId: 'p', settings: {}, mode: 'auto', prompts: items.map((_, i) => `p${i}`), refs: items.map(() => []) });
    db.prepare('update batch set stop_requested=?, status=? where id=?').run(o.stop ? 1 : 0, o.status ?? 'running', batchId);
    const ids = db.prepare('select attempt_id a from item where batch_id=? order by ord').all(batchId) as { a: string }[];
    ids.forEach((r, i) => db.prepare('update attempt set state_json=? where id=?').run(JSON.stringify({ ...initial('x'), item: items[i] }), r.a));
    return batchStatus(db, batchId);
  };
  expect(run(['needs_review', 'ready'], { stop: true })).toBe('needs_review');
  expect(run(['submitting', 'queued'], {})).toBe('running');
  expect(run(['generating'], { status: 'paused' })).toBe('paused');
  expect(run(['ready', 'cancelled'], { stop: true })).toBe('stopped');
  expect(run(['queued', 'ready'], { status: 'queued' })).toBe('queued');
  expect(run(['ready', 'ready'], {})).toBe('completed');
  expect(run(['ready', 'failed'], {})).toBe('partial_failed');
  expect(run(['failed', 'cancelled'], {})).toBe('failed');
});

test('target changed blocks click', async () => {
  const t = rig(['image-ok'], { n: 1, check: async () => ({ ok: false, code: 'TARGET_CHANGED' }) });
  t.runner.start(t.batchId);
  await t.step(2);
  expect(t.driver.ledger.clicks).toBe(0);
  expect(batchRow(t.db, t.batchId).status).toBe('paused');
  expect(t.runner.lastError(t.batchId)).toBe('TARGET_CHANGED');
});

test('auto off means no click', async () => {
  const t = rig(['image-ok'], { n: 1, auto: false });
  t.runner.start(t.batchId);
  await t.step(2);
  expect(t.driver.ledger.clicks).toBe(0);
  expect(t.states()[0].item).toBe('awaiting_user');
});

test('journal never holds the raw request body (R11)', async () => {
  const t = rig(['image-ok'], { n: 1 });
  t.runner.start(t.batchId);
  await t.step(3);
  expect(t.states()[0].item).toBe('ready');
  const rows = t.db.prepare('select type, payload_json p from journal_event').all() as { type: string; p: string }[];
  expect(rows.some((r) => r.type === 'sent')).toBe(true);
  for (const r of rows) expect(r.p).not.toMatch(/f\.req=|(^|[&"\\])at=/);
});

// A sent+response pair for `prompt` produced by an independent fake: a request this runner never clicked.
async function foreign(prompt: string) {
  const f = createFakeDriver(['image-ok']);
  const got: DriverEvent[] = [];
  f.onEvent((e) => got.push(e));
  await f.prepare('x', { prompt, kind: 'image', settings: {}, refIds: [] });
  await f.click('x', 1);
  await flush();
  return got as [Extract<DriverEvent, { type: 'sent' }>, Extract<DriverEvent, { type: 'response' }>];
}
const reqOf = (s: AttemptState) => s.request as unknown as { batchId: string; items: { prompt: string }[] };
const blocks = (db: Db) => db.prepare('select project_id, attempt_id from target_block').all();

test('out-of-order responses settle their own attempt; only the throttled one is resent', async () => {
  const t = rig(['image-ok', 'image-ok', 'throttled', 'image-ok'], { n: 3, hold: true });
  t.runner.start(t.batchId);
  await t.step(4);
  expect(t.driver.ledger.clicks).toBe(3);
  expect(t.held.length).toBe(3);
  const [a, b, c] = t.states().map((s) => s.id);
  const [ha, hb, hc] = t.held.splice(0);
  for (const e of [hc, ha, hb]) t.deliver(e); // C (throttled) first, then A, then B
  await t.step();
  const s = t.states();
  expect(s.map((x) => x.item)).toEqual(['ready', 'ready', 'queued']);
  expect(s[2].resubmits).toBe(1);
  expect(t.runner.caps().image).toBe(6 + 2); // 12 → 6 on the throttle, +1 per ok receipt
  t.clock.t += 30_000;
  await t.step(3);
  t.release();
  await t.step(2);
  expect(t.driver.ledger.clicks).toBe(4);
  expect(t.states().map((x) => x.item)).toEqual(['ready', 'ready', 'ready']);
  const intents = (id: string) => (t.db.prepare("select count(*) c from journal_event where attempt_id=? and type='intent'").get(id) as { c: number }).c;
  expect([intents(a), intents(b), intents(c)]).toEqual([1, 1, 2]);
});

test('a non-generate rpc carrying a throttle frame changes nothing', async () => {
  const t = rig(['throttled'], { n: 1, hold: true });
  t.runner.start(t.batchId);
  await t.step(2);
  const [h] = t.held.splice(0);
  const hr = h as Extract<DriverEvent, { type: 'response' }>;
  t.deliver({ ...hr, rpc: 'jwpduf', text: hr.text.replaceAll('ogiZ0b', 'jwpduf') }); // same throttle frame, but on a poll rpc
  await t.step();
  expect(t.states()[0].item).toBe('submitting');
  expect(t.runner.caps().image).toBe(12);
  expect(t.runner.lastError(t.batchId)).toBeNull();
  t.deliver(h);
  await t.step();
  expect(t.states()[0].item).toBe('queued'); // the real generate response still counts
});

test('a generate response matching no awaiting attempt pauses with ATTRIBUTION_AMBIGUOUS and feeds nobody', async () => {
  const t = rig(['image-ok'], { n: 1, hold: true });
  t.runner.start(t.batchId);
  await t.step(2);
  const [, resp] = await foreign('prompt 0');
  t.deliver(resp);
  await t.step();
  expect(t.states()[0].item).toBe('submitting');
  expect(t.runner.lastError(t.batchId)).toBe('ATTRIBUTION_AMBIGUOUS');
  expect(batchRow(t.db, t.batchId).status).toBe('paused');
});

test('fast mode: a sent goes to the attempt waiting on its own tab', async () => {
  const t = rig(['image-ok', 'image-ok'], { n: 2, speed: 'fast', tabs: ['t1', 't2'], hold: true });
  t.runner.start(t.batchId);
  await t.step(2);
  const s = t.states();
  expect(s.map((x) => x.item)).toEqual(['submitting', 'submitting']);
  expect(s.map((x) => reqOf(x).items[0].prompt)).toEqual(['prompt 0', 'prompt 1']);
});

test('stop on a manual awaiting_user attempt sends skip with a fresh ping → cancelled, no credit', async () => {
  const t = rig([], { n: 1, mode: 'manual' });
  t.runner.start(t.batchId);
  await t.step(2);
  expect(t.states()[0].item).toBe('awaiting_user');
  t.runner.stop(t.batchId);
  expect(t.states()[0].item).toBe('awaiting_user');
  await t.step();
  const a = t.states()[0];
  expect(a.item).toBe('cancelled');
  expect(a.creditSpent).toBe(false);
  const [sent] = await foreign('prompt 0'); // the user's request reaches the desktop after the skip
  t.driver.emit({ ...sent, tabId: 't1' });
  await t.step();
  const b = t.states()[0];
  expect([b.item, b.stage, b.creditSpent]).toEqual(['needs_review', 'uncertain', true]);
  expect(blocks(t.db)).toEqual([{ project_id: 'p', attempt_id: a.id }]);
});

test('a sent already received when stop is ticked is processed before skip: never cancelled', async () => {
  const t = rig([], { n: 1, mode: 'manual' });
  t.runner.start(t.batchId);
  await t.step(2);
  const [sent] = await foreign('prompt 0');
  t.runner.stop(t.batchId);
  t.driver.emit({ ...sent, tabId: 't1' });
  await t.step();
  const a = t.states()[0];
  expect(a.item).toBe('submitting');
  expect(reqOf(a).items[0].prompt).toBe('prompt 0');
});

test('disconnected fences attempts awaiting a response on that tab', async () => {
  const t = rig(['image-ok', 'image-ok'], { n: 2, hold: true });
  t.runner.start(t.batchId);
  await t.step(2);
  t.driver.emit({ tabId: 't1', type: 'disconnected' });
  await t.step();
  const [a, b] = t.states();
  expect([a.item, a.stage]).toEqual(['needs_review', 'uncertain']);
  expect([b.item, b.stage]).toEqual(['needs_review', 'uncertain']);
  expect(blocks(t.db).length).toBe(1);
  expect(t.driver.ledger.clicks).toBe(2);
});

test('stop while the click is pending ends uncertain and blocks the project', async () => {
  const t = rig(['image-ok', 'image-ok'], { n: 2, slowClick: true });
  t.runner.start(t.batchId);
  const tick = t.runner.tick();
  await flush();
  t.runner.stop(t.batchId);
  t.openClick();
  await tick;
  await flush();
  await t.step(2);
  const a = t.states()[0];
  expect([a.item, a.stage]).toEqual(['needs_review', 'uncertain']);
  expect(blocks(t.db)).toEqual([{ project_id: 'p', attempt_id: a.id }]);
  expect(t.states()[1].item).toBe('cancelled');
  expect(t.runner.lastError(t.batchId)).not.toBe('ILLEGAL_TRANSITION');
});

test('SUBMIT_LISTENER_MISSING pauses once; resume clicks the next and stays running', async () => {
  const t = rig(['image-ok', 'image-ok'], { n: 2, noListener: true });
  t.runner.start(t.batchId);
  await t.step(2);
  expect(batchRow(t.db, t.batchId).status).toBe('paused');
  expect(t.driver.ledger.clicks).toBe(0);
  t.runner.resume(t.batchId);
  await t.step(6);
  expect(t.driver.ledger.clicks).toBe(2);
  expect(batchRow(t.db, t.batchId).status).toBe('running');
  expect(t.runner.lastError(t.batchId)).toBeNull();
});

test('unparseable sent: uncertain, project blocked, paused PROTOCOL_DRIFT', async () => {
  const t = rig(['image-ok', 'image-ok'], { n: 2, corruptSent: true, hold: true });
  t.runner.start(t.batchId);
  await t.step(3);
  const a = t.states()[0];
  expect([a.item, a.stage]).toEqual(['needs_review', 'uncertain']);
  expect(blocks(t.db)).toEqual([{ project_id: 'p', attempt_id: a.id }]);
  expect(t.runner.lastError(t.batchId)).toBe('PROTOCOL_DRIFT');
  expect(t.driver.ledger.clicks).toBe(1);
});

test('stop during prepare is a normal exit: no pause, no error log', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  let stopped = false;
  const t = rig(['image-ok'], { n: 1, afterPrepare: (_db, r) => { if (!stopped) { stopped = true; r.stop(t.batchId); } } });
  t.runner.start(t.batchId);
  await t.step(2);
  expect(t.states()[0].item).toBe('cancelled');
  expect(t.driver.ledger.clicks).toBe(0);
  expect(t.runner.lastError(t.batchId)).toBeNull();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('N1: a fresh pause-level error on an attempt whose admission is already pause still pauses', async () => {
  const t = rig(['throttled', 'image-ok'], { n: 2, noListener: true, hold: true });
  t.runner.start(t.batchId);
  await t.step(2);
  expect(batchRow(t.db, t.batchId).status).toBe('paused'); // SUBMIT_LISTENER_MISSING
  t.runner.resume(t.batchId);
  await t.step(); // A clicked, its response held
  const [h] = t.held.splice(0) as Extract<DriverEvent, { type: 'response' }>[];
  // real throttled-ogiZ0b.json response with only the reason string swapped to a pause-level code (no fixture carries one)
  t.deliver({ ...h, text: h.text.replace('PUBLIC_ERROR_USER_REQUESTS_THROTTLED', 'PUBLIC_ERROR_USER_QUOTA_REACHED') });
  await t.step(3);
  expect(t.driver.ledger.clicks).toBe(1); // B never clicked
  expect(batchRow(t.db, t.batchId).status).toBe('paused');
  expect(t.runner.lastError(t.batchId)).toBe('RATE_LIMIT'); // classification keys on the reason string (QUOTA_REACHED → RATE_LIMIT, pause), not grpc 8
});

test('N2: resuming with a still-dead observer pauses again instead of re-preparing every tick', async () => {
  const t = rig(['image-ok', 'image-ok'], { n: 2, deadObserver: true });
  t.runner.start(t.batchId);
  await t.step(3);
  expect(batchRow(t.db, t.batchId).status).toBe('paused');
  const before = t.driver.ledger.prepares;
  t.runner.resume(t.batchId);
  await t.step(6);
  expect(t.driver.ledger.prepares - before).toBe(1);
  expect(batchRow(t.db, t.batchId).status).toBe('paused');
  expect(t.driver.ledger.clicks).toBe(0);
});

test('N3: a response whose request is unparseable is never fed to the single awaiting attempt', async () => {
  const t = rig(['image-ok'], { n: 1, hold: true });
  t.runner.start(t.batchId);
  await t.step(2);
  const [h] = t.held.splice(0) as Extract<DriverEvent, { type: 'response' }>[];
  t.deliver({ ...h, request: 'garbage' });
  await t.step();
  expect(t.states()[0].item).toBe('submitting');
  expect(t.runner.lastError(t.batchId)).toBe('ATTRIBUTION_AMBIGUOUS');
  expect(batchRow(t.db, t.batchId).status).toBe('paused');
});

test('N4: ProtocolDrift on a matched response blames the matched attempt\'s batch, not the tab slot\'s', async () => {
  const t = rig(['image-ok', 'image-ok'], { n: 1, hold: true });
  const { batchId: b2 } = enqueueBatch(t.db, { commandId: 'c2', kind: 'image', projectId: 'p', settings: {}, mode: 'auto', prompts: ['other'], refs: [[]] });
  t.runner.start(t.batchId); t.runner.start(b2);
  await t.step(4); // A (batch 1) sent, then B (batch 2) clicked on the same tab → slot is B
  expect(t.driver.ledger.clicks).toBe(2);
  const [ha] = t.held.splice(0) as Extract<DriverEvent, { type: 'response' }>[];
  t.deliver({ ...ha, text: 'garbage' });
  await t.step();
  expect(t.runner.lastError(t.batchId)).toBe('PROTOCOL_DRIFT');
  expect(t.runner.lastError(b2)).toBeNull();
  expect(batchRow(t.db, t.batchId).status).toBe('paused');
  expect(batchRow(t.db, b2).status).toBe('running');
  const a = t.states()[0];
  expect([a.item, a.stage]).toEqual(['needs_review', 'uncertain']);
  expect(blocks(t.db)).toEqual([{ project_id: 'p', attempt_id: a.id }]);
  await t.step(4);
  expect(t.driver.ledger.clicks).toBe(2); // project blocked: batch 2 gets no further clicks
});

test('R25: a stale pause admission does not pause on a later throttled response after stop', async () => {
  const t = rig(['throttled', 'image-ok'], { n: 2, noListener: true, hold: true });
  t.runner.start(t.batchId);
  await t.step(2);
  t.runner.resume(t.batchId);
  await t.step(); // A clicked, its response held
  t.runner.stop(t.batchId);
  const [h] = t.held.splice(0) as Extract<DriverEvent, { type: 'response' }>[];
  t.deliver(h);
  await t.step(3);
  expect(batchStatus(t.db, t.batchId)).toBe('stopped');
  expect(t.runner.lastError(t.batchId)).toBeNull();
});

test('R25: GENERATION_ALREADY_IN_PROGRESS is uncertain: needs_review, credit spent, project blocked', async () => {
  const t = rig(['throttled', 'image-ok'], { n: 2, hold: true });
  t.runner.start(t.batchId);
  await t.step(2);
  const [h] = t.held.splice(0) as Extract<DriverEvent, { type: 'response' }>[];
  t.deliver({ ...h, text: h.text.replace('PUBLIC_ERROR_USER_REQUESTS_THROTTLED', 'PUBLIC_ERROR_GENERATION_ALREADY_IN_PROGRESS') });
  await t.step(3);
  const a = t.states()[0];
  expect([a.item, a.stage, a.creditSpent]).toEqual(['needs_review', 'uncertain', true]);
  expect(blocks(t.db)).toEqual([{ project_id: 'p', attempt_id: a.id }]);
});

test('a duplicate delivery of a settled response changes nothing', async () => {
  const t = rig(['image-ok'], { n: 1, hold: true });
  t.runner.start(t.batchId);
  await t.step(2);
  const [h] = t.held.splice(0);
  t.deliver(h);
  await t.step();
  const settled = JSON.stringify(t.states());
  expect(t.states()[0].item).toBe('ready');
  t.deliver(h);
  await t.step(2);
  expect(JSON.stringify(t.states())).toBe(settled);
  expect(t.runner.lastError(t.batchId)).toBeNull();
  expect(t.driver.ledger.clicks).toBe(1);
});
