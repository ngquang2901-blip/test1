// Notices: a batch finished, a batch stopped and needs the user, a scheduled batch started, Flow credit low.
// Each goes to the channels the user switched on: the in-app list (DB, last 50), Windows, Telegram. The text is content-free
// on purpose (short batch id, site, kind, counts, error code + hint, times): never a prompt, file name, path or account email.
import type { Db } from './db';
import type { Draft } from './ipc';
import { batchStatus, type BatchStatus } from './runner';
import { hintOf } from '../renderer/src/hints';

export type Notice = { kind: 'done' | 'attention' | 'scheduled' | 'credit'; batchId: string | null; title: string; body: string };
const KEPT = 50;
const SITE: Record<string, string> = { flow: 'Flow', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const KIND: Record<string, string> = { image: 'Ảnh', video: 'Video' };
const DONE: BatchStatus[] = ['completed', 'partial_failed', 'failed'];
const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function createNotifier(o: {
  db: Db; now(): number; prefs(): Pick<Draft, 'notifyApp' | 'notifyWindows' | 'notifyTelegram' | 'creditWarn'>;
  lastError(batchId: string): string | null; // the runner's pause reason (null: paused by the user)
  channels: { windows?(n: Notice): void; telegram?(text: string): Promise<void> };
  changed(): void; // the in-app list moved: the screen re-reads it
}) {
  const { db } = o;
  const seen = new Map<string, BatchStatus>(); // last status per batch; the first sighting (boot) only records
  let blocked = false;
  const facts = (id: string) => {
    const b = db.prepare('select provider p, kind k from batch where id=?').get(id) as { p: string; k: string };
    return `${SITE[b.p] ?? b.p} · ${KIND[b.k] ?? b.k}`;
  };
  const notify = (n: Notice): void => {
    const p = o.prefs();
    if (p.notifyApp) {
      const id = Number(db.prepare('insert into notice(at, kind, batch_id, title, body) values(?,?,?,?,?)').run(o.now(), n.kind, n.batchId, n.title, n.body).lastInsertRowid);
      db.prepare('delete from notice where id <= ?').run(id - KEPT);
    }
    if (p.notifyWindows) try { o.channels.windows?.(n); } catch { /* the in-app list must work on its own */ }
    if (p.notifyTelegram && o.channels.telegram) o.channels.telegram(`${n.title}\n${n.body}`).catch((e) => console.error('telegram', (e as { code?: string }).code ?? 'TG_FAILED'));
    o.changed();
  };
  return {
    notify,
    /** Called for every batch whose rows changed (the main scan). */
    batchChanged(id: string): void {
      const s = batchStatus(db, id), prev = seen.get(id);
      seen.set(id, s);
      if (prev === undefined || prev === s) return;
      const short = id.slice(0, 8);
      if (DONE.includes(s) && !DONE.includes(prev)) {
        const rows = db.prepare("select json_extract(a.state_json, '$.item') s from item i join attempt a on a.id=i.attempt_id where i.batch_id=?").all(id) as { s: string }[];
        const ok = rows.filter((r) => r.s === 'ready').length, bad = rows.filter((r) => r.s === 'failed').length;
        notify({ kind: 'done', batchId: id, title: `Lô ${short} đã xong`, body: `${facts(id)} · ${ok}/${rows.length} có kết quả · ${bad} lỗi` });
        return;
      }
      if (s !== 'paused' && s !== 'needs_review') return;
      const code = o.lastError(id) ?? (s === 'needs_review' ? (db.prepare("select json_extract(a.state_json, '$.error.code') c from item i join attempt a on a.id=i.attempt_id where i.batch_id=? and json_extract(a.state_json, '$.item')='needs_review'").get(id) as { c: string | null } | undefined)?.c ?? null : null);
      if (!code) return; // the user's own Tạm dừng
      const provider = (db.prepare('select provider p from batch where id=?').get(id) as { p: string }).p;
      const hint = hintOf(code, provider);
      notify({ kind: 'attention', batchId: id, title: `Lô ${short} cần bạn xem`, body: `${facts(id)} · ${code}${hint ? `: ${hint}` : ''}` });
    },
    scheduled(id: string, at: number, late: boolean): void {
      notify({ kind: 'scheduled', batchId: id, title: `Lô ${id.slice(0, 8)} đã bắt đầu theo hẹn giờ`, body: `${facts(id)} · ${late ? `bắt đầu trễ: hẹn lúc ${hhmm(at)}, lúc đó app đang tắt` : `hẹn lúc ${hhmm(at)}`}` });
    },
    /** The balance Flow just reported for an account: kept, and one notice each time it falls under the threshold. */
    credits(email: string | null, n: number): void {
      const e = (email ?? '').trim().toLowerCase(), th = o.prefs().creditWarn;
      const prev = (db.prepare('select credits c from credit where email=?').get(e) as { c: number } | undefined)?.c;
      db.prepare('insert into credit(email, credits, at) values(?,?,?) on conflict(email) do update set credits=excluded.credits, at=excluded.at').run(e, n, o.now());
      if (n < th && (prev === undefined || prev >= th)) notify({ kind: 'credit', batchId: null, title: 'Credit Flow sắp hết', body: `Còn ${n} credit, dưới mức cảnh báo ${th} · đọc lúc ${hhmm(o.now())}` });
    },
    creditList: () => db.prepare('select email, credits, at from credit order by email').all() as { email: string; credits: number; at: number }[],
    windowsFailed(): void { if (!blocked) { blocked = true; o.changed(); } },
    list() {
      const items = (db.prepare(`select id, at, kind, batch_id batchId, title, body, read from notice order by id desc limit ${KEPT}`).all() as (Notice & { id: number; at: number; read: number })[]).map((r) => ({ ...r, read: !!r.read }));
      return { items, unread: (db.prepare('select count(*) n from notice where read=0').get() as { n: number }).n, windowsBlocked: blocked };
    },
    markRead(): void { db.prepare('update notice set read=1 where read=0').run(); o.changed(); },
  };
}
export type Notifier = ReturnType<typeof createNotifier>;
