// Read-only live probe: pairs with the real Chrome extension and reports what the Flow tabs look like.
// Never clicks, fills or sends anything on the page. Prints no URLs/tokens; the account email is masked.
// Run: npm run live-probe -w apps/desktop   (stop the app first: only one process may own the pairing port)
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { startConnectorServer } from '../src/main/connector/server'
import { installExtension, readOrCreateToken } from '../src/main/connector/pairing'
import { EXT_ID } from '../src/main/connector/ext-id'
import flow from '../profiles/flow.json'
import { correlate, parseGenerateRequest, parseImageReceipt, parseRpcResponse, readFReq } from '@toolflow/flow-protocol/parse'

const userData = process.env.TOOLFLOW_USER_DATA ?? join(homedir(), '.local/share/toolflow-live')
const mask = (e: unknown): string => (typeof e === 'string' ? e.replace(/^(.{2}).*(@.*)$/, '$1***$2') : String(e))
const PROMPT = process.env.PROMPT ?? 'a single yellow lemon on a blue plate'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const server = await startConnectorServer({ token: readOrCreateToken(userData), extensionId: EXT_ID })
installExtension(resolve(process.cwd(), '../extension'), userData, server.port) // run via npm from apps/desktop
console.log('listening; waiting for the extension to (re)connect (it retries every 30 s)')
for (let i = 0; i < 40 && !server.connected(); i++) await sleep(3000)
if (!server.connected()) { console.log('RESULT: extension never connected'); process.exit(1) }
console.log('extension connected')

type Tab = { tabId: number; active: boolean; path: string; status: string }
// Wait (up to 6 min) until the extension runs the NEW code (tabs op exists) and a Flow tab has our page hooks (needs F5 after the extension reload).
let tabs: Tab[] = []
const t0 = Date.now()
for (let note = ''; Date.now() - t0 < 360_000; await sleep(4000)) {
  let why = ''
  try {
    tabs = (await server.send('tabs', {})) as Tab[]
    if (!tabs.length) why = 'no Flow tab open (https://flow.google.com/...)'
    else {
      const p = (await server.send('ping', { tabId: tabs[0].tabId }).catch(() => null)) as { version?: string } | null
      if (p?.version) break
      why = 'Flow tab has no ToolFlow hooks yet: reload the tab (F5)'
    }
  } catch (e) { why = `extension runs old code or is away (${(e as Error).message}): reload it on chrome://extensions` }
  if (why !== note) { console.log('waiting:', why); note = why }
}
console.log(`flow tabs: ${tabs.length}`)
for (const t of tabs) {
  const a = { tabId: t.tabId }
  const step = async (name: string, f: () => Promise<unknown>): Promise<unknown> => {
    try { return await f() } catch (e) { console.log(`  ${name}: ERROR ${(e as Error).message}`); return undefined }
  }
  console.log(`- tab ${t.tabId} active=${t.active} status=${t.status} path=${t.path.replace(/[0-9a-f-]{20,}/g, '<id>')}`)
  const ping = (await step('ping', () => server.send('ping', a))) as Record<string, unknown> | undefined
  if (ping) console.log(`  hooks: xhrSend=${ping.xhrSend} xhrOpen=${ping.xhrOpen} fetch=${ping.fetch} gen=${ping.gen} dropped=${ping.dropped} version=${ping.version || '(none)'}`)
  console.log(`  account: ${mask(await step('account', () => server.send('account', a)))}`)
  const pr = (await step('probe', () => server.send('probe', { ...a, selectors: flow.selectors }))) as { present: Record<string, boolean> } | undefined
  if (pr) console.log('  selectors present:', Object.entries(pr.present).map(([k, v]) => `${k}=${v}`).join(' '), '| selfCheck needs:', flow.selfCheck.join('+'))
  console.log('  submit hit-test:', JSON.stringify(await step('hit', () => server.send('hit', a))))
  const net = (await step('net', () => server.send('net', a))) as { rpc: string; via: string; status: number; res: string }[] | undefined
  if (net) {
    const by: Record<string, number> = {}
    for (const r of net) { const k = `${r.rpc}/${r.via ?? '?'}/${r.status}`; by[k] = (by[k] ?? 0) + 1 }
    console.log('  rpc seen since page load (rpc/transport/status: count):', JSON.stringify(by))
  }
}
// FOCUS=1: bring the first Flow tab to the front (op `focus`), like manual mode does before arming.
if (process.env.FOCUS === '1' && tabs[0]) console.log('focus:', JSON.stringify(await server.send('focus', { tabId: tabs[0].tabId })))
// WATCH_MIN=n: keep watching n minutes and print every RPC the page makes (rpc/transport/status/size) and gen changes, so one manual generate shows which transport carries it.
const watchMin = Number(process.env.WATCH_MIN ?? 0)
if (watchMin > 0 && tabs[0]) {
  console.log(`watching tab ${tabs[0].tabId} for ${watchMin} min: generate once by hand (read-only, nothing is clicked by us)`)
  let lastGen = -1
  // ARM=1: act like the manual-mode runner: arm the tab with an epoch, then the user's own send must come back as events with that epoch.
  const armEpoch = process.env.ARM === '1' ? Date.now() : null
  // AUTO=1: act like the auto runner: fill the composer (prep, never submits), then our own trusted click with a fresh epoch. Needs an empty composer.
  const autoEpoch = process.env.AUTO === '1' && armEpoch === null ? Date.now() : null
  // Parse the live traffic with the product parser, in memory only; print structure facts, never ids/urls/bodies.
  let liveReq: ReturnType<typeof parseGenerateRequest> | undefined
  const check = (e: { type: string; request?: unknown; text?: string; rpc?: string }): void => {
    try {
      if (e.type === 'sent') {
        liveReq = parseGenerateRequest(readFReq(e.request as string))
        console.log(`  parse request OK: rpc=${liveReq.rpc} items=${liveReq.items.length} batchId=uuid prompt0Matches=${liveReq.items[0].prompt === PROMPT} aspect=${liveReq.items[0].aspectCode} seedInt=${Number.isInteger(liveReq.items[0].seed)}`)
      } else if (e.type === 'response' && liveReq) {
        const r = parseRpcResponse(e.text ?? '', e.rpc ?? '') as { error?: unknown; payload?: unknown }
        if (r.error) { console.log('  response is an error:', JSON.stringify(r.error)); return }
        const rc = parseImageReceipt(r.payload) as { batchId: string; outputs: unknown[] }
        const c = correlate(liveReq, rc as never) as { owned: boolean; reason?: string; outputs?: unknown[] }
        console.log(`  parse response OK: outputs=${rc.outputs.length} correlate owned=${c.owned}${c.reason ? ' reason=' + c.reason : ''} batchMatches=${rc.batchId === liveReq.batchId}`)
      }
    } catch (err) { console.log('  PARSE FAILED:', (err as Error).message.slice(0, 160)) }
  }
  server.onEvent((e) => { if ((e.type === 'sent' || e.type === 'response') && ('epoch' in e)) check(e) })
  server.onEvent((e) => console.log(`${new Date().toISOString().slice(11, 19)} EVENT ${e.type} tab=${e.tabId}` + ('epoch' in e ? ` epoch=${e.epoch === armEpoch || e.epoch === autoEpoch ? 'OURS' : e.epoch}` : '') + ('rpc' in e ? ` rpc=${e.rpc} text=${e.text.length}B` : '') + ('request' in e ? ` request=${String(e.request).length}B` : '')))
  if (armEpoch !== null) { await server.send('arm', { tabId: tabs[0].tabId, epoch: armEpoch }); console.log('armed (manual mode): now send ONE generate in Flow') }
  if (autoEpoch !== null) {
    const a = { tabId: tabs[0].tabId }
    const st = (await server.send('state', a)) as { text: string | null }
    if (st.text) console.log('AUTO aborted: composer is not empty')
    else {
      const prep = (await server.send('prep', { ...a, prompt: PROMPT })) as { ok: boolean; textMatches: boolean; submitDisabled: boolean | null }
      console.log(`prep: ok=${prep.ok} textMatches=${prep.textMatches} submitDisabled=${prep.submitDisabled}`)
      if (prep.ok && prep.textMatches && prep.submitDisabled === false) {
        console.log('click result:', JSON.stringify(await server.send('trusted', a, autoEpoch)))
      } else console.log('AUTO aborted: composer not ready, no click made')
    }
  }
  for (const end = Date.now() + watchMin * 60_000; Date.now() < end; await sleep(1500)) {
    try {
      const p = (await server.send('ping', { tabId: tabs[0].tabId })) as { gen: number; id: string }
      if (p.gen !== lastGen) { console.log(`${new Date().toISOString().slice(11, 19)} gen=${p.gen}${lastGen >= 0 ? ' (a generate send was seen)' : ''}`); lastGen = p.gen }
      const net = (await server.send('net', { tabId: tabs[0].tabId })) as { rpc: string; via: string; status: number; res: string }[]
      for (const r of net) console.log(`${new Date().toISOString().slice(11, 19)} rpc=${r.rpc} via=${r.via} status=${r.status} bytes=${r.res.length}`)
    } catch (e) { console.log('watch:', (e as Error).message) }
  }
}
await server.close()
console.log('done')
