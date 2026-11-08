import type { Db } from './db';

const norm = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();

// Fail closed: unknown / unreadable email ⇒ false (D-19).
export function autoAllowed(db: Db, email: string | null): boolean {
  const e = norm(email);
  if (!e) return false;
  const r = db.prepare('select auto_enabled a from account_setting where email=?').get(e) as { a: number } | undefined;
  return r?.a === 1;
}

// Auto needs a usable profile AND an opted-in account (D-19, AC-18).
export const autoGate = (db: Db, email: string | null, profileError: string | null): boolean => !profileError && autoAllowed(db, email);

export function enableAuto(db: Db, email: string, ackAt: number): void {
  const e = norm(email);
  if (!e) throw new Error('email required');
  if (!Number.isInteger(ackAt)) throw new Error('ackAt must be an integer');
  db.prepare('insert into account_setting(email,auto_enabled,ack_at) values(?,1,?) on conflict(email) do update set auto_enabled=1, ack_at=excluded.ack_at').run(e, ackAt);
}

export function disableAuto(db: Db, email: string): void {
  db.prepare('update account_setting set auto_enabled=0 where email=?').run(norm(email));
}
