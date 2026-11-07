import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initial } from '@toolflow/flow-protocol/attempt';
import { openDb, type Db } from '../src/main/db';
import { applyEvent } from '../src/main/journal';

function seed(db: Db) {
  db.prepare("insert into batch(id,kind,target_project,settings_json,status,created_at) values('b','image','p','{}','running',0)").run();
  db.prepare("insert into item(id,batch_id,ord,source_line,prompt,refs_json,attempt_id) values('i','b',0,1,'x','[]','a')").run();
  db.prepare("insert into attempt(id,item_id,ordinal,state_json) values('a','i',1,?)").run(JSON.stringify(initial('x')));
}
const count = (db: Db) => (db.prepare('select count(*) c from journal_event').get() as { c: number }).c;
const stateJson = (db: Db) => (db.prepare("select state_json s from attempt where id='a'").get() as { s: string }).s;
const ping = { xhrSend: true, xhrOpen: true, fetch: true, id: 'o', seq: 1, dropped: 0, t: 1000 };

function fresh() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  seed(db);
  return db;
}

test('applies event and journals it', () => {
  const db = fresh();
  const s = applyEvent(db, 'a', { type: 'prepare', now: 1 }, 1);
  expect(s.item).toBe('preparing');
  expect(JSON.parse(stateJson(db)).item).toBe('preparing');
  expect(db.prepare('select type from journal_event').all()).toEqual([{ type: 'prepare' }]);
  expect(db.prepare("select revision r from attempt where id='a'").get()).toEqual({ r: 1 });
});

test('illegal event leaves db unchanged', () => {
  const db = fresh();
  const before = stateJson(db);
  expect(() => applyEvent(db, 'a', { type: 'clicked', result: {} }, 1)).toThrow(expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }));
  expect(stateJson(db)).toBe(before);
  expect(count(db)).toBe(0);
});

test('wal and full sync', () => {
  const db = fresh();
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(db.pragma('synchronous', { simple: true })).toBe(2);
});

test('intent write failure blocks click', () => {
  const db = fresh();
  applyEvent(db, 'a', { type: 'prepare', now: 1000 }, 1000);
  db.pragma('query_only = 1');
  expect(() => applyEvent(db, 'a', { type: 'intent', ping, now: 1000 }, 1000)).toThrow();
  db.pragma('query_only = 0');
  expect(JSON.parse(stateJson(db)).item).toBe('preparing');
  expect(count(db)).toBe(1);
});
