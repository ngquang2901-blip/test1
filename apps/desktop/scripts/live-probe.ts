// Read-only live probe: pairs with the real Chrome extension and reports what the Flow tabs look like.
// Never clicks, fills or sends anything on the page. Prints no URLs/tokens; the account email is masked.
// Run: npm run live-probe -w apps/desktop   (stop the app first: only one process may own the pairing port)
import { deflateSync } from 'node:zlib'
import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { startConnectorServer } from '../src/main/connector/server'
import { installExtension, readOrCreateToken } from '../src/main/connector/pairing'
import { EXT_ID } from '../src/main/connector/ext-id'
import flow from '../profiles/flow.json'
import pkg from '../package.json'
import { createExtDriver } from '../src/main/connector/ext-driver'
import { DEFAULT_COMBO } from '../src/main/profile'
import { correlate, parseGenerateRequest, parseImageReceipt, parseRpcResponse, readFReq } from '@toolflow/flow-protocol/parse'

const userData = process.env.TOOLFLOW_USER_DATA ?? join(homedir(), '.local/share/toolflow-live')
const mask = (e: unknown): string => (typeof e === 'string' ? e.replace(/^(.{2}).*(@.*)$/, '$1***$2') : String(e))
const PROMPT = process.env.PROMPT ?? 'a single yellow lemon on a blue plate'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const server = await startConnectorServer({ token: readOrCreateToken(userData), extensionId: EXT_ID })
installExtension(resolve(process.cwd(), '../extension'), userData, server.port, pkg.version) // run via npm from apps/desktop; same version stamp as the app, so a later app start asks for no reload
console.log('listening; waiting for the extension to (re)connect (it retries every 30 s)')
for (let i = 0; i < 40 && !server.connected(); i++) await sleep(3000)
if (!server.connected()) { console.log('RESULT: extension never connected'); process.exit(1) }
console.log('extension connected')

type Tab = { tabId: string; active: boolean; path: string; status: string }
// ACCOUNT=<start of the email>: only that account's Flow tab (several Chrome profiles can be connected; each reconnects within 30 s).
const WANT = process.env.ACCOUNT
// Wait (up to 6 min) until the extension runs the NEW code (tabs op exists) and a Flow tab has our page hooks (needs F5 after the extension reload).
let tabs: Tab[] = []
const t0 = Date.now()
for (let note = ''; Date.now() - t0 < 360_000; await sleep(4000)) {
  let why = ''
  try {
    tabs = (await server.send('tabs', {})) as Tab[]
    if (!tabs.length) why = 'no Flow tab open (https://flow.google.com/...)'
    else {
      if (WANT) {
        const mine: Tab[] = []
        for (const t of tabs) if (String(await server.send('account', { tabId: t.tabId }).catch(() => '')).startsWith(WANT)) mine.push(t)
        tabs = mine
      }
      const p = tabs[0] ? (await server.send('ping', { tabId: tabs[0].tabId }).catch(() => null)) as { version?: string } | null : null
      if (p?.version) break
      why = tabs[0] ? 'Flow tab has no ToolFlow hooks yet: reload the tab (F5)' : `no Flow tab of account ${WANT}*** connected yet`
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
// INSPECT=1: read-only look at the composer settings panel: open it, list its buttons (text/role/checked), close it again. Nothing is changed or sent.
if (process.env.INSPECT === '1' && tabs[0]) {
  const a = { tabId: tabs[0].tabId }
  console.log('state:', JSON.stringify(await server.send('state', a)))
  console.log('open settings:', JSON.stringify(await server.send('click', { ...a, sel: 'flow-prompt-box button.settings-trigger-button' })))
  await sleep(1200)
  console.log('radios:', JSON.stringify(await server.send('radios', a)))
  await sleep(Number(process.env.HOLD ?? 0) * 1000) // HOLD=<s>: keep the panel open for a screenshot (the cost line is only readable there)
  console.log('close settings:', JSON.stringify(await server.send('click', { ...a, sel: 'flow-prompt-box button.settings-trigger-button' })))
  await sleep(600)
  console.log('radios after close:', JSON.stringify(await server.send('radios', a)))
}
// MODELS=1: read-only look at the model menu: open the settings panel, click the model button, report which candidate selectors
// exist before/while it is open (HOLD=<s> keeps it open for a screenshot; close it with Escape), then close the panel. Nothing is chosen or sent.
if (process.env.MODELS === '1' && tabs[0]) {
  const a = { tabId: tabs[0].tabId }, TRIGGER = 'flow-prompt-box button.settings-trigger-button'
  const cand = {
    roleMenu: '[role="menu"]', roleMenuitem: '[role="menuitem"]', roleMenuitemradio: '[role="menuitemradio"]', roleOption: '[role="option"]', roleListbox: '[role="listbox"]',
    matMenuPanel: '.mat-mdc-menu-panel', matMenuItem: '.mat-mdc-menu-item', matOption: 'mat-option', matSelectPanel: '.mat-mdc-select-panel', cdkOverlay: '.cdk-overlay-pane', cdkBackdrop: '.cdk-overlay-backdrop',
    inPanelMenuitem: 'flow-prompt-box-settings [role="menuitem"]', inPanelOption: 'flow-prompt-box-settings [role="option"]', expanded: 'flow-prompt-box-settings button[aria-expanded="true"]', haspopup: 'flow-prompt-box-settings button[aria-haspopup]',
    popover: '[popover]', dialog: '[role="dialog"]', menuButtons: '[role="menu"] button', menuLi: '[role="menu"] li',
  }
  const seen = async (): Promise<string> => Object.entries(((await server.send('probe', { ...a, selectors: cand })) as { present: Record<string, boolean> }).present).filter(([, v]) => v).map(([k]) => k).join(' ') || '(none)'
  console.log('open settings:', JSON.stringify(await server.send('click', { ...a, sel: TRIGGER })))
  await sleep(1200)
  console.log('present before:', await seen())
  console.log('click model button:', JSON.stringify(await server.send('click', { ...a, sel: 'flow-prompt-box-settings button:not([role="radio"])' })))
  await sleep(1500)
  console.log('present with the menu open:', await seen())
  console.log('radios with the menu open:', JSON.stringify(await server.send('radios', a)))
  await sleep(Number(process.env.HOLD ?? 0) * 1000)
  console.log('present after hold:', await seen())
  // MODELS=all: additionally pick every menu item in turn, list the panel's options for it (they can differ per model), then put the first model back.
  // This changes the composer's model setting for a few seconds; nothing is typed or sent.
  if (process.env.MODELS_ALL === '1') {
    const ITEM = '[role="menu"] button[role="menuitem"]', MODEL = 'flow-prompt-box-settings button:not([role="radio"])'
    const model = async (): Promise<string> => String(((await server.send('radios', a)) as [number, string | null, string][]).find((r) => r[1] === null)?.[2] ?? '?')
    const orig = await model()
    let back = -1
    for (let k = 0; k < 8; k++) {
      if ((await seen()).includes('roleMenuitem') === false) { await server.send('click', { ...a, sel: MODEL }); await sleep(1200) }
      if ((await server.send('click', { ...a, sel: ITEM, idx: k })) !== 'clicked') break
      await sleep(1800)
      const now = await model()
      if (now === orig) back = k
      console.log(`MODEL ${k}: ${now} | radios: ${JSON.stringify(((await server.send('radios', a)) as [number, string | null, string, string | null][]).filter((r) => r[1] === 'radio').map((r) => r[2] + (r[3] === 'true' ? '*' : '')))} | chip: ${JSON.stringify(((await server.send('state', a)) as { settings: string }).settings)}`)
      await sleep(Number(process.env.HOLD ?? 0) * 1000)
    }
    if (back >= 0 && (await model()) !== orig) { await server.send('click', { ...a, sel: MODEL }); await sleep(1200); await server.send('click', { ...a, sel: ITEM, idx: back }); await sleep(1500) }
    console.log(`MODEL restored: ${(await model()) === orig}`)
  }
  if ((await server.send('radios', a)) !== 'no panel') console.log('close settings:', JSON.stringify(await server.send('click', { ...a, sel: TRIGGER })))
  await sleep(600)
  console.log('panel after close:', JSON.stringify(await server.send('radios', a)) === '"no panel"' ? 'closed' : 'STILL OPEN')
}
// SET='[{"model":"Nano Banana Pro","aspect":"9:16","quality":null,"count":"x1"}, ...]': run the product `settings` op for each entry (mode Image),
// print what the panel reads back, then put the default combo back. Changes the composer's settings for a moment; nothing is typed or sent.
if (process.env.SET && tabs[0]) {
  const a = { tabId: tabs[0].tabId }
  const chip = async (): Promise<string> => JSON.stringify(((await server.send('state', a)) as { settings: string }).settings)
  // SET_KEEP=1 leaves the last entry in place (to look at the panel of another mode with INSPECT / MODELS afterwards); run SET='[]' to put the default back
  for (const w of [...(JSON.parse(process.env.SET) as Record<string, unknown>[]), ...(process.env.SET_KEEP === '1' ? [] : [{ model: DEFAULT_COMBO.model, aspect: DEFAULT_COMBO.aspect, quality: DEFAULT_COMBO.quality, count: `x${DEFAULT_COMBO.count}` }])]) {
    const t1 = Date.now()
    const r = (await server.send('settings', { ...a, mode: 'Image', ...w }).catch((e) => ({ error: String((e as Error).message).slice(0, 120) }))) as { ok?: boolean; mismatches?: string[]; current?: object; error?: string }
    console.log(`SET ${JSON.stringify(w)} -> ok=${r.ok} mismatches=${JSON.stringify(r.mismatches ?? r.error)} current=${JSON.stringify(r.current)} ${Date.now() - t1}ms | chip ${await chip()} | panel ${(await server.send('radios', a)) === 'no panel' ? 'closed' : 'OPEN'} | menu ${((await server.send('probe', { ...a, selectors: { m: '[role="menu"]' } })) as { present: { m: boolean } }).present.m ? 'OPEN' : 'closed'}`)
    await sleep(800)
  }
}
// PREP=1: product ext-driver on the real tab, never clicks Send: prepare (settings + prompt), pre-click checks, stale-text replace, settings round trip, then clears the composer.
if (process.env.PREP === '1' && tabs[0]) {
  const drv = createExtDriver(server, { allow: () => true })
  const t = (await drv.listTabs())[0]
  const show = (label: string, v: unknown): void => console.log(`${label}: ${JSON.stringify(v)}`)
  const text = async (): Promise<string> => ((await server.send('state', { tabId: Number(t.tabId) })) as { text: string }).text
  const P1 = 'prep probe one: a red kite', P2 = 'prep probe two: a blue boat'
  const combo = { ...DEFAULT_COMBO }
  show('listTabs', { hasProject: !!t.projectId, hasEmail: !!t.email })
  show('prepare#1', await drv.prepare(t.tabId, { prompt: P1, kind: 'image', settings: { combo }, refIds: [] }))
  show('composer == P1', (await text()) === P1)
  show('checkBeforeClick', await drv.checkBeforeClick(t.tabId, t.projectId!, []))
  show('checkBeforeClick wrong project', await drv.checkBeforeClick(t.tabId, '00000000-0000-4000-8000-000000000000', []))
  show('prepare#2 (stale text present)', await drv.prepare(t.tabId, { prompt: P2, kind: 'image', settings: { combo }, refIds: [] }))
  show('composer == P2 only', (await text()) === P2)
  show('settings round trip x1', await drv.prepare(t.tabId, { prompt: P2, kind: 'image', settings: { combo: { ...combo, count: 1 } }, refIds: [] }))
  show('settings back to x2', await drv.prepare(t.tabId, { prompt: P2, kind: 'image', settings: { combo }, refIds: [] }))
  show('state settings', ((await server.send('state', { tabId: Number(t.tabId) })) as { settings: string }).settings)
  await server.send('click', { tabId: Number(t.tabId), sel: 'button.clear-button' })
  await sleep(500)
  show('composer cleared', (await text()) === '')
}
// SC=1: run the product probeTab + the raw ops it uses, print the raw answers (read-only).
if (process.env.SC === '1' && tabs[0]) {
  const a = { tabId: tabs[0].tabId }
  for (const [op, args] of [['ping', a], ['probe', { ...a, selectors: { editor: 'flow-prompt-box .ProseMirror[contenteditable="true"]', submit: 'flow-prompt-box button[type="submit"]' } }], ['listeners', a]] as const) {
    try { console.log(op, JSON.stringify(await server.send(op, args as never))) } catch (e) { console.log(op, 'ERR', (e as Error).message) }
  }
}
// REF=1: upload ONE tiny unique PNG (free, no generation) via op `file` (REF_HOW=drop|paste), then describe chips and composer buttons. Never sends.
if (process.env.REF === '1' && tabs[0]) {
  const a = { tabId: tabs[0].tabId }
  const crc = (b: Buffer): number => { let c, x = ~0; for (const v of b) { c = (x ^ v) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; x = (x >>> 8) ^ c } return ~x >>> 0 }
  const chunk = (t: string, d: Buffer): Buffer => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const W = 96, raw = Buffer.alloc((W * 3 + 1) * W); const tint = Date.now() % 200
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = tint + (x % 50); raw[o + 1] = 80 + (y % 90); raw[o + 2] = 200 - (x % 60) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  const name = `tf-ref-${Date.now()}.png`
  await server.send('net', a) // drain
  console.log('file:', JSON.stringify(await server.send('file', { ...a, b64: png.toString('base64'), name, mime: 'image/png', how: process.env.REF_HOW ?? 'drop' })), name)
  await sleep(4000)
  const net = (await server.send('net', a)) as { rpc?: string; status?: number; via?: string }[]
  console.log('net after upload:', JSON.stringify((Array.isArray(net) ? net : []).map((n) => `${n.rpc ?? '?'}/${n.via ?? ''}/${n.status ?? ''}`)))
  const st = await server.send('state', a)
  console.log('state:', JSON.stringify(st))
  if (process.env.REF_ATTACH === '1') for (let k = 1; k <= 3; k++) { const t0 = Date.now(); console.log(`attach#${k}:`, JSON.stringify(await server.send('attach', { ...a, name }).catch((e) => String(e))), `${Date.now() - t0}ms`) }
}
// CHIPS=1: read-only: composer state + net buffer (names only) + a masked description of the composer DOM.
if (process.env.CHIPS === '1' && tabs[0]) {
  const a = { tabId: tabs[0].tabId }
  console.log('state:', JSON.stringify(await server.send('state', a)))
  const net = (await server.send('net', a)) as { rpc?: string; status?: number; via?: string }[]
  console.log('net:', JSON.stringify((Array.isArray(net) ? net : []).map((n) => `${n.rpc ?? '?'}/${n.via ?? ''}/${n.status ?? ''}`)))
}
// SEL=1: presence/count of candidate selectors given as JSON in SELS (read-only probe op).
if (process.env.SEL === '1' && tabs[0]) {
  const sels = JSON.parse(process.env.SELS ?? '{}') as Record<string, string>
  console.log('probe:', JSON.stringify(await server.send('probe', { tabId: tabs[0].tabId, selectors: sels })))
}
// ASB=1 (design §8.1): which part of a video's listing entry shows up on its tile? Reloads the tab, reads the project listing the page
// loads (Zzl0ze, in memory only), waits ASB_WAIT s (open the Video view by hand meanwhile), then asks the page for the presence of
// each candidate (the media id, the workflow id, the token of each content url) on the page. Prints yes/no per candidate, never a token.
if (process.env.ASB === '1' && tabs[0]) {
  const a = { tabId: tabs[0].tabId }
  await server.send('net', a) // drop what is already in the ring
  await server.send('reloadTab', a)
  let text = ''
  for (let i = 0; i < 40 && !text; i++) { await sleep(1500); try { text = ((await server.send('net', a)) as { rpc: string; res: string }[]).find((r) => r.rpc === 'Zzl0ze')?.res ?? '' } catch { /* the tab is still loading */ } }
  if (!text) console.log('ASB: no project listing seen after the reload')
  else {
    const payload = (parseRpcResponse(text, 'Zzl0ze') as { payload: unknown[][] }).payload
    const media = payload[2] as unknown[][], token = (u: unknown): string => (typeof u === 'string' ? (/googleusercontent\.com\/([^=?]+)/.exec(u)?.[1] ?? '') : '')
    const videos = media.filter((e) => Array.isArray(e[7])).sort((x, y) => (y[5] as number[][])[0][0] - (x[5] as number[][])[0][0]).slice(0, 10)
    console.log(`ASB: listing has ${media.length} media, ${media.filter((e) => Array.isArray(e[7])).length} videos; waiting ${process.env.ASB_WAIT ?? 15} s before probing the newest ${videos.length}`)
    const shape = (u: unknown): string => (typeof u === 'string' ? u.replace(/[A-Za-z]/g, 'a').replace(/[0-9]/g, '0').replace(/a{4,}|0{4,}|(?:a|0){6,}/g, (m) => `${m[0]}{${m.length}}`) : String(u)) // letters and digits masked: only the punctuation and the lengths show
    console.log(`ASB url shape of the newest video: ${shape((videos[0]?.[5] as unknown[])?.[5])}`)
    await sleep(Number(process.env.ASB_WAIT ?? 15) * 1000)
    for (const [i, e] of videos.entries()) {
      const g = e[5] as unknown[], v = e[7] as unknown[][]
      const cand: Record<string, string> = { mediaIdAttr: `[data-media-id="${e[0]}"]`, hrefMedia: `a[href*="${e[0]}"]`, hrefWorkflow: `a[href*="${e[2]}"]` }
      for (const [k, u] of [['g5', g[5]], ['g10', g[10]], ['v0_8', v[0]?.[8]], ['v5_0', v[5]?.[0]]] as const) if (token(u)) { const t = token(u).slice(0, 60); cand[`img_${k}`] = `img[src*="${t}"]`; cand[`poster_${k}`] = `[poster*="${t}"]`; cand[`style_${k}`] = `[style*="${t}"]` } // a head of the token: the op takes short selectors only
      const r = (await server.send('probe', { ...a, selectors: cand })) as { present: Record<string, boolean> }
      console.log(`ASB video ${i}: tokens ${['g5', 'g10', 'v0_8', 'v5_0'].map((k) => `${k}=${token(k === 'g5' ? g[5] : k === 'g10' ? g[10] : k === 'v0_8' ? v[0]?.[8] : v[5]?.[0]).length}ch`).join(' ')} same(g5,g10)=${token(g[5]) === token(g[10])} same(g5,v0_8)=${token(g[5]) === token(v[0]?.[8])} same(v0_8,v5_0)=${token(v[0]?.[8]) === token(v[5]?.[0])} | present: ${Object.entries(r.present).filter(([, p]) => p).map(([k]) => k).join(' ') || '(none)'}`)
    }
    console.log('ASB generic:', JSON.stringify(((await server.send('probe', { ...a, selectors: { imgAsb: 'img[src*="/asb/"]', imgLh3: 'img[src*="googleusercontent.com"]', video: 'video', tile: 'flow-grid-tile-container', tileImgAsb: 'flow-grid-tile-container img[src*="/asb/"]' } })) as { present: object }).present))
  }
}
// ATTACH=<name prefix>: run the attach op once (opens library, searches, attaches ONE chip, closes) and print the raw answer + chips.
if (process.env.ATTACH && tabs[0]) {
  const a = { tabId: tabs[0].tabId }
  try { console.log('attach:', JSON.stringify(await server.send('attach', { ...a, name: process.env.ATTACH }))) } catch (e) { console.log('attach ERR', (e as Error).message) }
  console.log('state:', JSON.stringify(await server.send('state', a)))
}
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
      // DUMP_NET=<file outside the repo>: keep the observed responses for offline study of their shape; what opens media is cut out before anything is written
      if (process.env.DUMP_NET) for (const r of net) appendFileSync(process.env.DUMP_NET, JSON.stringify({ ...r, res: r.res.replace(/Signature=[^&"\\]+/g, 'Signature=<redacted>').replace(/(googleusercontent\.com\/)[^"\\]+/g, '$1<redacted>').replace(/(\/asb\/)[^"\\=]+/g, '$1<redacted>') }) + '\n', { mode: 0o600 })
    } catch (e) { console.log('watch:', (e as Error).message) }
  }
}
await server.close()
console.log('done')
