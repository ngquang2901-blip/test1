// Node workflows (TobyFlow-style canvas): Text / Ảnh → Tạo ảnh Flow → Tự tải về. A run is compiled onto the existing batch
// path: every "generate" node becomes one batch through the same enqueue the Tạo lô screen uses, so each send keeps every
// guarantee of a batch (intent first, never sent twice, refs checked). Nothing here talks to Flow directly.
import { randomUUID } from 'node:crypto'
import type { Db } from './db'

export type WfNode = { id: string; type: 'text' | 'image' | 'generate' | 'download' | 'note'; x: number; y: number; text?: string; assetIds?: string[] }
export type Graph = { nodes: WfNode[]; edges: { from: string; to: string }[] }
/** One generate node, ready to run: prompts = one per non-empty line; from = upstream generate nodes whose results become refs. */
export type Step = { node: string; prompts: string; images: string[]; from: string[]; save: boolean; feeds: boolean }
export type NodeRun = { state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'stopped'; code?: string; batchIds: string[]; assets?: string[] }
export type Run = { id: string; status: 'running' | 'done' | 'failed' | 'stopped'; stop: boolean; nodes: Record<string, NodeRun> }

const TYPES = ['text', 'image', 'generate', 'download', 'note']
const WIRES: Record<string, string[]> = { text: ['generate'], image: ['generate'], generate: ['generate', 'download'] } // source type → allowed target types
const ID = /^[\w-]{1,64}$/
const MAX_REFS = 8 // the batch path takes at most 8 reference images per prompt
const ACTIVE = ['queued', 'running', 'paused', 'needs_review']
const bad = (): never => { throw Object.assign(new Error('INVALID_ARGS'), { code: 'INVALID_ARGS' }) }
const lines = (s: string): number => s.split(/\r\n|\n/).filter((l) => l.trim() !== '').length

/** The renderer's graph is untrusted: types, sizes, ids, and only the wires that mean something. */
export function parseGraph(v: unknown): Graph {
  const o = v as { nodes?: unknown; edges?: unknown } | null
  if (!o || !Array.isArray(o.nodes) || !Array.isArray(o.edges) || o.nodes.length > 100 || o.edges.length > 400) bad()
  const nodes = (o!.nodes as Record<string, unknown>[]).map((n): WfNode => {
    if (!n || typeof n.id !== 'string' || !ID.test(n.id) || !TYPES.includes(n.type as string) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) bad()
    if (n.text !== undefined && (typeof n.text !== 'string' || n.text.length > 100_000)) bad()
    if (n.assetIds !== undefined && !(Array.isArray(n.assetIds) && n.assetIds.length <= MAX_REFS && n.assetIds.every((a) => typeof a === 'string' && ID.test(a)))) bad()
    return { id: n.id as string, type: n.type as WfNode['type'], x: n.x as number, y: n.y as number, ...(n.text !== undefined ? { text: n.text as string } : {}), ...(n.assetIds ? { assetIds: n.assetIds as string[] } : {}) }
  })
  const byId = new Map(nodes.map((n) => [n.id, n]))
  if (byId.size !== nodes.length) bad()
  const seen = new Set<string>()
  const edges = (o!.edges as { from?: unknown; to?: unknown }[]).map((e) => {
    const a = byId.get(e?.from as string), b = byId.get(e?.to as string)
    if (!a || !b || !WIRES[a.type]?.includes(b.type) || seen.has(`${a.id}>${b.id}`)) return bad()
    seen.add(`${a.id}>${b.id}`)
    return { from: a.id, to: b.id }
  })
  return { nodes, edges }
}

/** Generate nodes in running order (upstream first, then left to right), or the reasons the graph cannot run. */
export function plan(g: Graph): { steps: Step[]; errors: { node?: string; code: string }[] } {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const into = (id: string, type: string): WfNode[] => g.edges.filter((e) => e.to === id).map((e) => byId.get(e.from)!).filter((n) => n.type === type)
  const gens = g.nodes.filter((n) => n.type === 'generate').sort((a, b) => a.x - b.x || a.y - b.y)
  if (!gens.length) return { steps: [], errors: [{ code: 'WF_NO_GENERATE' }] }
  const order: WfNode[] = [], left = new Set(gens.map((n) => n.id))
  for (let moved = true; moved;) { // Kahn: take every node whose upstream is done; what never gets taken sits on a loop
    moved = false
    for (const n of gens) if (left.has(n.id) && into(n.id, 'generate').every((u) => !left.has(u.id))) { left.delete(n.id); order.push(n); moved = true }
  }
  if (left.size) return { steps: [], errors: [...left].map((node) => ({ node, code: 'WF_CYCLE' })) }
  const errors: { node?: string; code: string }[] = [], count = new Map<string, number>()
  const steps = order.map((n): Step => {
    const prompts = into(n.id, 'text').map((t) => t.text ?? '').join('\n')
    const images = [...new Set(into(n.id, 'image').flatMap((i) => i.assetIds ?? []))]
    const from = into(n.id, 'generate').map((u) => u.id)
    count.set(n.id, lines(prompts))
    if (!lines(prompts)) errors.push({ node: n.id, code: 'WF_NO_PROMPT' })
    else if (images.length + from.reduce((s, u) => s + (count.get(u) ?? 0), 0) > MAX_REFS) errors.push({ node: n.id, code: 'TOO_MANY_REFS' }) // one result image per upstream prompt
    const outs = g.edges.filter((e) => e.from === n.id).map((e) => byId.get(e.to)!.type)
    return { node: n.id, prompts, images, from, save: outs.includes('download'), feeds: outs.includes('generate') }
  })
  return { steps, errors }
}

type Enqueued = { batchId?: string; batchIds?: string[]; errors?: { code: string }[] }
export type WfDeps = {
  db: Db; now(): number; sleep?(ms: number): Promise<void>
  enqueue(a: object): Promise<Enqueued>; start(batchId: string): Promise<unknown>; stop(batchId: string): Promise<unknown> // the same handlers the Tạo lô / Hàng đợi screens call
  status(batchId: string): string; download(batchId: string): Promise<unknown>
  outputs(batchId: string): (string | null)[] // per prompt: the path of its first saved result, null when none is saved
  register(path: string): string // a saved result as a reference asset
}

export function createWorkflows(d: WfDeps) {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const runs = new Map<string, Run>()
  const code = (e: unknown): string => (e as { code?: string })?.code ?? 'INTERNAL_ERROR'

  // shortcut: nodes run one after another and a run lives in memory (after an app restart its batches go on, later nodes do not start); run branches in parallel / persist the run when users build wide graphs
  async function exec(run: Run, steps: Step[], mode: 'auto' | 'manual'): Promise<void> {
    for (const s of steps) {
      const n = run.nodes[s.node]
      if (run.stop) { n.state = 'stopped'; continue }
      const up = s.from.map((f) => run.nodes[f].assets)
      if (up.some((a) => !a)) { n.state = 'skipped'; n.code = 'WF_UPSTREAM_INCOMPLETE'; continue } // never send without the reference the user wired
      try {
        n.state = 'running'
        const refs = [...s.images, ...up.flatMap((a) => a!)]
        const r = await d.enqueue({ commandId: `wf:${run.id}:${s.node}`, kind: 'image', mode, text: s.prompts, refs: { assetIds: refs, mode: refs.length ? 'all' : 'none', perItem: MAX_REFS } })
        if (r.errors?.length) { n.state = 'failed'; n.code = r.errors[0].code; continue }
        n.batchIds = r.batchIds ?? [r.batchId!]
        for (const b of n.batchIds) await d.start(b)
        while (!run.stop && n.batchIds.some((b) => ACTIVE.includes(d.status(b)))) await sleep(500) // paused / needs_review wait for the user in Hàng đợi
        if (run.stop) { for (const b of n.batchIds) await d.stop(b); n.state = 'stopped'; continue }
        if (s.save || s.feeds) for (const b of n.batchIds) await d.download(b)
        if (s.feeds) {
          const files = n.batchIds.flatMap((b) => d.outputs(b))
          if (files.every((f): f is string => !!f)) n.assets = files.map((f) => d.register(f))
        }
        const notOk = n.batchIds.map((b) => d.status(b)).find((st) => st !== 'completed')
        n.state = notOk ? 'failed' : 'done'
        if (notOk) n.code = `WF_BATCH_${notOk.toUpperCase()}`
      } catch (e) { n.state = 'failed'; n.code = code(e) }
    }
    const states = Object.values(run.nodes).map((x) => x.state)
    run.status = run.stop ? 'stopped' : states.every((x) => x === 'done') ? 'done' : 'failed'
  }

  const assetOf = d.db.prepare('select id, name, bytes from asset where id=?')
  return {
    active: (): boolean => [...runs.values()].some((r) => r.status === 'running'), // not an IPC handler: main asks before restarting for an update
    handlers: {
    async listWorkflows() { // image nodes carry names and sizes, never paths; a file no longer registered is marked missing
      return (d.db.prepare('select id, name, json from workflow order by updated_at desc').all() as { id: string; name: string; json: string }[]).map((r) => {
        const g = JSON.parse(r.json) as Graph
        return { id: r.id, name: r.name, edges: g.edges, nodes: g.nodes.map((n) => ({ ...n, ...(n.assetIds ? { assets: n.assetIds.map((id) => assetOf.get(id) ?? { id, name: '', bytes: 0, missing: true }) } : {}) })) }
      })
    },
    async saveWorkflow(a: unknown) { // same name = update
      const o = a as { name?: unknown; graph?: unknown } | null, name = typeof o?.name === 'string' ? o.name.trim() : ''
      if (!name || name.length > 60) bad()
      const g = parseGraph(o!.graph)
      const id = (d.db.prepare('select id from workflow where name=?').get(name) as { id: string } | undefined)?.id ?? randomUUID()
      d.db.prepare('insert into workflow(id,name,json,updated_at) values(?,?,?,?) on conflict(name) do update set json=excluded.json, updated_at=excluded.updated_at').run(id, name, JSON.stringify(g), d.now())
      return { id }
    },
    async deleteWorkflow(a: unknown) { d.db.prepare('delete from workflow where id=?').run(typeof a === 'string' ? a : bad()) },
    /** Starts the run and returns at once; the canvas polls workflowRun. A graph that cannot run returns its errors and sends nothing. */
    async runWorkflow(a: unknown) {
      const o = a as { graph?: unknown; mode?: unknown } | null
      const mode = o?.mode === 'auto' || o?.mode === 'manual' ? o.mode : bad()
      const g = parseGraph(o!.graph), { steps, errors } = plan(g)
      for (const s of steps) if (s.images.some((id) => !assetOf.get(id))) errors.push({ node: s.node, code: 'REF_ASSET_MISSING' })
      if (errors.length) return { errors }
      const run: Run = { id: randomUUID(), status: 'running', stop: false, nodes: Object.fromEntries(steps.map((s) => [s.node, { state: 'waiting', batchIds: [] }])) }
      for (const [id, r] of runs) if (r.status !== 'running' && runs.size >= 20) runs.delete(id) // finished runs are only kept for the canvas that started them
      runs.set(run.id, run)
      void exec(run, steps, mode).catch((e) => { run.status = 'failed'; console.error('workflow', code(e)) })
      return { runId: run.id }
    },
    async stopWorkflow(a: unknown) { // no new node starts; the node that is running has its batches stopped like the Dừng button
      const run = runs.get(a as string)
      if (!run || run.status !== 'running') return
      run.stop = true
      for (const n of Object.values(run.nodes)) if (n.state === 'running') for (const b of n.batchIds) await d.stop(b)
    },
    async workflowRun(a: unknown) { // per node: state, progress, and one saved result to show (ids only)
      const run = runs.get(a as string)
      if (!run) return null
      const items = d.db.prepare('select a.id aid, a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=?')
      const saved = d.db.prepare("select attempt_id attemptId, media_id mediaId from download where attempt_id=? and state='completed' limit 1")
      return { status: run.status, nodes: Object.fromEntries(Object.entries(run.nodes).map(([id, n]) => {
        const its = n.batchIds.flatMap((b) => items.all(b) as { aid: string; j: string }[])
        return [id, { state: n.state, code: n.code ?? null, total: its.length, done: its.filter((x) => JSON.parse(x.j).item === 'ready').length, thumb: its.map((x) => saved.get(x.aid)).find(Boolean) ?? null }]
      })) }
    },
    },
  }
}
