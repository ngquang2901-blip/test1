import { test, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/main/db'
import { enqueueBatch } from '../src/main/batch'
import { createRunner } from '../src/main/runner'
import { createFakeDriver, FAKE_COMBOS, fakeCombo } from '../src/main/fake-driver'
import { createExtDriver, decideCheck, type CheckInput } from '../src/main/connector/ext-driver'
import { ConnectorError } from '../src/main/driver'
import { DEFAULT_COMBO, comboQualified, profile } from '../src/main/profile'
import type { ConnectorServer } from '../src/main/connector/server'

const P = 'cb7b8a3e-0000-4000-8000-000000000001'
const SECRET = 'SECRET prompt text 123'

type Handler = (op: string, args: Record<string, unknown>) => unknown
const stub = (h: Handler) => {
  const seen: Array<[string, Record<string, unknown>]> = []
  const server = { send: async (op: string, args: Record<string, unknown>) => { seen.push([op, args]); const r = h(op, args); if (r instanceof Error) throw r; return r }, onEvent: () => () => {} } as unknown as ConnectorServer
  return { server, seen }
}
// a clean composer for prepare's state reads (before refs and after the prompt)
const here = (path = `/fx/tools/flow/project/${P}`) => [{ tabId: '7', path, active: true }]
const clean = (h: Handler): Handler => (op, a) => (op === 'state' ? { text: '', chips: [] } : op === 'tabs' ? here() : h(op, a))
const OPEN = { allow: () => true }
const prep = { prompt: SECRET, kind: 'image' as const, settings: { combo: DEFAULT_COMBO }, refIds: [], projectId: P }
const SETTINGS_OK = { ok: true, current: {}, mismatches: [] }
const PREP_OK = { ok: true, textMatches: true, log: [] }

test('prepare: settings (count as x2) then prep; ok only when both pass', async () => {
  const { server, seen } = stub(clean((op) => (op === 'settings' ? SETTINGS_OK : PREP_OK)))
  expect(await createExtDriver(server, OPEN).prepare('7', prep)).toEqual({ ok: true })
  expect(seen).toEqual([
    ['tabs', {}],
    ['settings', { tabId: '7', mode: 'Image', aspect: '16:9', quality: 'High', count: 'x2', model: 'Nano Banana 2.1' }],
    ['state', { tabId: '7' }],
    ['prep', { tabId: '7', prompt: SECRET }],
    ['state', { tabId: '7' }],
  ])
})

test.each([
  ['settings mismatch', (op: string) => (op === 'settings' ? { ok: false, mismatches: ['model'] } : PREP_OK), 'SETTINGS_MISMATCH', ['settings']],
  ['settings op throws', (op: string) => (op === 'settings' ? new Error('no panel') : PREP_OK), 'SETTINGS_MISMATCH', ['settings']],
  ['prompt does not read back', (op: string) => (op === 'settings' ? SETTINGS_OK : { ok: false, textMatches: false, log: [] }), 'PROMPT_MISMATCH', ['settings', 'state', 'prep']],
  ['ok true but textMatches missing', (op: string) => (op === 'settings' ? SETTINGS_OK : { ok: true }), 'PROMPT_MISMATCH', ['settings', 'state', 'prep']],
  ['textMatches true but ok false', (op: string) => (op === 'settings' ? SETTINGS_OK : { ok: false, textMatches: true }), 'PROMPT_MISMATCH', ['settings', 'state', 'prep']],
  ['composer will not clear', (op: string) => (op === 'settings' ? SETTINGS_OK : { ok: false, log: ['clear failed'] }), 'COMPOSER_NOT_CLEAR', ['settings', 'state', 'prep']],
  ['prep throws', (op: string) => (op === 'settings' ? SETTINGS_OK : new Error('boom')), 'PROMPT_MISMATCH', ['settings', 'state', 'prep']],
])('prepare fails closed: %s', async (_n, h, code, ops) => {
  const { server, seen } = stub(clean(h as Handler))
  const r = await createExtDriver(server, OPEN).prepare('7', prep)
  expect(r).toEqual({ ok: false, code })
  expect(seen.map((s) => s[0])).toEqual(['tabs', ...ops])
  expect(JSON.stringify(r)).not.toContain('SECRET')
})

test('prepare: no combo in settings ⇒ SETTINGS_MISMATCH without touching the page; a lost connector propagates', async () => {
  const a = stub(clean(() => SETTINGS_OK))
  expect(await createExtDriver(a.server, OPEN).prepare('7', { ...prep, settings: {} })).toEqual({ ok: false, code: 'SETTINGS_MISMATCH' })
  expect(a.seen).toEqual([])
  const b = stub(clean(() => new ConnectorError('gone')))
  await expect(createExtDriver(b.server, OPEN).prepare('7', prep)).rejects.toBeInstanceOf(ConnectorError)
})

test.each([
  ['the tab is on another project', () => here('/fx/tools/flow/project/11111111-2222-4333-8444-555555555555')],
  ['the tab is on the home page', () => here('/fx/tools/flow')],
  ['the tab is gone', () => []],
  ['another tab only', () => [{ tabId: 8, path: `/fx/tools/flow/project/${P}`, active: true }]],
])('I2: prepare checks the tab project BEFORE any page-affecting op: %s => TARGET_CHANGED, only `tabs` was sent', async (_n, tabs) => {
  const { server, seen } = stub((op) => (op === 'tabs' ? tabs() : new Error(`must not be sent: ${op}`)))
  expect(await createExtDriver(server, OPEN).prepare('7', prep)).toEqual({ ok: false, code: 'TARGET_CHANGED' })
  expect(seen.map((s) => s[0])).toEqual(['tabs'])
  expect(await createExtDriver(stub((op) => (op === 'tabs' ? here() : new Error(`must not be sent: ${op}`))).server, OPEN).prepare('7', { ...prep, projectId: undefined })).toEqual({ ok: false, code: 'TARGET_CHANGED' }) // no batch project: nothing to compare with, fail closed
})

test('prepare: ungranted tab never reaches the page', async () => {
  const { server, seen } = stub(() => SETTINGS_OK)
  await expect(createExtDriver(server, { allow: () => false }).prepare('7', prep)).rejects.toThrow('tab not granted')
  expect(seen).toEqual([])
})

test('m1: fetchMedia without a grant is refused and never reaches the extension (no allow option = nothing granted)', async () => {
  const a = stub(() => ({ ok: true, downloadId: 1 }))
  await expect(createExtDriver(a.server, { allow: () => false }).fetchMedia('7', { mediaId: 'm', filename: 'f.bin' })).rejects.toThrow('tab not granted')
  await expect(createExtDriver(a.server).fetchMedia('7', { mediaId: 'm', filename: 'f.bin' })).rejects.toThrow('tab not granted')
  expect(a.seen).toEqual([])
  expect(await createExtDriver(a.server, OPEN).fetchMedia('7', { mediaId: 'm', filename: 'f.bin' })).toEqual({ ok: true, downloadId: 1 }) // control: granted goes through
})

const good = (): CheckInput => ({
  tabProject: P, projectId: P, refMedia: [],
  ping: { xhrSend: true, xhrOpen: true, fetch: true },
  probe: { present: { editor: true, submit: true } },
  state: { submitDisabled: false, creditWarning: false, chips: [] },
  hit: { covered: false },
})
test('decideCheck: table', () => {
  const mut = (f: (c: CheckInput) => void) => { const c = good(); f(c); return c }
  const rows: Array<[string, CheckInput, string | null]> = [
    ['all good', good(), null],
    ['all good with 2 refs and 2 chips', mut((c) => { c.refMedia = ['x', 'y']; c.state!.chips = ['y', 'x'] }), null],
    ['other project', mut((c) => { c.tabProject = 'zzz' }), 'TARGET_CHANGED'],
    ['tab has no project', mut((c) => { c.tabProject = null }), 'TARGET_CHANGED'],
    ['xhrSend dead', mut((c) => { c.ping!.xhrSend = false }), 'TARGET_CHANGED'],
    ['fetch dead', mut((c) => { c.ping!.fetch = false }), 'TARGET_CHANGED'],
    ['no ping', mut((c) => { c.ping = null }), 'TARGET_CHANGED'],
    ['submit selector gone', mut((c) => { c.probe!.present.submit = false }), 'TARGET_CHANGED'],
    ['no probe', mut((c) => { c.probe = null }), 'TARGET_CHANGED'],
    ['submit disabled', mut((c) => { c.state!.submitDisabled = true }), 'BUTTON_DISABLED'],
    ['submit missing (null)', mut((c) => { c.state!.submitDisabled = null }), 'BUTTON_DISABLED'],
    ['credit warning', mut((c) => { c.state!.creditWarning = true }), 'CREDIT_WARNING'],
    ['too few chips', mut((c) => { c.refMedia = ['a'] }), 'CHIP_MISMATCH'],
    ['too many chips', mut((c) => { c.state!.chips = ['x'] }), 'CHIP_MISMATCH'],
    ['hit null', mut((c) => { c.hit = null }), 'BUTTON_DISABLED'],
    ['covered', mut((c) => { c.hit = { covered: true } }), 'COVERED'],
  ]
  for (const [name, c, code] of rows) expect(decideCheck(c), name).toEqual(code ? { ok: false, code } : { ok: true })
})

test('checkBeforeClick: ops flow into the decision; any thrown op error ⇒ TARGET_CHANGED', async () => {
  const world = (over: Partial<Record<string, unknown>> = {}): Handler => (op) => (op in over ? over[op] : ({
    tabs: [{ tabId: '7', path: `/fx/tools/flow/project/${P}`, active: true }],
    ping: { xhrSend: true, xhrOpen: true, fetch: true }, probe: { present: { editor: true, submit: true } },
    state: { submitDisabled: false, creditWarning: false, chips: [] }, hit: { covered: false },
  } as Record<string, unknown>)[op])
  const d = (h: Handler) => createExtDriver(stub(h).server, OPEN)
  expect(await d(world()).checkBeforeClick('7', P)).toEqual({ ok: true })
  expect(await d(world()).checkBeforeClick('7', 'other')).toEqual({ ok: false, code: 'TARGET_CHANGED' })
  expect(await d(world({ tabs: [] })).checkBeforeClick('7', P)).toEqual({ ok: false, code: 'TARGET_CHANGED' })
  expect(await d(world({ hit: { covered: true } })).checkBeforeClick('7', P)).toEqual({ ok: false, code: 'COVERED' })
  const bound = { get: () => null, binding: () => ({ assetId: 'r1', projectId: P, uploadName: 'n', mediaId: 'c', state: 'bound' as const, intentAt: 1 }), writeBinding: () => {} }
  const dr = (h: Handler) => createExtDriver(stub(h).server, { allow: () => true, assets: bound })
  expect(await dr(world({ state: { submitDisabled: false, creditWarning: false, chips: ['c'] } })).checkBeforeClick('7', P, ['r1'])).toEqual({ ok: true })
  expect(await dr(world({ state: { submitDisabled: false, creditWarning: false, chips: ['other'] } })).checkBeforeClick('7', P, ['r1'])).toEqual({ ok: false, code: 'CHIP_MISMATCH' })
  expect(await d(world()).checkBeforeClick('7', P, ['r1'])).toEqual({ ok: false, code: 'CHIP_MISMATCH' })
  for (const op of ['tabs', 'ping', 'probe', 'state', 'hit']) expect(await d(world({ [op]: new Error('x') })).checkBeforeClick('7', P), op).toEqual({ ok: false, code: 'TARGET_CHANGED' })
  const probe = stub(world())
  await createExtDriver(probe.server, OPEN).checkBeforeClick('7', P)
  expect(probe.seen.find((s) => s[0] === 'probe')![1]).toEqual({ tabId: '7', selectors: { editor: profile.selectors.editor, submit: profile.selectors.submit } })
})

test('comboQualified: exact match per kind only', () => {
  expect(comboQualified('image', DEFAULT_COMBO)).toBe(true)
  expect(comboQualified('image', { ...DEFAULT_COMBO })).toBe(true)
  expect(comboQualified('video', DEFAULT_COMBO)).toBe(false)
  for (const bad of [undefined, null, {}, 'x', { ...DEFAULT_COMBO, count: 4 }, { ...DEFAULT_COMBO, aspect: '1:1' }, { ...DEFAULT_COMBO, extra: 1 }, { ...DEFAULT_COMBO, model: 'Nano Banana Pro' }])
    expect(comboQualified('image', bad), JSON.stringify(bad)).toBe(false)
})

// ---- runner: combo gate (AC-03) and scripted driver failures ----
function rig(settings: object, fail: { prepare?: string[]; check?: string[] } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'))
  const clock = { now: () => Date.now() }
  const fake = createFakeDriver(['image-ok', 'image-ok'], fail)
  const { batchId } = enqueueBatch(db, { commandId: 'c', kind: 'image', projectId: 'p', settings, mode: 'auto', prompts: ['a'], refs: [[]] })
  const runner = createRunner({ db, driver: fake, clock, tabs: ['t1'], speed: 'default', autoAllowed: () => true, combos: FAKE_COMBOS })
  runner.start(batchId)
  const journal = () => (db.prepare('select count(*) n from journal_event').get() as { n: number }).n
  const state = () => JSON.parse((db.prepare('select state_json j from attempt').get() as { j: string }).j)
  return { db, fake, runner, batchId, journal, state }
}
test.each([['no combo', {}], ['unknown model', { combo: { ...DEFAULT_COMBO, model: 'Nano Banana Pro' } }], ['wrong count', { combo: { ...DEFAULT_COMBO, count: 4 } }], ['wrong kind', { combo: fakeCombo('video') }], ['junk', { combo: 5 }]])(
  'combo gate: %s ⇒ batch paused COMBO_NOT_QUALIFIED, no intent, no page calls', async (_n, settings) => {
    const t = rig(settings)
    await t.runner.tick(); await t.runner.tick()
    expect(t.runner.lastError(t.batchId)).toBe('COMBO_NOT_QUALIFIED')
    expect(t.fake.ledger).toMatchObject({ prepares: 0, checks: 0, clicks: 0, arms: 0 })
    expect(t.journal()).toBe(0)
    expect(t.state().item).toBe('queued')
    expect((t.db.prepare('select status from batch').get() as { status: string }).status).toBe('paused')
  })

test('combo gate: qualified combo goes through to the click', async () => {
  const t = rig({ combo: DEFAULT_COMBO })
  await t.runner.tick()
  expect(t.fake.ledger).toMatchObject({ prepares: 1, checks: 1, clicks: 1 })
})

test('fake driver scripted prepare failure ⇒ prep_failed (no click); check failure ⇒ batch paused with that code', async () => {
  const a = rig({ combo: DEFAULT_COMBO }, { prepare: ['PROMPT_MISMATCH'] })
  await a.runner.tick()
  expect(a.fake.ledger).toMatchObject({ prepares: 1, checks: 0, clicks: 0 })
  expect(a.state().error).toMatchObject({ code: 'PROMPT_MISMATCH' })
  for (const code of ['SETTINGS_MISMATCH', 'COMPOSER_NOT_CLEAR']) {
    const t = rig({ combo: DEFAULT_COMBO }, { prepare: [code] })
    await t.runner.tick()
    expect([t.fake.ledger.clicks, t.state().error.code]).toEqual([0, code])
  }
  for (const code of ['TARGET_CHANGED', 'COVERED', 'CREDIT_WARNING', 'BUTTON_DISABLED', 'CHIP_MISMATCH']) {
    const t = rig({ combo: DEFAULT_COMBO }, { check: [code] })
    await t.runner.tick()
    expect([t.fake.ledger.clicks, t.runner.lastError(t.batchId)]).toEqual([0, code])
  }
})

const PRESENT = { present: { editor: true, submit: true }, path: '/p' }
const probeStub = (o: { listeners?: unknown; seen?: string[] | null } = {}) => stub((op) => (op === 'probe' ? PRESENT : op === 'listeners' ? (o.listeners === undefined ? { found: true, disabled: false, listeners: 1 } : o.listeners) : op === 'ping' ? (o.seen === null ? null : { seen: o.seen ?? ['Zzl0ze'] }) : new Error(op)))

test('probeTab: selfCheck selectors + listeners + project-load proof, read-only ops only', async () => {
  const { server, seen } = probeStub()
  expect(await createExtDriver(server, OPEN).probeTab!('7')).toEqual({ present: { editor: true, submit: true }, listeners: 1, sawProjectLoad: true })
  expect(seen.map((s) => s[0]).sort()).toEqual(['listeners', 'ping', 'probe'])
  expect(seen.find((s) => s[0] === 'probe')![1]).toEqual({ tabId: '7', selectors: { editor: profile.selectors.editor, submit: profile.selectors.submit } })
})

test('probeTab: no project RPC seen ⇒ sawProjectLoad false; no main world ⇒ listeners 0 and not seen', async () => {
  const a = await createExtDriver(probeStub({ seen: ['ogiZ0b'] }).server, OPEN).probeTab!('7')
  expect(a.sawProjectLoad).toBe(false)
  const b = await createExtDriver(probeStub({ listeners: null, seen: null }).server, OPEN).probeTab!('7')
  expect(b).toMatchObject({ listeners: 0, sawProjectLoad: false })
})

test('probeTab: ungranted tab never reaches the page', async () => {
  const { server, seen } = probeStub()
  await expect(createExtDriver(server, { allow: () => false }).probeTab!('7')).rejects.toThrow('tab not granted')
  await expect(createExtDriver(server).probeTab!('7')).rejects.toThrow('tab not granted')
  expect(seen).toEqual([])
})
