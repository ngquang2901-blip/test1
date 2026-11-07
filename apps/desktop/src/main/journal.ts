import { next, type AttemptEvent, type AttemptState } from '@toolflow/flow-protocol/attempt';
import type { Db } from './db';

// R9: signed urls never reach the DB; the runner re-resolves them at download time.
const redact = (k: string, v: unknown) =>
  k === 'url' ? undefined : typeof v === 'string' && (v.includes('Signature=') || /^https?:\/\//.test(v)) ? 'REDACTED_URL' : v;

/** Reads state, runs the state machine, writes state + journal_event atomically. Throws (and rolls back) on failure. */
export function applyEvent(db: Db, attemptId: string, ev: AttemptEvent, now: number): AttemptState {
  return db.transaction(() => {
    const row = db.prepare('select state_json from attempt where id = ?').get(attemptId) as { state_json: string } | undefined;
    if (!row) throw new Error(`unknown attempt ${attemptId}`);
    const state = next(JSON.parse(row.state_json), ev);
    db.prepare('update attempt set state_json = ?, revision = revision + 1 where id = ?').run(JSON.stringify(state, redact), attemptId);
    db.prepare('insert into journal_event(attempt_id, type, at, payload_json) values(?,?,?,?)').run(attemptId, ev.type, now, JSON.stringify(ev, redact));
    return state;
  })();
}
