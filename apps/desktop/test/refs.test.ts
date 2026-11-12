import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDb } from '../src/main/db'
import { enqueueBatch } from '../src/main/batch'
import { createRunner } from '../src/main/runner'
import { createFakeDriver, createFakeFlow, FAKE_COMBOS, type UploadScript } from '../src/main/fake-driver'
import { registerAsset, uploadName, createAssetStore, type AssetStore, type Binding } from '../src/main/assets'
import { createExtDriver, decideCheck, type CheckInput } from '../src/main/connector/ext-driver'
import { DEFAULT_COMBO } from '../src/main/profile'
import { createHandlers } from '../src/main/ipc'

const P = 'cb7b8a3e-0000-4000-8000-000000000001'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('payload-bytes')])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-bytes')])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')])
const dir = () => mkdtempSync(join(tmpdir(), 'tf-ref-'))

// ---- registerAsset / uploadName / store ----
test('registerAsset: sniffs magic bytes (png/jpeg/webp), returns id, basename, mime, bytes', () => {
  const d = dir(), db = openDb(join(d, 't.db'))
  for (const [file, buf, mime] of [['a.png', PNG, 'image/png'], ['b.jpeg', JPG, 'image/jpeg'], ['c.webp', WEBP, 'image/webp']] as const) {
    writeFileSync(join(d, file), buf)
    const r = registerAsset(db, join(d, file), 1000)
    expect(r).toMatchObject({ name: file, mime, bytes: buf.length })
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/)
  }
})

test('registerAsset: the type comes from the bytes, not the name; empty and oversize are refused; errors carry codes only', () => {
  const d = dir(), db = openDb(join(d, 't.db'))
  const code = (f: string) => { try { registerAsset(db, join(d, f), 1); return 'no error' } catch (e) { expect((e as Error).message).not.toContain(d); return (e as { code: string }).code } }
  writeFileSync(join(d, 'fake.png'), 'this is just text, not a picture')
  writeFileSync(join(d, 'empty.png'), '')
  writeFileSync(join(d, 'big.png'), Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]))
  writeFileSync(join(d, 'edge.png'), Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024 - PNG.length)]))
  expect(code('fake.png')).toBe('ASSET_UNSUPPORTED')
  expect(code('empty.png')).toBe('ASSET_EMPTY')
  expect(code('big.png')).toBe('ASSET_TOO_LARGE')
  expect(code('edge.png')).toBe('no error') // exactly 20 MB is allowed
  expect(code('missing.png')).toBe('ASSET_UNREADABLE')
})

test('registerAsset: same path + same bytes ⇒ same id; same bytes at another path ⇒ another asset; changed bytes ⇒ another asset', () => {
  const d = dir(), db = openDb(join(d, 't.db'))
  writeFileSync(join(d, 'a.png'), PNG); writeFileSync(join(d, 'b.png'), PNG)
  const a1 = registerAsset(db, join(d, 'a.png'), 1), a2 = registerAsset(db, join(d, 'a.png'), 2), b = registerAsset(db, join(d, 'b.png'), 3)
  expect(a2.id).toBe(a1.id)
  expect(b.id).not.toBe(a1.id)
  writeFileSync(join(d, 'a.png'), Buffer.concat([PNG, Buffer.from('v2')]))
  expect(registerAsset(db, join(d, 'a.png'), 4).id).not.toBe(a1.id)
  expect((db.prepare('select count(*) n from asset').get() as { n: number }).n).toBe(3)
})

test('uploadName: tf- + first 8 of the id + base36 time + extension from the mime', () => {
  const id = '0123abcd-4444-4555-8666-777788889999'
  expect(uploadName(id, 'image/png', 1_700_000_000_000)).toBe(`tf-0123abcd-${(1_700_000_000_000).toString(36)}.png`)
  expect(uploadName(id, 'image/jpeg', 5)).toBe('tf-0123abcd-5.jpg')
  expect(uploadName(id, 'image/webp', 5)).toBe('tf-0123abcd-5.webp')
})

test('asset store: bytes are re-verified against the sha256; bindings survive a restart (new store, same db)', () => {
  const d = dir(), db = openDb(join(d, 't.db'))
  writeFileSync(join(d, 'a.png'), PNG)
  const { id } = registerAsset(db, join(d, 'a.png'), 1)
  const s = createAssetStore(db)
  expect(s.get(id)!.bytes().equals(PNG)).toBe(true)
  expect(s.get('nope')).toBeNull()
  expect(s.binding(id, P)).toBeNull()
  const b: Binding = { assetId: id, projectId: P, uploadName: 'tf-x.png', mediaId: null, state: 'uploading', intentAt: 7 }
  s.writeBinding(b)
  expect(createAssetStore(db).binding(id, P)).toEqual(b)
  s.writeBinding({ ...b, state: 'bound', mediaId: 'u1' })
  expect(createAssetStore(db).binding(id, P)).toMatchObject({ state: 'bound', mediaId: 'u1', uploadName: 'tf-x.png' })
  expect(createAssetStore(db).binding(id, 'other-project')).toBeNull()
  writeFileSync(join(d, 'a.png'), Buffer.concat([PNG, Buffer.from('tampered')]))
  expect(() => s.get(id)!.bytes()).toThrow()
})

// ---- ext-driver against a fake Flow (library + chips) ----
function mem() {
  const files = new Map<string, { name: string; mime: string; bytes: Buffer }>()
  const rows = new Map<string, Binding>()
  const store: AssetStore = {
    get: (id) => { const f = files.get(id); return f ? { name: f.name, mime: f.mime, bytes: () => f.bytes } : null },
    binding: (a, p) => rows.get(`${a}|${p}`) ?? null,
    writeBinding: (b) => void rows.set(`${b.assetId}|${b.projectId}`, { ...b }),
  }
  const add = (bytes = PNG, name = 'photo.png') => { const id = randomUUID(); files.set(id, { name, mime: 'image/png', bytes }); return id }
  return { store, add, rows }
}
function rig(script: UploadScript[] = [], o: Parameters<typeof createFakeFlow>[1] = {}) {
  const flow = createFakeFlow(script, o), m = mem(), clock = { t: 1_700_000_000_000 }
  const driver = createExtDriver(flow.server, { allow: () => true, assets: m.store, now: () => clock.t, sleep: async (ms) => { clock.t += ms } })
  const prepare = (refIds: string[], projectId: string | null = P) => driver.prepare('7', { prompt: 'a prompt', kind: 'image', settings: { combo: DEFAULT_COMBO }, refIds, projectId: projectId ?? undefined })
  return { flow, m, driver, prepare, clock }
}

test('video from a start frame: the composer goes to Frames and the image is attached through the Start slot; an image names no slot', async () => {
  const spy = (t: ReturnType<typeof rig>) => { const seen: Array<[string, Record<string, unknown>]> = [], send = t.flow.server.send.bind(t.flow.server); t.flow.server.send = async (op, args) => { seen.push([op, args]); return send(op, args) }; return seen }
  const t = rig(), a = t.m.add(), seen = spy(t)
  const combo = { kind: 'video', mode: 'Video', model: 'Veo 3.1 - Lite', aspect: '9:16', count: 1 }
  expect(await t.driver.prepare('7', { prompt: 'a prompt', kind: 'video', settings: { combo }, refIds: [a], projectId: P })).toEqual({ ok: true })
  expect(seen.find(([op]) => op === 'settings')![1]).toMatchObject({ mode: 'Video', input: 'Frames' })
  const attaches = seen.filter(([op]) => op === 'attach')
  expect([attaches.length > 0, attaches.every(([, x]) => x.slot === 'start')]).toEqual([true, true])
  expect(t.flow.chips()).toEqual([t.m.store.binding(a, P)!.mediaId])
  const e = rig(), s1 = e.m.add(), s2 = e.m.add(), ends = spy(e) // a second image: the end frame, through the End slot
  expect(await e.driver.prepare('7', { prompt: 'a prompt', kind: 'video', settings: { combo }, refIds: [s1, s2], projectId: P })).toEqual({ ok: true })
  expect(ends.filter(([op]) => op === 'attach').map(([, x]) => x.slot).filter((v, k, l) => l.indexOf(v) === k)).toEqual(['start', 'end'])
  expect(e.flow.chips()).toEqual([e.m.store.binding(s1, P)!.mediaId, e.m.store.binding(s2, P)!.mediaId])
  const i = rig(), b = i.m.add(), plain = spy(i)
  expect(await i.prepare([b])).toEqual({ ok: true })
  expect(plain.filter(([op]) => op === 'attach').some(([, x]) => 'slot' in x)).toBe(false)
})

test('upload-no-ack: one upload across two prepares, both REF_UPLOAD_UNCERTAIN, binding uncertain', async () => {
  const t = rig(['upload-no-ack']), a = t.m.add()
  expect(await t.prepare([a])).toEqual({ ok: false, code: 'REF_UPLOAD_UNCERTAIN' })
  expect(t.m.store.binding(a, P)!.state).toBe('uncertain')
  expect(await t.prepare([a])).toEqual({ ok: false, code: 'REF_UPLOAD_UNCERTAIN' })
  expect(t.flow.uploadsOf(a)).toBe(1)
  expect(t.flow.uploads).toHaveLength(1)
})

test('upload-late-ack: found after a few polls ⇒ bound to the media uuid, exactly one upload, chip present', async () => {
  const t = rig(['upload-late-ack'], { lateAfter: 3 }), a = t.m.add()
  expect(await t.prepare([a])).toEqual({ ok: true })
  const b = t.m.store.binding(a, P)!
  expect(b).toMatchObject({ state: 'bound' })
  expect(t.flow.chips()).toEqual([b.mediaId])
  expect(t.flow.uploadsOf(a)).toBe(1)
  expect(t.flow.hows).toEqual(['drop']) // paste is not reliable (Q-32)
})

test('the upload intent is durable BEFORE the bytes are sent, and the name is generated once', async () => {
  const t = rig([], { onFile: () => seen.push(t.m.store.binding(a, P)) }), a = t.m.add(), seen: Array<Binding | null> = []
  expect(await t.prepare([a])).toEqual({ ok: true })
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ state: 'uploading', mediaId: null, intentAt: 1_700_000_000_000 })
  expect(seen[0]!.uploadName).toBe(t.flow.uploads[0])
  expect(t.m.store.binding(a, P)!.uploadName).toBe(t.flow.uploads[0])
})

test('Q-19: chip lost, re-prepare ⇒ attach by name only, 0 new uploads, same media id', async () => {
  const t = rig(), a = t.m.add()
  expect(await t.prepare([a])).toEqual({ ok: true })
  const media = t.m.store.binding(a, P)!.mediaId
  t.flow.dropChips()
  expect(await t.prepare([a])).toEqual({ ok: true })
  expect(t.flow.uploadsOf(a)).toBe(1)
  expect(t.flow.chips()).toEqual([media])
})

test('chip still there on re-prepare ⇒ no attach at all', async () => {
  const t = rig(), a = t.m.add()
  await t.prepare([a])
  t.flow.attaches = 0
  // the composer text from the previous prompt is cleared first, which also drops chips; with a clean composer the chip is kept
  t.flow.setText('')
  expect(await t.prepare([a])).toEqual({ ok: true })
  expect(t.flow.attaches).toBe(0)
})

test('two assets with identical bytes: distinct upload names, each bound to its own media id', async () => {
  const t = rig(), a = t.m.add(PNG, 'one.png'), b = t.m.add(PNG, 'two.png')
  expect(await t.prepare([a, b])).toEqual({ ok: true })
  const [ba, bb] = [t.m.store.binding(a, P)!, t.m.store.binding(b, P)!]
  expect(ba.uploadName).not.toBe(bb.uploadName)
  expect(ba.mediaId).not.toBe(bb.mediaId)
  expect(t.flow.uploadsOf(a)).toBe(1); expect(t.flow.uploadsOf(b)).toBe(1)
  expect(new Set(t.flow.chips())).toEqual(new Set([ba.mediaId, bb.mediaId]))
  expect(t.flow.libraryMedia(ba.uploadName)).toBe(ba.mediaId)
})

test('a binding left in uploading (crash after intent): never upload again; attach once; found ⇒ bound', async () => {
  const t = rig(), a = t.m.add()
  t.m.store.writeBinding({ assetId: a, projectId: P, uploadName: 'tf-deadbeef-abc.png', mediaId: null, state: 'uploading', intentAt: 1 })
  t.flow.addToLibrary('tf-deadbeef-abc.png')
  expect(await t.prepare([a])).toEqual({ ok: true })
  expect(t.flow.uploads).toHaveLength(0)
  expect(t.m.store.binding(a, P)).toMatchObject({ state: 'bound', uploadName: 'tf-deadbeef-abc.png' })
})

test('uncertain binding not in the library: REF_UPLOAD_UNCERTAIN after ONE attach, still no upload', async () => {
  const t = rig(), a = t.m.add()
  t.m.store.writeBinding({ assetId: a, projectId: P, uploadName: 'tf-deadbeef-abc.png', mediaId: null, state: 'uncertain', intentAt: 1 })
  expect(await t.prepare([a])).toEqual({ ok: false, code: 'REF_UPLOAD_UNCERTAIN' })
  expect(t.flow.uploads).toHaveLength(0)
  expect(t.flow.attaches).toBe(1)
})

test('I4a: an uploading binding found at prepare start (restart mid-upload) gets the same 30 s attach window as a fresh upload, then REF_UPLOAD_UNCERTAIN, still no upload', async () => {
  const t = rig(), a = t.m.add()
  t.m.store.writeBinding({ assetId: a, projectId: P, uploadName: 'tf-deadbeef-abc.png', mediaId: null, state: 'uploading', intentAt: 1 })
  const t0 = t.clock.t
  expect(await t.prepare([a])).toEqual({ ok: false, code: 'REF_UPLOAD_UNCERTAIN' })
  expect(t.clock.t - t0).toBeGreaterThanOrEqual(30_000)
  expect(t.flow.attaches).toBeGreaterThan(20)
  expect(t.flow.uploads).toHaveLength(0)
  expect(t.m.store.binding(a, P)!.state).toBe('uncertain')
})

test('I4a: an uploading binding whose upload is still processing shows up inside the window ⇒ bound, no new upload', async () => {
  const t = rig(), a = t.m.add()
  t.m.store.writeBinding({ assetId: a, projectId: P, uploadName: 'tf-deadbeef-abc.png', mediaId: null, state: 'uploading', intentAt: 1 })
  t.flow.addToLibrary('tf-deadbeef-abc.png', 4) // answers NOT_FOUND four times first
  expect(await t.prepare([a])).toEqual({ ok: true })
  expect(t.flow.uploads).toHaveLength(0)
  expect(t.m.store.binding(a, P)).toMatchObject({ state: 'bound' })
})

test('bound binding whose library item now resolves to another media ⇒ REF_MISMATCH (no silent rebind)', async () => {
  const t = rig(), a = t.m.add()
  t.m.store.writeBinding({ assetId: a, projectId: P, uploadName: 'tf-deadbeef-abc.png', mediaId: 'the-old-uuid', state: 'bound', intentAt: 1 })
  t.flow.addToLibrary('tf-deadbeef-abc.png')
  expect(await t.prepare([a])).toEqual({ ok: false, code: 'REF_MISMATCH' })
  expect(t.m.store.binding(a, P)!.mediaId).toBe('the-old-uuid')
  expect(t.flow.uploads).toHaveLength(0)
})

test('leftover chips that are not ours: the composer is cleared first and ends with exactly ours', async () => {
  const t = rig(), a = t.m.add()
  t.flow.setChips(['stray-1', 'stray-2'])
  expect(await t.prepare([a])).toEqual({ ok: true })
  expect(t.flow.chips()).toEqual([t.m.store.binding(a, P)!.mediaId])
  const none = rig(); none.flow.setChips(['stray']) // no refs at all: still cleared
  expect(await none.prepare([])).toEqual({ ok: true })
  expect(none.flow.chips()).toEqual([])
})

test('composer that will not clear ⇒ COMPOSER_NOT_CLEAR, nothing uploaded', async () => {
  const t = rig([], { stuckChips: true }), a = t.m.add()
  t.flow.setChips(['stray'])
  expect(await t.prepare([a])).toEqual({ ok: false, code: 'COMPOSER_NOT_CLEAR' })
  expect(t.flow.uploads).toHaveLength(0)
})

test('chip set after the prompt is typed must equal the bound media ids: stray chip ⇒ CHIP_MISMATCH', async () => {
  const t = rig([], { strayOnPrep: true }), a = t.m.add()
  expect(await t.prepare([a])).toEqual({ ok: false, code: 'CHIP_MISMATCH' })
})

test('ref failures never leak the asset name, path or bytes', async () => {
  const t = rig(['upload-no-ack']), a = t.m.add(PNG, 'SECRET-name.png')
  const r = await t.prepare([a])
  expect(JSON.stringify(r)).not.toMatch(/SECRET|photo|payload-bytes|tf-/)
})

test('refs without a project, an asset store or a known asset fail closed before any page work', async () => {
  const t = rig(), a = t.m.add()
  expect(await t.prepare([a], null)).toEqual({ ok: false, code: 'REF_ASSET_MISSING' })
  expect(await t.prepare([randomUUID()])).toEqual({ ok: false, code: 'REF_ASSET_MISSING' })
  const bare = createExtDriver(t.flow.server, { allow: () => true })
  expect(await bare.prepare('7', { prompt: 'p', kind: 'image', settings: { combo: DEFAULT_COMBO }, refIds: [a], projectId: P })).toEqual({ ok: false, code: 'REF_ASSET_MISSING' })
  expect(t.flow.uploads).toHaveLength(0)
})

test('I2: a tab on another project => TARGET_CHANGED before any page op; no upload, the binding table is untouched', async () => {
  for (const tabPath of ['/fx/tools/flow/project/11111111-2222-4333-8444-555555555555', null]) {
    const t = rig([], { tabPath }), a = t.m.add(), b = t.m.add()
    t.m.store.writeBinding({ assetId: b, projectId: P, uploadName: 'tf-keep-1.png', mediaId: null, state: 'uncertain', intentAt: 1 })
    const before = JSON.stringify([...t.m.rows])
    expect(await t.prepare([a, b])).toEqual({ ok: false, code: 'TARGET_CHANGED' })
    expect(t.flow.ops).toEqual(['tabs']) // not settings / state / file / attach / prep
    expect(t.flow.uploads).toHaveLength(0)
    expect(JSON.stringify([...t.m.rows])).toBe(before)
    expect(t.m.store.binding(a, P)).toBeNull()
  }
})

// ---- checkBeforeClick: chip set == bound media ids ----
const good = (): CheckInput => ({
  tabProject: P, projectId: P, refMedia: [],
  ping: { xhrSend: true, xhrOpen: true, fetch: true }, probe: { present: { editor: true, submit: true } },
  state: { submitDisabled: false, creditWarning: false, chips: [] }, hit: { covered: false },
})
test('decideCheck chip identity table', () => {
  const mut = (f: (c: CheckInput) => void) => { const c = good(); f(c); return c }
  const rows: Array<[string, CheckInput, string | null]> = [
    ['no refs, no chips', good(), null],
    ['two refs, same chips in another order', mut((c) => { c.refMedia = ['a', 'b']; c.state!.chips = ['b', 'a'] }), null],
    ['same count, wrong uuid', mut((c) => { c.refMedia = ['a']; c.state!.chips = ['zzz'] }), 'CHIP_MISMATCH'],
    ['extra chip', mut((c) => { c.refMedia = ['a']; c.state!.chips = ['a', 'x'] }), 'CHIP_MISMATCH'],
    ['missing chip', mut((c) => { c.refMedia = ['a', 'b']; c.state!.chips = ['a'] }), 'CHIP_MISMATCH'],
    ['unbound ref (null media)', mut((c) => { c.refMedia = [null]; c.state!.chips = ['x'] }), 'CHIP_MISMATCH'],
    ['unbound ref, empty chips', mut((c) => { c.refMedia = [null]; c.state!.chips = [] }), 'CHIP_MISMATCH'],
    ['chip without uuid', mut((c) => { c.refMedia = ['a']; c.state!.chips = [undefined] }), 'CHIP_MISMATCH'],
    ['chips on a no-ref prompt', mut((c) => { c.state!.chips = ['x'] }), 'CHIP_MISMATCH'],
    ['I3: duplicate chips vs two distinct media', mut((c) => { c.refMedia = ['a', 'b']; c.state!.chips = ['a', 'a'] }), 'CHIP_MISMATCH'],
    ['I3: duplicate chips vs one media', mut((c) => { c.refMedia = ['a']; c.state!.chips = ['a', 'a'] }), 'CHIP_MISMATCH'],
    ['I3: duplicate chips, no refs', mut((c) => { c.state!.chips = ['a', 'a'] }), 'CHIP_MISMATCH'],
    ['same asset twice, one chip', mut((c) => { c.refMedia = ['a', 'a']; c.state!.chips = ['a'] }), null],
  ]
  for (const [name, c, code] of rows) expect(decideCheck(c), name).toEqual(code ? { ok: false, code } : { ok: true })
})

test('checkBeforeClick reads bindings for this project only: bound ⇒ ok; uploading/uncertain/none ⇒ CHIP_MISMATCH', async () => {
  const t = rig(), a = t.m.add()
  const world = (chips: string[]) => ({ send: async (op: string) => ({ tabs: [{ tabId: 7, path: `/fx/tools/flow/project/${P}`, active: true }], ping: { xhrSend: true, xhrOpen: true, fetch: true }, probe: { present: { editor: true, submit: true } }, state: { submitDisabled: false, creditWarning: false, chips }, hit: { covered: false } } as Record<string, unknown>)[op], onEvent: () => () => {} })
  const d = (chips: string[]) => createExtDriver(world(chips) as never, { allow: () => true, assets: t.m.store })
  const bind = (state: Binding['state'], media: string | null, project = P) => t.m.store.writeBinding({ assetId: a, projectId: project, uploadName: 'n', mediaId: media, state, intentAt: 1 })
  expect(await d(['m1']).checkBeforeClick('7', P, [a])).toEqual({ ok: false, code: 'CHIP_MISMATCH' })
  bind('bound', 'm1', 'another-project')
  expect(await d(['m1']).checkBeforeClick('7', P, [a])).toEqual({ ok: false, code: 'CHIP_MISMATCH' })
  for (const s of ['uploading', 'uncertain'] as const) { bind(s, null); expect(await d([]).checkBeforeClick('7', P, [a]), s).toEqual({ ok: false, code: 'CHIP_MISMATCH' }) }
  bind('bound', 'm1')
  expect(await d(['m1']).checkBeforeClick('7', P, [a])).toEqual({ ok: true })
  expect(await d(['m1', 'x']).checkBeforeClick('7', P, [a])).toEqual({ ok: false, code: 'CHIP_MISMATCH' })
  expect(await d(['x']).checkBeforeClick('7', P, [a])).toEqual({ ok: false, code: 'CHIP_MISMATCH' })
})

// ---- runner: REF_UPLOAD_UNCERTAIN pauses the batch for the user ----
test('runner: a prepare that fails REF_UPLOAD_UNCERTAIN pauses the batch, no click, no retry loop', async () => {
  const db = openDb(join(dir(), 't.db'))
  const fake = createFakeDriver(['image-ok', 'image-ok', 'image-ok'], { prepare: ['REF_UPLOAD_UNCERTAIN'] })
  const { batchId } = enqueueBatch(db, { commandId: 'c', kind: 'image', projectId: 'p', settings: { combo: DEFAULT_COMBO }, mode: 'auto', prompts: ['a', 'b', 'c'], refs: [['r1'], ['r1'], ['r1']] })
  const runner = createRunner({ db, driver: fake, clock: { now: () => Date.now() }, tabs: ['t1'], speed: 'default', autoAllowed: () => true, combos: FAKE_COMBOS })
  runner.start(batchId)
  for (let i = 0; i < 5; i++) { await runner.tick(); await new Promise((r) => setTimeout(r, 0)) }
  expect(runner.lastError(batchId)).toBe('REF_UPLOAD_UNCERTAIN')
  expect((db.prepare('select status from batch').get() as { status: string }).status).toBe('paused')
  expect(fake.ledger).toMatchObject({ prepares: 1, clicks: 0 })
})

test('runner: prepare gets the project id, so bindings are per project', async () => {
  const db = openDb(join(dir(), 't.db'))
  const fake = createFakeDriver(['image-ok'])
  const seen: unknown[] = []
  const driver = { ...fake, prepare: async (t: string, p: Parameters<typeof fake.prepare>[1]) => (seen.push(p.projectId), fake.prepare(t, p)) }
  const { batchId } = enqueueBatch(db, { commandId: 'c', kind: 'image', projectId: 'proj-9', settings: { combo: DEFAULT_COMBO }, mode: 'auto', prompts: ['a'], refs: [[]] })
  const runner = createRunner({ db, driver: driver as never, clock: { now: () => Date.now() }, tabs: ['t1'], speed: 'default', autoAllowed: () => true, combos: FAKE_COMBOS })
  runner.start(batchId)
  await runner.tick()
  expect(seen).toEqual(['proj-9'])
})

test('I4b: after resetAssetBinding the next prepare uploads exactly once more (real asset store)', async () => {
  const d = dir(), db = openDb(join(d, 't.db'))
  writeFileSync(join(d, 'a.png'), PNG)
  const { id } = registerAsset(db, join(d, 'a.png'), 1)
  const store = createAssetStore(db), flow = createFakeFlow(['upload-no-ack', 'ok'])
  const clock = { t: 1_700_000_000_000 }, driver = createExtDriver(flow.server, { allow: () => true, assets: store, now: () => clock.t, sleep: async (ms) => { clock.t += ms } })
  const prepare = () => driver.prepare('7', { prompt: 'p', kind: 'image', settings: { combo: DEFAULT_COMBO }, refIds: [id], projectId: P })
  expect(await prepare()).toEqual({ ok: false, code: 'REF_UPLOAD_UNCERTAIN' })
  expect(await prepare()).toEqual({ ok: false, code: 'REF_UPLOAD_UNCERTAIN' }) // stuck: the hint loops
  expect(flow.uploadsOf(id)).toBe(1)
  const h = createHandlers({ db, projects: () => [P] } as never)
  await h.resetAssetBinding({ assetId: id, confirm: true })
  expect(store.binding(id, P)).toBeNull()
  expect(await prepare()).toEqual({ ok: true })
  expect(flow.uploadsOf(id)).toBe(2)
  expect(store.binding(id, P)).toMatchObject({ state: 'bound' })
})
