// Project listing (`Zzl0ze`, get project) and the D-11 reconciliation that uses it.
// Layout from spike lượt 35 (fixture project-Zzl0ze.json), cross-checked against the generate receipts
// of lượt 28–34: media id, workflow id, batch UUID, seed and the original prompt all match.
import { ProtocolDrift, at, opt } from './parse.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const isArr = Array.isArray;
const isTs = (v) => isArr(v) && Number.isInteger(v[0]) && (v[1] == null || Number.isInteger(v[1]));
const ms = (t) => t[0] * 1000 + Math.floor((t[1] ?? 0) / 1e6);

/**
 * payload = [_, workflows, media, voices, ...]
 *   workflow = [workflowId, _, _, [title, created, _, _, primaryMediaId, batchId|null, finished], projectId]
 *   media    = [mediaId, projectId, workflowId, _, _, gen, image?, video?]
 *     gen[0] created · gen[6][2][0][2][0][0][0] original prompt · gen[6][3][i][0][2] ref media id
 *     image[0][1] seed · gen[6][1][0][0] video model · gen[8][0] video status (3 = done)
 * Uploads have no prompt and no batch. Only finished media were seen in the listing.
 */
export function parseProject(payload, projectId) {
  const W = at(payload, [1], isArr, 'project');
  const M = at(payload, [2], isArr, 'project');
  const workflows = new Map();
  W.forEach((w, i) => {
    const where = `project workflow ${i}`;
    const id = at(w, [0], isUuid, where);
    if (at(w, [4], isUuid, where) !== projectId) throw new ProtocolDrift(where, [4], w[4]);
    workflows.set(id, {
      workflowId: id,
      title: at(w, [3, 0], (v) => typeof v === 'string', where),
      createdMs: ms(at(w, [3, 1], isTs, where)),
      primaryMediaId: at(w, [3, 4], isUuid, where),
      batchId: at(w, [3, 5], (v) => v === null || isUuid(v), where),
    });
  });
  const media = M.map((e, i) => {
    const where = `project media ${i}`;
    const mediaId = at(e, [0], isUuid, where);
    if (at(e, [1], isUuid, where) !== projectId) throw new ProtocolDrift(where, [1], e[1]);
    const workflowId = at(e, [2], isUuid, where);
    const wf = workflows.get(workflowId);
    if (!wf) throw new ProtocolDrift(where, [2], workflowId);
    const prompt = opt(e, [5, 6, 2, 0, 2, 0, 0, 0], (v) => typeof v === 'string');
    const video = isArr(e[7]);
    const kind = video ? 'video' : prompt === null ? 'upload' : 'image';
    if (kind !== 'upload' && !isUuid(wf.batchId)) throw new ProtocolDrift(where, ['batch'], wf.batchId);
    const refs = opt(e, [5, 6, 3], isArr) ?? [];
    return {
      mediaId, workflowId, kind, prompt,
      batchId: wf.batchId,
      createdMs: ms(at(e, [5, 0], isTs, where)),
      refIds: refs.map((r, k) => at(r, [0, 2], isUuid, `${where} ref ${k}`)),
      seed: kind === 'image' ? at(e, [6, 0, 1], Number.isInteger, where) : null,
      model: video ? at(e, [5, 6, 1, 0, 0], (v) => typeof v === 'string', where) : null,
      status: video ? at(e, [5, 8, 0], Number.isInteger, where) : null,
    };
  });
  return { projectId, workflows, media };
}

/**
 * D-11 job: look for an uncertain attempt in the project listing. Read-only; never resubmits.
 * attempt = { prompt, kind: 'image'|'video', clickMs, batchId? }  (batchId only if the request was seen)
 * owned   = media ids already bound to other attempts in the journal.
 * Returns { verdict: 'found' | 'not_found' | 'ambiguous', mediaIds, batchId, evidence }.
 * 'not_found' does NOT mean "not sent": an accepted video (lượt 30, batch 348E8F61) is missing from the listing.
 */
export function reconcile(project, attempt, { owned = new Set(), windowMs = 120_000, skewMs = 5_000 } = {}) {
  let pool;
  if (attempt.batchId) {
    pool = project.media.filter((m) => m.batchId === attempt.batchId);
    if (pool.some((m) => m.prompt !== attempt.prompt || m.kind !== attempt.kind))
      return { verdict: 'ambiguous', mediaIds: pool.map((m) => m.mediaId), batchId: attempt.batchId, evidence: { why: 'batch_mismatch' } };
  } else {
    pool = project.media.filter((m) => m.kind === attempt.kind && m.prompt === attempt.prompt
      && m.createdMs >= attempt.clickMs - skewMs && m.createdMs <= attempt.clickMs + windowMs);
  }
  pool = pool.filter((m) => !owned.has(m.mediaId));
  const batches = [...new Set(pool.map((m) => m.batchId))];
  const base = { mediaIds: pool.map((m) => m.mediaId), source: 'Zzl0ze' };
  if (batches.length === 0) return { verdict: 'not_found', ...base, batchId: null, evidence: { source: 'Zzl0ze', meaning: 'unknown' } };
  if (batches.length > 1) return { verdict: 'ambiguous', ...base, batchId: null, evidence: { source: 'Zzl0ze', batches } };
  return {
    verdict: 'found', ...base, batchId: batches[0],
    evidence: { source: 'Zzl0ze', batchId: batches[0], mediaIds: base.mediaIds, deltaMs: Math.min(...pool.map((m) => m.createdMs)) - attempt.clickMs },
  };
}
