import { createHash, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { ConnectorError, type DriverEvent } from '../driver'

type Conn = { ws: WebSocket; tabs: Set<string> }
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
  let cur: Conn | undefined
  let nextId = 1
  const pending = new Map<number, Pending>()
  const listeners = new Set<(e: DriverEvent) => void>()
  const emit = (e: DriverEvent): void => listeners.forEach((cb) => cb(e))
  const want = digest(o.token)

  const drop = (c: Conn): void => {
    if (cur === c) cur = undefined
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
    const token = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).find((p) => p.startsWith('tf.'))?.slice(3) ?? ''
    const ok = timingSafeEqual(digest(token), want) && req.headers.origin === `chrome-extension://${o.extensionId}`
    if (!ok) return void ws.close(4401, 'unauthorized')
    const conn: Conn = { ws, tabs: new Set() }
    const old = cur
    cur = conn
    epoch++
    if (old) {
      drop(old)
      old.ws.close(4000, 'replaced')
    }
    ws.on('close', () => drop(conn))
    ws.on('error', () => {})
    ws.on('message', (data) => {
      if (cur !== conn) return // socket identity, not the epoch field, decides who is heard
      let m: Record<string, unknown>
      try {
        m = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!m || typeof m !== 'object' || 'keepalive' in m) return
      if (m.type === 'sent' || m.type === 'response') {
        const tabId = String(m.tabId)
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

  return {
    port: (wss.address() as { port: number }).port,
    address: () => wss.address() as { address: string; port: number },
    epoch: () => epoch,
    connected: () => cur !== undefined,
    onEvent(cb: (e: DriverEvent) => void): () => void {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    // msgEpoch: ext-driver passes the runner's tab epoch for 'trusted'; every other op carries the connection epoch
    send(op: string, args: { tabId?: number } & Record<string, unknown>, msgEpoch?: number): Promise<unknown> {
      const conn = cur
      if (!conn) return Promise.reject(new ConnectorError('no extension connected'))
      const id = nextId++
      if (args.tabId !== undefined) conn.tabs.add(String(args.tabId))
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
    },
    async close(): Promise<void> {
      if (cur) drop(cur)
      for (const c of wss.clients) c.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
    }
  }
}
