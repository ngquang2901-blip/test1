import { test, expect } from 'vitest';
import { initial, next } from '@toolflow/flow-protocol/attempt';
import { parseRpcResponse } from '@toolflow/flow-protocol/parse';
import { classifyGenerateError } from '@toolflow/flow-protocol/errors';
import { checkHeartbeat } from '@toolflow/flow-protocol/heartbeat';
import { parseProject, reconcile } from '@toolflow/flow-protocol/project';
import Database from 'better-sqlite3';
test('flow-protocol and sqlite load under electron node', () => {
  expect(next(initial('x'), { type: 'prepare', now: 0 }).item).toBe('preparing');
  expect(new Database(':memory:').prepare('select 1 as v').get()).toEqual({ v: 1 });
  for (const f of [parseRpcResponse, classifyGenerateError, checkHeartbeat, parseProject, reconcile]) expect(typeof f).toBe('function');
});
