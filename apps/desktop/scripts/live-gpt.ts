// Live look at the ChatGPT tab (spike for the ChatGPT driver): pairs with the real Chrome extension, lists chatgpt.com tabs and prints
// the masked outline of the page (structure only: no conversation text, no URLs). LOOK=1 (default) only reads.
// Run: npm run live-gpt -w apps/desktop   (stop the app first: only one process may own the pairing port)
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { startConnectorServer } from '../src/main/connector/server'
import { installExtension, readOrCreateToken } from '../src/main/connector/pairing'
import { EXT_ID } from '../src/main/connector/ext-id'
import pkg from '../package.json'

const userData = process.env.TOOLFLOW_USER_DATA ?? join(homedir(), '.local/share/toolflow-live')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const SITE = process.env.SITE ?? 'gpt' // gpt = chatgpt.com, gem = gemini.google.com: the prefix of the site's ops
const server = await startConnectorServer({ token: readOrCreateToken(userData), extensionId: EXT_ID })
installExtension(resolve(process.cwd(), '../extension'), userData, server.port, pkg.version)
console.log('listening; waiting for the extension')
for (let i = 0; i < 40 && !server.connected(); i++) await sleep(3000)
if (!server.connected()) { console.log('RESULT: extension never connected'); process.exit(1) }
let tabs: { tabId: string; active: boolean; path: string; status: string }[] = []
for (let i = 0; i < 20 && !tabs.length; i++, tabs.length || await sleep(3000)) tabs = (await server.send(`${SITE}Tabs`, {}).catch((e) => { console.log(`${SITE}Tabs:`, (e as Error).message); return [] })) as typeof tabs
console.log(`${SITE} tabs: ${tabs.length}`, tabs.map((t) => `${t.active ? 'active' : 'background'} ${t.status} ${t.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{12,32}/g, "<id>")}`).join(' | '))
const tab = tabs[0]
if (tab) {
  const a = { tabId: tab.tabId }
  // STEPS='[["gptNew",{}],["gptPrep",{"prompt":"…"}]]' runs ops in order (default: one read-only gptLook); WATCH=<seconds> then prints gptState whenever it changes
  // a string value "@b64:<path>" in STEPS becomes that file's bytes in base64 (reference images are too big for an env var)
  const steps = process.env.STEPS ? (JSON.parse(process.env.STEPS, (_k, v) => (typeof v === 'string' && v.startsWith('@b64:') ? readFileSync(v.slice(5)).toString('base64') : v)) as [string, object][]) : (process.env.OPS ?? `${SITE}Look`).split(',').map((op): [string, object] => [op, JSON.parse(process.env.ARGS ?? '{}')])
  for (const [op, args] of steps) {
    if (op === 'until') { // ["until",{"op":"gptState","key":"editor"}]: polls that op until the key is truthy, like the runner's own wait (max 15 s)
      const w = args as { op: string; key: string }; let ok = false
      for (const t0 = Date.now(); !ok && Date.now() - t0 < 15000; await sleep(250)) ok = !!((await server.send(w.op, a).catch(() => null)) as Record<string, unknown> | null)?.[w.key]
      console.log(`until ${w.op}.${w.key}:`, ok); continue
    }
    try { console.log(`${op}:`, JSON.stringify(await server.send(op, { ...a, ...args }), null, process.env.FLAT ? undefined : 1)) }
    catch (e) { console.log(`${op}: ERROR ${(e as Error).message}`) }
  }
  let last = ''
  for (const t0 = Date.now(); Date.now() - t0 < Number(process.env.WATCH ?? 0) * 1000; await sleep(2000)) {
    const st = JSON.stringify(await server.send(process.env.WATCH_OP ?? 'gptState', { ...a, ...JSON.parse(process.env.WATCH_ARGS ?? '{}') }).catch((e) => ({ error: (e as Error).message })))
    if (st !== last) { console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${st}`); last = st }
  }
}
await server.close()
console.log('done')
