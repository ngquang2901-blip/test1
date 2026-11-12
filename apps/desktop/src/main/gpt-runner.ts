// Image runner for a chat site (ChatGPT, Gemini; docs/app/05, D-09): one new conversation per batch, prompts sent one after another in it, at most 15 turns per
// conversation. It writes the same batch / item / attempt rows as the Flow runner, so the queue, the results and the downloader show a
// ChatGPT batch like any other; the Flow runner skips batches with provider 'chatgpt'.
// Never sends twice: the intent is journaled before the click, and a click without a turn of exactly our prompt ends in "needs review".
import { next, type AttemptState } from '@toolflow/flow-protocol/attempt'
import type { Db } from './db'
import type { FetchMediaResult } from './driver'
import type { Runner } from './runner'
import type { GptDriver, GptState, GptStep, GptTurn, Site } from './gpt-driver'

export const GPT_TURNS_PER_CONV = 15
const SEND_DEADLINE_MS = 30_000 // a click must show its turn within this
const GEN_DEADLINE_MS = 600_000 // an answer still unfinished after this is for the user to look at
const NO_IMAGE_GRACE_MS = 20_000 // "finished without an image" is believed only after this: the image can render after the answer ends
const NOT_STARTED_GRACE_MS = 90_000 // …and only after this when the answer was never seen in progress: a turn reads "complete" for some seconds right after the click (measured: 2–5 s)
const PAGE_WAIT_TRIES = 30 // x 500 ms: a navigated tab must show its composer within this

type Row = { id: string; batch: string; s: AttemptState }
type Base = { keys: string[]; conv: string | null; at: number } // turns that were there before the click, the conversation, the click time
type Req = { turnKey: string; conv: string | null }

export type GptRunner = {
  tick(): Promise<void>; recover(): void; lastError(batchId: string): string | null; findTab(): Promise<string | null> // the ChatGPT tab in use, or the first one open
  fetchMedia(tab: string, p: { mediaId: string; filename: string }): Promise<FetchMediaResult>
}

export function createGptRunner(o: {
  db: Db; driver: GptDriver; provider?: Site; clock: { now(): number }; pollMs?: number; // provider: the batches this runner owns (default chatgpt)
  sleep?(ms: number): Promise<void>
  download?(batchId: string): Promise<void> // saves the batch's finished images; called while they are still on the page
}): GptRunner {
  const { db, driver, clock } = o
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollMs = o.pollMs ?? 1500
  const provider = o.provider ?? 'chatgpt'
  const reasons = new Map<string, string>() // why this runner paused a batch
  const reopen = new Set<string>() // batches the user resumed: the tab may be taken back to their conversation once
  const noImage = new Map<string, number>() // attempt → when its answer was first seen finished without an image
  const started = new Set<string>() // attempts whose answer was seen in progress or with an image coming
  let lastTab: string | null = null
  let lastPoll = -Infinity
  let busy = false // a prompt is being typed/sent, or the tab is being taken to a conversation for a download

  const put = (id: string, type: string, s: AttemptState): AttemptState => {
    db.transaction(() => {
      db.prepare('update attempt set state_json=?, revision=revision+1 where id=?').run(JSON.stringify(s), id)
      db.prepare('insert into journal_event(attempt_id, type, at, payload_json) values(?,?,?,?)').run(id, type, clock.now(), JSON.stringify({ type, item: s.item, stage: s.stage, code: s.error?.code ?? null }))
    })()
    return s
  }
  const rows = (where: string, ...args: unknown[]): Row[] => (db.prepare(
    `select a.id, i.batch_id batch, a.state_json j from item i join attempt a on a.id=i.attempt_id join batch b on b.id=i.batch_id
     where b.provider=? and ${where} order by b.created_at, b.rowid, i.ord`).all(provider, ...args) as { id: string; batch: string; j: string }[]).map((r) => ({ id: r.id, batch: r.batch, s: JSON.parse(r.j) as AttemptState }))
  const flying = (): Row[] => rows("json_extract(a.state_json,'$.item') in ('submitting','generating')")
  const review = (s: AttemptState, code: string, why: string): AttemptState => ({ ...s, item: 'needs_review', stage: s.stage === 'accepted' ? 'accepted' : 'uncertain', error: { code, why }, admission: 'pause', creditSpent: true })
  const hold = (batch: string, code: string): void => {
    db.prepare("update batch set status='paused', revision=revision+1 where id=? and status='running'").run(batch)
    reasons.set(batch, code)
  }
  const theTab = async (conv?: string | null): Promise<string | null> => {
    try {
      const tabs = await driver.tabs()
      const t = (conv ? tabs.find((x) => x.conv === conv) : undefined) ?? tabs.find((x) => x.tabId === lastTab) ?? tabs.find((x) => x.active) ?? tabs[0]
      return (lastTab = t?.tabId ?? null)
    } catch { return null } // the extension is not there: the same as no tab
  }
  const waitFor = async (tab: string, ok: (s: GptState) => boolean, tries = PAGE_WAIT_TRIES): Promise<GptState | null> => {
    for (let i = 0; i < tries; i++) {
      try { const s = await driver.state(tab); if (ok(s)) return s } catch { /* the page is loading */ }
      await sleep(500)
    }
    return null
  }

  /** One in-flight attempt: its turn must show up, then finish with an image. */
  async function watch(a: Row): Promise<void> {
    const s = a.s, base = s.baseline as Base, req = s.request as Req | null
    const tab = await theTab(req?.conv ?? base.conv)
    let turns: GptTurn[] = [], conv: string | null = null
    if (tab) try { ({ turns, conv } = await driver.turns(tab, s.prompt)) } catch { /* not seen this time */ }
    const age = clock.now() - base.at
    const moving = (t: GptTurn): boolean => t.state !== 'complete' || t.pending > 0 || t.images.length > 0 // the answer is under way (or there)
    if (s.item === 'submitting') {
      const fresh = turns.filter((t) => !base.keys.includes(t.key)), mine = fresh.filter((t) => t.mine)
      if (mine.length === 1) { if (moving(mine[0])) started.add(a.id); put(a.id, 'turn', { ...s, item: 'generating', stage: 'accepted', request: { turnKey: mine[0].key, conv: base.conv ?? conv } satisfies Req, creditSpent: true, error: null }); return }
      if (mine.length > 1) { put(a.id, 'deadline', review(s, 'SUBMIT_UNCERTAIN', 'more than one new turn with this prompt')); return }
      if (age >= SEND_DEADLINE_MS) put(a.id, 'deadline', fresh.length ? review(s, 'USER_INTERFERENCE', 'a turn that is not this prompt appeared') : review(s, 'SUBMIT_UNCERTAIN', 'no turn appeared after the click'))
      return
    }
    if (!req) return
    const t = turns.find((x) => x.key === req.turnKey)
    const cur = t && !req.conv && conv ? put(a.id, 'conv', { ...s, request: { ...req, conv } }) : s // a new conversation gets its id a moment after the first send
    if (t && t.state === 'complete' && t.images.length && !t.pending) {
      noImage.delete(a.id); started.delete(a.id)
      put(a.id, 'ready', { ...cur, item: 'ready', stage: 'outcome_known', outputs: t.images.map((mediaId) => ({ mediaId })), error: null })
      await o.download?.(a.batch).catch(() => undefined) // a failed save shows on the output itself
      return
    }
    if (t && moving(t)) started.add(a.id)
    if (t && t.state === 'complete' && !t.images.length && !t.pending) {
      if (!noImage.has(a.id)) noImage.set(a.id, clock.now())
      if (clock.now() - noImage.get(a.id)! < (started.has(a.id) ? NO_IMAGE_GRACE_MS : NOT_STARTED_GRACE_MS)) return
      noImage.delete(a.id); started.delete(a.id)
      put(a.id, 'no_image', { ...cur, item: 'failed', stage: 'outcome_known', error: { code: 'GPT_NO_IMAGE' }, admission: 'pause' })
      hold(a.batch, 'GPT_NO_IMAGE') // a limit or a refusal: the next prompts would likely end the same way, so the user decides
      return
    }
    noImage.delete(a.id)
    if (age >= GEN_DEADLINE_MS) put(a.id, 'deadline', next(cur, { type: 'deadline' }))
  }

  /** Sends the next prompt of one batch. Anything in the way before the click pauses the batch and keeps the item. */
  async function dispatch(tab: string, batch: string, c: Row, list: Row[]): Promise<void> {
    let s = c.s
    if (s.item === 'queued') s = put(c.id, 'prepare', { ...s, item: 'preparing', retryAt: null })
    const sent = list.filter((a) => (a.s.request as Req | null)?.turnKey)
    const cur = sent.length ? (sent[sent.length - 1].s.request as Req).conv : null
    const used = cur ? sent.filter((a) => (a.s.request as Req).conv === cur).length : 0
    const fresh = !cur || used >= GPT_TURNS_PER_CONV
    let keys: string[]
    try {
      let st: GptState | null
      if (fresh) {
        await driver.newChat(tab)
        st = await waitFor(tab, (x) => x.start && x.editor && x.turns === 0)
      } else {
        st = await driver.state(tab)
        if (st.conv !== cur) {
          if (!reopen.has(batch)) return hold(batch, 'GPT_CONVERSATION_CHANGED') // the user moved the tab: never type into another chat
          await driver.open(tab, cur)
        }
        st = await waitFor(tab, (x) => x.conv === cur && x.editor && x.turns >= used) // every turn we know of is on the page before the baseline is taken
      }
      reopen.delete(batch)
      if (!st) return hold(batch, fresh ? 'GPT_PAGE_NOT_READY' : 'GPT_CONVERSATION_CHANGED')
      await driver.front(tab) // ChatGPT's "+" menu does not open while the page is hidden (measured): the tab becomes the active one of its window
      if (!(await waitFor(tab, (x) => x.visible, 4))) { // still hidden: the window is minimised or covered, so it is raised (only now, not to pull Chrome over the user's work for nothing)
        await driver.front(tab, true)
        if (!(await waitFor(tab, (x) => x.visible, 6))) return hold(batch, 'GPT_TAB_HIDDEN')
      }
      if (st.generating) return // the page is still answering something: look again on a later tick
      keys = (await driver.turns(tab, s.prompt)).turns.map((t) => t.key)
      let r: GptStep = await driver.mode(tab)
      if (r.ok) r = await driver.prep(tab, s.prompt)
      if (!r.ok) return hold(batch, `GPT_${r.code}`)
    } catch { return hold(batch, 'CONNECTOR_LOST') } // nothing was sent
    const base: Base = { keys, conv: fresh ? null : cur, at: clock.now() }
    s = put(c.id, 'intent', { ...s, item: 'submitting', stage: 'intent_recorded', clicked: false, baseline: base, request: null, error: null, manual: false })
    let r: GptStep
    try { r = await driver.send(tab, s.prompt) } catch { put(c.id, 'deadline', review(s, 'SUBMIT_UNCERTAIN', 'the page did not answer the click')); return }
    if (!r.ok) { // the page refused before clicking
      put(c.id, 'not_clicked', { ...s, item: 'preparing', stage: 'rejected_before_dispatch', error: { code: `GPT_${r.code}` } })
      return hold(batch, `GPT_${r.code}`)
    }
    put(c.id, 'clicked', { ...s, clicked: true, baseline: { ...base, at: clock.now() } })
  }

  async function run(): Promise<void> {
    for (const b of [...reasons.keys()]) { // the user resumed a batch this runner paused
      if ((db.prepare('select status from batch where id=?').get(b) as { status: string } | undefined)?.status === 'running') { reasons.delete(b); reopen.add(b) }
    }
    const fly = flying()
    const batches = fly.length ? [] : db.prepare("select id from batch where provider=? and status='running' and stop_requested=0 and archived=0 order by created_at, rowid").all(provider) as { id: string }[]
    if (!fly.length && !batches.length) return // nothing of ours: the extension is not asked anything
    if (clock.now() - lastPoll < pollMs || busy) return
    lastPoll = clock.now()
    if (fly.length) { for (const a of fly) await watch(a); return } // one prompt at a time: the next goes out on a later tick
    for (const b of batches) {
      const list = rows('i.batch_id=?', b.id)
      if (list.some((a) => a.s.item === 'needs_review')) continue // waits for the user's answer
      const c = list.find((a) => a.s.item === 'queued' || a.s.item === 'preparing')
      if (!c) continue
      const tab = await theTab()
      if (!tab) { hold(b.id, 'NO_CHATGPT_TAB'); continue }
      busy = true
      try { await dispatch(tab, b.id, c, list) } finally { busy = false }
      return
    }
  }

  let chain: Promise<unknown> = Promise.resolve()
  return {
    tick() { const p = chain.then(run); chain = p.catch(() => undefined); return p },
    recover() { // after a restart a click without its turn is uncertain, never resent; an answer being generated is simply watched again
      for (const a of rows("json_extract(a.state_json,'$.item')='submitting'")) put(a.id, 'restart', next(a.s, { type: 'restart' }))
    },
    lastError: (b) => reasons.get(b) ?? null,
    findTab: () => theTab(),
    /** The image is only on the page of its own conversation: when the tab is elsewhere and no prompt is in flight, take it back there. */
    async fetchMedia(tab, p) {
      let r = await driver.fetchMedia(tab, p)
      if (r.ok || r.code !== 'NOT_FOUND' || busy || flying().length) return r
      const owner = (db.prepare('select state_json j from attempt where state_json like ?').all(`%"mediaId":"${p.mediaId}"%`) as { j: string }[])[0]
      const conv = owner ? (JSON.parse(owner.j).request as Req | null)?.conv : null
      if (!conv) return r
      busy = true
      try {
        if ((await driver.state(tab)).conv !== conv && !(await driver.open(tab, conv))) return r
        for (let i = 0; i < 20; i++) { await sleep(1000); r = await driver.fetchMedia(tab, p); if (r.ok || r.code !== 'NOT_FOUND') break }
        return r
      } catch { return r } finally { busy = false }
    },
  }
}

/** One Runner for the IPC: the user's actions on a batch (start, pause, resume, stop, confirm, rerun, archive) are plain state and work for both
 *  sites; ticking, restart recovery and the pause reason come from both runners. */
export function routeRunner(flow: Runner, ...sites: GptRunner[]): Runner {
  return {
    ...flow,
    async tick() { const r = await Promise.allSettled([flow.tick(), ...sites.map((s) => s.tick())]); for (const x of r) if (x.status === 'rejected') throw x.reason },
    recover() { flow.recover(); for (const s of sites) s.recover() },
    lastError: (b) => sites.map((s) => s.lastError(b)).find((e) => e != null) ?? flow.lastError(b),
  }
}
