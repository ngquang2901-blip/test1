import type { AttemptState } from '@toolflow/flow-protocol/attempt';
import { parseRpcResponse } from '@toolflow/flow-protocol/parse';
import { parseProject, reconcile } from '@toolflow/flow-protocol/project';
import type { Db } from './db';
import type { FlowDriver } from './driver';
import { applyEvent } from './journal';

export const RECONCILE_MS = 600_000; // D-11
const WINDOW = { windowMs: 120_000, skewMs: 5_000 };
type Row = { id: string; project: string; prompt: string; kind: 'image' | 'video'; clickAt: number | null; state: AttemptState };

const rows = (db: Db, where: string, ...args: unknown[]): Row[] =>
  (db.prepare(`select a.id, b.target_project project, i.prompt, b.kind, a.click_at clickAt, a.state_json j
    from attempt a join item i on i.id=a.item_id join batch b on b.id=i.batch_id where ${where}`).all(...args) as (Omit<Row, 'state'> & { j: string })[])
    .map(({ j, ...r }) => ({ ...r, state: JSON.parse(j) as AttemptState }));

/** Attempts that still hold their project: the only thing that keeps a target_block alive. */
export const unresolved = (db: Db, project: string) =>
  rows(db, "b.target_project=? and json_extract(a.state_json,'$.item')='needs_review'", project);

/** Clears this attempt's schedule and the project block, unless another unresolved attempt of the project still needs it. */
export function unblock(db: Db, attemptId: string): void {
  db.transaction(() => {
    const [me] = rows(db, 'a.id=?', attemptId);
    db.prepare('update attempt set reconcile_at=null where id=?').run(attemptId);
    const other = unresolved(db, me.project).find((r) => r.id !== attemptId);
    if (other) db.prepare('update target_block set attempt_id=? where project_id=?').run(other.id, me.project);
    else db.prepare('delete from target_block where project_id=?').run(me.project);
  })();
}

/** D-11/D-21: read the project listing once; only `found` settles. Never touches the page, never resubmits. */
export async function runReconcile(db: Db, driver: FlowDriver, attemptId: string, now: number): Promise<'found' | 'not_found' | 'ambiguous'> {
  const [me] = rows(db, 'a.id=?', attemptId);
  db.prepare('update attempt set reconcile_at=null where id=?').run(attemptId);
  if (me.state.item !== 'needs_review' || me.state.stage !== 'uncertain') return 'not_found';
  const batchId = (me.state.request as { batchId?: string } | null)?.batchId;
  const clickMs = me.clickAt ?? now;
  const journal = (verdict: string, evidence: unknown) =>
    db.prepare("insert into journal_event(attempt_id, type, at, payload_json) values(?,'reconcile',?,?)").run(attemptId, now, JSON.stringify({ verdict, evidence }));

  // Same prompt sent twice with overlapping windows: one listing entry could be either, so neither is assigned.
  const twin = !batchId && unresolved(db, me.project).some((o) => o.id !== attemptId && o.prompt === me.prompt && o.kind === me.kind && o.state.stage === 'uncertain'
    && Math.abs((o.clickAt ?? now) - clickMs) <= WINDOW.windowMs + WINDOW.skewMs);
  if (twin) { journal('ambiguous', { why: 'duplicate_prompt' }); return 'ambiguous'; }

  let verdict;
  try {
    const raw = parseRpcResponse(await driver.readProject(me.project), 'Zzl0ze') as { payload: unknown };
    const owned = new Set<string>();
    for (const o of rows(db, 'a.id<>?', attemptId)) {
      const s = o.state as { outputs?: { mediaId: string }[] | null; operations?: { operationId: string }[] | null; evidence?: { mediaIds?: string[] } | null };
      [...(s.outputs ?? []).map((x) => x.mediaId), ...(s.operations ?? []).map((x) => x.operationId), ...(s.evidence?.mediaIds ?? [])].forEach((m) => owned.add(m));
    }
    verdict = reconcile(parseProject(raw.payload, me.project), { batchId, prompt: me.prompt, kind: me.kind, clickMs }, { owned, ...WINDOW });
  } catch (err) { // unreadable listing proves nothing: wait for the user (shortcut: no automatic retry, upgrade when the connector gives transient errors)
    journal('not_found', { source: 'Zzl0ze', error: (err as { code?: string }).code ?? 'READ_FAILED' });
    return 'not_found';
  }
  if (verdict.verdict === 'found') { applyEvent(db, attemptId, { type: 'resolve', to: 'ready', evidence: verdict.evidence }, now); unblock(db, attemptId); }
  else journal(verdict.verdict, verdict.evidence);
  return verdict.verdict;
}
