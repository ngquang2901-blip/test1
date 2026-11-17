// What the app saves by itself, so a batch left alone ends with its files on disk:
//  - a Flow batch's results as they get ready (when switched on in Cài đặt; a chat site's runner saves in its own turn);
//  - a save that failed, twice more, 30 s apart (any site; no credits, nothing is sent).
// Only what happened since this app start: results and failures from earlier sessions wait for the user's Tải / Thử lại.
import type { AttemptState } from '@toolflow/flow-protocol/attempt'
import type { Db } from './db'

const RETRY_MS = 30_000, TRIES = 2

export function createAutoSaver(o: { db: Db; now(): number; enabled(): boolean; downloader: { batch(batchId: string): Promise<void> } }) {
  const since = o.now()
  const asked = new Set<string>() // results whose first save was asked for here: once, whatever came of it
  const tried = new Map<string, { n: number; at: number }>() // failed saves tried again here
  const busy = new Set<string>() // batches being saved right now
  const keysOf = new Map<string, string[]>() // batch → the results first asked for in this pass
  return {
    async tick(): Promise<void> {
      const rows = o.db.prepare(`select b.id b, b.provider p, a.id a, a.state_json j from batch b join item i on i.batch_id=b.id join attempt a on a.id=i.attempt_id
        where b.archived=0 and json_extract(a.state_json,'$.item')='ready' and (select max(at) from journal_event where attempt_id=a.id) >= ?`).all(since) as { b: string; p: string | null; a: string; j: string }[]
      const want = new Set<string>()
      keysOf.clear()
      for (const r of rows) {
        if (busy.has(r.b)) continue
        for (const m of (JSON.parse(r.j) as AttemptState).outputs ?? []) {
          const key = `${r.a}:${m.mediaId}`
          const d = o.db.prepare('select state, updated_at u from download where attempt_id=? and media_id=?').get(r.a, m.mediaId) as { state: string; u: number } | undefined
          if (!d) { if ((r.p ?? 'flow') === 'flow' && o.enabled() && !asked.has(key)) { asked.add(key); want.add(r.b); keysOf.set(r.b, [...(keysOf.get(r.b) ?? []), key]) } continue }
          if (d.state !== 'failed' || d.u < since) continue // needs_review is the user's
          const t = tried.get(key) ?? { n: 0, at: 0 }
          if (t.n < TRIES && o.now() - Math.max(d.u, t.at) >= RETRY_MS) { tried.set(key, { n: t.n + 1, at: o.now() }); want.add(r.b) }
        }
      }
      for (const b of want) { busy.add(b); const keys = keysOf.get(b) ?? []; void o.downloader.batch(b).catch((e) => { if ((e as { code?: string }).code === 'NO_PROJECT_TAB') for (const k of keys) asked.delete(k) /* no row exists yet: ask again once a tab is granted */ }).finally(() => busy.delete(b)) } // batch(): every result not saved yet, failed ones again
    },
  }
}
