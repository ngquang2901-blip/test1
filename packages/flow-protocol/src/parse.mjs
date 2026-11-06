// Parsers for Google Flow web `batchexecute` traffic, written from captured fixtures (spike 01).
// Fail closed: any shape that differs from what was qualified throws ProtocolDrift; never guess.

export class ProtocolDrift extends Error {
  constructor(where, path, value) {
    super(`PROTOCOL_DRIFT at ${where}${path.length ? ' [' + path.join('][') + ']' : ''}` +
      (value === undefined ? '' : `: got ${JSON.stringify(value)?.slice(0, 80)}`));
    this.code = 'PROTOCOL_DRIFT';
    this.where = where;
    this.path = path;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isStr = (v) => typeof v === 'string';
const isInt = Number.isInteger;
const isArr = Array.isArray;
const isUuid = (v) => isStr(v) && UUID.test(v);

function at(root, path, check, where) {
  let v = root;
  for (const k of path) {
    if (!isArr(v) || k >= v.length) throw new ProtocolDrift(where, path);
    v = v[k];
  }
  if (check && !check(v)) throw new ProtocolDrift(where, path, v);
  return v;
}

// Optional fields: absent or wrong type gives null, so harmless additions do not break parsing.
function opt(root, path, check) {
  try { return at(root, path, check, ''); } catch { return null; }
}

function json(text, where) {
  try { return JSON.parse(text); } catch { throw new ProtocolDrift(where, [], String(text).slice(0, 40)); }
}

/** Splits a batchexecute response body into frames. */
export function parseEnvelope(text) {
  if (!isStr(text) || !text.startsWith(")]}'")) throw new ProtocolDrift('envelope', [], String(text).slice(0, 10));
  const frames = [];
  for (const line of text.slice(4).split('\n')) {
    if (line === '' || /^\d+$/.test(line)) continue; // chunk length lines
    if (!line.startsWith('[')) throw new ProtocolDrift('envelope', [], line.slice(0, 40));
    for (const f of json(line, 'envelope')) frames.push(f);
  }
  return frames;
}

/**
 * Returns {payload} for a successful RPC or {error: {grpc, reasons}} for an RPC-level error
 * (HTTP is still 200 then: e.g. PUBLIC_ERROR_USER_REQUESTS_THROTTLED).
 */
export function parseRpcResponse(text, rpc) {
  const hits = parseEnvelope(text).filter((f) => isArr(f) && f[0] === 'wrb.fr' && f[1] === rpc);
  if (hits.length !== 1) throw new ProtocolDrift(`rpc ${rpc}`, [], `${hits.length} wrb.fr frames`);
  const f = hits[0];
  if (isStr(f[2])) return { payload: json(f[2], `rpc ${rpc} payload`) };
  if (f[2] === null && isArr(f[5])) {
    const grpc = at(f, [5, 0], isInt, `rpc ${rpc} error`);
    const details = at(f, [5, 2], isArr, `rpc ${rpc} error`);
    const reasons = details.flatMap((d) => (isArr(d) && isArr(d[1]) ? d[1].filter(isStr) : []));
    return { error: { grpc, reasons } };
  }
  throw new ProtocolDrift(`rpc ${rpc}`, [2], f[2]);
}

/** Reads `f.req` from a raw application/x-www-form-urlencoded batchexecute body, as sent on the wire. */
export function readFReq(body) {
  const v = isStr(body) ? new URLSearchParams(body).get('f.req') : null;
  if (!isStr(v) || !v.startsWith('[')) throw new ProtocolDrift('request body', [], String(body).slice(0, 40));
  return v;
}

// Request layouts per generate RPC. Start/End-frame RPCs (eb1hJf, nprQif) have no fixture yet: unsupported.
const REQUEST = {
  ogiZ0b: { items: [1], batch: [4, 0], prompt: [8, 0, 0, 0], model: [5], seed: [3], aspect: [4], imageRefs: [2] },
  YhhmEf: { items: [0], batch: [2, 0], prompt: [0, 2, 0, 0, 0], model: [1] },
  MZZa6b: { items: [0], batch: [2, 0], prompt: [0, 2, 0, 0, 0], model: [2], refs: [1] },
};

/** Parses the decoded `f.req` value of a generate request (product code: new URLSearchParams(body).get('f.req')). */
export function parseGenerateRequest(fReq) {
  const outer = json(fReq, 'request');
  const rpc = at(outer, [0, 0, 0], isStr, 'request');
  const L = REQUEST[rpc];
  if (!L) throw new ProtocolDrift('request', [0, 0, 0], rpc);
  const where = `request ${rpc}`;
  const inner = json(at(outer, [0, 0, 1], isStr, where), where);
  const items = at(inner, L.items, (v) => isArr(v) && v.length > 0, where).map((it, i) => {
    const w = `${where} item ${i}`;
    const item = { prompt: at(it, L.prompt, isStr, w), model: at(it, L.model, isStr, w) };
    if (L.seed) item.seed = at(it, L.seed, isInt, w);
    if (L.aspect) item.aspectCode = at(it, L.aspect, isInt, w); // 1 = 1:1, 2 = 9:16 (lượt 16/33)
    if (L.refs) item.refIds = at(it, L.refs, isArr, w).map((r, j) => at(r, [1], isUuid, `${w} ref ${j}`));
    // image refs: null without refs, else [[refId, null, null, null, 1], ...] (lượt 34)
    if (L.imageRefs) item.refIds = (at(it, L.imageRefs, (v) => v === null || isArr(v), w) || []).map((r, j) => at(r, [0], isUuid, `${w} ref ${j}`));
    return item;
  });
  return { rpc, batchId: at(inner, L.batch, isUuid, where), items };
}

/** Upload (maseQ) request: the file name is the only value Flow echoes back, so it is the ownership key. */
export function parseUploadRequest(fReq) {
  const outer = json(fReq, 'upload request');
  if (at(outer, [0, 0, 0], isStr, 'upload request') !== 'maseQ') throw new ProtocolDrift('upload request', [0, 0, 0]);
  const inner = json(at(outer, [0, 0, 1], isStr, 'upload request'), 'upload request');
  return { mime: at(inner, [2], isStr, 'upload request'), fileName: at(inner, [8], isStr, 'upload request') };
}

/** Upload (maseQ) payload: [media, workflow]. The media id is what a ref chip / generate request uses. */
export function parseUploadReceipt(payload) {
  const where = 'upload receipt';
  const m = at(payload, [0], isArr, where), wf = at(payload, [1], isArr, where);
  const mediaId = at(m, [0], isUuid, where);
  if (at(wf, [3, 4], isUuid, where) !== mediaId || at(wf, [0], isUuid, where) !== at(m, [2], isUuid, where)) {
    throw new ProtocolDrift(where, [1, 3, 4]);
  }
  return {
    mediaId, workflowId: wf[0], projectId: at(m, [1], isUuid, where),
    fileName: at(wf, [3, 0], isStr, where),
    mime: opt(m, [6, 1, 6], isStr),
    width: at(m, [6, 2, 0], isInt, where), height: at(m, [6, 2, 1], isInt, where),
  };
}

function workflows(list, where) {
  return at(list, [], isArr, where).map((w, i) => ({
    workflowId: at(w, [0], isUuid, `${where} ${i}`),
    primaryId: at(w, [3, 4], isUuid, `${where} ${i}`), // image: media id; video: operation id
    batchId: at(w, [3, 5], isUuid, `${where} ${i}`),
    title: opt(w, [3, 0], isStr),
  }));
}

function oneBatch(wfs, where) {
  const ids = [...new Set(wfs.map((w) => w.batchId))];
  if (ids.length !== 1) throw new ProtocolDrift(where, [], ids);
  return ids[0];
}

/** Image generate (ogiZ0b) payload: the response already carries the finished images. */
export function parseImageReceipt(payload) {
  const where = 'image receipt';
  const wfs = workflows(at(payload, [1], isArr, where), `${where} workflow`);
  const outputs = at(payload, [0], isArr, where).map((m, i) => {
    const w = `${where} media ${i}`;
    const mediaId = at(m, [0], isUuid, w);
    const workflowId = at(m, [2], isUuid, w);
    const wf = wfs.find((x) => x.workflowId === workflowId);
    if (!wf || wf.primaryId !== mediaId) throw new ProtocolDrift(w, [2], workflowId);
    return {
      mediaId, workflowId,
      seed: at(m, [6, 0, 1], isInt, w),
      url: at(m, [6, 5, 1], isStr, w),
      width: at(m, [6, 2, 0], isInt, w),
      height: at(m, [6, 2, 1], isInt, w),
      title: wf.title,
      rewrittenPrompt: opt(m, [6, 0, 7], isStr),
      prompt: opt(m, [6, 0, 15, 2, 0, 2, 0, 0, 0], isStr),
    };
  });
  if (outputs.length !== wfs.length) throw new ProtocolDrift(where, [0], `${outputs.length} media / ${wfs.length} workflows`);
  return { batchId: oneBatch(wfs, where), outputs };
}

// Operation status codes seen: 6 at receipt, 2 while rendering, 3 done, 4 failed (lượt 17/21).
const STATUS = { 6: 'accepted', 2: 'running', 3: 'succeeded', 4: 'failed' };

function parseOps(list, where) {
  return at(list, [], isArr, where).map((op, i) => {
    const w = `${where} op ${i}`;
    const code = at(op, [5, 8, 0], isInt, w);
    const status = STATUS[code];
    if (!status) throw new ProtocolDrift(w, [5, 8, 0], code);
    const out = {
      operationId: at(op, [0], isUuid, w),
      projectId: at(op, [1], isUuid, w),
      workflowId: at(op, [2], isUuid, w),
      model: at(op, [5, 6, 1, 0, 0], isStr, w),
      status,
      prompt: opt(op, [5, 1], isStr),
      refIds: (opt(op, [5, 6, 1, 1], isArr) || []).map((r, j) => at(r, [2], isUuid, `${w} ref ${j}`)),
      seed: opt(op, [7, 0, 1], isInt),
    };
    if (status === 'failed') {
      out.failure = {
        grpc: at(op, [5, 8, 1, 0], isInt, w),
        reasons: [...new Set([opt(op, [5, 8, 1, 1], isStr), ...(opt(op, [5, 8, 2], isArr) || [])].filter(isStr))],
      };
    }
    return out;
  });
}

const credits = (payload, where) => at(payload, [1], (v) => v === null || isInt(v), where);

/** Video generate (YhhmEf, MZZa6b) payload: operations accepted, not finished. */
export function parseVideoReceipt(payload) {
  const where = 'video receipt';
  const wfs = workflows(at(payload, [2], isArr, where), `${where} workflow`);
  const ops = parseOps(at(payload, [3], isArr, where), where);
  for (const op of ops) {
    const wf = wfs.find((x) => x.workflowId === op.workflowId);
    if (!wf || wf.primaryId !== op.operationId) throw new ProtocolDrift(where, [3], op.operationId);
    op.title = wf.title;
  }
  return { batchId: oneBatch(wfs, where), credits: credits(payload, where), operations: ops };
}

/** Video poll (jwpduf) payload. */
export function parsePoll(payload) {
  return { credits: credits(payload, 'poll'), operations: parseOps(at(payload, [2], isArr, 'poll'), 'poll') };
}

/**
 * Binds a parsed request to a parsed receipt. The response echoes only the request's batch UUID
 * (and, for images, each item's seed), so that is the ownership proof; prompt text is not.
 */
export function correlate(request, receipt) {
  if (request.batchId !== receipt.batchId) return { owned: false, reason: 'batch_mismatch' };
  if (receipt.outputs) {
    const seeds = request.items.map((i) => i.seed).sort();
    const got = receipt.outputs.map((o) => o.seed).sort();
    if (seeds.length !== got.length || seeds.some((s, i) => s !== got[i])) return { owned: false, reason: 'seed_mismatch' };
    return { owned: true, outputs: receipt.outputs.map((o) => ({ ...o, item: request.items.findIndex((i) => i.seed === o.seed) })) };
  }
  if (receipt.operations.length !== request.items.length) return { owned: false, reason: 'count_mismatch' };
  return { owned: true, operations: receipt.operations };
}
