import { ConnectorError, type ClickResult, type FlowDriver, type FlowTab, type Ping } from '../driver'
import { projectIdOf } from '../tabs'
import { profile } from '../profile'
import type { ConnectorServer } from './server'

type CheckCode = 'COVERED' | 'CREDIT_WARNING' | 'BUTTON_DISABLED' | 'CHIP_MISMATCH' | 'TARGET_CHANGED'
export type CheckInput = {
  tabProject: string | null; projectId: string
  ping: { xhrSend: boolean; xhrOpen: boolean; fetch: boolean } | null
  probe: { present: Record<string, boolean> } | null
  state: { submitDisabled: boolean | null; creditWarning: boolean; chips: unknown[] } | null
  hit: { covered: boolean } | null
  refIds: string[]
}
/** Pure, fail closed: anything missing or odd blocks. Ref ids themselves are checked in Task 5; here only the chip count. */
export function decideCheck(c: CheckInput, selfCheck: readonly string[] = profile.selfCheck): { ok: true } | { ok: false; code: CheckCode } {
  const no = (code: CheckCode) => ({ ok: false as const, code })
  if (c.tabProject !== c.projectId) return no('TARGET_CHANGED')
  if (!c.ping || c.ping.xhrSend !== true || c.ping.xhrOpen !== true || c.ping.fetch !== true) return no('TARGET_CHANGED') // observer not alive: the page is not what we armed
  if (!c.probe || selfCheck.some((k) => c.probe!.present?.[k] !== true)) return no('TARGET_CHANGED')
  if (!c.state || c.state.submitDisabled !== false) return no('BUTTON_DISABLED')
  if (c.state.creditWarning !== false) return no('CREDIT_WARNING')
  if (!Array.isArray(c.state.chips) || c.state.chips.length !== c.refIds.length) return no('CHIP_MISMATCH')
  if (!c.hit) return no('BUTTON_DISABLED')
  if (c.hit.covered !== false) return no('COVERED')
  return { ok: true }
}

const todo = (what: string): never => {
  throw new ConnectorError(`${what}: not implemented`)
}

// allow: session grant. A tab the user did not grant never receives a page-acting op (prepare/click/arm), whatever the runner asks.
export function createExtDriver(server: ConnectorServer, o: { allow?(tabId: string): boolean } = {}): FlowDriver {
  const tab = (tabId: string): { tabId: number } => ({ tabId: Number(tabId) })
  const granted = (tabId: string): void => {
    if (o.allow && !o.allow(tabId)) throw new ConnectorError('tab not granted')
  }
  return {
    async listTabs() {
      const raw = (await server.send('tabs', {})) as Array<{ tabId: number; path: string; active: boolean }>
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
    // Settings (read back by label) then the prompt (must read back verbatim). Codes only: never the prompt text.
    async prepare(tabId, p) {
      granted(tabId)
      const combo = (p.settings as { combo?: Record<string, unknown> }).combo
      if (!combo) return { ok: false, code: 'SETTINGS_MISMATCH' }
      const call = async <T>(op: string, args: object, code: string): Promise<T | { fail: string }> => {
        try { return (await server.send(op, { ...tab(tabId), ...args })) as T } catch (e) { if (e instanceof ConnectorError) throw e; return { fail: code } }
      }
      const s = await call<{ ok: boolean }>('settings', { mode: combo.mode, aspect: combo.aspect, quality: combo.quality, count: combo.count === undefined ? undefined : `x${combo.count}`, model: combo.model }, 'SETTINGS_MISMATCH')
      if ('fail' in s) return { ok: false, code: s.fail }
      if (s?.ok !== true) return { ok: false, code: 'SETTINGS_MISMATCH' }
      const r = await call<{ ok: boolean; textMatches: boolean; log?: string[] }>('prep', { prompt: p.prompt }, 'PROMPT_MISMATCH')
      if ('fail' in r) return { ok: false, code: r.fail }
      if (r?.log?.includes('clear failed')) return { ok: false, code: 'COMPOSER_NOT_CLEAR' }
      return r?.ok === true && r.textMatches === true ? { ok: true } : { ok: false, code: 'PROMPT_MISMATCH' }
    },
    async checkBeforeClick(tabId, projectId, refIds = []) {
      granted(tabId)
      const t = tab(tabId)
      try {
        const tabs = (await server.send('tabs', {})) as Array<{ tabId: number; path: string }>
        const here = tabs.find((x) => x.tabId === t.tabId)
        const selectors = Object.fromEntries(profile.selfCheck.map((k) => [k, profile.selectors[k as keyof typeof profile.selectors]]))
        const [ping, probe, state, hit] = await Promise.all([server.send('ping', t), server.send('probe', { ...t, selectors }), server.send('state', t), server.send('hit', t)]) as never[]
        return decideCheck({ tabProject: here ? projectIdOf(here.path) : null, projectId, ping, probe, state, hit, refIds })
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
    onEvent: (cb) => server.onEvent(cb)
  }
}
