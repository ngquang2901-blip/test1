import { randomUUID } from 'node:crypto'
import { closeSync, constants, copyFileSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import type { AttemptState } from '@toolflow/flow-protocol/attempt'
import { EXT, sniff } from './assets'
import type { Db } from './db'
import { ConnectorError, type DlInfo, type FetchMediaResult, type FlowDriver } from './driver'

export type { DlInfo } from './driver'
/** All the download path needs from a driver: it never touches prepare / click / arm (AC-16). */
export type DlDriver = Pick<FlowDriver, 'fetchMedia' | 'downloads'>

const coded = (code: string): Error => Object.assign(new Error(code), { code })

// ---------- naming (docs/app/06 §5) ----------
const BAD = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*%]/g // control chars, Windows/Linux forbidden chars, and % so an encoded %2e%2e can never be decoded into '..' later
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const cut = (s: string, max: number): string => { // by code point: never splits a surrogate pair
  let n = 0, out = ''
  for (const ch of s) { if (n + ch.length > max) break; n += ch.length; out += ch }
  return out
}
const clean = (s: string, max: number): string => cut(s.normalize('NFC').replace(BAD, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+/, ''), max).replace(/[.\s]+$/, '')

/** One path component that is safe on Linux and Windows: no separators, no leading/trailing dots, no reserved device names (also with an extension). */
export function safeComponent(s: string, max = 80): string {
  let t = clean(s, max)
  if (RESERVED.test(t.split('.')[0].trim())) t = clean('_' + t, max)
  return t || '_'
}

const dayOf = (at: number, tz: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at) // one timezone for the whole name

export type PlanInput = { batchLabel: string; at: number; index: number; prompt: string; outputId: string; ext: string; root: string; tz: string; withPrompt?: boolean }
/** `{day}_{batch}/{index}_{prompt}_{id8}.{ext}`, relative to root, always '/'-separated. Pure: same inputs, same name. */
export function planName(p: PlanInput): string {
  if (!Number.isInteger(p.index) || p.index < 1) throw new Error('index must be a positive integer')
  const folder = safeComponent(`${dayOf(p.at, p.tz)}_${p.batchLabel}`)
  const head = String(p.index).padStart(3, '0')
  const tail = `${clean(p.outputId, 80).replace(/ /g, '').slice(0, 8) || '_'}.${p.ext.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin'}`
  const room = Math.min(80, 200 - p.root.length - 1 - folder.length - 1) - head.length - tail.length - 2
  const mid = p.withPrompt === false || room < 1 ? '' : clean(p.prompt, room)
  const file = [head, mid, tail].filter(Boolean).join('_')
  if (p.root.length + 1 + folder.length + 1 + file.length > 200) throw coded('PATH_TOO_LONG')
  const rel = `${folder}/${file}`
  const root = resolve(p.root)
  if (!resolve(root, rel).startsWith(root + sep)) throw coded('PATH_ESCAPE')
  return rel
}

/** Creates the destination folder and proves, on the real file system, that it is still inside root (a symlink may point out). */
export function ensureDir(root: string, rel: string): string {
  mkdirSync(root, { recursive: true })
  const real = realpathSync(root)
  const dir = join(real, dirname(rel))
  mkdirSync(dir, { recursive: true })
  const at = realpathSync(dir)
  if (at !== real && !at.startsWith(real + sep)) throw coded('PATH_ESCAPE')
  return at
}

/** link + unlink instead of rename: rename silently replaces an existing file. EXDEV / no-hardlink file systems fall back to an exclusive copy. */
export function moveNoClobber(src: string, want: string): string {
  const ext = extname(want), stem = want.slice(0, want.length - ext.length)
  for (let n = 1; n < 1000; n++) {
    const dst = n === 1 ? want : `${stem}-${n}${ext}`
    try { linkSync(src, dst) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      try { copyFileSync(src, dst, constants.COPYFILE_EXCL) } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') continue
        rmSync(dst, { force: true }) // a half-written copy must not stay behind
        throw e2
      }
    }
    try { unlinkSync(src) } catch { /* the temp file is garbage now; the data is safe */ }
    return dst
  }
  throw coded('DOWNLOAD_MOVE_FAILED')
}

// ---------- state machine (docs/app/06 §6) ----------
export type DlRow = { id: string; attempt_id: string; media_id: string; planned_name: string; state: 'intent' | 'started' | 'completed' | 'failed' | 'needs_review'; handle: string | null; actual_name: string | null; bytes: number | null; error_code: string | null; created_at: number; updated_at: number }
export type DlArgs = { attemptId: string; mediaId: string; tab: string; explicit?: boolean; batchLabel: string; at: number; index: number; prompt: string; tz: string; withPrompt?: boolean; kind?: 'image' | 'video' } // kind: what the output is (default image); the file must be that
export type DlEnv = { root: string; now(): number; sleep(ms: number): Promise<void>; budgetMs?: number; onChange?(): void }
const BUDGET_MS = 120_000
const TMP_DIR = 'ToolFlow-tmp'

/** A browser/extension code as a stored error code. */
const dlCode = (c: unknown): string => (typeof c === 'string' && /^[A-Z_]{1,40}$/.test(c) ? (c.startsWith('DOWNLOAD_') ? c : `DOWNLOAD_${c}`) : 'DOWNLOAD_INTERRUPTED')

/** After a restart an intent without a handle may or may not have reached the browser: needs_review, and reconcile decides. */
export function recoverDownloads(db: Db): void {
  db.prepare("update download set state='needs_review', error_code='DOWNLOAD_ACK_LOST' where state='intent'").run()
}

/**
 * Download one output. Never calls prepare / click / arm. A transfer that may exist (intent, started, needs_review) is
 * reconciled through the browser's download list BEFORE anything new starts; a fresh transfer after "found nothing"
 * needs `explicit` (the user's Thử lại). failed rows are known dead and are retried on the same row with the same name.
 */
export async function requestDownload(db: Db, drv: DlDriver, a: DlArgs, env: DlEnv): Promise<DlRow> {
  const get = (): DlRow | undefined => db.prepare('select * from download where attempt_id=? and media_id=?').get(a.attemptId, a.mediaId) as DlRow | undefined
  const set = (patch: Partial<DlRow>): DlRow => {
    db.prepare(`update download set ${Object.keys(patch).map((c) => `${c}=@${c}`).join(',')}, updated_at=@u_ where attempt_id=@a_ and media_id=@m_`).run({ ...patch, u_: env.now(), a_: a.attemptId, m_: a.mediaId })
    env.onChange?.()
    return get()!
  }
  const prefix = `${a.attemptId}_${a.mediaId}` // one browser file name per (attempt, output): the search key
  const planned = (): string => get()!.planned_name

  /** Validate the finished temp file and put it at its final name. null = the file is not there (moved or deleted already). */
  const finish = (c: DlInfo): DlRow | null => {
    const path = c.filename
    if (basename(dirname(path)) !== TMP_DIR || !basename(path).startsWith(prefix)) return set({ state: 'failed', error_code: 'DOWNLOAD_BAD_PATH' }) // never touch a path the browser did not put in our folder
    let size: number, mime: string | null
    try {
      const st = lstatSync(path) // lstat: a symlink or a directory under our prefix is not a download (the target must never be moved or read)
      if (!st.isFile()) return set({ state: 'failed', error_code: 'DOWNLOAD_BAD_FILE' })
      size = st.size
      const head = Buffer.alloc(12)
      const fd = openSync(path, 'r')
      try { readSync(fd, head, 0, 12, 0) } finally { closeSync(fd) }
      // a video must be an MP4 (file-type box at byte 4): the still picture Flow shows for it, saved as if it were the result, would be a wrong file
      mime = size === 0 ? null : a.kind === 'video' ? (head.subarray(4, 8).toString('latin1') === 'ftyp' ? 'video/mp4' : null) : sniff(head)
    } catch { return null }
    if (!mime) { rmSync(path, { force: true }); return set({ state: 'failed', error_code: a.kind === 'video' ? 'DOWNLOAD_NOT_VIDEO' : 'DOWNLOAD_NOT_IMAGE' }) } // HTML error page, login redirect, 0 bytes, the other kind of file
    const rel = planned().replace(/\.[^./]+$/, `.${mime === 'video/mp4' ? 'mp4' : EXT[mime]}`) // the real type decides the extension; the stored plan stays as planned
    try {
      const dst = moveNoClobber(path, join(ensureDir(env.root, rel), basename(rel)))
      return set({ state: 'completed', actual_name: `${dirname(rel)}/${basename(dst)}`, bytes: size, error_code: null })
    } catch (e) {
      if ((e as { code?: string }).code === 'PATH_ESCAPE') { rmSync(path, { force: true }); return set({ state: 'failed', error_code: 'PATH_ESCAPE' }) }
      return set({ state: 'needs_review', error_code: 'DOWNLOAD_MOVE_FAILED' }) // disk full / permissions: the finished temp file stays, a retry reconciles and moves it without a new transfer
    }
  }

  const wait = async (id: number): Promise<DlRow> => {
    const t0 = env.now()
    for (;;) {
      let it: DlInfo | undefined
      try { const same = (await drv.downloads({ id })).filter((x) => x.id === id); it = same.length > 1 ? same.find((x) => basename(x.filename).startsWith(prefix)) : same[0] /* several Chrome profiles can each have a download with this id: ours carries our prefix */ } catch { return set({ state: 'needs_review', error_code: 'DOWNLOAD_RECONCILE_FAILED' }) }
      if (!it) return set({ state: 'needs_review', error_code: 'DOWNLOAD_ACK_LOST' })
      if (it.state === 'complete') return finish(it) ?? set({ state: 'failed', error_code: 'DOWNLOAD_FILE_MISSING' })
      if (it.state === 'interrupted') return set({ state: 'failed', error_code: dlCode(it.error) })
      if (env.now() - t0 >= (env.budgetMs ?? BUDGET_MS)) return set({ state: 'needs_review', error_code: 'DOWNLOAD_TIMEOUT' })
      await env.sleep(500)
    }
  }

  /** Ask the browser what exists for this output. 'fresh' = a new transfer may start now. */
  const reconcile = async (explicit: boolean): Promise<DlRow | 'fresh'> => {
    let list: DlInfo[]
    try { list = (await drv.downloads({ filenamePrefix: prefix })).sort((x, y) => y.id - x.id) } catch { return set({ state: 'needs_review', error_code: 'DOWNLOAD_RECONCILE_FAILED' }) }
    for (const c of list.filter((x) => x.state === 'complete')) { const r = finish(c); if (r) return r }
    const going = list.find((x) => x.state === 'in_progress')
    if (going) return wait(going.id)
    if (list.length && list.every((x) => x.state === 'interrupted')) { set({ state: 'failed', error_code: dlCode(list[0].error) }); return 'fresh' } // known dead: nothing to duplicate
    if (explicit) return 'fresh'
    return get()!.state === 'needs_review' ? get()! : set({ state: 'needs_review', error_code: 'DOWNLOAD_ACK_LOST' }) // undecidable: only the user may start another
  }

  const cur = get()
  if (cur?.state === 'completed') return cur
  if (cur && cur.state !== 'failed') {
    const r = await reconcile(a.explicit === true)
    if (r !== 'fresh') return r
  }

  // fresh transfer: the intent row is durable before anything is sent
  if (cur) set({ state: 'intent', handle: null, error_code: null })
  else {
    const name = planName({ batchLabel: a.batchLabel, at: a.at, index: a.index, prompt: a.prompt, outputId: a.mediaId, ext: a.kind === 'video' ? 'mp4' : 'png', root: env.root, tz: a.tz, withPrompt: a.withPrompt })
    db.prepare("insert into download(id,attempt_id,media_id,planned_name,state,created_at,updated_at) values(?,?,?,?,'intent',?,?)").run(randomUUID(), a.attemptId, a.mediaId, name, env.now(), env.now())
    env.onChange?.()
  }
  let sent: FetchMediaResult
  try {
    sent = await drv.fetchMedia(a.tab, { mediaId: a.mediaId, filename: `${prefix}.bin` })
    // Flow fetches a finished video's address about 0.6 s after the poll that reports it (measured); "not found" started nothing, so one more ask is safe
    if (!sent.ok && sent.code === 'NOT_FOUND' && a.kind === 'video') { await env.sleep(3000); sent = await drv.fetchMedia(a.tab, { mediaId: a.mediaId, filename: `${prefix}.bin` }) }
  } catch (e) {
    if (!(e instanceof ConnectorError)) return set({ state: 'failed', error_code: 'DOWNLOAD_REFUSED' }) // the extension refused the request: nothing was started
    set({ state: 'needs_review', error_code: 'DOWNLOAD_ACK_LOST' }) // the transfer may have started: look before anything else
    const r = await reconcile(false)
    return r === 'fresh' ? get()! : r
  }
  if (!sent.ok) return set({ state: 'failed', error_code: dlCode(sent.code) })
  set({ state: 'started', handle: String(sent.downloadId) })
  return wait(sent.downloadId)
}

// ---------- batch / retry (what the IPC calls) ----------
export type DownloaderOptions = { db: Db; driver: DlDriver; root: string; tz: string; now(): number; sleep?(ms: number): Promise<void>; budgetMs?: number; tab(): string | null; onChange?(batchId: string): void }
const WORKERS = 2

export function createDownloader(o: DownloaderOptions) {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const inflight = new Map<string, Promise<DlRow>>() // a double click must not open a second transfer
  type Out = { batchId: string; attemptId: string; mediaId: string; index: number; prompt: string; at: number; kind: 'image' | 'video' }

  const outputsOf = (batchId: string): Out[] => {
    const b = o.db.prepare('select created_at at, kind from batch where id=?').get(batchId) as { at: number; kind: 'image' | 'video' } | undefined
    if (!b) throw coded('NOT_FOUND')
    const items = o.db.prepare('select i.ord ord, i.prompt prompt, a.id aid, a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(batchId) as { ord: number; prompt: string; aid: string; j: string }[]
    return items.flatMap((it) => ((JSON.parse(it.j) as AttemptState).outputs ?? []).map((m: { mediaId: string }) => ({ batchId, attemptId: it.aid, mediaId: m.mediaId, index: it.ord + 1, prompt: it.prompt, at: b.at, kind: b.kind })))
  }
  const stateOf = (x: Out): string | undefined => (o.db.prepare('select state from download where attempt_id=? and media_id=?').get(x.attemptId, x.mediaId) as { state: string } | undefined)?.state

  const run = (x: Out, explicit: boolean): Promise<DlRow> => {
    const key = `${x.attemptId}:${x.mediaId}`
    const have = inflight.get(key)
    if (have) return have
    const tab = o.tab()
    if (!tab) return Promise.reject(coded('NO_PROJECT_TAB'))
    const p = requestDownload(o.db, o.driver, { attemptId: x.attemptId, mediaId: x.mediaId, tab, explicit, batchLabel: x.batchId.slice(0, 8), at: x.at, index: x.index, prompt: x.prompt, tz: o.tz, kind: x.kind },
      { root: o.root, now: o.now, sleep, budgetMs: o.budgetMs, onChange: () => o.onChange?.(x.batchId) }).finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }

  return {
    /** Every output of the batch that is not completed; failed ones are retried, needs_review ones are only reconciled. At most 2 at a time. */
    async batch(batchId: string): Promise<void> {
      const todo = outputsOf(batchId).filter((x) => stateOf(x) !== 'completed')
      if (todo.length && !o.tab()) throw coded('NO_PROJECT_TAB')
      let next = 0
      const worker = async (): Promise<void> => {
        for (let x = todo[next++]; x; x = todo[next++]) await run(x, false).catch((e) => console.error('download', (e as { code?: string }).code ?? 'INTERNAL_ERROR'))
      }
      await Promise.all(Array.from({ length: WORKERS }, worker))
    },
    /** The user's Thử lại on one output: the only call that may start a fresh transfer after "found nothing". */
    async retry(attemptId: string, mediaId: string): Promise<void> {
      const batch = (o.db.prepare('select i.batch_id b from attempt a join item i on i.id=a.item_id where a.id=?').get(attemptId) as { b: string } | undefined)?.b
      const x = batch ? outputsOf(batch).find((y) => y.attemptId === attemptId && y.mediaId === mediaId) : undefined
      if (!x) throw coded('NOT_FOUND')
      await run(x, true)
    },
    /** Absolute path of a saved output, proven on disk to be a regular file inside root (the row could be stale or the folder swapped for a link). */
    file(attemptId: string, mediaId: string): string {
      const r = o.db.prepare("select actual_name n from download where attempt_id=? and media_id=? and state='completed'").get(attemptId, mediaId) as { n: string | null } | undefined
      if (!r?.n) throw coded('NOT_FOUND')
      let real: string, st
      try { real = realpathSync(join(o.root, r.n)); st = lstatSync(real) } catch { throw coded('NOT_FOUND') } // moved or deleted by the user
      const root = realpathSync(o.root)
      if (!real.startsWith(root + sep) || !st.isFile()) throw coded('PATH_ESCAPE')
      return real
    },
  }
}
export type Downloader = ReturnType<typeof createDownloader>
