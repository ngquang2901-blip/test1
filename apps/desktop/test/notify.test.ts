import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/main/db';
import { enqueueBatch } from '../src/main/batch';
import { createNotifier, type Notice } from '../src/main/notify';
import { createFakeDriver, fakeCombo, FAKE_COMBOS } from '../src/main/fake-driver';
import { createRunner } from '../src/main/runner';

const PROMPT = 'một con mèo bí mật';
function rig(p: Partial<{ notifyApp: boolean; notifyWindows: boolean; notifyTelegram: boolean; creditWarn: number }> = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-n-')), 't.db'));
  const prefs = { notifyApp: true, notifyWindows: true, notifyTelegram: true, creditWarn: 50, ...p };
  const toasts: Notice[] = [], telegram: string[] = [], reasons = new Map<string, string>();
  let changed = 0;
  const timers: (() => void)[] = [];
  const n = createNotifier({ db, now: () => Date.UTC(2026, 10, 13, 7, 5), prefs: () => prefs, lastError: (id) => reasons.get(id) ?? null, changed: () => { changed++; }, later: (f) => { timers.push(f); },
    channels: { windows: (x) => { toasts.push(x); }, telegram: async (t) => { telegram.push(t); } } });
  const batch = (prompts = [PROMPT, 'b', 'c'], provider: 'flow' | 'chatgpt' = 'flow') => enqueueBatch(db, { commandId: Math.random().toString(), kind: 'image', provider, projectId: 'p', settings: {}, mode: 'auto', prompts, refs: prompts.map(() => []) }).batchId;
  return { db, n, prefs, toasts, telegram, reasons, batch, changed: () => changed, timers };
}
/** The batch row and each item's current attempt as the runner would leave them. */
function put(db: Db, id: string, status: string, items: (string | [string, string])[], stop = 0) {
  db.prepare('update batch set status=?, stop_requested=? where id=?').run(status, stop, id);
  const as = db.prepare('select attempt_id a from item where batch_id=? order by ord').all(id) as { a: string }[];
  as.forEach((r, i) => { const it = items[i]; const [item, code] = Array.isArray(it) ? it : [it, null]; db.prepare('update attempt set state_json=? where id=?').run(JSON.stringify({ item, stage: item === 'needs_review' ? 'uncertain' : 'x', error: code ? { code } : null }), r.a); });
}

test('a batch already finished or paused when the app starts raises nothing; a later finish raises one notice on every channel with counts, never the prompt', async () => {
  const t = rig();
  const old = t.batch(), live = t.batch();
  put(t.db, old, 'running', ['ready', 'ready', 'ready']);
  put(t.db, live, 'running', ['ready', 'queued', 'queued']);
  t.n.batchChanged(old); t.n.batchChanged(live); // the first scan after boot sees every batch
  expect(t.n.list().items).toEqual([]);
  put(t.db, live, 'running', ['ready', 'ready', 'failed']);
  t.n.batchChanged(live);
  t.n.batchChanged(live); // the same state again: nothing new
  const { items, unread } = t.n.list();
  expect(unread).toBe(1);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: 'done', batchId: live, read: false, title: `Lô ${live.slice(0, 8)} đã xong` });
  expect(items[0].body).toBe('Flow · Ảnh · 2/3 có kết quả · 1 lỗi');
  expect(t.toasts).toHaveLength(1);
  await Promise.resolve();
  expect(t.telegram).toEqual([`Lô ${live.slice(0, 8)} đã xong\nFlow · Ảnh · 2/3 có kết quả · 1 lỗi`]);
  for (const s of [...t.telegram, JSON.stringify(items)]) expect(s).not.toContain(PROMPT);
  expect(t.changed()).toBe(1);
});

test('a stop with a reason code needs the user (code + Vietnamese hint); the user\'s own pause and stop raise nothing', () => {
  const t = rig();
  const a = t.batch(['x'], 'chatgpt'), b = t.batch(['y']), c = t.batch(['z']), d = t.batch(['w']);
  for (const id of [a, b, c, d]) { put(t.db, id, 'running', ['preparing']); t.n.batchChanged(id); }
  t.reasons.set(a, 'GPT_NO_IMAGE'); put(t.db, a, 'paused', ['preparing']); t.n.batchChanged(a);
  put(t.db, b, 'paused', [['needs_review', 'SUBMIT_UNCERTAIN']]); t.n.batchChanged(b);
  put(t.db, c, 'paused', ['preparing']); t.n.batchChanged(c); // Tạm dừng by the user: no reason
  put(t.db, d, 'running', ['cancelled'], 1); t.n.batchChanged(d); // Dừng by the user
  const items = t.n.list().items;
  expect(items.map((i) => [i.kind, i.batchId])).toEqual([['attention', b], ['attention', a]]); // newest first
  expect(items[1].title).toBe(`Lô ${a.slice(0, 8)} cần bạn xem`);
  expect(items[1].body).toMatch(/^ChatGPT · Ảnh · GPT_NO_IMAGE: ChatGPT trả lời mà không có ảnh/);
  expect(items[0].body).toMatch(/^Flow · Ảnh · SUBMIT_UNCERTAIN: Không rõ Flow đã nhận/);
});

test('each channel follows its own switch; the in-app list keeps the last 50, newest first; Đánh dấu đã đọc clears the count', async () => {
  const t = rig({ notifyWindows: false, notifyTelegram: false });
  for (let i = 0; i < 53; i++) t.n.notify({ kind: 'done', batchId: null, title: `t${i}`, body: 'b' });
  await Promise.resolve();
  expect([t.toasts.length, t.telegram.length]).toEqual([0, 0]);
  const l = t.n.list();
  expect([l.items.length, l.unread, l.items[0].title, l.items[49].title]).toEqual([50, 50, 't52', 't3']);
  expect((t.db.prepare('select count(*) n from notice').get() as { n: number }).n).toBe(50);
  t.n.markRead();
  expect(t.n.list().unread).toBe(0);
  t.prefs.notifyApp = false; t.prefs.notifyWindows = true;
  t.n.notify({ kind: 'done', batchId: null, title: 'only windows', body: 'b' });
  expect([t.n.list().unread, t.toasts.map((x) => x.title)]).toEqual([0, ['only windows']]);
});

test('credit: below the threshold raises one notice per crossing, not one per send; the last balance per account is kept with its time', () => {
  const t = rig({ notifyTelegram: false });
  t.n.credits('a@x.y', 120);
  t.n.credits('a@x.y', 45);
  t.n.credits('a@x.y', 35);
  t.n.credits('a@x.y', 20);
  expect(t.n.list().items.map((i) => i.title)).toEqual(['Credit Flow sắp hết']);
  expect(t.n.list().items[0].body).toMatch(/^Còn 45 credit, dưới mức cảnh báo 50 · đọc lúc \d\d:\d\d$/);
  t.n.credits('a@x.y', 500); // topped up, then down again: a new crossing
  t.n.credits('a@x.y', 10);
  expect(t.n.list().items).toHaveLength(2);
  t.n.credits(null, 7); // the account could not be read: kept apart, first reading below ⇒ a notice
  expect(t.n.creditList()).toEqual([{ email: '', credits: 7, at: Date.UTC(2026, 10, 13, 7, 5) }, { email: 'a@x.y', credits: 10, at: Date.UTC(2026, 10, 13, 7, 5) }]);
  expect(t.n.list().items).toHaveLength(3);
});

test('a scheduled start says when it was due, and that it is late when the app was closed at that time', () => {
  const t = rig();
  const id = t.batch(['x']);
  t.n.scheduled(id, Date.UTC(2026, 10, 13, 6, 0), true);
  t.n.scheduled(id, Date.UTC(2026, 10, 13, 7, 0), false);
  const [onTime, late] = t.n.list().items;
  expect(late).toMatchObject({ kind: 'scheduled', title: `Lô ${id.slice(0, 8)} đã bắt đầu theo hẹn giờ` });
  expect(late.body).toMatch(/^Flow · Ảnh · bắt đầu trễ: hẹn lúc \d\d:\d\d, lúc đó app đang tắt$/);
  expect(onTime.body).toMatch(/^Flow · Ảnh · hẹn lúc \d\d:\d\d$/);
});

test('a Windows notification that failed is remembered, so the screen can say how to switch them on', () => {
  const t = rig();
  expect(t.n.list().windowsBlocked).toBe(false);
  t.n.windowsFailed();
  expect(t.n.list().windowsBlocked).toBe(true);
});

test('the runner hands over the credit balance Flow reports with a video receipt and with its polls', async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-c-')), 't.db'));
  const clock = { t: Date.now(), now() { return this.t; } };
  const driver = createFakeDriver(['video-ok']);
  const seen: [string, number][] = [];
  const runner = createRunner({ db, driver: { ...driver, ping: async (x) => ({ ...(await driver.ping(x)), t: clock.now() }) }, clock, tabs: ['t1'], speed: 'default', combos: FAKE_COMBOS, autoAllowed: () => true, onCredits: (tab, n) => seen.push([tab, n]) });
  const { batchId } = enqueueBatch(db, { commandId: 'c', kind: 'video', projectId: 'p', settings: { combo: fakeCombo('video') }, mode: 'auto', prompts: ['v'], refs: [[]] });
  runner.start(batchId);
  for (let i = 0; i < 6; i++) { await runner.tick(); await new Promise((r) => setTimeout(r, 0)); }
  expect(seen).toEqual([['t1', 958]]);
  for (const e of driver.videoPolls()) driver.emit(e);
  await runner.tick();
  expect(seen).toEqual([['t1', 958], ['t1', 948]]);
});

test('a lost connection notifies only when it lasts: the app picks the tab again by itself, so a short drop that already went on says nothing', () => {
  const t = rig();
  const a = t.batch(['x']), b = t.batch(['y']);
  for (const id of [a, b]) { put(t.db, id, 'running', ['preparing']); t.n.batchChanged(id); t.reasons.set(id, 'CONNECTOR_LOST'); put(t.db, id, 'paused', ['preparing']); t.n.batchChanged(id); }
  expect(t.n.list().items).toEqual([]); // not at once
  t.reasons.delete(a); put(t.db, a, 'running', ['preparing']); t.n.batchChanged(a); // a: the tab came back and the batch went on
  t.timers.forEach((f) => f());
  expect(t.n.list().items.map((i) => [i.kind, i.batchId])).toEqual([['attention', b]]); // b: still waiting after the grace time
  expect(t.telegram).toHaveLength(1);
});
