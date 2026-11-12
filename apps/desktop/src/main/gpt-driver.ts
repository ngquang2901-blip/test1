// ChatGPT image driver: what the runner may ask of a chatgpt.com tab. The real one talks to the extension's gpt ops;
// the fake plays a conversation for unit tests and e2e. No call returns conversation text or an address.
import { randomBytes, randomUUID } from 'node:crypto'
import type { FetchMediaResult } from './driver'
import type { ConnectorServer } from './connector/server'

export type GptTab = { tabId: string; conv: string | null; active: boolean }
export type GptState = { conv: string | null; start: boolean; visible: boolean; editor: boolean; mode: string | null; textLen: number; canSend: boolean; generating: boolean; turns: number }
/** One exchange: `mine` = its user bubble is exactly the prompt asked about; `images` = media ids of finished images; `pending` = images still loading. */
export type GptTurn = { key: string; state: string | null; mine: boolean; images: string[]; pending: number } // state: 'complete' | 'in_progress' | null as the page says; right after the click a turn reads 'complete' for a few seconds before its answer starts (measured)
export type GptStep = { ok: true } | { ok: false; code: string }
export type RefFile = { name: string; mime: string; b64: string }
export interface GptDriver {
  tabs(): Promise<GptTab[]>
  newChat(tab: string): Promise<boolean> // the tab goes to an empty conversation
  open(tab: string, conv: string): Promise<boolean> // the tab goes back to one of our conversations
  front(tab: string, raise?: boolean): Promise<boolean> // the tab becomes the active one of its window; raise: the window itself comes forward too (only when the page is still hidden)
  state(tab: string): Promise<GptState>
  mode(tab: string, aspect?: string): Promise<GptStep> // image mode on (postcondition read from the composer); aspect: Gemini's ratio menu
  attach?(tab: string, file: RefFile, clear: boolean): Promise<GptStep> // Gemini: one reference image into the composer; clear = remove what is attached first
  prep(tab: string, prompt: string): Promise<GptStep> // types; never sends
  send(tab: string, prompt: string, refs?: number): Promise<GptStep> // ok:false = nothing was clicked; refs: how many images must be attached (Gemini)
  turns(tab: string, prompt: string): Promise<{ conv: string | null; turns: GptTurn[] }> // the conversation and its turns in one look, so a turn is never paired with another chat's id
  fetchMedia(tab: string, p: { mediaId: string; filename: string }): Promise<FetchMediaResult>
}

export const IMAGE_MODE = 'picture_v2'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const isGptMedia = (id: string): boolean => new RegExp(`^${UUID}-[1-9][0-9]?$`).test(id)
export const isGemMedia = (id: string): boolean => /^[0-9a-f]{8,32}-[1-9][0-9]?$/.test(id) // Gemini: turn id (hex) + image number
/** The two sites the runner can drive: the prefix of the site's extension ops and where a conversation's id sits in the tab's path. */
const SITES = { chatgpt: { ops: 'gpt', conv: new RegExp(`^/c/(${UUID})$`) }, gemini: { ops: 'gem', conv: /^\/app\/([0-9a-f]{8,32})$/ } } as const
export type Site = keyof typeof SITES

export function createExtGpt(server: Pick<ConnectorServer, 'send'>, site: Site = 'chatgpt'): GptDriver {
  const x = SITES[site].ops, convOf = (path: string): string | null => SITES[site].conv.exec(path)?.[1] ?? null
  const op = <T>(name: string, tabId: string, args: Record<string, unknown> = {}): Promise<T> => server.send(name, { tabId, ...args }) as Promise<T>
  return {
    async tabs() { return ((await server.send(`${x}Tabs`, {})) as { tabId: string; path: string; active: boolean }[]).map((t) => ({ tabId: t.tabId, conv: convOf(t.path), active: t.active })) },
    newChat: (t) => op(`${x}New`, t), open: (t, conv) => op(`${x}Open`, t, { conv }), front: (t, raise) => op('gptFront', t, raise ? { raise: true } : {}), state: (t) => op(`${x}State`, t), mode: (t, aspect) => op(`${x}Mode`, t, aspect ? { aspect } : {}), // gptFront: any tab
    ...(site === 'gemini' ? { attach: (t: string, file: RefFile, clear: boolean) => op<GptStep>('gemAttach', t, { ...file, clear }) } : {}),
    prep: (t, prompt) => op(`${x}Prep`, t, { prompt }), send: (t, prompt, refs) => op(`${x}Send`, t, { prompt, ...(refs === undefined ? {} : { refs }) }), turns: (t, prompt) => op(`${x}Turns`, t, { prompt }),
    fetchMedia: (t, p) => op(`${x}Fetch`, t, p),
  }
}

// ---------- fake ----------
/** Per send, in order: ok = an image; two = two images in one answer; text = an answer without an image; lost = no turn shows up;
 *  slow = the answer never finishes; foreign = a turn that is not ours shows up instead; leave = an image, after which the user
 *  moves the tab to another chat (at the next look at the composer, so its own image is still saved); early = an image, but the turn
 *  reads "complete" for its first looks, before the answer starts (measured live); mute = reads "complete" from the first look and
 *  never gets an image or an answer in progress. After the script: ok. */
export type GptScript = 'ok' | 'two' | 'text' | 'lost' | 'slow' | 'foreign' | 'leave' | 'early' | 'mute'
type FakeTurn = { key: string; prompt: string; kind: GptScript; polls: number; msg: string }

export function createFakeGpt(script: GptScript[] = [], o: { site?: Site; tabs?: number; fetchMedia?: GptDriver['fetchMedia']; mode?: string[]; prep?: string[]; send?: string[] } = {}) {
  const steps = [...script]
  const newId = (): string => (o.site === 'gemini' ? randomBytes(8).toString('hex') : randomUUID()) // ids shaped like the site's own
  const fail = { mode: [...(o.mode ?? [])], prep: [...(o.prep ?? [])], send: [...(o.send ?? [])] } // per call, in order: '' = ok, anything else = that code
  const convs = new Map<string, FakeTurn[]>()
  const page = { open: (o.tabs ?? 1) > 0, front: false, hidden: false, minimised: false, conv: null as string | null, start: false, mode: null as string | null, text: '' }
  const files: string[] = [] // what is attached in the composer
  const ledger = { aspects: [] as (string | null)[], attached: [] as { name: string; mime: string; bytes: number; clear: boolean }[], refs: [] as string[][], sends: [] as string[], fronts: 0, raises: 0, newChats: 0, opens: [] as string[], fetched: [] as string[] }
  const here = (): FakeTurn[] => (page.conv ? convs.get(page.conv) ?? [] : [])
  const need = (): void => { if (!page.open) throw Object.assign(new Error('no such tab'), { code: 'CONNECTOR_LOST' }) }
  let leaving = false
  const leave = (): void => { page.conv = newId(); convs.set(page.conv, []); page.start = false; page.mode = null; page.text = '' }
  const imagesOf = (t: FakeTurn): string[] => (t.kind === 'ok' || t.kind === 'leave' || t.kind === 'early' ? [`${t.msg}-1`] : t.kind === 'two' ? [`${t.msg}-1`, `${t.msg}-2`] : [])
  const done = (t: FakeTurn): boolean => t.kind !== 'slow' && t.polls >= (t.kind === 'early' ? 5 : 2)
  const step = (list: string[]): string => list.shift() ?? ''
  const driver: GptDriver = {
    async tabs() { return page.open ? [{ tabId: o.site === 'gemini' ? 'm1' : 'g1', conv: page.conv, active: true }] : [] },
    async front(_t, raise) { need(); if (raise) { ledger.raises++; page.minimised = false } else ledger.fronts++; page.front = true; return true },
    async newChat() { need(); ledger.newChats++; page.conv = null; page.start = true; page.mode = null; page.text = ''; return true },
    async open(_t, conv) { need(); ledger.opens.push(conv); if (!convs.has(conv)) return false; page.conv = conv; page.start = false; page.mode = null; page.text = ''; return true },
    async state() { need(); if (leaving) { leaving = false; leave() } return { conv: page.conv, start: page.start, visible: page.front && !page.hidden && !page.minimised, editor: true, mode: page.mode, textLen: page.text.length, canSend: page.text.length > 0, generating: here().some((t) => !done(t) && t.kind !== 'slow'), turns: here().length } },
    async mode(_t, aspect) { need(); const c = step(fail.mode); if (c) return { ok: false, code: c }; if (!page.front || page.hidden || page.minimised) return { ok: false, code: 'MODE_NOT_FOUND' }; page.mode = IMAGE_MODE; ledger.aspects.push(aspect ?? null); return { ok: true } },
    ...(o.site === 'gemini' ? { async attach(_t: string, f: RefFile, clear: boolean): Promise<GptStep> { need(); if (clear) files.length = 0; files.push(f.name); ledger.attached.push({ name: f.name, mime: f.mime, bytes: Buffer.from(f.b64, 'base64').length, clear }); return { ok: true } } } : {}), // the menu does not open in a tab that is not shown
    async prep(_t, prompt) {
      need(); const c = step(fail.prep); if (c) return { ok: false, code: c }
      if (page.mode !== IMAGE_MODE) return { ok: false, code: 'MODE_NOT_SET' }
      if (page.text && page.text !== prompt) return { ok: false, code: 'COMPOSER_NOT_EMPTY' } // exactly our prompt already there (an earlier try): fine as it is
      page.text = prompt; return { ok: true }
    },
    async send(_t, prompt, refs) {
      need(); const c = step(fail.send); if (c) return { ok: false, code: c }
      if (page.mode !== IMAGE_MODE) return { ok: false, code: 'MODE_NOT_SET' }
      if (page.text !== prompt) return { ok: false, code: 'PROMPT_MISMATCH' }
      if (refs !== undefined && files.length !== refs) return { ok: false, code: 'REF_MISMATCH' }
      const kind = steps.shift() ?? 'ok'
      ledger.refs.push(files.splice(0)); ledger.sends.push(prompt); page.text = ''; page.mode = null // the pill is gone after every send (measured)
      if (kind === 'lost') return { ok: true }
      if (!page.conv) { page.conv = newId(); page.start = false; convs.set(page.conv, []) }
      convs.get(page.conv)!.push({ key: newId(), prompt: kind === 'foreign' ? 'something the user typed' : prompt, kind, polls: 0, msg: newId() })
      return { ok: true }
    },
    async turns(_t, prompt) {
      need()
      return { conv: page.conv, turns: here().map((t) => { t.polls++; if (t.kind === 'leave' && t.polls === 2) leaving = true; return { key: t.key, state: done(t) || t.kind === 'early' || t.kind === 'mute' ? 'complete' : 'in_progress', mine: t.prompt === prompt, images: done(t) ? imagesOf(t) : [], pending: !done(t) && t.kind !== 'early' && imagesOf({ ...t, polls: 9 }).length ? 1 : 0 } }) }
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
    /** The user switches to another tab of that window / minimises the window (front() cannot undo the second). */
    toBackground() { page.front = false }, minimise() { page.minimised = true }, hideWindow(h: boolean) { page.hidden = h }, // hideWindow: hidden whatever is tried
  }
}
