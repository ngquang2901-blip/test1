import { ConnectorError, type ClickResult, type FlowDriver, type FlowTab, type Ping } from '../driver'
import { projectIdOf } from '../tabs'
import type { ConnectorServer } from './server'

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
    // shortcut: no matching extension op yet (fail closed), live in P2
    prepare: async (tabId) => (granted(tabId), { ok: false, code: 'NOT_IMPLEMENTED' }),
    // shortcut: cannot verify the page yet, so refuse every click, live in P2
    checkBeforeClick: async () => ({ ok: false, code: 'TARGET_CHANGED' }),
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
