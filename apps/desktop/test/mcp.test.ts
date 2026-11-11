import { test, expect } from 'vitest'
import { createMcpSwitch, rpc, startMcp, toolsOf, type Tool } from '../src/main/mcp'

const echo: Record<string, Tool> = {
  echo: { description: 'd', inputSchema: { type: 'object' }, run: async (a) => ({ got: a }) },
  boom: { description: 'd', inputSchema: { type: 'object' }, run: async () => { throw Object.assign(new Error('NO_PROJECT_TAB at /home/secret/path'), { code: 'NO_PROJECT_TAB' }) } },
}
const O = { version: '9.9.9', tools: echo }
const call = (method: string, params?: object, id: number | 'none' = 1) => rpc({ jsonrpc: '2.0', ...(id === 'none' ? {} : { id }), method, ...(params ? { params } : {}) }, O)

test('rpc: initialize, ping, tools/list and tools/call answer in MCP shapes; a notification gets no answer; anything else is a JSON-RPC error', async () => {
  expect(await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } })).toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'toolflow', version: '9.9.9' } } })
  expect(((await call('initialize', { protocolVersion: '1999-01-01' })) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-06-18') // unknown version: ours
  expect(await call('ping')).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  expect(await call('notifications/initialized', undefined, 'none')).toBeNull()
  expect(await call('tools/list')).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }, { name: 'boom', description: 'd', inputSchema: { type: 'object' } }] } })
  expect(await call('tools/call', { name: 'echo', arguments: { a: 1 } })).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"got":{"a":1}}' }] } })
  expect(await call('tools/call', { name: 'boom' })).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'NO_PROJECT_TAB' }], isError: true } }) // the code only, never the message
  expect(await call('tools/call', { name: 'nope' })).toMatchObject({ error: { code: -32602 } })
  expect(await call('resources/list')).toMatchObject({ id: 1, error: { code: -32601 } })
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
    start: async (id) => void calls.push(`start ${id}`), download: async (id) => void calls.push(`download ${id}`),
    list: async () => ({ batches: [batch], session: { connected: true, tabs: [{ granted: true }, { granted: false }], autoEnabled: true, selfCheck: { ok: true }, email: 'someone@gmail.com' } }),
    file: (a, m) => { if (m === 'm2') throw new Error('not saved'); return `/dl/${a}-${m}.mp4` },
  })
  expect(Object.keys(t)).toEqual(['toolflow_status', 'toolflow_create_batch', 'toolflow_list_batches', 'toolflow_download'])
  expect(await t.toolflow_status.run({})).toEqual({ connected: true, tabsInUse: 1, selfCheckOk: true, autoSend: true, account: 'so***@gmail.com' })
  expect(await t.toolflow_create_batch.run({ prompts: ['một con mèo', ' một con chó '], kind: 'video' })).toEqual({ batchIds: ['b1', 'b2'] })
  expect(calls[0]).toMatchObject({ kind: 'video', mode: 'auto', text: 'một con mèo\nmột con chó' })
  expect(Object.keys(calls[0] as object).sort()).toEqual(['commandId', 'kind', 'mode', 'text'])
  expect(calls.slice(1)).toEqual(['start b1', 'start b2'])
  expect(await t.toolflow_create_batch.run({ prompts: ['bad'] })).toEqual({ errors: [{ code: 'EMPTY' }] }) // nothing started
  expect(calls).toHaveLength(4)
  for (const bad of [{}, { prompts: [] }, { prompts: 'x' }, { prompts: ['a\nb'] }, { prompts: [''] }, { prompts: Array(101).fill('x') }, { prompts: ['x'], kind: 'audio' }, { prompts: ['x'.repeat(5001)] }])
    await expect(t.toolflow_create_batch.run(bad), JSON.stringify(bad).slice(0, 60)).rejects.toMatchObject({ code: 'INVALID_ARGS' })
  const brief = { id: 'b1', kind: 'video', status: 'completed', pauseReason: null, items: [{ n: 1, prompt: 'p1', state: 'ready', error: null, files: ['/dl/a1-m1.mp4'] }, { n: 2, prompt: 'p2', state: 'failed', error: 'CONTENT_BLOCKED', files: [] }] }
  expect(await t.toolflow_list_batches.run({})).toEqual({ batches: [brief] })
  expect(await t.toolflow_list_batches.run({ batchId: 'nope' })).toEqual({ batches: [] })
  expect(await t.toolflow_download.run({ batchId: 'b1' })).toEqual({ batches: [brief] })
  expect(calls.at(-1)).toBe('download b1')
  await expect(t.toolflow_download.run({})).rejects.toMatchObject({ code: 'INVALID_ARGS' })
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
  expect([on.enabled, on.url, statSync(file).mode & 0o777, on.token.length >= 32]).toEqual([true, a.state().url, 0o600, true])
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
