import { test, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { openDb } from '../src/main/db'
import { createFakeDriver, FAKE_COMBOS } from '../src/main/fake-driver'
import { createRunner } from '../src/main/runner'
import { createDownloader } from '../src/main/downloads'
import { createAutoSaver } from '../src/main/autosave'
import { createHandlers, revisioned, type Draft } from '../src/main/ipc'
import { createAssetStore } from '../src/main/assets'

const M = ['3f2b9c1e-1111-4222-8333-444455556660', '3f2b9c1e-1111-4222-8333-444455556661', '3f2b9c1e-1111-4222-8333-444455556662']
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'tf-res-'))
  const db = openDb(join(dir, 't.db'))
  const root = join(dir, 'root'), bin = join(dir, 'bin'), out = join(dir, 'out')
  mkdirSync(bin)
  const fake = createFakeDriver([], { downloadsDir: join(dir, 'tmp', 'ToolFlow-tmp'), assets: createAssetStore(db) })
  const clock = { now: () => 1_800_000_000_000 }
  const runner = createRunner({ db, driver: fake, clock, tabs: ['t1'], speed: 'default', combos: FAKE_COMBOS, autoAllowed: () => true })
  let draft: Draft = { text: '', kind: 'image', mode: 'auto', speed: 'default', autoSave: true }
  const trashed: string[] = []
  let folder: string | null = out
  const downloader = createDownloader({ db, driver: fake, root, tz: 'UTC', now: clock.now, sleep: async () => {}, tab: () => 't1' })
  const h = createHandlers({
    db, runner, clock, grants: { use: () => {} }, projects: () => ['p'], email: async () => null, session: async () => ({}), pickPaths: async () => [], getDraft: () => draft, saveDraft: (d) => { draft = d }, emit: revisioned(() => {}), downloader, reveal: () => {}, thumb: () => null,
    trash: async (p) => { trashed.push(p); renameSync(p, join(bin, basename(p))) }, pickFolder: async () => folder,
  })
  return { dir, db, root, bin, out, fake, h, downloader, trashed, clock, pick: (f: string | null) => { folder = f } }
}
async function withBatch(r: ReturnType<typeof rig>, lines = ['một con mèo', 'hai, "chó"', 'ba']) {
  const { batchId } = (await r.h.enqueueBatch({ commandId: `c${Math.random()}`, text: lines.join('\n'), kind: 'image', mode: 'manual' })) as { batchId: string }
  const atts = (r.db.prepare('select a.id id from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(batchId) as { id: string }[]).map((a) => a.id)
  atts.forEach((a, i) => r.db.prepare("update attempt set state_json=json_set(state_json,'$.outputs',json(?), '$.item','ready') where id=?").run(JSON.stringify([{ mediaId: M[i] }]), a))
  return { batchId, atts, outs: atts.map((attemptId, i) => ({ attemptId, mediaId: M[i] })) }
}
const view = async (r: ReturnType<typeof rig>) => ((await r.h.listBatches()) as { batches: { items: { attempts: { outputs: string[]; tags: Record<string, string[]> }[] }[] }[] }).batches[0].items.map((it) => it.attempts[0])

test('tags: added to and removed from the chosen outputs, trimmed, shown in the view; bad tags and foreign outputs are refused', async () => {
  const r = rig()
  const { outs } = await withBatch(r)
  await r.h.tagOutputs({ outputs: outs.slice(0, 2), add: '  bìa sách ' })
  await r.h.tagOutputs({ outputs: outs.slice(1, 3), add: 'đẹp' })
  await r.h.tagOutputs({ outputs: outs.slice(1, 2), add: 'đẹp' }) // twice: still once
  expect((await view(r)).map((a) => a.tags)).toEqual([{ [M[0]]: ['bìa sách'] }, { [M[1]]: ['bìa sách', 'đẹp'] }, { [M[2]]: ['đẹp'] }])
  await r.h.tagOutputs({ outputs: outs, remove: 'bìa sách' })
  expect((await view(r)).map((a) => a.tags)).toEqual([{}, { [M[1]]: ['đẹp'] }, { [M[2]]: ['đẹp'] }])
  for (const a of [undefined, {}, { outputs: outs }, { outputs: outs, add: '' }, { outputs: outs, add: '   ' }, { outputs: outs, add: 'x'.repeat(31) }, { outputs: outs, add: 'a\nb' }, { outputs: [], add: 'x' }, { outputs: [{ attemptId: outs[0].attemptId, mediaId: M[1] }], add: 'x' }, { outputs: outs, add: 'x', remove: 'y' }])
    await expect(r.h.tagOutputs(a)).rejects.toThrow(/INVALID_ARGS/)
  for (let i = 0; i < 19; i++) await r.h.tagOutputs({ outputs: outs.slice(1, 2), add: `t${i}` })
  await expect(r.h.tagOutputs({ outputs: outs.slice(1, 2), add: 'one too many' })).rejects.toThrow(/TAG_LIMIT/)
})

test('delete: needs confirm:true; saved files go to the recycle bin (missing ones counted), outputs are hidden for good and never saved again by Tải tất cả, Thử lại or auto save', async () => {
  const r = rig()
  const { batchId, outs } = await withBatch(r)
  await r.h.downloadBatch(batchId) // all three saved
  const fetched = r.fake.ledger.fetches
  rmSync(r.downloader.file(outs[1].attemptId, outs[1].mediaId)) // the user removed one file by hand
  await expect(r.h.deleteOutputs({ outputs: outs.slice(0, 2) })).rejects.toThrow(/INVALID_ARGS/)
  await expect(r.h.deleteOutputs({ outputs: outs.slice(0, 2), confirm: 'yes' })).rejects.toThrow(/INVALID_ARGS/)
  expect(r.trashed).toEqual([])
  expect(await r.h.deleteOutputs({ outputs: outs.slice(0, 2), confirm: true })).toEqual({ deleted: 2, trashed: 1, missing: 1, failed: 0 })
  expect(readdirSync(r.bin)).toHaveLength(1)
  expect((await view(r)).map((a) => a.outputs)).toEqual([[], [], [M[2]]])
  // a deleted output whose save failed (or that was never saved) is never fetched again
  r.db.prepare("update download set state='failed' where attempt_id in (?, ?)").run(outs[0].attemptId, outs[1].attemptId)
  await r.h.downloadBatch(batchId)
  await expect(r.h.retryDownload(outs[0])).rejects.toThrow(/NOT_FOUND/)
  let t = r.clock.now()
  const saver = createAutoSaver({ db: r.db, now: () => t, enabled: () => true, downloader: r.downloader })
  for (const o of outs.slice(0, 2)) r.db.prepare("insert into journal_event(attempt_id,type,at,payload_json) values(?,'receipt',?,'{}')").run(o.attemptId, t)
  r.db.prepare('update download set updated_at=? where attempt_id in (?, ?)').run(t, outs[0].attemptId, outs[1].attemptId) // failed during this app session: auto save would try them again
  for (let i = 0; i < 3; i++) { t += 31_000; await saver.tick(); await new Promise((res) => setTimeout(res, 5)) }
  expect(r.fake.ledger.fetches).toBe(fetched)
  expect(r.db.prepare("select count(*) n from download where state='completed'").get()).toEqual({ n: 1 })
})

test('delete: a file the recycle bin refuses stays where it is and stays shown', async () => {
  const r = rig()
  const { batchId, outs } = await withBatch(r, ['một'])
  await r.h.downloadBatch(batchId)
  const h = createHandlers({ db: r.db, clock: r.clock, trash: async () => { throw new Error('EPERM') }, downloader: r.downloader, emit: revisioned(() => {}) } as never)
  expect(await h.deleteOutputs({ outputs: outs.slice(0, 1), confirm: true })).toEqual({ deleted: 0, trashed: 0, missing: 0, failed: 1 })
  expect((await view(r))[0].outputs).toEqual([M[0]])
})

test('export: copies the saved files into the chosen folder without overwriting, writes toolflow-export.csv (UTF-8 BOM, quoted), counts the unsaved ones', async () => {
  const r = rig()
  const { batchId, outs } = await withBatch(r)
  await r.h.downloadBatch(batchId)
  r.db.prepare("delete from download where attempt_id=?").run(outs[2].attemptId) // the third is not saved
  await r.h.tagOutputs({ outputs: outs.slice(0, 2), add: 'đẹp' })
  r.pick(null)
  expect(await r.h.exportOutputs({ outputs: outs })).toEqual({ canceled: true })
  r.pick(r.out)
  expect(await r.h.exportOutputs({ outputs: [outs[2]] })).toEqual({ copied: 0, skipped: 1, csv: null }) // nothing saved: no dialog, no file
  expect(existsSync(r.out)).toBe(false)
  expect(await r.h.exportOutputs({ outputs: outs })).toEqual({ copied: 2, skipped: 1, csv: 'toolflow-export.csv' })
  expect(await r.h.exportOutputs({ outputs: outs })).toEqual({ copied: 2, skipped: 1, csv: 'toolflow-export (2).csv' }) // again: nothing is overwritten
  const files = readdirSync(r.out).sort()
  expect(files).toHaveLength(6)
  expect(files.filter((f) => / \(2\)\.png$/.test(f))).toHaveLength(2)
  const csv = readFileSync(join(r.out, 'toolflow-export.csv'))
  expect(csv.subarray(0, 3).toString('hex')).toBe('efbbbf')
  const lines = csv.toString('utf8').slice(1).trim().split('\r\n')
  expect(lines[0]).toBe('"Tên tệp","Prompt","Nền tảng","Loại","Mã lô","Dòng","Thẻ","Lưu lúc"')
  expect(lines).toHaveLength(3)
  expect(lines[2]).toMatch(new RegExp(`^"002_[^"]+\\.png","hai, ""chó""","Flow","Ảnh","${batchId}","2","đẹp","\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d"$`))
  for (const a of [undefined, {}, { outputs: 'x' }, { outputs: [{ attemptId: 'nope', mediaId: M[0] }] }]) await expect(r.h.exportOutputs(a)).rejects.toThrow(/INVALID_ARGS/)
})
