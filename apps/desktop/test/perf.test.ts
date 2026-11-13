import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/main/db';
import { enqueueBatch } from '../src/main/batch';
import { createFakeGpt } from '../src/main/gpt-driver';
import { createGptRunner, routeRunner } from '../src/main/gpt-runner';
import { createFakeDriver, FAKE_COMBOS } from '../src/main/fake-driver';
import { createRunner } from '../src/main/runner';
import { createAutoSaver } from '../src/main/autosave';
import { batchSignatures, viewBatches } from '../src/main/batch-view';
import { createDownloader } from '../src/main/downloads';
import { createNotifier } from '../src/main/notify';
import { createScheduler, setStart } from '../src/main/schedule';

// A finished history of `n` batches of `k` prompts each (Flow and ChatGPT), each prompt with its journal and saved files,
// written straight to the tables the way the runners leave them.
function history(db: Db, n: number, k: number): void {
  for (let b = 0; b < n; b++) {
    const provider = b % 3 === 2 ? 'chatgpt' : 'flow';
    const { batchId } = enqueueBatch(db, { commandId: `h${b}`, kind: 'image', provider, projectId: provider === 'flow' ? 'p' : null, settings: { provider }, prompts: Array.from({ length: k }, (_, i) => `prompt ${b} ${i}`), refs: Array.from({ length: k }, () => []), mode: 'auto' });
    db.prepare("update batch set status='done' where id=?").run(batchId);
    for (const { a } of db.prepare('select attempt_id a from item where batch_id=?').all(batchId) as { a: string }[]) {
      const outputs = [{ mediaId: `${a}-1` }, { mediaId: `${a}-2` }];
      db.prepare('update attempt set state_json=?, revision=4, click_at=1 where id=?').run(JSON.stringify({ item: 'ready', stage: 'outcome_known', prompt: 'x', clicked: true, baseline: null, outputs }), a);
      for (const [t, type] of ['intent', 'click', 'receipt', 'ready'].entries())
        db.prepare('insert into journal_event(attempt_id, type, at, payload_json) values(?,?,?,?)').run(a, type, 100 + t, JSON.stringify(type === 'intent' ? { profileVersion: '2026.11.12-1' } : {}));
      for (const o of outputs) db.prepare("insert into download(id, attempt_id, media_id, planned_name, state, actual_name, bytes, created_at, updated_at) values(?,?,?,?,'completed',?,1,1,1)").run(`d-${o.mediaId}`, a, o.mediaId, 'n', `x/${o.mediaId}.png`);
    }
  }
}

/** Records every statement the app prepares, so its query plan can be read. */
function recorded(db: Db): Set<string> {
  const seen = new Set<string>(), prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => { seen.add(sql); return prepare(sql); }) as Db['prepare'];
  return seen;
}

/** Tables read row by row in full (SCAN), batch excepted: it has one row per batch, every other table grows with every prompt. */
function fullPasses(db: Db, sql: string): string[] {
  if (!/^\s*(select|update|delete|with)\b/i.test(sql)) return [];
  const plan = (args: unknown[]) => (db.prepare(`explain query plan ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail);
  let rows: string[] | null = null;
  for (let n = 0; n <= 12 && !rows; n++) { try { rows = plan(Array(n).fill(null)); } catch { /* wrong parameter count: try one more */ } }
  if (!rows) { const named = Object.fromEntries([...sql.matchAll(/@(\w+)/g)].map((m) => [m[1], null])); rows = plan([named]); }
  return rows.filter((d) => /^SCAN /.test(d) && !/^SCAN (b|batch)\b/.test(d)).map((d) => `${d}  ←  ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
}

test('the loops that run several times a second (runners, auto save, change scan, notices, schedule) never read the whole history: every statement finds its rows by an index', async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-perf-')), 't.db'));
  const seen = recorded(db);
  history(db, 6, 3);
  const clock = { t: 1_800_000_000_000, now() { return this.t; } };
  const gpt = createGptRunner({ db, driver: createFakeGpt(['ok', 'ok']).driver, clock, pollMs: 0, sleep: async () => undefined, download: async () => undefined });
  const flow = createRunner({ db, driver: createFakeDriver(['image-ok', 'image-ok']), clock, tabs: ['t1'], speed: 'default', combos: FAKE_COMBOS, autoAllowed: () => true, projectOf: () => 'p' });
  const runner = routeRunner(flow, gpt);
  for (const provider of ['flow', 'chatgpt'] as const)
    runner.start(enqueueBatch(db, { commandId: `run-${provider}`, kind: 'image', provider, projectId: provider === 'flow' ? 'p' : null, settings: { provider }, prompts: ['a', 'b'], refs: [[], []], mode: 'auto' }).batchId);
  const saver = createAutoSaver({ db, now: () => clock.now(), enabled: () => true, downloader: { batch: async () => undefined } });
  const notes = createNotifier({ db, now: () => clock.now(), prefs: () => ({ notifyApp: true, notifyWindows: false, notifyTelegram: false, creditWarn: 50 }), lastError: (b) => runner.lastError(b), channels: {}, changed: () => {} });
  const sched = createScheduler({ db, now: () => clock.now(), start: (b) => runner.start(b), notify: (b, at, late) => notes.scheduled(b, at, late) });
  setStart(db, enqueueBatch(db, { commandId: 'later', kind: 'image', projectId: 'p', settings: {}, prompts: ['s'], refs: [[]], mode: 'auto' }).batchId, clock.t + 150_000);
  const round = async () => { await runner.tick(); await saver.tick(); for (const r of batchSignatures(db)) notes.batchChanged(r.id); await sched.tick(); notes.credits('a@b.c', 40 + (clock.t % 20)); clock.t += 5_000; };
  for (let i = 0; i < 40; i++) await round();
  expect(notes.list().items.map((n) => n.kind)).toEqual(expect.arrayContaining(['done', 'scheduled', 'credit']));
  seen.clear(); // what one more round of the loops prepares, with the batches mid-run and done
  for (let i = 0; i < 5; i++) await round();
  expect(seen.size).toBeGreaterThan(5);
  expect([...seen].flatMap((sql) => fullPasses(db, sql))).toEqual([]);
});

test('the batch list: the same number of queries for 4 or 40 batches, what one batch reads as is what the list says about it', () => {
  const count = (n: number) => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-perf-')), 't.db'));
    history(db, n, 3);
    const seen: string[] = [], prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => { seen.push(sql); return prepare(sql); }) as Db['prepare'];
    const all = viewBatches(db);
    db.prepare = prepare;
    return { db, all, queries: seen.length };
  };
  const few = count(4), many = count(40);
  expect(many.all).toHaveLength(40);
  expect(many.queries).toBe(few.queries);
  expect(many.queries).toBeLessThan(10);
  for (const b of many.all.slice(0, 5)) expect(viewBatches(many.db, [b.id])).toEqual([b]);
  const one = many.all[0];
  expect(one.status).toBe('completed');
  expect(one.items[0].attempts[0]).toMatchObject({ profileVersion: '2026.11.12-1', item: 'ready', clickAt: 1, journal: [{ type: 'intent', at: 100 }, { type: 'click', at: 101 }, { type: 'receipt', at: 102 }, { type: 'ready', at: 103 }] });
  expect(Object.keys(one.items[0].attempts[0].downloads)).toHaveLength(2);
  expect(viewBatches(many.db, ['nope'])).toEqual([]);
});

test('Kết quả: the list with tags and deleted outputs, and the save path that skips deleted outputs, find their rows by an index', async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-perf-')), 't.db'));
  history(db, 6, 3);
  const seen = recorded(db);
  viewBatches(db);
  const dl = createDownloader({ db, driver: createFakeDriver([]), root: mkdtempSync(join(tmpdir(), 'tf-perf-')), tz: 'UTC', now: () => 1, tab: () => 't1' });
  for (const { id } of db.prepare('select id from batch').all() as { id: string }[]) await dl.batch(id); // Tải tất cả / auto save: one batch after another
  expect(seen.size).toBeGreaterThan(5);
  expect([...seen].flatMap((sql) => fullPasses(db, sql)).filter((d) => !/^SCAN json_each/.test(d))).toEqual([]); // json_each is the list of wanted batch ids itself
});
