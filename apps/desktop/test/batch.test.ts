import { test, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePrompts, mapRefs, enqueueBatch } from '../src/main/batch';
import { openDb } from '../src/main/db';

const bytes = (...b: number[]) => new Uint8Array(b);
const fresh = () => openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
const n = (db: ReturnType<typeof fresh>, t: string) => (db.prepare(`select count(*) c from ${t}`).get() as { c: number }).c;

test('CRLF and LF give the same items', () => {
  const a = parsePrompts('a\r\n\r\n  \nb').items;
  const b = parsePrompts('a\n\nb').items;
  expect(a.map((x) => x.prompt)).toEqual(['a', 'b']);
  expect(b.map((x) => x.prompt)).toEqual(['a', 'b']);
  expect(a.map((x) => x.sourceLine)).toEqual([1, 4]);
  expect(b.map((x) => x.sourceLine)).toEqual([1, 3]);
});

test('BOM stripped only at start', () => {
  const r = parsePrompts(bytes(0xef, 0xbb, 0xbf, 0x61, 0x0a, 0xef, 0xbb, 0xbf, 0x62));
  expect(r.items.map((x) => x.prompt)).toEqual(['a', '\uFEFFb']);
});

test('invalid utf-8 is an error, not replaced', () => {
  expect(parsePrompts(bytes(0x61, 0x0a, 0xff))).toEqual({ items: [], errors: [{ line: 2, code: 'INVALID_UTF8' }] });
});

test('parsePrompts keeps NFD and NFC as-is', () => {
  const r = parsePrompts('Phở\n' + 'Phở'.normalize('NFD'));
  expect(r.items).toHaveLength(2);
  expect(r.items[1].prompt).toBe('Phở'.normalize('NFD'));
});

test('sequential never wraps', () => {
  const r = mapRefs(3, ['r1', 'r2', 'r3', 'r4'], 'sequential', 2);
  expect(r.errors).toEqual([{ index: 2, code: 'NOT_ENOUGH_REFS' }]);
  expect(r.refs).toEqual([['r1', 'r2'], ['r3', 'r4'], []]);
});

test('other ref modes', () => {
  expect(mapRefs(2, [], 'none', 1).refs).toEqual([[], []]);
  expect(mapRefs(2, ['a', 'b'], 'all', 2).refs).toEqual([['a', 'b'], ['a', 'b']]);
  expect(mapRefs(2, ['a', 'b'], 'all', 1).errors.map((e) => e.code)).toEqual(['TOO_MANY_REFS', 'TOO_MANY_REFS']);
  expect(mapRefs(3, ['a', 'b'], 'start', 9)).toEqual({ refs: [['a'], ['b'], []], errors: [{ index: 2, code: 'NOT_ENOUGH_REFS' }] });
});

test('enqueue is atomic and idempotent', () => {
  const db = fresh();
  const cmd = { commandId: 'c1', kind: 'image' as const, projectId: 'p', settings: { x: 1 }, prompts: ['a', 'b'], refs: [['r'], []], mode: 'manual' as const };
  const orig = db.prepare.bind(db);
  let k = 0;
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.startsWith('insert into item') && ++k === 2) throw new Error('boom');
    return orig(sql);
  }) as typeof db.prepare);
  expect(() => enqueueBatch(db, cmd)).toThrow('boom');
  spy.mockRestore();
  expect([n(db, 'batch'), n(db, 'command'), n(db, 'item'), n(db, 'attempt')]).toEqual([0, 0, 0, 0]);
  const r1 = enqueueBatch(db, cmd);
  const r2 = enqueueBatch(db, cmd);
  expect(r2).toEqual(r1);
  expect(r1.revision).toBe(1);
  expect([n(db, 'batch'), n(db, 'item'), n(db, 'attempt')]).toEqual([1, 2, 2]);
  expect(JSON.parse((db.prepare('select settings_json s from batch').get() as { s: string }).s)).toEqual({ x: 1, mode: 'manual' });
  expect(() => enqueueBatch(db, { ...cmd, commandId: 'c2', refs: [] })).toThrow();
});
