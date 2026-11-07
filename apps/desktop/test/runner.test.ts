import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initial, type AttemptState } from '@toolflow/flow-protocol/attempt';
import { openDb, type Db } from '../src/main/db';
import { enqueueBatch } from '../src/main/batch';
import { createFakeDriver, type FakeScript } from '../src/main/fake-driver';
import type { DriverEvent, FlowDriver } from '../src/main/driver';
import { createRunner, batchStatus } from '../src/main/runner';

const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(script: FakeScript, o: { kind?: 'image' | 'video'; n: number; speed?: 'default' | 'fast'; tabs?: string[]; mode?: 'auto' | 'manual'; auto?: boolean; hold?: boolean; check?: FlowDriver['checkBeforeClick']; afterPrepare?: (db: Db) => void }) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  const clock = { t: Date.now(), now() { return this.t; } };
  const fake = createFakeDriver(script);
  const cbs = new Set<(e: DriverEvent) => void>();
  const held: DriverEvent[] = [];
  const gate = { hold: !!o.hold };
  fake.onEvent((e) => (gate.hold && e.type === 'response' ? held.push(e) : cbs.forEach((cb) => cb(e))));
  const driver: FlowDriver & { ledger: typeof fake.ledger } = {
    ...fake,
    ping: async () => ({ ...(await fake.ping('x')), t: clock.now() }), // the observer ping must look fresh to the fake clock
    prepare: async (tab, p) => { const r = await fake.prepare(tab, p); o.afterPrepare?.(db); return r; },
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
  return { db, clock, driver, runner, batchId, step, release, states };
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
