// Hẹn giờ chạy: a batch that has not started keeps a start time; a ticker in main starts it through the same start as the button.
import type { Db } from './db';

export const MAX_AHEAD_MS = 30 * 24 * 3600_000;
const coded = (code: string): Error => Object.assign(new Error(code), { code });

/** A start time from the renderer: a whole ms epoch in the future, at most 30 days ahead (on the app clock). */
export function startAtOf(v: unknown, now: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw coded('INVALID_ARGS');
  if (v <= now) throw coded('SCHEDULE_PAST');
  if (v > now + MAX_AHEAD_MS) throw coded('SCHEDULE_TOO_FAR');
  return v;
}

/** Sets or clears (null) the time of a batch that has not started. */
export function setStart(db: Db, id: string, at: number | null): void {
  const r = db.prepare("update batch set start_at=?, revision=revision+1 where id=? and status='queued' and archived=0 and stop_requested=0").run(at, id);
  if (!r.changes) throw coded('NOT_SCHEDULABLE');
}

export function createScheduler(o: { db: Db; now(): number; start(id: string): Promise<void> | void; notify(id: string, at: number, late: boolean): void }) {
  let first = true; // what is due at the first tick fell while the app was closed
  return {
    async tick(): Promise<void> {
      const late = first;
      first = false;
      for (const r of o.db.prepare("select id, start_at at from batch where start_at is not null and start_at <= ? and status='queued' and archived=0 and stop_requested=0 order by start_at").all(o.now()) as { id: string; at: number }[]) {
        try { await o.start(r.id); o.notify(r.id, r.at, late); } // start clears start_at, so it runs once
        catch (e) { o.db.prepare('update batch set start_at=null where id=?').run(r.id); console.error('schedule', (e as { code?: string }).code ?? 'INTERNAL_ERROR'); } // never retried every 5 s
      }
    },
  };
}
