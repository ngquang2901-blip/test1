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

function rig(email: string | null = 'a@b.c', script: ('image-ok' | 'no-request')[] = ['image-ok', 'image-ok', 'image-ok'], projectId: () => string | null = () => 'p', projects?: () => string[]) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  const clock = { t: 1_000_000, now() { return this.t; } };
  const runner = createRunner({ db, driver: ((f) => ({ ...f, ping: async (t: string) => ({ ...(await f.ping(t)), t: clock.now() }) }))(createFakeDriver(script)), clock, tabs: ['t1'], speed: 'default', combos: FAKE_COMBOS, autoAllowed: (e) => autoAllowed(db, e) });
  const events: Array<{ entity: string; id: string; revision: number }> = [];
  let draft: Draft = { text: 't', kind: 'image', mode: 'auto', speed: 'default' };
  const h = createHandlers({ db, runner, grants: { use: () => {} }, projects: projects ?? (() => { const x = projectId(); return x ? [x] : []; }), email: async () => email, session: async () => ({}), pickPaths: async () => [], getDraft: () => draft, saveDraft: (d) => { draft = d; }, emit: revisioned((e) => events.push(e)), clock, downloader: { batch: async () => {}, retry: async () => {}, file: () => '' }, reveal: () => {}, thumb: () => null });
  return { db, h, events, runner, clock, draft: () => draft };
}
const good = { commandId: 'c1', text: 'a\nb\n\nc', kind: 'image', mode: 'auto' };

test('enqueueBatch rejects kind "mixed" and every other malformed argument', async () => {
  const { h, db } = rig();
  for (const bad of [{ ...good, kind: 'mixed' }, { ...good, mode: 'x' }, { ...good, text: 5 }, { ...good, text: 'x'.repeat(1_000_001) }, { ...good, commandId: 7 }, null, 'str'])
    await expect(h.enqueueBatch(bad)).rejects.toThrow(/INVALID_ARGS/);
  expect(db.prepare('select count(*) n from batch').get()).toEqual({ n: 0 });
});

test('enqueueBatch: an optional combo must be a qualified one and is stored as the profile\'s own object; any other combo creates nothing', async () => {
  const { h, db } = rig();
  const combo = { count: 3, aspect: '9:16', model: 'Nano Banana Pro', mode: 'Image', kind: 'image' };
  const r = (await h.enqueueBatch({ ...good, combo })) as { batchId: string };
  expect(JSON.parse((db.prepare('select settings_json s from batch where id=?').get(r.batchId) as { s: string }).s).combo).toEqual({ kind: 'image', mode: 'Image', model: 'Nano Banana Pro', aspect: '9:16', count: 3 });
  for (const bad of [{ ...combo, count: 9 }, { ...combo, quality: 'High' }, { ...combo, model: 'Imagen 9' }, { ...combo, kind: 'video' }, null, 'x', {}])
    await expect(h.enqueueBatch({ ...good, commandId: 'c2', combo: bad }), JSON.stringify(bad)).rejects.toMatchObject({ code: 'COMBO_NOT_QUALIFIED' });
  await expect(h.enqueueBatch({ ...good, commandId: 'c3', dryRun: true, combo: { ...combo, count: 9 } })).rejects.toMatchObject({ code: 'COMBO_NOT_QUALIFIED' }); // the preview says so too
  expect(db.prepare('select count(*) n from batch').get()).toEqual({ n: 1 });
});

test('enqueueBatch: a video batch without chosen settings runs with the profile\'s video default; settings of the other kind create nothing', async () => {
  const { h, db } = rig();
  const combo = (id: string) => JSON.parse((db.prepare('select settings_json s from batch where id=?').get(id) as { s: string }).s).combo;
  const v = (await h.enqueueBatch({ ...good, kind: 'video' })) as { batchId: string };
  expect(combo(v.batchId)).toEqual({ kind: 'video', mode: 'Video', model: 'Veo 3.1 - Lite', aspect: '16:9', count: 1 });
  const tall = (await h.enqueueBatch({ ...good, commandId: 'c2', kind: 'video', combo: { kind: 'video', mode: 'Video', model: 'Veo 3.1 - Lite', aspect: '9:16', count: 1 } })) as { batchId: string };
  expect(combo(tall.batchId).aspect).toBe('9:16');
  await expect(h.enqueueBatch({ ...good, commandId: 'c3', kind: 'video', combo: DEFAULT_COMBO })).rejects.toMatchObject({ code: 'COMBO_NOT_QUALIFIED' });
  await expect(h.enqueueBatch({ ...good, commandId: 'c4', kind: 'image', combo: combo(v.batchId) })).rejects.toMatchObject({ code: 'COMBO_NOT_QUALIFIED' });
  expect(db.prepare('select count(*) n from batch').get()).toEqual({ n: 2 });
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

test('several granted projects: the list is split line i -> project i mod n, line numbers and refs kept, idempotent per command', async () => {
  const { h: hh, db } = rig('a@b.c', undefined, undefined, () => ['P1', 'P2'])
  const a = { commandId: 'cmd-split', text: 'l1\nl2\nl3\nl4\nl5', kind: 'image', mode: 'auto' }
  const r = (await hh.enqueueBatch(a)) as { batchId: string; batchIds: string[] }
  expect(r.batchIds).toHaveLength(2)
  const rows = (id: string) => (db.prepare('select b.target_project p, b.settings_json s, i.ord o, i.prompt t from item i join batch b on b.id=i.batch_id where b.id=? order by i.ord').all(id) as { p: string; s: string; o: number; t: string }[])
  expect(rows(r.batchIds[0]).map((x) => [x.p, x.o, x.t])).toEqual([['P1', 0, 'l1'], ['P1', 2, 'l3'], ['P1', 4, 'l5']])
  expect(rows(r.batchIds[1]).map((x) => [x.p, x.o, x.t])).toEqual([['P2', 1, 'l2'], ['P2', 3, 'l4']])
  expect(JSON.parse(rows(r.batchIds[1])[0].s).split).toEqual({ part: 2, of: 2 })
  expect(((await hh.enqueueBatch(a)) as { batchIds: string[] }).batchIds).toEqual(r.batchIds) // a double click makes nothing new
  expect(db.prepare('select count(*) n from batch').get()).toEqual({ n: 2 })
})

test('enableAuto / disableAuto cover every account of the granted tabs; without ack nothing changes', async () => {
  const { db, runner, clock } = rig()
  const h = createHandlers({ db, runner, clock, grants: { use: () => {} }, projects: () => ['p'], email: async () => 'a@b.c', emails: async () => ['a@b.c', 'x@y.z'], session: async () => ({}), pickPaths: async () => [], getDraft: () => ({ text: '', kind: 'image', mode: 'auto', speed: 'default' }), saveDraft: () => {}, emit: revisioned(() => {}), downloader: { batch: async () => {}, retry: async () => {}, file: () => '' }, reveal: () => {}, thumb: () => null })
  await expect(h.enableAuto({})).rejects.toMatchObject({ code: 'ACK_REQUIRED' })
  expect([autoAllowed(db, 'a@b.c'), autoAllowed(db, 'x@y.z')]).toEqual([false, false])
  await h.enableAuto({ ack: true })
  expect([autoAllowed(db, 'a@b.c'), autoAllowed(db, 'x@y.z')]).toEqual([true, true])
  await h.disableAuto()
  expect([autoAllowed(db, 'a@b.c'), autoAllowed(db, 'x@y.z')]).toEqual([false, false])
})

test('enqueueBatch for ChatGPT: an image batch with no project, no Flow settings and no refs; anything else creates nothing', async () => {
  const { h, db } = rig('a@b.c', [], () => null); // no Flow tab at all: a ChatGPT batch does not need one
  const gpt = { commandId: 'g1', text: 'a red kite\n\na blue door', kind: 'image', mode: 'auto', provider: 'chatgpt' };
  expect(await h.enqueueBatch({ ...gpt, dryRun: true })).toMatchObject({ rows: [{ n: 1, prompt: 'a red kite' }, { n: 2, prompt: 'a blue door' }], errors: [] });
  const r = (await h.enqueueBatch(gpt)) as { batchId: string; batchIds: string[] };
  expect(r.batchIds).toEqual([r.batchId]);
  expect(db.prepare('select provider, kind, target_project p, settings_json s from batch where id=?').get(r.batchId)).toEqual({ provider: 'chatgpt', kind: 'image', p: null, s: JSON.stringify({ provider: 'chatgpt', mode: 'auto' }) });
  const b = (await h.getBatch(r.batchId)) as { provider: string; items: { prompt: string; sourceLine: number }[] };
  expect(b.provider).toBe('chatgpt');
  expect(b.items.map((i) => [i.prompt, i.sourceLine])).toEqual([['a red kite', 1], ['a blue door', 3]]);
  for (const bad of [{ ...gpt, kind: 'video' }, { ...gpt, mode: 'manual' }, { ...gpt, provider: 'grok' }])
    await expect(h.enqueueBatch({ ...bad, commandId: 'g2' }), JSON.stringify(bad)).rejects.toThrow(/INVALID_ARGS/);
  await expect(h.enqueueBatch({ ...gpt, commandId: 'g3', refs: { assetIds: ['x'], mode: 'all', perItem: 1 } })).rejects.toMatchObject({ code: 'REF_KIND_UNSUPPORTED' });
  expect(db.prepare('select count(*) n from batch').get()).toEqual({ n: 1 });
  const flow = (await rig().h.enqueueBatch(good)) as { batchId: string };
  expect(flow.batchId).toBeTruthy(); // a batch without a provider is a Flow batch, as before
});
