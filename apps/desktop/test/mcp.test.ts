import { test, expect } from 'vitest'
import { hintOf } from '../src/renderer/src/hints'
import { createMcpSwitch, rpc, startMcp, toolsOf, PANEL_URI, type Tool } from '../src/main/mcp'

const echo: Record<string, Tool> = {
  echo: { description: 'd', inputSchema: { type: 'object' }, run: async (a) => ({ got: a }) },
  boom: { description: 'd', inputSchema: { type: 'object' }, run: async () => { throw Object.assign(new Error('NO_PROJECT_TAB at /home/secret/path'), { code: 'NO_PROJECT_TAB' }) } },
}
const O = { version: '9.9.9', tools: echo }
const call = (method: string, params?: object, id: number | 'none' = 1) => rpc({ jsonrpc: '2.0', ...(id === 'none' ? {} : { id }), method, ...(params ? { params } : {}) }, O)

test('rpc: initialize, ping, tools/list and tools/call answer in MCP shapes; a notification gets no answer; anything else is a JSON-RPC error', async () => {
  expect(await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } })).toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'toolflow', version: '9.9.9' } } })
  expect(((await call('initialize', { protocolVersion: '1999-01-01' })) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-06-18') // unknown version: ours
  expect(await call('ping')).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  expect(await call('notifications/initialized', undefined, 'none')).toBeNull()
  expect(await call('tools/list')).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }, { name: 'boom', description: 'd', inputSchema: { type: 'object' } }] } })
  expect(await call('tools/call', { name: 'echo', arguments: { a: 1 } })).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"got":{"a":1}}' }] } })
  expect(await call('tools/call', { name: 'boom' })).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'NO_PROJECT_TAB: Chưa có tab dự án Flow được cấp quyền. Mở dự án Flow, vào màn Kết nối và bấm “Dùng tab này”' }], isError: true } }) // the code and the app's own line for it, never the message
  expect(await call('tools/call', { name: 'nope' })).toMatchObject({ error: { code: -32602 } })
  expect(await call('prompts/list')).toMatchObject({ id: 1, error: { code: -32601 } })
  expect(await rpc('junk', O)).toMatchObject({ id: null, error: { code: -32600 } })
})

test('http: only POST /mcp with the bearer token and no browser Origin gets in; the body is capped', async () => {
  const s = await startMcp({ token: 'tok-123', port: 0, ...O }), url = `http://127.0.0.1:${s.port}/mcp`
  const post = (headers: Record<string, string>, body: string = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }), u = url) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
  try {
    const ok = await post({ authorization: 'Bearer tok-123' })
    expect([ok.status, ok.headers.get('content-type'), await ok.json()]).toEqual([200, 'application/json', { jsonrpc: '2.0', id: 7, result: {} }])
    expect((await post({})).status).toBe(401)
    expect((await post({ authorization: 'Bearer tok-124' })).status).toBe(401)
    expect((await post({ authorization: 'Bearer tok-123', origin: 'https://evil.example' })).status).toBe(403) // a web page can reach 127.0.0.1; an MCP client sends no Origin
    expect((await post({ authorization: 'Bearer tok-123' }, undefined, url.replace('/mcp', '/other'))).status).toBe(404)
    expect((await fetch(url, { headers: { authorization: 'Bearer tok-123' } })).status).toBe(405)
    expect((await post({ authorization: 'Bearer tok-123' }, 'x'.repeat(1_100_000))).status).toBe(413)
    expect((await post({ authorization: 'Bearer tok-123' }, '{not json')).status).toBe(400)
    expect((await post({ authorization: 'Bearer tok-123' }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status).toBe(202)
  } finally { await s.close() }
  await expect(fetch(url, { method: 'POST' })).rejects.toThrow() // closed
})

test('tools: create_batch goes through the app\'s own enqueue + start in auto mode and cannot name refs or settings; batches come back short, with the saved files', async () => {
  const calls: unknown[] = []
  const batch = { id: 'b1', kind: 'video', status: 'completed', pauseReason: null, items: [
    { prompt: 'p1', attempts: [{ id: 'old', item: 'failed', error: { code: 'X' }, outputs: [] }, { id: 'a1', item: 'ready', error: null, outputs: ['m1', 'm2'] }] },
    { prompt: 'p2', attempts: [{ id: 'a2', item: 'failed', error: { code: 'CONTENT_BLOCKED' }, outputs: [] }] }] }
  const t = toolsOf({
    enqueue: async (a) => { calls.push(a); return (a as { text: string }).text === 'bad' ? { errors: [{ code: 'EMPTY' }] } : { batchIds: ['b1', 'b2'] } },
    start: async (id) => void calls.push(`start ${id}`), download: async (id) => void calls.push(`download ${id}`), resume: async () => {}, pause: async () => {}, preview: async () => ({ url: null }),
    list: async () => ({ batches: [batch], session: { connected: true, tabs: [{ granted: true }, { granted: false }], gptTabs: 1, autoEnabled: true, selfCheck: { ok: true }, email: 'someone@gmail.com' } }),
    file: (a, m) => { if (m === 'm2') throw new Error('not saved'); return `/dl/${a}-${m}.mp4` },
  })
  expect(Object.keys(t)).toEqual(['toolflow_status', 'toolflow_create_batch', 'toolflow_list_batches', 'toolflow_download', 'toolflow_resume', 'toolflow_panel', 'toolflow_app_state', 'toolflow_app_preview', 'toolflow_app_control'])
  expect(await t.toolflow_status.run({})).toEqual({ connected: true, tabsInUse: 1, chatgptTabs: 1, geminiTabs: 0, selfCheckOk: true, autoSend: true, account: 'so***@gmail.com' })
  const stale = toolsOf({ enqueue: async () => ({}), start: async () => {}, download: async () => {}, resume: async () => {}, pause: async () => {}, preview: async () => ({ url: null }), file: () => '',
    list: async () => ({ batches: [], session: { connected: true, tabs: [{ granted: true }], autoEnabled: false, selfCheck: { ok: false, code: 'CONFIG_INCOMPLETE', reasons: ['RELOAD_TAB'] }, email: null } }) })
  expect(await stale.toolflow_status.run({})).toMatchObject({ selfCheckOk: false, hint: hintOf('RELOAD_TAB') }) // the agent can tell the user what to do
  expect(await t.toolflow_create_batch.run({ prompts: ['một con mèo', ' một con chó '], kind: 'video' })).toEqual({ batchIds: ['b1', 'b2'] })
  expect(calls[0]).toMatchObject({ kind: 'video', mode: 'auto', text: 'một con mèo\nmột con chó' })
  expect(Object.keys(calls[0] as object).sort()).toEqual(['commandId', 'kind', 'mode', 'text'])
  expect(calls.slice(1)).toEqual(['start b1', 'start b2'])
  expect(await t.toolflow_create_batch.run({ prompts: ['bad'] })).toEqual({ errors: [{ code: 'EMPTY' }] }) // nothing started
  expect(calls).toHaveLength(4)
  for (const bad of [{}, { prompts: [] }, { prompts: 'x' }, { prompts: ['a\nb'] }, { prompts: [''] }, { prompts: Array(101).fill('x') }, { prompts: ['x'], kind: 'audio' }, { prompts: ['x'.repeat(5001)] }, { prompts: ['x'], site: 'grok' }, { prompts: ['x'], site: 7 }])
    await expect(t.toolflow_create_batch.run(bad), JSON.stringify(bad).slice(0, 60)).rejects.toMatchObject({ code: 'INVALID_ARGS' })
  const brief = { id: 'b1', kind: 'video', status: 'completed', pauseReason: null, items: [{ n: 1, prompt: 'p1', state: 'ready', error: null, files: ['/dl/a1-m1.mp4'] }, { n: 2, prompt: 'p2', state: 'failed', error: 'CONTENT_BLOCKED', hint: hintOf('CONTENT_BLOCKED'), files: [] }] }
  expect(await t.toolflow_list_batches.run({})).toEqual({ batches: [brief] })
  expect(await t.toolflow_list_batches.run({ batchId: 'nope' })).toEqual({ batches: [] })
  // the Vietnamese line the app shows for a code rides along as `hint` (batch pause and item error), worded for the batch's site
  const hinted = await toolsOf({ enqueue: async () => ({}), start: async () => {}, download: async () => {}, resume: async () => {}, pause: async () => {}, preview: async () => ({ url: null }), file: () => '', list: async () => ({ session: {}, batches: [{ id: 'h1', kind: 'image', provider: 'gemini', status: 'paused', pauseReason: 'GPT_NO_PLUS', items: [{ prompt: 'p', attempts: [{ id: 'a', item: 'failed', error: { code: 'PAGE_BLOCKED' }, outputs: [] }] }] }, { id: 'h2', kind: 'image', status: 'paused', pauseReason: 'PAGE_BLOCKED', items: [] }] }) }).toolflow_list_batches.run({}) as { batches: { hint?: string; items: { hint?: string }[] }[] }
  expect(hinted.batches[0].hint).toContain('Gemini')
  expect(hinted.batches[0].items[0].hint).toMatch(/tiện ích khác/)
  expect(hinted.batches[1].hint).toMatch(/tiện ích khác/)
  expect(hintOf('CONTENT_BLOCKED')).toBeTruthy()
  expect(await t.toolflow_download.run({ batchId: 'b1' })).toEqual({ batches: [brief] })
  expect(calls.at(-1)).toBe('download b1')
  await expect(t.toolflow_download.run({})).rejects.toMatchObject({ code: 'INVALID_ARGS' })
  // a chat site: named with its Gemini choices and handed to the same enqueue, which is the one that refuses a wrong mix
  const n = calls.length
  expect(await t.toolflow_create_batch.run({ prompts: ['x'], site: 'gemini', aspect: '9:16', model: 'Pro' })).toEqual({ batchIds: ['b1', 'b2'] })
  expect(calls[n]).toMatchObject({ kind: 'image', mode: 'auto', text: 'x', provider: 'gemini', aspect: '9:16', model: 'Pro' })
  await t.toolflow_create_batch.run({ prompts: ['x'], site: 'chatgpt' })
  expect(Object.keys(calls[n + 3] as object).sort()).toEqual(['commandId', 'kind', 'mode', 'provider', 'text'])
  await t.toolflow_create_batch.run({ prompts: ['x'], site: 'flow' })
  expect(Object.keys(calls[n + 6] as object).sort()).toEqual(['commandId', 'kind', 'mode', 'text'])
})

test('tools: resume lifts only a pause the page caused (re-checked before any click); a pause that needs a person stays for the user', async () => {
  const resumed: string[] = []
  const b = (id: string, status: string, pauseReason: string | null) => ({ id, kind: 'image', status, pauseReason, items: [] })
  const t = toolsOf({
    enqueue: async () => ({}), start: async () => {}, download: async () => {}, file: () => { throw new Error('x') },
    resume: async (id) => void resumed.push(id), pause: async () => {}, preview: async () => ({ url: null }),
    list: async () => ({ batches: [b('p1', 'paused', 'PAGE_BLOCKED'), b('p2', 'paused', 'COVERED'), b('u1', 'paused', 'SUBMIT_UNCERTAIN'), b('u2', 'paused', null), b('r1', 'running', null)], session: {} }),
  })
  expect(await t.toolflow_resume.run({ batchId: 'p1' })).toEqual({ batches: [{ ...b('p1', 'paused', 'PAGE_BLOCKED'), hint: hintOf('PAGE_BLOCKED') }] })
  await t.toolflow_resume.run({ batchId: 'p2' })
  expect(resumed).toEqual(['p1', 'p2'])
  for (const [a, code] of [[{ batchId: 'u1' }, 'NEEDS_USER'], [{ batchId: 'u2' }, 'NEEDS_USER'], [{ batchId: 'r1' }, 'NOT_PAUSED'], [{ batchId: 'nope' }, 'NOT_FOUND'], [{}, 'INVALID_ARGS']] as const)
    await expect(t.toolflow_resume.run(a), JSON.stringify(a)).rejects.toMatchObject({ code })
  expect(resumed).toEqual(['p1', 'p2']) // a send that may have gone out, or the user's own pause, is never lifted by an agent
})

test('switch: off by default; on writes address + token to a 0600 file and answers there; off closes it; the token and the choice survive a restart', async () => {
  const { mkdtempSync, readFileSync, statSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const file = join(mkdtempSync(join(tmpdir(), 'tf-mcp-')), 'mcp.json'), mk = () => createMcpSwitch({ file, port: 0, ...O })
  const read = () => JSON.parse(readFileSync(file, 'utf8')) as { enabled: boolean; url: string; token: string }
  const ping = (url: string, token: string) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }).then((r) => r.status)
  const a = mk()
  await a.start()
  expect(a.state()).toEqual({ enabled: false, url: null, file })
  expect((await a.set(true)).enabled).toBe(true)
  const on = read()
  expect([on.enabled, on.url, process.platform === 'win32' ? 0o600 : statSync(file).mode & 0o777, on.token.length >= 32]).toEqual([true, a.state().url, 0o600, true]) // Windows has no Unix modes: the file lives in the user's own profile folder
  expect(await ping(on.url, on.token)).toBe(200)
  expect((await a.set(false)).url).toBeNull()
  await expect(ping(on.url, on.token)).rejects.toThrow()
  expect([read().enabled, read().token]).toEqual([false, on.token])
  await a.set(true)
  await a.set(false) // "app closed" while the file says on:
  await a.set(true); const kept = read(); await a.close()
  const b = mk()
  await b.start() // a new app start: on again, same token
  expect([b.state().enabled, read().token]).toEqual([true, kept.token])
  expect(await ping(read().url, kept.token)).toBe(200)
  await b.close()
  expect(read().enabled).toBe(true) // closing the app is not the user turning it off
})

// MCP Apps (io.modelcontextprotocol/ui): Kaiser shows ToolFlow's own panel in the chat. Tools only the panel calls (the user's clicks) are
// listed and callable only on a connection that announced the UI extension, so no other agent can reach them.
const UI = { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } }
const appTools: Record<string, Tool> = {
  shown: { description: 'd', inputSchema: { type: 'object' }, meta: { ui: { resourceUri: PANEL_URI } }, readOnly: true, run: async () => ({}) },
  clicked: { description: 'd', inputSchema: { type: 'object' }, app: true, run: async () => ({ done: 1 }) },
}
test('apps: an app-only tool is hidden and refused without the UI extension; a UI tool carries _meta; the panel is a resource', async () => {
  const A = { version: '1', tools: appTools }
  const list = async (apps: boolean) => ((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, A, { apps })) as { result: { tools: { name: string; _meta?: object; annotations?: object }[] } }).result.tools
  expect((await list(false)).map((x) => x.name)).toEqual(['shown'])
  expect((await list(false))[0]).toMatchObject({ _meta: { ui: { resourceUri: PANEL_URI } }, annotations: { readOnlyHint: true } })
  expect((await list(true))[1]).toMatchObject({ name: 'clicked', _meta: { ui: { visibility: ['app'] } }, annotations: { readOnlyHint: false, destructiveHint: false } })
  expect(await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clicked' } }, A, { apps: false })).toMatchObject({ error: { code: -32602 } })
  expect(await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clicked' } }, A, { apps: true })).toMatchObject({ result: { content: [{ text: '{"done":1}' }] } })
  expect(await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, A)).toMatchObject({ result: { resources: [{ uri: PANEL_URI, mimeType: 'text/html;profile=mcp-app' }] } })
  const read = (await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: PANEL_URI } }, A)) as { result: { contents: { uri: string; mimeType: string; text: string }[] } }
  expect(read.result.contents[0]).toMatchObject({ uri: PANEL_URI, mimeType: 'text/html;profile=mcp-app' })
  expect([/'ui\/initialize'/, /'toolflow_app_state'/, /'toolflow_app_control'/].every((r) => r.test(read.result.contents[0].text))).toBe(true) // the panel speaks the bridge and asks ToolFlow for its state
  expect(await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://other' } }, A)).toMatchObject({ error: { code: -32002 } })
})

test('apps over http: only an initialize that announces the UI extension gets the session id that opens the panel tools', async () => {
  const s = await startMcp({ token: 'tok-9', port: 0, version: '1', tools: appTools }), url = `http://127.0.0.1:${s.port}/mcp`
  const post = (body: object, sid?: string) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer tok-9', 'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) })
  const names = async (sid?: string) => ((await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid)).json()) as { result: { tools: { name: string }[] } }).result.tools.map((x) => x.name)
  try {
    const plain = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
    expect(plain.headers.get('mcp-session-id')).toBeNull()
    const ui = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', ...UI } })
    const sid = ui.headers.get('mcp-session-id')!
    expect(sid).toMatch(/^[0-9a-f]{64}$/)
    expect(await names()).toEqual(['shown'])
    expect(await names('0'.repeat(64))).toEqual(['shown']) // a guessed id is no key
    expect(await names(sid)).toEqual(['shown', 'clicked'])
  } finally { await s.close() }
  const again = await startMcp({ token: 'tok-9', port: 0, version: '1', tools: appTools }) // the id is derived from the token: it survives an app restart
  try {
    const r = await fetch(`http://127.0.0.1:${again.port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer tok-9' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: UI }) })
    expect(r.headers.get('mcp-session-id')).toBeTruthy()
  } finally { await again.close() }
})

test('panel tools: state lists each output and whether it is saved; preview and control go to the screens\' own handlers, within limits', async () => {
  const calls: string[] = []
  const mk = (id: string, status: string, pauseReason: string | null = null) => ({ id, kind: 'image', status, pauseReason, items: [{ prompt: 'p', attempts: [{ id: `a-${id}`, item: 'ready', error: null, outputs: ['m1', 'm2'] }] }] })
  const t = toolsOf({
    enqueue: async () => ({}), start: async () => {}, download: async (id) => void calls.push(`download ${id}`), resume: async (id) => void calls.push(`resume ${id}`), pause: async (id) => void calls.push(`pause ${id}`),
    list: async () => ({ batches: [mk('b1', 'running'), mk('b2', 'paused', 'SUBMIT_UNCERTAIN'), ...['c', 'd', 'e', 'f', 'g'].map((x) => mk(x, 'completed'))], session: {} }),
    file: (a, m) => { if (m === 'm2') throw new Error('not saved'); return `/dl/${a}-${m}.png` },
    preview: async (a, m, play) => { calls.push(`preview ${a} ${m} ${play}`); return { url: `data:image/jpeg;base64,${m}` } },
  })
  const st = await t.toolflow_app_state.run({}) as { batches: { id: string; site: string; items: { outputs: object[] }[] }[] }
  expect(st.batches.map((b) => b.id)).toEqual(['b1', 'b2', 'c', 'd', 'e']) // the newest five
  expect(st.batches[0]).toMatchObject({ site: 'flow', status: 'running', items: [{ n: 1, prompt: 'p', state: 'ready', outputs: [{ attemptId: 'a-b1', mediaId: 'm1', saved: true }, { attemptId: 'a-b1', mediaId: 'm2', saved: false }] }] })
  expect((await t.toolflow_app_state.run({ batchIds: ['b2', 'zz'] }) as { batches: { id: string; hint: string }[] }).batches).toMatchObject([{ id: 'b2', hint: hintOf('SUBMIT_UNCERTAIN') }])
  expect(await t.toolflow_panel.run({ batchId: 'b1' })).toEqual(await t.toolflow_app_state.run({ batchIds: ['b1'] }))
  expect(await t.toolflow_app_preview.run({ outputs: [{ attemptId: 'a-b1', mediaId: 'm1' }] })).toEqual({ previews: [{ attemptId: 'a-b1', mediaId: 'm1', url: 'data:image/jpeg;base64,m1' }] })
  await t.toolflow_app_preview.run({ outputs: [{ attemptId: 'a-b1', mediaId: 'm1' }], play: true })
  expect(calls).toEqual(['preview a-b1 m1 false', 'preview a-b1 m1 true'])
  for (const bad of [{}, { outputs: [] }, { outputs: Array(13).fill({ attemptId: 'a', mediaId: 'm' }) }, { outputs: [{ attemptId: 'a', mediaId: 'm' }, { attemptId: 'a', mediaId: 'n' }], play: true }, { outputs: [{ attemptId: 7, mediaId: 'm' }] }])
    await expect(t.toolflow_app_preview.run(bad), JSON.stringify(bad).slice(0, 50)).rejects.toMatchObject({ code: 'INVALID_ARGS' })
  const gone = toolsOf({ enqueue: async () => ({}), start: async () => {}, download: async () => {}, resume: async () => {}, pause: async () => {}, list: async () => ({ batches: [], session: {} }), file: () => '', preview: async () => { throw new Error('/secret/path') } })
  expect(await gone.toolflow_app_preview.run({ outputs: [{ attemptId: 'a', mediaId: 'm' }] })).toEqual({ previews: [{ attemptId: 'a', mediaId: 'm', url: null }] }) // a file not on disk: no tile, no path
  calls.length = 0
  await t.toolflow_app_control.run({ batchId: 'b1', action: 'pause' })
  await t.toolflow_app_control.run({ batchId: 'b2', action: 'resume' }) // the user's own Tiếp tục, as in the app
  expect(await t.toolflow_app_control.run({ batchId: 'c', action: 'download' })).toMatchObject({ batches: [{ id: 'c' }] })
  expect(calls).toEqual(['pause b1', 'resume b2', 'download c'])
  for (const [a, code] of [[{ batchId: 'b1', action: 'resume' }, 'NOT_PAUSED'], [{ batchId: 'b2', action: 'pause' }, 'NOT_RUNNING'], [{ batchId: 'nope', action: 'pause' }, 'NOT_FOUND'], [{ batchId: 'b1', action: 'stop' }, 'INVALID_ARGS'], [{ action: 'pause' }, 'INVALID_ARGS']] as const)
    await expect(t.toolflow_app_control.run(a), JSON.stringify(a)).rejects.toMatchObject({ code })
  expect(t.toolflow_create_batch.meta).toEqual({ ui: { resourceUri: PANEL_URI } }) // a batch the agent starts opens the panel in the chat
  expect([t.toolflow_panel.meta, t.toolflow_panel.readOnly, t.toolflow_app_state.app, t.toolflow_app_control.app, t.toolflow_list_batches.meta]).toEqual([{ ui: { resourceUri: PANEL_URI } }, true, true, true, undefined])
})


test('create_batch with no Flow tab says whether Chrome is not connected at all, or only no tab was picked', async () => {
  const dep = (connected: boolean) => ({ enqueue: async () => { throw Object.assign(new Error('x'), { code: 'NO_PROJECT_TAB' }) }, start: async () => ({}), download: async () => ({}), resume: async () => ({}), pause: async () => ({}),
    preview: async () => ({ url: null }), list: async () => ({ batches: [], session: { connected, tabs: [], autoEnabled: false, selfCheck: null, email: null } }), file: () => { throw new Error('x') } })
  const run = async (connected: boolean) => (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'toolflow_create_batch', arguments: { prompts: ['a'] } } }, { version: '1', tools: toolsOf(dep(connected) as never) })) as { result: { content: { text: string }[] } }
  expect((await run(false)).result.content[0].text).toMatch(/^CHROME_NOT_CONNECTED: /)
  expect((await run(true)).result.content[0].text).toMatch(/^NO_PROJECT_TAB: .*Dùng tab này/)
})

test('workflow tools: list names with their {variables}; run needs exactly one of rows / prompts and sends with auto only when the user turned auto-send on', async () => {
  const calls: object[] = []
  let auto = false
  const dep = { enqueue: async () => ({}), start: async () => ({}), download: async () => ({}), resume: async () => ({}), pause: async () => ({}), preview: async () => ({ url: null }), list: async () => ({ batches: [], session: {} }), file: () => { throw new Error('x') },
    workflows: { list: async () => [{ name: 'SP', vars: { sp: 'cốc' }, nodes: [{ type: 'text', text: 'ảnh {sp} trên {nền}' }, { type: 'generate' }] }], bulk: async (a: object) => { calls.push(a); return { bulkId: 'k1', total: 2 } }, bulkStatus: async (id: string) => (id === 'k1' ? { status: 'running', total: 2, done: 1, failed: 0, batchIds: ['b1', 'b2'] } : null), stopBulk: async () => {}, autoSend: async () => auto } }
  const tools = toolsOf(dep as never)
  expect(await tools.toolflow_list_workflows.run({})).toEqual({ workflows: [{ name: 'SP', variables: ['sp', 'nền'], defaults: { sp: 'cốc' } }] })
  await expect(tools.toolflow_run_workflow.run({ name: 'SP' })).rejects.toThrow(/INVALID_ARGS/)
  await expect(tools.toolflow_run_workflow.run({ name: 'SP', rows: [{}], prompts: ['a'] })).rejects.toThrow(/INVALID_ARGS/)
  expect(await tools.toolflow_run_workflow.run({ name: 'SP', prompts: ['a', 'b'] })).toEqual({ bulkId: 'k1', total: 2 })
  auto = true
  await tools.toolflow_run_workflow.run({ name: 'SP', rows: [{ sp: 'x', 'nền': 'y' }] })
  expect(calls).toEqual([{ name: 'SP', prompts: ['a', 'b'], mode: 'manual' }, { name: 'SP', rows: [{ sp: 'x', 'nền': 'y' }], mode: 'auto' }])
  expect(await tools.toolflow_workflow_status.run({ bulkId: 'k1' })).toMatchObject({ done: 1 })
  await expect(tools.toolflow_workflow_status.run({ bulkId: 'nope' })).rejects.toThrow(/NOT_FOUND/)
  // the panel follows the job: its batches so far, and while it runs the panel keeps asking by bulkId (later runs add batches)
  expect(await tools.toolflow_panel.run({ bulkId: 'k1' })).toEqual({ ...((await tools.toolflow_app_state.run({ batchIds: ['b1', 'b2'] })) as object), bulkId: 'k1', bulkRunning: true })
  expect(await tools.toolflow_app_state.run({ bulkId: 'k1' })).toEqual(await tools.toolflow_panel.run({ bulkId: 'k1' }))
  await expect(tools.toolflow_panel.run({ bulkId: 'nope' })).rejects.toThrow(/NOT_FOUND/)
})
