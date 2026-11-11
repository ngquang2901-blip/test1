// Live look at the ChatGPT tab (spike for the ChatGPT driver): pairs with the real Chrome extension, lists chatgpt.com tabs and prints
// the masked outline of the page (structure only: no conversation text, no URLs). LOOK=1 (default) only reads.
// Run: npm run live-gpt -w apps/desktop   (stop the app first: only one process may own the pairing port)
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { startConnectorServer } from '../src/main/connector/server'
import { installExtension, readOrCreateToken } from '../src/main/connector/pairing'
import { EXT_ID } from '../src/main/connector/ext-id'
import pkg from '../package.json'

const userData = process.env.TOOLFLOW_USER_DATA ?? join(homedir(), '.local/share/toolflow-live')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const server = await startConnectorServer({ token: readOrCreateToken(userData), extensionId: EXT_ID })
installExtension(resolve(process.cwd(), '../extension'), userData, server.port, pkg.version)
console.log('listening; waiting for the extension')
for (let i = 0; i < 40 && !server.connected(); i++) await sleep(3000)
if (!server.connected()) { console.log('RESULT: extension never connected'); process.exit(1) }
let tabs: { tabId: string; active: boolean; path: string; status: string }[] = []
for (let i = 0; i < 20 && !tabs.length; i++, tabs.length || await sleep(3000)) tabs = (await server.send('gptTabs', {}).catch((e) => { console.log('gptTabs:', (e as Error).message); return [] })) as typeof tabs
console.log(`chatgpt tabs: ${tabs.length}`, tabs.map((t) => `${t.active ? 'active' : 'background'} ${t.status} ${t.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')}`).join(' | '))
const tab = tabs[0]
if (tab) {
  const a = { tabId: tab.tabId }
  // STEPS='[["gptNew",{}],["gptPrep",{"prompt":"…"}]]' runs ops in order (default: one read-only gptLook); WATCH=<seconds> then prints gptState whenever it changes
  const steps = process.env.STEPS ? (JSON.parse(process.env.STEPS) as [string, object][]) : (process.env.OPS ?? 'gptLook').split(',').map((op): [string, object] => [op, JSON.parse(process.env.ARGS ?? '{}')])
  for (const [op, args] of steps) {
    try { console.log(`${op}:`, JSON.stringify(await server.send(op, { ...a, ...args }), null, process.env.FLAT ? undefined : 1)) }
    catch (e) { console.log(`${op}: ERROR ${(e as Error).message}`) }
  }
  let last = ''
  for (const t0 = Date.now(); Date.now() - t0 < Number(process.env.WATCH ?? 0) * 1000; await sleep(2000)) {
    const st = JSON.stringify(await server.send('gptState', a).catch((e) => ({ error: (e as Error).message })))
    if (st !== last) { console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${st}`); last = st }
  }
}
await server.close()
console.log('done')
