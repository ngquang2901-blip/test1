import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/main/db';
import { createAssetStore } from '../src/main/assets';
import { DEFAULT_COMBO } from '../src/main/profile';
import { FAKE_COMBOS, createFakeDriver } from '../src/main/fake-driver';
import { createRunner } from '../src/main/runner';
import { autoAllowed, enableAuto } from '../src/main/account';
import { createHandlers, revisioned, parseDraft, type Draft } from '../src/main/ipc';
import { clockFactor, errorCode } from '../src/main/boot-util';
import { newer } from '../src/renderer/src/revision';

function rig(email: string | null = 'a@b.c', script: ('image-ok' | 'no-request')[] = ['image-ok', 'image-ok', 'image-ok'], projectId: () => string | null = () => 'p') {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  const clock = { t: 1_000_000, now() { return this.t; } };
  const runner = createRunner({ db, driver: ((f) => ({ ...f, ping: async (t: string) => ({ ...(await f.ping(t)), t: clock.now() }) }))(createFakeDriver(script)), clock, tabs: ['t1'], speed: 'default', combos: FAKE_COMBOS, autoAllowed: (e) => autoAllowed(db, e) });
  const events: Array<{ entity: string; id: string; revision: number }> = [];
  let draft: Draft = { text: 't', kind: 'image', mode: 'auto', speed: 'default' };
  const h = createHandlers({ db, runner, grants: { use: () => {} }, projectId, email: async () => email, session: async () => ({}), pickPaths: async () => [], getDraft: () => draft, saveDraft: (d) => { draft = d; }, emit: revisioned((e) => events.push(e)), clock, downloader: { batch: async () => {}, retry: async () => {} } });
  return { db, h, events, runner, clock, draft: () => draft };
}
const good = { commandId: 'c1', text: 'a\nb\n\nc', kind: 'image', mode: 'auto' };

test('enqueueBatch rejects kind "mixed" and every other malformed argument', async () => {
  const { h, db } = rig();
  for (const bad of [{ ...good, kind: 'mixed' }, { ...good, mode: 'x' }, { ...good, text: 5 }, { ...good, text: 'x'.repeat(1_000_001) }, { ...good, commandId: 7 }, null, 'str'])
    await expect(h.enqueueBatch(bad)).rejects.toThrow(/INVALID_ARGS/);
  expect(db.prepare('select count(*) n from batch').get()).toEqual({ n: 0 });
});

test('dryRun previews without creating; real call creates one item per non-empty line', async () => {
  const { h, db } = rig();
  const p = (await h.enqueueBatch({ ...good, dryRun: true })) as { rows: { n: number; prompt: string }[] };
  expect(p.rows.map((r) => r.prompt)).toEqual(['a', 'b', 'c']);
  expect(db.prepare('select count(*) n from batch').get()).toEqual({ n: 0 });
  const r = (await h.enqueueBatch(good)) as { batchId: string };
  expect(db.prepare('select count(*) n from item where batch_id=?').get(r.batchId)).toEqual({ n: 3 });
  expect(JSON.parse((db.prepare('select settings_json s from batch where id=?').get(r.batchId) as { s: string }).s).combo).toEqual(DEFAULT_COMBO);
});

test('ids must be strings; confirmUncertain only accepts sent|not_sent', async () => {
  const { h } = rig();
  for (const f of [h.startBatch, h.pauseBatch, h.resumeBatch, h.stopBatch, h.archiveBatch, h.getBatch]) await expect(f(42)).rejects.toThrow(/INVALID_ARGS/);
  await expect(h.confirmUncertain({ attemptId: 'x', to: 'ready' })).rejects.toThrow(/INVALID_ARGS/);
});

test('enableAuto needs ack === true and a readable email (defence in depth)', async () => {
  const { h, db } = rig();
  for (const bad of [{}, { ack: 'true' }, { ack: false }, undefined]) await expect(h.enableAuto(bad)).rejects.toThrow(/ACK_REQUIRED|INVALID_ARGS/);
  expect(db.prepare('select count(*) n from account_setting').get()).toEqual({ n: 0 });
  await h.enableAuto({ ack: true });
  expect(autoAllowed(db, 'a@b.c')).toBe(true);
  await h.disableAuto();
  expect(autoAllowed(db, 'a@b.c')).toBe(false);
  await expect(rig(null).h.enableAuto({ ack: true })).rejects.toThrow(/NO_ACCOUNT/);
});

test('mutations emit strictly increasing revisions; getBatch hides urls', async () => {
  const { h, events } = rig();
  const { batchId } = (await h.enqueueBatch(good)) as { batchId: string };
  await h.startBatch(batchId);
  await h.pauseBatch(batchId);
  expect(events.map((e) => e.revision)).toEqual([1, 2, 3]);
  const b = (await h.getBatch(batchId)) as { items: unknown[] };
  expect(b.items).toHaveLength(3);
  expect(JSON.stringify(b)).not.toMatch(/https?:|Signature=/);
});

test('confirmUncertain stores the user word as error.resolution (sent vs not_sent are not swapped)', async () => {
  for (const to of ['sent', 'not_sent'] as const) {
    const { h, db, runner, clock } = rig('a@b.c', ['no-request']);
    enableAuto(db, 'fake@example.invalid', 0); // the account the fake driver reports
    const { batchId } = (await h.enqueueBatch(good)) as { batchId: string };
    await h.startBatch(batchId);
    for (let i = 0; i < 2; i++) { await runner.tick(); await new Promise((r) => setTimeout(r, 0)); }
    clock.t += 31_000;
    for (let i = 0; i < 3; i++) { await runner.tick(); await new Promise((r) => setTimeout(r, 0)); }
    type B = { items: { attempts: { id: string; item: string; error: { resolution?: string } | null }[] }[] };
    const a = ((await h.getBatch(batchId)) as B).items[0].attempts[0];
    expect(a.item).toBe('needs_review');
    await h.confirmUncertain({ attemptId: a.id, to });
    expect(((await h.getBatch(batchId)) as B).items[0].attempts[0].error?.resolution).toBe(to);
  }
});

test('getBatch carries the current revision', async () => {
  const { h } = rig();
  const { batchId } = (await h.enqueueBatch(good)) as { batchId: string };
  await h.startBatch(batchId);
  expect(((await h.getBatch(batchId)) as { revision: number }).revision).toBe(2);
});

test('saveDraft merges a partial patch into the stored draft', async () => {
  const { h, draft } = rig();
  await h.saveDraft({ speed: 'fast' });
  expect(draft()).toEqual({ text: 't', kind: 'image', mode: 'auto', speed: 'fast' });
  await expect(h.saveDraft({ speed: 'warp' })).rejects.toThrow(/INVALID_ARGS/);
});

test('parseDraft: a bad draft on disk falls back to defaults', () => {
  const def = { text: '', kind: 'image', mode: 'auto', speed: 'default' };
  expect(parseDraft({ kind: 'mixed' })).toEqual(def);
  expect(parseDraft('x')).toEqual(def);
  expect(parseDraft({ text: 'hi', speed: 'fast' })).toEqual({ ...def, text: 'hi', speed: 'fast' });
});

test('revision guard: older or equal revisions are ignored', () => {
  expect(newer(5, 6)).toBe(true);
  expect(newer(5, 5)).toBe(false);
  expect(newer(5, 4)).toBe(false);
});

test('clockFactor: non-numeric or <=0 means 1; errorCode never leaks messages', () => {
  expect([clockFactor('30'), clockFactor(undefined), clockFactor('abc'), clockFactor('0'), clockFactor('-3'), clockFactor('Infinity')]).toEqual([30, 1, 1, 1, 1, 1]);
  expect(errorCode(Object.assign(new Error('/home/x/secret'), { code: 'ENOENT' }))).toBe('ENOENT');
  expect(errorCode(new Error('/home/x/token abc'))).toBe('CONNECTOR_FAILED');
});

test('archiveBatch needs {batchId, confirm: true}; anything else is INVALID_ARGS and archives nothing', async () => {
  const { h, db } = rig();
  const { batchId } = (await h.enqueueBatch(good)) as { batchId: string };
  for (const bad of [batchId, { batchId }, { batchId, confirm: 'true' }, { batchId, confirm: false }, { confirm: true }, null]) await expect(h.archiveBatch(bad)).rejects.toThrow(/INVALID_ARGS/);
  expect(db.prepare('select archived a from batch where id=?').get(batchId)).toEqual({ a: 0 });
  await h.archiveBatch({ batchId, confirm: true });
  expect(db.prepare('select archived a from batch where id=?').get(batchId)).toEqual({ a: 1 });
});

test('rerun needs {attemptId, confirmCost: true}', async () => {
  const { h } = rig();
  for (const bad of ['x', { attemptId: 'x' }, { attemptId: 'x', confirmCost: 1 }, { attemptId: 'x', confirmCost: false }, { confirmCost: true }, { attemptId: 7, confirmCost: true }, undefined]) await expect(h.rerun(bad)).rejects.toThrow(/INVALID_ARGS/);
});

test('enqueueBatch: project comes from the getter at call time; none ⇒ NO_PROJECT_TAB and nothing is created (dryRun still previews)', async () => {
  let p: string | null = null;
  const { h, db } = rig('a@b.c', undefined, () => p);
  await expect(h.enqueueBatch(good)).rejects.toThrow(/NO_PROJECT_TAB/);
  await expect(h.enqueueBatch(good)).rejects.toMatchObject({ code: 'NO_PROJECT_TAB' });
  expect(db.prepare('select count(*) n from batch').get()).toEqual({ n: 0 });
  expect(((await h.enqueueBatch({ ...good, dryRun: true })) as { rows: unknown[] }).rows).toHaveLength(3);
  p = 'proj-1';
  const r = (await h.enqueueBatch(good)) as { batchId: string };
  expect(db.prepare('select target_project p from batch where id=?').get(r.batchId)).toEqual({ p: 'proj-1' });
});

test('I4b: resetAssetBinding needs {assetId, confirm: true}, a granted project, and deletes only that (asset, project) row', async () => {
  let p: string | null = 'proj-1';
  const { h, db } = rig('a@b.c', undefined, () => p);
  const store = createAssetStore(db);
  const bind = (assetId: string, projectId: string) => store.writeBinding({ assetId, projectId, uploadName: 'tf-x-1.png', mediaId: null, state: 'uncertain', intentAt: 1 });
  bind('a1', 'proj-1'); bind('a1', 'proj-2'); bind('a2', 'proj-1');
  const left = () => (db.prepare('select asset_id a, project_id p from asset_binding order by 1, 2').all() as { a: string; p: string }[]).map((r) => `${r.a}|${r.p}`);
  for (const bad of ['a1', { assetId: 'a1' }, { assetId: 'a1', confirm: 'true' }, { assetId: 'a1', confirm: 1 }, { assetId: 'a1', confirm: false }, { confirm: true }, { assetId: 7, confirm: true }, { assetId: '', confirm: true }, null, undefined])
    await expect(h.resetAssetBinding(bad)).rejects.toThrow(/INVALID_ARGS/);
  expect(left()).toEqual(['a1|proj-1', 'a1|proj-2', 'a2|proj-1']);
  p = null;
  await expect(h.resetAssetBinding({ assetId: 'a1', confirm: true })).rejects.toMatchObject({ code: 'NO_PROJECT_TAB' });
  expect(left()).toHaveLength(3);
  p = 'proj-1';
  await h.resetAssetBinding({ assetId: 'a1', confirm: true });
  expect(left()).toEqual(['a1|proj-2', 'a2|proj-1']);
});

test('m4: rerun refuses an archived batch (nothing is added)', async () => {
  const { h, db } = rig();
  const { batchId } = (await h.enqueueBatch(good)) as { batchId: string };
  db.prepare("update attempt set state_json=json_set(state_json,'$.item','failed') where id=(select a.id from attempt a join item i on i.id=a.item_id where i.batch_id=? order by i.ord limit 1)").run(batchId);
  const a = (db.prepare('select a.id id from attempt a join item i on i.id=a.item_id where i.batch_id=? order by i.ord limit 1').get(batchId) as { id: string }).id;
  db.prepare('update batch set archived=1 where id=?').run(batchId);
  await expect(h.rerun({ attemptId: a, confirmCost: true })).rejects.toMatchObject({ code: 'BATCH_ARCHIVED' });
  expect(db.prepare('select count(*) n from attempt where id!=? and item_id=(select item_id from attempt where id=?)').get(a, a)).toEqual({ n: 0 });
  db.prepare('update batch set archived=0 where id=?').run(batchId);
  await h.rerun({ attemptId: a, confirmCost: true }); // control: the same call works on a live batch
  expect(db.prepare('select count(*) n from attempt where item_id=(select item_id from attempt where id=?)').get(a)).toEqual({ n: 2 });
});
