import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHeartbeat, MAX_AGE_MS } from '../src/heartbeat.mjs';

const NOW = 1_800_000_000_000;
const ping = (o = {}) => ({ xhrSend: true, xhrOpen: true, fetch: true, id: 'a', seq: 5, dropped: 0, t: NOW, ...o });
const check = (p, baseline) => checkHeartbeat(p, { now: NOW, baseline }).reasons;

test('alive: our hooks, fresh, same page, nothing dropped', () => {
  assert.deepEqual(checkHeartbeat(ping(), { now: NOW }), { alive: true, reasons: [] });
  assert.deepEqual(check(ping({ seq: 9 }), ping()), []);
});

test('each failure mode is named', () => {
  assert.deepEqual(check(null), ['no_ping']);
  assert.deepEqual(check(ping({ xhrSend: false, fetch: false })), ['hook_xhr_send', 'hook_fetch']);
  assert.deepEqual(check(ping({ id: undefined })), ['old_observer']);           // spike observer before seq/id
  assert.deepEqual(check(ping({ t: NOW - MAX_AGE_MS - 1 })), ['stale']);
  assert.deepEqual(check(ping({ id: 'b', seq: 0 }), ping()), ['page_reloaded']);
  assert.deepEqual(check(ping({ seq: 4 }), ping()), ['seq_backwards']);
  assert.deepEqual(check(ping({ seq: 300, dropped: 2 }), ping()), ['records_dropped']);
});
