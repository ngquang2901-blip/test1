// MCP endpoint (Model Context Protocol, "Streamable HTTP" without a stream): lets an AI agent on THIS machine create batches and read
// their results through the same handlers the screens call. Off unless the user turns it on in Cài đặt. Trust boundary: 127.0.0.1 only,
// a bearer token from a 0600 file, no browser Origin, small bodies; a tool can never enable auto-send, pick settings or touch files.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { hintOf, checkHint } from '../renderer/src/hints' // the Vietnamese line the screens show for a code
import PANEL_HTML from './mcp-panel.html?raw'

/** meta: `_meta` as listed (a UI tool names the panel); app: only the panel calls it, i.e. the user's click in a chat that shows ToolFlow's panel. */
export type Tool = { description: string; inputSchema: object; meta?: object; readOnly?: boolean; app?: true; run(args: Record<string, unknown>): Promise<unknown> }
type Opts = { version: string; tools: Record<string, Tool> }
type Ctx = { apps?: boolean } // apps: the client announced MCP Apps (io.modelcontextprotocol/ui) on this connection
export const PANEL_URI = 'ui://toolflow/panel'
const APP_MIME = 'text/html;profile=mcp-app'
const UI_EXT = 'io.modelcontextprotocol/ui'
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const coded = (code: string): Error => Object.assign(new Error(code), { code })

/** One JSON-RPC message in, its answer out (null for a notification). */
export async function rpc(msg: unknown, o: Opts, ctx: Ctx = {}): Promise<object | null> {
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> } | null
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
  if (m.id === undefined) return null
  const ok = (result: object): object => ({ jsonrpc: '2.0', id: m.id, result })
  const err = (code: number, message: string): object => ({ jsonrpc: '2.0', id: m.id, error: { code, message } })
  if (m.method === 'initialize') return ok({ protocolVersion: VERSIONS.includes(m.params?.protocolVersion as string) ? m.params!.protocolVersion : VERSIONS[0], capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'toolflow', version: o.version } })
  if (m.method === 'ping') return ok({})
  const open = (t: Tool | undefined): t is Tool => !!t && (!t.app || !!ctx.apps) // a panel-only tool does not exist for any other client
  if (m.method === 'tools/list') return ok({ tools: Object.entries(o.tools).filter(([, t]) => open(t)).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema,
    ...(t.app ? { _meta: { ui: { visibility: ['app'] } }, annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false } } : t.meta ? { _meta: t.meta, annotations: { readOnlyHint: !!t.readOnly } } : {}) })) })
  if (m.method === 'resources/list') return ok({ resources: [{ uri: PANEL_URI, name: 'ToolFlow', mimeType: APP_MIME }] })
  if (m.method === 'resources/read') return m.params?.uri === PANEL_URI ? ok({ contents: [{ uri: PANEL_URI, mimeType: APP_MIME, text: PANEL_HTML }] }) : err(-32002, 'Resource not found')
  if (m.method !== 'tools/call') return err(-32601, 'Method not found')
  const tool = o.tools[m.params?.name as string], args = m.params?.arguments ?? {}
  if (!open(tool) || typeof args !== 'object' || Array.isArray(args)) return err(-32602, 'Unknown tool or bad arguments')
  try { return ok({ content: [{ type: 'text', text: JSON.stringify(await tool.run(args as Record<string, unknown>)) }] }) }
  catch (e) { // the app's error code and its own line for the user (what an agent should tell them): a message could carry a path
    const code = (e as { code?: string })?.code ?? 'INTERNAL_ERROR', hint = hintOf(code)
    return ok({ content: [{ type: 'text', text: hint ? `${code}: ${hint}` : code }], isError: true })
  }
}

const body = (req: IncomingMessage, max: number): Promise<string | null> => new Promise((done) => {
  const parts: Buffer[] = []; let n = 0
  req.on('data', (c: Buffer) => { n += c.length; if (n <= max) parts.push(c) }) // past the cap the rest is read and dropped, so the 413 can be sent
  req.on('end', () => done(n > max ? null : Buffer.concat(parts).toString('utf8')))
  req.on('error', () => done(null))
})

/** ui: ToolFlow's own screens under /app (web-ui.ts), answered before the MCP checks: they are a browser page by design. */
export async function startMcp(o: Opts & { token: string; port: number; ui?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }): Promise<{ port: number; close(): Promise<void> }> {
  const want = createHash('sha256').update(`Bearer ${o.token}`).digest()
  const appsSid = createHmac('sha256', o.token).update('mcp-apps').digest('hex') // handed only to a client that announced the UI extension; from the token, so it outlives a restart
  const server = createServer((req, res) => {
    const end = (status: number, json?: object): void => { res.writeHead(status, json ? { 'content-type': 'application/json' } : {}); res.end(json ? JSON.stringify(json) : undefined) }
    void (async () => {
      if (o.ui && await o.ui(req, res)) return
      if (req.headers.origin !== undefined) return end(403) // a web page (or a DNS-rebound one) can reach 127.0.0.1; an MCP client is not a page
      if (!timingSafeEqual(createHash('sha256').update(req.headers.authorization ?? '').digest(), want)) return end(401)
      if (req.url !== '/mcp') return end(404)
      if (req.method !== 'POST') return end(405)
      const text = await body(req, 1_000_000)
      if (text === null) return end(413)
      let msg: unknown
      try { msg = JSON.parse(text) } catch { return end(400) }
      const sid = req.headers['mcp-session-id'], ctx = { apps: typeof sid === 'string' && sid.length === 64 && timingSafeEqual(Buffer.from(sid), Buffer.from(appsSid)) }
      const m = msg as { method?: unknown; params?: { capabilities?: { extensions?: Record<string, unknown> } } } | null
      if (m?.method === 'initialize' && m.params?.capabilities?.extensions?.[UI_EXT]) res.setHeader('mcp-session-id', appsSid)
      const out = Array.isArray(msg) ? (await Promise.all(msg.map((x) => rpc(x, o, ctx)))).filter(Boolean) : await rpc(msg, o, ctx)
      return out === null || (Array.isArray(out) && !out.length) ? end(202) : end(200, out as object)
    })().catch(() => end(500))
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(o.port, '127.0.0.1', ok) })
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}

/** The user's on/off. `file` (0600) holds the choice, the address and the token: it is what the user points an agent at, and the token never goes to the renderer. */
export function createMcpSwitch(o: Opts & { file: string; port: number; ui?: (token: string) => (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }) {
  let live: Awaited<ReturnType<typeof startMcp>> | null = null
  const saved = (): { enabled?: boolean; token?: string } => { try { return JSON.parse(readFileSync(o.file, 'utf8')) } catch { return {} } }
  const state = () => ({ enabled: !!live, url: live ? `http://127.0.0.1:${live.port}/mcp` : null, file: o.file })
  const close = async (): Promise<void> => { await live?.close(); live = null }
  async function set(on: boolean) {
    const token = saved().token ?? randomBytes(32).toString('hex')
    await close()
    if (on) live = await startMcp({ ...o, token, ui: o.ui?.(token) }) // a busy port throws EADDRINUSE: nothing is written, the switch stays off
    writeFileSync(o.file, JSON.stringify({ enabled: on, url: state().url, token, note: 'Send the token as the HTTP header  Authorization: Bearer <token>. Anyone who can read this file can spend Flow credits through ToolFlow.' }, null, 2), { mode: 0o600 })
    chmodSync(o.file, 0o600) // the mode above only applies when the file is created
    return state()
  }
  return { state, set, close, start: async () => { if (saved().enabled) await set(true) } }
}

/** Pauses from the check before a click: nothing was sent, and a resume runs the same check again. */
const PAGE_PAUSES = ['PAGE_BLOCKED', 'TARGET_CHANGED', 'COVERED', 'CREDIT_WARNING', 'BUTTON_DISABLED', 'CHIP_MISMATCH']
type Brief = { id: string; kind: string; provider?: string; status: string; pauseReason: string | null; items: { prompt: string; attempts: { id: string; item: string; error: { code?: string } | null; outputs: string[] }[] }[] }
export type McpDeps = {
  enqueue(a: object): Promise<{ batchId?: string; batchIds?: string[]; errors?: { code: string }[] }>; start(batchId: string): Promise<unknown>; download(batchId: string): Promise<unknown>; resume(batchId: string): Promise<unknown>; pause(batchId: string): Promise<unknown> // the handlers the screens call
  preview(attemptId: string, mediaId: string, play: boolean): Promise<{ url: string | null; video?: boolean }> // the Kết quả screen's thumbnail (a video's data only on play)
  list(): Promise<{ batches: unknown[]; session: unknown }>
  file(attemptId: string, mediaId: string): string // the saved file's path; throws when it is not saved
  workflows?: { list(): Promise<{ name: string; vars: Record<string, string>; nodes: { type: string; text?: string }[] }[]>; bulk(a: object): Promise<unknown>; bulkStatus(id: string): Promise<unknown>; stopBulk(id: string): Promise<unknown>; autoSend(): Promise<boolean> } // the Workflow screen's handlers
}

/** What an agent may do: read the state, send a list of prompts with the app's default settings, read results, save them. */
export function toolsOf(d: McpDeps): Record<string, Tool> {
  const batches = async (id?: unknown): Promise<object> => ({ batches: ((await d.list()).batches as Brief[]).filter((b) => id === undefined || b.id === id).map((b) => ({
    id: b.id, kind: b.kind, status: b.status, pauseReason: b.pauseReason ?? null, hint: hintOf(b.pauseReason, b.provider),
    items: b.items.map((it, i) => { const a = it.attempts.at(-1); return { n: i + 1, prompt: it.prompt, state: a?.item ?? null, error: a?.error?.code ?? null, hint: hintOf(a?.error?.code, b.provider), files: (a?.outputs ?? []).flatMap((m) => { try { return [d.file(a!.id, m)] } catch { return [] } }) } }),
  })) })
  const str = (x: unknown): string => { if (typeof x !== 'string' || !x || x.length > 200) throw coded('INVALID_ARGS'); return x }
  const find = async (id: string): Promise<Brief> => { const b = ((await d.list()).batches as Brief[]).find((x) => x.id === id); if (!b) throw coded('NOT_FOUND'); return b }
  /** The panel's view: the newest five batches (or the named ones), each output with whether it is on disk. */
  const appState = async (ids?: unknown): Promise<object> => {
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 20)) throw coded('INVALID_ARGS')
    const all = (await d.list()).batches as Brief[], picked = ids === undefined ? all.slice(0, 5) : all.filter((b) => (ids as unknown[]).includes(b.id))
    return { batches: picked.map((b) => ({ id: b.id, kind: b.kind, site: b.provider ?? 'flow', status: b.status, pauseReason: b.pauseReason ?? null, hint: hintOf(b.pauseReason, b.provider),
      items: b.items.map((it, i) => { const a = it.attempts.at(-1); return { n: i + 1, prompt: it.prompt, state: a?.item ?? null, error: a?.error?.code ?? null, hint: hintOf(a?.error?.code, b.provider),
        outputs: (a?.outputs ?? []).map((m) => { let saved = true; try { d.file(a!.id, m) } catch { saved = false } return { attemptId: a!.id, mediaId: m, saved } }) } }) })) }
  }
  const PANEL = { ui: { resourceUri: PANEL_URI } }
  const wf = d.workflows
  const wfTools: Record<string, Tool> = !wf ? {} : {
    toolflow_list_workflows: {
      readOnly: true,
      description: 'The workflows the user saved in ToolFlow (each is one .json file in Documents\\ToolFlow\\workflows): name and the {variables} its Text nodes use, with their saved default values. Run one with toolflow_run_workflow.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        return { workflows: (await wf.list()).map((w) => ({ name: w.name, variables: [...new Set([...Object.keys(w.vars ?? {}), ...w.nodes.flatMap((n) => (n.type === 'text' ? [...(n.text ?? '').matchAll(/\{([^{}\n]+)\}/g)].map((m) => m[1].trim()) : []))])], defaults: w.vars ?? {} })) }
      },
    },
    toolflow_run_workflow: {
      description: 'Run one saved workflow many times, one whole run per input, one after another (large jobs). Give rows (each an object of {variable: value}) or, for a workflow with exactly one variable, prompts (one value per run). Every input is checked first; nothing is sent when one cannot run (errors name the row). Uses the settings saved on the workflow\'s nodes and spends the user\'s credits; when auto-send is off the user clicks Send in Flow. Returns bulkId; poll toolflow_workflow_status.',
      inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 60 }, rows: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', additionalProperties: { type: 'string', maxLength: 5000 } } }, prompts: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', maxLength: 5000 } } } },
      async run(a) {
        if ((a.rows === undefined) === (a.prompts === undefined)) throw coded('INVALID_ARGS') // exactly one of them
        return wf.bulk({ name: str(a.name), ...(a.rows !== undefined ? { rows: a.rows } : { prompts: a.prompts }), mode: (await wf.autoSend()) ? 'auto' : 'manual' })
      },
    },
    toolflow_workflow_status: {
      readOnly: true,
      description: 'Progress of a toolflow_run_workflow job: status (running / done / stopped), total runs, done, failed. The images of each run are listed by toolflow_list_batches like any batch.',
      inputSchema: { type: 'object', required: ['bulkId'], properties: { bulkId: { type: 'string' } } },
      async run(a) { const s = await wf.bulkStatus(str(a.bulkId)); if (!s) throw coded('NOT_FOUND'); return s },
    },
    toolflow_stop_workflow: {
      description: 'Stop a toolflow_run_workflow job: no new run starts and the run in flight is stopped like the Dừng button.',
      inputSchema: { type: 'object', required: ['bulkId'], properties: { bulkId: { type: 'string' } } },
      async run(a) { await wf.stopBulk(str(a.bulkId)); return { stopped: true } },
    },
  }
  return {
    ...wfTools,
    toolflow_status: {
      description: 'ToolFlow state: is Chrome connected, how many Flow tabs are in use, how many chatgpt.com / gemini.google.com tabs are open, did the self-check pass, is auto-send on (off = the user must click Send in Flow). When the self-check fails, hint is the Vietnamese line telling the user what to do.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const s = (await d.list()).session as { connected: boolean | null; tabs: { granted: boolean }[]; gptTabs?: number; gemTabs?: number; autoEnabled: boolean; selfCheck: { ok: boolean; code?: string; reasons?: string[] } | null; email: string | null }
        return { connected: s.connected !== false, /* null: the built-in test Flow, which has no Chrome to lose */ tabsInUse: s.tabs.filter((t) => t.granted).length, chatgptTabs: s.gptTabs ?? 0, geminiTabs: s.gemTabs ?? 0, selfCheckOk: !!s.selfCheck?.ok, autoSend: s.autoEnabled, account: s.email ? s.email.replace(/^(..)[^@]*/, '$1***') : null,
          ...(s.selfCheck && !s.selfCheck.ok ? { hint: checkHint({ code: s.selfCheck.code ?? '', reasons: s.selfCheck.reasons ?? [] }) } : {}) } // what the user should do, in the app's own words
      },
    },
    toolflow_create_batch: {
      meta: PANEL,
      description: 'Send prompts to Google Flow (or, with site, to the ChatGPT / Gemini tab) through ToolFlow, one result set per prompt, with the app\'s default settings (image: 2 images per prompt; video: one 8 s video, 10 Flow credits each). Spends the user\'s Flow credits. Returns batch ids; poll toolflow_list_batches.',
      inputSchema: { type: 'object', required: ['prompts'], properties: { prompts: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 5000 }, description: 'One prompt per entry, no line breaks.' }, kind: { type: 'string', enum: ['image', 'video'], default: 'image' }, site: { type: 'string', enum: ['flow', 'chatgpt', 'gemini'], default: 'flow', description: 'chatgpt / gemini: images only, one per prompt, sent in the open chatgpt.com / gemini.google.com tab and saved by the app; uses that account\'s image quota, not Flow credits.' }, aspect: { type: 'string', enum: ['1:1', '9:16', '3:4', '4:3', '16:9'], description: 'site only (gemini: its ratio menu; chatgpt: one sentence added at the end of each prompt).' }, model: { type: 'string', enum: ['Flash-Lite', 'Flash', 'Pro'], description: 'gemini only; also changes the model in the user\'s Gemini tab.' } } },
      async run(a) {
        const kind = a.kind ?? 'image', p = a.prompts, site = a.site ?? 'flow'
        if (!['flow', 'chatgpt', 'gemini'].includes(site as string) || (kind !== 'image' && kind !== 'video') || !Array.isArray(p) || !p.length || p.length > 100 || p.some((x) => typeof x !== 'string' || !x.trim() || x.length > 5000 || /[\r\n]/.test(x))) throw coded('INVALID_ARGS')
        try {
          const r = await d.enqueue({ commandId: `mcp:${randomUUID()}`, kind, mode: 'auto', text: (p as string[]).map((x) => x.trim()).join('\n'),
            ...(site !== 'flow' ? { provider: site, ...(a.aspect !== undefined ? { aspect: a.aspect } : {}), ...(a.model !== undefined ? { model: a.model } : {}) } : {}) }) // enqueue refuses a wrong mix (a video, a ratio for ChatGPT)
          if (r.errors?.length) return { errors: r.errors }
          const batchIds = r.batchIds ?? [r.batchId!]
          for (const id of batchIds) await d.start(id)
          return { batchIds }
        } catch (e) {
          // No tab, because Chrome's extension is not even connected (an old extension, Chrome closed): say that, not "pick a tab".
          if ((e as { code?: string })?.code === 'NO_PROJECT_TAB' && ((await d.list()).session as { connected: boolean | null }).connected === false) throw coded('CHROME_NOT_CONNECTED')
          throw e
        }
      },
    },
    toolflow_list_batches: {
      description: 'Batches (newest first) with each prompt\'s state, error code and the paths of its saved files. `hint` (on a batch with a pauseReason, and on an item with an error) is the Vietnamese explanation and next step the app shows the user for that code: read it instead of guessing what a code means. batchId narrows to one.',
      inputSchema: { type: 'object', properties: { batchId: { type: 'string' } } },
      run: (a) => batches(a.batchId),
    },
    toolflow_download: {
      description: 'Save every finished result of a batch to Downloads/ToolFlow, then return the batch with file paths. Generates nothing.',
      inputSchema: { type: 'object', required: ['batchId'], properties: { batchId: { type: 'string' } } },
      async run(a) { if (typeof a.batchId !== 'string' || !a.batchId) throw coded('INVALID_ARGS'); await d.download(a.batchId); return batches(a.batchId) },
    },
    toolflow_resume: {
      description: `Resume a batch paused by the Flow page (${PAGE_PAUSES.join(', ')}) after the cause is fixed; the page is checked again before any click. Any other pause (a send that may have gone out, the user's own pause) is for the user: NEEDS_USER.`,
      inputSchema: { type: 'object', required: ['batchId'], properties: { batchId: { type: 'string' } } },
      async run(a) {
        if (typeof a.batchId !== 'string' || !a.batchId) throw coded('INVALID_ARGS')
        const b = ((await d.list()).batches as Brief[]).find((x) => x.id === a.batchId)
        if (!b) throw coded('NOT_FOUND')
        if (b.status !== 'paused') throw coded('NOT_PAUSED')
        if (!PAGE_PAUSES.includes(b.pauseReason ?? '')) throw coded('NEEDS_USER')
        await d.resume(b.id)
        return batches(b.id)
      },
    },
    toolflow_panel: {
      meta: PANEL, readOnly: true,
      description: 'Show the ToolFlow panel in this chat: live progress of the newest batches (or batchId), their images and videos, and Pause / Resume / Save buttons the user can press. Use it when the user wants to see or follow their batches.',
      inputSchema: { type: 'object', properties: { batchId: { type: 'string' } } },
      run: (a) => appState(a.batchId === undefined ? undefined : [str(a.batchId)]),
    },
    toolflow_app_state: { app: true, readOnly: true, description: 'Panel: batches and their outputs.', inputSchema: { type: 'object', properties: { batchIds: { type: 'array', items: { type: 'string' }, maxItems: 20 } } }, run: (a) => appState(a.batchIds) },
    toolflow_app_preview: {
      app: true, readOnly: true, description: 'Panel: thumbnails of saved outputs; play: the one video itself.',
      inputSchema: { type: 'object', required: ['outputs'], properties: { outputs: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['attemptId', 'mediaId'], properties: { attemptId: { type: 'string' }, mediaId: { type: 'string' } } } }, play: { type: 'boolean' } } },
      async run(a) {
        const outs = a.outputs, play = a.play === true
        if (!Array.isArray(outs) || !outs.length || outs.length > 12 || (play && outs.length !== 1)) throw coded('INVALID_ARGS')
        const want = outs.map((x) => ({ attemptId: str((x as Record<string, unknown>)?.attemptId), mediaId: str((x as Record<string, unknown>)?.mediaId) }))
        return { previews: await Promise.all(want.map(async (w) => { try { return { ...w, ...(await d.preview(w.attemptId, w.mediaId, play)) } } catch { return { ...w, url: null } } })) } // not on disk (or not readable): no tile; a message could carry a path
      },
    },
    toolflow_app_control: {
      app: true, description: 'Panel: the user pressed Pause, Resume or Save on a batch (as the same buttons in the app).',
      inputSchema: { type: 'object', required: ['batchId', 'action'], properties: { batchId: { type: 'string' }, action: { type: 'string', enum: ['pause', 'resume', 'download'] } } },
      async run(a) {
        const id = str(a.batchId), act = a.action
        if (act !== 'pause' && act !== 'resume' && act !== 'download') throw coded('INVALID_ARGS')
        const b = await find(id)
        if (act === 'pause') { if (b.status !== 'running' && b.status !== 'queued') throw coded('NOT_RUNNING'); await d.pause(id) }
        else if (act === 'resume') { if (b.status !== 'paused') throw coded('NOT_PAUSED'); await d.resume(id) } // the app's own Tiếp tục: any pause, the runner re-checks the page before a click
        else await d.download(id)
        return appState([id])
      },
    },
  }
}
