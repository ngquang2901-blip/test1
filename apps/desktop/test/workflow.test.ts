import { test, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/main/db'
import { createWorkflows, parseGraph, plan, type Graph } from '../src/main/workflow'

const N = (id: string, type: string, x = 0, extra: object = {}) => ({ id, type, x, y: 0, ...extra })
// Text + Ảnh → G1 → G2 (its own Text) → Tải về
const CHAIN: Graph = parseGraph({
  nodes: [N('t1', 'text', 0, { text: 'nhân vật A\n\nnhân vật B' }), N('img', 'image', 0, { assetIds: ['a1'] }), N('g1', 'generate', 300), N('t2', 'text', 300, { text: 'cảnh 1' }), N('g2', 'generate', 600), N('dl', 'download', 900), N('memo', 'note', 0, { text: 'ghi chú' })],
  edges: [{ from: 't1', to: 'g1' }, { from: 'img', to: 'g1' }, { from: 'g1', to: 'g2' }, { from: 't2', to: 'g2' }, { from: 'g2', to: 'dl' }],
})

function rig(o: { missing?: string[]; blocked?: boolean; saveFails?: boolean; frameFails?: boolean; late?: boolean; statusOf?: (b: string) => string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-wf-')), file = join(dir, 'out.toolflow.json'), dialogs: string[] = []
  const db = openDb(join(dir, 't.db'))
  db.prepare("insert into asset(id,path,sha256,bytes,mime,name,created_at) values('a1','/x/a.png','h',3,'image/png','a.png',1)").run()
  const calls: string[] = [], enq: { commandId: string; text: string; mode: string; combo?: object; refs: { assetIds: string[]; mode: string } }[] = []
  const gone = (k: string) => (o.missing ?? []).includes(k) || (!!o.late && k === 'B' && calls.filter((c) => c === 'download b1').length < 2) // late: B is saved only by the second try
  const all = createWorkflows({
    db, now: () => 5, sleep: () => new Promise((r) => setTimeout(r, 1)), // a real macrotask: an instant sleep would starve the timers while a batch is "running"
    enqueue: async (a) => { enq.push(a as (typeof enq)[number]); return { batchIds: [`b${enq.length}`] } },
    start: async (b) => void calls.push(`start ${b}`), stop: async (b) => void calls.push(`stop ${b}`),
    status: o.statusOf ?? (() => 'completed'), download: async (b) => { calls.push(`download ${b}`); if (o.saveFails && b === 'b1') throw Object.assign(new Error('DOWNLOAD_ROOT_UNAVAILABLE'), { code: 'DOWNLOAD_ROOT_UNAVAILABLE' }) },
    outputs: (b) => (b === 'b1' ? [gone('A') ? null : '/dl/A.png', gone('B') ? null : '/dl/B.png'] : ['/dl/c.png']),
    codes: (b) => (b === 'b1' ? [null, o.blocked ? 'CONTENT_BLOCKED' : gone('B') ? 'PROVIDER_ERROR_UNKNOWN' : null] : [null]),
    register: (p) => `asset:${p}`,
    lastFrame: async (p) => { calls.push(`frame ${p}`); if (o.frameFails) throw Object.assign(new Error('FFMPEG_FAILED'), { code: 'FFMPEG_FAILED' }); return `${p}.last.png` },
    merge: async (files, name) => { calls.push(`merge ${files.join(',')} ${name}`); return `/dl/${name}` },
    savePath: async (suggested) => { dialogs.push(suggested); return file }, openPath: async () => file,
  })
  const wf = all.handlers
  const wait = async (runId: string): Promise<string> => { for (let i = 0; i < 200; i++) { const r = await wf.workflowRun(runId); if (r!.status !== 'running') return r!.status; await new Promise((r) => setTimeout(r, 5)) } return 'timeout' }
  return { db, wf, calls, enq, wait, active: all.active, file, dialogs }
}

test('parseGraph: only meaningful wires, unique ids, bounded sizes', () => {
  expect(CHAIN.nodes).toHaveLength(7)
  const bad = (g: unknown) => expect(() => parseGraph(g)).toThrow(/INVALID_ARGS/)
  bad(null)
  bad({ nodes: [N('a', 'text'), N('a', 'generate')], edges: [] }) // duplicate id
  bad({ nodes: [N('a', 'sql')], edges: [] })
  bad({ nodes: [N('a', 'text'), N('d', 'download')], edges: [{ from: 'a', to: 'd' }] }) // text cannot feed a download
  bad({ nodes: [N('g', 'generate'), N('t', 'text')], edges: [{ from: 'g', to: 't' }] })
  bad({ nodes: [N('t', 'text'), N('g', 'generate')], edges: [{ from: 't', to: 'g' }, { from: 't', to: 'g' }] }) // same wire twice
  bad({ nodes: [N('t', 'text')], edges: [{ from: 't', to: 'nope' }] })
  bad({ nodes: [N('t', 'text', 0, { text: 'x'.repeat(1_000_001) })], edges: [] })
  bad({ nodes: [{ id: 't', type: 'text', x: 'left', y: 0 }], edges: [] })
  bad({ nodes: [N('i', 'image', 0, { assetIds: Array(11).fill('a') })], edges: [] })
  // Điều kiện: its wires need a port, other wires must not have one; variables are bounded
  const B = [N('g', 'generate'), N('b', 'branch'), N('h', 'generate')]
  expect(parseGraph({ nodes: B, edges: [{ from: 'g', to: 'b' }, { from: 'b', to: 'h', port: 'fail' }], vars: { 'nhân vật': 'mèo\nchó' } })).toMatchObject({ edges: [{ from: 'g', to: 'b' }, { from: 'b', to: 'h', port: 'fail' }], vars: { 'nhân vật': 'mèo\nchó' } })
  bad({ nodes: B, edges: [{ from: 'b', to: 'h' }] })
  bad({ nodes: B, edges: [{ from: 'b', to: 'h', port: 'maybe' }] })
  bad({ nodes: B, edges: [{ from: 'g', to: 'h', port: 'ok' }] })
  bad({ nodes: B, edges: [], vars: { '{x}': 'v' } })
  bad({ nodes: B, edges: [], vars: { x: 5 } })
  bad({ nodes: B, edges: [], vars: ['x'] })
})

test('plan: upstream first; prompts are the wired Text lines; a result wire makes the upstream feed and the node depend on it', () => {
  const { steps, errors } = plan(CHAIN)
  expect(errors).toEqual([])
  expect(steps).toEqual([
    { node: 'g1', kind: 'image', prompts: 'nhân vật A\n\nnhân vật B', images: ['a1'], deps: [], save: false, feeds: true },
    { node: 'g2', kind: 'image', prompts: 'cảnh 1', images: [], deps: [{ node: 'g1', port: 'direct' }], save: true, feeds: false },
  ])
})

test('plan: reasons a graph cannot run', () => {
  expect(plan(parseGraph({ nodes: [N('t', 'text', 0, { text: 'x' })], edges: [] })).errors).toEqual([{ code: 'WF_NO_GENERATE' }])
  expect(plan(parseGraph({ nodes: [N('t', 'text', 0, { text: '  \n' }), N('g', 'generate')], edges: [{ from: 't', to: 'g' }] })).errors).toEqual([{ node: 'g', code: 'WF_NO_PROMPT' }])
  const loop = plan(parseGraph({ nodes: [N('a', 'generate'), N('b', 'generate')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }))
  expect(loop.errors.map((e) => e.code)).toEqual(['WF_CYCLE', 'WF_CYCLE'])
  const many = Array.from({ length: 11 }, (_, i) => `p${i}`).join('\n') // 11 upstream prompts ⇒ 11 result refs for one prompt
  const big = plan(parseGraph({ nodes: [N('t', 'text', 0, { text: many }), N('a', 'generate'), N('u', 'text', 0, { text: 'x' }), N('b', 'generate', 300)], edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }, { from: 'u', to: 'b' }] }))
  expect(big.errors).toEqual([{ node: 'b', code: 'TOO_MANY_REFS' }])
})

test('run: each generate node is one batch; the second gets the first saved result of every upstream prompt as refs; only wired results are downloaded', async () => {
  const r = rig()
  const { runId } = await r.wf.runWorkflow({ graph: CHAIN, mode: 'manual' }) as { runId: string }
  expect(await r.wait(runId)).toBe('done')
  expect(r.enq.map((e) => [e.commandId, e.text, e.mode, e.refs.mode, e.refs.assetIds])).toEqual([
    [`wf:${runId}:g1`, 'nhân vật A\n\nnhân vật B', 'manual', 'all', ['a1']],
    [`wf:${runId}:g2`, 'cảnh 1', 'manual', 'all', ['asset:/dl/A.png', 'asset:/dl/B.png']],
  ])
  expect(r.calls).toEqual(['start b1', 'download b1', 'start b2', 'download b2'])
  expect((await r.wf.workflowRun(runId))!.nodes.g2.state).toBe('done')
})

test('run: an upstream prompt without a saved result ⇒ the dependent node is skipped, nothing is sent for it', async () => {
  const r = rig({ missing: ['B'] })
  const { runId } = await r.wf.runWorkflow({ graph: CHAIN, mode: 'auto' }) as { runId: string }
  expect(await r.wait(runId)).toBe('failed')
  expect(r.enq).toHaveLength(1)
  expect((await r.wf.workflowRun(runId))!.nodes.g2).toMatchObject({ state: 'skipped', code: 'WF_UPSTREAM_INCOMPLETE' })
})

test('run: a failed batch fails its node (and skips what depends on it); a graph that cannot run or a missing ref file sends nothing', async () => {
  const r = rig({ statusOf: () => 'partial_failed' })
  const { runId } = await r.wf.runWorkflow({ graph: CHAIN, mode: 'auto' }) as { runId: string }
  expect(await r.wait(runId)).toBe('failed')
  expect((await r.wf.workflowRun(runId))!.nodes.g1).toMatchObject({ state: 'failed', code: 'WF_BATCH_PARTIAL_FAILED' })
  const none = rig()
  expect(await none.wf.runWorkflow({ graph: { nodes: [N('g', 'generate')], edges: [] }, mode: 'auto' })).toEqual({ errors: [{ node: 'g', code: 'WF_NO_PROMPT' }] })
  none.db.prepare("delete from asset where id='a1'").run()
  expect(await none.wf.runWorkflow({ graph: CHAIN, mode: 'auto' })).toEqual({ errors: [{ node: 'g1', code: 'REF_ASSET_MISSING' }] })
  expect(none.enq).toEqual([])
  await expect(none.wf.runWorkflow({ graph: CHAIN, mode: 'turbo' })).rejects.toThrow(/INVALID_ARGS/)
})

test('stop: the running node has its batches stopped and no later node starts', async () => {
  let active = true
  const r = rig({ statusOf: () => (active ? 'running' : 'stopped') })
  const { runId } = await r.wf.runWorkflow({ graph: CHAIN, mode: 'auto' }) as { runId: string }
  await new Promise((x) => setTimeout(x, 20))
  expect(r.active()).toBe(true) // an update restart is refused meanwhile
  await r.wf.stopWorkflow(runId)
  active = false
  expect(await r.wait(runId)).toBe('stopped')
  expect(r.enq).toHaveLength(1)
  expect(r.calls).toContain('stop b1')
  expect(r.active()).toBe(false)
  expect(Object.values((await r.wf.workflowRun(runId))!.nodes).map((n) => n.state)).toEqual(['stopped', 'stopped'])
})

test('save / list / delete: same name updates; image nodes come back with names, a file no longer registered is marked missing', async () => {
  const r = rig()
  const { id } = await r.wf.saveWorkflow({ name: ' Nhân vật → cảnh ', graph: CHAIN })
  expect((await r.wf.saveWorkflow({ name: 'Nhân vật → cảnh', graph: { nodes: [N('img', 'image', 0, { assetIds: ['a1', 'gone'] })], edges: [] } })).id).toBe(id)
  const [w] = await r.wf.listWorkflows()
  expect([w.name, w.nodes.length]).toEqual(['Nhân vật → cảnh', 1])
  expect((w.nodes[0] as unknown as { assets: object[] }).assets).toEqual([{ id: 'a1', name: 'a.png', bytes: 3 }, { id: 'gone', name: '', bytes: 0, missing: true }])
  await expect(r.wf.saveWorkflow({ name: '', graph: CHAIN })).rejects.toThrow(/INVALID_ARGS/)
  await r.wf.deleteWorkflow(id)
  expect(await r.wf.listWorkflows()).toEqual([])
})

// g1 → Điều kiện → (Đủ ảnh) g2 with its results as refs / (Thiếu ảnh) g3, a fallback without them
const BRANCH: Graph = parseGraph({
  nodes: [N('t1', 'text', 0, { text: 'nhân vật A\nnhân vật B' }), N('g1', 'generate', 300), N('b', 'branch', 500), N('t2', 'text', 300, { text: 'cảnh có nhân vật' }), N('g2', 'generate', 700), N('t3', 'text', 300, { text: 'cảnh dự phòng' }), N('g3', 'generate', 700, { y: 300 })],
  edges: [{ from: 't1', to: 'g1' }, { from: 'g1', to: 'b' }, { from: 'b', to: 'g2', port: 'ok' }, { from: 't2', to: 'g2' }, { from: 'b', to: 'g3', port: 'fail' }, { from: 't3', to: 'g3' }],
})

test('Điều kiện, plan: both sides wait for the node wired into it; only "Đủ ảnh" counts its results as refs; a Điều kiện without exactly one input is an error', () => {
  const { steps, errors } = plan(BRANCH)
  expect(errors).toEqual([])
  expect(steps.map((s) => [s.node, s.deps, s.feeds])).toEqual([['g1', [], true], ['g2', [{ node: 'g1', port: 'ok' }], false], ['g3', [{ node: 'g1', port: 'fail' }], false]])
  const loose = plan(parseGraph({ nodes: [N('b', 'branch'), N('t', 'text', 0, { text: 'x' }), N('g', 'generate', 300), N('h', 'generate', 600)], edges: [{ from: 't', to: 'g' }, { from: 't', to: 'h' }, { from: 'b', to: 'g', port: 'ok' }, { from: 'b', to: 'h', port: 'fail' }] }))
  expect(loose.errors).toEqual([{ node: 'b', code: 'WF_BRANCH_INPUT' }])
  const loop = plan(parseGraph({ nodes: [N('a', 'generate'), N('b', 'branch'), N('c', 'generate')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', port: 'ok' }, { from: 'c', to: 'a' }] }))
  expect(loop.errors.map((e) => e.code)).toEqual(['WF_CYCLE', 'WF_CYCLE']) // a loop through a Điều kiện is still a loop
})

test('Điều kiện, run: every result saved ⇒ "Đủ ảnh" runs with them and the fallback steps aside; one missing ⇒ only the fallback runs, without refs', async () => {
  const full = rig()
  const a = await full.wf.runWorkflow({ graph: BRANCH, mode: 'auto' }) as { runId: string }
  expect(await full.wait(a.runId)).toBe('done') // a branch not taken is not a failure
  expect(full.enq.map((e) => [e.text, e.refs.assetIds])).toEqual([['nhân vật A\nnhân vật B', []], ['cảnh có nhân vật', ['asset:/dl/A.png', 'asset:/dl/B.png']]])
  expect((await full.wf.workflowRun(a.runId))!.nodes.g3.state).toBe('bypassed')
  const short = rig({ missing: ['B'] })
  const b = await short.wf.runWorkflow({ graph: BRANCH, mode: 'auto' }) as { runId: string }
  expect(await short.wait(b.runId)).toBe('done')
  expect(short.enq.map((e) => [e.text, e.refs.mode, e.refs.assetIds])).toEqual([['nhân vật A\nnhân vật B', 'none', []], ['cảnh dự phòng', 'none', []]])
  expect((await short.wf.workflowRun(b.runId))!.nodes.g2.state).toBe('bypassed')
})

test('dryRun returns the plan and sends nothing', async () => {
  const r = rig()
  const d = await r.wf.runWorkflow({ graph: CHAIN, mode: 'auto', dryRun: true }) as { steps: { node: string; prompts: string }[]; errors: unknown[] }
  expect([d.steps.map((s) => s.node), d.errors]).toEqual([['g1', 'g2'], []])
  expect(r.enq).toEqual([])
  expect(r.active()).toBe(false)
})

test('export / import: the file round-trips through the same validator; a file that is not a workflow is refused with one code', async () => {
  const r = rig()
  const graph = { ...BRANCH, vars: { 'nhân vật': 'mèo' } }
  expect(await r.wf.exportWorkflow({ name: 'Nhân vật: bản/1', graph })).toEqual({ saved: true })
  expect(r.dialogs).toEqual(['Nhân vật bản 1.toolflow.json']) // the suggested file name is one safe component
  expect(JSON.parse(readFileSync(r.file, 'utf8'))).toMatchObject({ toolflow: 1, name: 'Nhân vật: bản/1', vars: { 'nhân vật': 'mèo' } })
  const back = await r.wf.importWorkflow()
  expect(back).toMatchObject({ name: 'Nhân vật: bản/1', vars: { 'nhân vật': 'mèo' }, edges: BRANCH.edges })
  expect(back!.nodes.map((n) => n.id)).toEqual(BRANCH.nodes.map((n) => n.id))
  for (const junk of ['not json', '{"nodes":[{"id":"x","type":"shell","x":0,"y":0}],"edges":[]}', '[]']) {
    writeFileSync(r.file, junk)
    await expect(r.wf.importWorkflow()).rejects.toThrow(/^WF_FILE_INVALID$/)
  }
})

// ---- per-node settings: a Tạo ảnh node may carry its own combo (model / aspect / thinking level / count) ----
const PRO = { kind: 'image', mode: 'Image', model: 'Nano Banana Pro', aspect: '9:16', count: 3 }
const SET = (combo: unknown): unknown => ({ nodes: [N('t', 'text', 0, { text: 'x' }), N('g', 'generate', 300, { combo }), N('u', 'text', 300, { text: 'y' }), N('h', 'generate', 600)], edges: [{ from: 't', to: 'g' }, { from: 'g', to: 'h' }, { from: 'u', to: 'h' }] })

test('node settings, parseGraph: a combo is kept on a Tạo ảnh node only, rebuilt from known keys; a malformed one is refused', () => {
  const g = parseGraph(SET({ count: 3, aspect: '9:16', model: 'Nano Banana Pro', mode: 'Image', kind: 'image' }))
  expect(g.nodes.find((n) => n.id === 'g')!.combo).toEqual(PRO)
  expect(g.nodes.find((n) => n.id === 'h')!.combo).toBeUndefined()
  const bad = (v: unknown) => expect(() => parseGraph(v), JSON.stringify(v)).toThrow(/INVALID_ARGS/)
  for (const c of [null, 'x', [], {}, { ...PRO, count: 0 }, { ...PRO, count: 9 }, { ...PRO, count: '3' }, { ...PRO, model: '' }, { ...PRO, model: 'm'.repeat(61) }, { ...PRO, quality: 5 }, { ...PRO, kind: 'audio' }, { ...PRO, extra: 1 }]) bad(SET(c)) // kind video is a shape the plan judges (video node)
  bad({ nodes: [N('t', 'text', 0, { text: 'x', combo: PRO })], edges: [] }) // only a Tạo ảnh node has settings
})

test('node settings, plan + run: the node\'s combo goes to its own batch, the next node keeps the default; a combo that is not qualified stops the run before anything is sent', async () => {
  const g = parseGraph(SET(PRO))
  expect(plan(g).steps.map((s) => [s.node, s.combo])).toEqual([['g', PRO], ['h', undefined]])
  const r = rig()
  const { runId } = await r.wf.runWorkflow({ graph: g, mode: 'auto' }) as { runId: string }
  expect(await r.wait(runId)).toBe('done')
  expect(r.enq.map((e) => [e.text, e.combo, 'combo' in e])).toEqual([['x', PRO, true], ['y', undefined, false]])
  const off = rig()
  for (const c of [{ ...PRO, model: 'Imagen 9' }, { ...PRO, quality: 'High' }, { ...PRO, count: 8 }]) // well-formed, but not in the profile
    expect(await off.wf.runWorkflow({ graph: SET(c), mode: 'auto' }), JSON.stringify(c)).toEqual({ errors: [{ node: 'g', code: 'COMBO_NOT_QUALIFIED' }] })
  expect(off.enq).toEqual([])
})

// ---- Điều kiện: what it asks about the node wired into it ----
const COND = (cond?: string): Graph => parseGraph({ ...BRANCH, nodes: BRANCH.nodes.map((n) => (n.id === 'b' && cond ? { ...n, cond } : n)) })
const sent = async (cond: string | undefined, o: Parameters<typeof rig>[0]) => {
  const r = rig(o), { runId } = await r.wf.runWorkflow({ graph: COND(cond), mode: 'auto' }) as { runId: string }
  await r.wait(runId)
  const nodes = (await r.wf.workflowRun(runId))!.nodes
  return { texts: r.enq.slice(1).map((e) => [e.text, e.refs.assetIds]), g2: nodes.g2.state, g3: nodes.g3.state }
}

test('Điều kiện, parseGraph + plan: the condition sits on the Điều kiện node (default: every result saved) and travels with both wires', () => {
  expect(COND('any').nodes.find((n) => n.id === 'b')!.cond).toBe('any')
  expect(plan(COND('any')).steps.map((s) => s.deps)).toEqual([[], [{ node: 'g1', port: 'ok', cond: 'any' }], [{ node: 'g1', port: 'fail', cond: 'any' }]])
  expect(plan(COND('all')).steps[1].deps).toEqual([{ node: 'g1', port: 'ok' }]) // 'all' is the default: the same plan as a graph saved before conditions had kinds
  for (const bad of ['maybe', '', 5, null]) expect(() => parseGraph({ ...BRANCH, nodes: BRANCH.nodes.map((n) => (n.id === 'b' ? { ...n, cond: bad } : n)) }), String(bad)).toThrow(/INVALID_ARGS/)
  expect(() => parseGraph({ nodes: [N('g', 'generate', 0, { cond: 'any' })], edges: [] })).toThrow(/INVALID_ARGS/) // only a Điều kiện node has one
  // "bị lọc" hands no images on, so eleven upstream prompts are not eleven refs for the next node
  const many = Array.from({ length: 11 }, (_, i) => `p${i}`).join('\n')
  const wide = (cond: string) => plan(parseGraph({ nodes: [N('t', 'text', 0, { text: many }), N('a', 'generate'), N('b', 'branch', 200, { cond }), N('u', 'text', 0, { text: 'x' }), N('c', 'generate', 400)], edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c', port: 'ok' }, { from: 'u', to: 'c' }] })).errors
  expect([wide('filtered'), wide('any')]).toEqual([[], [{ node: 'c', code: 'TOO_MANY_REFS' }]])
})

test('Điều kiện "có ít nhất một ảnh": the yes side runs with the results that exist; the no side only when there is none', async () => {
  expect(await sent('any', {})).toEqual({ texts: [['cảnh có nhân vật', ['asset:/dl/A.png', 'asset:/dl/B.png']]], g2: 'done', g3: 'bypassed' })
  expect(await sent('any', { missing: ['B'] })).toEqual({ texts: [['cảnh có nhân vật', ['asset:/dl/A.png']]], g2: 'done', g3: 'bypassed' })
  expect(await sent('any', { missing: ['A', 'B'] })).toEqual({ texts: [['cảnh dự phòng', []]], g2: 'bypassed', g3: 'done' })
  expect(await sent(undefined, { missing: ['B'] })).toEqual({ texts: [['cảnh dự phòng', []]], g2: 'bypassed', g3: 'done' }) // the default still needs every result
})

test('Điều kiện "bị Flow lọc": the yes side runs when Flow blocked a prompt, the no side for any other ending; neither gets the images', async () => {
  expect(await sent('filtered', { missing: ['B'], blocked: true })).toEqual({ texts: [['cảnh có nhân vật', []]], g2: 'done', g3: 'bypassed' })
  expect(await sent('filtered', {})).toEqual({ texts: [['cảnh dự phòng', []]], g2: 'bypassed', g3: 'done' })
  expect(await sent('filtered', { missing: ['B'] })).toEqual({ texts: [['cảnh dự phòng', []]], g2: 'bypassed', g3: 'done' }) // a result missing for another reason is not "bị lọc"
  expect(await sent('filtered', { missing: ['B'], blocked: true, saveFails: true })).toEqual({ texts: [['cảnh có nhân vật', []]], g2: 'done', g3: 'bypassed' }) // what Flow answered is known even when saving the other results fails
  expect(await sent(undefined, { saveFails: true })).toEqual({ texts: [['cảnh dự phòng', []]], g2: 'bypassed', g3: 'done' }) // nothing saved ⇒ "Thiếu ảnh"
})

const VIDEO = { kind: 'video', mode: 'Video', model: 'Veo 3.1 - Lite', aspect: '9:16', count: 1 }
// Text (2 prompts) → G1 (image) → V (video, its own 2 prompts) → Tải về
const TO_VIDEO = (vText = 'cảnh 1\ncảnh 2', extra: { nodes?: object[]; edges?: object[] } = {}): Graph => parseGraph({
  nodes: [N('t1', 'text', 0, { text: 'A\nB' }), N('g1', 'generate', 300), N('t2', 'text', 300, { text: vText }), N('v', 'generate', 600, { combo: VIDEO }), N('dl', 'download', 900), ...(extra.nodes ?? [])],
  edges: [{ from: 't1', to: 'g1' }, { from: 'g1', to: 'v' }, { from: 't2', to: 'v' }, { from: 'v', to: 'dl' }, ...(extra.edges ?? [])],
})

test('video node, plan: a Tạo ảnh node with video settings is a video step; its images are start frames (one for all prompts, or one per prompt); it cannot feed another node', () => {
  expect(parseGraph({ nodes: [N('v', 'generate', 0, { combo: VIDEO })], edges: [] }).nodes[0].combo).toEqual(VIDEO)
  const ok = plan(TO_VIDEO())
  expect([ok.errors, ok.steps.map((s) => [s.node, s.kind])]).toEqual([[], [['g1', 'image'], ['v', 'video']]])
  expect(plan(TO_VIDEO('một cảnh')).errors).toEqual([{ node: 'v', code: 'WF_VIDEO_FRAMES' }]) // 2 upstream images, 1 prompt
  expect(plan(TO_VIDEO('1\n2\n3')).errors).toEqual([{ node: 'v', code: 'WF_VIDEO_FRAMES' }])
  const fed = TO_VIDEO('1\n2', { nodes: [N('t3', 'text', 900, { text: 'x' }), N('g3', 'generate', 1200)], edges: [{ from: 'v', to: 'g3' }, { from: 't3', to: 'g3' }] })
  expect(plan(fed).errors).toContainEqual({ node: 'v', code: 'WF_VIDEO_OUTPUT' })
  expect(plan(parseGraph({ nodes: [N('t', 'text', 0, { text: 'x' }), N('v', 'generate', 300, { combo: { ...VIDEO, aspect: '1:1' } })], edges: [{ from: 't', to: 'v' }] })).errors).toEqual([{ node: 'v', code: 'COMBO_NOT_QUALIFIED' }])
})

test('video node, run: the batch is a video batch; prompt i starts from the saved image of upstream prompt i; one image serves every prompt', async () => {
  const t = rig()
  const kinds = (): unknown[] => (t.enq as unknown as { kind: string; refs: { assetIds: string[]; mode: string; perItem: number } }[]).map((e) => [e.kind, e.refs.mode, e.refs.perItem, e.refs.assetIds])
  expect(await t.wait(((await t.wf.runWorkflow({ graph: TO_VIDEO(), mode: 'auto' })) as { runId: string }).runId)).toBe('done')
  expect(kinds()).toEqual([['image', 'none', 10, []], ['video', 'sequential', 1, ['asset:/dl/A.png', 'asset:/dl/B.png']]])
  expect(t.enq[1].combo).toEqual(VIDEO)
  const one = rig(), g = parseGraph({ nodes: [N('t', 'text', 0, { text: 'x\ny' }), N('img', 'image', 0, { assetIds: ['a1'] }), N('v', 'generate', 300, { combo: VIDEO })], edges: [{ from: 't', to: 'v' }, { from: 'img', to: 'v' }] })
  expect(await one.wait(((await one.wf.runWorkflow({ graph: g, mode: 'auto' })) as { runId: string }).runId)).toBe('done')
  expect((one.enq[0] as unknown as { kind: string }).kind).toBe('video')
  expect([one.enq[0].refs.mode, one.enq[0].refs.assetIds]).toEqual(['all', ['a1']])
})

test('site node: a Tạo ảnh node may go to ChatGPT or Gemini instead of Flow; its batch names the site and is always sent by the app, Gemini with its ratio; a site and Flow settings do not mix', async () => {
  const SITE = (g: object, h: object = {}) => ({ nodes: [N('t', 'text', 0, { text: 'x' }), N('g', 'generate', 300, g), N('t2', 'text', 300, { text: 'y' }), N('h', 'generate', 600, h), N('dl', 'download', 900)], edges: [{ from: 't', to: 'g' }, { from: 'g', to: 'h' }, { from: 't2', to: 'h' }, { from: 'h', to: 'dl' }] })
  const g = parseGraph(SITE({ site: 'gemini', aspect: '9:16', model: 'Pro' }, { site: 'chatgpt' }))
  expect(plan(g).steps.map((s) => [s.node, s.kind, s.site, s.aspect, s.model])).toEqual([['g', 'image', 'gemini', '9:16', 'Pro'], ['h', 'image', 'chatgpt', undefined, undefined]])
  expect(plan(g).errors).toEqual([])
  const r = rig()
  const { runId } = await r.wf.runWorkflow({ graph: g, mode: 'manual' }) as { runId: string }
  expect(await r.wait(runId)).toBe('done')
  expect((r.enq as unknown as { text: string; provider?: string; aspect?: string; model?: string; mode: string; combo?: object; refs: { assetIds: string[] } }[]).map((e) => [e.text, e.provider, e.aspect, e.model, e.mode, 'combo' in e, e.refs.assetIds]))
    .toEqual([['x', 'gemini', '9:16', 'Pro', 'auto', false, []], ['y', 'chatgpt', undefined, undefined, 'auto', false, ['asset:/dl/A.png', 'asset:/dl/B.png']]]) // the first node's results are the second one's reference images
  const bad = (v: unknown) => expect(() => parseGraph(v), JSON.stringify(v)).toThrow(/INVALID_ARGS/)
  for (const x of [{ site: 'grok' }, { site: 'flow' }, { site: 5 }, { aspect: '9:16' }, { site: 'chatgpt', aspect: '9:16' }, { site: 'gemini', aspect: '21:9' }, { site: 'gemini', combo: PRO }, { model: 'Pro' }, { site: 'chatgpt', model: 'Pro' }, { site: 'gemini', model: 'Ultra' }]) bad(SITE(x))
  bad({ nodes: [N('t', 'text', 0, { text: 'x', site: 'gemini' })], edges: [] }) // only a Tạo ảnh node goes somewhere
})


// ---- Vòng lặp: the generate node wired into it runs again with the same prompts, each round with the previous round's results as refs ----
const LOOP = (rounds: unknown = 3, extra: { nodes?: object[]; edges?: object[] } = {}): unknown => ({
  nodes: [N('t', 'text', 0, { text: 'mèo\nchó' }), N('img', 'image', 0, { assetIds: ['a1'] }), N('g', 'generate', 300), N('l', 'loop', 600, { rounds }), N('dl', 'download', 900), ...(extra.nodes ?? [])],
  edges: [{ from: 't', to: 'g' }, { from: 'img', to: 'g' }, { from: 'g', to: 'l' }, { from: 'l', to: 'dl' }, ...(extra.edges ?? [])],
})

test('Vòng lặp, parseGraph: rounds 2..10 on a loop node only; it takes a Tạo ảnh and gives to Tạo ảnh / Tự tải về / Điều kiện', () => {
  expect(parseGraph(LOOP()).nodes.find((n) => n.id === 'l')!.rounds).toBe(3)
  const bad = (v: unknown) => expect(() => parseGraph(v), JSON.stringify(v)).toThrow(/INVALID_ARGS/)
  for (const r of [1, 11, 2.5, '3', null]) bad(LOOP(r))
  bad({ nodes: [N('l', 'loop')], edges: [] }) // a loop node always says how many rounds
  bad({ nodes: [N('g', 'generate', 0, { rounds: 3 })], edges: [] }) // only a loop node has rounds
  bad({ nodes: [N('t', 'text'), N('l', 'loop', 0, { rounds: 2 })], edges: [{ from: 't', to: 'l' }] }) // a loop repeats a Tạo ảnh node, not a Text
  expect(parseGraph(LOOP(2, { nodes: [N('b', 'branch', 900), N('h', 'generate', 1200), N('u', 'text', 900, { text: 'x' })], edges: [{ from: 'l', to: 'b' }, { from: 'b', to: 'h', port: 'ok' }, { from: 'u', to: 'h' }] })).edges).toHaveLength(7)
})

test('Vòng lặp, plan: unrolled into one step per round (<loop>#2, #3), same prompts, each round sequential on the one before; what is wired out of the loop gets the last round', () => {
  const { steps, errors } = plan(parseGraph(LOOP(3, { nodes: [N('u', 'text', 900, { text: 'cảnh' }), N('h', 'generate', 1200)], edges: [{ from: 'l', to: 'h' }, { from: 'u', to: 'h' }] })))
  expect(errors).toEqual([])
  expect(steps.map((s) => [s.node, s.prompts, s.images, s.deps, s.save, s.feeds, s.round])).toEqual([
    ['g', 'mèo\nchó', ['a1'], [], false, true, undefined],
    ['l#2', 'mèo\nchó', [], [{ node: 'g', port: 'direct' }], false, true, 2],
    ['l#3', 'mèo\nchó', [], [{ node: 'l#2', port: 'direct' }], true, true, 3],
    ['h', 'cảnh', [], [{ node: 'l#3', port: 'direct' }], false, false, undefined],
  ])
  // a Điều kiện after the loop looks at the last round
  const br = plan(parseGraph(LOOP(2, { nodes: [N('b', 'branch', 900), N('h', 'generate', 1200), N('u', 'text', 900, { text: 'x' })], edges: [{ from: 'l', to: 'b' }, { from: 'b', to: 'h', port: 'fail' }, { from: 'u', to: 'h' }] })))
  expect([br.errors, br.steps.at(-1)!.deps]).toEqual([[], [{ node: 'l#2', port: 'fail' }]])
})

test('Vòng lặp, plan errors: no Tạo ảnh or two of them wired in; a video node before it (a video is not a reference image); a loop back into its own node', () => {
  expect(plan(parseGraph({ nodes: [N('t', 'text', 0, { text: 'x' }), N('g', 'generate'), N('l', 'loop', 300, { rounds: 2 }), N('dl', 'download')], edges: [{ from: 't', to: 'g' }, { from: 'l', to: 'dl' }] })).errors).toEqual([{ node: 'l', code: 'WF_LOOP_INPUT' }])
  const two = plan(parseGraph(LOOP(2, { nodes: [N('g2', 'generate', 300), N('t2', 'text', 0, { text: 'y' })], edges: [{ from: 't2', to: 'g2' }, { from: 'g2', to: 'l' }] })))
  expect(two.errors).toContainEqual({ node: 'l', code: 'WF_LOOP_INPUT' })
  const video = plan(parseGraph({ nodes: [N('t', 'text', 0, { text: 'x' }), N('g', 'generate', 300, { combo: VIDEO }), N('l', 'loop', 600, { rounds: 2 }), N('dl', 'download', 900)], edges: [{ from: 't', to: 'g' }, { from: 'g', to: 'l' }, { from: 'l', to: 'dl' }] }))
  expect(video.errors).toEqual([{ node: 'l', code: 'WF_LOOP_VIDEO' }]) // its own code, not WF_VIDEO_OUTPUT as well
  const back = plan(parseGraph({ nodes: [N('t', 'text', 0, { text: 'x' }), N('g', 'generate', 300), N('l', 'loop', 600, { rounds: 2 })], edges: [{ from: 't', to: 'g' }, { from: 'g', to: 'l' }, { from: 'l', to: 'g' }] }))
  expect(back.errors).toEqual([{ node: 'g', code: 'WF_CYCLE' }])
})

test('Vòng lặp, run: one batch per round in order; round n sends prompt i with the saved result of prompt i of round n-1; only the last round is wired to Tự tải về; the run shows which round', async () => {
  const r = rig()
  const all = createWorkflows({
    db: r.db, now: () => 5, sleep: () => new Promise((x) => setTimeout(x, 1)),
    enqueue: async (a) => { r.enq.push(a as (typeof r.enq)[number]); return { batchIds: [`b${r.enq.length}`] } },
    start: async () => {}, stop: async () => {}, status: () => 'completed', download: async (b) => void r.calls.push(`download ${b}`),
    outputs: (b) => [`/dl/${b}-1.png`, `/dl/${b}-2.png`], codes: () => [null, null], register: (p) => `asset:${p}`, lastFrame: async (p) => p, merge: async () => '', savePath: async () => null, openPath: async () => null,
  })
  const { runId } = await all.handlers.runWorkflow({ graph: LOOP(3), mode: 'auto' }) as { runId: string }
  let view = await all.handlers.workflowRun(runId)
  for (let i = 0; i < 200 && view!.status === 'running'; i++) { await new Promise((x) => setTimeout(x, 5)); view = await all.handlers.workflowRun(runId) }
  expect(view!.status).toBe('done')
  expect(r.enq.map((e) => [e.commandId.split(':')[2], e.text, e.refs.mode, e.refs.assetIds])).toEqual([
    ['g', 'mèo\nchó', 'all', ['a1']],
    ['l#2', 'mèo\nchó', 'sequential', ['asset:/dl/b1-1.png', 'asset:/dl/b1-2.png']],
    ['l#3', 'mèo\nchó', 'sequential', ['asset:/dl/b2-1.png', 'asset:/dl/b2-2.png']],
  ])
  expect((r.enq[1] as unknown as { refs: { perItem: number } }).refs.perItem).toBe(1)
  expect(r.calls).toEqual(['download b1', 'download b2', 'download b3'])
  expect(view!.nodes.l).toMatchObject({ state: 'done', round: 3, rounds: 3 })
})

test('Vòng lặp, run: a round with a missing result stops the loop there (later rounds and what follows are skipped, nothing sent for them)', async () => {
  const r = rig({ missing: ['B'] })
  const { runId } = await r.wf.runWorkflow({ graph: LOOP(3), mode: 'auto' }) as { runId: string }
  expect(await r.wait(runId)).toBe('failed')
  expect(r.enq).toHaveLength(1)
  expect((await r.wf.workflowRun(runId))!.nodes.l).toMatchObject({ state: 'skipped', code: 'WF_UPSTREAM_INCOMPLETE', round: 2, rounds: 3 })
})

// ---- Bảng CSV: rows stored in the node (validated like text); the canvas fills its template per row, so plan() reads it like a Text node ----
test('Bảng CSV, parseGraph + plan: rows are bounded strings on a csv node only; it feeds a Tạo ảnh node one prompt per line like a Text node', () => {
  const g = { nodes: [N('c', 'csv', 0, { text: 'mèo ở sân\nchó ở nhà', rows: [['Tên', 'Nơi'], ['mèo', 'sân'], ['chó', 'nhà']] }), N('g', 'generate', 300)], edges: [{ from: 'c', to: 'g' }] }
  expect(parseGraph(g).nodes[0].rows).toEqual([['Tên', 'Nơi'], ['mèo', 'sân'], ['chó', 'nhà']])
  expect(plan(parseGraph(g)).steps.map((s) => s.prompts)).toEqual(['mèo ở sân\nchó ở nhà'])
  const bad = (v: unknown) => expect(() => parseGraph(v), JSON.stringify(v).slice(0, 80)).toThrow(/INVALID_ARGS/)
  const withRows = (rows: unknown, type = 'csv') => ({ nodes: [N('c', type, 0, { rows })], edges: [] })
  for (const rows of ['a,b', [['a', 1]], [null], Array(2002).fill(['x']), [Array(51).fill('x')], [['x'.repeat(1_000_001)]], Array(2).fill(['x'.repeat(600_000)])]) bad(withRows(rows))
  bad(withRows([['a']], 'text')) // only a Bảng CSV node holds rows
  bad({ nodes: [N('c', 'csv'), N('d', 'download')], edges: [{ from: 'c', to: 'd' }] })
})

// ---- Khung cuối: a video node's last frames become the start frames of the next node; Ghép video: clips of several video nodes made into one ----
// T (2 prompts) → V1 (video) → Khung cuối → V2 (video, its own 2 prompts) → Ghép video ← V1
const SCENES = (extra: { nodes?: object[]; edges?: object[] } = {}): Graph => parseGraph({
  nodes: [N('t1', 'text', 0, { text: 'cảnh 1\ncảnh 2' }), N('v1', 'generate', 300, { combo: VIDEO }), N('f', 'frame', 600), N('t2', 'text', 600, { text: 'tiếp 1\ntiếp 2' }), N('v2', 'generate', 900, { combo: VIDEO }), N('m', 'merge', 1200), ...(extra.nodes ?? [])],
  edges: [{ from: 't1', to: 'v1' }, { from: 'v1', to: 'f' }, { from: 'f', to: 'v2' }, { from: 't2', to: 'v2' }, { from: 'v1', to: 'm' }, { from: 'v2', to: 'm' }, ...(extra.edges ?? [])],
})

test('Khung cuối + Ghép video, parseGraph + plan: a frame node takes one video node and gives to Tạo ảnh; a merge node takes video nodes, in wire order', () => {
  const p = plan(SCENES())
  expect(p.errors).toEqual([])
  expect(p.steps.map((s) => [s.node, s.kind, s.save, s.feeds, s.deps])).toEqual([['v1', 'video', true, true, []], ['v2', 'video', true, false, [{ node: 'v1', port: 'direct' }]]])
  expect(p.merges).toEqual([{ node: 'm', inputs: ['v1', 'v2'] }])
  const bad = (v: unknown) => expect(() => parseGraph(v)).toThrow(/INVALID_ARGS/)
  bad({ nodes: [N('t', 'text'), N('f', 'frame')], edges: [{ from: 't', to: 'f' }] }) // a frame comes from a Tạo ảnh node
  bad({ nodes: [N('m', 'merge'), N('d', 'download')], edges: [{ from: 'm', to: 'd' }] }) // a merge saves its own file
  const img = (type: string) => plan(parseGraph({ nodes: [N('t', 'text', 0, { text: 'x' }), N('g', 'generate', 300), N('n', type, 600)], edges: [{ from: 't', to: 'g' }, { from: 'g', to: 'n' }] })).errors
  expect(img('frame')).toEqual([{ node: 'n', code: 'WF_FRAME_INPUT' }]) // an image node has no last frame
  expect(img('merge')).toEqual([{ node: 'n', code: 'WF_MERGE_INPUT' }])
  expect(plan(parseGraph({ nodes: [N('t', 'text', 0, { text: 'x' }), N('g', 'generate', 300), N('m', 'merge', 600)], edges: [{ from: 't', to: 'g' }] })).errors).toEqual([{ node: 'm', code: 'WF_MERGE_INPUT' }]) // nothing wired in
  const two = plan(SCENES({ nodes: [N('t3', 'text', 0, { text: 'y' }), N('v3', 'generate', 300, { combo: VIDEO })], edges: [{ from: 't3', to: 'v3' }, { from: 'v3', to: 'f' }] })).errors
  expect(two).toContainEqual({ node: 'f', code: 'WF_FRAME_INPUT' }) // exactly one video node
})

test('Khung cuối + Ghép video, run: prompt i of the next scene starts from the last frame of prompt i; the merge gets every clip of V1 then V2 and names its file', async () => {
  const t = rig()
  const runId = ((await t.wf.runWorkflow({ graph: SCENES(), mode: 'auto' })) as { runId: string }).runId
  expect(await t.wait(runId)).toBe('done')
  expect(t.calls.filter((c) => c.startsWith('frame'))).toEqual(['frame /dl/A.png', 'frame /dl/B.png'])
  expect([t.enq[1].refs.mode, t.enq[1].refs.assetIds]).toEqual(['sequential', ['asset:/dl/A.png.last.png', 'asset:/dl/B.png.last.png']])
  const merge = t.calls.find((c) => c.startsWith('merge'))!
  expect(merge).toMatch(/^merge \/dl\/A\.png,\/dl\/B\.png,\/dl\/c\.png ghep-video-[\w-]{8}\.mp4$/)
  expect((await t.wf.workflowRun(runId))!.nodes.m).toMatchObject({ state: 'done', file: expect.stringMatching(/^ghep-video-/) })
  await t.wf.revealWorkflowFile({ runId, node: 'm' }) // the path stays in main
  await expect(t.wf.revealWorkflowFile({ runId, node: 'v1' })).rejects.toMatchObject({ code: 'WF_FILE_GONE' })
})

test('Khung cuối + Ghép video, run: a missing clip skips the merge (never a video with a scene missing); a frame that ffmpeg cannot read fails the node and skips the next scene', async () => {
  const gone = rig({ missing: ['B'] })
  const id1 = ((await gone.wf.runWorkflow({ graph: SCENES(), mode: 'auto' })) as { runId: string }).runId
  expect(await gone.wait(id1)).toBe('failed')
  expect(gone.calls.some((c) => c.startsWith('merge'))).toBe(false)
  expect((await gone.wf.workflowRun(id1))!.nodes.m).toMatchObject({ state: 'skipped', code: 'WF_UPSTREAM_INCOMPLETE' })
  const bad = rig({ frameFails: true })
  const id2 = ((await bad.wf.runWorkflow({ graph: SCENES(), mode: 'auto' })) as { runId: string }).runId
  expect(await bad.wait(id2)).toBe('failed')
  expect(bad.enq).toHaveLength(1)
  const n = (await bad.wf.workflowRun(id2))!.nodes
  expect([n.v1.state, n.v1.code, n.v2.state]).toEqual(['failed', 'FFMPEG_FAILED', 'skipped'])
})

test('a save that fails once right after the result is tried again before what needs the file (seen live: a fresh Flow video)', async () => {
  const t = rig({ late: true })
  const runId = ((await t.wf.runWorkflow({ graph: SCENES(), mode: 'auto' })) as { runId: string }).runId
  expect(await t.wait(runId)).toBe('done')
  expect(t.calls.filter((c) => c === 'download b1')).toHaveLength(2)
  expect(t.calls.filter((c) => c.startsWith('frame'))).toEqual(['frame /dl/A.png', 'frame /dl/B.png'])
  expect((await t.wf.workflowRun(runId))!.nodes.m.state).toBe('done')
})
