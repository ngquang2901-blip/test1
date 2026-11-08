import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initial } from '@toolflow/flow-protocol/attempt';
import { parseRpcResponse, parseGenerateRequest, parseImageReceipt } from '@toolflow/flow-protocol/parse';
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

test('never persists signed urls', () => {
  const recs = JSON.parse(readFileSync(join(__dirname, '../../../packages/flow-protocol/test/fixtures/image-1x1-burst3.json'), 'utf8')).records;
  const sent = recs.filter((r: any) => r.phase === 'sent')[0];
  const req = parseGenerateRequest(sent.req.slice('f.req='.length, sent.req.indexOf('&at=')));
  const rec = recs.filter((r: any) => r.phase === 'done').map((r: any) => parseImageReceipt((parseRpcResponse(r.res, r.rpc) as any).payload)).find((r: any) => r.batchId === req.batchId);
  const NOW = 1_800_000_000_000;
  const db = fresh();
  db.prepare("update attempt set state_json = ? where id = 'a'").run(JSON.stringify(initial(req.items[0].prompt)));
  applyEvent(db, 'a', { type: 'prepare', now: NOW }, NOW);
  applyEvent(db, 'a', { type: 'intent', ping: { ...ping, t: NOW }, now: NOW }, NOW);
  applyEvent(db, 'a', { type: 'clicked', result: { found: true, disabled: false, listeners: 1, called: 1 } }, NOW);
  applyEvent(db, 'a', { type: 'sent', request: req }, NOW);
  const s = applyEvent(db, 'a', { type: 'receipt', receipt: rec }, NOW);
  expect(s.outputs!.length).toBeGreaterThan(0);
  expect(s.outputs!.every((o: any) => o.mediaId)).toBe(true);
  expect(JSON.stringify(s)).toContain('Signature='); // in-memory state keeps urls
  const stored = stateJson(db) + JSON.stringify(db.prepare('select payload_json from journal_event').all());
  for (const bad of ['Signature=', 'flow-content.google', 'googleusercontent']) expect(stored).not.toContain(bad);
});

test('keeps prompts that look like urls', () => {
  const recs = JSON.parse(readFileSync(join(__dirname, '../../../packages/flow-protocol/test/fixtures/image-1x1-burst3.json'), 'utf8')).records;
  const sent = recs.filter((r: any) => r.phase === 'sent')[0];
  const req = parseGenerateRequest(sent.req.slice('f.req='.length, sent.req.indexOf('&at=')));
  const prompt = 'https://example.com/ref.jpg a red bike';
  req.items[0].prompt = prompt;
  const NOW = 1_800_000_000_000;
  const db = fresh();
  db.prepare("update attempt set state_json = ? where id = 'a'").run(JSON.stringify(initial(prompt)));
  applyEvent(db, 'a', { type: 'prepare', now: NOW }, NOW);
  applyEvent(db, 'a', { type: 'intent', ping: { ...ping, t: NOW }, now: NOW }, NOW);
  applyEvent(db, 'a', { type: 'clicked', result: { found: true, disabled: false, listeners: 1, called: 1 } }, NOW);
  const s = applyEvent(db, 'a', { type: 'sent', request: req }, NOW);
  expect(s.item).not.toBe('needs_review');
  expect(stateJson(db)).toContain(JSON.stringify(prompt).slice(1, -1));
  expect(stateJson(db)).not.toContain('REDACTED_URL');
});
