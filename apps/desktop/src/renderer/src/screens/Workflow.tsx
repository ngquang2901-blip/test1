// Node canvas (TobyFlow-style): Text / Ảnh → Tạo ảnh Flow → Tự tải về, with a Điều kiện branch and reusable {biến}. The graph is
// only a way to describe batches; main compiles it (src/main/workflow.ts) and runs every "Tạo ảnh Flow" node as a normal batch.
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, addEdge, useEdgesState, useNodesState, type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { hintOf } from '../hints'
import { MAX_PROMPTS, fillLines, varsOf, type ExpandError } from '../template'
import type { PresetAsset, Session } from '../types'
import { Chip, Icon, type Tone } from '../ui'
import { Thumb } from './Results'
import { ComboFields, Opt, comboLabel, defaultCombo, type Combo } from '../combo'
import { TEMPLATES } from '../wf-templates'

type Kind = 'text' | 'image' | 'generate' | 'download' | 'note' | 'branch'
type Cond = 'all' | 'any' | 'filtered' // what a Điều kiện node asks (absent = 'all')
type Data = { text?: string; assets?: PresetAsset[]; combo?: Combo; cond?: Cond }
type WNode = Node<Data, Kind>
type Var = { name: string; value: string }
type NodeRun = { state: string; code: string | null; total: number; done: number; thumb: { attemptId: string; mediaId: string } | null }
type RunView = { status: 'running' | 'done' | 'failed' | 'stopped'; nodes: Record<string, NodeRun> }
type Canvas = { name?: string; nodes: { id: string; type: Kind; x: number; y: number; text?: string; assets?: PresetAsset[]; combo?: Combo; cond?: Cond }[]; edges: { from: string; to: string; port?: string }[]; vars?: Record<string, string> }
type Saved = Canvas & { id: string; name: string }
type Plan = { steps: { node: string; kind: 'image' | 'video'; prompts: string; images: string[]; deps: { node: string; port: string; cond?: Cond }[]; save: boolean; feeds: boolean; combo?: Combo }[]; errors: { node?: string; code: string }[] }

const KINDS: Kind[] = ['text', 'image', 'generate', 'branch', 'download', 'note']
const TITLE: Record<Kind, string> = { text: 'Text', image: 'Ảnh tham chiếu', generate: 'Tạo ảnh Flow', download: 'Tự tải về', note: 'Ghi chú', branch: 'Điều kiện' }
const ICON = { text: 'list', image: 'image', generate: 'layers', download: 'download', note: 'sliders', branch: 'branch' } as const
const WIRES: Record<string, Kind[]> = { text: ['generate'], image: ['generate'], generate: ['generate', 'download', 'branch'], branch: ['generate'] } // main checks the same table again
const STATE: Record<string, [Tone, string]> = { waiting: ['idle', 'Chờ lượt'], running: ['run', 'Đang chạy'], done: ['done', 'Xong'], failed: ['attn', 'Lỗi'], skipped: ['attn', 'Bỏ qua'], bypassed: ['idle', 'Không chạy'], stopped: ['idle', 'Đã dừng'] }
const WHY: Record<string, string> = {
  WF_NO_GENERATE: 'Chưa có node Tạo ảnh Flow nào. Thêm một node rồi nối Text vào nó',
  WF_NO_PROMPT: 'Node này chưa có prompt. Nối một node Text có chữ vào chấm bên trái',
  WF_CYCLE: 'Các node Tạo ảnh đang nối thành vòng tròn. Bỏ bớt một dây nối',
  WF_BRANCH_INPUT: 'Node Điều kiện cần đúng một node Tạo ảnh nối vào chấm bên trái',
  WF_VIDEO_FRAMES: 'Node video cần 1 ảnh dùng chung, hoặc số ảnh đúng bằng số prompt (mỗi prompt một ảnh làm khung hình đầu). Sửa số prompt hoặc số ảnh nối vào',
  WF_VIDEO_OUTPUT: 'Kết quả video chỉ nối được sang node Tự tải về. Bỏ dây nối sang node Tạo ảnh hoặc Điều kiện',
  WF_FILE_INVALID: 'File này không phải workflow của ToolFlow hoặc đã hỏng',
  TOO_MANY_REFS: 'Quá 8 ảnh tham chiếu cho một prompt. Bớt ảnh hoặc bớt prompt ở node phía trước',
  REF_ASSET_MISSING: 'Có ảnh tham chiếu không còn trên máy. Chọn lại ảnh ở node Ảnh tham chiếu',
  WF_UPSTREAM_INCOMPLETE: 'Node phía trước chưa có đủ ảnh đã lưu nên node này không gửi gì. Xem Hàng đợi, sửa xong thì chạy lại',
  WF_BATCH_FAILED: 'Lô của node này bị lỗi. Xem lý do ở Hàng đợi',
  WF_BATCH_PARTIAL_FAILED: 'Một phần prompt của node này bị lỗi. Xem lý do ở Hàng đợi',
  WF_BATCH_STOPPED: 'Lô của node này đã bị dừng',
  NO_PROJECT_TAB: 'Chưa có tab Flow nào được cấp quyền. Vào màn Kết nối rồi bấm Dùng tab này',
  COMBO_NOT_QUALIFIED: 'Cài đặt tạo ảnh của node này không nằm trong danh sách app đã kiểm thử nên không gửi. Chọn lại mô hình, tỉ lệ, số ảnh ở bảng bên phải',
}
const DEFAULT = defaultCombo('image')! // what a Tạo ảnh node without its own settings runs with
// ---- Điều kiện: the question, the names of its two sides, and what a node behind each side is told ----
const COND: Record<Cond, { name: string; yes: string; no: string; when: [string, string]; help: string }> = {
  all: { name: 'Đủ ảnh: mọi prompt đều có ảnh đã lưu', yes: 'Đủ ảnh đã lưu', no: 'Thiếu ảnh (lỗi hoặc bị lọc)', when: ['Chỉ chạy khi node phía trước có đủ ảnh.', 'Chỉ chạy khi node phía trước thiếu ảnh.'],
    help: 'Nối một node Tạo ảnh vào bên trái. Chấm “Đủ ảnh” chạy khi mọi prompt của node đó đều có ảnh đã lưu (ảnh được dùng làm tham chiếu). Chấm “Thiếu ảnh” chạy khi có prompt lỗi hoặc bị lọc, dùng cho prompt dự phòng.' },
  any: { name: 'Có ít nhất một ảnh đã lưu', yes: 'Có ít nhất một ảnh', no: 'Không có ảnh nào', when: ['Chỉ chạy khi node phía trước có ít nhất một ảnh.', 'Chỉ chạy khi node phía trước không có ảnh nào.'],
    help: 'Chấm “Có ít nhất một ảnh” chạy khi node phía trước lưu được từ một ảnh trở lên; những ảnh có được sẽ làm tham chiếu cho node sau. Chấm “Không có ảnh nào” chạy khi không lưu được ảnh nào, dùng cho prompt dự phòng.' },
  filtered: { name: 'Có prompt bị Flow lọc nội dung', yes: 'Có prompt bị Flow lọc', no: 'Không bị lọc', when: ['Chỉ chạy khi node phía trước có prompt bị Flow lọc.', 'Chỉ chạy khi node phía trước không bị lọc prompt nào.'],
    help: 'Chấm “Có prompt bị Flow lọc” chạy khi Flow từ chối ít nhất một prompt vì nội dung, dùng cho prompt viết lại nhẹ hơn. Chấm “Không bị lọc” chạy trong mọi trường hợp còn lại. Cả hai nhánh không mang ảnh sang node sau: muốn dùng ảnh làm tham chiếu thì nối thẳng node Tạo ảnh sang node đó.' },
}
const carries = (d: { port: string; cond?: Cond }): boolean => d.port === 'direct' || (d.port === 'ok' && d.cond !== 'filtered') // the wires that hand result images on (main applies the same rule)

const why = (code: string): string => WHY[code] ?? hintOf(code) ?? `Lỗi ${code}`
const varErr = (e: ExpandError): string =>
  e.code === 'EMPTY_VAR' ? `Biến {${e.name}} chưa có giá trị. Bấm vào nền trống rồi khai báo ở bảng Biến bên phải`
  : e.code === 'TOO_MANY' ? `${e.count} prompt là quá nhiều (tối đa ${MAX_PROMPTS}). Bớt giá trị của biến` : 'Biến chưa dùng được'
const FIT = { maxZoom: 1, padding: 0.2 } // room around the nodes: the zoom buttons and the minimap sit in the corners
const DRAG = 'application/x-toolflow-node' // a node type dragged from the toolbar onto the canvas
const ARIA = { 'controls.ariaLabel': 'Phóng to, thu nhỏ', 'controls.zoomIn.ariaLabel': 'Phóng to', 'controls.zoomOut.ariaLabel': 'Thu nhỏ', 'minimap.ariaLabel': 'Bản đồ thu nhỏ' }
const clean = (m: string): string => m.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
// where a new node lands: inputs stack on the left; a taken spot pushes the node down (a Tạo ảnh also right, so a chain reads left to right)
const place = (type: Kind, ns: WNode[]): { x: number; y: number } => {
  const p = { x: type === 'generate' ? 400 : type === 'download' || type === 'branch' ? 760 : 40, y: 40 }
  while (ns.some((n) => Math.abs(n.position.x - p.x) < 300 && Math.abs(n.position.y - p.y) < 240)) { p.y += 240; if (type === 'generate') p.x += 360 }
  return p
}

type Tools = { run: RunView | null; errs: Record<string, string>; patch(id: string, d: Data): void; pick(id: string): void; del(id: string): void }
const Ctx = createContext<Tools>({ run: null, errs: {}, patch() {}, pick() {}, del() {} })

function Box({ id, type, data }: NodeProps<WNode>): React.JSX.Element {
  const { run, errs, patch, pick, del } = useContext(Ctx)
  const r = run?.nodes[id], err = errs[id] ?? (r?.code ? why(r.code) : undefined)
  return (
    <div className="wf-node" data-testid={`wf-${type}`} data-state={err && !r ? 'failed' : r?.state}>
      {(type === 'generate' || type === 'download' || type === 'branch') && <Handle type="target" position={Position.Left} />}
      <header>
        <Icon name={ICON[type]} /><b>{TITLE[type]}</b><span className="spacer" />
        {r && <Chip tone={STATE[r.state]?.[0] ?? 'idle'}>{STATE[r.state]?.[1] ?? r.state}{r.total ? ` ${r.done}/${r.total}` : ''}</Chip>}
        <button className="x nodrag" aria-label={`Xoá node ${TITLE[type]}`} onClick={() => del(id)}>×</button>
      </header>
      {(type === 'text' || type === 'note') && (
        <textarea className="nodrag nowheel" rows={type === 'text' ? 5 : 3} aria-label={type === 'text' ? 'Prompt của node Text' : 'Nội dung ghi chú'} placeholder={type === 'text' ? 'Mỗi dòng là một prompt. Dùng {tên biến} cho phần lặp lại' : 'Ghi chú cho mình, app không gửi đi'}
          value={data.text ?? ''} onChange={(e) => patch(id, { text: e.target.value })} />
      )}
      {type === 'image' && (
        <>
          {(data.assets ?? []).map((a) => <div key={a.id} className="wf-file">{a.missing ? 'Không còn file này' : a.name}</div>)}
          <button className="small nodrag" onClick={() => pick(id)}>{data.assets?.length ? 'Chọn lại ảnh' : 'Chọn ảnh'}</button>
        </>
      )}
      {type === 'generate' && <p className="wf-combo" data-testid="wf-combo">{data.combo?.kind === 'video' ? 'Video · ' : ''}{comboLabel(data.combo ?? DEFAULT)}</p>}
      {type === 'generate' && (r?.thumb ? <Thumb attemptId={r.thumb.attemptId} media={r.thumb.mediaId} saved /> : <p className="hint">Mỗi prompt nối vào tạo một lượt ảnh. Nối chấm bên phải sang node Tạo ảnh khác để dùng ảnh vừa tạo làm ảnh tham chiếu.</p>)}
      {type === 'download' && <p className="hint">Lưu kết quả của node nối vào đây về thư mục Downloads/ToolFlow.</p>}
      {type === 'branch' && (
        <>
          <p className="hint">Xét node Tạo ảnh nối vào bên trái, rồi chạy tiếp một trong hai nhánh:</p>
          <div className="wf-port">{COND[data.cond ?? 'all'].yes}<Handle id="ok" type="source" position={Position.Right} /></div>
          <div className="wf-port">{COND[data.cond ?? 'all'].no}<Handle id="fail" type="source" position={Position.Right} /></div>
        </>
      )}
      {err && <p className="wf-err" role="alert">{err}</p>}
      {(type === 'text' || type === 'image' || type === 'generate') && <Handle type="source" position={Position.Right} />}
    </div>
  )
}
const NODE_TYPES = { text: Box, image: Box, generate: Box, download: Box, note: Box, branch: Box }

// the canvas survives a visit to another screen: mid-run the user goes to Hàng đợi (or to Flow to click Gửi) and comes back
let keep: { nodes: WNode[]; edges: Edge[]; vars: Var[]; name: string; runId: string | null; hist?: { past: string[]; future: string[]; cur: string } } = { nodes: [], edges: [], vars: [], name: '', runId: null }

export default function Workflow({ s }: { s: Session }): React.JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<WNode>(keep.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(keep.edges)
  const [vars, setVars] = useState<Var[]>(keep.vars)
  const [name, setName] = useState(keep.name)
  const [runId, setRunId] = useState(keep.runId)
  const [run, setRun] = useState<RunView | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Saved[]>([])
  const [mode, setMode] = useState<'auto' | 'manual'>(s.autoEnabled ? 'auto' : 'manual')
  const [msg, setMsg] = useState('')
  const [preview, setPreview] = useState<Plan | null>(null)
  const rf = useRef<ReactFlowInstance<WNode, Edge> | null>(null)
  useEffect(() => { keep = { nodes, edges, vars, name, runId, hist: hist.current } })
  const list = (): Promise<void> => window.api.listWorkflows().then(setSaved)
  useEffect(() => { void list() }, [])
  useEffect(() => {
    if (!runId) return
    let t: ReturnType<typeof setInterval> | undefined, live = true
    const tick = (): void => void window.api.workflowRun(runId).then((r: RunView | null) => {
      if (!live) return
      setRun(r)
      if (!r || r.status !== 'running') clearInterval(t) // a finished run no longer changes (null: the app was restarted)
    })
    tick()
    t = setInterval(tick, 1000)
    return () => { live = false; clearInterval(t) }
  }, [runId])

  // ---- undo / redo: one snapshot of what the user built (not selection or sizes) each time it settles ----
  const snap = JSON.stringify({ nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })), edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, sourceHandle })), vars })
  const hist = useRef(keep.hist ?? { past: [] as string[], future: [] as string[], cur: snap }) // the steps come back with the canvas
  const [, bump] = useState(0)
  const commit = (): void => {
    const h = hist.current
    if (snap === h.cur) return
    h.past.push(h.cur)
    if (h.past.length > 100) h.past.shift()
    h.cur = snap; h.future = []
    bump((n) => n + 1)
  }
  useEffect(() => { const t = setTimeout(commit, 300); return () => clearTimeout(t) }, [snap])
  const travel = (back: boolean): void => {
    commit() // an edit made a moment ago is its own step
    const h = hist.current, to = (back ? h.past : h.future).pop()
    if (!to) return
    ;(back ? h.future : h.past).push(h.cur)
    h.cur = to
    const v = JSON.parse(to) as { nodes: WNode[]; edges: Edge[]; vars: Var[] }
    setNodes(v.nodes); setEdges(v.edges); setVars(v.vars)
    bump((n) => n + 1)
  }
  const travelNow = useRef(travel)
  travelNow.current = travel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || /^(TEXTAREA|INPUT|SELECT)$/.test((e.target as HTMLElement).tagName)) return // text boxes keep their own undo
      const k = e.key.toLowerCase()
      if (k === 'z' || k === 'y') { e.preventDefault(); travelNow.current(k === 'z' && !e.shiftKey) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const call = (f: () => Promise<unknown>): void => { setMsg(''); void f().catch((e: Error) => setMsg(why(clean(e.message)))) }
  const typeOf = (id: string | null): string => nodes.find((n) => n.id === id)?.type ?? ''
  const table = Object.fromEntries(vars.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value]))
  /** What is saved, exported and undone: texts as written, with their {biến}. */
  const raw = (): { nodes: { id: string; type: Kind; x: number; y: number; text?: string; assetIds?: string[]; combo?: Combo; cond?: Cond }[]; edges: object[]; vars: Record<string, string> } => ({
    nodes: nodes.map((n) => ({ id: n.id, type: n.type!, x: n.position.x, y: n.position.y, ...(n.data.text !== undefined ? { text: n.data.text } : {}), ...(n.data.assets ? { assetIds: n.data.assets.map((a) => a.id) } : {}),
      ...(n.type === 'generate' && n.data.combo ? { combo: n.data.combo } : {}), ...(n.type === 'branch' && n.data.cond ? { cond: n.data.cond } : {}) })),
    edges: edges.map((e) => ({ from: e.source, to: e.target, ...(e.sourceHandle ? { port: e.sourceHandle } : {}) })),
    vars: table,
  })
  /** What runs: every Text node with its variables filled in (one prompt per line); a variable without a value is an error on that node. */
  const filled = (): { graph: object; errs: Record<string, string> } => {
    const g = raw(), bad: Record<string, string> = {}
    const out = g.nodes.map((n) => {
      if (n.type !== 'text') return n
      const r = fillLines(n.text ?? '', table)
      if ('error' in r) { bad[n.id] = varErr(r.error); return n }
      return { ...n, text: r.prompts.join('\n') }
    })
    return { graph: { nodes: out, edges: g.edges }, errs: bad }
  }
  const reset = (): void => { setRunId(null); setRun(null); setErrs({}); setMsg('') }
  const open = (w: Canvas | undefined): void => {
    reset()
    setName(w?.name ?? '')
    setVars(Object.entries(w?.vars ?? {}).map(([n, value]) => ({ name: n, value })))
    setNodes((w?.nodes ?? []).map((n) => ({ id: n.id, type: n.type, position: { x: n.x, y: n.y }, data: { ...(n.text !== undefined ? { text: n.text } : {}), ...(n.assets ? { assets: n.assets } : {}), ...(n.combo ? { combo: n.combo } : {}), ...(n.cond ? { cond: n.cond } : {}) } })))
    setEdges((w?.edges ?? []).map((e) => ({ id: `${e.from}>${e.to}`, source: e.from, target: e.to, ...(e.port ? { sourceHandle: e.port } : {}) })))
    setTimeout(() => void rf.current?.fitView(FIT), 50)
  }
  const add = (type: Kind, data: Data = {}, at?: { x: number; y: number }): string => { // at: where the user dropped it
    const id = crypto.randomUUID()
    setNodes((ns) => [...ns, { id, type, position: at ?? place(type, ns), data }])
    if (!at) setTimeout(() => void rf.current?.fitView(FIT), 50) // a new node must be on screen
    return id
  }
  const blank = (k: Kind): Data => (k === 'text' || k === 'note' ? { text: '' } : {})
  const starter = (): void => { // the chain most people start from, already wired
    const t = add('text', { text: '' }), g = add('generate'), d = add('download')
    setEdges([{ id: `${t}>${g}`, source: t, target: g }, { id: `${g}>${d}`, source: g, target: d }])
  }
  const tools: Tools = {
    run, errs,
    patch: (id, d) => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...d } } : n))),
    del: (id) => void rf.current?.deleteElements({ nodes: [{ id }] }),
    pick: (id) => call(async () => {
      const p = await window.api.pickRefs() as { assets: PresetAsset[]; errors: unknown[] }
      if (p.assets.length) tools.patch(id, { assets: p.assets.slice(0, 8) })
      setMsg(p.errors.length ? `${p.errors.length} file không dùng được (chỉ nhận PNG, JPG, WEBP dưới 20 MB)` : p.assets.length > 8 ? 'Chỉ lấy 8 ảnh đầu' : '')
    }),
  }
  const start = (): void => call(async () => {
    const f = filled()
    setErrs(f.errs)
    if (Object.keys(f.errs).length) return setMsg('Chưa chạy được: xem dòng đỏ trên node')
    const r = await window.api.runWorkflow({ graph: f.graph, mode }) as { runId?: string; errors?: { node?: string; code: string }[] }
    if (r.errors) {
      setErrs(Object.fromEntries(r.errors.filter((e) => e.node).map((e) => [e.node!, why(e.code)])))
      setMsg(r.errors.some((e) => !e.node) ? why(r.errors.find((e) => !e.node)!.code) : 'Chưa chạy được: xem dòng đỏ trên node')
    } else { setRun(null); setRunId(r.runId!) }
  })
  const picked = nodes.filter((n) => n.selected)
  const sel = picked.length === 1 ? picked[0] : undefined
  const wires = picked.length ? [] : edges.filter((e) => e.selected) // a clicked wire turns blue; the side panel then offers to remove it
  const side1 = (id: string, port?: string | null): string => `${TITLE[typeOf(id) as Kind] ?? '?'}${port ? ` (nhánh “${COND[nodes.find((n) => n.id === id)?.data.cond ?? 'all'][port === 'ok' ? 'yes' : 'no']}”)` : ''}`
  useEffect(() => { // the side panel of a Tạo ảnh node shows what main would really send (same plan as a run, nothing sent)
    if (sel?.type !== 'generate') return
    let live = true
    const t = setTimeout(() => void window.api.runWorkflow({ graph: filled().graph, mode, dryRun: true }).then((p: Plan) => { if (live) setPreview(p) }, () => { if (live) setPreview(null) }), 250)
    return () => { live = false; clearTimeout(t) }
  }, [sel?.id, sel?.type, snap, mode])
  const running = run?.status === 'running' || (!!runId && !run)
  const id = saved.find((w) => w.name === name.trim())?.id
  const h = hist.current
  const missing = [...new Set(nodes.flatMap((n) => (n.type === 'text' ? varsOf(n.data.text ?? '') : [])))].filter((n) => !(n in table))
  const setVar = (i: number, p: Partial<Var>): void => setVars((vs) => vs.map((v, j) => (j === i ? { ...v, ...p } : v)))

  const side = (): React.JSX.Element => {
    if (!sel && wires.length) return (
      <>
        <h3>Dây nối đã chọn</h3>
        {wires.map((e) => <p key={e.id} className="hint" data-testid="wf-wire">{side1(e.source, e.sourceHandle)} → {side1(e.target)}</p>)}
        <button className="small" onClick={() => void rf.current?.deleteElements({ edges: wires.map(({ id }) => ({ id })) })}>{wires.length > 1 ? `Xoá ${wires.length} dây này` : 'Xoá dây này'}</button>
        <p className="hint">Hoặc nhấn phím Delete (Backspace cũng được). Xoá nhầm thì bấm Hoàn tác.</p>
      </>
    )
    if (!sel) return (
      <>
        <h3>Biến dùng lại</h3>
        <p className="hint">Viết <code>{'{tên biến}'}</code> trong node Text. Sửa giá trị ở đây thì mọi node dùng biến đó đổi theo. Nhiều dòng giá trị thì prompt được nhân ra, mỗi dòng một bản.</p>
        {vars.map((v, i) => (
          <div key={i} className="wf-var">
            <input aria-label="Tên biến" maxLength={40} placeholder="tên biến" value={v.name} onChange={(e) => setVar(i, { name: e.target.value.replace(/[{}]/g, '') })} />
            <button className="x" aria-label={`Xoá biến ${v.name}`} onClick={() => setVars((vs) => vs.filter((_, j) => j !== i))}>×</button>
            <textarea aria-label={`Giá trị của ${v.name || 'biến'}`} rows={2} placeholder="Mỗi dòng một giá trị" value={v.value} onChange={(e) => setVar(i, { value: e.target.value })} />
          </div>
        ))}
        <button className="small" onClick={() => setVars((vs) => [...vs, { name: '', value: '' }])}>+ Thêm biến</button>
        {missing.length > 0 && <p className="hint">Đang dùng nhưng chưa khai báo: {missing.map((n) => <button key={n} className="small" onClick={() => setVars((vs) => [...vs, { name: n, value: '' }])}>{`{${n}}`}</button>)}</p>}
        <p className="hint">Bấm vào một node trên khung để xem và sửa cấu hình của node đó ở đây.</p>
        <p className="hint" data-testid="wf-wire-hint">Muốn bỏ một dây nối: bấm vào dây (dây đổi sang màu xanh) rồi bấm Xoá dây này ở đây, hoặc nhấn phím Delete.</p>
      </>
    )
    const r = run?.nodes[sel.id], t = sel.type!
    const step = preview?.steps.find((x) => x.node === sel.id), perr = preview?.errors.find((x) => x.node === sel.id)
    const prompts = step ? step.prompts.split('\n').filter((l) => l.trim()) : []
    const fill = t === 'text' ? fillLines(sel.data.text ?? '', table) : null
    const bad = t === 'generate' ? filled().errs : {}, wired = edges.filter((e) => e.target === sel.id).map((e) => bad[e.source]).filter(Boolean) // a wired Text whose variable has no value
    return (
      <>
        <h3><Icon name={ICON[t]} /> {TITLE[t]}</h3>
        {r && <Chip tone={STATE[r.state]?.[0] ?? 'idle'}>{STATE[r.state]?.[1] ?? r.state}{r.total ? ` ${r.done}/${r.total}` : ''}</Chip>}
        {(t === 'text' || t === 'note') && <textarea aria-label={t === 'text' ? 'Prompt (bảng cấu hình)' : 'Ghi chú (bảng cấu hình)'} rows={10} value={sel.data.text ?? ''} onChange={(e) => tools.patch(sel.id, { text: e.target.value })} />}
        {fill && ('error' in fill ? <p className="wf-err" role="alert">{varErr(fill.error)}</p> : <p className="hint" data-testid="wf-count">{fill.prompts.length} prompt sau khi thay biến</p>)}
        {t === 'image' && (
          <>
            {(sel.data.assets ?? []).map((a) => (
              <div key={a.id} className="wf-row"><span className="wf-file">{a.missing ? 'Không còn file này' : a.name}</span>
                <button className="x" aria-label={`Bỏ ảnh ${a.name}`} onClick={() => tools.patch(sel.id, { assets: sel.data.assets!.filter((x) => x.id !== a.id) })}>×</button></div>
            ))}
            <button className="small" onClick={() => tools.pick(sel.id)}>{sel.data.assets?.length ? 'Chọn lại ảnh' : 'Chọn ảnh'}</button>
            <p className="hint">Tối đa 8 ảnh. Mọi prompt của node Tạo ảnh nối vào đều dùng các ảnh này.</p>
          </>
        )}
        {t === 'generate' && (() => {
          const cur = sel.data.combo ?? DEFAULT
          return (
            <div className="wf-set" data-testid="wf-settings">
              <h4>Cài đặt tạo {cur.kind === 'video' ? 'video' : 'ảnh'}</h4>
              <Opt label="Loại kết quả" value={cur.kind} options={['image', 'video']} show={(k) => (k === 'video' ? 'Video' : 'Ảnh')} onChange={(k) => tools.patch(sel.id, { combo: k === 'video' ? defaultCombo('video') : undefined })} />
              <ComboFields value={cur} onChange={(combo) => tools.patch(sel.id, { combo })} />
              <p className="hint">{sel.data.combo ? 'Node này dùng cài đặt riêng.' : 'Đang dùng cài đặt mặc định của app.'} Trước khi gửi, app tự chọn đúng các mục này trong Flow; Flow không nhận thì node dừng lại, không gửi bằng cài đặt khác.</p>
              {sel.data.combo && <button className="small" onClick={() => tools.patch(sel.id, { combo: undefined })}>Về mặc định</button>}
            </div>
          )
        })()}
        {t === 'generate' && (
          <div className="wf-preview" data-testid="wf-preview">
            <h4>Sẽ gửi {prompts.length} prompt</h4>
            <ol className="wf-prompts">{prompts.slice(0, 20).map((p, i) => <li key={i}>{p}</li>)}</ol>
            {prompts.length > 20 && <p className="hint">… và {prompts.length - 20} prompt nữa</p>}
            {step && <p className="hint">Mỗi prompt tạo {(step.combo ?? DEFAULT).count} {step.kind === 'video' ? 'video' : 'ảnh'}, tổng cộng {prompts.length * (step.combo ?? DEFAULT).count} {step.kind === 'video' ? 'video' : 'ảnh'}.{step.feeds && (step.combo ?? DEFAULT).count > 1 ? ' Node phía sau chỉ lấy ảnh đầu tiên của mỗi prompt làm tham chiếu.' : ''}</p>}
            {step?.kind === 'video' && <p className="hint">Video bắt đầu từ ảnh nối vào (khung hình đầu): một ảnh thì dùng chung, nhiều ảnh thì mỗi prompt một ảnh theo thứ tự. Không nối ảnh thì tạo video từ chữ.</p>}
            {step && step.kind !== 'video' && <p className="hint">Ảnh tham chiếu cho mỗi prompt: {step.images.length} ảnh chọn sẵn{step.deps.some(carries) ? `, cộng ảnh kết quả của ${step.deps.filter(carries).length} node phía trước` : ''}.</p>}
            {step?.deps.filter((x) => x.port !== 'direct').map((x) => <p key={x.node + x.port} className="hint">{COND[x.cond ?? 'all'].when[x.port === 'ok' ? 0 : 1]}</p>)}
            {step && <p className="hint">{step.save || step.feeds ? 'Kết quả sẽ được tải về máy.' : 'Kết quả chưa tự tải về: nối sang node Tự tải về nếu muốn lưu.'}</p>}
            {[...wired, ...(perr ? [why(perr.code)] : [])].map((m) => <p key={m} className="wf-err" role="alert">{m}</p>)}
          </div>
        )}
        {t === 'download' && <p className="hint">Nối chấm bên phải của node Tạo ảnh vào node này để ảnh tự lưu về Downloads/ToolFlow khi tạo xong. Node này không có gì để chỉnh.</p>}
        {t === 'branch' && (
          <>
            <Opt label="Xét node Tạo ảnh phía trước theo điều kiện" value={sel.data.cond ?? 'all'} options={Object.keys(COND)} show={(c) => COND[c as Cond].name} onChange={(c) => tools.patch(sel.id, { cond: c === 'all' ? undefined : (c as Cond) })} />
            <p className="hint" data-testid="wf-cond-help">{COND[sel.data.cond ?? 'all'].help}</p>
          </>
        )}
        {r?.code && <p className="wf-err" role="alert">{why(r.code)}</p>}
        <button className="small" onClick={() => tools.del(sel.id)}>Xoá node này</button>
      </>
    )
  }

  return (
    <section className="wf" aria-label="Workflow">
      <div className="wf-bar">
        <select aria-label="Workflow đã lưu" value={id ?? ''} onChange={(e) => open(saved.find((w) => w.id === e.target.value))}>
          <option value="">{saved.length ? 'Mở workflow đã lưu…' : 'Chưa lưu workflow nào'}</option>
          {saved.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select aria-label="Mẫu có sẵn" value="" onChange={(e) => { const t = TEMPLATES.find((x) => x.name === e.target.value); if (t) { open(t); setMsg('Đã mở mẫu. Sửa prompt trong các ô Text rồi bấm Chạy workflow') } }}>
          <option value="">Mẫu có sẵn…</option>
          {TEMPLATES.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
        <input aria-label="Tên workflow" maxLength={60} placeholder="Tên workflow" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="small" disabled={!name.trim() || !nodes.length} onClick={() => call(() => window.api.saveWorkflow({ name, graph: raw() }).then(list).then(() => setMsg('Đã lưu')))}>Lưu</button>
        <button className="small" disabled={!id} onClick={() => call(() => window.api.deleteWorkflow(id).then(list).then(() => setMsg('Đã xoá bản lưu. Các node vẫn còn trên màn hình, bấm Lưu nếu muốn giữ lại')))}>Xoá</button>
        <button className="small" disabled={!nodes.length} onClick={() => open(undefined)}>Mới</button>
        <button className="small" onClick={() => call(async () => { const w = await window.api.importWorkflow() as Canvas | null; if (w) { open(w); setMsg('Đã mở file. Bấm Lưu nếu muốn giữ trong app') } })}>Nhập file</button>
        <button className="small" disabled={!nodes.length} onClick={() => call(() => window.api.exportWorkflow({ name, graph: raw() }).then((r: { saved: boolean }) => setMsg(r.saved ? 'Đã xuất file' : '')))}>Xuất file</button>
        <span className="spacer" />
        <label><input type="radio" name="wf-mode" checked={mode === 'auto'} disabled={!s.autoEnabled} onChange={() => setMode('auto')} /> Tự động</label>
        <label><input type="radio" name="wf-mode" checked={mode === 'manual'} onChange={() => setMode('manual')} /> Thủ công</label>
        {running
          ? <button className="small" onClick={() => call(() => window.api.stopWorkflow(runId))}>Dừng workflow</button>
          : <button className="primary small" disabled={!nodes.length} onClick={start}>Chạy workflow</button>}
      </div>
      <div className="wf-bar">
        {KINDS.map((k) => <button key={k} className="small" draggable title="Bấm để thêm, hoặc kéo thả vào khung" onDragStart={(e) => e.dataTransfer.setData(DRAG, k)} onClick={() => add(k, blank(k))}>+ {TITLE[k]}</button>)}
        <button className="small" disabled={!nodes.length} onClick={() => void rf.current?.fitView(FIT)}>Căn giữa</button>
        <button className="small" disabled={!h.past.length && snap === h.cur} onClick={() => travel(true)}>Hoàn tác</button>
        <button className="small" disabled={!h.future.length || snap !== h.cur} onClick={() => travel(false)}>Làm lại</button>
        <span className="spacer" />
        <span className="muted small-text" role="status" data-testid="wf-status">
          {msg || (run ? { running: 'Đang chạy, theo dõi từng lượt ở Hàng đợi', done: 'Workflow đã chạy xong', failed: 'Workflow chạy xong, có node lỗi (xem dòng đỏ)', stopped: 'Workflow đã dừng' }[run.status] : !s.autoEnabled ? 'Tự bấm đang tắt (bật ở Cài đặt): bạn bấm Gửi trong Flow cho từng prompt' : '')}
        </span>
      </div>
      <div className="wf-main">
        <div className="wf-canvas" onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG)) e.preventDefault() }}
          onDrop={(e) => { const k = e.dataTransfer.getData(DRAG) as Kind; if (KINDS.includes(k) && rf.current) { e.preventDefault(); add(k, blank(k), rf.current.screenToFlowPosition({ x: e.clientX, y: e.clientY })) } }}>
          <Ctx.Provider value={tools}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onInit={(i) => { rf.current = i }}
              onConnect={(c: Connection) => setEdges((es) => addEdge(c, es))}
              isValidConnection={(c) => c.source !== c.target && !!WIRES[typeOf(c.source)]?.includes(typeOf(c.target) as Kind) && !(typeOf(c.target) === 'branch' && edges.some((e) => e.target === c.target))}
              fitView fitViewOptions={FIT} minZoom={0.3} deleteKeyCode={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }} ariaLabelConfig={ARIA}>
              <Background />
              <Controls showInteractive={false} showFitView={false} />
              <MiniMap pannable zoomable style={{ width: 150, height: 100 }} />
            </ReactFlow>
          </Ctx.Provider>
          {!nodes.length && (
            <div className="wf-empty">
              <p>Mỗi ô là một bước. Kéo từ chấm tròn bên phải của ô này sang chấm bên trái của ô kia để nối chúng (hoặc bấm lần lượt vào hai chấm).</p>
              <button className="primary" onClick={starter}>Tạo chuỗi mẫu: Text → Tạo ảnh → Tự tải về</button>
            </div>
          )}
        </div>
        <aside className="wf-side" aria-label="Cấu hình">{side()}</aside>
      </div>
    </section>
  )
}
