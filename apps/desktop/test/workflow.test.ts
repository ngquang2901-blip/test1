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

function rig(o: { missing?: string[]; statusOf?: (b: string) => string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-wf-')), file = join(dir, 'out.toolflow.json'), dialogs: string[] = []
  const db = openDb(join(dir, 't.db'))
  db.prepare("insert into asset(id,path,sha256,bytes,mime,name,created_at) values('a1','/x/a.png','h',3,'image/png','a.png',1)").run()
  const calls: string[] = [], enq: { commandId: string; text: string; mode: string; refs: { assetIds: string[]; mode: string } }[] = []
  const all = createWorkflows({
    db, now: () => 5, sleep: () => new Promise((r) => setTimeout(r, 1)), // a real macrotask: an instant sleep would starve the timers while a batch is "running"
    enqueue: async (a) => { enq.push(a as (typeof enq)[number]); return { batchIds: [`b${enq.length}`] } },
    start: async (b) => void calls.push(`start ${b}`), stop: async (b) => void calls.push(`stop ${b}`),
    status: o.statusOf ?? (() => 'completed'), download: async (b) => void calls.push(`download ${b}`),
    outputs: (b) => (b === 'b1' ? ['/dl/A.png', (o.missing ?? []).includes('B') ? null : '/dl/B.png'] : ['/dl/c.png']),
    register: (p) => `asset:${p}`,
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
  bad({ nodes: [N('i', 'image', 0, { assetIds: Array(9).fill('a') })], edges: [] })
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
    { node: 'g1', prompts: 'nhân vật A\n\nnhân vật B', images: ['a1'], deps: [], save: false, feeds: true },
    { node: 'g2', prompts: 'cảnh 1', images: [], deps: [{ node: 'g1', port: 'direct' }], save: true, feeds: false },
  ])
})

test('plan: reasons a graph cannot run', () => {
  expect(plan(parseGraph({ nodes: [N('t', 'text', 0, { text: 'x' })], edges: [] })).errors).toEqual([{ code: 'WF_NO_GENERATE' }])
  expect(plan(parseGraph({ nodes: [N('t', 'text', 0, { text: '  \n' }), N('g', 'generate')], edges: [{ from: 't', to: 'g' }] })).errors).toEqual([{ node: 'g', code: 'WF_NO_PROMPT' }])
  const loop = plan(parseGraph({ nodes: [N('a', 'generate'), N('b', 'generate')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }))
  expect(loop.errors.map((e) => e.code)).toEqual(['WF_CYCLE', 'WF_CYCLE'])
  const many = Array.from({ length: 9 }, (_, i) => `p${i}`).join('\n') // 9 upstream prompts ⇒ 9 result refs for one prompt
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
