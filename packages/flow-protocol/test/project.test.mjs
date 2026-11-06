import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRpcResponse, parseGenerateRequest, parseImageReceipt, parseVideoReceipt, ProtocolDrift } from '../src/parse.mjs';
import { parseProject, reconcile } from '../src/project.mjs';
import { initial, next } from '../src/attempt.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')).records;
const fReq = (rec) => rec.req.slice('f.req='.length, rec.req.indexOf('&at='));
const payload = (rec) => parseRpcResponse(rec.res, rec.rpc).payload;
const PROJECT = 'b89ba0b5-d5e3-44d9-8d86-1851dd147159';
const rawProject = () => payload(fx('project-Zzl0ze.json').find((r) => r.phase === 'done'));
const project = parseProject(rawProject(), PROJECT);

// Real attempts from spike runs (run30.json, run31.json in the spike scratch; FINDINGS lượt 30–31).
const RUN31 = { prompt: 'Cận cảnh đĩa bánh cuốn nóng, ảnh chụp đời thường', kind: 'image', clickMs: 1793951501654 }; // observer blind
const CAT = { prompt: 'Chú mèo vờn cuộn len, buổi sáng, máy quay đứng yên', kind: 'video', clickMs: 1793951219653 };
const GRANNY = { prompt: 'Bà cụ đan len bên lò sưởi, buổi sáng, máy quay đứng yên', kind: 'video', clickMs: 1793951227655, batchId: '348E8F61-D218-46F8-82FD-6EA98CBA927E' };

test('Zzl0ze listing: counts, and every generate receipt we hold is found with the same ids, seed and prompt', () => {
  const kinds = {};
  for (const m of project.media) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
  assert.deepEqual([project.workflows.size, project.media.length, kinds], [280, 280, { image: 164, video: 103, upload: 13 }]);
  for (const name of ['image-1x1-ref-raw.json', 'image-9x16-x2.json', 'image-1x1-burst3.json']) {
    for (const rec of fx(name).filter((r) => r.phase === 'done' && r.rpc === 'ogiZ0b')) {
      const r = parseImageReceipt(payload(rec));
      for (const o of r.outputs) {
        const m = project.media.find((x) => x.mediaId === o.mediaId);
        assert.deepEqual([m.workflowId, m.batchId, m.seed, m.prompt, m.kind], [o.workflowId, r.batchId, o.seed, o.prompt, 'image'], name);
      }
    }
  }
  const ref = project.media.find((m) => m.mediaId === '6710fe93-4fe1-49bd-b2c6-4a91277ec660');
  assert.deepEqual(ref.refIds, ['e838b42d-8e72-4ae7-8ce9-6a2c6cf09cd5'], 'ref = uploaded media of lượt 34');
  const v = parseVideoReceipt(payload(fx('video-t2v.json').find((r) => r.phase === 'done'))).operations[0];
  const vm = project.media.find((m) => m.mediaId === v.operationId);
  assert.deepEqual([vm.kind, vm.prompt, vm.model, vm.status, vm.workflowId], ['video', v.prompt, v.model, 3, v.workflowId]);
});

test('reconcile without batch id (observer blind, lượt 31): exactly one media just after the click → found', () => {
  const r = reconcile(project, RUN31);
  assert.equal(r.verdict, 'found');
  assert.deepEqual(r.mediaIds, ['7260a21b-c546-4ec0-866b-1123de1f36d8']);
  assert.equal(r.evidence.deltaMs, 6519);
});

test('reconcile: same prompt sent twice — the time window keeps it unique, a wide window makes it ambiguous', () => {
  assert.deepEqual([reconcile(project, CAT).verdict, reconcile(project, CAT).mediaIds], ['found', ['e5300814-f2fd-4ae3-8530-1821eea9ca8c']]);
  assert.equal(reconcile(project, CAT, { windowMs: 200_000 }).verdict, 'ambiguous', 'second send 178 s later');
  const owned = new Set(['596ea880-6713-4fe4-b430-5dfd208d13ac']);
  assert.equal(reconcile(project, CAT, { windowMs: 200_000, owned }).verdict, 'found', 'media of other attempts are excluded');
  assert.equal(reconcile(project, { ...CAT, clickMs: CAT.clickMs + 10_000 }).verdict, 'not_found', 'never matches media created before the click');
  assert.equal(reconcile(project, { ...CAT, kind: 'image' }).verdict, 'not_found');
});

test('reconcile with batch id: x2 batch returns both media; accepted-but-missing video stays not_found (unknown, not "not sent")', () => {
  const q = parseGenerateRequest(fReq(fx('image-9x16-x2.json').find((r) => r.phase === 'sent')));
  const r = reconcile(project, { prompt: q.items[0].prompt, kind: 'image', clickMs: 0, batchId: q.batchId });
  assert.deepEqual([r.verdict, r.mediaIds.length], ['found', 2]);
  const g = reconcile(project, GRANNY); // lượt 30: receipt HTTP 200 accepted, yet absent from the listing
  assert.deepEqual([g.verdict, g.evidence.meaning], ['not_found', 'unknown']);
  assert.equal(reconcile(project, { ...r, ...{ prompt: 'khác', kind: 'image', clickMs: 0, batchId: q.batchId } }).verdict, 'ambiguous', 'batch with another prompt');
});

test('found evidence resolves an uncertain attempt to ready; not_found/ambiguous leave it blocked', () => {
  const ping = { xhrSend: true, xhrOpen: true, fetch: true, id: 'o', seq: 1, dropped: 0, t: 1 };
  const s = [{ type: 'prepare', now: 1 }, { type: 'intent', ping, now: 1 },
    { type: 'clicked', result: { found: true, disabled: false, listeners: 1, called: 1 } }, { type: 'deadline' }].reduce(next, initial(RUN31.prompt));
  assert.equal(s.error.code, 'SUBMIT_UNCERTAIN');
  const r = reconcile(project, RUN31);
  const done = next(s, { type: 'resolve', to: 'ready', evidence: r.evidence });
  assert.deepEqual([done.item, done.creditSpent, done.evidence.source], ['ready', true, 'Zzl0ze']);
});

test('drift: listing shape changes throw instead of guessing', () => {
  const drift = (mut) => { const p = rawProject(); mut(p); assert.throws(() => parseProject(p, PROJECT), ProtocolDrift); };
  drift((p) => { p[2][0][1] = 'other-project'; });
  drift((p) => { p[1][0][4] = '11111111-1111-1111-1111-111111111111'; }); // workflow of another project
  drift((p) => { p[2][5][2] = '00000000-0000-0000-0000-000000000000'; });       // media → unknown workflow
  drift((p) => { const i = p[2].findIndex((e) => Array.isArray(e[6]) && e[5]?.[6]?.[2]); p[2][i][6][0][1] = 'x'; }); // seed not an int
  drift((p) => { p[1][0][3][5] = 'not-a-uuid'; });
  drift((p) => { p[2] = null; });
  assert.throws(() => parseProject(rawProject(), '11111111-1111-1111-1111-111111111111'), ProtocolDrift);
});
