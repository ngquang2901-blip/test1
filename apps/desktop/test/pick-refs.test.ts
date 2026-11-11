import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/main/db'
import { createFakeDriver, FAKE_COMBOS } from '../src/main/fake-driver'
import { createRunner } from '../src/main/runner'
import { createHandlers, revisioned, type Draft } from '../src/main/ipc'
import { registerAsset } from '../src/main/assets'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('tiny-png-bytes')])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-bytes')])

function rig(picked: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-pick-'))
  const db = openDb(join(dir, 't.db'))
  const clock = { now: () => 1_000_000 }
  const runner = createRunner({ db, driver: createFakeDriver([]), clock, tabs: ['t1'], speed: 'default', combos: FAKE_COMBOS, autoAllowed: () => true })
  let draft: Draft = { text: '', kind: 'image', mode: 'auto', speed: 'default' }
  const h = createHandlers({ db, runner, clock, grants: { use: () => {} }, projects: () => ['p'], email: async () => null, session: async () => ({}), getDraft: () => draft, saveDraft: (d) => { draft = d }, emit: revisioned(() => {}), pickPaths: async () => picked, downloader: { batch: async () => {}, retry: async () => {}, file: () => '' }, reveal: () => {}, thumb: () => null })
  const png = (name: string, buf = PNG) => { writeFileSync(join(dir, name), buf); return registerAsset(db, join(dir, name), 1) }
  return { dir, db, h, png }
}
const count = (db: ReturnType<typeof openDb>, t: string) => (db.prepare(`select count(*) n from ${t}`).get() as { n: number }).n
const base = { commandId: 'c1', kind: 'image', mode: 'auto' }

test('enqueueBatch refs: every malformed refs argument is INVALID_ARGS and creates nothing', async () => {
  const { h, db, png } = rig()
  const a = png('a.png')
  const ok = { assetIds: [a.id], mode: 'all', perItem: 1 }
  for (const refs of [
    { ...ok, mode: 'rotate' }, { ...ok, assetIds: ['no-such-asset'] }, { ...ok, assetIds: [a.id, a.id] }, { ...ok, assetIds: 'x' }, { ...ok, assetIds: [7] },
    { ...ok, perItem: 0 }, { ...ok, perItem: 9 }, { ...ok, perItem: 1.5 }, { ...ok, perItem: '2' }, 'all', null,
  ]) {
    await expect(h.enqueueBatch({ ...base, text: 'x', refs })).rejects.toThrow(/INVALID_ARGS/)
    await expect(h.enqueueBatch({ ...base, text: 'x', refs, dryRun: true })).rejects.toThrow(/INVALID_ARGS/)
  }
  expect(count(db, 'batch')).toBe(0)
})

test('video with refs is refused with REF_KIND_UNSUPPORTED (a video without refs still works)', async () => {
  const { h, db, png } = rig()
  const a = png('a.png')
  await expect(h.enqueueBatch({ ...base, kind: 'video', text: 'x', refs: { assetIds: [a.id], mode: 'all', perItem: 1 } })).rejects.toThrow(/REF_KIND_UNSUPPORTED/)
  expect(count(db, 'batch')).toBe(0)
  await h.enqueueBatch({ ...base, kind: 'video', text: 'x', refs: { assetIds: [], mode: 'none', perItem: 1 } })
  expect(count(db, 'batch')).toBe(1)
})

test('mapping errors block creation: no batch, no command row, no rotation or truncation (AC-04)', async () => {
  const { h, db, png } = rig()
  const [a, b] = [png('a.png'), png('b.jpg', JPG)]
  const seq = { assetIds: [a.id, b.id], mode: 'sequential', perItem: 1 }
  const short = (await h.enqueueBatch({ ...base, text: 'p1\np2\np3', refs: seq })) as { rows: { n: number; refs: string[]; error: string | null }[]; errors: { index: number; code: string }[]; batchId?: string }
  expect(short.batchId).toBeUndefined()
  expect(short.errors).toEqual([{ index: 2, code: 'NOT_ENOUGH_REFS' }])
  expect(short.rows.map((r) => r.refs)).toEqual([['a.png'], ['b.jpg'], []]) // the third prompt gets nothing, not a rotated first image
  expect(short.rows[2].error).toBe('NOT_ENOUGH_REFS')
  const many = (await h.enqueueBatch({ ...base, text: 'p1\np2', refs: { assetIds: [a.id, b.id], mode: 'all', perItem: 1 } })) as { errors: { code: string }[]; batchId?: string }
  expect(many.errors.map((e) => e.code)).toEqual(['TOO_MANY_REFS', 'TOO_MANY_REFS'])
  expect(many.batchId).toBeUndefined()
  expect(count(db, 'batch')).toBe(0)
  expect(count(db, 'item')).toBe(0)
  expect(count(db, 'command')).toBe(0)
})

test('valid mapping: dryRun shows asset names, the batch stores asset ids', async () => {
  const { h, db, png } = rig()
  const [a, b] = [png('a.png'), png('b.jpg', JPG)]
  const refs = { assetIds: [a.id, b.id], mode: 'sequential', perItem: 1 }
  const dry = (await h.enqueueBatch({ ...base, text: 'p1\np2', refs, dryRun: true })) as { rows: { refs: string[] }[]; errors: unknown[] }
  expect(dry.rows.map((r) => r.refs)).toEqual([['a.png'], ['b.jpg']])
  expect(dry.errors).toEqual([])
  expect(count(db, 'batch')).toBe(0)
  const r = (await h.enqueueBatch({ ...base, text: 'p1\np2', refs })) as { batchId: string }
  expect((db.prepare('select refs_json r from item where batch_id=? order by ord').all(r.batchId) as { r: string }[]).map((x) => JSON.parse(x.r))).toEqual([[a.id], [b.id]])
  const shared = (await h.enqueueBatch({ ...base, commandId: 'c2', text: 'p1\np2', refs: { assetIds: [a.id, b.id], mode: 'all', perItem: 2 } })) as { batchId: string }
  expect((db.prepare('select refs_json r from item where batch_id=?').all(shared.batchId) as { r: string }[]).map((x) => JSON.parse(x.r))).toEqual([[a.id, b.id], [a.id, b.id]])
})

test('pickRefs registers assets and returns ids/names/sizes plus error codes only, never a path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-pick-src-'))
  const f = (n: string, b: Buffer | string) => { writeFileSync(join(dir, n), b); return join(dir, n) }
  const paths = [f('good.png', PNG), f('photo.jpeg', JPG), f('empty.png', ''), f('text.png', 'not a picture'), join(dir, 'missing.png')]
  const { h, db } = rig(paths)
  const r = (await h.pickRefs()) as { assets: { id: string; name: string; bytes: number }[]; errors: { code: string }[] }
  expect(r.assets.map((a) => [a.name, a.bytes])).toEqual([['good.png', PNG.length], ['photo.jpeg', JPG.length]])
  expect(r.assets.every((a) => Object.keys(a).sort().join() === 'bytes,id,name')).toBe(true)
  expect(r.errors).toEqual([{ code: 'ASSET_EMPTY' }, { code: 'ASSET_UNSUPPORTED' }, { code: 'ASSET_UNREADABLE' }])
  expect(JSON.stringify(r)).not.toContain(dir)
  expect(count(db, 'asset')).toBe(2)
  // the registered ids are usable as a pool right away
  await expect(h.enqueueBatch({ ...base, text: 'x', refs: { assetIds: [r.assets[0].id], mode: 'all', perItem: 1 }, dryRun: true })).resolves.toBeTruthy()
})

test('pickRefs with nothing picked (dialog cancelled) is an empty result', async () => {
  const { h } = rig([])
  expect(await h.pickRefs()).toEqual({ assets: [], errors: [] })
})

test('presets: save, list with ref names (never paths), same name updates, missing asset flagged, bad input refused', async () => {
  const { h, db, png } = rig()
  const a = png('a.png')
  const p = { name: 'Phở buổi sáng', kind: 'image', mode: 'manual', refs: { assetIds: [a.id], mode: 'all', perItem: 1 }, template: { template: '{món} ở {nơi}', how: 'zip', lists: { món: 'phở\nbún', nơi: 'Hà Nội\nHuế' } } }
  const { id } = (await h.savePreset(p)) as { id: string }
  let list = (await h.listPresets()) as any[]
  expect(list).toEqual([{ id, name: 'Phở buổi sáng', kind: 'image', mode: 'manual', refs: { assetIds: [a.id], mode: 'all', perItem: 1, assets: [{ id: a.id, name: 'a.png', bytes: a.bytes }] }, template: p.template }])
  expect(JSON.stringify(list)).not.toContain('/') // no path reaches the renderer
  expect(((await h.savePreset({ ...p, name: ' Phở buổi sáng ', mode: 'auto' })) as { id: string }).id).toBe(id) // same name: one preset, updated
  list = (await h.listPresets()) as any[]
  expect(list.map((x) => x.mode)).toEqual(['auto'])
  db.prepare('delete from asset where id=?').run(a.id) // the file's record is gone
  expect(((await h.listPresets()) as any[])[0].refs.assets[0]).toEqual({ id: a.id, name: '', bytes: 0, missing: true })
  for (const bad of [{ ...p, name: '' }, { ...p, name: 'x'.repeat(61) }, { ...p, kind: 'gif' }, { ...p, refs: { ...p.refs, assetIds: ['nope'] } }, { ...p, refs: { ...p.refs, perItem: 9 } }, { ...p, template: { ...p.template, how: 'x' } }, null])
    await expect(h.savePreset(bad)).rejects.toThrow(/INVALID_ARGS/)
  await h.deletePreset(id)
  expect(await h.listPresets()).toEqual([])
  expect(count(db, 'preset')).toBe(0)
})

test('presets: the chosen model / aspect / count is kept as the profile\'s own object; settings the profile does not offer are refused', async () => {
  const { h } = rig()
  const p = { name: 'Dọc Pro', kind: 'image', mode: 'auto', refs: { assetIds: [], mode: 'none', perItem: 1 }, template: { template: '', how: 'all', lists: {} } }
  const combo = { count: 3, aspect: '9:16', model: 'Nano Banana Pro', mode: 'Image', kind: 'image' }
  await h.savePreset({ ...p, combo })
  expect(((await h.listPresets()) as any[])[0].combo).toEqual({ kind: 'image', mode: 'Image', model: 'Nano Banana Pro', aspect: '9:16', count: 3 })
  for (const bad of [{ ...combo, count: 9 }, { ...combo, model: 'Imagen 9' }, { ...combo, kind: 'video' }, 'x', null])
    await expect(h.savePreset({ ...p, name: 'x', combo: bad }), JSON.stringify(bad)).rejects.toThrow(/INVALID_ARGS/)
  await h.savePreset(p) // saved again without settings: the preset carries none (the app default applies)
  expect(((await h.listPresets()) as any[])[0]).not.toHaveProperty('combo')
})
