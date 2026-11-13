import { test, expect } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { openDb } from '../src/main/db'
import { createFakeDriver, FAKE_COMBOS, type DownloadScript } from '../src/main/fake-driver'
import { createRunner } from '../src/main/runner'
import { createDownloader } from '../src/main/downloads'
import { createHandlers, revisioned, DEFAULT_DRAFT, type Draft } from '../src/main/ipc'
import { createAssetStore } from '../src/main/assets'

const M = ['3f2b9c1e-1111-4222-8333-444455556660', '3f2b9c1e-1111-4222-8333-444455556661']
function rig(script: DownloadScript[] = [], thumb: (b: Buffer) => Buffer | null = () => null) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-dlipc-'))
  const db = openDb(join(dir, 't.db'))
  const root = join(dir, 'root'), tmp = join(dir, 'tmp', 'ToolFlow-tmp')
  const fake = createFakeDriver([], { downloads: script, downloadsDir: tmp, assets: createAssetStore(db) })
  const clock = { now: () => 1_000_000 }
  const runner = createRunner({ db, driver: fake, clock, tabs: ['t1'], speed: 'default', combos: FAKE_COMBOS, autoAllowed: () => true })
  const events: string[] = [], revealed: string[] = []
  let draft: Draft = { ...DEFAULT_DRAFT, text: '' }
  const downloader = createDownloader({ db, driver: fake, root, tz: 'UTC', now: clock.now, sleep: async () => {}, tab: () => 't1', onChange: (b) => events.push(b) })
  const h = createHandlers({ db, runner, clock, grants: { use: () => {} }, projects: () => ['p'], email: async () => null, session: async () => ({}), pickPaths: async () => [], getDraft: () => draft, saveDraft: (d) => { draft = d }, emit: revisioned(() => {}), downloader, reveal: (p) => revealed.push(p), thumb })
  return { dir, root, tmp, db, h, fake, events, revealed }
}
async function withBatch(r: ReturnType<typeof rig>) {
  const { batchId } = (await r.h.enqueueBatch({ commandId: 'c1', text: 'một\nhai', kind: 'image', mode: 'manual' })) as { batchId: string }
  const atts = r.db.prepare('select a.id id from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(batchId) as { id: string }[]
  atts.forEach((a, i) => r.db.prepare("update attempt set state_json=json_set(state_json,'$.outputs',json(?), '$.item','ready') where id=?").run(JSON.stringify([{ mediaId: M[i] }]), a.id))
  return { batchId, atts }
}

test('downloadBatch / retryDownload: every malformed argument is INVALID_ARGS, unknown ids NOT_FOUND', async () => {
  const r = rig()
  const { atts } = await withBatch(r)
  for (const a of [undefined, null, 5, '', {}, 'x'.repeat(300)]) await expect(r.h.downloadBatch(a)).rejects.toThrow(/INVALID_ARGS/)
  for (const a of [undefined, 'x', {}, { attemptId: atts[0].id }, { mediaId: M[0] }, { attemptId: 7, mediaId: M[0] }, { attemptId: atts[0].id, mediaId: ['x'] }])
    await expect(r.h.retryDownload(a)).rejects.toThrow(/INVALID_ARGS/)
  await expect(r.h.downloadBatch('no-such-batch')).rejects.toThrow(/NOT_FOUND/)
  await expect(r.h.retryDownload({ attemptId: atts[0].id, mediaId: M[1] })).rejects.toThrow(/NOT_FOUND/) // an output of the other attempt
  expect(r.fake.ledger.fetches).toBe(0)
  expect(r.db.prepare('select count(*) n from download').get()).toEqual({ n: 0 })
})

test('views carry per-output download state and the relative actualName only, never a path or url', async () => {
  const r = rig(['download-html'])
  const { batchId, atts } = await withBatch(r)
  const dl = (v: unknown) => (v as { items: { attempts: { downloads: Record<string, { state: string; actualName: string | null; errorCode: string | null }> }[] }[] }).items[0].attempts[0].downloads
  expect(dl(await r.h.getBatch(batchId))).toEqual({}) // nothing yet: the UI says Chưa tải
  await r.h.downloadBatch(batchId)
  expect(dl(await r.h.getBatch(batchId))[M[0]]).toEqual({ state: 'failed', actualName: null, errorCode: 'DOWNLOAD_NOT_IMAGE' }) // first fetch was HTML
  const second = ((await r.h.getBatch(batchId)) as { items: { attempts: { downloads: Record<string, { state: string }> }[] }[] }).items[1].attempts[0].downloads[M[1]]
  expect(second.state).toBe('completed')
  await r.h.retryDownload({ attemptId: atts[0].id, mediaId: M[0] })
  const v = (await r.h.listBatches()) as { batches: unknown[] }
  const att0 = (v.batches[0] as { items: { attempts: { downloads: Record<string, { state: string; actualName: string }> }[] }[] }).items[0].attempts[0]
  expect(att0.downloads[M[0]].state).toBe('completed')
  expect(att0.downloads[M[0]].actualName).toMatch(/^\d{4}-\d\d-\d\d_[0-9a-f]{8}\/001_một_3f2b9c1e\.png$/)
  const json = JSON.stringify(v)
  expect(json).not.toContain(r.root)
  expect(json).not.toContain(r.tmp)
  expect(json).not.toMatch(/https?:/)
  expect(r.events.length).toBeGreaterThan(0)
})

test('previewOutput / revealOutput: only a completed file that is really inside root; a link out, a deleted file or an unsaved output is refused', async () => {
  const r = rig()
  const { batchId, atts } = await withBatch(r)
  const one = { attemptId: atts[0].id, mediaId: M[0] }
  await expect(r.h.previewOutput(one)).rejects.toThrow(/NOT_FOUND/) // not downloaded yet
  for (const a of [undefined, {}, { attemptId: atts[0].id }]) await expect(r.h.previewOutput(a)).rejects.toThrow(/INVALID_ARGS/)
  await r.h.downloadBatch(batchId)
  const { url } = (await r.h.previewOutput(one)) as { url: string }
  expect(url).toMatch(/^data:image\/png;base64,iVBOR/) // the stub cannot shrink it: the file itself
  const small = rig([], (b) => (b.subarray(0, 4).toString('hex') === '89504e47' ? Buffer.from([0xff, 0xd8, 0xff, 0xe0]) : null))
  const s2 = await withBatch(small)
  await small.h.downloadBatch(s2.batchId)
  expect(((await small.h.previewOutput({ attemptId: s2.atts[0].id, mediaId: M[0] })) as { url: string }).url).toBe('data:image/jpeg;base64,/9j/4A==') // a thumbnail when main can make one
  await r.h.revealOutput(one)
  expect(r.revealed).toHaveLength(1)
  expect(r.revealed[0].startsWith(realpathSync(r.root) + sep)).toBe(true)
  const rel = (r.db.prepare('select actual_name n from download where attempt_id=?').get(atts[0].id) as { n: string }).n
  const outside = join(r.dir, 'outside.png')
  writeFileSync(outside, readFileSync(join(r.root, rel)))
  rmSync(join(r.root, rel))
  await expect(r.h.previewOutput(one)).rejects.toThrow(/NOT_FOUND/) // the user deleted it
  try { symlinkSync(outside, join(r.root, rel)) } catch (e) { // swapped for a link that points out of root
    if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') return // Windows: a file symlink needs admin or Developer Mode
    throw e
  }
  await expect(r.h.previewOutput(one)).rejects.toThrow(/PATH_ESCAPE/)
  expect(r.revealed).toHaveLength(1)
})

test('previewOutput: a thumbnail is made once per file and kept; the same file asked again is not decoded again, a file that changed on disk is', async () => {
  let made = 0
  const r = rig([], (b) => { made++; return b.subarray(0, 4).toString('hex') === '89504e47' ? Buffer.from([0xff, 0xd8, 0xff, 0xe0]) : null })
  const { batchId, atts } = await withBatch(r)
  await r.h.downloadBatch(batchId)
  const one = { attemptId: atts[0].id, mediaId: M[0] }, two = { attemptId: atts[1].id, mediaId: M[1] }
  const first = (await r.h.previewOutput(one)) as { url: string }
  for (let i = 0; i < 5; i++) expect(await r.h.previewOutput(one)).toEqual(first) // the screen opened again and again: decoded once (measured 20-50 ms each on the main process)
  await r.h.previewOutput(two)
  expect(made).toBe(2)
  const rel = (r.db.prepare('select actual_name n from download where attempt_id=?').get(atts[0].id) as { n: string }).n
  const file = join(r.root, rel), png = readFileSync(file)
  writeFileSync(file, Buffer.concat([png, Buffer.alloc(16)])) // the user edited the file: a new thumbnail
  await r.h.previewOutput(one)
  expect(made).toBe(3)
})

