import { test, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttemptState } from '@toolflow/flow-protocol/attempt';
import { openDb, type Db } from '../src/main/db';
import { enqueueBatch } from '../src/main/batch';
import { applyEvent } from '../src/main/journal';
import { createFakeDriver, type FakeScript } from '../src/main/fake-driver';
import type { DriverEvent, FlowDriver } from '../src/main/driver';
import { createRunner, batchStatus } from '../src/main/runner';

const flush = () => new Promise((r) => setTimeout(r, 0));
// Real fixture project-Zzl0ze.json: lượt 31 (image, observer blind) was clicked at RUN31.clickMs and found 6.5 s later.
const PROJECT = 'b89ba0b5-d5e3-44d9-8d86-1851dd147159';
const RUN31 = { prompt: 'Cận cảnh đĩa bánh cuốn nóng, ảnh chụp đời thường', clickMs: 1793951501654 };
const DEADLINE = 31_000; // past the runner's send deadline (30 s)
const TEN_MIN = 600_000;

function rig(script: FakeScript, o: { file?: string; hold?: boolean; holdSent?: boolean; slowClick?: boolean; clock?: { t: number; now(): number }; manual?: boolean } = {}) {
  const file = o.file ?? join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db');
  const db = openDb(file);
  const clock = o.clock ?? { t: RUN31.clickMs, now() { return this.t; } };
  const fake = createFakeDriver(script);
  const cbs = new Set<(e: DriverEvent) => void>();
  const held: DriverEvent[] = [];
  const gate = { hold: !!o.hold };
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const epochs: number[] = [];
  fake.onEvent((e) => (gate.hold && (e.type === 'response' || (o.holdSent && e.type === 'sent')) ? held.push(e) : cbs.forEach((cb) => cb(e))));
  const driver: FlowDriver & { ledger: typeof fake.ledger } = {
    ...fake,
    click: async (tab, epoch) => { epochs.push(epoch); if (o.slowClick) await opened; return fake.click(tab, epoch); },
    ping: async () => ({ ...(await fake.ping('x')), t: clock.now() }),
    onEvent: (cb) => { cbs.add(cb); return () => cbs.delete(cb); },
  };
  const runner = createRunner({ db, driver, clock, tabs: ['t1'], speed: 'default', autoAllowed: () => true });
  let n = 0;
  const add = (project: string, prompts: string[], kind: 'image' | 'video' = 'image') =>
    enqueueBatch(db, { commandId: `c${n++}`, kind, projectId: project, settings: {}, mode: o.manual ? 'manual' : 'auto', prompts, refs: prompts.map(() => []) }).batchId;
  const step = async (k = 1) => { for (let i = 0; i < k; i++) { await runner.tick(); await flush(); } };
  const states = (batch: string) => (db.prepare('select a.id, a.click_at c, a.reconcile_at r, a.source_attempt_id src, a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(batch) as
    { id: string; c: number | null; r: number | null; src: string | null; j: string }[]).map((r) => ({ ...r, ...(JSON.parse(r.j) as AttemptState) }));
  const release = () => { gate.hold = false; held.splice(0).forEach((e) => cbs.forEach((cb) => cb(e))); };
  return { db, file, clock, driver, fake, runner, add, step, states, deliver: (e: DriverEvent) => cbs.forEach((cb) => cb(e)), release, held, open, epochs };
}
const blocks = (db: Db) => db.prepare('select project_id from target_block').all() as { project_id: string }[];
const ping = (t: number) => ({ xhrSend: true, xhrOpen: true, fetch: true, id: 'o', seq: 1, dropped: 0, t, version: 'x', email: null });
const CLICKED = { found: true, disabled: false, listeners: 1, called: 1 };
/** An attempt as the crashed app left it: intent (and click) committed, nothing else. */
function leave(db: Db, id: string, t: number, clickAt: number | null) {
  applyEvent(db, id, { type: 'prepare', now: t }, t);
  applyEvent(db, id, { type: 'intent', ping: ping(t), now: t }, t);
  if (clickAt !== null) {
    applyEvent(db, id, { type: 'clicked', result: CLICKED }, t);
    db.prepare('update attempt set click_at=? where id=?').run(clickAt, id);
  }
}

test('uncertain releases runner to a batch on another project', async () => {
  const t = rig(['no-request', 'image-ok']);
  const a = t.add(PROJECT, ['a1', 'a2']);
  const b = t.add('P2', ['b1']);
  t.runner.start(a); t.runner.start(b);
  await t.step(2);
  expect(t.driver.ledger.clicks).toBe(1); // a1 clicked, nothing seen: tab waits for its send deadline
  t.clock.t += DEADLINE;
  await t.step(4);
  expect(t.states(a).map((s) => s.item)).toEqual(['needs_review', 'queued']);
  expect(t.states(b)[0].item).toBe('ready');
  expect(t.driver.ledger.clicks).toBe(2); // a2 never clicked
  expect(blocks(t.db)).toEqual([{ project_id: PROJECT }]);
});

test('reconcile after 10 minutes: found resumes batch', async () => {
  const t = rig(['no-request', 'image-ok']);
  const a = t.add(PROJECT, [RUN31.prompt, 'second']);
  t.runner.start(a);
  await t.step(2);
  t.clock.t += DEADLINE;
  await t.step(2);
  const [u] = t.states(a);
  expect([u.item, u.stage, u.c, u.r]).toEqual(['needs_review', 'uncertain', RUN31.clickMs, RUN31.clickMs + TEN_MIN]);
  t.clock.t = RUN31.clickMs + TEN_MIN - 1;
  await t.step(2);
  expect(t.driver.ledger.readProject).toBe(0);
  t.clock.t += 1;
  await t.step(4);
  const [f, s] = t.states(a);
  expect([f.item, f.creditSpent, f.r]).toEqual(['ready', true, null]);
  expect(s.item).toBe('ready');
  expect(blocks(t.db)).toEqual([]);
  expect(t.driver.ledger.clicks).toBe(2);
  expect(t.driver.ledger.readProject).toBe(1);
});

test('not found waits for user; confirm not_sent unblocks and never re-clicks that attempt', async () => {
  const t = rig(['no-request', 'image-ok']);
  const a = t.add(PROJECT, ['not in the listing', 'a2']);
  t.runner.start(a);
  await t.step(2);
  t.clock.t += DEADLINE;
  await t.step(2);
  t.clock.t = RUN31.clickMs + TEN_MIN;
  await t.step(5);
  const [u] = t.states(a);
  expect([u.item, u.r, t.driver.ledger.readProject, t.driver.ledger.clicks]).toEqual(['needs_review', null, 1, 1]);
  expect(batchStatus(t.db, a)).toBe('needs_review');
  expect(blocks(t.db)).toEqual([{ project_id: PROJECT }]);
  expect(JSON.stringify(t.db.prepare("select payload_json from journal_event where type='reconcile'").all())).not.toMatch(/https?:|Signature=/);
  t.runner.confirm(u.id, 'not_sent');
  expect(blocks(t.db)).toEqual([]);
  await t.step(4);
  const [first, second] = t.states(a);
  expect([first.item, (first.error as { userConfirmed?: boolean }).userConfirmed, second.item]).toEqual(['failed', true, 'ready']);
  expect(t.driver.ledger.clicks).toBe(2); // the confirmed attempt was not clicked again
});

test('duplicate prompts both uncertain: same single media inside both windows → both ambiguous, none assigned', async () => {
  const t = rig([]);
  const a = t.add(PROJECT, [RUN31.prompt, RUN31.prompt]);
  const [x, y] = t.states(a);
  leave(t.db, x.id, RUN31.clickMs, RUN31.clickMs);
  leave(t.db, y.id, RUN31.clickMs, RUN31.clickMs + 10_000);
  t.runner.recover();
  t.clock.t = RUN31.clickMs + TEN_MIN + 10_000;
  await t.step(3);
  expect(t.states(a).map((s) => [s.item, s.r])).toEqual([['needs_review', null], ['needs_review', null]]);
  expect(t.states(a).every((s) => s.evidence == null && s.outputs == null)).toBe(true);
  expect(blocks(t.db)).toEqual([{ project_id: PROJECT }]);
  expect(t.driver.ledger.clicks).toBe(0);
});

test('crash after intent commit, before click: recover makes it uncertain, no click, reconcile scheduled', async () => {
  const t = rig([]);
  const a = t.add(PROJECT, ['p1']);
  t.runner.start(a);
  leave(t.db, t.states(a)[0].id, RUN31.clickMs, null);
  t.db.close();
  const t2 = rig(['image-ok'], { file: t.file, clock: t.clock });
  t2.runner.recover();
  const [s] = t2.states(a);
  expect([s.item, s.stage, (s.error as { why?: string }).why, s.creditSpent]).toEqual(['needs_review', 'uncertain', 'restart', true]);
  expect(s.r).toBe(RUN31.clickMs + TEN_MIN);
  expect(blocks(t2.db)).toEqual([{ project_id: PROJECT }]);
  await t2.step(3);
  expect(t2.driver.ledger.clicks).toBe(0);
});

test('restart reschedules overdue reconcile, and rebuilds a lost target_block', async () => {
  const t = rig([]);
  const a = t.add(PROJECT, [RUN31.prompt]);
  leave(t.db, t.states(a)[0].id, RUN31.clickMs, RUN31.clickMs);
  t.runner.recover();
  expect(t.states(a)[0].r).toBe(RUN31.clickMs + TEN_MIN);
  t.db.exec('delete from target_block'); // crash between the state write and the block insert
  t.db.close();
  t.clock.t = RUN31.clickMs + 2 * TEN_MIN; // app was closed past reconcile_at
  const t2 = rig([], { file: t.file, clock: t.clock });
  t2.runner.recover();
  expect(blocks(t2.db)).toEqual([{ project_id: PROJECT }]);
  expect(t2.driver.ledger.readProject).toBe(0);
  await t2.step();
  expect(t2.driver.ledger.readProject).toBe(1);
  expect(t2.states(a)[0].item).toBe('ready');
  expect(blocks(t2.db)).toEqual([]);
});

test('recover leaves a block only for projects that still have an unresolved attempt', async () => {
  const t = rig([]);
  const a = t.add(PROJECT, ['p1']);
  leave(t.db, t.states(a)[0].id, RUN31.clickMs, RUN31.clickMs);
  t.runner.recover();
  t.runner.confirm(t.states(a)[0].id, 'sent');
  t.db.prepare('insert or ignore into target_block(project_id, attempt_id, since) values(?,?,?)').run(PROJECT, t.states(a)[0].id, 1); // crash after resolve, before unblock
  t.runner.recover();
  expect(blocks(t.db)).toEqual([]);
});

test('archive releases runner immediately but keeps block', async () => {
  const t = rig(['no-request', 'image-ok']);
  const a = t.add(PROJECT, ['a1', 'a2']);
  const b = t.add('P2', ['b1']);
  t.runner.start(a);
  await t.step(2);
  t.clock.t += DEADLINE;
  await t.step(2);
  t.runner.archive(a);
  t.runner.start(b);
  await t.step(3);
  expect((t.db.prepare('select archived from batch where id=?').get(a) as { archived: number }).archived).toBe(1);
  expect(t.states(b)[0].item).toBe('ready');
  expect(t.states(a).map((s) => s.item)).toEqual(['needs_review', 'queued']);
  expect(blocks(t.db)).toEqual([{ project_id: PROJECT }]);
});

test('archive is refused while a click is in flight', async () => {
  const t = rig(['image-ok'], { slowClick: true });
  const a = t.add(PROJECT, ['a1']);
  t.runner.start(a);
  const tick = t.runner.tick();
  await flush();
  expect(() => t.runner.archive(a)).toThrow(expect.objectContaining({ code: 'CLICK_IN_FLIGHT' }));
  expect((t.db.prepare('select archived from batch where id=?').get(a) as { archived: number }).archived).toBe(0);
  t.open(); await tick; await flush();
});

test('archive is refused while an item awaits the user; after stop → skip it is allowed and the tab is free', async () => {
  const t = rig(['no-request', 'image-ok'], { manual: true });
  const a = t.add(PROJECT, ['a1']);
  t.runner.start(a);
  await t.step(2);
  expect(t.states(a)[0].item).toBe('awaiting_user');
  expect(() => t.runner.archive(a)).toThrow(expect.objectContaining({ code: 'CLICK_IN_FLIGHT' }));
  t.runner.stop(a);
  await t.step(2);
  t.runner.archive(a);
  expect((t.db.prepare('select archived from batch where id=?').get(a) as { archived: number }).archived).toBe(1);
  expect(t.states(a)[0].item).toBe('cancelled'); // nothing was sent
  const b = t.add('P2', ['b1']);
  t.runner.start(b);
  await t.step(2);
  expect(t.states(b)[0].item).toBe('awaiting_user'); // the tab is free again
});

test('rerun needs confirmation and links the old attempt', async () => {
  const t = rig(['no-request', 'image-ok', 'image-ok']);
  const a = t.add(PROJECT, ['a1', 'a2']);
  t.runner.start(a);
  await t.step(2);
  t.clock.t += DEADLINE;
  await t.step(2);
  const [old] = t.states(a);
  expect(() => t.runner.rerun(old.id, true)).toThrow(expect.objectContaining({ code: 'TARGET_BLOCKED' }));
  t.runner.confirm(old.id, 'not_sent');
  const id = t.runner.rerun(old.id, true);
  const row = t.db.prepare('select source_attempt_id src, ordinal from attempt where id=?').get(id) as { src: string; ordinal: number };
  expect([db_attempt(t.db, id).item, row.src, row.ordinal]).toEqual(['queued', old.id, 2]);
  expect((db_attempt(t.db, old.id).error as { userConfirmed?: boolean }).userConfirmed).toBe(true);
  expect(db_attempt(t.db, old.id).item).toBe('failed');
  expect(t.states(a)[0].id).toBe(id); // the item now points at the new attempt
  expect(() => t.runner.rerun(old.id, true)).toThrow(expect.objectContaining({ code: 'ALREADY_RERUN' })); // already rerun: no second paid copy
  await t.step(6);
  expect(db_attempt(t.db, id).item).toBe('ready');
  expect(t.driver.ledger.clicks).toBe(3);
});
const db_attempt = (db: Db, id: string) => JSON.parse((db.prepare('select state_json j from attempt where id=?').get(id) as { j: string }).j) as AttemptState;

test('stale epoch response ignored; the next click carries the new epoch', async () => {
  const t = rig(['image-ok', 'no-request'], { hold: true, holdSent: true });
  const a = t.add(PROJECT, ['a1']);
  const b = t.add('P2', ['b1']);
  t.runner.start(a);
  await t.step(); // A clicked at epoch 1; its sent and response are still on the old connection
  t.deliver({ tabId: 't1', type: 'disconnected' });
  await t.step();
  expect(t.states(a)[0].item).toBe('needs_review');
  t.runner.start(b);
  await t.step(); // B clicked at epoch 2, nothing seen yet
  expect(t.epochs).toEqual([RUN31.clickMs, RUN31.clickMs + 1]);
  const before = JSON.stringify([t.states(a), t.states(b)]);
  t.release(); // epoch-1 sent + response arrive now: they must not be taken for B's request
  await t.step(2);
  expect(JSON.stringify([t.states(a), t.states(b)])).toBe(before);
  expect(t.states(b)[0].item).toBe('submitting');
});

const batchRow = (db: Db, id: string) => (db.prepare('select status from batch where id=?').get(id) as { status: string }).status;

test('C1: a send deadline fences the tab, so the late sent/response of A never bind to B', async () => {
  const t = rig(['image-ok', 'no-request'], { hold: true, holdSent: true });
  const a = t.add(PROJECT, [RUN31.prompt]);
  const b = t.add('P2', [RUN31.prompt]); // same prompt: the nastiest case
  t.runner.start(a);
  await t.step(); // A clicked at epoch 1; its sent + response are held back
  t.clock.t += DEADLINE;
  await t.step(); // A: deadline → uncertain, tab fenced
  expect(t.states(a)[0].item).toBe('needs_review');
  t.runner.start(b);
  await t.step();
  expect(t.epochs).toEqual([RUN31.clickMs, RUN31.clickMs + 1]);
  const before = JSON.stringify(t.states(b));
  t.release(); // epoch-1 sent + response arrive late
  await t.step(2);
  expect(JSON.stringify(t.states(b))).toBe(before);
  expect(t.states(b)[0].item).toBe('submitting');
  expect(t.states(a)[0].item).toBe('needs_review');
  t.clock.t = RUN31.clickMs + TEN_MIN;
  await t.step(3);
  expect(t.states(a)[0].item).toBe('ready'); // reconcile still finds A's media: it was never taken by B
  expect(t.states(b)[0].outputs ?? null).toBeNull();
});

test('I1: a user pause survives the uncertain attempt being resolved', async () => {
  const t = rig(['no-request', 'image-ok']);
  const a = t.add(PROJECT, [RUN31.prompt, 'second']);
  t.runner.start(a);
  await t.step(2);
  t.runner.pause(a);
  t.clock.t += DEADLINE;
  await t.step(2);
  expect(t.states(a)[0].item).toBe('needs_review');
  t.clock.t = RUN31.clickMs + TEN_MIN;
  await t.step(3);
  expect(t.states(a)[0].item).toBe('ready');
  expect([batchRow(t.db, a), t.driver.ledger.clicks]).toEqual(['paused', 1]);
  t.runner.resume(a);
  await t.step(3);
  expect(t.states(a)[1].item).toBe('ready');
});

test('I1: a PROTOCOL_DRIFT pause survives the uncertain attempt being resolved', async () => {
  const t = rig(['no-request', 'image-ok']);
  const a = t.add(PROJECT, [RUN31.prompt, 'second']);
  t.runner.start(a);
  await t.step(2);
  t.deliver({ tabId: 't1', type: 'sent', epoch: t.epochs[0], request: 'garbage' }); // unreadable: uncertain, then drift pause
  await t.step();
  expect([t.states(a)[0].item, t.runner.lastError(a)]).toEqual(['needs_review', 'PROTOCOL_DRIFT']);
  t.clock.t = RUN31.clickMs + TEN_MIN;
  await t.step(3);
  expect(t.states(a)[0].item).toBe('ready');
  expect([batchRow(t.db, a), t.runner.lastError(a), t.driver.ledger.clicks]).toEqual(['paused', 'PROTOCOL_DRIFT', 1]);
});

test('I2: a drop mid-click still starts the reconcile window at the click', async () => {
  const t = rig(['drop']);
  const a = t.add(PROJECT, [RUN31.prompt]);
  t.runner.start(a);
  await t.step(2);
  const [u] = t.states(a);
  expect([u.item, u.c, u.r]).toEqual(['needs_review', RUN31.clickMs, RUN31.clickMs + TEN_MIN]);
  t.clock.t = RUN31.clickMs + TEN_MIN;
  await t.step(3);
  expect(t.states(a)[0].item).toBe('ready');
});

test('I2: with click_at null (crash between intent and click write) reconcile uses the intent time', async () => {
  const t = rig([]);
  const a = t.add(PROJECT, [RUN31.prompt]);
  leave(t.db, t.states(a)[0].id, RUN31.clickMs, null);
  t.runner.recover();
  t.clock.t = RUN31.clickMs + TEN_MIN + 1_000_000; // reconcile time far from the click
  await t.step(2);
  expect(t.states(a)[0].item).toBe('ready');
});

test('I3: the block stays until the last uncertain attempt of the project is settled', async () => {
  const t = rig(['image-ok']);
  const a = t.add(PROJECT, ['u1', 'u2', 'u3']);
  t.runner.start(a);
  const [x, y] = t.states(a);
  leave(t.db, x.id, RUN31.clickMs, RUN31.clickMs);
  leave(t.db, y.id, RUN31.clickMs, RUN31.clickMs);
  t.runner.recover();
  t.runner.confirm(x.id, 'not_sent');
  expect(blocks(t.db)).toEqual([{ project_id: PROJECT }]);
  expect(() => t.runner.rerun(x.id, true)).toThrow(expect.objectContaining({ code: 'TARGET_BLOCKED' }));
  await t.step(3);
  expect([batchStatus(t.db, a), t.driver.ledger.clicks]).toEqual(['needs_review', 0]); // y still holds the pause
  expect(t.runner.lastError(a)).not.toBeNull();
  t.runner.confirm(y.id, 'sent');
  expect(blocks(t.db)).toEqual([]);
  await t.step(3);
  expect([batchRow(t.db, a), t.driver.ledger.clicks, t.states(a)[2].item]).toEqual(['running', 1, 'ready']);
});

test('I4: archiving a batch with generating attempts keeps counting them against the caps', async () => {
  const t = rig(Array(9).fill('video-ok') as FakeScript);
  const a = t.add(PROJECT, Array.from({ length: 8 }, (_, i) => `v${i}`), 'video');
  t.runner.start(a);
  await t.step(10);
  expect([t.driver.ledger.clicks, t.runner.inFlight().video]).toEqual([8, 8]);
  t.runner.archive(a);
  expect(t.runner.inFlight().video).toBe(8);
  const b = t.add(PROJECT + '-2', ['w0'], 'video');
  t.runner.start(b);
  await t.step(3);
  expect(t.driver.ledger.clicks).toBe(8); // cap 8 still full
});

test('archive keeps following a sent attempt: its held response still settles it', async () => {
  const t = rig(['image-ok'], { hold: true });
  const a = t.add(PROJECT, ['a1']);
  t.runner.start(a);
  await t.step(2); // sent seen, response held
  expect(t.states(a)[0].item).toBe('submitting');
  t.runner.archive(a);
  t.release();
  await t.step(2);
  expect(t.states(a)[0].item).toBe('ready');
  expect(blocks(t.db)).toEqual([]);
});

test('unread listing is journaled as READ_FAILED and the attempt keeps waiting', async () => {
  const t = rig([]);
  const a = t.add(PROJECT, ['p1']);
  leave(t.db, t.states(a)[0].id, RUN31.clickMs, RUN31.clickMs);
  t.runner.recover();
  t.driver.readProject = async () => { throw new Error('boom'); };
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  t.clock.t = RUN31.clickMs + TEN_MIN;
  await t.step(2);
  expect(err).toHaveBeenCalled(); err.mockRestore();
  const ev = (t.db.prepare("select payload_json p from journal_event where type='reconcile'").all() as { p: string }[]).map((r) => JSON.parse(r.p));
  expect(ev).toHaveLength(1);
  expect(ev[0].evidence.why).toBe('READ_FAILED');
  expect(t.states(a)[0].item).toBe('needs_review');
});

test('confirm() landing while readProject is awaited: reconcile returns quietly', async () => {
  const t = rig(['image-ok']);
  const a = t.add(PROJECT, [RUN31.prompt, 'p2']); // the listing holds p1: without the re-check this would be 'found' on a failed attempt
  t.runner.start(a);
  const x = t.states(a)[0];
  leave(t.db, x.id, RUN31.clickMs, RUN31.clickMs);
  t.runner.recover();
  const read = t.driver.readProject; let go!: () => void;
  const gate = new Promise<void>((r) => { go = r; });
  t.driver.readProject = async (p) => { await gate; return read(p); };
  t.clock.t = RUN31.clickMs + TEN_MIN;
  const tick = t.runner.tick();
  await flush();
  t.runner.confirm(x.id, 'not_sent');
  go(); await tick;
  expect(t.runner.lastError(a)).toBeNull();
  expect(batchRow(t.db, a)).toBe('running');
});

test('restart: a batch paused only by an uncertain attempt auto-resumes once reconcile settles it', async () => {
  const t = rig(['image-ok']);
  const a = t.add(PROJECT, [RUN31.prompt, 'second']);
  t.runner.start(a);
  leave(t.db, t.states(a)[0].id, RUN31.clickMs, RUN31.clickMs);
  t.runner.recover();
  await t.step();
  t.db.close();
  t.clock.t = RUN31.clickMs + TEN_MIN;
  const t2 = rig(['image-ok'], { file: t.file, clock: t.clock });
  t2.runner.recover();
  await t2.step(4); // no resume() call
  expect(t2.states(a).map((s) => s.item)).toEqual(['ready', 'ready']);
  expect(t2.driver.ledger.clicks).toBe(1);
});

test('a click that throws without a disconnect still fences the tab', async () => {
  const t = rig(['no-request'], { hold: true, holdSent: true });
  const click = t.driver.click; let first = true;
  t.driver.click = async (tab, e) => { if (first) { first = false; throw new Error('gone'); } return click(tab, e); };
  const a = t.add(PROJECT, ['a1']);
  const b = t.add('P2', ['b1']);
  t.runner.start(a);
  await t.step(2);
  expect(t.states(a)[0].item).toBe('needs_review');
  t.runner.start(b);
  await t.step(2);
  expect(t.epochs).toEqual([RUN31.clickMs + 1]);
  const before = JSON.stringify(t.states(b));
  t.deliver({ tabId: 't1', type: 'sent', epoch: RUN31.clickMs, request: 'late' }); // old epoch: must not bind to B
  await t.step();
  expect(JSON.stringify(t.states(b))).toBe(before);
  expect(t.states(b)[0].item).toBe('submitting');
});

test('R38: a restarted runner seeds epochs from the clock, so a late event of the previous run is ignored', async () => {
  const t = rig(['no-request'], { hold: true, holdSent: true });
  const a = t.add(PROJECT, ['a1']);
  const b = t.add('P2', ['b1']); // queued before the restart (command ids are per rig)
  t.runner.start(a);
  await t.step();
  const eA = t.epochs[0];
  t.db.close();
  t.clock.t += TEN_MIN;
  const t2 = rig(['no-request'], { file: t.file, clock: t.clock });
  t2.runner.recover();
  t2.runner.start(b);
  await t2.step();
  expect(t2.epochs[0]).toBeGreaterThan(eA);
  const before = JSON.stringify(t2.states(b));
  t2.deliver({ tabId: 't1', type: 'sent', epoch: eA, request: 'late' });
  await t2.step();
  expect(JSON.stringify(t2.states(b))).toBe(before);
  expect(t2.states(b)[0].item).toBe('submitting');
});
