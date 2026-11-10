import { test, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
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
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-wf-')), 't.db'))
  db.prepare("insert into asset(id,path,sha256,bytes,mime,name,created_at) values('a1','/x/a.png','h',3,'image/png','a.png',1)").run()
  const calls: string[] = [], enq: { commandId: string; text: string; mode: string; refs: { assetIds: string[]; mode: string } }[] = []
  const all = createWorkflows({
    db, now: () => 5, sleep: () => new Promise((r) => setTimeout(r, 1)), // a real macrotask: an instant sleep would starve the timers while a batch is "running"
    enqueue: async (a) => { enq.push(a as (typeof enq)[number]); return { batchIds: [`b${enq.length}`] } },
    start: async (b) => void calls.push(`start ${b}`), stop: async (b) => void calls.push(`stop ${b}`),
    status: o.statusOf ?? (() => 'completed'), download: async (b) => void calls.push(`download ${b}`),
    outputs: (b) => (b === 'b1' ? ['/dl/A.png', (o.missing ?? []).includes('B') ? null : '/dl/B.png'] : ['/dl/c.png']),
    register: (p) => `asset:${p}`,
  })
  const wf = all.handlers
  const wait = async (runId: string): Promise<string> => { for (let i = 0; i < 200; i++) { const r = await wf.workflowRun(runId); if (r!.status !== 'running') return r!.status; await new Promise((r) => setTimeout(r, 5)) } return 'timeout' }
  return { db, wf, calls, enq, wait, active: all.active }
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
  bad({ nodes: [N('t', 'text', 0, { text: 'x'.repeat(100_001) })], edges: [] })
  bad({ nodes: [{ id: 't', type: 'text', x: 'left', y: 0 }], edges: [] })
  bad({ nodes: [N('i', 'image', 0, { assetIds: Array(9).fill('a') })], edges: [] })
})

test('plan: upstream first; prompts are the wired Text lines; a result wire makes the upstream feed and the node depend on it', () => {
  const { steps, errors } = plan(CHAIN)
  expect(errors).toEqual([])
  expect(steps).toEqual([
    { node: 'g1', prompts: 'nhân vật A\n\nnhân vật B', images: ['a1'], from: [], save: false, feeds: true },
    { node: 'g2', prompts: 'cảnh 1', images: [], from: ['g1'], save: true, feeds: false },
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
