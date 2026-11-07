import { next, type AttemptEvent, type AttemptState } from '@toolflow/flow-protocol/attempt';
import type { Db } from './db';

/** Reads state, runs the state machine, writes state + journal_event atomically. Throws (and rolls back) on failure. */
export function applyEvent(db: Db, attemptId: string, ev: AttemptEvent, now: number): AttemptState {
  return db.transaction(() => {
    const row = db.prepare('select state_json from attempt where id = ?').get(attemptId) as { state_json: string } | undefined;
    if (!row) throw new Error(`unknown attempt ${attemptId}`);
    const state = next(JSON.parse(row.state_json), ev);
    db.prepare('update attempt set state_json = ?, revision = revision + 1 where id = ?').run(JSON.stringify(state), attemptId);
    db.prepare('insert into journal_event(attempt_id, type, at, payload_json) values(?,?,?,?)').run(attemptId, ev.type, now, JSON.stringify(ev));
    return state;
  })();
}
