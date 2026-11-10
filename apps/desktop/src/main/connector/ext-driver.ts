import { ConnectorError, type ClickResult, type DlInfo, type FlowDriver, type FlowTab, type Ping } from '../driver'
import { projectIdOf } from '../tabs'
import { profile } from '../profile'
import { uploadName, type AssetStore } from '../assets'
import type { ConnectorServer } from './server'

type CheckCode = 'COVERED' | 'CREDIT_WARNING' | 'BUTTON_DISABLED' | 'CHIP_MISMATCH' | 'TARGET_CHANGED'
/** Order-insensitive; a null in `want` (unbound ref) never matches; a chip listed twice never matches. */
const sameSet = (chips: unknown, want: Array<string | null>): boolean => {
  const w = new Set(want)
  return Array.isArray(chips) && !w.has(null) && new Set(chips).size === chips.length && chips.length === w.size && chips.every((x) => w.has(x as string))
}

export type CheckInput = {
  tabProject: string | null; projectId: string
  ping: { xhrSend: boolean; xhrOpen: boolean; fetch: boolean } | null
  probe: { present: Record<string, boolean> } | null
  state: { submitDisabled: boolean | null; creditWarning: boolean; chips: unknown[] } | null
  hit: { covered: boolean } | null
  refMedia: Array<string | null> // bound media uuid per ref of the prompt; null = no bound binding
}
/** Pure, fail closed: anything missing or odd blocks. The composer chips must be exactly the media of the refs (set equality), none unbound. */
export function decideCheck(c: CheckInput, selfCheck: readonly string[] = profile.selfCheck): { ok: true } | { ok: false; code: CheckCode } {
  const no = (code: CheckCode) => ({ ok: false as const, code })
  if (c.tabProject !== c.projectId) return no('TARGET_CHANGED')
  if (!c.ping || c.ping.xhrSend !== true || c.ping.xhrOpen !== true || c.ping.fetch !== true) return no('TARGET_CHANGED') // observer not alive: the page is not what we armed
  if (!c.probe || selfCheck.some((k) => c.probe!.present?.[k] !== true)) return no('TARGET_CHANGED')
  if (!c.state || c.state.submitDisabled !== false) return no('BUTTON_DISABLED')
  if (c.state.creditWarning !== false) return no('CREDIT_WARNING')
  if (!sameSet(c.state.chips, c.refMedia)) return no('CHIP_MISMATCH')
  if (!c.hit) return no('BUTTON_DISABLED')
  if (c.hit.covered !== false) return no('COVERED')
  return { ok: true }
}

const selfSelectors = () => Object.fromEntries(profile.selfCheck.map((k) => [k, profile.selectors[k as keyof typeof profile.selectors]]))

const todo = (what: string): never => {
  throw new ConnectorError(`${what}: not implemented`)
}

// allow: session grant, fail closed: omitted ⇒ nothing is granted. A tab the user did not grant never receives a page-acting op (prepare/click/arm), whatever the runner asks.
export type ExtDriverOptions = {
  allow?(tabId: string): boolean
  assets?: AssetStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  uploadWindowMs?: number // how long a fresh upload may take to show in the library
}
type AttachResult = { ok: true; chips: string[]; added: string } | { ok: false; code: string }
const UPLOAD_WINDOW_MS = 30_000

export function createExtDriver(server: ConnectorServer, o: ExtDriverOptions = {}): FlowDriver {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const mediaOf = (assetId: string, projectId: string): string | null => { const b = o.assets?.binding(assetId, projectId); return b?.state === 'bound' ? b.mediaId : null }
  const tab = (tabId: string): { tabId: string } => ({ tabId }) // the server routes it to the Chrome profile that owns it
  const granted = (tabId: string): void => {
    if (!o.allow?.(tabId)) throw new ConnectorError('tab not granted')
  }
  return {
    async listTabs() {
      const raw = (await server.send('tabs', {})) as Array<{ tabId: string; path: string; active: boolean }>
      return Promise.all(raw.map(async (t): Promise<FlowTab> => ({
        tabId: String(t.tabId), projectId: projectIdOf(t.path), active: !!t.active,
        email: ((await server.send('account', { tabId: t.tabId }).catch(() => null)) as string | null) ?? null, // no content script ⇒ not logged in as far as we can tell
      })))
    },
    async ping(tabId) {
      const p = (await server.send('ping', tab(tabId))) as Omit<Ping, 'email'>
      const email = (await server.send('account', tab(tabId))) as string | null // R2: main-world ping has no email
      return { ...p, email: email ?? null }
    },
    // Self-check signals, all read-only. No main world (null) ⇒ 0 listeners / nothing seen, so the check fails.
    async probeTab(tabId) {
      granted(tabId)
      const t = tab(tabId)
      const [p, l, ping] = await Promise.all([server.send('probe', { ...t, selectors: selfSelectors() }), server.send('listeners', t), server.send('ping', t)]) as Array<{ present: Record<string, boolean>; listeners: number; seen?: string[] } | null>
      return { present: p?.present ?? {}, listeners: l?.listeners ?? 0, sawProjectLoad: !!ping?.seen?.includes(profile.rpc.project) }
    },
    // Settings (read back by label) then the prompt (must read back verbatim). Codes only: never the prompt text.
    async prepare(tabId, p) {
      granted(tabId)
      const combo = (p.settings as { combo?: Record<string, unknown> }).combo
      if (!combo) return { ok: false, code: 'SETTINGS_MISMATCH' }
      const call = async <T>(op: string, args: object, code: string): Promise<T | { fail: string }> => {
        try { return (await server.send(op, { ...tab(tabId), ...args })) as T } catch (e) { if (e instanceof ConnectorError) throw e; return { fail: code } }
      }
      const refs = p.refIds, project = p.projectId
      if (refs.length && !(project && o.assets)) return { ok: false, code: 'REF_ASSET_MISSING' }
      // I2: the page is touched only when the tab is on the batch's project (settings, upload and typing would otherwise land in another project)
      const here = ((await server.send('tabs', {})) as Array<{ tabId: string; path: string }>).find((x) => String(x.tabId) === tabId)
      if (!project || !here || projectIdOf(here.path) !== project) return { ok: false, code: 'TARGET_CHANGED' }
      const s = await call<{ ok: boolean }>('settings', { mode: combo.mode, aspect: combo.aspect, quality: combo.quality, count: combo.count === undefined ? undefined : `x${combo.count}`, model: combo.model }, 'SETTINGS_MISMATCH')
      if ('fail' in s) return { ok: false, code: s.fail }
      if (s?.ok !== true) return { ok: false, code: 'SETTINGS_MISMATCH' }
      const live = (x: unknown): x is { text?: string; chips: string[] } => !!x && typeof x === 'object' && !('fail' in x) && Array.isArray((x as { chips?: unknown }).chips)
      const readState = async () => { const r = await call<{ text?: string; chips: string[] }>('state', {}, 'CHIP_MISMATCH'); return live(r) ? r : null }
      let st = await readState()
      if (!st) return { ok: false, code: 'CHIP_MISMATCH' }
      // Chips that are not ours, or text that prep would clear (which drops chips too): clear first, then prove the chips are gone.
      const ours = new Set(refs.map((id) => mediaOf(id, project!)))
      if (st.chips.some((c) => !ours.has(c)) || st.text?.trim()) {
        await call('click', { sel: profile.selectors.clear, idx: 0 }, 'COMPOSER_NOT_CLEAR')
        st = null
        for (let k = 0; k < 10; k++) { // chips can take a moment to go
          st = await readState()
          if (st && !st.chips.length) break
          await sleep(300)
        }
        if (!st || st.chips.length) return { ok: false, code: 'COMPOSER_NOT_CLEAR' }
      }
      let have = st.chips
      for (const id of refs) {
        const asset = o.assets!.get(id)
        if (!asset) return { ok: false, code: 'REF_ASSET_MISSING' }
        let b = o.assets!.binding(id, project!)
        if (b?.state === 'bound' && have.includes(b.mediaId!)) continue
        const attach = async (name: string) => await call<AttachResult>('attach', { name }, 'REF_ATTACH_ERROR')
        const attachWait = async (name: string) => { // the upload is async: the library may need a while to show it
          const t0 = now()
          for (;;) {
            const x = await attach(name)
            if (!('fail' in x) && !x.ok && x.code === 'NOT_FOUND' && now() - t0 < (o.uploadWindowMs ?? UPLOAD_WINDOW_MS)) await sleep(1000)
            else return x
          }
        }
        let r: AttachResult | { fail: string }
        if (b?.state === 'bound') { // chip lost (Q-19): attach only, and it must be the same media
          r = await attach(b.uploadName)
          if ('fail' in r) return { ok: false, code: r.fail }
          if (!r.ok) return { ok: false, code: `REF_${r.code}` }
          if (r.added !== b.mediaId) return { ok: false, code: 'REF_MISMATCH' }
          have = r.chips
          continue
        }
        if (b) r = b.state === 'uploading' ? await attachWait(b.uploadName) : await attach(b.uploadName) // uploading/uncertain: a previous upload may have happened, so never upload again; an uploading one may still be processing
        else {
          let bytes: Buffer
          try { bytes = asset.bytes() } catch { return { ok: false, code: 'REF_ASSET_MISSING' } }
          b = { assetId: id, projectId: project!, uploadName: uploadName(id, asset.mime, now()), mediaId: null, state: 'uploading', intentAt: now() }
          o.assets!.writeBinding(b) // durable before the bytes leave
          const sent = await call('file', { how: 'drop', name: b.uploadName, mime: asset.mime, b64: bytes.toString('base64') }, 'REF_UPLOAD_UNCERTAIN')
          if (!sent || typeof sent !== 'object' || 'fail' in sent) { o.assets!.writeBinding({ ...b, state: 'uncertain' }); return { ok: false, code: 'REF_UPLOAD_UNCERTAIN' } }
          r = await attachWait(b.uploadName)
        }
        if (!('fail' in r) && r.ok) { o.assets!.writeBinding({ ...b, state: 'bound', mediaId: r.added }); have = r.chips; continue }
        o.assets!.writeBinding({ ...b, state: 'uncertain' })
        if ('fail' in r) return { ok: false, code: r.fail }
        return { ok: false, code: r.code === 'NOT_FOUND' ? 'REF_UPLOAD_UNCERTAIN' : `REF_${r.code}` }
      }
      const r = await call<{ ok: boolean; textMatches: boolean; log?: string[] }>('prep', { prompt: p.prompt }, 'PROMPT_MISMATCH')
      if ('fail' in r) return { ok: false, code: r.fail }
      if (r?.log?.includes('clear failed')) return { ok: false, code: 'COMPOSER_NOT_CLEAR' }
      if (!(r?.ok === true && r.textMatches === true)) return { ok: false, code: 'PROMPT_MISMATCH' }
      const fin = await readState()
      return fin && sameSet(fin.chips, p.refIds.map((id) => mediaOf(id, p.projectId!))) ? { ok: true } : { ok: false, code: 'CHIP_MISMATCH' }
    },
    async checkBeforeClick(tabId, projectId, refIds = []) {
      granted(tabId)
      const t = tab(tabId)
      try {
        const refMedia = refIds.map((id) => mediaOf(id, projectId))
        const tabs = (await server.send('tabs', {})) as Array<{ tabId: string; path: string }>
        const here = tabs.find((x) => String(x.tabId) === t.tabId)
        const selectors = selfSelectors()
        const [ping, probe, state, hit] = await Promise.all([server.send('ping', t), server.send('probe', { ...t, selectors }), server.send('state', t), server.send('hit', t)]) as never[]
        return decideCheck({ tabProject: here ? projectIdOf(here.path) : null, projectId, ping, probe, state, hit, refMedia })
      } catch { return { ok: false, code: 'TARGET_CHANGED' } }
    },
    // the runner's tab epoch rides in msg.epoch (sw.js copies it into args.epoch for 'trusted')
    click: async (tabId, epoch) => (granted(tabId), (await server.send('trusted', tab(tabId), epoch)) as ClickResult),
    // shortcut: needs a separate read tab, live in P2
    readProject: async () => todo('readProject'),
    async arm(tabId, epoch) {
      granted(tabId)
      await server.send('arm', { ...tab(tabId), epoch })
    },
    async focusTab(tabId) {
      await server.send('focus', tab(tabId))
    },
    // The extension reads the tile's src itself (locate/src never leave the page) and starts chrome.downloads; only an id or a code comes back.
    async fetchMedia(tabId, p) {
      granted(tabId)
      const r = (await server.send('fetchMedia', { ...tab(tabId), mediaId: p.mediaId, filename: p.filename })) as { ok?: unknown; downloadId?: unknown; code?: unknown } | null
      if (r?.ok === true && Number.isInteger(r.downloadId)) return { ok: true, downloadId: r.downloadId as number }
      return { ok: false, code: typeof r?.code === 'string' ? r.code : 'DOWNLOAD_REFUSED' }
    },
    async downloads(q) {
      const r = await server.send('downloads', q.id !== undefined ? { id: q.id } : { filenamePrefix: q.filenamePrefix })
      const states = ['in_progress', 'interrupted', 'complete']
      return (Array.isArray(r) ? r : []).filter((x): x is DlInfo => !!x && Number.isInteger(x.id) && states.includes(x.state) && typeof x.filename === 'string').map((x) => ({ id: x.id, state: x.state, filename: x.filename, fileSize: Number(x.fileSize), mime: String(x.mime ?? ''), error: typeof x.error === 'string' ? x.error : null }))
    },
    onEvent: (cb) => server.onEvent(cb)
  }
}
