// Node workflows (TobyFlow-style canvas): Text / Ảnh → Tạo ảnh Flow → Tự tải về. A run is compiled onto the existing batch
// path: every "generate" node becomes one batch through the same enqueue the Tạo lô screen uses, so each send keeps every
// guarantee of a batch (intent first, never sent twice, refs checked). Nothing here talks to Flow directly.
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Db } from './db'
import { safeComponent } from './downloads'
import { comboQualified, type Combo } from './profile'
import { GEM_ASPECTS, GEM_MODELS, type Site } from './gpt-driver'

type Cond = 'all' | 'any' | 'filtered' // what a Điều kiện node asks about the generate node wired into it: every prompt has a saved result / at least one has / Flow blocked a prompt
/** combo: a Tạo ảnh node's own model / aspect / thinking level / count (absent = the app's default). cond: a Điều kiện node's question (absent = 'all'). */
export type WfNode = { id: string; type: 'text' | 'image' | 'generate' | 'download' | 'note' | 'branch' | 'loop' | 'csv' | 'frame' | 'merge'; x: number; y: number; text?: string; assetIds?: string[]; combo?: Combo; cond?: Cond; site?: Site; aspect?: string; model?: string; rounds?: number; rows?: string[][] } // site: a Tạo ảnh node that goes to ChatGPT / Gemini instead of Flow (aspect, model: Gemini's menus); rounds: a Vòng lặp node's; rows: a Bảng CSV node's table (header first), its text being the {Cột} template, or the filled prompts when the canvas runs it
type Port = 'ok' | 'fail' // the two outputs of a Điều kiện node: its question is answered yes / no
export type Graph = { nodes: WfNode[]; edges: { from: string; to: string; port?: Port }[]; vars?: Record<string, string> } // vars: the canvas's reusable {biến}; main only stores them (the renderer fills them in before a run)
type Dep = { node: string; port: 'direct' | Port; cond?: Cond } // cond: only through a Điều kiện node that asks something other than 'all'
/** One generate node, ready to run: prompts = one per non-empty line; deps = the generate nodes it waits for (see carries() for which hand their results on as refs). */
export type Step = { node: string; kind: 'image' | 'video'; prompts: string; images: string[]; deps: Dep[]; save: boolean; feeds: boolean; combo?: Combo; site?: Site; aspect?: string; model?: string; round?: number } // kind: the node's settings decide (video settings = a video node); round: a repeat of a Vòng lặp (node `<loop>#<round>`), prompt i refined from result i of the round before
/** assets: per prompt, its first saved result as a reference asset (null = none saved); blocked: Flow refused a prompt of this node for its content. Both only for a node something waits for. */
export type NodeRun = { state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'bypassed' | 'stopped'; code?: string; batchIds: string[]; assets?: (string | null)[]; blocked?: boolean; file?: string } // file: a Ghép video node's saved video
/** A Ghép video node: the video steps wired into it, in wire order (their clips are joined in that order, each step's prompts in order). */
export type Merge = { node: string; inputs: string[] }
export type Run = { id: string; status: 'running' | 'done' | 'failed' | 'stopped'; stop: boolean; nodes: Record<string, NodeRun>; loops: Record<string, string[]> } // loops: a Vòng lặp node's steps, round 1 first

const TYPES = ['text', 'image', 'generate', 'download', 'note', 'branch', 'loop', 'csv', 'frame', 'merge']
const CONDS = ['all', 'any', 'filtered']
const WIRES: Record<string, string[]> = { text: ['generate'], csv: ['generate'], image: ['generate'], generate: ['generate', 'download', 'branch', 'loop', 'frame', 'merge'], branch: ['generate'], loop: ['generate', 'download', 'branch'], frame: ['generate'] } // source type → allowed target types (Khung cuối: a video's last frames; Ghép video: an end)
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
    if ((n.type === 'loop') !== (Number.isInteger(n.rounds) && (n.rounds as number) >= 2 && (n.rounds as number) <= 10)) bad() // a loop node always says how many rounds, nothing else does
    if (n.rows !== undefined && (n.type !== 'csv' || !Array.isArray(n.rows) || n.rows.length > 2001 || !n.rows.every((r) => Array.isArray(r) && r.length <= 50 && r.every((c) => typeof c === 'string')) || n.rows.flat().join('').length > 1_000_000)) bad() // header + 2000 rows (a batch's prompt cap), the size cap of a text
    return { id: n.id as string, type: n.type as WfNode['type'], x: n.x as number, y: n.y as number, ...(n.text !== undefined ? { text: n.text as string } : {}), ...(n.assetIds ? { assetIds: n.assetIds as string[] } : {}),
      ...(n.combo !== undefined ? { combo: comboOf(n.combo) } : {}), ...(n.cond !== undefined ? { cond: n.cond as Cond } : {}), ...(n.site !== undefined ? { site: n.site as Site } : {}), ...(n.aspect !== undefined ? { aspect: n.aspect as string } : {}), ...(n.model !== undefined ? { model: n.model as string } : {}),
      ...(n.rounds !== undefined ? { rounds: n.rounds as number } : {}), ...(n.rows !== undefined ? { rows: n.rows as string[][] } : {}) }
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
export function plan(g: Graph): { steps: Step[]; merges: Merge[]; errors: { node?: string; code: string }[] } {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const into = (id: string, ...types: string[]): WfNode[] => g.edges.filter((e) => e.to === id).map((e) => byId.get(e.from)!).filter((n) => types.includes(n.type))
  const gens = g.nodes.filter((n) => n.type === 'generate').sort((a, b) => a.x - b.x || a.y - b.y)
  if (!gens.length) return { steps: [], merges: [], errors: [{ code: 'WF_NO_GENERATE' }] }
  const errors: { node?: string; code: string }[] = []
  // a Vòng lặp repeats the one generate node wired into it (unrolled below into steps `<loop>#2`…); what comes out of it is its last round
  const loopOf = new Map<string, WfNode>()
  for (const l of g.nodes.filter((n) => n.type === 'loop')) {
    const ins = into(l.id, 'generate')
    if (ins.length !== 1) errors.push({ node: l.id, code: 'WF_LOOP_INPUT' })
    else if (ins[0].combo?.kind === 'video') errors.push({ node: l.id, code: 'WF_LOOP_VIDEO' }) // a video is not a reference image
    else loopOf.set(l.id, ins[0])
  }
  const outOf = (n: WfNode): string | undefined => (n.type === 'generate' ? n.id : loopOf.has(n.id) ? `${n.id}#${n.rounds}` : undefined) // undefined: a loop that cannot run (already an error)
  const genOf = (step: string): string => (step.includes('#') ? loopOf.get(step.split('#')[0])!.id : step)
  // what a generate node waits for: generate nodes wired straight in, or through a Điều kiện node (which looks at the one generate node wired into it)
  const depsOf = new Map(gens.map((n) => [n.id, g.edges.filter((e) => e.to === n.id).flatMap((e): Dep[] => {
    const src = byId.get(e.from)!, up = outOf(src)
    if (src.type === 'generate' || src.type === 'loop') return up ? [{ node: up, port: 'direct' }] : []
    if (src.type === 'frame') { const ins = into(src.id, 'generate'); return ins.length === 1 && ins[0].combo?.kind === 'video' ? [{ node: ins[0].id, port: 'direct' }] : [] } // a wrong input is reported below
    if (src.type !== 'branch') return []
    const ins = into(src.id, 'generate', 'loop'), from = ins.length === 1 ? outOf(ins[0]) : undefined
    if (ins.length !== 1) { if (!errors.some((x) => x.node === src.id)) errors.push({ node: src.id, code: 'WF_BRANCH_INPUT' }); return [] }
    return from ? [{ node: from, port: e.port!, ...(src.cond && src.cond !== 'all' ? { cond: src.cond } : {}) }] : []
  })]))
  const order: WfNode[] = [], left = new Set(gens.map((n) => n.id))
  for (let moved = true; moved;) { // Kahn: take every node whose upstream is done; what never gets taken sits on a loop
    moved = false
    for (const n of gens) if (left.has(n.id) && depsOf.get(n.id)!.every((u) => !left.has(genOf(u.node)))) { left.delete(n.id); order.push(n); moved = true }
  }
  if (left.size) return { steps: [], merges: [], errors: [...left].map((node) => ({ node, code: 'WF_CYCLE' })) }
  const count = new Map<string, number>()
  const steps = order.flatMap((n): Step[] => {
    const prompts = into(n.id, 'text', 'csv').map((t) => t.text ?? '').join('\n')
    const images = [...new Set(into(n.id, 'image').flatMap((i) => i.assetIds ?? []))]
    const deps = depsOf.get(n.id)!, kind = n.combo?.kind ?? 'image'
    const refs = images.length + deps.reduce((s, u) => s + (carries(u) ? count.get(u.node) ?? 0 : 0), 0) // one result image per upstream prompt
    count.set(n.id, lines(prompts))
    if (!lines(prompts)) errors.push({ node: n.id, code: 'WF_NO_PROMPT' })
    else if (kind === 'video' ? refs > 1 && refs !== lines(prompts) : refs > MAX_REFS) errors.push({ node: n.id, code: kind === 'video' ? 'WF_VIDEO_FRAMES' : 'TOO_MANY_REFS' }) // a video starts from one image: the same for all prompts, or one each
    if (n.combo && !comboQualified(kind, n.combo)) errors.push({ node: n.id, code: 'COMBO_NOT_QUALIFIED' }) // AC-03: no other combo is used instead
    const outs = g.edges.filter((e) => e.from === n.id).map((e) => byId.get(e.to)!.type)
    if (kind === 'video' && outs.some((t) => t !== 'download' && t !== 'loop' && t !== 'frame' && t !== 'merge')) errors.push({ node: n.id, code: 'WF_VIDEO_OUTPUT' }) // a video is not a reference image, and a Điều kiện node reads images (a Vòng lặp says so itself)
    const step: Step = { node: n.id, kind, prompts, images, deps, save: outs.includes('download') || outs.includes('merge'), feeds: outs.includes('generate') || outs.includes('branch') || outs.includes('loop') || outs.includes('frame'), ...(n.combo ? { combo: n.combo } : {}), ...(n.site ? { site: n.site } : {}), ...(n.aspect ? { aspect: n.aspect } : {}), ...(n.model ? { model: n.model } : {}) }
    return [step, ...[...loopOf].filter(([, gen]) => gen === n).flatMap(([l]) => { // its rounds follow it at once: whatever waits for a round waits for this node
      const loop = byId.get(l)!, louts = g.edges.filter((e) => e.from === l).map((e) => byId.get(e.to)!.type)
      return Array.from({ length: loop.rounds! - 1 }, (_, k): Step => {
        const r = k + 2, last = r === loop.rounds
        count.set(`${l}#${r}`, lines(prompts))
        return { ...step, node: `${l}#${r}`, images: [], deps: [{ node: r === 2 ? n.id : `${l}#${r - 1}`, port: 'direct' }], save: last && louts.includes('download'), feeds: !last || louts.includes('generate') || louts.includes('branch'), round: r }
      })
    })]
  })
  for (const f of g.nodes.filter((n) => n.type === 'frame')) { const ins = into(f.id, 'generate'); if (ins.length !== 1 || ins[0].combo?.kind !== 'video') errors.push({ node: f.id, code: 'WF_FRAME_INPUT' }) }
  const merges = g.nodes.filter((n) => n.type === 'merge').flatMap((m): Merge[] => {
    const ins = into(m.id, 'generate')
    if (!ins.length || ins.some((n) => n.combo?.kind !== 'video')) { errors.push({ node: m.id, code: 'WF_MERGE_INPUT' }); return [] }
    return [{ node: m.id, inputs: ins.map((n) => n.id) }]
  })
  return { steps, merges, errors }
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
  lastFrame(video: string): Promise<string> // the clip's last frame as an image file (ffmpeg)
  merge(files: string[], name: string): Promise<string> // the clips joined into one video file named name, next to the first; returns its path
  reveal?(path: string): void // shows a file in the OS file manager
  savePath(suggested: string): Promise<string | null>; openPath(): Promise<string | null> // the OS file dialogs (null = cancelled)
}

export function createWorkflows(d: WfDeps) {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const runs = new Map<string, Run>()
  const code = (e: unknown): string => (e as { code?: string })?.code ?? 'INTERNAL_ERROR'

  // shortcut: nodes run one after another and a run lives in memory (after an app restart its batches go on, later nodes do not start); run branches in parallel / persist the run when users build wide graphs
  async function exec(run: Run, steps: Step[], merges: Merge[], mode: 'auto' | 'manual'): Promise<void> {
    for (const s of steps) {
      const n = run.nodes[s.node]
      if (run.stop) { n.state = 'stopped'; continue }
      const takes = s.deps.map((dp) => take(dp, run.nodes[dp.node]))
      if (takes.includes('skipped')) { n.state = 'skipped'; n.code = 'WF_UPSTREAM_INCOMPLETE'; continue }
      if (takes.includes('bypassed')) { n.state = 'bypassed'; continue } // the other side of a Điều kiện: not an error
      try {
        n.state = 'running'
        const refs = [...s.images, ...s.deps.flatMap((dp) => (carries(dp) ? (run.nodes[dp.node].assets ?? []).filter((a): a is string => !!a) : []))]
        const each = refs.length > 1 && (s.kind === 'video' || !!s.round) // a video's start frames, a loop round's previous results: prompt i gets image i
        const r = await d.enqueue({ commandId: `wf:${run.id}:${s.node}`, kind: s.kind, mode: s.site ? 'auto' : mode, text: s.prompts, refs: { assetIds: refs, mode: each ? 'sequential' : refs.length ? 'all' : 'none', perItem: each ? 1 : MAX_REFS }, ...(s.combo ? { combo: s.combo } : {}), ...(s.site ? { provider: s.site, ...(s.aspect ? { aspect: s.aspect } : {}), ...(s.model ? { model: s.model } : {}) } : {}) }) // a site's batch is always sent by the app
        if (r.errors?.length) { n.state = 'failed'; n.code = r.errors[0].code; continue }
        n.batchIds = r.batchIds ?? [r.batchId!]
        for (const b of n.batchIds) await d.start(b)
        while (!run.stop && n.batchIds.some((b) => ACTIVE.includes(d.status(b)))) await sleep(500) // paused / needs_review wait for the user in Hàng đợi
        if (run.stop) { for (const b of n.batchIds) await d.stop(b); n.state = 'stopped'; continue }
        if (s.feeds) n.blocked = n.batchIds.some((b) => d.codes(b).includes('CONTENT_BLOCKED')) // what Flow answered: known before, and whatever becomes of, the saving below
        if (s.save || s.feeds) for (const b of n.batchIds) await d.download(b)
        // a save can fail once right after the result appears (seen live: a fresh Flow video, saved by auto save 2 s later), and what follows needs the file
        for (let k = 0; k < 3 && (s.save || s.feeds) && !run.stop && n.batchIds.some((b) => d.outputs(b).some((f) => !f)); k++) { await sleep(5000); for (const b of n.batchIds) await d.download(b) }
        if (s.feeds) { const fs = n.batchIds.flatMap((b) => d.outputs(b)), out: (string | null)[] = []; for (const f of fs) out.push(f ? d.register(s.kind === 'video' ? await d.lastFrame(f) : f) : null); n.assets = out } // a video hands on its last frames (it feeds only through Khung cuối)
        const notOk = n.batchIds.map((b) => d.status(b)).find((st) => st !== 'completed')
        n.state = notOk ? 'failed' : 'done'
        if (notOk) n.code = `WF_BATCH_${notOk.toUpperCase()}`
      } catch (e) { n.state = 'failed'; n.code = code(e) }
    }
    for (const m of merges) { // after every scene: a merge is an end, nothing waits for it
      const n = run.nodes[m.node], ups = m.inputs.map((i) => run.nodes[i])
      if (run.stop) { n.state = 'stopped'; continue }
      const files = ups.every((u) => u.state === 'done') ? m.inputs.flatMap((i) => run.nodes[i].batchIds.flatMap((b) => d.outputs(b))) : []
      if (!files.length || files.some((f) => !f)) { n.state = 'skipped'; n.code = 'WF_UPSTREAM_INCOMPLETE'; continue } // never a video with a scene missing
      try { n.state = 'running'; n.file = await d.merge(files as string[], `ghep-video-${run.id.slice(0, 8)}.mp4`); n.state = 'done' } catch (e) { n.state = 'failed'; n.code = code(e) }
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
        const g = parseGraph(o!.graph), { steps, merges, errors } = plan(g)
        for (const s of steps) if (s.images.some((id) => !assetOf.get(id))) errors.push({ node: s.node, code: 'REF_ASSET_MISSING' })
        if (o!.dryRun === true) return { steps, merges, errors }
        if (errors.length) return { errors }
        const loops: Record<string, string[]> = {}
        for (const s of steps) if (s.round) (loops[s.node.split('#')[0]] ??= [s.deps[0].node]).push(s.node)
        const run: Run = { id: randomUUID(), status: 'running', stop: false, nodes: Object.fromEntries([...steps, ...merges].map((s) => [s.node, { state: 'waiting', batchIds: [] }])), loops }
        for (const [id, r] of runs) if (r.status !== 'running' && runs.size >= 20) runs.delete(id) // finished runs are only kept for the canvas that started them
        runs.set(run.id, run)
        void exec(run, steps, merges, mode).catch((e) => { run.status = 'failed'; console.error('workflow', code(e)) })
        return { runId: run.id }
      },
      async stopWorkflow(a: unknown) { // no new node starts; the node that is running has its batches stopped like the Dừng button
        const run = runs.get(a as string)
        if (!run || run.status !== 'running') return
        run.stop = true
        for (const n of Object.values(run.nodes)) if (n.state === 'running') for (const b of n.batchIds) await d.stop(b)
      },
      async revealWorkflowFile(a: unknown) { // a Ghép video node's file, shown in Explorer: the canvas knows only its name
        const o = a as { runId?: unknown; node?: unknown } | null, f = typeof o?.runId === 'string' && typeof o.node === 'string' ? runs.get(o.runId)?.nodes[o.node]?.file : undefined
        if (!f) throw coded('WF_FILE_GONE')
        d.reveal?.(f)
      },
      async workflowRun(a: unknown) { // per node: state, progress, and one saved result to show (ids only)
        const run = runs.get(a as string)
        if (!run) return null
        const items = d.db.prepare('select a.id aid, a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=?')
        const saved = d.db.prepare("select attempt_id attemptId, media_id mediaId from download where attempt_id=? and state='completed' limit 1")
        const nodes: Record<string, { state: string; code: string | null; total: number; done: number; thumb: unknown; round?: number; rounds?: number; file?: string }> = Object.fromEntries(Object.entries(run.nodes).map(([id, n]) => {
          const its = n.batchIds.flatMap((b) => items.all(b) as { aid: string; j: string }[])
          return [id, { state: n.state, code: n.code ?? null, total: its.length, done: its.filter((x) => JSON.parse(x.j).item === 'ready').length, thumb: its.map((x) => saved.get(x.aid)).find(Boolean) ?? null, ...(n.file ? { file: basename(n.file) } : {}) }] // the name only, never the path
        }))
        for (const [l, ids] of Object.entries(run.loops)) { // a Vòng lặp shows its first round not done yet (all done: the last)
          const k = ids.findIndex((x) => run.nodes[x].state !== 'done')
          nodes[l] = { ...nodes[ids[k < 0 ? ids.length - 1 : k]], round: (k < 0 ? ids.length - 1 : k) + 1, rounds: ids.length }
        }
        return { status: run.status, nodes }
      },
    },
  }
}
