import { createHash, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { ConnectorError, type DriverEvent } from '../driver'

type Conn = { ws: WebSocket; inst: string; tabs: Set<string> }
type Pending = { conn: Conn; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const digest = (s: string): Buffer => createHash('sha256').update(s).digest()
// Per-op budgets (ms): reads fail fast, composer work and file work get room; unlisted ops use `default`.
export const OP_TIMEOUT_MS: Record<string, number> = {
  ping: 3000, account: 3000,
  state: 5000, hit: 5000, probe: 5000, tabs: 5000, focus: 5000, net: 5000, arm: 5000, trusted: 5000,
  settings: 20000, prep: 20000, file: 60000, attach: 50000, default: 30000
}

export type ConnectorServer = Awaited<ReturnType<typeof startConnectorServer>>

export const PROTO = 'toolflow.v1'
// Ops without a tab that every connected Chrome profile answers; the answers are concatenated (tab ids namespaced).
const BROADCAST = new Set(['tabs', 'gptTabs', 'gemTabs', 'downloads'])
/** App-facing tab id: `<instance>:<chrome tab id>` for an extension that names its instance (one per Chrome profile), the bare id otherwise. */
const ns = (inst: string, tab: unknown): string => (inst ? `${inst}:${tab}` : String(tab))
const parse = (id: string | number): [string, number] => {
  const s = String(id), i = s.lastIndexOf(':')
  return i < 0 ? ['', Number(s)] : [s.slice(0, i), Number(s.slice(i + 1))]
}

export async function startConnectorServer(o: { token: string; extensionId: string; port?: number; budgets?: Record<string, number> }) {
  const budgets = { ...OP_TIMEOUT_MS, ...o.budgets } // injectable so tests need no real 20 s waits
  // the token rides in a subprotocol (`tf.<token>`), not the URL: Chrome prints failed WebSocket URLs in the extension's Errors page
  const wss = new WebSocketServer({ host: '127.0.0.1', port: o.port ?? 0, handleProtocols: (ps) => (ps.has(PROTO) ? PROTO : false) })
  await new Promise<void>((res, rej) => {
    wss.once('listening', res)
    wss.once('error', rej)
  })
  wss.on('error', () => {}) // a later server error must not crash the process
  let epoch = Date.now() // R41: monotonic across restarts; fences replies only (tab epochs belong to the runner)
  const conns = new Map<string, Conn>() // one per extension instance (Chrome profile); the same instance reconnecting replaces itself
  let nextId = 1
  const pending = new Map<number, Pending>()
  const listeners = new Set<(e: DriverEvent) => void>()
  const emit = (e: DriverEvent): void => listeners.forEach((cb) => cb(e))
  const want = digest(o.token)

  const drop = (c: Conn): void => {
    if (conns.get(c.inst) === c) conns.delete(c.inst)
    for (const [id, p] of pending) {
      if (p.conn !== c) continue
      clearTimeout(p.timer)
      pending.delete(id)
      p.reject(new ConnectorError('connection lost'))
    }
    const tabs = [...c.tabs]
    c.tabs.clear() // once per connection
    tabs.forEach((tabId) => emit({ type: 'disconnected', tabId }))
  }

  wss.on('connection', (ws, req) => {
    // digests make timingSafeEqual length-safe; the protocol header is never logged or put in an error
    const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim())
    const token = protos.find((p) => p.startsWith('tf.'))?.slice(3) ?? ''
    const ok = timingSafeEqual(digest(token), want) && req.headers.origin === `chrome-extension://${o.extensionId}`
    if (!ok) return void ws.close(4401, 'unauthorized')
    const inst = protos.find((p) => /^tfi\.[0-9a-f]{8}$/.test(p))?.slice(4) ?? ''
    const conn: Conn = { ws, inst, tabs: new Set() }
    const old = conns.get(inst)
    conns.set(inst, conn)
    epoch++
    if (old) {
      drop(old)
      old.ws.close(4000, 'replaced')
    }
    ws.on('close', () => drop(conn))
    ws.on('error', () => {})
    ws.on('message', (data) => {
      if (conns.get(inst) !== conn) return // socket identity, not the epoch field, decides who is heard
      let m: Record<string, unknown>
      try {
        m = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!m || typeof m !== 'object' || 'keepalive' in m) return
      if (m.type === 'sent' || m.type === 'response' || m.type === 'poll') {
        const tabId = ns(inst, m.tabId)
        conn.tabs.add(tabId)
        return emit({ ...m, tabId } as DriverEvent)
      }
      const p = typeof m.id === 'number' ? pending.get(m.id) : undefined
      if (!p || p.conn !== conn) return // unknown id: dropped
      clearTimeout(p.timer)
      pending.delete(m.id as number)
      if (m.ok === true) p.resolve(m.result)
      else p.reject(Object.assign(new Error(String(m.error ?? 'extension error')), { code: 'EXTENSION_REFUSED' }))
    })
  })

  const sendTo = (conn: Conn, op: string, args: Record<string, unknown>, msgEpoch?: number): Promise<unknown> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new ConnectorError('extension did not answer'))
      }, budgets[op] ?? budgets.default)
      pending.set(id, { conn, resolve, reject, timer })
      conn.ws.send(JSON.stringify({ id, epoch: msgEpoch ?? epoch, op, args }), (err) => {
        if (!err) return
        clearTimeout(timer)
        pending.delete(id)
        reject(new ConnectorError('send failed'))
      })
    })
  }

  return {
    port: (wss.address() as { port: number }).port,
    address: () => wss.address() as { address: string; port: number },
    epoch: () => epoch,
    connected: () => conns.size > 0,
    onEvent(cb: (e: DriverEvent) => void): () => void {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    // msgEpoch: ext-driver passes the runner's tab epoch for 'trusted'; every other op carries the connection epoch.
    // A tab op goes to the profile that owns the tab; 'tabs'/'downloads' ask every profile; anything else needs exactly one.
    async send(op: string, args: { tabId?: number | string } & Record<string, unknown>, msgEpoch?: number): Promise<unknown> {
      if (args.tabId !== undefined) {
        const [inst, tab] = parse(args.tabId)
        const conn = conns.get(inst)
        if (!conn) throw new ConnectorError('no extension connected')
        conn.tabs.add(ns(inst, tab))
        return sendTo(conn, op, { ...args, tabId: tab }, msgEpoch)
      }
      const all = [...conns.values()]
      if (!all.length) throw new ConnectorError('no extension connected')
      if (!BROADCAST.has(op)) {
        if (all.length > 1) throw new ConnectorError('op needs a tab when several profiles are connected')
        return sendTo(all[0], op, args, msgEpoch)
      }
      const got = await Promise.allSettled(all.map(async (c) => {
        const r = await sendTo(c, op, args, msgEpoch)
        const list = Array.isArray(r) ? r : []
        return op === 'tabs' || op === 'gptTabs' || op === 'gemTabs' ? list.map((t: { tabId?: unknown }) => ({ ...t, tabId: ns(c.inst, t.tabId) })) : list
      }))
      const ok = got.filter((g): g is PromiseFulfilledResult<unknown[]> => g.status === 'fulfilled')
      if (!ok.length) throw (got[0] as PromiseRejectedResult).reason // every profile failed: the caller's usual error path
      return ok.flatMap((g) => g.value) // a profile that did not answer is left out; downloads still match by file name prefix
    },
    async close(): Promise<void> {
      for (const c of [...conns.values()]) drop(c)
      for (const c of wss.clients) c.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
    }
  }
}
