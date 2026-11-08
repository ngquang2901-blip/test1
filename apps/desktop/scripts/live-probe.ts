// Read-only live probe: pairs with the real Chrome extension and reports what the Flow tabs look like.
// Never clicks, fills or sends anything on the page. Prints no URLs/tokens; the account email is masked.
// Run: npm run live-probe -w apps/desktop   (stop the app first: only one process may own the pairing port)
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { startConnectorServer } from '../src/main/connector/server'
import { installExtension, readOrCreateToken } from '../src/main/connector/pairing'
import { EXT_ID } from '../src/main/connector/ext-id'
import flow from '../profiles/flow.json'

const userData = process.env.TOOLFLOW_USER_DATA ?? join(homedir(), '.local/share/toolflow-live')
const mask = (e: unknown): string => (typeof e === 'string' ? e.replace(/^(.{2}).*(@.*)$/, '$1***$2') : String(e))
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
// WATCH_MIN=n: keep watching n minutes and print every RPC the page makes (rpc/transport/status/size) and gen changes, so one manual generate shows which transport carries it.
const watchMin = Number(process.env.WATCH_MIN ?? 0)
if (watchMin > 0 && tabs[0]) {
  console.log(`watching tab ${tabs[0].tabId} for ${watchMin} min: generate once by hand (read-only, nothing is clicked by us)`)
  let lastGen = -1
  // ARM=1: act like the manual-mode runner: arm the tab with an epoch, then the user's own send must come back as events with that epoch.
  const armEpoch = process.env.ARM === '1' ? Date.now() : null
  server.onEvent((e) => console.log(`${new Date().toISOString().slice(11, 19)} EVENT ${e.type} tab=${e.tabId}` + ('epoch' in e ? ` epoch=${e.epoch === armEpoch ? 'ARMED' : e.epoch}` : '') + ('rpc' in e ? ` rpc=${e.rpc} text=${e.text.length}B` : '') + ('request' in e ? ` request=${String(e.request).length}B` : '')))
  if (armEpoch !== null) { await server.send('arm', { tabId: tabs[0].tabId, epoch: armEpoch }); console.log('armed (manual mode): now send ONE generate in Flow') }
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
