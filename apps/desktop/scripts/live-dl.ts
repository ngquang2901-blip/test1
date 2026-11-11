// Live download check: downloads already-existing outputs (ids from DL_IDS json) through the PRODUCT download pipeline.
// No generation, no credits. Prints states, sizes, magic type and pixel size vs the receipt size. No URLs.
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { startConnectorServer } from '../src/main/connector/server'
import { installExtension, readOrCreateToken } from '../src/main/connector/pairing'
import { EXT_ID } from '../src/main/connector/ext-id'
import { createExtDriver } from '../src/main/connector/ext-driver'
import { openDb } from '../src/main/db'
import { requestDownload } from '../src/main/downloads'
import pkg from '../package.json'

const userData = process.env.TOOLFLOW_USER_DATA ?? join(homedir(), '.local/share/toolflow-live')
const ids = JSON.parse(readFileSync(process.env.DL_IDS!, 'utf8')) as { id: string; w: number; h: number }[]
const N = Number(process.env.N ?? 2)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const server = await startConnectorServer({ token: readOrCreateToken(userData), extensionId: EXT_ID })
installExtension(resolve(process.cwd(), '../extension'), userData, server.port, pkg.version) // same version stamp as the app
for (let i = 0; i < 40 && !server.connected(); i++) await sleep(3000)
if (!server.connected()) { console.log('RESULT: extension never connected'); process.exit(1) }
const driver = createExtDriver(server, { allow: () => true })
const tab = (await driver.listTabs()).find((t) => t.projectId)
if (!tab) { console.log('RESULT: no project tab'); process.exit(1) }
if (process.env.RAW === '1') { console.log('raw fetchMedia:', JSON.stringify(await server.send('fetchMedia', { tabId: Number(tab.tabId), mediaId: ids[0].id, filename: 'raw-check.bin' }).catch((e) => String(e)))); process.exit(0) }
const tmp = mkdtempSync(join(tmpdir(), 'tf-dl-'))
const db = openDb(join(tmp, 'toolflow.db'))
const root = join(tmp, 'root')
for (const [i, o] of ids.slice(0, N).entries()) {
  const t0 = Date.now()
  const loc = await server.send('locate', { tabId: Number(tab.tabId), mediaId: o.id }).catch((e) => String(e))
  console.log(`#${i + 1} locate:`, JSON.stringify(loc))
  const row = await requestDownload(db, driver, { attemptId: `live-${i}`, mediaId: o.id, tab: tab.tabId, batchLabel: 'live', at: Date.now(), index: i + 1, prompt: 'live download check', tz: 'Asia/Ho_Chi_Minh' }, { root, now: () => Date.now(), sleep })
  console.log(`#${i + 1} state=${row.state} err=${row.error_code ?? '-'} bytes=${row.bytes ?? '-'} name=${row.actual_name ?? '-'} ${Date.now() - t0}ms receipt=${o.w}x${o.h}`)
  if (row.state === 'completed') {
    const f = join(root, row.actual_name!)
    const b = readFileSync(f)
    const kind = b.subarray(0, 4).toString('hex') === '89504e47' ? 'PNG' : b.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'JPEG' : b.subarray(8, 12).toString() === 'WEBP' ? 'WEBP' : '??'
    const dim = kind === 'PNG' ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : '?'
    console.log(`   file exists=${existsSync(f)} type=${kind} png-dim=${dim}`)
  }
}
console.log('call counts: no generate ops were sent (script only uses locate/fetchMedia/downloads)')
process.exit(0)
