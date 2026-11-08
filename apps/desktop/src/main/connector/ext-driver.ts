import { ConnectorError, type ClickResult, type FlowDriver, type Ping } from '../driver'
import type { ConnectorServer } from './server'

const todo = (what: string): never => {
  throw new ConnectorError(`${what}: not implemented`)
}

export function createExtDriver(server: ConnectorServer): FlowDriver {
  const tab = (tabId: string): { tabId: number } => ({ tabId: Number(tabId) })
  return {
    async ping(tabId) {
      const p = (await server.send('ping', tab(tabId))) as Omit<Ping, 'email'>
      const email = (await server.send('account', tab(tabId))) as string | null // R2: main-world ping has no email
      return { ...p, email: email ?? null }
    },
    // shortcut: no matching extension op yet (fail closed), live in P2
    prepare: async () => ({ ok: false, code: 'NOT_IMPLEMENTED' }),
    // shortcut: cannot verify the page yet, so refuse every click, live in P2
    checkBeforeClick: async () => ({ ok: false, code: 'TARGET_CHANGED' }),
    // the runner's tab epoch rides in msg.epoch (sw.js copies it into args.epoch for 'trusted')
    click: (tabId, epoch) => server.send('trusted', tab(tabId), epoch) as Promise<ClickResult>,
    // shortcut: needs a separate read tab, live in P2
    readProject: async () => todo('readProject'),
    async arm(tabId, epoch) {
      await server.send('arm', { ...tab(tabId), epoch })
    },
    // shortcut: no focus op in the extension, live in P2
    focusTab: async () => todo('focusTab'),
    onEvent: (cb) => server.onEvent(cb)
  }
}
