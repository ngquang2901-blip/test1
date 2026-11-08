// Live image batch through the PRODUCT runner on the user's real Flow tab (Chrome profile with the extension loaded).
// MODE=auto (default) clicks Gửi itself; MODE=manual waits for a human click. N prompts, each makes `count` images (credits!).
// Prints only states/ids (no URLs, bodies, tokens; email masked). Run: npm run live-batch -w apps/desktop  (stop other pairing processes first)
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
import { DEFAULT_COMBO, selfCheckTab, validateProfile, profile } from '../src/main/profile'
import { autoGate, enableAuto } from '../src/main/account'

const userData = process.env.TOOLFLOW_USER_DATA ?? join(homedir(), '.local/share/toolflow-live')
const MODE = process.env.MODE === 'manual' ? 'manual' : 'auto'
const PROMPTS = (process.env.PROMPTS ?? 'a single ripe orange on a wooden table|a single white teacup on a windowsill|a single green apple in a basket').split('|')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const mask = (e: string | null): string => (e ?? '').replace(/^(.{2}).*(@.*)$/, '$1***$2')

const server = await startConnectorServer({ token: readOrCreateToken(userData), extensionId: EXT_ID })
installExtension(resolve(process.cwd(), '../extension'), userData, server.port)
console.log('listening; waiting for the extension')
for (let i = 0; i < 40 && !server.connected(); i++) await sleep(3000)
if (!server.connected()) { console.log('RESULT: extension never connected'); process.exit(1) }

const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-live-')), 'toolflow.db'))
let grants!: ReturnType<typeof createGrants>
const driver = createExtDriver(server, { allow: (id) => grants.has(id) })
const clock = { now: () => Date.now() }
let email = ''
const runner = createRunner({ db, driver, clock, tabs: [], speed: 'default', autoAllowed: (e) => autoGate(db, e, validateProfile(profile)),
  selfCheckOk: async (t) => (await selfCheckTab(driver, await driver.ping(t), t, '0.1.0')).ok })
grants = createGrants(driver, runner)

const list = await grants.list()
const t = list.find((x) => x.projectId && x.email)
if (!t) { console.log('RESULT: no usable Flow tab (need a project page, logged in)'); process.exit(1) }
grants.use([t.tabId]); email = t.email!
console.log(`tab granted; account ${mask(email)}; mode ${MODE}; ${PROMPTS.length} prompts`)
const sc = await selfCheckTab(driver, await driver.ping(t.tabId), t.tabId, '0.1.0')
console.log('self-check:', JSON.stringify(sc))
if (MODE === 'auto') { enableAuto(db, email, Date.now()); console.log('auto enabled for this run (test db only)') }

const r = enqueueBatch(db, { commandId: `live-${Date.now()}`, kind: 'image', projectId: t.projectId!, settings: { combo: DEFAULT_COMBO }, prompts: PROMPTS, refs: PROMPTS.map(() => []), mode: MODE })
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
console.log('journal types:', (db.prepare('select type, count(*) n from journal_event group by type').all() as { type: string; n: number }[]).map((x) => `${x.type}×${x.n}`).join(' '))
process.exit(0)
