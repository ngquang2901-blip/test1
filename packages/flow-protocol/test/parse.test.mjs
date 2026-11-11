import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ProtocolDrift, parseEnvelope, parseRpcResponse, parseGenerateRequest, readFReq,
  parseImageReceipt, parseVideoReceipt, parsePoll, correlate, parseUploadRequest, parseUploadReceipt,
} from '../src/parse.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')).records;
// Fixture requests are stored decoded (as the spike observer saw them); product code reads f.req via URLSearchParams.
const fReq = (rec) => rec.req.slice('f.req='.length, rec.req.indexOf('&at='));
const sent = (recs) => recs.filter((r) => r.phase === 'sent');
const done = (recs) => recs.filter((r) => r.phase === 'done');
const payload = (rec) => parseRpcResponse(rec.res, rec.rpc).payload;

test('image 1:1 burst: each request binds to exactly one receipt, even with duplicate prompts', () => {
  const recs = fx('image-1x1-burst3.json');
  const reqs = sent(recs).map((r) => parseGenerateRequest(fReq(r)));
  const recv = done(recs).map((r) => parseImageReceipt(payload(r)));
  assert.equal(reqs.length, 3);
  assert.equal(reqs[1].items[0].prompt, reqs[2].items[0].prompt, 'fixture has two identical prompts');
  for (const q of reqs) {
    assert.equal(q.rpc, 'ogiZ0b');
    assert.equal(q.items[0].aspectCode, 1);
    const owners = recv.filter((r) => correlate(q, r).owned);
    assert.equal(owners.length, 1);
    const o = owners[0].outputs[0];
    assert.equal(o.seed, q.items[0].seed);
    assert.equal(o.prompt, q.items[0].prompt, 'response echoes the original Vietnamese prompt');
    assert.deepEqual([o.width, o.height], [1024, 1024]);
    assert.match(o.url, /^https:\/\/flow-content\.google\/image\//);
  }
});

test('image 9:16 x2: two items with their own seeds, outputs paired by seed', () => {
  const recs = fx('image-9x16-x2.json');
  const q = parseGenerateRequest(fReq(sent(recs)[0]));
  const r = parseImageReceipt(payload(done(recs)[0]));
  assert.equal(q.items.length, 2);
  assert.deepEqual(q.items.map((i) => i.aspectCode), [2, 2]);
  assert.notEqual(q.items[0].seed, q.items[1].seed);
  const c = correlate(q, r);
  assert.equal(c.owned, true);
  assert.deepEqual(c.outputs.map((o) => o.item).sort(), [0, 1]);
  assert.deepEqual(c.outputs.map((o) => [o.width, o.height]), [[768, 1376], [768, 1376]]);
  // same batch but a seed that is not ours: refuse ownership instead of pairing by position
  const forged = { ...q, items: [q.items[0], { ...q.items[1], seed: q.items[1].seed + 1 }] };
  assert.deepEqual(correlate(forged, r), { owned: false, reason: 'seed_mismatch' });
});

test('video text-to-video: receipt is accepted, not finished, and carries credits', () => {
  const recs = fx('video-t2v.json');
  const q = parseGenerateRequest(fReq(sent(recs)[0]));
  const r = parseVideoReceipt(payload(done(recs)[0]));
  assert.equal(q.rpc, 'YhhmEf');
  assert.equal(q.items[0].model, 'veo_3_1_t2v_lite');
  assert.equal(r.credits, 958);
  assert.equal(r.operations.length, 1);
  assert.equal(r.operations[0].status, 'accepted');
  assert.equal(r.operations[0].prompt, q.items[0].prompt);
  assert.equal(correlate(q, r).owned, true);
});

test('video ingredients: the ref id in the request is the one Flow used', () => {
  const recs = fx('video-ingredients.json');
  const q = parseGenerateRequest(fReq(sent(recs)[0]));
  const r = parseVideoReceipt(payload(done(recs)[0]));
  assert.equal(q.items[0].model, 'veo_3_1_r2v_lite');
  assert.deepEqual(q.items[0].refIds, ['fa4e0000-0000-4000-8000-00000000000d']);
  assert.deepEqual(r.operations[0].refIds, q.items[0].refIds);
  assert.equal(correlate(q, r).owned, true);
});

test('another request does not own a receipt', () => {
  const t2v = fx('video-t2v.json'), ing = fx('video-ingredients.json');
  const q = parseGenerateRequest(fReq(sent(t2v)[0]));
  assert.deepEqual(correlate(q, parseVideoReceipt(payload(done(ing)[0]))), { owned: false, reason: 'batch_mismatch' });
});

test('poll: running and succeeded operations are told apart and keep their ids', () => {
  const running = parsePoll(payload(fx('poll-running.json')[0]));
  assert.deepEqual(running.operations.map((o) => o.status), ['running']);
  const finished = parsePoll(payload(fx('poll-succeeded-2.json')[0]));
  assert.equal(finished.credits, 948);
  assert.deepEqual(finished.operations.map((o) => o.status), ['succeeded', 'succeeded']);
  const t2v = parseVideoReceipt(payload(done(fx('video-t2v.json'))[0])).operations[0];
  assert.ok(finished.operations.some((o) => o.operationId === t2v.operationId && o.workflowId === t2v.workflowId));
});

test('poll: failed operation exposes the gRPC code (shape seen in lượt 21)', () => {
  // No raw failed poll was stored; this applies the status tuple printed in lượt 21 to a real poll.
  const rec = fx('poll-running.json')[0];
  const p = payload(rec);
  p[2][0][5][8] = [4, [13, 'INTERNAL'], ['INTERNAL']];
  p[2][0][5][9] = 10;
  const op = parsePoll(p).operations[0];
  assert.equal(op.status, 'failed');
  assert.deepEqual(op.failure, { grpc: 13, reasons: ['INTERNAL'] });
});

test('throttled generate: RPC error with HTTP 200 and no payload', () => {
  for (const name of ['throttled-ogiZ0b.json', 'throttled-YhhmEf.json']) {
    const rec = fx(name)[0];
    assert.equal(rec.status, 200);
    assert.deepEqual(parseRpcResponse(rec.res, rec.rpc), { error: { grpc: 8, reasons: ['PUBLIC_ERROR_USER_REQUESTS_THROTTLED'] } });
  }
});

test('raw wire body with a ref: URL decoding keeps Vietnamese exact and the ref is the uploaded media', () => {
  const recs = fx('image-1x1-ref-raw.json');
  const q = parseGenerateRequest(readFReq(sent(recs)[0].raw));
  assert.equal(q.items[0].prompt, 'Văn bản mẫu 0009');
  const up = fx('upload-maseQ.json');
  const upload = parseUploadReceipt(payload(done(up)[0]));
  assert.deepEqual(q.items[0].refIds, [upload.mediaId], 'generate uses the media id returned by the upload');
  assert.equal(correlate(q, parseImageReceipt(payload(done(recs)[0]))).owned, true);
  assert.deepEqual(parseGenerateRequest(fReq(sent(fx('image-1x1-burst3.json'))[0])).items[0].refIds, []);
});

test('upload: the file name is the only echo, so it is the ownership key', () => {
  const recs = fx('upload-maseQ.json');
  const q = parseUploadRequest(fReq(sent(recs)[0]));
  const r = parseUploadReceipt(payload(done(recs)[0]));
  assert.deepEqual(q, { mime: 'image/jpeg', fileName: 'sample-file-0003.jpg' });
  assert.equal(r.fileName, q.fileName);
  assert.deepEqual([r.mime, r.width, r.height], ['image/jpeg', 768, 1376]);
  assert.throws(() => parseUploadRequest(fReq(sent(fx('image-1x1-burst3.json'))[0])), ProtocolDrift);
  const p = payload(done(recs)[0]);
  p[1][3][4] = p[1][0];                                                 // workflow points at another media
  assert.throws(() => parseUploadReceipt(p), ProtocolDrift);
});

test('drift: unexpected shapes throw ProtocolDrift instead of guessing', () => {
  assert.throws(() => readFReq('at=x&foo=1'), ProtocolDrift);         // no f.req in the body
  const img = fx('image-1x1-burst3.json');
  const okRes = done(img)[0].res;
  const okReq = fReq(sent(img)[0]);
  const drift = (fn) => assert.throws(fn, (e) => e instanceof ProtocolDrift && e.code === 'PROTOCOL_DRIFT');

  drift(() => parseEnvelope(okRes.slice(4)));                          // XSSI prefix missing
  drift(() => parseRpcResponse(okRes, 'YhhmEf'));                       // no frame for that rpc
  drift(() => parseRpcResponse(okRes.replace('["di"', '["wrb.fr","ogiZ0b","[]"],["di"'), 'ogiZ0b')); // two frames
  drift(() => parseGenerateRequest(okReq.replace('"ogiZ0b"', '"eb1hJf"'))); // start-frame RPC: no fixture yet

  const inner = JSON.parse(JSON.parse(okReq)[0][0][1]);
  inner[1][0][3] = String(inner[1][0][3]);                              // seed became a string
  const outer = JSON.parse(okReq); outer[0][0][1] = JSON.stringify(inner);
  assert.throws(() => parseGenerateRequest(JSON.stringify(outer)), /request ogiZ0b item 0 \[3\]/);

  const p = payload(done(img)[0]);
  p[1][0][3][5] = 'not-a-uuid';                                         // batch id missing
  drift(() => parseImageReceipt(p));

  const poll = payload(fx('poll-running.json')[0]);
  poll[2][0][5][8] = [9];                                               // unknown status code
  drift(() => parsePoll(poll));
});

test('harmless additions do not break parsing', () => {
  const rec = done(fx('image-1x1-burst3.json'))[0];
  const p = payload(rec);
  p.push(['new field']);
  p[0][0].push('extra');
  assert.equal(parseImageReceipt(p).outputs.length, 1);
});
