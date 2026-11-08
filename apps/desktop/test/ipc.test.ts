import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/main/db';
import { createFakeDriver } from '../src/main/fake-driver';
import { createRunner } from '../src/main/runner';
import { autoAllowed, enableAuto } from '../src/main/account';
import { createHandlers, revisioned, parseDraft, type Draft } from '../src/main/ipc';
import { clockFactor, errorCode } from '../src/main/boot-util';
import { newer } from '../src/renderer/src/revision';

function rig(email: string | null = 'a@b.c', script: ('image-ok' | 'no-request')[] = ['image-ok', 'image-ok', 'image-ok']) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  const clock = { t: 1_000_000, now() { return this.t; } };
  const runner = createRunner({ db, driver: ((f) => ({ ...f, ping: async (t: string) => ({ ...(await f.ping(t)), t: clock.now() }) }))(createFakeDriver(script)), clock, tabs: ['t1'], speed: 'default', autoAllowed: (e) => autoAllowed(db, e) });
  const events: Array<{ entity: string; id: string; revision: number }> = [];
  let draft: Draft = { text: 't', kind: 'image', mode: 'auto', speed: 'default' };
  const h = createHandlers({ db, runner, grants: { use: () => {} }, projectId: 'p', email: async () => email, session: async () => ({}), getDraft: () => draft, saveDraft: (d) => { draft = d; }, emit: revisioned((e) => events.push(e)), clock });
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
