// MCP endpoint (Model Context Protocol, "Streamable HTTP" without a stream): lets an AI agent on THIS machine create batches and read
// their results through the same handlers the screens call. Off unless the user turns it on in Cài đặt. Trust boundary: 127.0.0.1 only,
// a bearer token from a 0600 file, no browser Origin, small bodies; a tool can never enable auto-send, pick settings or touch files.
import { createServer, type IncomingMessage } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'

export type Tool = { description: string; inputSchema: object; run(args: Record<string, unknown>): Promise<unknown> }
type Opts = { version: string; tools: Record<string, Tool> }
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const coded = (code: string): Error => Object.assign(new Error(code), { code })

/** One JSON-RPC message in, its answer out (null for a notification). */
export async function rpc(msg: unknown, o: Opts): Promise<object | null> {
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> } | null
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
  if (m.id === undefined) return null
  const ok = (result: object): object => ({ jsonrpc: '2.0', id: m.id, result })
  const err = (code: number, message: string): object => ({ jsonrpc: '2.0', id: m.id, error: { code, message } })
  if (m.method === 'initialize') return ok({ protocolVersion: VERSIONS.includes(m.params?.protocolVersion as string) ? m.params!.protocolVersion : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'toolflow', version: o.version } })
  if (m.method === 'ping') return ok({})
  if (m.method === 'tools/list') return ok({ tools: Object.entries(o.tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) })
  if (m.method !== 'tools/call') return err(-32601, 'Method not found')
  const tool = o.tools[m.params?.name as string], args = m.params?.arguments ?? {}
  if (!tool || typeof args !== 'object' || Array.isArray(args)) return err(-32602, 'Unknown tool or bad arguments')
  try { return ok({ content: [{ type: 'text', text: JSON.stringify(await tool.run(args as Record<string, unknown>)) }] }) }
  catch (e) { return ok({ content: [{ type: 'text', text: (e as { code?: string })?.code ?? 'INTERNAL_ERROR' }], isError: true }) } // the app's error code only: a message could carry a path
}

const body = (req: IncomingMessage, max: number): Promise<string | null> => new Promise((done) => {
  const parts: Buffer[] = []; let n = 0
  req.on('data', (c: Buffer) => { n += c.length; if (n <= max) parts.push(c) }) // past the cap the rest is read and dropped, so the 413 can be sent
  req.on('end', () => done(n > max ? null : Buffer.concat(parts).toString('utf8')))
  req.on('error', () => done(null))
})

export async function startMcp(o: Opts & { token: string; port: number }): Promise<{ port: number; close(): Promise<void> }> {
  const want = createHash('sha256').update(`Bearer ${o.token}`).digest()
  const server = createServer((req, res) => {
    const end = (status: number, json?: object): void => { res.writeHead(status, json ? { 'content-type': 'application/json' } : {}); res.end(json ? JSON.stringify(json) : undefined) }
    void (async () => {
      if (req.headers.origin !== undefined) return end(403) // a web page (or a DNS-rebound one) can reach 127.0.0.1; an MCP client is not a page
      if (!timingSafeEqual(createHash('sha256').update(req.headers.authorization ?? '').digest(), want)) return end(401)
      if (req.url !== '/mcp') return end(404)
      if (req.method !== 'POST') return end(405)
      const text = await body(req, 1_000_000)
      if (text === null) return end(413)
      let msg: unknown
      try { msg = JSON.parse(text) } catch { return end(400) }
      const out = Array.isArray(msg) ? (await Promise.all(msg.map((x) => rpc(x, o)))).filter(Boolean) : await rpc(msg, o)
      return out === null || (Array.isArray(out) && !out.length) ? end(202) : end(200, out as object)
    })().catch(() => end(500))
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(o.port, '127.0.0.1', ok) })
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}

/** The user's on/off. `file` (0600) holds the choice, the address and the token: it is what the user points an agent at, and the token never goes to the renderer. */
export function createMcpSwitch(o: Opts & { file: string; port: number }) {
  let live: Awaited<ReturnType<typeof startMcp>> | null = null
  const saved = (): { enabled?: boolean; token?: string } => { try { return JSON.parse(readFileSync(o.file, 'utf8')) } catch { return {} } }
  const state = () => ({ enabled: !!live, url: live ? `http://127.0.0.1:${live.port}/mcp` : null, file: o.file })
  const close = async (): Promise<void> => { await live?.close(); live = null }
  async function set(on: boolean) {
    const token = saved().token ?? randomBytes(32).toString('hex')
    await close()
    if (on) live = await startMcp({ ...o, token }) // a busy port throws EADDRINUSE: nothing is written, the switch stays off
    writeFileSync(o.file, JSON.stringify({ enabled: on, url: state().url, token, note: 'Send the token as the HTTP header  Authorization: Bearer <token>. Anyone who can read this file can spend Flow credits through ToolFlow.' }, null, 2), { mode: 0o600 })
    chmodSync(o.file, 0o600) // the mode above only applies when the file is created
    return state()
  }
  return { state, set, close, start: async () => { if (saved().enabled) await set(true) } }
}

type Brief = { id: string; kind: string; status: string; pauseReason: string | null; items: { prompt: string; attempts: { id: string; item: string; error: { code?: string } | null; outputs: string[] }[] }[] }
export type McpDeps = {
  enqueue(a: object): Promise<{ batchId?: string; batchIds?: string[]; errors?: { code: string }[] }>; start(batchId: string): Promise<unknown>; download(batchId: string): Promise<unknown> // the handlers the screens call
  list(): Promise<{ batches: unknown[]; session: unknown }>
  file(attemptId: string, mediaId: string): string // the saved file's path; throws when it is not saved
}

/** What an agent may do: read the state, send a list of prompts with the app's default settings, read results, save them. */
export function toolsOf(d: McpDeps): Record<string, Tool> {
  const batches = async (id?: unknown): Promise<object> => ({ batches: ((await d.list()).batches as Brief[]).filter((b) => id === undefined || b.id === id).map((b) => ({
    id: b.id, kind: b.kind, status: b.status, pauseReason: b.pauseReason ?? null,
    items: b.items.map((it, i) => { const a = it.attempts.at(-1); return { n: i + 1, prompt: it.prompt, state: a?.item ?? null, error: a?.error?.code ?? null, files: (a?.outputs ?? []).flatMap((m) => { try { return [d.file(a!.id, m)] } catch { return [] } }) } }),
  })) })
  return {
    toolflow_status: {
      description: 'ToolFlow state: is Chrome connected, how many Flow tabs are in use, how many chatgpt.com / gemini.google.com tabs are open, did the self-check pass, is auto-send on (off = the user must click Send in Flow).',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const s = (await d.list()).session as { connected: boolean | null; tabs: { granted: boolean }[]; gptTabs?: number; gemTabs?: number; autoEnabled: boolean; selfCheck: { ok: boolean } | null; email: string | null }
        return { connected: s.connected !== false, /* null: the built-in test Flow, which has no Chrome to lose */ tabsInUse: s.tabs.filter((t) => t.granted).length, chatgptTabs: s.gptTabs ?? 0, geminiTabs: s.gemTabs ?? 0, selfCheckOk: !!s.selfCheck?.ok, autoSend: s.autoEnabled, account: s.email ? s.email.replace(/^(..)[^@]*/, '$1***') : null }
      },
    },
    toolflow_create_batch: {
      description: 'Send prompts to Google Flow (or, with site, to the ChatGPT / Gemini tab) through ToolFlow, one result set per prompt, with the app\'s default settings (image: 2 images per prompt; video: one 8 s video, 10 Flow credits each). Spends the user\'s Flow credits. Returns batch ids; poll toolflow_list_batches.',
      inputSchema: { type: 'object', required: ['prompts'], properties: { prompts: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 5000 }, description: 'One prompt per entry, no line breaks.' }, kind: { type: 'string', enum: ['image', 'video'], default: 'image' }, site: { type: 'string', enum: ['flow', 'chatgpt', 'gemini'], default: 'flow', description: 'chatgpt / gemini: images only, one per prompt, sent in the open chatgpt.com / gemini.google.com tab and saved by the app; uses that account\'s image quota, not Flow credits.' }, aspect: { type: 'string', enum: ['1:1', '9:16', '3:4', '4:3', '16:9'], description: 'gemini only.' }, model: { type: 'string', enum: ['Flash-Lite', 'Flash', 'Pro'], description: 'gemini only; also changes the model in the user\'s Gemini tab.' } } },
      async run(a) {
        const kind = a.kind ?? 'image', p = a.prompts, site = a.site ?? 'flow'
        if (!['flow', 'chatgpt', 'gemini'].includes(site as string) || (kind !== 'image' && kind !== 'video') || !Array.isArray(p) || !p.length || p.length > 100 || p.some((x) => typeof x !== 'string' || !x.trim() || x.length > 5000 || /[\r\n]/.test(x))) throw coded('INVALID_ARGS')
        const r = await d.enqueue({ commandId: `mcp:${randomUUID()}`, kind, mode: 'auto', text: (p as string[]).map((x) => x.trim()).join('\n'),
          ...(site !== 'flow' ? { provider: site, ...(a.aspect !== undefined ? { aspect: a.aspect } : {}), ...(a.model !== undefined ? { model: a.model } : {}) } : {}) }) // enqueue refuses a wrong mix (a video, a ratio for ChatGPT)
        if (r.errors?.length) return { errors: r.errors }
        const batchIds = r.batchIds ?? [r.batchId!]
        for (const id of batchIds) await d.start(id)
        return { batchIds }
      },
    },
    toolflow_list_batches: {
      description: 'Batches (newest first) with each prompt\'s state, error code and the paths of its saved files. batchId narrows to one.',
      inputSchema: { type: 'object', properties: { batchId: { type: 'string' } } },
      run: (a) => batches(a.batchId),
    },
    toolflow_download: {
      description: 'Save every finished result of a batch to Downloads/ToolFlow, then return the batch with file paths. Generates nothing.',
      inputSchema: { type: 'object', required: ['batchId'], properties: { batchId: { type: 'string' } } },
      async run(a) { if (typeof a.batchId !== 'string' || !a.batchId) throw coded('INVALID_ARGS'); await d.download(a.batchId); return batches(a.batchId) },
    },
  }
}
