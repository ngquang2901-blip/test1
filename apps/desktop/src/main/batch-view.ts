import type { AttemptState } from '@toolflow/flow-protocol/attempt';
import type { Db } from './db';
import { statusOf } from './runner';

type BatchRow = { id: string; kind: string; provider: string; s: string; archived: number; createdAt: number; project: string | null; status: string; stop: number };
type ItemRow = { id: string; b: string; ord: number; sourceLine: number | null; prompt: string; refs: string; cur: string };
type AttemptRow = { id: string; it: string; ordinal: number; j: string; clickAt: number | null; reconcileAt: number | null; sourceAttemptId: string | null };
type EventRow = { a: string; type: string; at: number; p: string | null };
type DownloadRow = { a: string; m: string; state: string; actualName: string | null; errorCode: string | null };

const group = <T, K extends keyof T>(rows: T[], key: K): Map<T[K], T[]> => {
  const m = new Map<T[K], T[]>();
  for (const r of rows) { const l = m.get(r[key]); if (l) l.push(r); else m.set(r[key], [r]); }
  return m;
};

/**
 * What the screens show about batches: `ids` in that order (unknown ids left out), or every batch newest first.
 * A fixed number of queries however long the history is (one per table, rows found by index), grouped here.
 */
export function viewBatches(db: Db, ids?: string[]) {
  const list = ids ?? (db.prepare('select id from batch order by created_at desc, rowid desc').all() as { id: string }[]).map((r) => r.id);
  const want = JSON.stringify(list);
  const IN = 'in (select value from json_each(?))';
  const batches = new Map((db.prepare(`select id, kind, provider, settings_json s, archived, created_at createdAt, target_project project, status, stop_requested stop from batch where id ${IN}`).all(want) as BatchRow[]).map((b) => [b.id, b]));
  const items = group(db.prepare(`select id, batch_id b, ord, source_line sourceLine, prompt, refs_json refs, attempt_id cur from item where batch_id ${IN} order by batch_id, ord`).all(want) as ItemRow[], 'b');
  const attempts = group(db.prepare(`select a.id, a.item_id it, a.ordinal, a.state_json j, a.click_at clickAt, a.reconcile_at reconcileAt, a.source_attempt_id sourceAttemptId
    from item i join attempt a on a.item_id=i.id where i.batch_id ${IN} order by a.item_id, a.ordinal`).all(want) as AttemptRow[], 'it');
  // only the first 'intent' event's payload is read (its profile version); the rest of the journal is type + time
  const events = group(db.prepare(`select j.attempt_id a, j.type, j.at, case when j.type='intent' then j.payload_json end p
    from item i join attempt a on a.item_id=i.id join journal_event j on j.attempt_id=a.id where i.batch_id ${IN} order by j.attempt_id, j.id`).all(want) as EventRow[], 'a');
  const downloads = group(db.prepare(`select d.attempt_id a, d.media_id m, d.state, d.actual_name actualName, d.error_code errorCode
    from item i join attempt a on a.item_id=i.id join download d on d.attempt_id=a.id where i.batch_id ${IN}`).all(want) as DownloadRow[], 'a');
  return list.flatMap((id) => {
    const b = batches.get(id);
    if (!b) return [];
    const its = (items.get(id) ?? []).map((it) => {
      const as = (attempts.get(it.id) ?? []).map(({ j, it: _item, ...a }) => {
        const s = JSON.parse(j) as AttemptState;
        const ev = events.get(a.id) ?? [];
        const intent = ev.find((e) => e.type === 'intent');
        return {
          ...a, profileVersion: intent?.p ? (JSON.parse(intent.p).profileVersion ?? null) : null, item: s.item, stage: s.stage, error: s.error, creditSpent: s.creditSpent,
          outputs: ((s.outputs ?? []) as { mediaId: string }[]).map((o) => o.mediaId), // ids only: no signed urls (R54)
          journal: ev.map((e) => ({ type: e.type, at: e.at })),
          // per output: state + the name relative to the download folder (no absolute path, no url)
          downloads: Object.fromEntries((downloads.get(a.id) ?? []).map(({ m, a: _a, ...r }) => [m, r])),
        };
      });
      return { id: it.id, ord: it.ord, sourceLine: it.sourceLine, prompt: it.prompt, refs: JSON.parse(it.refs), attemptId: it.cur, attempts: as, state: as.find((a) => a.id === it.cur)?.item };
    });
    const status = statusOf(b.status, b.stop, its.map((it) => it.state).filter((s): s is AttemptState['item'] => !!s));
    return [{ id: b.id, kind: b.kind, provider: b.provider, status, archived: !!b.archived, createdAt: b.createdAt, settings: JSON.parse(b.s), project: b.project, items: its.map(({ state: _s, ...it }) => it) }];
  });
}

/** One signature per batch that changes whenever its rows do: the main process tells the screen which batch to re-read. */
export function batchSignatures(db: Db): { id: string; sig: string }[] {
  return db.prepare("select b.id, b.revision || ':' || coalesce((select sum(a.revision) from item i join attempt a on a.item_id=i.id where i.batch_id=b.id),0) sig from batch b").all() as { id: string; sig: string }[];
}
