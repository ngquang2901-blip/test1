// Node canvas (TobyFlow-style): Text / Ảnh → Tạo ảnh Flow → Tự tải về. The graph is only a way to describe batches;
// main compiles it (src/main/workflow.ts) and runs every "Tạo ảnh Flow" node as a normal batch you can follow in Hàng đợi.
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Background, Handle, Position, ReactFlow, addEdge, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { hintOf } from '../hints'
import type { PresetAsset, Session } from '../types'
import { Chip, Icon, type Tone } from '../ui'
import { Thumb } from './Results'

type Kind = 'text' | 'image' | 'generate' | 'download' | 'note'
type Data = { text?: string; assets?: PresetAsset[] }
type WNode = Node<Data, Kind>
type NodeRun = { state: string; code: string | null; total: number; done: number; thumb: { attemptId: string; mediaId: string } | null }
type RunView = { status: 'running' | 'done' | 'failed' | 'stopped'; nodes: Record<string, NodeRun> }
type Saved = { id: string; name: string; nodes: { id: string; type: Kind; x: number; y: number; text?: string; assets?: PresetAsset[] }[]; edges: { from: string; to: string }[] }

const TITLE: Record<Kind, string> = { text: 'Text', image: 'Ảnh tham chiếu', generate: 'Tạo ảnh Flow', download: 'Tự tải về', note: 'Ghi chú' }
const ICON = { text: 'list', image: 'image', generate: 'layers', download: 'download', note: 'sliders' } as const
const WIRES: Record<string, Kind[]> = { text: ['generate'], image: ['generate'], generate: ['generate', 'download'] } // main checks the same table again
// where a new node lands: inputs stack on the left, each further Tạo ảnh steps right and down so a chain reads left to right
const place = (type: Kind, ns: WNode[]): { x: number; y: number } => {
  const k = ns.filter((n) => (type === 'generate' || type === 'download' ? n.type === type : !['generate', 'download'].includes(n.type!))).length
  return type === 'generate' ? { x: 400 + 360 * k, y: 40 + 240 * k } : type === 'download' ? { x: 760 + 360 * k, y: 40 } : { x: 40, y: 40 + 240 * k }
}
const STATE: Record<string, [Tone, string]> = { waiting: ['idle', 'Chờ lượt'], running: ['run', 'Đang chạy'], done: ['done', 'Xong'], failed: ['attn', 'Lỗi'], skipped: ['attn', 'Bỏ qua'], stopped: ['idle', 'Đã dừng'] }
const WHY: Record<string, string> = {
  WF_NO_GENERATE: 'Chưa có node Tạo ảnh Flow nào. Thêm một node rồi nối Text vào nó',
  WF_NO_PROMPT: 'Node này chưa có prompt. Nối một node Text có chữ vào chấm bên trái',
  WF_CYCLE: 'Các node Tạo ảnh đang nối thành vòng tròn. Bỏ bớt một dây nối',
  TOO_MANY_REFS: 'Quá 8 ảnh tham chiếu cho một prompt. Bớt ảnh hoặc bớt prompt ở node phía trước',
  REF_ASSET_MISSING: 'Có ảnh tham chiếu không còn trên máy. Chọn lại ảnh ở node Ảnh tham chiếu',
  WF_UPSTREAM_INCOMPLETE: 'Node phía trước chưa có đủ ảnh đã lưu nên node này không gửi gì. Xem Hàng đợi, sửa xong thì chạy lại',
  WF_BATCH_FAILED: 'Lô của node này bị lỗi. Xem lý do ở Hàng đợi',
  WF_BATCH_PARTIAL_FAILED: 'Một phần prompt của node này bị lỗi. Xem lý do ở Hàng đợi',
  WF_BATCH_STOPPED: 'Lô của node này đã bị dừng',
  NO_PROJECT_TAB: 'Chưa có tab Flow nào được cấp quyền. Vào màn Kết nối rồi bấm Dùng tab này',
}
const why = (code: string): string => WHY[code] ?? hintOf(code) ?? `Lỗi ${code}`
const clean = (m: string): string => m.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')

const Ctx = createContext<{ run: RunView | null; errs: Record<string, string> }>({ run: null, errs: {} })

function Box({ id, type, data }: NodeProps<WNode>): React.JSX.Element {
  const rf = useReactFlow()
  const { run, errs } = useContext(Ctx)
  const r = run?.nodes[id], err = errs[id] ?? r?.code
  const [note, setNote] = useState('')
  const pick = (): void => void window.api.pickRefs().then((p: { assets: PresetAsset[]; errors: unknown[] }) => {
    if (p.assets.length) rf.updateNodeData(id, { assets: p.assets.slice(0, 8) })
    setNote(p.errors.length ? `${p.errors.length} file không dùng được (chỉ nhận PNG, JPG, WEBP dưới 20 MB)` : p.assets.length > 8 ? 'Chỉ lấy 8 ảnh đầu' : '')
  })
  return (
    <div className="wf-node" data-testid={`wf-${type}`} data-state={err && !r ? 'failed' : r?.state}>
      {(type === 'generate' || type === 'download') && <Handle type="target" position={Position.Left} />}
      <header>
        <Icon name={ICON[type]} /><b>{TITLE[type]}</b><span className="spacer" />
        {r && <Chip tone={STATE[r.state]?.[0] ?? 'idle'}>{STATE[r.state]?.[1] ?? r.state}{r.total ? ` ${r.done}/${r.total}` : ''}</Chip>}
        <button className="x nodrag" aria-label={`Xoá node ${TITLE[type]}`} onClick={() => void rf.deleteElements({ nodes: [{ id }] })}>×</button>
      </header>
      {(type === 'text' || type === 'note') && (
        <textarea className="nodrag nowheel" rows={type === 'text' ? 5 : 3} aria-label={type === 'text' ? 'Prompt của node Text' : 'Nội dung ghi chú'} placeholder={type === 'text' ? 'Mỗi dòng là một prompt' : 'Ghi chú cho mình, app không gửi đi'}
          value={data.text ?? ''} onChange={(e) => rf.updateNodeData(id, { text: e.target.value })} />
      )}
      {type === 'image' && (
        <>
          {(data.assets ?? []).map((a) => <div key={a.id} className="wf-file">{a.missing ? 'Không còn file này' : a.name}</div>)}
          <button className="small nodrag" onClick={pick}>{data.assets?.length ? 'Chọn lại ảnh' : 'Chọn ảnh'}</button>
          {note && <p className="hint">{note}</p>}
        </>
      )}
      {type === 'generate' && (r?.thumb ? <Thumb attemptId={r.thumb.attemptId} media={r.thumb.mediaId} saved /> : <p className="hint">Mỗi prompt nối vào tạo một lượt ảnh. Nối chấm bên phải sang node Tạo ảnh khác để dùng ảnh vừa tạo làm ảnh tham chiếu.</p>)}
      {type === 'download' && <p className="hint">Lưu kết quả của node nối vào đây về thư mục Downloads/ToolFlow.</p>}
      {err && <p className="wf-err" role="alert">{why(err)}</p>}
      {(type === 'text' || type === 'image' || type === 'generate') && <Handle type="source" position={Position.Right} />}
    </div>
  )
}
const NODE_TYPES = { text: Box, image: Box, generate: Box, download: Box, note: Box }

// the canvas survives a visit to another screen: mid-run the user goes to Hàng đợi (or to Flow to click Gửi) and comes back
let keep: { nodes: WNode[]; edges: Edge[]; name: string; runId: string | null } = { nodes: [], edges: [], name: '', runId: null }

export default function Workflow({ s }: { s: Session }): React.JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<WNode>(keep.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(keep.edges)
  const [name, setName] = useState(keep.name)
  const [runId, setRunId] = useState(keep.runId)
  const [run, setRun] = useState<RunView | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Saved[]>([])
  const [mode, setMode] = useState<'auto' | 'manual'>(s.autoEnabled ? 'auto' : 'manual')
  const [msg, setMsg] = useState('')
  const rf = useRef<ReactFlowInstance<WNode, Edge> | null>(null)
  useEffect(() => { keep = { nodes, edges, name, runId } })
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

  const call = (f: () => Promise<unknown>): void => { setMsg(''); void f().catch((e: Error) => setMsg(why(clean(e.message)))) }
  const typeOf = (id: string | null): string => nodes.find((n) => n.id === id)?.type ?? ''
  const graph = (): object => ({
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, x: n.position.x, y: n.position.y, ...(n.data.text !== undefined ? { text: n.data.text } : {}), ...(n.data.assets ? { assetIds: n.data.assets.map((a) => a.id) } : {}) })),
    edges: edges.map((e) => ({ from: e.source, to: e.target })),
  })
  const reset = (): void => { setRunId(null); setRun(null); setErrs({}); setMsg('') }
  const open = (w: Saved | undefined): void => {
    reset()
    setName(w?.name ?? '')
    setNodes((w?.nodes ?? []).map((n) => ({ id: n.id, type: n.type, position: { x: n.x, y: n.y }, data: { ...(n.text !== undefined ? { text: n.text } : {}), ...(n.assets ? { assets: n.assets } : {}) } })))
    setEdges((w?.edges ?? []).map((e) => ({ id: `${e.from}>${e.to}`, source: e.from, target: e.to })))
    setTimeout(() => void rf.current?.fitView({ maxZoom: 1 }), 50)
  }
  const add = (type: Kind, data: Data = {}): string => {
    const id = crypto.randomUUID()
    setNodes((ns) => [...ns, { id, type, position: place(type, ns), data }])
    setTimeout(() => void rf.current?.fitView({ maxZoom: 1 }), 50) // a new node must be on screen
    return id
  }
  const starter = (): void => { // the chain most people start from, already wired
    const t = add('text', { text: '' }), g = add('generate'), d = add('download')
    setEdges([{ id: `${t}>${g}`, source: t, target: g }, { id: `${g}>${d}`, source: g, target: d }])
  }
  const start = (): void => call(async () => {
    setErrs({})
    const r = await window.api.runWorkflow({ graph: graph(), mode }) as { runId?: string; errors?: { node?: string; code: string }[] }
    if (r.errors) {
      setErrs(Object.fromEntries(r.errors.filter((e) => e.node).map((e) => [e.node!, e.code])))
      setMsg(r.errors.some((e) => !e.node) ? why(r.errors.find((e) => !e.node)!.code) : 'Chưa chạy được: xem dòng đỏ trên node')
    } else { setRun(null); setRunId(r.runId!) }
  })
  const running = run?.status === 'running' || (!!runId && !run)
  const id = saved.find((w) => w.name === name.trim())?.id

  return (
    <section className="wf" aria-label="Workflow">
      <div className="wf-bar">
        <select aria-label="Workflow đã lưu" value={id ?? ''} onChange={(e) => open(saved.find((w) => w.id === e.target.value))}>
          <option value="">{saved.length ? 'Mở workflow đã lưu…' : 'Chưa lưu workflow nào'}</option>
          {saved.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <input aria-label="Tên workflow" maxLength={60} placeholder="Tên workflow" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="small" disabled={!name.trim() || !nodes.length} onClick={() => call(() => window.api.saveWorkflow({ name, graph: graph() }).then(list).then(() => setMsg('Đã lưu')))}>Lưu</button>
        <button className="small" disabled={!id} onClick={() => call(() => window.api.deleteWorkflow(id).then(list).then(() => setMsg('Đã xoá bản lưu. Các ô vẫn còn trên màn hình, bấm Lưu nếu muốn giữ lại')))}>Xoá</button>
        <button className="small" disabled={!nodes.length} onClick={() => open(undefined)}>Mới</button>
        <span className="spacer" />
        <label><input type="radio" name="wf-mode" checked={mode === 'auto'} disabled={!s.autoEnabled} onChange={() => setMode('auto')} /> Tự động</label>
        <label><input type="radio" name="wf-mode" checked={mode === 'manual'} onChange={() => setMode('manual')} /> Thủ công</label>
        {running
          ? <button className="small" onClick={() => call(() => window.api.stopWorkflow(runId))}>Dừng workflow</button>
          : <button className="primary small" disabled={!nodes.length} onClick={start}>Chạy workflow</button>}
      </div>
      <div className="wf-bar">
        {(['text', 'image', 'generate', 'download', 'note'] as Kind[]).map((k) => <button key={k} className="small" onClick={() => add(k, k === 'text' || k === 'note' ? { text: '' } : {})}>+ {TITLE[k]}</button>)}
        <button className="small" disabled={!nodes.length} onClick={() => void rf.current?.fitView({ maxZoom: 1 })}>Căn giữa</button>
        <span className="spacer" />
        <span className="muted small-text" role="status" data-testid="wf-status">
          {msg || (run ? { running: 'Đang chạy, theo dõi từng lượt ở Hàng đợi', done: 'Workflow đã chạy xong', failed: 'Workflow dừng vì có node lỗi', stopped: 'Workflow đã dừng' }[run.status] : !s.autoEnabled ? 'Tự bấm đang tắt (bật ở Cài đặt): bạn bấm Gửi trong Flow cho từng prompt' : '')}
        </span>
      </div>
      <div className="wf-canvas">
        <Ctx.Provider value={{ run, errs }}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onInit={(i) => { rf.current = i }}
            onConnect={(c: Connection) => setEdges((es) => addEdge(c, es))} isValidConnection={(c) => c.source !== c.target && !!WIRES[typeOf(c.source)]?.includes(typeOf(c.target) as Kind)}
            fitView fitViewOptions={{ maxZoom: 1 }} minZoom={0.3} deleteKeyCode={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}>
            <Background />
          </ReactFlow>
        </Ctx.Provider>
        {!nodes.length && (
          <div className="wf-empty">
            <p>Mỗi ô là một bước. Kéo từ chấm tròn bên phải của ô này sang chấm bên trái của ô kia để nối chúng (hoặc bấm lần lượt vào hai chấm).</p>
            <button className="primary" onClick={starter}>Tạo chuỗi mẫu: Text → Tạo ảnh → Tự tải về</button>
          </div>
        )}
      </div>
    </section>
  )
}
