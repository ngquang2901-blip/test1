import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/main/db';
import { createFakeDriver } from '../src/main/fake-driver';
import { createRunner } from '../src/main/runner';
import { autoAllowed } from '../src/main/account';
import { createHandlers, revisioned } from '../src/main/ipc';

function rig(email: string | null = 'a@b.c') {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  const runner = createRunner({ db, driver: createFakeDriver(['image-ok', 'image-ok', 'image-ok']), clock: Date, tabs: ['t1'], speed: 'default', autoAllowed: (e) => autoAllowed(db, e) });
  const events: Array<{ entity: string; id: string; revision: number }> = [];
  const h = createHandlers({ db, runner, projectId: 'p', email: async () => email, session: async () => ({}), saveDraft: () => {}, emit: revisioned((e) => events.push(e)), clock: Date });
  return { db, h, events };
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
