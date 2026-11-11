// Live image batch through the PRODUCT runner on the user's real Flow tab (Chrome profile with the extension loaded).
// MODE=auto (default) clicks Gửi itself; MODE=manual waits for a human click. N prompts, each makes `count` images (credits!).
// Prints only states/ids (no URLs, bodies, tokens; email masked). Run: npm run live-batch -w apps/desktop  (stop other pairing processes first)
// ACCOUNT=<start of the email>: only that account's tab (several Chrome profiles can be connected; never send on the wrong one).
// COMBO='{"model":"Nano Banana Pro","aspect":"9:16","quality":null,"count":1}': qualify a combo: merged over the default (null drops the key),
// allowed through the runner's gate for this run only; the request facts and output sizes are printed, then the default settings are put back.
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { startConnectorServer } from '../src/main/connector/server'
import { installExtension, readOrCreateToken } from '../src/main/connector/pairing'
import { EXT_ID } from '../src/main/connector/ext-id'
import { createExtDriver } from '../src/main/connector/ext-driver'
import { createGrants } from '../src/main/tabs'
import { batchStatus, createRunner } from '../src/main/runner'
import { enqueueBatch } from '../src/main/batch'
import { openDb } from '../src/main/db'
import { createAssetStore, registerAsset } from '../src/main/assets'
import { DEFAULT_COMBO, selfCheckTab, validateProfile, profile, type Combo } from '../src/main/profile'
import { parseGenerateRequest, readFReq } from '@toolflow/flow-protocol/parse'
import pkg from '../package.json'
import { autoGate, enableAuto } from '../src/main/account'

const userData = process.env.TOOLFLOW_USER_DATA ?? join(homedir(), '.local/share/toolflow-live')
const MODE = process.env.MODE === 'manual' ? 'manual' : 'auto'
const PROMPTS = (process.env.PROMPTS ?? 'a single ripe orange on a wooden table|a single white teacup on a windowsill|a single green apple in a basket').split('|')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const mask = (e: string | null): string => (e ?? '').replace(/^(.{2}).*(@.*)$/, '$1***$2')
const ACCOUNT = process.env.ACCOUNT
const combo = Object.fromEntries(Object.entries({ ...DEFAULT_COMBO, ...(process.env.COMBO ? JSON.parse(process.env.COMBO) as object : {}) }).filter(([, v]) => v !== null)) as Combo

const server = await startConnectorServer({ token: readOrCreateToken(userData), extensionId: EXT_ID })
const ext = installExtension(resolve(process.cwd(), '../extension'), userData, server.port, pkg.version) // same version stamp as the app
console.log('listening; waiting for the extension')
for (let i = 0; i < 40 && !server.connected(); i++) await sleep(3000)
if (!server.connected()) { console.log('RESULT: extension never connected'); process.exit(1) }

const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-live-')), 'toolflow.db'))
let grants!: ReturnType<typeof createGrants>
const assets = createAssetStore(db)
const driver = createExtDriver(server, { allow: (id) => grants.has(id), assets })
const REF = process.env.REF_FILE ? registerAsset(db, process.env.REF_FILE, Date.now()) : null // every prompt gets this one ref ('all' mode)
const clock = { now: () => Date.now() }
let email = ''
const runner = createRunner({ db, driver, clock, tabs: [], speed: 'default', autoAllowed: (e) => autoGate(db, e, validateProfile(profile)), combos: [combo],
  selfCheckOk: async (t) => (await selfCheckTab(driver, await driver.ping(t), t, ext.version)).ok })
// what the page really sent, parsed with the product parser (structure facts only, never bodies)
server.onEvent((e) => {
  if (e.type !== 'sent' || !('request' in e)) return
  try { const q = parseGenerateRequest(readFReq(e.request as string)); console.log(`request: rpc=${q.rpc} items=${q.items.length} aspectCodes=${[...new Set(q.items.map((i) => i.aspectCode))].join(',')} models=${[...new Set(q.items.map((i) => i.model))].join(',')} refs=${q.items[0].refIds?.length ?? 0}`) }
  catch (err) { console.log('request PARSE FAILED:', (err as Error).message.slice(0, 160)) }
})
grants = createGrants(driver, runner)

let t: Awaited<ReturnType<typeof grants.list>>[number] | undefined
for (let i = 0; i < 20 && !t; i++) { // another profile may have connected first; each reconnects within 30 s
  t = (await grants.list()).find((x) => x.projectId && x.email && (!ACCOUNT || x.email.startsWith(ACCOUNT)))
  if (!t) await sleep(3000)
}
if (!t) { console.log(`RESULT: no usable Flow tab${ACCOUNT ? ` of account ${ACCOUNT}***` : ''} (need a project page, logged in)`); process.exit(1) }
grants.use([t.tabId]); email = t.email!
console.log(`tab granted; account ${mask(email)}; mode ${MODE}; ${PROMPTS.length} prompts`)
const sc = await selfCheckTab(driver, await driver.ping(t.tabId), t.tabId, ext.version)
console.log('self-check:', JSON.stringify(sc))
if (MODE === 'auto') { enableAuto(db, email, Date.now()); console.log('auto enabled for this run (test db only)') }

const r = enqueueBatch(db, { commandId: `live-${Date.now()}`, kind: 'image', projectId: t.projectId!, settings: { combo }, prompts: PROMPTS, refs: PROMPTS.map(() => (REF ? [REF.id] : [])), mode: MODE })
runner.start(r.batchId)
const view = (): string => (db.prepare('select i.ord o, a.state_json s from item i left join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(r.batchId) as { o: number; s: string | null }[])
  .map((x) => { const s = x.s ? JSON.parse(x.s) : {}; return `#${x.o + 1}:${s.item ?? '-'}/${s.stage ?? '-'}${s.error?.code ? '!' + s.error.code : ''}` }).join('  ')
const t0 = Date.now(); let last = ''
const LIMIT = (MODE === 'manual' ? 12 : 8) * 60_000
for (; Date.now() - t0 < LIMIT; await sleep(500)) {
  await runner.tick()
  const v = view()
  if (v !== last) { console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${v}`); last = v }
  const st = batchStatus(db, r.batchId)
  if (['completed', 'partial_failed', 'needs_review', 'failed', 'stopped'].includes(st)) { console.log('batch status:', st); break }
}
console.log('FINAL:', view())
if (process.env.COMBO) {
  console.log('combo:', JSON.stringify(combo))
  const outs = (db.prepare('select a.state_json s from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(r.batchId) as { s: string }[]).map((x) => ((JSON.parse(x.s).outputs ?? []) as { mediaId: string }[]).map((o) => o.mediaId))
  for (const [k, ids] of outs.entries()) { // the tile's natural size shows the aspect that really came back (read-only)
    const sizes: string[] = []
    for (const mediaId of ids) {
      let l: { ok?: boolean; w?: number; h?: number } | null = null
      for (let k = 0; k < 20 && !(l?.ok && l.w); k++, await sleep(1000)) l = (await server.send('locate', { tabId: t.tabId, mediaId }).catch(() => null)) as typeof l // the tile's image loads a few seconds after the receipt
      sizes.push(l?.ok ? `${l.w}x${l.h}` : '?')
    }
    console.log(`prompt #${k + 1}: outputs=${ids.length} sizes=${sizes.join(' ')}`)
  }
  const back = (await server.send('settings', { tabId: t.tabId, mode: DEFAULT_COMBO.mode, aspect: DEFAULT_COMBO.aspect, quality: DEFAULT_COMBO.quality, count: `x${DEFAULT_COMBO.count}`, model: DEFAULT_COMBO.model }).catch((e) => ({ ok: false, error: String(e).slice(0, 80) }))) as { ok: boolean }
  console.log('default settings put back:', back.ok)
}
console.log('bindings:', JSON.stringify((db.prepare('select state, count(*) n from asset_binding group by state').all())))
console.log('journal types:', (db.prepare('select type, count(*) n from journal_event group by type').all() as { type: string; n: number }[]).map((x) => `${x.type}×${x.n}`).join(' '))
process.exit(0)
