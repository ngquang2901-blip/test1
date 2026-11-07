import { test, expect } from 'vitest';
import { initial, next } from '@toolflow/flow-protocol/attempt';
import Database from 'better-sqlite3';
test('flow-protocol and sqlite load under electron node', () => {
  expect(next(initial('x'), { type: 'prepare', now: 0 }).item).toBe('preparing');
  expect(new Database(':memory:').prepare('select 1 as v').get()).toEqual({ v: 1 });
});
