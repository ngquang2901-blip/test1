// ChatGPT image driver: what the runner may ask of a chatgpt.com tab. The real one talks to the extension's gpt ops;
// the fake plays a conversation for unit tests and e2e. No call returns conversation text or an address.
import { randomUUID } from 'node:crypto'
import type { FetchMediaResult } from './driver'
import type { ConnectorServer } from './connector/server'

export type GptTab = { tabId: string; conv: string | null; active: boolean }
export type GptState = { conv: string | null; start: boolean; editor: boolean; mode: string | null; textLen: number; canSend: boolean; generating: boolean; turns: number }
/** One exchange: `mine` = its user bubble is exactly the prompt asked about; `images` = media ids of finished images; `pending` = images still loading. */
export type GptTurn = { key: string; state: string | null; mine: boolean; images: string[]; pending: number }
export type GptStep = { ok: true } | { ok: false; code: string }
export interface GptDriver {
  tabs(): Promise<GptTab[]>
  newChat(tab: string): Promise<boolean> // the tab goes to an empty conversation
  open(tab: string, conv: string): Promise<boolean> // the tab goes back to one of our conversations
  state(tab: string): Promise<GptState>
  mode(tab: string): Promise<GptStep> // image mode on (postcondition read from the composer)
  prep(tab: string, prompt: string): Promise<GptStep> // types; never sends
  send(tab: string, prompt: string): Promise<GptStep> // ok:false = nothing was clicked
  turns(tab: string, prompt: string): Promise<{ conv: string | null; turns: GptTurn[] }> // the conversation and its turns in one look, so a turn is never paired with another chat's id
  fetchMedia(tab: string, p: { mediaId: string; filename: string }): Promise<FetchMediaResult>
}

export const IMAGE_MODE = 'picture_v2'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const isGptMedia = (id: string): boolean => new RegExp(`^${UUID}-[1-9][0-9]?$`).test(id)
const convOf = (path: string): string | null => new RegExp(`^/c/(${UUID})$`).exec(path)?.[1] ?? null

export function createExtGpt(server: Pick<ConnectorServer, 'send'>): GptDriver {
  const op = <T>(name: string, tabId: string, args: Record<string, unknown> = {}): Promise<T> => server.send(name, { tabId, ...args }) as Promise<T>
  return {
    async tabs() { return ((await server.send('gptTabs', {})) as { tabId: string; path: string; active: boolean }[]).map((t) => ({ tabId: t.tabId, conv: convOf(t.path), active: t.active })) },
    newChat: (t) => op('gptNew', t), open: (t, conv) => op('gptOpen', t, { conv }), state: (t) => op('gptState', t), mode: (t) => op('gptMode', t),
    prep: (t, prompt) => op('gptPrep', t, { prompt }), send: (t, prompt) => op('gptSend', t, { prompt }), turns: (t, prompt) => op('gptTurns', t, { prompt }),
    fetchMedia: (t, p) => op('gptFetch', t, p),
  }
}

// ---------- fake ----------
/** Per send, in order: ok = an image; two = two images in one answer; text = an answer without an image; lost = no turn shows up;
 *  slow = the answer never finishes; foreign = a turn that is not ours shows up instead; leave = an image, after which the user
 *  moves the tab to another chat (at the next look at the composer, so its own image is still saved). After the script: ok. */
export type GptScript = 'ok' | 'two' | 'text' | 'lost' | 'slow' | 'foreign' | 'leave'
type FakeTurn = { key: string; prompt: string; kind: GptScript; polls: number; msg: string }

export function createFakeGpt(script: GptScript[] = [], o: { tabs?: number; fetchMedia?: GptDriver['fetchMedia']; mode?: string[]; prep?: string[]; send?: string[] } = {}) {
  const steps = [...script]
  const fail = { mode: [...(o.mode ?? [])], prep: [...(o.prep ?? [])], send: [...(o.send ?? [])] } // per call, in order: '' = ok, anything else = that code
  const convs = new Map<string, FakeTurn[]>()
  const page = { open: (o.tabs ?? 1) > 0, conv: null as string | null, start: false, mode: null as string | null, text: '' }
  const ledger = { sends: [] as string[], newChats: 0, opens: [] as string[], fetched: [] as string[] }
  const here = (): FakeTurn[] => (page.conv ? convs.get(page.conv) ?? [] : [])
  const need = (): void => { if (!page.open) throw Object.assign(new Error('no such tab'), { code: 'CONNECTOR_LOST' }) }
  let leaving = false
  const leave = (): void => { page.conv = randomUUID(); convs.set(page.conv, []); page.start = false; page.mode = null; page.text = '' }
  const imagesOf = (t: FakeTurn): string[] => (t.kind === 'ok' || t.kind === 'leave' ? [`${t.msg}-1`] : t.kind === 'two' ? [`${t.msg}-1`, `${t.msg}-2`] : [])
  const done = (t: FakeTurn): boolean => t.kind !== 'slow' && t.polls >= 2
  const step = (list: string[]): string => list.shift() ?? ''
  const driver: GptDriver = {
    async tabs() { return page.open ? [{ tabId: 'g1', conv: page.conv, active: true }] : [] },
    async newChat() { need(); ledger.newChats++; page.conv = null; page.start = true; page.mode = null; page.text = ''; return true },
    async open(_t, conv) { need(); ledger.opens.push(conv); if (!convs.has(conv)) return false; page.conv = conv; page.start = false; page.mode = null; page.text = ''; return true },
    async state() { need(); if (leaving) { leaving = false; leave() } return { conv: page.conv, start: page.start, editor: true, mode: page.mode, textLen: page.text.length, canSend: page.text.length > 0, generating: here().some((t) => !done(t) && t.kind !== 'slow'), turns: here().length } },
    async mode() { need(); const c = step(fail.mode); if (c) return { ok: false, code: c }; page.mode = IMAGE_MODE; return { ok: true } },
    async prep(_t, prompt) {
      need(); const c = step(fail.prep); if (c) return { ok: false, code: c }
      if (page.mode !== IMAGE_MODE) return { ok: false, code: 'MODE_NOT_SET' }
      if (page.text) return { ok: false, code: 'COMPOSER_NOT_EMPTY' }
      page.text = prompt; return { ok: true }
    },
    async send(_t, prompt) {
      need(); const c = step(fail.send); if (c) return { ok: false, code: c }
      if (page.mode !== IMAGE_MODE) return { ok: false, code: 'MODE_NOT_SET' }
      if (page.text !== prompt) return { ok: false, code: 'PROMPT_MISMATCH' }
      const kind = steps.shift() ?? 'ok'
      ledger.sends.push(prompt); page.text = ''; page.mode = null // the pill is gone after every send (measured)
      if (kind === 'lost') return { ok: true }
      if (!page.conv) { page.conv = randomUUID(); page.start = false; convs.set(page.conv, []) }
      convs.get(page.conv)!.push({ key: randomUUID(), prompt: kind === 'foreign' ? 'something the user typed' : prompt, kind, polls: 0, msg: randomUUID() })
      return { ok: true }
    },
    async turns(_t, prompt) {
      need()
      return { conv: page.conv, turns: here().map((t) => { t.polls++; if (t.kind === 'leave' && t.polls === 2) leaving = true; return { key: t.key, state: done(t) ? 'complete' : null, mine: t.prompt === prompt, images: done(t) ? imagesOf(t) : [], pending: !done(t) && imagesOf({ ...t, polls: 2 }).length ? 1 : 0 } }) }
    },
    async fetchMedia(tab, p) {
      need(); ledger.fetched.push(p.mediaId)
      if (!here().some((t) => done(t) && imagesOf(t).includes(p.mediaId))) return { ok: false, code: 'NOT_FOUND' } // the image is only on the page of its own conversation
      return o.fetchMedia ? o.fetchMedia(tab, p) : { ok: false, code: 'DOWNLOAD_REFUSED' }
    },
  }
  return {
    driver, ledger, page,
    /** The user goes to another chat / types in the composer / closes the tab. */
    userLeaves: leave,
    userTypes(text: string) { page.text = text },
    closeTab() { page.open = false }, openTab() { page.open = true },
  }
}
