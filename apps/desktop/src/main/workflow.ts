// Node workflows (TobyFlow-style canvas): Text / Ảnh → Tạo ảnh Flow → Tự tải về. A run is compiled onto the existing batch
// path: every "generate" node becomes one batch through the same enqueue the Tạo lô screen uses, so each send keeps every
// guarantee of a batch (intent first, never sent twice, refs checked). Nothing here talks to Flow directly.
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Db } from './db'
import { safeComponent } from './downloads'
import { comboQualified, type Combo } from './profile'
import { GEM_ASPECTS, GEM_MODELS, type Site } from './gpt-driver'

type Cond = 'all' | 'any' | 'filtered' // what a Điều kiện node asks about the generate node wired into it: every prompt has a saved result / at least one has / Flow blocked a prompt
/** combo: a Tạo ảnh node's own model / aspect / thinking level / count (absent = the app's default). cond: a Điều kiện node's question (absent = 'all'). */
export type WfNode = { id: string; type: 'text' | 'image' | 'generate' | 'download' | 'note' | 'branch'; x: number; y: number; text?: string; assetIds?: string[]; combo?: Combo; cond?: Cond; site?: Site; aspect?: string; model?: string } // site: a Tạo ảnh node that goes to ChatGPT / Gemini instead of Flow (aspect, model: Gemini's menus)
type Port = 'ok' | 'fail' // the two outputs of a Điều kiện node: its question is answered yes / no
export type Graph = { nodes: WfNode[]; edges: { from: string; to: string; port?: Port }[]; vars?: Record<string, string> } // vars: the canvas's reusable {biến}; main only stores them (the renderer fills them in before a run)
type Dep = { node: string; port: 'direct' | Port; cond?: Cond } // cond: only through a Điều kiện node that asks something other than 'all'
/** One generate node, ready to run: prompts = one per non-empty line; deps = the generate nodes it waits for (see carries() for which hand their results on as refs). */
export type Step = { node: string; kind: 'image' | 'video'; prompts: string; images: string[]; deps: Dep[]; save: boolean; feeds: boolean; combo?: Combo; site?: Site; aspect?: string; model?: string } // kind: the node's settings decide (video settings = a video node)
/** assets: per prompt, its first saved result as a reference asset (null = none saved); blocked: Flow refused a prompt of this node for its content. Both only for a node something waits for. */
export type NodeRun = { state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'bypassed' | 'stopped'; code?: string; batchIds: string[]; assets?: (string | null)[]; blocked?: boolean }
export type Run = { id: string; status: 'running' | 'done' | 'failed' | 'stopped'; stop: boolean; nodes: Record<string, NodeRun> }

const TYPES = ['text', 'image', 'generate', 'download', 'note', 'branch']
const CONDS = ['all', 'any', 'filtered']
const WIRES: Record<string, string[]> = { text: ['generate'], image: ['generate'], generate: ['generate', 'download', 'branch'], branch: ['generate'] } // source type → allowed target types
const ID = /^[\w-]{1,64}$/
export const MAX_REFS = 10 // reference images per prompt: 10 were sent live (2026-11-11); more is not proven
const ACTIVE = ['queued', 'running', 'paused', 'needs_review']
const coded = (code: string): Error => Object.assign(new Error(code), { code })
const bad = (): never => { throw coded('INVALID_ARGS') }
const lines = (s: string): number => s.split(/\r\n|\n/).filter((l) => l.trim() !== '').length
/** A wire that hands the upstream results on as reference images: a direct wire, or the "yes" side of a question about having images. */
const carries = (dp: Dep): boolean => dp.port === 'direct' || (dp.port === 'ok' && dp.cond !== 'filtered')
/** Shape only, rebuilt from the known keys. Whether the combo may run is asked when it runs: a file can come from another app version. */
function comboOf(v: unknown): Combo {
  const c = v as Record<string, unknown> | null, short = (x: unknown): boolean => typeof x === 'string' && x.length > 0 && x.length <= 60
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some((k) => !['kind', 'mode', 'model', 'aspect', 'quality', 'count'].includes(k))) bad()
  if ((c!.kind !== 'image' && c!.kind !== 'video') || ![c!.mode, c!.model, c!.aspect].every(short) || !(c!.quality === undefined || short(c!.quality)) || !Number.isInteger(c!.count) || (c!.count as number) < 1 || (c!.count as number) > 8) bad()
  return { kind: c!.kind as Combo['kind'], mode: c!.mode as string, model: c!.model as string, aspect: c!.aspect as string, ...(c!.quality !== undefined ? { quality: c!.quality as string } : {}), count: c!.count as number }
}

/** The renderer's graph (or an imported file) is untrusted: types, sizes, ids, and only the wires that mean something. */
export function parseGraph(v: unknown): Graph {
  const o = v as { nodes?: unknown; edges?: unknown; vars?: unknown } | null
  if (!o || !Array.isArray(o.nodes) || !Array.isArray(o.edges) || o.nodes.length > 100 || o.edges.length > 400) bad()
  const nodes = (o!.nodes as Record<string, unknown>[]).map((n): WfNode => {
    if (!n || typeof n.id !== 'string' || !ID.test(n.id) || !TYPES.includes(n.type as string) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) bad()
    if (n.text !== undefined && (typeof n.text !== 'string' || n.text.length > 1_000_000)) bad() // the same cap as a batch's prompt list
    if (n.assetIds !== undefined && !(Array.isArray(n.assetIds) && n.assetIds.length <= MAX_REFS && n.assetIds.every((a) => typeof a === 'string' && ID.test(a)))) bad()
    if (n.combo !== undefined && n.type !== 'generate') bad() // settings belong to a Tạo ảnh node
    if (n.cond !== undefined && (n.type !== 'branch' || !CONDS.includes(n.cond as string))) bad()
    if (n.site !== undefined && (n.type !== 'generate' || (n.site !== 'chatgpt' && n.site !== 'gemini') || n.combo !== undefined)) bad() // a site node has no Flow settings
    if (n.aspect !== undefined && (n.site !== 'gemini' || !(GEM_ASPECTS as readonly unknown[]).includes(n.aspect))) bad()
    if (n.model !== undefined && (n.site !== 'gemini' || !(GEM_MODELS as readonly unknown[]).includes(n.model))) bad()
    return { id: n.id as string, type: n.type as WfNode['type'], x: n.x as number, y: n.y as number, ...(n.text !== undefined ? { text: n.text as string } : {}), ...(n.assetIds ? { assetIds: n.assetIds as string[] } : {}),
      ...(n.combo !== undefined ? { combo: comboOf(n.combo) } : {}), ...(n.cond !== undefined ? { cond: n.cond as Cond } : {}), ...(n.site !== undefined ? { site: n.site as Site } : {}), ...(n.aspect !== undefined ? { aspect: n.aspect as string } : {}), ...(n.model !== undefined ? { model: n.model as string } : {}) }
  })
  const byId = new Map(nodes.map((n) => [n.id, n]))
  if (byId.size !== nodes.length) bad()
  const seen = new Set<string>()
  const edges = (o!.edges as { from?: unknown; to?: unknown; port?: unknown }[]).map((e) => {
    const a = byId.get(e?.from as string), b = byId.get(e?.to as string)
    if (!a || !b || !WIRES[a.type]?.includes(b.type) || seen.has(`${a.id}>${b.id}`)) return bad()
    if (a.type === 'branch' ? e.port !== 'ok' && e.port !== 'fail' : e.port !== undefined) return bad() // a port exists only on a Điều kiện node
    seen.add(`${a.id}>${b.id}`)
    return { from: a.id, to: b.id, ...(e.port ? { port: e.port as Port } : {}) }
  })
  if (o!.vars === undefined) return { nodes, edges }
  const vars = o!.vars && typeof o!.vars === 'object' && !Array.isArray(o!.vars) ? Object.entries(o!.vars) : bad()
  if (vars.length > 30 || vars.some(([k, val]) => !/^[^{}\n]{1,40}$/.test(k) || typeof val !== 'string' || val.length > 10_000)) bad()
  return { nodes, edges, vars: Object.fromEntries(vars) as Record<string, string> }
}

/** Generate nodes in running order (upstream first, then left to right), and the reasons the graph cannot run. */
export function plan(g: Graph): { steps: Step[]; errors: { node?: string; code: string }[] } {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const into = (id: string, type: string): WfNode[] => g.edges.filter((e) => e.to === id).map((e) => byId.get(e.from)!).filter((n) => n.type === type)
  const gens = g.nodes.filter((n) => n.type === 'generate').sort((a, b) => a.x - b.x || a.y - b.y)
  if (!gens.length) return { steps: [], errors: [{ code: 'WF_NO_GENERATE' }] }
  const errors: { node?: string; code: string }[] = []
  // what a generate node waits for: generate nodes wired straight in, or through a Điều kiện node (which looks at the one generate node wired into it)
  const depsOf = new Map(gens.map((n) => [n.id, g.edges.filter((e) => e.to === n.id).flatMap((e): Dep[] => {
    const src = byId.get(e.from)!
    if (src.type === 'generate') return [{ node: src.id, port: 'direct' }]
    if (src.type !== 'branch') return []
    const ins = into(src.id, 'generate')
    if (ins.length !== 1) { if (!errors.some((x) => x.node === src.id)) errors.push({ node: src.id, code: 'WF_BRANCH_INPUT' }); return [] }
    return [{ node: ins[0].id, port: e.port!, ...(src.cond && src.cond !== 'all' ? { cond: src.cond } : {}) }]
  })]))
  const order: WfNode[] = [], left = new Set(gens.map((n) => n.id))
  for (let moved = true; moved;) { // Kahn: take every node whose upstream is done; what never gets taken sits on a loop
    moved = false
    for (const n of gens) if (left.has(n.id) && depsOf.get(n.id)!.every((u) => !left.has(u.node))) { left.delete(n.id); order.push(n); moved = true }
  }
  if (left.size) return { steps: [], errors: [...left].map((node) => ({ node, code: 'WF_CYCLE' })) }
  const count = new Map<string, number>()
  const steps = order.map((n): Step => {
    const prompts = into(n.id, 'text').map((t) => t.text ?? '').join('\n')
    const images = [...new Set(into(n.id, 'image').flatMap((i) => i.assetIds ?? []))]
    const deps = depsOf.get(n.id)!, kind = n.combo?.kind ?? 'image'
    const refs = images.length + deps.reduce((s, u) => s + (carries(u) ? count.get(u.node) ?? 0 : 0), 0) // one result image per upstream prompt
    count.set(n.id, lines(prompts))
    if (!lines(prompts)) errors.push({ node: n.id, code: 'WF_NO_PROMPT' })
    else if (kind === 'video' ? refs > 1 && refs !== lines(prompts) : refs > MAX_REFS) errors.push({ node: n.id, code: kind === 'video' ? 'WF_VIDEO_FRAMES' : 'TOO_MANY_REFS' }) // a video starts from one image: the same for all prompts, or one each
    if (n.combo && !comboQualified(kind, n.combo)) errors.push({ node: n.id, code: 'COMBO_NOT_QUALIFIED' }) // AC-03: no other combo is used instead
    const outs = g.edges.filter((e) => e.from === n.id).map((e) => byId.get(e.to)!.type)
    if (kind === 'video' && outs.some((t) => t !== 'download')) errors.push({ node: n.id, code: 'WF_VIDEO_OUTPUT' }) // a video is not a reference image, and a Điều kiện node reads images
    return { node: n.id, kind, prompts, images, deps, save: outs.includes('download'), feeds: outs.includes('generate') || outs.includes('branch'), ...(n.combo ? { combo: n.combo } : {}), ...(n.site ? { site: n.site } : {}), ...(n.aspect ? { aspect: n.aspect } : {}), ...(n.model ? { model: n.model } : {}) }
  })
  return { steps, errors }
}

// What a wire does once the node it waits for has ended. That node's own branch was not taken ⇒ this one is not either;
// it never ran or was cut off (stopped, not enqueued) ⇒ skipped. Otherwise it ran: a direct wire needs every prompt's saved result
// (never send without the reference the user wired); a Điều kiện wire runs on its side of the answer.
function take(dp: Dep, u: NodeRun): 'run' | 'bypassed' | 'skipped' {
  if (u.state === 'bypassed') return 'bypassed'
  if (!(u.batchIds.length && (u.state === 'done' || u.state === 'failed'))) return 'skipped'
  const saved = u.assets ?? [], full = saved.length > 0 && saved.every(Boolean)
  if (dp.port === 'direct') return full ? 'run' : 'skipped'
  const yes = dp.cond === 'any' ? saved.some(Boolean) : dp.cond === 'filtered' ? !!u.blocked : full
  return yes === (dp.port === 'ok') ? 'run' : 'bypassed'
}

type Enqueued = { batchId?: string; batchIds?: string[]; errors?: { code: string }[] }
export type WfDeps = {
  db: Db; now(): number; sleep?(ms: number): Promise<void>
  enqueue(a: object): Promise<Enqueued>; start(batchId: string): Promise<unknown>; stop(batchId: string): Promise<unknown> // the same handlers the Tạo lô / Hàng đợi screens call
  status(batchId: string): string; download(batchId: string): Promise<unknown>
  outputs(batchId: string): (string | null)[] // per prompt: the path of its first saved result, null when none is saved
  codes(batchId: string): (string | null)[] // per prompt: the error code it ended with, null when none
  register(path: string): string // a saved result as a reference asset
  savePath(suggested: string): Promise<string | null>; openPath(): Promise<string | null> // the OS file dialogs (null = cancelled)
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
      const takes = s.deps.map((dp) => take(dp, run.nodes[dp.node]))
      if (takes.includes('skipped')) { n.state = 'skipped'; n.code = 'WF_UPSTREAM_INCOMPLETE'; continue }
      if (takes.includes('bypassed')) { n.state = 'bypassed'; continue } // the other side of a Điều kiện: not an error
      try {
        n.state = 'running'
        const refs = [...s.images, ...s.deps.flatMap((dp) => (carries(dp) ? (run.nodes[dp.node].assets ?? []).filter((a): a is string => !!a) : []))]
        const each = s.kind === 'video' && refs.length > 1 // a video's start frames: prompt i gets image i
        const r = await d.enqueue({ commandId: `wf:${run.id}:${s.node}`, kind: s.kind, mode: s.site ? 'auto' : mode, text: s.prompts, refs: { assetIds: refs, mode: each ? 'sequential' : refs.length ? 'all' : 'none', perItem: each ? 1 : MAX_REFS }, ...(s.combo ? { combo: s.combo } : {}), ...(s.site ? { provider: s.site, ...(s.aspect ? { aspect: s.aspect } : {}), ...(s.model ? { model: s.model } : {}) } : {}) }) // a site's batch is always sent by the app
        if (r.errors?.length) { n.state = 'failed'; n.code = r.errors[0].code; continue }
        n.batchIds = r.batchIds ?? [r.batchId!]
        for (const b of n.batchIds) await d.start(b)
        while (!run.stop && n.batchIds.some((b) => ACTIVE.includes(d.status(b)))) await sleep(500) // paused / needs_review wait for the user in Hàng đợi
        if (run.stop) { for (const b of n.batchIds) await d.stop(b); n.state = 'stopped'; continue }
        if (s.feeds) n.blocked = n.batchIds.some((b) => d.codes(b).includes('CONTENT_BLOCKED')) // what Flow answered: known before, and whatever becomes of, the saving below
        if (s.save || s.feeds) for (const b of n.batchIds) await d.download(b)
        if (s.feeds) n.assets = n.batchIds.flatMap((b) => d.outputs(b)).map((f) => (f ? d.register(f) : null))
        const notOk = n.batchIds.map((b) => d.status(b)).find((st) => st !== 'completed')
        n.state = notOk ? 'failed' : 'done'
        if (notOk) n.code = `WF_BATCH_${notOk.toUpperCase()}`
      } catch (e) { n.state = 'failed'; n.code = code(e) }
    }
    const states = Object.values(run.nodes).map((x) => x.state)
    run.status = run.stop ? 'stopped' : states.every((x) => x === 'done' || x === 'bypassed') ? 'done' : 'failed'
  }

  const assetOf = d.db.prepare('select id, name, bytes from asset where id=?')
  // for the canvas: image nodes carry names and sizes, never paths; a file not registered on this machine is marked missing
  const forCanvas = (g: Graph) => ({ edges: g.edges, vars: g.vars ?? {}, nodes: g.nodes.map((n) => ({ ...n, ...(n.assetIds ? { assets: n.assetIds.map((id) => assetOf.get(id) ?? { id, name: '', bytes: 0, missing: true }) } : {}) })) })
  return {
    active: (): boolean => [...runs.values()].some((r) => r.status === 'running'), // not an IPC handler: main asks before restarting for an update
    handlers: {
      async listWorkflows() {
        return (d.db.prepare('select id, name, json from workflow order by updated_at desc').all() as { id: string; name: string; json: string }[]).map((r) => ({ id: r.id, name: r.name, ...forCanvas(JSON.parse(r.json) as Graph) }))
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
      /** The canvas as a .json file the user can keep or copy to another machine (image nodes keep ids only: files are picked again there). */
      async exportWorkflow(a: unknown) {
        const o = a as { name?: unknown; graph?: unknown } | null, g = parseGraph(o?.graph)
        const name = typeof o?.name === 'string' ? o.name.trim().slice(0, 60) : ''
        const path = await d.savePath(`${safeComponent(name || 'workflow')}.toolflow.json`)
        if (!path) return { saved: false }
        writeFileSync(path, JSON.stringify({ toolflow: 1, name, ...g }, null, 2))
        return { saved: true }
      },
      /** A file from disk is as untrusted as the renderer: same validator. Returns the graph for the canvas; nothing is saved or run. */
      async importWorkflow() {
        const path = await d.openPath()
        if (!path) return null
        try {
          if (statSync(path).size > 2_000_000) throw coded('WF_FILE_INVALID')
          const v = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown }
          return { name: typeof v?.name === 'string' ? v.name.slice(0, 60) : '', ...forCanvas(parseGraph(v)) }
        } catch { throw coded('WF_FILE_INVALID') } // unreadable, not JSON, or not a workflow: one code, no path in the message
      },
      /** Starts the run and returns at once; the canvas polls workflowRun. A graph that cannot run returns its errors and sends nothing. dryRun: only the plan (what each node would send). */
      async runWorkflow(a: unknown) {
        const o = a as { graph?: unknown; mode?: unknown; dryRun?: unknown } | null
        const mode = o?.mode === 'auto' || o?.mode === 'manual' ? o.mode : bad()
        const g = parseGraph(o!.graph), { steps, errors } = plan(g)
        for (const s of steps) if (s.images.some((id) => !assetOf.get(id))) errors.push({ node: s.node, code: 'REF_ASSET_MISSING' })
        if (o!.dryRun === true) return { steps, errors }
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
