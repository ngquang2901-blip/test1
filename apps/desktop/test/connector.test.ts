import { test, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { startConnectorServer, OP_TIMEOUT_MS } from '../src/main/connector/server'
import { createServer } from 'node:net'
import { installExtension, readOrCreateToken } from '../src/main/connector/pairing'
import { createExtDriver } from '../src/main/connector/ext-driver'
import { EXT_ID } from '../src/main/connector/ext-id'
import { ConnectorError, type DriverEvent } from '../src/main/driver'

const TOKEN = 'ab'.repeat(32)
const ORIGIN = `chrome-extension://${EXT_ID}`
const closers: Array<() => unknown> = []
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c() })

const boot = async () => {
  const s = await startConnectorServer({ token: TOKEN, extensionId: EXT_ID })
  closers.push(() => s.close())
  return s
}
type Client = { ws: WebSocket; msgs: any[]; closed: Promise<number>; next(): Promise<any> }
const connect = async (port: number, o: { token?: string; origin?: string | null; query?: boolean; inst?: string } = {}): Promise<Client> => {
  const headers = o.origin === null ? {} : { Origin: o.origin ?? ORIGIN }
  const ws = o.query // the old pairing style: token in the URL
    ? new WebSocket(`ws://127.0.0.1:${port}/?token=${o.token ?? TOKEN}`, ['toolflow.v1'], { headers })
    : new WebSocket(`ws://127.0.0.1:${port}/`, ['toolflow.v1', `tf.${o.token ?? TOKEN}`, ...(o.inst ? [`tfi.${o.inst}`] : [])], { headers })
  const msgs: any[] = []
  const waiters: Array<(m: any) => void> = []
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); if (w) w(m); else msgs.push(m) })
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)))
  ws.on('error', () => {})
  await new Promise((r) => { ws.once('open', r); ws.once('close', r) })
  closers.push(() => ws.terminate())
  return { ws, msgs, closed, next: () => (msgs.length ? Promise.resolve(msgs.shift()) : new Promise((r) => waiters.push(r))) }
}
const tick = () => new Promise((r) => setTimeout(r, 20))

test('rejects wrong token', async () => {
  const s = await boot()
  expect(await (await connect(s.port, { token: 'cd'.repeat(32) })).closed).toBe(4401)
  expect(await (await connect(s.port, { token: 'x' })).closed).toBe(4401)
  expect(await (await connect(s.port, { query: true })).closed).toBe(4401) // a right token in the URL is not accepted: only the subprotocol carries it
})
test('rejects wrong origin', async () => {
  const s = await boot()
  expect(await (await connect(s.port, { origin: 'chrome-extension://' + 'a'.repeat(32) })).closed).toBe(4401)
  expect(await (await connect(s.port, { origin: 'https://evil.example' })).closed).toBe(4401)
})
test('rejects missing origin', async () => {
  const s = await boot()
  expect(await (await connect(s.port, { origin: null })).closed).toBe(4401)
})
test('listen failure rejects instead of hanging', async () => {
  const blocker = createServer()
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
  closers.push(() => new Promise((r) => blocker.close(r)))
  const port = (blocker.address() as { port: number }).port
  await expect(startConnectorServer({ token: TOKEN, extensionId: EXT_ID, port })).rejects.toThrow()
})
test('server listens on loopback only', async () => {
  const s = await boot()
  expect(s.address().address).toBe('127.0.0.1')
})
test('send with no connection rejects ConnectorError', async () => {
  const s = await boot()
  await expect(s.send('ping', { tabId: 1 })).rejects.toBeInstanceOf(ConnectorError)
})
test('ordinary round trip: id and connection epoch echoed', async () => {
  const s = await boot()
  const c = await connect(s.port)
  const p = s.send('state', { tabId: 7 })
  const m = await c.next()
  expect(m).toMatchObject({ op: 'state', args: { tabId: 7 }, epoch: s.epoch() })
  c.ws.send(JSON.stringify({ id: m.id, epoch: m.epoch, ok: true, result: { x: 1 } }))
  expect(await p).toEqual({ x: 1 })
  const q = s.send('state', { tabId: 7 })
  const m2 = await c.next()
  c.ws.send(JSON.stringify({ id: m2.id, epoch: m2.epoch, ok: false, error: 'boom' }))
  await expect(q).rejects.toThrow('boom')
  await expect(q).rejects.toMatchObject({ code: 'EXTENSION_REFUSED' })
})
test('newest connection wins: old closed, epoch up, pending of old rejects, late old reply ignored', async () => {
  const s = await boot()
  const events: DriverEvent[] = []
  s.onEvent((e) => events.push(e))
  const c1 = await connect(s.port)
  const e1 = s.epoch()
  const old = s.send('state', { tabId: 5 })
  const oldRejected = expect(old).rejects.toBeInstanceOf(ConnectorError)
  const oldMsg = await c1.next()
  ;(c1.ws as any)._socket.pause() // keep the old client unaware of the close so its late reply really reaches the server
  const c2 = await connect(s.port)
  expect(s.epoch()).toBe(e1 + 1)
  await oldRejected
  const fresh = s.send('state', { tabId: 5 })
  const m = await c2.next()
  expect(m.id).not.toBe(oldMsg.id)
  // old socket (already closing) tries to answer the new call's id and the old one: both must be ignored
  c1.ws.send(JSON.stringify({ id: m.id, epoch: m.epoch, ok: true, result: 'evil' }))
  await tick()
  c2.ws.send(JSON.stringify({ id: m.id, epoch: m.epoch, ok: true, result: 'good' }))
  expect(await fresh).toBe('good')
  ;(c1.ws as any)._socket.resume()
  await c1.closed
  expect(events).toEqual([{ type: 'disconnected', tabId: '5' }])
})
test('reply with unknown id is dropped; keepalive ignored', async () => {
  const s = await boot()
  const events: DriverEvent[] = []
  s.onEvent((e) => events.push(e))
  const c = await connect(s.port)
  c.ws.send(JSON.stringify({ id: 9999, ok: true, result: 1 }))
  c.ws.send(JSON.stringify({ keepalive: Date.now() }))
  c.ws.send('not json')
  await tick()
  expect(events).toEqual([])
  const p = s.send('state', { tabId: 1 })
  const m = await c.next()
  c.ws.send(JSON.stringify({ id: m.id, epoch: m.epoch, ok: true, result: 'still fine' }))
  expect(await p).toBe('still fine')
})
test('sent/response events pass through unchanged; disconnected once per addressed or seen tab', async () => {
  const s = await boot()
  const events: DriverEvent[] = []
  s.onEvent((e) => events.push(e))
  const c = await connect(s.port)
  const sent = { type: 'sent', tabId: 3, epoch: 42, request: 'f.req=x' }
  const resp = { type: 'response', tabId: 3, epoch: 42, rpc: 'r', text: 't', request: 'f.req=x' }
  c.ws.send(JSON.stringify(sent))
  c.ws.send(JSON.stringify(resp))
  void s.send('state', { tabId: 8 }).catch(() => {})
  await tick()
  expect(events).toEqual([{ ...sent, tabId: '3' }, { ...resp, tabId: '3' }])
  c.ws.close()
  await c.closed
  await tick()
  const gone = events.slice(2)
  expect(gone).toHaveLength(2)
  expect(gone).toEqual(expect.arrayContaining([{ type: 'disconnected', tabId: '3' }, { type: 'disconnected', tabId: '8' }]))
  await tick()
  expect(events).toHaveLength(4)
})
test('ext-driver: click puts runner epoch in msg.epoch, arm in args.epoch; ping merges account email', async () => {
  const s = await boot()
  const c = await connect(s.port)
  const d = createExtDriver(s, { allow: () => true })
  const CLICK = { found: true, disabled: false, listeners: 1, called: 1 }
  const click = d.click('11', 777)
  const m = await c.next()
  expect(m).toMatchObject({ op: 'trusted', epoch: 777, args: { tabId: 11 } })
  expect(m.epoch).not.toBe(s.epoch())
  c.ws.send(JSON.stringify({ id: m.id, epoch: m.epoch, ok: true, result: CLICK }))
  expect(await click).toEqual(CLICK)
  const arm = d.arm('11', 5)
  const a = await c.next()
  expect(a).toMatchObject({ op: 'arm', epoch: s.epoch(), args: { tabId: 11, epoch: 5 } })
  c.ws.send(JSON.stringify({ id: a.id, epoch: a.epoch, ok: true, result: true }))
  await arm
  const ping = d.ping('11')
  const p = await c.next()
  expect(p.op).toBe('ping')
  c.ws.send(JSON.stringify({ id: p.id, epoch: p.epoch, ok: true, result: { version: '0.1.0', seq: 1 } }))
  const acc = await c.next()
  expect(acc.op).toBe('account')
  c.ws.send(JSON.stringify({ id: acc.id, epoch: acc.epoch, ok: true, result: 'a@b.c' }))
  expect(await ping).toMatchObject({ version: '0.1.0', email: 'a@b.c' })
})
test('ext-driver: readProject is not implemented yet (fails closed)', async () => {
  const d = createExtDriver(await boot())
  await expect(d.readProject('p')).rejects.toThrow()
})
test('ext-driver: disconnect reaches onEvent subscribers', async () => {
  const s = await boot()
  const got: DriverEvent[] = []
  createExtDriver(s).onEvent((e) => got.push(e))
  const c = await connect(s.port)
  void s.send('state', { tabId: 2 }).catch(() => {})
  await tick()
  c.ws.close()
  await c.closed
  await tick()
  expect(got).toEqual([{ type: 'disconnected', tabId: '2' }])
})
test('token never appears in errors or console output', async () => {
  const logs: string[] = []
  const spies = (['log', 'error', 'warn', 'info'] as const).map((k) => { const o = console[k]; console[k] = (...a: unknown[]) => void logs.push(a.join(' ')); return () => { console[k] = o } })
  try {
    const s = await boot()
    const bad = await connect(s.port, { token: 'cd'.repeat(32) })
    await bad.closed
    const errs: string[] = []
    await s.send('ping', { tabId: 1 }).catch((e) => errs.push(String(e), e.stack ?? ''))
    const c = await connect(s.port)
    const p = s.send('ping', { tabId: 1 }).catch((e) => errs.push(String(e)))
    await c.next()
    c.ws.terminate()
    await p
    expect([...errs, ...logs].join('\n')).not.toContain(TOKEN)
    expect(errs.length).toBeGreaterThan(0)
  } finally { spies.forEach((f) => f()) }
})
test('ext id from key is 32 [a-p] chars and matches an independent computation', () => {
  expect(EXT_ID).toMatch(/^[a-p]{32}$/)
  const key = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8')).key
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  expect([...hex].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('')).toBe(EXT_ID)
})
test('install keeps token across updates, overwrites files, rewrites port, 0600', () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-pair-'))
  closers.push(() => rmSync(root, { recursive: true, force: true }))
  const bundled = join(root, 'bundled')
  mkdirSync(bundled)
  writeFileSync(join(bundled, 'sw.js'), 'v1')
  const a = installExtension(bundled, join(root, 'ud'), 1111)
  expect(a.token).toMatch(/^[0-9a-f]{64}$/)
  writeFileSync(join(a.dir, 'sw.js'), 'tampered')
  writeFileSync(join(bundled, 'sw.js'), 'v2')
  const b = installExtension(bundled, join(root, 'ud'), 2222)
  expect(b.token).toBe(a.token)
  expect(readFileSync(join(b.dir, 'sw.js'), 'utf8')).toBe('v2')
  expect(JSON.parse(readFileSync(join(b.dir, 'pair.json'), 'utf8'))).toEqual({ port: 2222, token: a.token })
  if (process.platform !== 'win32') expect(statSync(join(b.dir, 'pair.json')).mode & 0o777).toBe(0o600)
})
test('the installed extension carries the app version (so a stale copy in Chrome fails the self-check); bad versions are not written', () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-ver-'))
  const bundled = join(root, 'b')
  mkdirSync(bundled)
  writeFileSync(join(bundled, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'ToolFlow Connector', version: '0.1.0' }))
  const mf = (d: string) => JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'))
  const a = installExtension(bundled, join(root, 'ud'), 1111, '0.5.1')
  expect([a.version, mf(a.dir).version, mf(a.dir).name]).toEqual(['0.5.1', '0.5.1', 'ToolFlow Connector'])
  expect(mf(bundled).version).toBe('0.1.0') // the bundled source is never touched
  expect(installExtension(bundled, join(root, 'ud'), 1111, '0.6.0-beta.1').version).toBe('0.1.0') // not a Chrome version: keep the file's
  expect(installExtension(bundled, join(root, 'ud'), 1111).version).toBe('0.1.0')
})
test('first run: one persisted token shared by server and pair.json; stable on repeat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-pair-'))
  closers.push(() => rmSync(root, { recursive: true, force: true }))
  const bundled = join(root, 'bundled')
  mkdirSync(bundled)
  writeFileSync(join(bundled, 'sw.js'), 'v1')
  const ud = join(root, 'ud')
  const token = readOrCreateToken(ud)
  expect(readOrCreateToken(ud)).toBe(token)
  const s = await startConnectorServer({ token, extensionId: EXT_ID })
  closers.push(() => s.close())
  const { dir } = installExtension(bundled, ud, s.port)
  expect(JSON.parse(readFileSync(join(dir, 'pair.json'), 'utf8')).token).toBe(token)
  expect(await Promise.race([connect(s.port, { token }).then((c) => c.closed.then(() => 'closed'), () => 'x'), tick().then(() => 'open')])).toBe('open')
  writeFileSync(join(dir, 'pair.json'), '{corrupt')
  const t2 = readOrCreateToken(ud)
  expect(t2).toMatch(/^[0-9a-f]{64}$/)
  expect(readOrCreateToken(ud)).toBe(t2)
  if (process.platform !== 'win32') expect(statSync(join(dir, 'pair.json')).mode & 0o777).toBe(0o600)
})

test('listTabs composes tabs + account (no content script ⇒ email null); only a granted tab ever receives trusted/arm', async () => {
  const s = await boot()
  const c = await connect(s.port)
  const U = (n: number) => `0b4d3c1e-1111-4222-8333-44445555666${n}`
  const answer = async () => {
    const seen: any[] = []
    c.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); seen.push(m)
      const reply = (r: unknown, ok = true) => c.ws.send(JSON.stringify({ id: m.id, epoch: m.epoch, ...(ok ? { ok, result: r } : { ok, error: r }) }))
      if (m.op === 'tabs') reply([{ tabId: 1, path: '/fx/tools/flow', active: true }, { tabId: 2, path: `/fx/tools/flow/project/${U(1)}`, active: false }, { tabId: 3, path: `/fx/tools/flow/project/${U(2)}`, active: false }])
      else if (m.op === 'account') m.args.tabId === 3 ? reply('no content script in tab', false) : reply(`u${m.args.tabId}@x.y`)
      else reply(true)
    })
    return seen
  }
  const seen = await answer()
  const d = createExtDriver(s, { allow: (t) => t === '2' })
  expect(await d.listTabs()).toEqual([
    { tabId: '1', projectId: null, email: 'u1@x.y', active: true },
    { tabId: '2', projectId: U(1), email: 'u2@x.y', active: false },
    { tabId: '3', projectId: U(2), email: null, active: false },
  ])
  seen.length = 0
  for (const t of ['1', '2', '3']) {
    await d.click(t, 5).catch(() => {})
    await d.arm(t, 5).catch(() => {})
    await d.prepare(t, { prompt: 'p', kind: 'image', settings: {}, refIds: [] }).catch(() => {})
  }
  expect(seen.map((m) => [m.op, m.args.tabId])).toEqual([['trusted', 2], ['arm', 2]])
  await d.focusTab('3') // focus is not a trusted op: no grant needed (the user may need to see any tab)
  expect(seen.at(-1)).toMatchObject({ op: 'focus', args: { tabId: 3 } })
})

test('per-op budgets: table values, and each op times out on its own budget', async () => {
  expect(OP_TIMEOUT_MS).toMatchObject({ ping: 3000, account: 3000, state: 5000, hit: 5000, probe: 5000, tabs: 5000, focus: 5000, net: 5000, arm: 5000, trusted: 5000, settings: 20000, prep: 20000, file: 60000, default: 30000 })
  const s = await startConnectorServer({ token: TOKEN, extensionId: EXT_ID, budgets: { ping: 30, state: 400, default: 700 } })
  closers.push(() => s.close())
  const c = await connect(s.port) // never answers by itself
  const t0 = Date.now()
  const state = s.send('state', { tabId: 1 })
  await expect(s.send('ping', { tabId: 1 })).rejects.toThrow('extension did not answer')
  expect(Date.now() - t0).toBeLessThan(300)
  const m = await c.next()
  c.ws.send(JSON.stringify({ id: m.id, epoch: m.epoch, ok: true, result: 'late but in budget' }))
  expect(await state).toBe('late but in budget')
  const t1 = Date.now()
  await expect(s.send('whatever', {})).rejects.toThrow('extension did not answer')
  expect(Date.now() - t1).toBeGreaterThanOrEqual(600) // unlisted op: the default budget
})
test('ext-driver: without an allow option no page-acting op reaches any tab', async () => {
  const s = await boot()
  const c = await connect(s.port)
  const d = createExtDriver(s)
  await expect(d.click('1', 5)).rejects.toThrow('tab not granted')
  await expect(d.arm('1', 5)).rejects.toThrow('tab not granted')
  await expect(d.arm('1', null)).rejects.toThrow('tab not granted')
  await expect(d.prepare('1', { prompt: 'p', kind: 'image', settings: { combo: {} }, refIds: [] })).rejects.toThrow('tab not granted')
  await expect(d.checkBeforeClick('1', 'p')).rejects.toThrow('tab not granted')
  await tick()
  expect(c.msgs).toEqual([])
})

test('several Chrome profiles: both stay connected; tabs merged and namespaced; a tab op reaches only its owner; one leaving drops only its tabs', async () => {
  const s = await boot()
  const events: DriverEvent[] = []
  s.onEvent((e) => events.push(e))
  const a = await connect(s.port, { inst: 'aaaa0001' })
  const b = await connect(s.port, { inst: 'bbbb0002' })
  const answer = async (c: Client, result: (m: any) => unknown) => { const m = await c.next(); c.ws.send(JSON.stringify({ id: m.id, epoch: m.epoch, ok: true, result: result(m) })); return m }
  const tabs = s.send('tabs', {})
  await Promise.all([answer(a, () => [{ tabId: 5, path: '/a' }]), answer(b, () => [{ tabId: 5, path: '/b' }])]) // the same Chrome tab id in two profiles
  expect(await tabs).toEqual([{ tabId: 'aaaa0001:5', path: '/a' }, { tabId: 'bbbb0002:5', path: '/b' }])
  const st = s.send('state', { tabId: 'bbbb0002:5' })
  const m = await answer(b, () => 'from b')
  expect(m.args).toEqual({ tabId: 5 }) // the extension sees its own numeric id
  expect(await st).toBe('from b')
  expect(a.msgs).toEqual([]) // profile a never saw it
  await expect(s.send('focus', { tabId: 'cccc0003:1' })).rejects.toBeInstanceOf(ConnectorError) // unknown profile
  await expect(s.send('open', {})).rejects.toBeInstanceOf(ConnectorError) // a tab-less op that is not a broadcast is ambiguous
  b.ws.send(JSON.stringify({ type: 'sent', tabId: 5, epoch: 1, request: 'x' }))
  await tick()
  expect(events).toEqual([{ type: 'sent', tabId: 'bbbb0002:5', epoch: 1, request: 'x' }])
  b.ws.close(); await b.closed; await tick()
  expect(events.slice(1)).toEqual([{ type: 'disconnected', tabId: 'bbbb0002:5' }])
  expect(s.connected()).toBe(true) // a is still there
  const again = s.send('state', { tabId: 'aaaa0001:5' })
  await answer(a, () => 'a ok')
  expect(await again).toBe('a ok')
  const a2 = await connect(s.port, { inst: 'aaaa0001' }) // the same profile reconnecting replaces itself
  expect(await a.closed).toBe(4000)
  void a2
})

test('downloads ask every profile; a profile that does not answer is left out, all failing is an error', async () => {
  const s = await startConnectorServer({ token: TOKEN, extensionId: EXT_ID, budgets: { downloads: 200 } })
  closers.push(() => s.close())
  const a = await connect(s.port, { inst: 'aaaa0001' })
  const b = await connect(s.port, { inst: 'bbbb0002' })
  const p = s.send('downloads', { filenamePrefix: 'x' })
  const m = await a.next()
  a.ws.send(JSON.stringify({ id: m.id, epoch: m.epoch, ok: true, result: [{ id: 3, filename: '/t/x_1.png' }] }))
  expect(await p).toEqual([{ id: 3, filename: '/t/x_1.png' }]) // b stayed silent until its budget
  void b
  const q = s.send('downloads', { id: 3 })
  await expect(q).rejects.toBeInstanceOf(ConnectorError)
})

test('onConnect fires once per accepted extension connection, never for a refused one (the app lists tabs at once to pick the remembered ones again)', async () => {
  let n = 0
  const s = await startConnectorServer({ token: TOKEN, extensionId: EXT_ID, onConnect: () => { n++ } })
  closers.push(() => s.close())
  expect(await (await connect(s.port, { token: 'cd'.repeat(32) })).closed).toBe(4401)
  expect(n).toBe(0)
  await connect(s.port, { inst: '0123abcd' })
  await tick()
  expect(n).toBe(1)
})
