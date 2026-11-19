import { describe, expect, it, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMcp } from '../src/main/mcp'
import { createWebUi, uiTicket } from '../src/main/web-ui'

const TOKEN = 'a'.repeat(64)
const dir = mkdtempSync(join(tmpdir(), 'tf-webui-'))
mkdirSync(join(dir, 'assets'))
writeFileSync(join(dir, 'index.html'), '<!doctype html><head><script type="module" src="./assets/app.js"></script></head><body></body>')
writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')

let stop: (() => Promise<void>) | null = null
afterEach(async () => { await stop?.(); stop = null })

async function serve(handlers: Record<string, (a: never) => unknown> = { listBatches: () => [{ id: 'b1' }], failing: () => { throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }) } }) {
  const ui = createWebUi({ token: TOKEN, rendererDir: dir, handlers })
  const s = await startMcp({ version: '1', tools: {}, token: TOKEN, port: 0, ui: ui.handle })
  stop = s.close
  const base = `http://127.0.0.1:${s.port}`
  const open = async (): Promise<string> => {
    const r = await fetch(`${base}/app/open?t=${uiTicket(TOKEN, Date.now() + 60_000)}`, { redirect: 'manual' })
    expect(r.status).toBe(302)
    return (r.headers.get('set-cookie') ?? '').split(';')[0]
  }
  return { ui, base, open }
}

describe('ToolFlow screens over http (inside another app)', () => {
  it('opens only with a fresh ticket made from the MCP key, then serves the screens with the bridge first', async () => {
    const { base, open } = await serve()
    expect((await fetch(`${base}/app/`)).status).toBe(401)
    expect((await fetch(`${base}/app/open?t=${uiTicket('b'.repeat(64), Date.now() + 60_000)}`, { redirect: 'manual' })).status).toBe(401)
    expect((await fetch(`${base}/app/open?t=${uiTicket(TOKEN, Date.now() - 1)}`, { redirect: 'manual' })).status).toBe(401)
    const cookie = await open()
    const html = await (await fetch(`${base}/app/`, { headers: { cookie } })).text()
    expect(html.indexOf('./bridge.js')).toBeGreaterThan(-1)
    expect(html.indexOf('./bridge.js')).toBeLessThan(html.indexOf('./assets/app.js'))
    expect(await (await fetch(`${base}/app/assets/app.js`, { headers: { cookie } })).text()).toBe('console.log(1)')
    expect((await fetch(`${base}/app/assets/..%2f..%2fpackage.json`, { headers: { cookie } })).status).toBe(404)
  })

  it('calls the same handlers the window calls, only from its own page', async () => {
    const { base, open } = await serve()
    const cookie = await open()
    const post = (ch: string, headers: Record<string, string>) => fetch(`${base}/app/rpc/${ch}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify({ arg: null }) })
    const own = { origin: base, 'x-toolflow-ui': '1' }
    expect(await (await post('listBatches', own)).json()).toEqual({ ok: true, value: [{ id: 'b1' }] })
    expect(await (await post('failing', own)).json()).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect((await post('nope', own)).status).toBe(404)
    expect((await post('listBatches', { origin: 'http://evil.example', 'x-toolflow-ui': '1' })).status).toBe(403)
    expect((await post('listBatches', { origin: base })).status).toBe(403)
  })

  it('pushes the window\'s events to the page', async () => {
    const { ui, base, open } = await serve()
    const cookie = await open()
    const res = await fetch(`${base}/app/events`, { headers: { cookie } })
    const reader = res.body!.getReader()
    await new Promise((r) => setTimeout(r, 50))
    ui.push('state', { entity: 'batch', id: 'b1', revision: 2 })
    let text = ''
    while (!text.includes('data:')) text += new TextDecoder().decode((await reader.read()).value)
    expect(text).toContain('data: {"type":"state","data":{"entity":"batch","id":"b1","revision":2}}')
    await reader.cancel()
  })

  it('still refuses a browser page on /mcp', async () => {
    const { base } = await serve()
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { origin: base, authorization: `Bearer ${TOKEN}` }, body: '{}' })).status).toBe(403)
    expect(createHmac('sha256', TOKEN).update('x').digest('hex')).toHaveLength(64)
  })
})
