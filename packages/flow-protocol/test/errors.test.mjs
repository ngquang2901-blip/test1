import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PUBLIC_ERRORS, RESUBMITTABLE, BACKOFF_MS, resubmitDelay,
  classifyGenerateError, classifyPollFailure, CLIENT_SIGNALS,
} from '../src/errors.mjs';
import { parseRpcResponse } from '../src/parse.mjs';

// Codes of the ToolFlow catalogue, docs/app/07 §2.
const CATALOGUE = new Set(readFileSync(new URL('../../../docs/app/07-safety-and-recovery.md', import.meta.url), 'utf8')
  .match(/^\| ([A-Z_]+) \|/gm).map((l) => l.slice(2, -2)));

test('table covers exactly the PUBLIC_ERROR enum shipped in Flow frontend source', () => {
  const src = readFileSync(new URL('../../../docs/research/evidence/native-sources/flow-boq-m_b.js', import.meta.url), 'utf8');
  const start = src.indexOf('_.qu={');
  const body = src.slice(start, src.indexOf('}', start));
  const enumPairs = [...body.matchAll(/(\d+):"(PUBLIC_ERROR_[A-Z_]+)"/g)].map((m) => [m[2], Number(m[1])]).sort();
  const table = Object.entries(PUBLIC_ERRORS).map(([k, v]) => [k, v.num]).sort();
  assert.equal(enumPairs.length, 70);
  assert.deepEqual(table, enumPairs);
});

test('every row maps to a ToolFlow catalogue code and a known admission', () => {
  for (const [name, row] of Object.entries(PUBLIC_ERRORS)) {
    assert.ok(CATALOGUE.has(row.code), `${name} -> ${row.code} is not in 07 §2`);
    assert.ok(['continue', 'throttle', 'pause', 'stop_profile'].includes(row.admission), name);
  }
  for (const s of Object.values(CLIENT_SIGNALS)) assert.ok(CATALOGUE.has(s.code));
});

test('table agrees with how Flow itself groups errors (Agent UI in flow-boq-m_wO1vlb.js)', () => {
  const ui = readFileSync(new URL('../../../docs/research/evidence/native-sources/flow-boq-m_wO1vlb.js', import.meta.url), 'utf8');
  const quota = ui.match(/_\.YRb=new Set\("([A-Z_ ]+)"\.split/)[1].split(' ');
  assert.equal(quota.length, 6);
  for (const q of quota) assert.deepEqual([PUBLIC_ERRORS[q].code, PUBLIC_ERRORS[q].admission], ['RATE_LIMIT', 'pause'], q);
  const retry = [...ui.matchAll(/((?:a==="[A-Z_0-9]+"\|\|)*a==="[A-Z_0-9]+")\?\{zi:"[^"]+",\s*Zh:[^,]+,oh:"RETRY"/g)]
    .flatMap((m) => m[1].match(/PUBLIC_ERROR_[A-Z_]+/g) || []);
  // Flow also retries VIDEO_GENERATION_TIMED_OUT, but that error comes after the generation existed: 07 §3 forbids it.
  assert.deepEqual(retry.filter((r) => r !== 'PUBLIC_ERROR_VIDEO_GENERATION_TIMED_OUT').sort(), [...RESUBMITTABLE].sort());
  assert.equal(RESUBMITTABLE.has('PUBLIC_ERROR_VIDEO_GENERATION_TIMED_OUT'), false);
});

test('only the narrow 07 §3 exception may resubmit', () => {
  assert.deepEqual([...RESUBMITTABLE].sort(), ['PUBLIC_ERROR_CONCURRENT_LIMIT_REACHED', 'PUBLIC_ERROR_HIGH_TRAFFIC',
    'PUBLIC_ERROR_MODEL_OVERLOADED', 'PUBLIC_ERROR_USER_REQUESTS_THROTTLED']);
  for (const r of RESUBMITTABLE) assert.equal(PUBLIC_ERRORS[r].admission, 'throttle');
});

test('observed throttle response: resubmit after backoff, slow down, nothing created', () => {
  const rec = JSON.parse(readFileSync(new URL('fixtures/throttled-YhhmEf.json', import.meta.url), 'utf8')).records[0];
  const c = classifyGenerateError(parseRpcResponse(rec.res, rec.rpc).error);
  assert.deepEqual(
    { code: c.code, admission: c.admission, dispatch: c.dispatch, resubmit: c.resubmit },
    { code: 'RATE_LIMIT', admission: 'throttle', dispatch: 'rejected_by_provider', resubmit: true });
});

test('backoff: 30 s doubling to 5 min, then give up after 5 resubmits', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(resubmitDelay), BACKOFF_MS);
  assert.equal(resubmitDelay(5), null);
});

test('policy block, flagged account and unknown codes never resubmit', () => {
  assert.deepEqual(pickKeys(classifyGenerateError({ grpc: 3, reasons: ['PUBLIC_ERROR_SEXUAL'] })),
    { code: 'CONTENT_BLOCKED', admission: 'continue', resubmit: false, drift: false });
  assert.deepEqual(pickKeys(classifyGenerateError({ grpc: 7, reasons: ['PUBLIC_ERROR_UNUSUAL_ACTIVITY'] })),
    { code: 'HUMAN_REQUIRED', admission: 'stop_profile', resubmit: false, drift: false });
  assert.deepEqual(pickKeys(classifyGenerateError({ grpc: 8, reasons: ['PUBLIC_ERROR_SOMETHING_NEW'] })),
    { code: 'PROVIDER_ERROR_UNKNOWN', admission: 'pause', resubmit: false, drift: true });
  assert.equal(classifyGenerateError({ grpc: 8, reasons: [] }).resubmit, false);
  // mixed: the most severe admission wins and one non-resubmittable reason blocks the resubmit
  const mixed = classifyGenerateError({ grpc: 8, reasons: ['PUBLIC_ERROR_USER_REQUESTS_THROTTLED', 'PUBLIC_ERROR_USER_QUOTA_REACHED'] });
  assert.deepEqual(pickKeys(mixed), { code: 'RATE_LIMIT', admission: 'pause', resubmit: false, drift: false });
});

test('poll failures never resubmit, even with a resubmittable code', () => {
  const internal = classifyPollFailure({ grpc: 13, reasons: ['INTERNAL'] });
  assert.deepEqual(pickKeys(internal), { code: 'PROVIDER_ERROR_UNKNOWN', admission: 'continue', resubmit: false, drift: false });
  assert.equal(internal.refundExpected, true);
  assert.equal(classifyPollFailure({ grpc: 8, reasons: ['PUBLIC_ERROR_USER_REQUESTS_THROTTLED'] }).resubmit, false);
  assert.equal(classifyPollFailure({ grpc: 2, reasons: ['UNKNOWN'] }).drift, true);
});

function pickKeys(c) {
  return { code: c.code, admission: c.admission, resubmit: c.resubmit, drift: c.drift };
}
