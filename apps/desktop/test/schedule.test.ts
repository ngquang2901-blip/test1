import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/main/db';
import { createFakeDriver, FAKE_COMBOS } from '../src/main/fake-driver';
import { createRunner } from '../src/main/runner';
import { createHandlers, revisioned, parseDraft, DEFAULT_DRAFT, type Draft } from '../src/main/ipc';
import { createScheduler, MAX_AHEAD_MS } from '../src/main/schedule';
import { viewBatches } from '../src/main/batch-view';

const T0 = 1_800_000_000_000;
function rig() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-s-')), 't.db'));
  const clock = { t: T0, now() { return this.t; } };
  const runner = createRunner({ db, driver: createFakeDriver([]), clock, tabs: [], speed: 'default', combos: FAKE_COMBOS, autoAllowed: () => true });
  let draft: Draft = DEFAULT_DRAFT;
  const h = createHandlers({ db, runner, grants: { use: () => {} }, projects: () => ['p'], email: async () => 'a@b.c', session: async () => ({}), pickPaths: async () => [], getDraft: () => draft, saveDraft: (d) => { draft = d; }, emit: revisioned(() => {}), clock, downloader: { batch: async () => {}, retry: async () => {}, file: () => '' }, reveal: () => {}, thumb: () => null });
  const started: [string, number, boolean][] = [];
  const sched = createScheduler({ db, now: () => clock.now(), start: (id) => h.startBatch(id), notify: (id, at, late) => { started.push([id, at, late]); } });
  const status = (id: string) => (db.prepare('select status, start_at s from batch where id=?').get(id) as { status: string; s: number | null });
  return { db, clock, h, sched, started, status, draft: () => draft };
}
const make = async (h: ReturnType<typeof rig>['h'], startAt?: unknown, text = 'a\nb') => ((await h.enqueueBatch({ commandId: Math.random().toString(), text, kind: 'image', mode: 'auto', ...(startAt === undefined ? {} : { startAt }) })) as { batchId: string }).batchId;

test('Hẹn giờ chạy: the batch is created but not started and carries its time; only a future time within 30 days is taken, checked before anything is created', async () => {
  const t = rig();
  for (const [bad, code] of [[T0 - 1, 'SCHEDULE_PAST'], [T0, 'SCHEDULE_PAST'], [T0 + MAX_AHEAD_MS + 1, 'SCHEDULE_TOO_FAR'], ['soon', 'INVALID_ARGS'], [1.5 + T0, 'INVALID_ARGS'], [null, 'INVALID_ARGS']] as const)
    await expect(make(t.h, bad), String(bad)).rejects.toMatchObject({ code });
  expect(t.db.prepare('select count(*) n from batch').get()).toEqual({ n: 0 });
  const id = await make(t.h, T0 + 60_000);
  expect(t.status(id)).toEqual({ status: 'queued', s: T0 + 60_000 });
  expect(viewBatches(t.db, [id])[0]).toMatchObject({ status: 'queued', startAt: T0 + 60_000 });
  expect(((await t.h.enqueueBatch({ commandId: 'dry', text: 'a', kind: 'image', mode: 'auto', dryRun: true, startAt: T0 - 5 })) as { rows: unknown[] }).rows).toHaveLength(1); // the preview never trips on the time
});

test('the ticker starts a due batch once, through the same start as the button; a time missed while the app was closed starts at the next start and is marked late', async () => {
  const t = rig();
  const missed = await make(t.h, T0 + 1_000), later = await make(t.h, T0 + 120_000), cancelled = await make(t.h, T0 + 60_000);
  await t.h.scheduleBatch({ batchId: cancelled, at: null }); // Huỷ hẹn giờ
  t.clock.t = T0 + 5_000; // the app was closed at missed's time and opens now
  await t.sched.tick();
  expect(t.started).toEqual([[missed, T0 + 1_000, true]]);
  expect(t.status(missed)).toEqual({ status: 'running', s: null });
  t.clock.t = T0 + 119_000;
  await t.sched.tick();
  expect(t.started).toHaveLength(1);
  t.clock.t = T0 + 125_000;
  await t.sched.tick();
  await t.sched.tick();
  expect(t.started).toEqual([[missed, T0 + 1_000, true], [later, T0 + 120_000, false]]);
  expect(t.status(cancelled)).toEqual({ status: 'queued', s: null });
});

test('Hẹn giờ / Huỷ hẹn giờ only on a batch that has not started; Chạy ngay clears the time', async () => {
  const t = rig();
  const id = await make(t.h);
  await t.h.scheduleBatch({ batchId: id, at: T0 + 30_000 });
  expect(t.status(id).s).toBe(T0 + 30_000);
  await expect(t.h.scheduleBatch({ batchId: id, at: T0 - 1 })).rejects.toMatchObject({ code: 'SCHEDULE_PAST' });
  await expect(t.h.scheduleBatch({ batchId: id })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  await t.h.startBatch(id);
  expect(t.status(id)).toEqual({ status: 'running', s: null });
  await expect(t.h.scheduleBatch({ batchId: id, at: T0 + 30_000 })).rejects.toMatchObject({ code: 'NOT_SCHEDULABLE' });
  await expect(t.h.scheduleBatch({ batchId: 'nope', at: T0 + 30_000 })).rejects.toMatchObject({ code: 'NOT_SCHEDULABLE' });
});

test('the new settings are validated like the old ones; a bad value on disk falls back to the defaults', async () => {
  const t = rig();
  expect(DEFAULT_DRAFT).toMatchObject({ notifyApp: true, notifyWindows: true, notifyTelegram: true, tray: true, openAtLogin: false, creditWarn: 50 });
  await t.h.saveDraft({ tray: false, openAtLogin: true, creditWarn: 1000, notifyWindows: false });
  expect(t.draft()).toMatchObject({ tray: false, openAtLogin: true, creditWarn: 1000, notifyWindows: false, notifyApp: true });
  for (const bad of [{ tray: 'yes' }, { creditWarn: -1 }, { creditWarn: 2.5 }, { creditWarn: 1_000_001 }, { notifyTelegram: 1 }])
    await expect(t.h.saveDraft(bad), JSON.stringify(bad)).rejects.toThrow(/INVALID_ARGS/);
  expect(parseDraft({ creditWarn: 'x' })).toEqual(DEFAULT_DRAFT);
});
