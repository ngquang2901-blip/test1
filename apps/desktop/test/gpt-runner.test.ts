import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttemptState } from '@toolflow/flow-protocol/attempt';
import { openDb } from '../src/main/db';
import { enqueueBatch } from '../src/main/batch';
import { createFakeGpt, isGptMedia, type GptScript } from '../src/main/gpt-driver';
import { createGptRunner, routeRunner, GPT_TURNS_PER_CONV } from '../src/main/gpt-runner';
import { createFakeDriver, FAKE_COMBOS } from '../src/main/fake-driver';
import { batchStatus, createRunner } from '../src/main/runner';

type FakeOpts = Parameters<typeof createFakeGpt>[1];
function rig(script: GptScript[], prompts: string[], o: { fake?: FakeOpts; start?: boolean } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-gpt-')), 't.db'));
  const clock = { t: 1_800_000_000_000, now() { return this.t; } };
  const fake = createFakeGpt(script, o.fake);
  const downloads: string[] = [];
  const gpt = createGptRunner({ db, driver: fake.driver, clock, pollMs: 0, sleep: async () => undefined, download: async (b) => { downloads.push(`${b}:${fake.ledger.sends.length}`); } });
  const flowFake = createFakeDriver([]);
  const flow = createRunner({ db, driver: flowFake, clock, tabs: ['t1'], speed: 'default', combos: FAKE_COMBOS, autoAllowed: () => true, projectOf: () => 'p-flow' });
  const runner = routeRunner(flow, gpt);
  const add = (list: string[], id = 'c1'): string => enqueueBatch(db, { commandId: id, kind: 'image', provider: 'chatgpt', projectId: null, settings: { provider: 'chatgpt' }, prompts: list, refs: list.map(() => []), mode: 'auto' }).batchId;
  const batch = add(prompts);
  if (o.start !== false) runner.start(batch);
  const states = (b = batch): AttemptState[] => (db.prepare('select a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(b) as { j: string }[]).map((r) => JSON.parse(r.j));
  const ids = (b = batch): string[] => (db.prepare('select attempt_id a from item where batch_id=? order by ord').all(b) as { a: string }[]).map((r) => r.a);
  const journal = (id: string): string[] => (db.prepare('select type from journal_event where attempt_id=? order by id').all(id) as { type: string }[]).map((r) => r.type);
  const status = (b = batch): string => (db.prepare('select status from batch where id=?').get(b) as { status: string }).status;
  const ticks = async (n: number, ms = 0): Promise<void> => { for (let i = 0; i < n; i++) { clock.t += ms; await runner.tick(); } };
  return { db, clock, fake, gpt, flow, flowFake, runner, batch, add, states, ids, journal, status, ticks, downloads };
}
const items = (s: AttemptState[]): string => s.map((x) => x.item).join(',');

test('two prompts: one new conversation for the batch, sent one after another, each ready with its image id', async () => {
  const t = rig([], ['a red kite', 'a blue door']);
  await t.ticks(1);
  expect(t.fake.ledger.sends).toEqual(['a red kite']);
  expect(items(t.states())).toBe('submitting,queued');
  await t.ticks(1);
  expect(items(t.states())).toBe('generating,queued'); // the turn with exactly this prompt showed up
  expect(t.fake.ledger.sends).toHaveLength(1); // the second prompt waits for the first to finish
  await t.ticks(6);
  expect(items(t.states())).toBe('ready,ready');
  expect(t.fake.ledger.sends).toEqual(['a red kite', 'a blue door']);
  expect(t.fake.ledger.newChats).toBe(1);
  const s = t.states();
  expect(s.every((x) => x.outputs!.length === 1 && isGptMedia(x.outputs![0].mediaId))).toBe(true);
  expect(s[0].request.conv).toBe(s[1].request.conv);
  expect(s[0].creditSpent).toBe(true);
  expect(t.journal(t.ids()[0])).toEqual(['prepare', 'intent', 'clicked', 'turn', 'ready']); // the intent is written before the click
  expect(t.journal(t.ids()[1])).toEqual(['prepare', 'intent', 'clicked', 'turn', 'ready']);
  expect(batchStatus(t.db, t.batch)).toBe('completed');
  expect(t.downloads).toEqual([`${t.batch}:1`, `${t.batch}:2`]); // each image is saved before the next prompt goes out
});

test('a ChatGPT batch and a Flow batch never touch each other', async () => {
  const t = rig([], ['a red kite'], { start: false });
  const flowBatch = enqueueBatch(t.db, { commandId: 'f1', kind: 'image', projectId: 'p-flow', settings: { combo: FAKE_COMBOS[0] }, prompts: ['flow prompt'], refs: [[]], mode: 'auto' }).batchId;
  t.runner.start(t.batch);
  for (let i = 0; i < 5; i++) await t.flow.tick(); // the Flow runner alone: the ChatGPT batch is not its business
  expect(items(t.states())).toBe('queued');
  expect(t.flowFake.ledger.clicks).toBe(0);
  for (let i = 0; i < 2; i++) await t.gpt.tick(); // the ChatGPT runner alone: the queued Flow batch is not its business
  expect(items(t.states())).toBe('generating');
  expect(items(t.states(flowBatch))).toBe('queued');
  expect(t.flow.inFlight()).toEqual({ image: 0, video: 0 }); // a ChatGPT image in flight takes no Flow slot
  t.flow.recover(); // Flow's restart recovery leaves it alone too
  expect(items(t.states())).toBe('generating');
});

test('an answer without an image: the item fails with GPT_NO_IMAGE, the batch pauses, and Tiếp tục sends the next prompt', async () => {
  const t = rig(['text'], ['a red kite', 'a blue door']);
  await t.ticks(4);
  expect(items(t.states())).toBe('generating,queued'); // complete without an image is not final at once: the image can render late
  await t.ticks(2, 15_000);
  expect(items(t.states())).toBe('failed,queued');
  expect(t.states()[0].error.code).toBe('GPT_NO_IMAGE');
  expect(t.status()).toBe('paused');
  expect(t.runner.lastError(t.batch)).toBe('GPT_NO_IMAGE');
  await t.ticks(3);
  expect(t.fake.ledger.sends).toHaveLength(1); // paused: nothing more goes out
  t.runner.resume(t.batch);
  await t.ticks(6);
  expect(items(t.states())).toBe('failed,ready');
  expect(t.runner.lastError(t.batch)).toBeNull();
  expect(batchStatus(t.db, t.batch)).toBe('partial_failed');
});

test('no turn after the click: needs review, never sent again; the next prompt waits for the user\'s answer', async () => {
  const t = rig(['lost'], ['a red kite', 'a blue door']);
  await t.ticks(3);
  expect(items(t.states())).toBe('submitting,queued');
  await t.ticks(2, 20_000);
  expect(items(t.states())).toBe('needs_review,queued');
  expect(t.states()[0].error.code).toBe('SUBMIT_UNCERTAIN');
  expect(batchStatus(t.db, t.batch)).toBe('needs_review');
  await t.ticks(5, 20_000);
  expect(t.fake.ledger.sends).toEqual(['a red kite']);
  t.runner.confirm(t.ids()[0], 'not_sent');
  await t.ticks(8);
  expect(items(t.states())).toBe('failed,ready');
  expect(t.fake.ledger.sends).toEqual(['a red kite', 'a blue door']);
});

test('a turn that is not our prompt shows up instead: needs review as USER_INTERFERENCE', async () => {
  const t = rig(['foreign'], ['a red kite']);
  await t.ticks(2);
  expect(items(t.states())).toBe('submitting');
  await t.ticks(2, 20_000);
  expect(t.states()[0].item).toBe('needs_review');
  expect(t.states()[0].error.code).toBe('USER_INTERFERENCE');
});

test('the user moved the tab to another chat between two prompts: the batch pauses and nothing is typed there; Tiếp tục reopens the batch\'s conversation', async () => {
  const t = rig([], ['a red kite', 'a blue door']);
  await t.ticks(3);
  expect(items(t.states())).toBe('ready,queued');
  const conv = t.states()[0].request.conv;
  t.fake.userLeaves();
  await t.ticks(3);
  expect(t.status()).toBe('paused');
  expect(t.runner.lastError(t.batch)).toBe('GPT_CONVERSATION_CHANGED');
  expect(t.fake.ledger.sends).toHaveLength(1);
  expect(t.fake.page.text).toBe('');
  expect(t.states()[1].item).toBe('preparing'); // not failed: it goes on after the pause
  t.runner.resume(t.batch);
  await t.ticks(6);
  expect(t.fake.ledger.opens).toEqual([conv]);
  expect(items(t.states())).toBe('ready,ready');
  expect(t.states()[1].request.conv).toBe(conv);
  expect(t.fake.ledger.newChats).toBe(1);
});

test('something the user typed is in the composer: the batch pauses, the text stays, the item is not failed', async () => {
  const t = rig([], ['a red kite', 'a blue door']);
  await t.ticks(3);
  t.fake.userTypes('my own draft');
  await t.ticks(2);
  expect(t.runner.lastError(t.batch)).toBe('GPT_COMPOSER_NOT_EMPTY');
  expect(t.fake.page.text).toBe('my own draft');
  expect(items(t.states())).toBe('ready,preparing');
  expect(t.fake.ledger.sends).toHaveLength(1);
});

test('no ChatGPT tab: the batch pauses with NO_CHATGPT_TAB and goes on after the tab is there and the user resumes', async () => {
  const t = rig([], ['a red kite'], { fake: { tabs: 0 } });
  await t.ticks(2);
  expect(t.status()).toBe('paused');
  expect(t.runner.lastError(t.batch)).toBe('NO_CHATGPT_TAB');
  expect(items(t.states())).toBe('queued');
  t.fake.openTab(); t.runner.resume(t.batch);
  await t.ticks(4);
  expect(items(t.states())).toBe('ready');
});

test('image mode cannot be turned on, or Send refuses: nothing is sent, the batch pauses with the page\'s code', async () => {
  const a = rig([], ['a red kite'], { fake: { mode: ['MODE_NOT_FOUND'] } });
  await a.ticks(2);
  expect(a.runner.lastError(a.batch)).toBe('GPT_MODE_NOT_FOUND');
  expect(a.fake.ledger.sends).toHaveLength(0);
  expect(items(a.states())).toBe('preparing');
  const b = rig([], ['a red kite'], { fake: { send: ['SEND_DISABLED'] } });
  await b.ticks(2);
  expect(b.runner.lastError(b.batch)).toBe('GPT_SEND_DISABLED');
  expect(b.fake.ledger.sends).toHaveLength(0);
  expect(b.states()[0]).toMatchObject({ item: 'preparing', stage: 'rejected_before_dispatch', clicked: false });
  expect(b.journal(b.ids()[0])).toEqual(['prepare', 'intent', 'not_clicked']);
});

test(`at most ${GPT_TURNS_PER_CONV} turns in one conversation: prompt ${GPT_TURNS_PER_CONV + 1} opens a new one`, async () => {
  const prompts = Array.from({ length: GPT_TURNS_PER_CONV + 1 }, (_, i) => `prompt number ${i + 1}`);
  const t = rig([], prompts);
  await t.ticks(4 * prompts.length);
  const s = t.states();
  expect(s.every((x) => x.item === 'ready')).toBe(true);
  expect(t.fake.ledger.newChats).toBe(2);
  expect(new Set(s.slice(0, GPT_TURNS_PER_CONV).map((x) => x.request.conv)).size).toBe(1);
  expect(s[GPT_TURNS_PER_CONV].request.conv).not.toBe(s[0].request.conv);
});

test('the same prompt twice in one batch: the second send binds to its own new turn, not to the first one', async () => {
  const t = rig([], ['a red kite', 'a red kite']);
  await t.ticks(8);
  const s = t.states();
  expect(items(s)).toBe('ready,ready');
  expect(s[0].request.turnKey).not.toBe(s[1].request.turnKey);
  expect(s[0].outputs![0].mediaId).not.toBe(s[1].outputs![0].mediaId);
});

test('an answer that never finishes: needs review after ten minutes, not a failure and not a resend', async () => {
  const t = rig(['slow'], ['a red kite']);
  await t.ticks(4);
  expect(items(t.states())).toBe('generating');
  await t.ticks(3, 250_000);
  expect(t.states()[0]).toMatchObject({ item: 'needs_review', stage: 'accepted' });
  expect(t.fake.ledger.sends).toHaveLength(1);
});

test('two images in one answer are two outputs', async () => {
  const t = rig(['two'], ['a red kite']);
  await t.ticks(4);
  const out = t.states()[0].outputs!.map((o) => o.mediaId);
  expect(out).toHaveLength(2);
  expect(out[0].slice(0, 36)).toBe(out[1].slice(0, 36));
  expect(out.map((m) => m.slice(37))).toEqual(['1', '2']);
});

test('restart: a click without a turn is uncertain; an answer already being generated is followed to its end', async () => {
  const t = rig([], ['a red kite']);
  await t.ticks(1);
  expect(items(t.states())).toBe('submitting');
  const again = createGptRunner({ db: t.db, driver: t.fake.driver, clock: t.clock, pollMs: 0, sleep: async () => undefined });
  again.recover();
  expect(t.states()[0]).toMatchObject({ item: 'needs_review', error: { code: 'SUBMIT_UNCERTAIN' } });

  const u = rig([], ['a blue door']);
  await u.ticks(2);
  expect(items(u.states())).toBe('generating');
  const next = createGptRunner({ db: u.db, driver: u.fake.driver, clock: u.clock, pollMs: 0, sleep: async () => undefined });
  next.recover();
  for (let i = 0; i < 3; i++) await next.tick();
  expect(items(u.states())).toBe('ready');
  expect(u.fake.ledger.sends).toHaveLength(1);
});

test('stop: prompts not sent yet are cancelled, the one being generated is followed to its result', async () => {
  const t = rig([], ['a red kite', 'a blue door', 'a green hill']);
  await t.ticks(2);
  t.runner.stop(t.batch);
  await t.ticks(5);
  expect(items(t.states())).toBe('ready,cancelled,cancelled');
  expect(t.fake.ledger.sends).toHaveLength(1);
});

test('a download asked after the tab left the conversation: the tab goes back to it, but never while a prompt is in flight', async () => {
  const got: string[] = [];
  const t = rig([], ['a red kite'], { fake: { fetchMedia: async (_t, p) => { got.push(p.mediaId); return { ok: true, downloadId: 5 }; } } });
  await t.ticks(4);
  const media = t.states()[0].outputs![0].mediaId, conv = t.states()[0].request.conv;
  t.fake.userLeaves();
  expect(await t.gpt.fetchMedia('g1', { mediaId: media, filename: 'x.bin' })).toEqual({ ok: true, downloadId: 5 });
  expect(t.fake.ledger.opens).toEqual([conv]);
  expect(got).toEqual([media]);

  const other = t.add(['a blue door'], 'c2');
  t.runner.start(other);
  await t.ticks(2); // a new conversation, its prompt is being generated
  expect(items(t.states(other))).toBe('generating');
  expect(await t.gpt.fetchMedia('g1', { mediaId: media, filename: 'x.bin' })).toEqual({ ok: false, code: 'NOT_FOUND' });
  expect(t.fake.ledger.opens).toEqual([conv]); // not navigated away from the running prompt
});

test('the user leaves right after the image is there: its own image is still saved from its own conversation, and the next prompt is not typed into the other chat', async () => {
  const t = rig(['leave'], ['a red kite', 'a blue door']);
  await t.ticks(3);
  expect(items(t.states())).toBe('ready,queued');
  const conv = t.states()[0].request.conv;
  expect(conv).toBeTruthy();
  await t.ticks(2);
  expect(t.runner.lastError(t.batch)).toBe('GPT_CONVERSATION_CHANGED');
  expect(t.fake.page.conv).not.toBe(conv); // the tab really is elsewhere, and the id we kept is the batch's own conversation
  expect(t.fake.ledger.sends).toEqual(['a red kite']);
});
