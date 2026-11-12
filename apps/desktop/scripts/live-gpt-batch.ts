// Live ChatGPT image batch through the product path (spends the account's image quota): the real connector, the real ChatGPT runner and
// downloader, a throwaway DB. Prints states and codes only: no conversation text, no addresses.
// Run: PROMPTS='a|b' npm run live-gpt-batch -w apps/desktop   (stop the app first: only one process may own the pairing port)
//   WATCH=1 prints what the page reports for the turn on every change (structure only)
import { mkdtempSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AttemptState } from '@toolflow/flow-protocol/attempt'
import { startConnectorServer } from '../src/main/connector/server'
import { installExtension, readOrCreateToken } from '../src/main/connector/pairing'
import { createExtDriver } from '../src/main/connector/ext-driver'
import { EXT_ID } from '../src/main/connector/ext-id'
import { openDb } from '../src/main/db'
import { enqueueBatch } from '../src/main/batch'
import { createExtGpt, type GptDriver } from '../src/main/gpt-driver'
import { createGptRunner } from '../src/main/gpt-runner'
import { createDownloader } from '../src/main/downloads'
import { batchStatus } from '../src/main/runner'
import pkg from '../package.json'

const userData = process.env.TOOLFLOW_USER_DATA ?? join(homedir(), '.local/share/toolflow-live')
const prompts = (process.env.PROMPTS ?? '').split('|').map((p) => p.trim()).filter(Boolean)
if (!prompts.length) { console.log('PROMPTS is empty'); process.exit(1) }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const mask = (s: string | null | undefined): string => (s ? `…${s.slice(-6)}` : String(s))
const t0 = Date.now(), at = (): string => `[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s]`

const server = await startConnectorServer({ token: readOrCreateToken(userData), extensionId: EXT_ID })
installExtension(resolve(process.cwd(), '../extension'), userData, server.port, pkg.version)
for (let i = 0; i < 40 && !server.connected(); i++) await sleep(3000)
if (!server.connected()) { console.log('RESULT: extension never connected'); process.exit(1) }
const provider = process.env.SITE === 'gem' ? 'gemini' : 'chatgpt' // SITE=gem runs the same batch on the Gemini tab
const real = createExtGpt(server, provider)
let seen = ''
const gpt: GptDriver = { ...real,
  async turns(tab, prompt) { // WATCH: what the page says about the turns, whenever it changes
    const r = await real.turns(tab, prompt)
    const line = JSON.stringify({ conv: mask(r.conv), turns: r.turns.map((t) => ({ key: mask(t.key), state: t.state, mine: t.mine, images: t.images.length, pending: t.pending })) })
    if (process.env.WATCH && line !== seen) { seen = line; console.log(at(), 'page:', line) }
    return r
  } }
for (let i = 0; i < 20 && !(await gpt.tabs().catch(() => [])).length; i++) await sleep(3000)
console.log(`${provider} tabs:`, (await gpt.tabs()).length)

const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-live-gpt-')), 'toolflow.db'))
const clock = { now: () => Date.now() }
const root = process.env.DL_ROOT ?? join(homedir(), 'Downloads', 'ToolFlow')
const flow = createExtDriver(server, { allow: () => false }) // only its downloads() list is used here
const runner = createGptRunner({ db, driver: gpt, provider, clock, download: (b) => downloader.batch(b) })
const downloader = createDownloader({ db, root, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now, tab: () => runner.findTab(),
  driver: { fetchMedia: (tab, p) => runner.fetchMedia(tab, p), downloads: (q) => flow.downloads(q) } })
const batch = enqueueBatch(db, { commandId: randomUUID(), kind: 'image', provider, projectId: null, settings: { provider }, prompts, refs: prompts.map(() => []), mode: 'auto' }).batchId
db.prepare("update batch set status='running' where id=?").run(batch)

const states = (): AttemptState[] => (db.prepare('select a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(batch) as { j: string }[]).map((r) => JSON.parse(r.j))
let last = ''
const limit = Number(process.env.LIMIT_S ?? 150 * prompts.length) * 1000
for (;;) {
  await runner.tick().catch((e) => console.log('tick error:', (e as { code?: string }).code ?? (e as Error).name))
  const s = states(), line = s.map((x, i) => `#${i + 1}:${x.item}${x.error?.code ? `(${x.error.code})` : ''}`).join(' ')
  const status = (db.prepare('select status from batch where id=?').get(batch) as { status: string }).status
  if (line !== last) { last = line; console.log(at(), line, status === 'paused' ? `| paused: ${runner.lastError(batch)}` : '') }
  if (status === 'paused' || s.every((x) => ['ready', 'failed', 'cancelled', 'needs_review'].includes(x.item))) break
  if (Date.now() - t0 > limit) { console.log('RESULT: time limit'); break }
  await sleep(500)
}
const s = states()
console.log('batch:', batchStatus(db, batch), '| conversations:', new Set(s.map((x) => (x.request as { conv?: string } | null)?.conv).filter(Boolean)).size, '| outputs per prompt:', s.map((x) => x.outputs?.length ?? 0).join(','))
for (const d of db.prepare('select state, actual_name n, bytes, error_code e from download order by created_at').all() as { state: string; n: string | null; bytes: number | null; e: string | null }[]) {
  const file = d.n ? join(root, d.n) : null
  console.log('download:', d.state, d.e ?? '', d.n ? `${d.n.replace(/_[^_/]{9,}_/, '_<prompt>_')} ${d.bytes} bytes on disk ${file && statSync(file).size}` : '')
}
console.log('journal:', (db.prepare('select a.ordinal o, group_concat(j.type) t from journal_event j join attempt a on a.id=j.attempt_id group by j.attempt_id order by a.rowid').all() as { t: string }[]).map((r) => r.t).join(' | '))
await server.close()
process.exit(0)
