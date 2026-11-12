import { test, expect } from 'vitest';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttemptState } from '@toolflow/flow-protocol/attempt';
import { openDb } from '../src/main/db';
import { createAssetStore, registerAsset } from '../src/main/assets';
import { enqueueBatch } from '../src/main/batch';
import { createFakeGpt, isGemMedia, isGptMedia, type GptScript } from '../src/main/gpt-driver';
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

test('Send refused once (the button was still locked): after Tiếp tục the prompt already in the composer is sent as it is, once, in the same conversation', async () => {
  const t = rig([], ['a red kite', 'a blue door'], { fake: { send: ['', 'SEND_DISABLED'] } });
  await t.ticks(5);
  expect(t.runner.lastError(t.batch)).toBe('GPT_SEND_DISABLED');
  expect(t.fake.page.text).toBe('a blue door'); // our own text stays in the composer
  t.runner.resume(t.batch);
  await t.ticks(4);
  expect(items(t.states())).toBe('ready,ready');
  expect(t.fake.ledger.sends).toEqual(['a red kite', 'a blue door']);
  expect(t.fake.ledger.newChats).toBe(1);
  expect(t.states()[1].request.conv).toBe(t.states()[0].request.conv);
});

test('a turn reads "complete" for a while right after the click, before its answer starts (seen live): that is not an answer without an image', async () => {
  const t = rig(['early'], ['a red kite']);
  await t.ticks(2);
  expect(items(t.states())).toBe('generating');
  await t.ticks(2, 30_000); // past the short grace while the page still shows the early "complete"
  expect(items(t.states())).toBe('generating');
  await t.ticks(3);
  expect(items(t.states())).toBe('ready');
});

test('a turn that stays "complete" with no image and was never seen in progress fails only after the long wait', async () => {
  const t = rig(['mute'], ['a red kite']);
  await t.ticks(3);
  await t.ticks(2, 30_000);
  expect(items(t.states())).toBe('generating');
  await t.ticks(2, 30_000);
  expect(t.states()[0]).toMatchObject({ item: 'failed', error: { code: 'GPT_NO_IMAGE' } });
  expect(t.fake.ledger.sends).toHaveLength(1);
});

test('the ChatGPT tab is brought to the front of its window before every prompt (its "+" menu does not open in a background tab, seen live)', async () => {
  const t = rig([], ['a red kite', 'a blue door']);
  await t.ticks(8);
  expect(items(t.states())).toBe('ready,ready');
  expect(t.fake.ledger.fronts).toBe(2);
  expect(t.fake.ledger.raises).toBe(0); // the tab was shown already: the Chrome window is not pulled in front of the user's work
});

test('the Chrome window is minimised (or, on Windows, fully covered): making the tab active is not enough, so the window is raised once and the prompt goes out', async () => {
  const t = rig([], ['a red kite']);
  t.fake.minimise();
  await t.ticks(4);
  expect(items(t.states())).toBe('ready');
  expect(t.fake.ledger.raises).toBe(1);
});

test('the ChatGPT tab stays hidden even after its window was raised: nothing is typed, the batch pauses with GPT_TAB_HIDDEN', async () => {
  const t = rig([], ['a red kite']);
  t.fake.hideWindow(true);
  await t.ticks(2);
  expect(t.runner.lastError(t.batch)).toBe('GPT_TAB_HIDDEN');
  expect(t.fake.page.text).toBe('');
  expect(t.fake.ledger.sends).toHaveLength(0);
  t.fake.hideWindow(false); t.runner.resume(t.batch);
  await t.ticks(4);
  expect(items(t.states())).toBe('ready');
});

test('a Gemini batch runs in the Gemini tab through its own runner; the ChatGPT side is never asked about it, and the other way round', async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-gem-')), 't.db'));
  const clock = { t: 1_800_000_000_000, now() { return this.t; } };
  const gptFake = createFakeGpt([]), gemFake = createFakeGpt([], { site: 'gemini' });
  const mk = (provider: 'chatgpt' | 'gemini', fake: typeof gptFake) => createGptRunner({ db, provider, driver: fake.driver, clock, pollMs: 0, sleep: async () => undefined });
  const gpt = mk('chatgpt', gptFake), gem = mk('gemini', gemFake);
  const runner = routeRunner(createRunner({ db, driver: createFakeDriver([]), clock, tabs: ['t1'], speed: 'default', combos: FAKE_COMBOS, autoAllowed: () => true, projectOf: () => 'p-flow' }), gpt, gem);
  const add = (provider: 'chatgpt' | 'gemini', prompt: string, id: string = provider): string => enqueueBatch(db, { commandId: id, kind: 'image', provider, projectId: null, settings: { provider }, prompts: [prompt], refs: [[]], mode: 'auto' }).batchId;
  const state = (b: string): AttemptState => JSON.parse((db.prepare('select a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=?').get(b) as { j: string }).j);
  const g = add('gemini', 'a red kite'), c = add('chatgpt', 'a blue door');
  runner.start(g); runner.start(c);
  for (let i = 0; i < 2; i++) await gem.tick(); // the Gemini runner alone
  expect(state(g).item).toBe('generating');
  expect(state(c).item).toBe('queued');
  expect(gptFake.ledger.sends).toEqual([]);
  for (let i = 0; i < 4; i++) await runner.tick(); // all of them
  expect([state(g).item, state(c).item]).toEqual(['ready', 'ready']);
  expect(gemFake.ledger.sends).toEqual(['a red kite']);
  expect(gptFake.ledger.sends).toEqual(['a blue door']);
  const gm = state(g).outputs![0].mediaId, cm = state(c).outputs![0].mediaId;
  expect([isGemMedia(gm), isGptMedia(gm), isGemMedia(cm), isGptMedia(cm)]).toEqual([true, false, false, true]); // the id's shape says which site's tab holds the image
  expect(state(g).request.conv).toMatch(/^[0-9a-f]{16}$/);
  gemFake.closeTab();
  const g2 = add('gemini', 'a green hill', 'g2');
  runner.start(g2);
  for (let i = 0; i < 2; i++) await runner.tick();
  expect(runner.lastError(g2)).toBe('NO_CHATGPT_TAB'); // one code for "this site's tab is not open"; the hint names the site
});

test('a Gemini batch with an aspect ratio and reference images: the ratio goes with the image tool, each prompt gets exactly its own images (the first one clears the composer), and the send names how many; a missing image pauses before anything is sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-gem-'));
  const db = openDb(join(dir, 't.db'));
  const clock = { t: 1_800_000_000_000, now() { return this.t; } };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const ids = ['a.png', 'b.png'].map((n) => { writeFileSync(join(dir, n), png); return registerAsset(db, join(dir, n), clock.now()).id; });
  const fake = createFakeGpt([], { site: 'gemini' });
  const gem = createGptRunner({ db, provider: 'gemini', driver: fake.driver, assets: createAssetStore(db), clock, pollMs: 0, sleep: async () => undefined });
  const add = (id: string, prompts: string[], refs: string[][], settings: object): string => enqueueBatch(db, { commandId: id, kind: 'image', provider: 'gemini', projectId: null, settings, prompts, refs, mode: 'auto' }).batchId;
  const b = add('g', ['a red kite', 'a blue door'], [[ids[0], ids[1]], [ids[1]]], { provider: 'gemini', aspect: '9:16', model: 'Pro' });
  db.prepare("update batch set status='running' where id=?").run(b);
  for (let i = 0; i < 8; i++) await gem.tick();
  expect(fake.ledger.sends).toEqual(['a red kite', 'a blue door']);
  expect(fake.ledger.aspects).toEqual(['9:16', '9:16']);
  expect(fake.ledger.models).toEqual(['Pro', 'Pro']);
  expect(fake.ledger.refs).toEqual([['ref-1.png', 'ref-2.png'], ['ref-1.png']]); // the second prompt did not inherit the first one's images
  expect(fake.ledger.attached[0]).toEqual({ name: 'ref-1.png', mime: 'image/png', bytes: png.length, clear: true });
  expect(fake.ledger.attached[1].clear).toBe(false);
  // no ratio, no images: nothing is asked of the page beyond the tool
  const plain = add('p', ['a green hill'], [[]], { provider: 'gemini' });
  db.prepare("update batch set status='running' where id=?").run(plain);
  for (let i = 0; i < 4; i++) await gem.tick();
  expect(fake.ledger.aspects[2]).toBeNull();
  expect(fake.ledger.models[2]).toBeNull();
  expect(fake.ledger.refs[2]).toEqual([]);
  // an image whose file is gone
  unlinkSync(join(dir, 'a.png'));
  const gone = add('x', ['a grey cat'], [[ids[0]]], { provider: 'gemini' });
  db.prepare("update batch set status='running' where id=?").run(gone);
  for (let i = 0; i < 3; i++) await gem.tick();
  expect(gem.lastError(gone)).toBe('GPT_REF_ASSET_MISSING');
  expect(fake.ledger.sends).toHaveLength(3);
});

test('a ChatGPT batch with reference images: each prompt goes out with exactly its own, after the image mode is on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-gptref-'));
  const db = openDb(join(dir, 't.db'));
  const clock = { t: 1_800_000_000_000, now() { return this.t; } };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const ids = ['a.png', 'b.png'].map((n) => { writeFileSync(join(dir, n), png); return registerAsset(db, join(dir, n), clock.now()).id; });
  const fake = createFakeGpt([]);
  const gpt = createGptRunner({ db, driver: fake.driver, assets: createAssetStore(db), clock, pollMs: 0, sleep: async () => undefined });
  const b = enqueueBatch(db, { commandId: 'c', kind: 'image', provider: 'chatgpt', projectId: null, settings: { provider: 'chatgpt' }, prompts: ['a red kite', 'a blue door', 'a tin cup'], refs: [[ids[0]], [ids[0], ids[1]], []], mode: 'auto' }).batchId;
  db.prepare("update batch set status='running' where id=?").run(b);
  for (let i = 0; i < 12; i++) await gpt.tick();
  expect(fake.ledger.sends).toEqual(['a red kite', 'a blue door', 'a tin cup']);
  expect(fake.ledger.refs).toEqual([['ref-1.png'], ['ref-1.png', 'ref-2.png'], []]);
  expect(fake.ledger.attached.map((x) => x.clear)).toEqual([true, true, false]);
});

test('a ChatGPT batch and a Gemini batch at the same time, both tabs in one window: bringing one tab forward hides the other, so the sites take turns, one prompt at a time from its send to the end of its save, and both batches finish', async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-two-')), 't.db'));
  const clock = { t: 1_800_000_000_000, now() { return this.t; } };
  const gptFake = createFakeGpt([]), gemFake = createFakeGpt([], { site: 'gemini' });
  const log: string[] = [];
  const oneWindow = (a: typeof gptFake, b: typeof gptFake, name: string): void => { // a tab that becomes the active one puts the other in the background
    const front = a.driver.front, newChat = a.driver.newChat, open = a.driver.open, send = a.driver.send;
    a.driver.send = async (...x) => { log.push(`send ${name}`); return send(...x); };
    a.driver.front = async (...x) => { b.toBackground(); const r = await front(...x); await new Promise((res) => setTimeout(res, 1)); return r; }; // the pause: room for the other runner to do the same
    a.driver.newChat = async (...x) => { b.toBackground(); return newChat(...x); };
    a.driver.open = async (...x) => { b.toBackground(); return open(...x); };
  };
  oneWindow(gptFake, gemFake, 'chatgpt'); oneWindow(gemFake, gptFake, 'gemini');
  const hands = { busy: false };
  const mk = (provider: 'chatgpt' | 'gemini', fake: typeof gptFake) => createGptRunner({ db, provider, driver: fake.driver, clock, pollMs: 0, sleep: async () => undefined, hands, download: async () => { await new Promise((res) => setTimeout(res, 1)); log.push(`saved ${provider}`); } });
  const runner = routeRunner(createRunner({ db, driver: createFakeDriver([]), clock, tabs: ['t1'], speed: 'default', combos: FAKE_COMBOS, autoAllowed: () => true, projectOf: () => 'p-flow' }), mk('chatgpt', gptFake), mk('gemini', gemFake));
  const add = (provider: 'chatgpt' | 'gemini', prompts: string[]): string => enqueueBatch(db, { commandId: provider, kind: 'image', provider, projectId: null, settings: { provider }, prompts, refs: prompts.map(() => []), mode: 'auto' }).batchId;
  const c = add('chatgpt', ['a blue door', 'a blue window']), g = add('gemini', ['a red kite', 'a red boat']);
  runner.start(c); runner.start(g);
  for (let i = 0; i < 24; i++) await runner.tick();
  const items = (b: string): string[] => (db.prepare('select a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(b) as { j: string }[]).map((r) => (JSON.parse(r.j) as AttemptState).item);
  expect([items(c), runner.lastError(c), items(g), runner.lastError(g)]).toEqual([['ready', 'ready'], null, ['ready', 'ready'], null]);
  expect([gptFake.ledger.sends, gemFake.ledger.sends]).toEqual([['a blue door', 'a blue window'], ['a red kite', 'a red boat']]);
  expect(log).toHaveLength(8);
  for (let i = 0; i < log.length; i += 2) expect([log[i].slice(0, 5), log[i + 1]], log.join(', ')).toEqual(['send ', log[i].replace('send', 'saved')]); // nothing of the other site between a send and its save
});

