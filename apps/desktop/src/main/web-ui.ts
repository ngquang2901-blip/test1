// ToolFlow's own screens over http on the MCP port, for an app that shows ToolFlow inside itself (Kaiser's ToolFlow row).
// Trust boundary: a session starts only from a ticket that holds an HMAC of the MCP key and expires within 2 minutes (the
// app that holds the key makes it); the session is an HttpOnly cookie; a call must come from this page (its Origin plus a
// header a form cannot send) and name a handler the window has. The key itself never reaches the page.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'

const TICKET_MS = 2 * 60_000
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' }

/** `<expiry ms>.<hmac>`: what the app holding the key puts in /app/open?t=. */
export function uiTicket(token: string, expires: number): string {
  return `${expires}.${createHmac('sha256', token).update(`ui:${expires}`).digest('hex')}`
}

// window.api as the preload gives it, over fetch and one event stream. An error reads like Electron's, so the screens find its code.
const BRIDGE = `(() => {
  const listeners = { notice: new Set(), update: new Set(), state: new Set() };
  const events = new EventSource('./events');
  events.onmessage = (m) => { const e = JSON.parse(m.data); for (const cb of listeners[e.type] || []) cb(e.data); };
  const call = (ch) => async (arg) => {
    const r = await fetch('./rpc/' + ch, { method: 'POST', headers: { 'content-type': 'application/json', 'x-toolflow-ui': '1' }, body: JSON.stringify({ arg: arg === undefined ? null : arg }) });
    const out = await r.json().catch(() => ({ ok: false, error: 'INTERNAL_ERROR' }));
    if (!out.ok) throw new Error("Error invoking remote method '" + ch + "': Error: " + (out.error || 'INTERNAL_ERROR'));
    return out.value;
  };
  const on = (type) => (cb) => { listeners[type].add(cb); return () => listeners[type].delete(cb); };
  window.api = new Proxy({ onNotice: on('notice'), onUpdate: on('update'), onState: on('state') }, { get: (t, k) => (k in t ? t[k] : call(String(k))) });
})();`

type Handlers = Record<string, (a: never) => unknown>

export function createWebUi(o: { token: string; rendererDir: string; handlers: Handlers }) {
  const sessions = new Set<string>() // shortcut: kept until ToolFlow quits (one per opening of the screen); cap it if an app opens it in a loop
  const streams = new Set<ServerResponse>()
  const end = (res: ServerResponse, status: number, body?: string, type = 'text/plain'): true => { res.writeHead(status, body === undefined ? {} : { 'content-type': type }); res.end(body); return true }
  const session = (req: IncomingMessage): boolean => {
    const sid = /(?:^|;\s*)tf_ui=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')?.[1]
    return !!sid && sessions.has(sid)
  }
  const validTicket = (t: string | null): boolean => {
    const m = /^(\d{13})\.([a-f0-9]{64})$/.exec(t ?? '')
    if (!m) return false
    const exp = Number(m[1]), now = Date.now()
    if (exp < now || exp > now + TICKET_MS) return false
    return timingSafeEqual(Buffer.from(m[2]), Buffer.from(uiTicket(o.token, exp).split('.')[1]))
  }
  const body = (req: IncomingMessage): Promise<string | null> => new Promise((done) => {
    const parts: Buffer[] = []; let n = 0
    req.on('data', (c: Buffer) => { n += c.length; if (n <= 5_000_000) parts.push(c) })
    req.on('end', () => done(n > 5_000_000 ? null : Buffer.concat(parts).toString('utf8')))
    req.on('error', () => done(null))
  })

  /** True when the request was for the screens (answered here); false leaves it to MCP. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/app' && !url.pathname.startsWith('/app/')) return false
    if (url.pathname === '/app/open' && req.method === 'GET') {
      if (!validTicket(url.searchParams.get('t'))) return end(res, 401)
      const sid = randomBytes(32).toString('hex')
      sessions.add(sid)
      res.writeHead(302, { location: '/app/', 'set-cookie': `tf_ui=${sid}; HttpOnly; SameSite=Strict; Path=/app` })
      res.end()
      return true
    }
    if (!session(req)) return end(res, 401)
    const rest = url.pathname.slice('/app/'.length)
    if (req.method === 'POST' && rest.startsWith('rpc/')) {
      const own = `http://${req.headers.host}`
      if (req.headers.origin !== own || req.headers['x-toolflow-ui'] !== '1') return end(res, 403)
      const fn = Object.hasOwn(o.handlers, rest.slice(4)) ? o.handlers[rest.slice(4)] : undefined
      if (!fn) return end(res, 404)
      const text = await body(req)
      let arg: unknown
      try { arg = text === null ? undefined : (JSON.parse(text) as { arg?: unknown }).arg } catch { return end(res, 400) }
      if (text === null) return end(res, 413)
      try {
        const value = await (fn as (a: unknown) => unknown)(arg ?? undefined)
        return end(res, 200, JSON.stringify({ ok: true, value: value ?? null }), 'application/json')
      } catch (e) { return end(res, 200, JSON.stringify({ ok: false, error: (e as { code?: string })?.code ?? (e as Error)?.message ?? 'INTERNAL_ERROR' }), 'application/json') }
    }
    if (req.method !== 'GET') return end(res, 405)
    if (rest === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(': open\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return true
    }
    if (rest === 'bridge.js') return end(res, 200, BRIDGE, TYPES['.js'])
    const file = normalize(join(o.rendererDir, rest || 'index.html'))
    if (!file.startsWith(normalize(o.rendererDir) + sep) || !(extname(file) in TYPES)) return end(res, 404)
    let data: Buffer
    try { data = readFileSync(file) } catch { return end(res, 404) }
    if (rest === '' || rest === 'index.html') return end(res, 200, data.toString('utf8').replace('<script', '<script src="./bridge.js"></script><script'), TYPES['.html'])
    res.writeHead(200, { 'content-type': TYPES[extname(file)] })
    res.end(data)
    return true
  }

  return {
    handle,
    /** What the window is sent ('state', 'notice', 'update') goes to every open page too. */
    push(type: 'state' | 'notice' | 'update', data?: unknown): void {
      const line = `data: ${JSON.stringify({ type, data: data ?? null })}\n\n`
      for (const s of streams) s.write(line)
    },
    close(): void { for (const s of streams) s.end(); streams.clear() },
  }
}
