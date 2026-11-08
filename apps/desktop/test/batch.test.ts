import { test, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePrompts, mapRefs, enqueueBatch } from '../src/main/batch';
import { initial } from '@toolflow/flow-protocol/attempt';
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
  expect(() => enqueueBatch(db, { ...cmd, commandId: 'c2', refs: [] })).toThrow('prompts/refs length mismatch');
  expect(n(db, 'batch')).toBe(1);
});

test('enqueue storage contract', () => {
  const db = fresh();
  const cmd = { commandId: 'c1', kind: 'video' as const, projectId: 'p', settings: {}, prompts: ['a', 'b', 'c'], refs: [['r1', 'r2'], [], ['r3']], mode: 'auto' as const };
  const { batchId } = enqueueBatch(db, cmd);
  const b = db.prepare('select revision, status from batch where id=?').get(batchId);
  expect(b).toEqual({ revision: 1, status: 'queued' });
  const rows = db.prepare('select i.ord, i.prompt, i.refs_json, i.source_line, i.attempt_id, a.id aid, a.ordinal, a.state_json from item i left join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(batchId) as any[];
  expect(rows.map((r) => r.ord)).toEqual([0, 1, 2]);
  rows.forEach((r, i) => {
    expect(r.refs_json).toBe(JSON.stringify(cmd.refs[i]));
    expect(r.attempt_id).not.toBeNull();
    expect(r.aid).toBe(r.attempt_id);
    expect(r.ordinal).toBe(1);
    expect(r.state_json).toBe(JSON.stringify(initial(cmd.prompts[i])));
    expect(r.source_line).toBeNull();
  });
});

test('enqueue stores sourceLines and validates length', () => {
  const db = fresh();
  const cmd = { commandId: 'c1', kind: 'image' as const, projectId: 'p', settings: {}, prompts: ['a', 'b'], refs: [[], []], mode: 'auto' as const };
  expect(() => enqueueBatch(db, { ...cmd, sourceLines: [1] })).toThrow('prompts/sourceLines length mismatch');
  expect(n(db, 'batch')).toBe(0);
  enqueueBatch(db, { ...cmd, sourceLines: [3, 7] });
  expect((db.prepare('select source_line s from item order by ord').all() as { s: number }[]).map((x) => x.s)).toEqual([3, 7]);
});

test('prompts are not trimmed; string BOM stripped', () => {
  expect(parsePrompts('x\n  a b  \t\ny').items.map((x) => x.prompt)).toEqual(['x', '  a b  \t', 'y']);
  expect(parsePrompts('\uFEFFa\nb').items.map((x) => x.prompt)).toEqual(['a', 'b']);
});
