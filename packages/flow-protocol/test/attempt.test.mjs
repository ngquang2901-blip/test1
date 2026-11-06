import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRpcResponse, parseGenerateRequest, parseImageReceipt, parseVideoReceipt, parsePoll } from '../src/parse.mjs';
import { initial, next, canClick, IllegalTransition } from '../src/attempt.mjs';
import { BACKOFF_MS } from '../src/errors.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')).records;
const fReq = (rec) => rec.req.slice('f.req='.length, rec.req.indexOf('&at='));
const payload = (rec) => parseRpcResponse(rec.res, rec.rpc).payload;

// Real traffic: image lượt 16 (request 0 ↔ its receipt), video lượt 17A, polls lượt 17, throttle lượt 25.
const img = fx('image-1x1-burst3.json');
const imgReq = parseGenerateRequest(fReq(img.filter((r) => r.phase === 'sent')[0]));
const imgRec = img.filter((r) => r.phase === 'done').map((r) => parseImageReceipt(payload(r))).find((r) => r.batchId === imgReq.batchId);
const otherImgRec = img.filter((r) => r.phase === 'done').map((r) => parseImageReceipt(payload(r))).find((r) => r.batchId !== imgReq.batchId);
const vid = fx('video-t2v.json');
const vidReq = parseGenerateRequest(fReq(vid.find((r) => r.phase === 'sent')));
const vidRec = parseVideoReceipt(payload(vid.find((r) => r.phase === 'done')));
const pollRunning = parsePoll(payload(fx('poll-running.json')[0]));
const pollDone = parsePoll(payload(fx('poll-succeeded-2.json')[0]));
const throttled = parseRpcResponse(fx('throttled-ogiZ0b.json')[0].res, 'ogiZ0b').error;

const NOW = 1_800_000_000_000;
const ping = (o = {}) => ({ xhrSend: true, xhrOpen: true, fetch: true, id: 'obs-1', seq: 10, dropped: 0, t: NOW, ...o });
const CLICK_OK = { found: true, disabled: false, listeners: 1, called: 1 };

const run = (s, ...evs) => evs.reduce(next, s);
const toClick = (prompt) => run(initial(prompt), { type: 'prepare', now: NOW }, { type: 'intent', ping: ping(), now: NOW });
const toSent = (req) => run(toClick(req.items[0].prompt), { type: 'clicked', result: CLICK_OK }, { type: 'sent', request: req });

test('image happy path on real traffic: one click, receipt owned by seed + batch → ready', () => {
  const s0 = toClick(imgReq.items[0].prompt);
  assert.equal(canClick(s0), true);
  const s1 = next(s0, { type: 'clicked', result: CLICK_OK });
  assert.equal(canClick(s1), false, 'one intent = one click');
  assert.throws(() => next(s1, { type: 'clicked', result: CLICK_OK }), IllegalTransition);
  const s = run(s1, { type: 'sent', request: imgReq }, { type: 'receipt', receipt: imgRec });
  assert.deepEqual([s.item, s.stage, s.outputs.length], ['ready', 'outcome_known', 1]);
});

test('a receipt from another request (same prompt text) is not ours → needs_review, not ready', () => {
  const s = next(toSent(imgReq), { type: 'receipt', receipt: otherImgRec });
  assert.deepEqual([s.item, s.error.code, s.error.why], ['needs_review', 'RESULT_OWNERSHIP_AMBIGUOUS', 'batch_mismatch']);
});

test('video on real traffic: accepted → running → poll that also lists another attempt → ready', () => {
  let s = next(toSent(vidReq), { type: 'receipt', receipt: vidRec });
  assert.deepEqual([s.item, s.stage], ['generating', 'accepted']);
  s = next(s, { type: 'poll', operations: pollRunning.operations });
  assert.equal(s.item, 'generating');
  assert.equal(next(s, { type: 'poll', operations: pollDone.operations.filter((o) => o.operationId !== s.operations[0].operationId) }).item,
    'generating', 'a poll listing only other attempts says nothing about ours');
  s = next(s, { type: 'poll', operations: pollDone.operations });
  assert.deepEqual([s.item, s.outputs.map((o) => o.operationId)], ['ready', [vidRec.operations[0].operationId]]);
});

test('poll INTERNAL: failed, Flow refunds, and there is no edge back to submitting', () => {
  let s = next(toSent(vidReq), { type: 'receipt', receipt: vidRec });
  const failed = { ...pollRunning.operations[0], status: 'failed', failure: { grpc: 13, reasons: ['INTERNAL'] } };
  s = next(s, { type: 'poll', operations: [failed] });
  assert.deepEqual([s.item, s.error.resubmit, s.error.refundExpected], ['failed', false, true]);
  assert.throws(() => next(s, { type: 'prepare', now: NOW }), IllegalTransition);
});

test('throttled generate response: same attempt waits 30 s, 60 s… then RATE_LIMIT + pause after 5', () => {
  let s = toSent(imgReq);
  for (let i = 0; i < BACKOFF_MS.length; i++) {
    s = next(s, { type: 'rejected', error: throttled, now: NOW });
    assert.deepEqual([s.item, s.stage, s.resubmits, s.retryAt - NOW], ['queued', 'rejected_before_dispatch', i + 1, BACKOFF_MS[i]]);
    assert.throws(() => next(s, { type: 'prepare', now: NOW }), IllegalTransition, 'backoff is enforced');
    s = run(s, { type: 'prepare', now: s.retryAt }, { type: 'intent', ping: ping(), now: NOW },
      { type: 'clicked', result: CLICK_OK }, { type: 'sent', request: imgReq });
  }
  s = next(s, { type: 'rejected', error: throttled, now: NOW });
  assert.deepEqual([s.item, s.error.code, s.admission, s.error.exhausted], ['failed', 'RATE_LIMIT', 'pause', true]);
});

test('non-resubmittable rejection settles the attempt; stop during backoff cancels (Flow created nothing)', () => {
  const blocked = next(toSent(imgReq), { type: 'rejected', error: { grpc: 3, reasons: ['PUBLIC_ERROR_UNSAFE_GENERATION'] }, now: NOW });
  assert.deepEqual([blocked.item, blocked.error.code], ['failed', 'CONTENT_BLOCKED']);
  const waiting = next(toSent(imgReq), { type: 'rejected', error: throttled, now: NOW });
  assert.equal(next(waiting, { type: 'stop' }).item, 'cancelled');
});

test('click with no listener run = rejected before dispatch, pause; prepare again in the same attempt', () => {
  const s = next(toClick('x'), { type: 'clicked', result: { found: true, disabled: false, listeners: 0, called: 0 } });
  assert.deepEqual([s.item, s.stage, s.error.signal, s.admission], ['preparing', 'rejected_before_dispatch', 'SUBMIT_LISTENER_MISSING', 'pause']);
  assert.equal(next(s, { type: 'intent', ping: ping(), now: NOW }).stage, 'intent_recorded');
});

test('dead observer before intent: refuse, stay preparing, no click possible', () => {
  const s = run(initial('x'), { type: 'prepare', now: NOW }, { type: 'intent', ping: ping({ fetch: false }), now: NOW });
  assert.deepEqual([s.item, s.error.signal, s.error.reasons, canClick(s)], ['preparing', 'OBSERVER_DEAD', ['hook_fetch'], false]);
});

test('observer lost or deadline after the click → SUBMIT_UNCERTAIN; a late real receipt settles it (lượt 30)', () => {
  const clicked = next(toClick(imgReq.items[0].prompt), { type: 'clicked', result: CLICK_OK });
  assert.equal(next(clicked, { type: 'heartbeat', ping: ping({ seq: 11 }), now: NOW }).item, 'submitting');
  const reloaded = next(clicked, { type: 'heartbeat', ping: ping({ id: 'obs-2', seq: 0 }), now: NOW });
  assert.deepEqual([reloaded.item, reloaded.stage, reloaded.error.reasons], ['needs_review', 'uncertain', ['page_reloaded']]);
  assert.throws(() => next(reloaded, { type: 'intent', ping: ping(), now: NOW }), IllegalTransition);
  const late = run(clicked, { type: 'sent', request: imgReq }, { type: 'deadline' });
  assert.equal(late.error.code, 'SUBMIT_UNCERTAIN');
  assert.equal(next(late, { type: 'receipt', receipt: imgRec }).item, 'ready');
  const lateThrottle = next(late, { type: 'rejected', error: throttled, now: NOW });
  assert.deepEqual([lateThrottle.item, lateThrottle.resubmits], ['failed', 0], 'after uncertainty a rejection settles, never re-queues');
});

test('crash between intent and a journaled click: deadline → needs_review, never a click on recovery', () => {
  const s = next(toClick('x'), { type: 'deadline' });
  assert.deepEqual([s.item, s.stage, s.error.code, canClick(s)], ['needs_review', 'uncertain', 'SUBMIT_UNCERTAIN', false]);
});

test('D-04 restart: intent without receipt → uncertain, credit counted; receipt-backed attempts keep going', () => {
  const s = next(next(toClick('x'), { type: 'clicked', result: CLICK_OK }), { type: 'restart' });
  assert.deepEqual([s.item, s.stage, s.error.why, s.creditSpent, canClick(s)], ['needs_review', 'uncertain', 'restart', true, false]);
  assert.equal(next(toClick('x'), { type: 'restart' }).item, 'needs_review', 'intent recorded, click not journaled');
  const gen = next(toSent(vidReq), { type: 'receipt', receipt: vidRec });
  assert.equal(next(gen, { type: 'restart' }), gen);
  assert.equal(next(initial('x'), { type: 'restart' }).item, 'queued');
});

test('D-11 user confirms sent / not sent: attempt settles, credit stays spent, nothing is requeued', () => {
  const u = next(next(toClick('x'), { type: 'clicked', result: CLICK_OK }), { type: 'deadline' });
  for (const to of ['sent', 'not_sent']) {
    const s = next(u, { type: 'resolve', to, evidence: 'user' });
    assert.deepEqual([s.item, s.stage, s.error.resolution, s.error.userConfirmed, s.creditSpent], ['failed', 'outcome_known', to, true, true]);
    assert.throws(() => next(s, { type: 'prepare', now: NOW }), IllegalTransition);
  }
  assert.throws(() => next(u, { type: 'resolve', to: 'not_sent' }), IllegalTransition, 'evidence required');
});

test('two generate requests for one click → needs_review that a single receipt cannot clear', () => {
  const s = next(toSent(imgReq), { type: 'sent', request: imgReq });
  assert.equal(s.error.double, true);
  assert.throws(() => next(s, { type: 'receipt', receipt: imgRec }), IllegalTransition);
  assert.equal(next(s, { type: 'resolve', to: 'ready', evidence: 'user checked grid' }).item, 'ready');
  assert.throws(() => next(s, { type: 'resolve', to: 'ready' }), IllegalTransition, 'evidence required');
});

test('prompt on the wire differs from ours → USER_INTERFERENCE', () => {
  const s = next(next(toClick('khác'), { type: 'clicked', result: CLICK_OK }), { type: 'sent', request: imgReq });
  assert.deepEqual([s.item, s.error.code], ['needs_review', 'USER_INTERFERENCE']);
});

test('stop: cancels only what surely was not sent', () => {
  assert.equal(next(initial('x'), { type: 'stop' }).item, 'cancelled');
  const s = next(next(toClick('x'), { type: 'clicked', result: CLICK_OK }), { type: 'stop' });
  assert.deepEqual([s.item, s.stopRequested], ['submitting', true]);
  assert.equal(canClick(next(toClick('x'), { type: 'stop' })), false, 'stop closes the click gate');
});

test('fuzz: no event order clicks twice per intent, resubmits outside 07 §3, or cancels a sent attempt', () => {
  let r = 42; const rnd = (n) => ((r = (r * 1103515245 + 12345) % 2 ** 31), r % n);
  const evs = [
    { type: 'prepare', now: NOW + 1e9 }, { type: 'intent', ping: ping(), now: NOW }, { type: 'intent', ping: ping({ xhrSend: false }), now: NOW },
    { type: 'clicked', result: CLICK_OK }, { type: 'clicked', result: { called: 0 } }, { type: 'sent', request: imgReq },
    { type: 'receipt', receipt: imgRec }, { type: 'receipt', receipt: otherImgRec }, { type: 'rejected', error: throttled, now: NOW },
    { type: 'rejected', error: { grpc: 8, reasons: ['PUBLIC_ERROR_UNUSUAL_ACTIVITY'] }, now: NOW }, { type: 'heartbeat', ping: ping({ dropped: 3 }), now: NOW },
    { type: 'deadline' }, { type: 'stop' }, { type: 'resolve', to: 'failed', evidence: 'x' }, { type: 'prep_failed', error: { code: 'SETTINGS_NOT_APPLIED' } },
  ];
  for (let run = 0; run < 2000; run++) {
    let s = initial(imgReq.items[0].prompt), intents = 0, clicks = 0;
    for (let k = 0; k < 30; k++) {
      const ev = evs[rnd(evs.length)];
      let n; try { n = next(s, ev); } catch (e) { assert.ok(e instanceof IllegalTransition); continue; }
      if (n.stage === 'intent_recorded' && s.stage !== 'intent_recorded') intents++;
      if (ev.type === 'clicked' && ev.result.called) clicks++;
      if (n.item === 'queued' && s.item !== 'queued') assert.equal(ev.type, 'rejected', 'only a provider rejection re-queues');
      if (s.item === 'needs_review' && n.item === 'submitting') assert.fail('needs_review → submitting');
      if (n.item === 'cancelled' && s.item !== 'cancelled') assert.ok(!s.clicked || ev.type === 'rejected', 'cancelled after a possible dispatch');
      s = n;
    }
    assert.ok(clicks <= intents, `clicks ${clicks} > intents ${intents}`);
    assert.ok(s.resubmits <= BACKOFF_MS.length);
  }
});
