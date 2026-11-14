// Node canvas drawn like TobyFlow's editor (always dark): a header, a floating tool column, a dotted canvas, a block picker, a form
// under a Tạo ảnh node and a right panel (Cấu hình / Kết quả / Trợ giúp). The graph is only a way to describe batches; main compiles
// it (src/main/workflow.ts) and runs every "Tạo ảnh Flow" node as a normal batch.
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Background, BackgroundVariant, BaseEdge, Controls, Handle, Position, ReactFlow, addEdge, getBezierPath, useEdgesState, useInternalNode, useNodesState, useStore, useViewport, type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { hintOf } from '../hints'
import { MAX_PROMPTS, fillLines, varsOf, type ExpandError } from '../template'
import type { PresetAsset, Session } from '../types'
import { Chip, Icon, type IconName, type Tone } from '../ui'
import { Thumb } from './Results'
import { ComboFields, Opt, choicesOf, comboLabel, defaultCombo, withChange, type Combo } from '../combo'
import { TEMPLATES } from '../wf-templates'
import { csvMsg, fillRows, readCsv } from '../csv'

type Kind = 'text' | 'image' | 'generate' | 'download' | 'note' | 'branch' | 'loop' | 'csv' | 'frame' | 'merge'
type Pick = Kind | 'video' // a picker entry; 'video' = a Tạo ảnh node set to the default video settings
type Cond = 'all' | 'any' | 'filtered' // what a Điều kiện node asks (absent = 'all')
type Site = 'chatgpt' | 'gemini' // a Tạo ảnh node that goes to a chat site instead of Flow
type Data = { text?: string; assets?: PresetAsset[]; combo?: Combo; cond?: Cond; site?: Site; aspect?: string; model?: string; rounds?: number; rows?: string[][] } // rounds: a Vòng lặp's; rows: a Bảng CSV's table (header first), text being its {Cột} template
/** A Tạo ảnh node says where it sends (Flow unless a site is chosen) and whether it makes videos. */
const genTitle = (d: Data): string => (d.site === 'gemini' ? 'Tạo ảnh Gemini' : d.site === 'chatgpt' ? 'Tạo ảnh ChatGPT' : d.combo?.kind === 'video' ? 'Tạo video Flow' : 'Tạo ảnh Flow')
const SITE_LABEL: Record<Site, string> = { chatgpt: 'ChatGPT · Create image', gemini: 'Gemini · Tạo hình ảnh' }
const SITE_NAME: Record<string, string> = { flow: 'Google Flow', chatgpt: 'ChatGPT', gemini: 'Gemini' }
const GEM_ASPECTS = ['1:1', '9:16', '3:4', '4:3', '16:9'], GEM_MODELS = ['Flash-Lite', 'Flash', 'Pro']
type WNode = Node<Data, Kind>
type Var = { name: string; value: string }
type NodeRun = { state: string; code: string | null; total: number; done: number; thumb: { attemptId: string; mediaId: string } | null; round?: number; rounds?: number; file?: string } // round: a Vòng lặp's round shown; file: a Ghép video's file name
type RunView = { status: 'running' | 'done' | 'failed' | 'stopped'; nodes: Record<string, NodeRun> }
type Canvas = { name?: string; nodes: { id: string; type: Kind; x: number; y: number; text?: string; assets?: PresetAsset[]; combo?: Combo; cond?: Cond; site?: Site; aspect?: string; model?: string; rounds?: number; rows?: string[][] }[]; edges: { from: string; to: string; port?: string }[]; vars?: Record<string, string> }
type Saved = Canvas & { id: string; name: string }
type Plan = { steps: { node: string; kind: 'image' | 'video'; prompts: string; images: string[]; deps: { node: string; port: string; cond?: Cond }[]; save: boolean; feeds: boolean; combo?: Combo; site?: Site }[]; merges?: { node: string; inputs: string[] }[]; errors: { node?: string; code: string }[] }

const TITLE: Record<Kind, string> = { text: 'Text', image: 'Ảnh tham chiếu', generate: 'Tạo ảnh Flow', download: 'Tự tải về', note: 'Ghi chú', branch: 'Điều kiện', loop: 'Vòng lặp', csv: 'Bảng CSV', frame: 'Khung cuối', merge: 'Ghép video' }
const ICON: Record<Kind, IconName> = { text: 'text', image: 'image', generate: 'layers', download: 'download', note: 'note', branch: 'branch', loop: 'repeat', csv: 'table', frame: 'film', merge: 'merge' }
// the picker: one flat list, in this order
const PICKS: { k: Pick; name: string; desc: string; icon: IconName }[] = [
  { k: 'text', name: 'Text', desc: 'Danh sách prompt, mỗi dòng một prompt', icon: 'text' },
  { k: 'csv', name: 'Bảng CSV', desc: 'Mỗi dòng của file CSV thành một prompt', icon: 'table' },
  { k: 'image', name: 'Ảnh tham chiếu', desc: 'Ảnh trên máy gửi kèm làm ảnh tham chiếu', icon: 'image' },
  { k: 'generate', name: 'Tạo ảnh Flow', desc: 'Tạo ảnh bằng Google Flow, ChatGPT hoặc Gemini', icon: 'layers' },
  { k: 'video', name: 'Tạo video Flow', desc: 'Tạo video bằng Google Flow', icon: 'video' },
  { k: 'frame', name: 'Khung cuối', desc: 'Khung hình cuối của video làm khung đầu cảnh sau', icon: 'film' },
  { k: 'merge', name: 'Ghép video', desc: 'Ghép các video nối vào thành một file MP4', icon: 'merge' },
  { k: 'loop', name: 'Vòng lặp', desc: 'Chạy lại node Tạo ảnh nhiều vòng', icon: 'repeat' },
  { k: 'branch', name: 'Điều kiện', desc: 'Chạy tiếp một trong hai nhánh theo kết quả', icon: 'branch' },
  { k: 'download', name: 'Tự tải về', desc: 'Lưu kết quả về Downloads/ToolFlow', icon: 'download' },
  { k: 'note', name: 'Ghi chú', desc: 'Ghi chú cho mình, app không gửi đi', icon: 'note' },
]
const WIRES: Record<string, Kind[]> = { text: ['generate'], csv: ['generate'], image: ['generate'], generate: ['generate', 'download', 'branch', 'loop', 'frame', 'merge'], branch: ['generate'], loop: ['generate', 'download', 'branch'], frame: ['generate'] } // main checks the same table again
const VIDEO_OUT: Kind[] = ['download', 'loop', 'frame', 'merge'] // a video's result goes nowhere else (main says WF_VIDEO_OUTPUT)
const ONE_IN: Kind[] = ['branch', 'loop', 'frame'] // nodes that look at exactly one Tạo ảnh node
// ports: a ring coloured by what travels through it (Toby: text violet, image blue, video / frame green)
type PortKind = 'text' | 'image' | 'video' | 'any'
const PORT_ICON: Record<PortKind, IconName> = { text: 'text', image: 'image', video: 'video', any: 'dot' }
const PORT_NAME: Record<PortKind, string> = { text: 'chữ', image: 'ảnh', video: 'video', any: 'mọi loại' }
const IN: Partial<Record<Kind, PortKind>> = { generate: 'any', download: 'any', branch: 'image', loop: 'image', frame: 'video', merge: 'video' }
const isVideo = (d: Data): boolean => !d.site && d.combo?.kind === 'video'
const outPort = (type: Kind, d: Data): PortKind => (type === 'text' || type === 'csv' ? 'text' : type === 'frame' || (type === 'generate' && isVideo(d)) ? 'video' : 'image')
const outLabel = (type: Kind, d: Data): string => (type === 'text' || type === 'csv' ? 'Prompt' : type === 'frame' ? 'Khung hình cuối' : type === 'image' ? 'Ảnh đã chọn' : isVideo(d) ? 'Video kết quả' : 'Ảnh kết quả')
const STATE: Record<string, [Tone, string]> = { waiting: ['idle', 'Chờ lượt'], running: ['run', 'Đang chạy'], done: ['done', 'Xong'], failed: ['attn', 'Lỗi'], skipped: ['attn', 'Bỏ qua'], bypassed: ['idle', 'Không chạy'], stopped: ['idle', 'Đã dừng'] }
const WHY: Record<string, string> = {
  WF_NO_GENERATE: 'Chưa có node Tạo ảnh Flow nào. Thêm một node rồi nối Text vào nó',
  WF_NO_PROMPT: 'Node này chưa có prompt. Nối một node Text có chữ vào chấm bên trái',
  WF_CYCLE: 'Các node Tạo ảnh đang nối thành vòng tròn. Bỏ bớt một dây nối',
  WF_BRANCH_INPUT: 'Node Điều kiện cần đúng một node Tạo ảnh nối vào chấm bên trái',
  WF_VIDEO_FRAMES: 'Node video cần 1 ảnh dùng chung, hoặc số ảnh đúng bằng số prompt (mỗi prompt một ảnh làm khung hình đầu). Sửa số prompt hoặc số ảnh nối vào',
  WF_VIDEO_OUTPUT: 'Kết quả video chỉ nối được sang Tự tải về, Khung cuối, Ghép video hoặc Vòng lặp. Bỏ dây nối sang node Tạo ảnh hoặc Điều kiện',
  WF_FRAME_INPUT: 'Node Khung cuối cần đúng một node Tạo video nối vào chấm bên trái',
  WF_MERGE_INPUT: 'Node Ghép video chỉ nhận node Tạo video, và cần ít nhất một node nối vào',
  FFMPEG_FAILED: 'Không ghép hoặc cắt được video (ffmpeg báo lỗi). Thử chạy lại; nếu vẫn lỗi, xem các video gốc trong thư mục tải về',
  FFMPEG_NOT_VIDEO: 'Có file kết quả không phải video đọc được nên không ghép hoặc lấy khung cuối được. Chạy lại node Tạo video đó',
  WF_FILE_GONE: 'Không còn file video đã ghép của lượt chạy này (app đã mở lại hoặc file bị xoá). Chạy lại workflow để ghép lại',
  WF_FILE_INVALID: 'File này không phải workflow của ToolFlow hoặc đã hỏng',
  TOO_MANY_REFS: 'Quá 10 ảnh tham chiếu cho một prompt. Bớt ảnh hoặc bớt prompt ở node phía trước',
  REF_ASSET_MISSING: 'Có ảnh tham chiếu không còn trên máy. Chọn lại ảnh ở node Ảnh tham chiếu',
  WF_UPSTREAM_INCOMPLETE: 'Node phía trước chưa có đủ ảnh đã lưu nên node này không gửi gì. Xem Hàng đợi, sửa xong thì chạy lại',
  WF_BATCH_FAILED: 'Lô của node này bị lỗi. Xem lý do ở Hàng đợi',
  WF_BATCH_PARTIAL_FAILED: 'Một phần prompt của node này bị lỗi. Xem lý do ở Hàng đợi',
  WF_BATCH_STOPPED: 'Lô của node này đã bị dừng',
  NO_PROJECT_TAB: 'Chưa có tab Flow nào được cấp quyền. Vào màn Kết nối rồi bấm Dùng tab này',
  COMBO_NOT_QUALIFIED: 'Cài đặt tạo ảnh của node này không nằm trong danh sách app đã kiểm thử nên không gửi. Chọn lại mô hình, tỉ lệ, số ảnh trong phần cài đặt của node',
}
// the Trợ giúp tab: what the block does, and a chain it is often used in
const HELP: Record<Kind, [string, string]> = {
  text: ['Mỗi dòng là một prompt. Viết {tên biến} cho phần lặp lại rồi khai báo giá trị ở bảng Biến dùng lại (bấm vào nền trống để mở).', 'Text → Tạo ảnh Flow → Tự tải về'],
  csv: ['Nạp một file CSV: mỗi dòng thành một prompt, ghép từ mẫu có tên cột trong ngoặc nhọn, ví dụ {Tên} đứng ở {Nơi}.', 'Bảng CSV → Tạo ảnh Flow → Tự tải về'],
  image: ['Chọn tối đa 10 ảnh trên máy. Mọi prompt của node Tạo ảnh nối vào đều gửi kèm các ảnh này làm ảnh tham chiếu.', 'Ảnh tham chiếu + Text → Tạo ảnh Flow → Tự tải về'],
  generate: ['Gửi từng prompt của các node Text nối vào sang Google Flow (hoặc ChatGPT, Gemini). Ảnh nối vào là ảnh tham chiếu; với video, ảnh nối vào là khung hình đầu.', 'Text → Tạo ảnh Flow → Tạo ảnh Flow (dùng ảnh vừa tạo làm tham chiếu) → Tự tải về'],
  download: ['Lưu kết quả của node nối vào về thư mục Downloads/ToolFlow khi tạo xong.', 'Tạo ảnh Flow → Tự tải về'],
  note: ['Ghi chú cho mình đọc. App không gửi ghi chú đi đâu.', 'Đặt ghi chú cạnh các bước để nhớ cách dùng workflow'],
  branch: ['Xét node Tạo ảnh nối vào rồi chạy tiếp một trong hai nhánh. Đổi câu hỏi ở tab Cấu hình.', 'Tạo ảnh → Điều kiện → (Thiếu ảnh) Tạo ảnh với prompt dự phòng'],
  loop: ['Chạy lại node Tạo ảnh nối vào nhiều vòng, mỗi vòng gửi kèm ảnh của vòng trước làm ảnh tham chiếu.', 'Text → Tạo ảnh Flow → Vòng lặp (3 vòng) → Tự tải về'],
  frame: ['Lấy khung hình cuối của mỗi video do node Tạo video nối vào làm ra. Prompt thứ nhất của node Tạo video phía sau bắt đầu từ khung cuối của video thứ nhất, và cứ thế.', 'Tạo video → Khung cuối → Tạo video (cảnh tiếp theo) → Ghép video'],
  merge: ['Ghép video của các node Tạo video nối vào thành một file MP4, theo thứ tự dây nối (trong mỗi node theo thứ tự prompt). File được lưu cạnh video đầu tiên.', 'Tạo video → Khung cuối → Tạo video, rồi nối cả hai node Tạo video vào Ghép video'],
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
const FIT = { maxZoom: 1, padding: { top: '70px', bottom: '60px', left: '72px', right: '40px' } } as const // room for the tool column, the zoom buttons and the names above the nodes
const DRAG = 'application/x-toolflow-node' // a block dragged from the picker onto the canvas
const ARIA = { 'controls.ariaLabel': 'Phóng to, thu nhỏ', 'controls.zoomIn.ariaLabel': 'Phóng to', 'controls.zoomOut.ariaLabel': 'Thu nhỏ' }
const clean = (m: string): string => m.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
const COL = 440, ROW = 320 // one step of a chain across, one node down
// where a new node lands: inputs stack on the left; a taken spot pushes the node down (a Tạo ảnh also right, so a chain reads left to right)
const place = (type: Kind, ns: WNode[]): { x: number; y: number } => {
  const p = { x: type === 'generate' ? COL : type === 'download' || type === 'branch' || type === 'loop' || type === 'frame' || type === 'merge' ? 2 * COL : 0, y: 0 }
  while (ns.some((n) => Math.abs(n.position.x - p.x) < 360 && Math.abs(n.position.y - p.y) < ROW)) { p.y += ROW; if (type === 'generate') p.x += COL }
  return p
}
/** A Tạo ảnh node's frame: the aspect its settings ask for (Gemini's own, or square when the site decides). */
const ratio = (d: Data): [number, number] => {
  const m = /^(\d+):(\d+)$/.exec(d.site ? (d.site === 'gemini' ? d.aspect ?? '' : '') : (d.combo ?? DEFAULT).aspect)
  return m ? [Number(m[1]), Number(m[2])] : [1, 1]
}

type Tools = {
  run: RunView | null; errs: Record<string, string>; order: Record<string, number>; manual: boolean
  prompt(id: string): string; patch(id: string, d: Data): void; pick(id: string): void; del(id: string): void; csv(id: string, f?: File): void
  dup(id: string): void; copy(id: string): void; cfg(id: string): void; reveal(id: string): void; port(e: React.MouseEvent, id: string, handle?: string): void
}
const Ctx = createContext<Tools>(null!)
const chip = (r: NodeRun): string => `${STATE[r.state]?.[1] ?? r.state}${r.round ? ` · vòng ${r.round}/${r.rounds}` : ''}${r.total ? ` ${r.done}/${r.total}` : ''}`
const CsvButton = ({ id, has }: { id: string; has: boolean }): React.JSX.Element => {
  const { csv } = useContext(Ctx)
  return <label className="filebtn small nodrag">{has ? 'Nạp file CSV khác' : 'Nạp file CSV'}<input type="file" accept=".csv,text/csv" onChange={(e) => { csv(id, e.target.files?.[0]); e.target.value = '' }} /></label>
}
const cols = (d: Data): string => (d.rows?.[0] ?? []).map((h) => `{${h.trim()}}`).join(' ')
/** What a running node is doing, from its counts only: nothing sent yet, results coming in, all in and being saved. */
const phase = (r: NodeRun, manual: boolean): string => (!r.total ? 'Đang gửi' : r.done < r.total ? (manual ? 'Đang chờ trong Hàng đợi' : `Đang tạo ${r.done}/${r.total}`) : 'Đang tải về')
// shortcut: the clock counts from when this screen first saw the node running (a visit to another screen restarts it); keep a start time per node in main if users ask for exact times
function Clock(): React.JSX.Element {
  const [s, setS] = useState(0)
  useEffect(() => { const i = setInterval(() => setS((x) => x + 1), 1000); return () => clearInterval(i) }, [])
  return <span className="wf-clock">{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>
}
const Loading = ({ text }: { text: string }): React.JSX.Element => <div className="wf-load"><span className="wf-spin" /><Clock /><span>{text}</span></div>

function Port({ side, kind, node, id, label }: { side: 'source' | 'target'; kind: PortKind; node: string; id?: string; label: string }): React.JSX.Element {
  const t = useContext(Ctx)
  return (
    <Handle type={side} id={id} position={side === 'target' ? Position.Left : Position.Right} className={`wf-h wf-h-${kind}`} title={label}
      onClick={side === 'source' ? (e) => t.port(e, node, id) : undefined}>
      <Icon name={PORT_ICON[kind]} size={16} />
    </Handle>
  )
}
/** A select drawn as a pill on the node: changes the setting at once, offers only what the settings allow. */
const Pill = ({ label, value, options, show = (v) => v, onChange }: { label: string; value: string; options: string[]; show?: (v: string) => string; onChange(v: string): void }): React.JSX.Element => (
  <select className="wf-pill nodrag" aria-label={label} title={label} value={value} onChange={(e) => onChange(e.target.value)}>
    {!options.includes(value) && <option value={value} disabled>{show(value)}</option>}
    {options.map((o) => <option key={o} value={o}>{show(o)}</option>)}
  </select>
)
function Pills({ id, d }: { id: string; d: Data }): React.JSX.Element {
  const { patch } = useContext(Ctx)
  if (d.site) return (
    <div className="wf-pills nodrag">
      <Pill label="Nền tảng trên node" value={d.site} options={['flow', 'chatgpt', 'gemini']} show={(v) => SITE_NAME[v]} onChange={(v) => patch(id, { site: v === 'flow' ? undefined : (v as Site), combo: undefined, aspect: undefined, model: undefined })} />
      {d.site === 'gemini' && <Pill label="Mô hình trên node" value={d.model ?? ''} options={['', ...GEM_MODELS]} show={(v) => v || 'Mô hình tự động'} onChange={(v) => patch(id, { model: v || undefined })} />}
      {d.site === 'gemini' && <Pill label="Tỉ lệ trên node" value={d.aspect ?? ''} options={['', ...GEM_ASPECTS]} show={(v) => v || 'Tỉ lệ tự động'} onChange={(v) => patch(id, { aspect: v || undefined })} />}
    </div>
  )
  const c = d.combo ?? DEFAULT, all = choicesOf(c.kind), ch = all.find((x) => x.model === c.model), set = (p: Partial<Combo>): void => patch(id, { combo: withChange(c, p) })
  return (
    <div className="wf-pills nodrag">
      <Pill label="Số lượng trên node" value={String(c.count)} options={(ch?.counts ?? []).map(String)} show={(n) => `${n}x`} onChange={(n) => set({ count: Number(n) })} />
      <Pill label="Ảnh hay video trên node" value={c.kind} options={defaultCombo('video') ? ['image', 'video'] : ['image']} show={(k) => (k === 'video' ? 'Video' : 'Ảnh')} onChange={(k) => patch(id, { combo: k === 'video' ? defaultCombo('video') : undefined })} />
      <Pill label="Mô hình trên node" value={c.model} options={all.map((x) => x.model)} onChange={(model) => set({ model })} />
      <Pill label="Tỉ lệ trên node" value={c.aspect} options={ch?.aspects ?? []} onChange={(aspect) => set({ aspect })} />
    </div>
  )
}

function Box({ id, type, data }: NodeProps<WNode>): React.JSX.Element {
  const t = useContext(Ctx)
  const r = t.run?.nodes[id], live = type === 'csv' && data.rows ? fillRows(data.text ?? '', data.rows) : null // a Bảng CSV says at once which row cannot become a prompt
  const err = t.errs[id] ?? (live && 'error' in live ? csvMsg(live.error) : undefined) ?? (r?.code ? why(r.code) : undefined)
  const gen = type === 'generate', title = gen ? genTitle(data) : TITLE[type], [aw, ah] = gen ? ratio(data) : [1, 1]
  const hasText = type === 'text' || type === 'note' || type === 'csv', running = r?.state === 'running'
  const inp = IN[type], out = type === 'text' || type === 'csv' || type === 'image' || gen || type === 'loop' || type === 'frame'
  return (
    <div className="wf-node" data-testid={`wf-${type}`} data-kind={type} data-state={err && !r ? 'failed' : r?.state} data-media={gen || undefined} style={gen ? { width: aw > ah ? 320 : 260 } : undefined}>
      <div className="wf-tools" role="toolbar" aria-label={`Thao tác với node ${title}`}>
        <button className="nodrag" aria-label={`Cài đặt node ${title}`} data-tip="Cài đặt" onClick={() => t.cfg(id)}><Icon name="gear" /></button>
        <button className="nodrag" aria-label={`Nhân bản node ${title}`} data-tip="Nhân bản" onClick={() => t.dup(id)}><Icon name="copy" /></button>
        {hasText && <button className="nodrag" aria-label={`Sao chép chữ của node ${title}`} data-tip="Sao chép chữ" onClick={() => t.copy(id)}><Icon name="clip" /></button>}
        <button className="nodrag danger" aria-label={`Xoá node ${TITLE[type]}`} data-tip="Xoá" onClick={() => t.del(id)}><Icon name="trash" /></button>
      </div>
      <header><Icon name={gen && isVideo(data) ? 'video' : ICON[type]} /><b>{title}</b>{r && <Chip tone={STATE[r.state]?.[0] ?? 'idle'}>{chip(r)}</Chip>}</header>
      {t.order[id] ? <span className="wf-order" title={`Bước ${t.order[id]} khi chạy`}>{t.order[id]}</span> : null}
      {(type === 'text' || type === 'note') && (
        <textarea className="nodrag nowheel" spellCheck={false} rows={type === 'text' ? 5 : 3} aria-label={type === 'text' ? 'Prompt của node Text' : 'Nội dung ghi chú'} placeholder={type === 'text' ? 'Mỗi dòng là một prompt. Dùng {tên biến} cho phần lặp lại' : 'Ghi chú cho mình, app không gửi đi'}
          value={data.text ?? ''} onChange={(e) => t.patch(id, { text: e.target.value })} />
      )}
      {type === 'image' && (
        <>
          {(data.assets ?? []).map((a) => <div key={a.id} className="wf-file">{a.missing ? 'Không còn file này' : a.name}</div>)}
          <button className="small nodrag" onClick={() => t.pick(id)}>{data.assets?.length ? 'Chọn lại ảnh' : 'Chọn ảnh'}</button>
        </>
      )}
      {gen && (
        <>
          <div className="wf-media" style={{ aspectRatio: `${aw} / ${ah}` }}>
            {r?.thumb ? <Thumb attemptId={r.thumb.attemptId} media={r.thumb.mediaId} saved /> : <Icon name={isVideo(data) ? 'video' : 'image'} size={40} />}
            <p className="wf-overlay">{t.prompt(id) || 'Chưa có prompt: nối một node Text vào chấm bên trái'}</p>
            {running && <Loading text={phase(r, t.manual && !data.site)} />}
          </div>
          {err && <p className="wf-err" role="alert">{err}</p>}
          <Pills id={id} d={data} />
          <div className="wf-brand"><span className="wf-prov" data-site={data.site ?? 'flow'}>{SITE_NAME[data.site ?? 'flow']}</span>
            <span className="wf-combo" data-testid="wf-combo">{data.site ? `${SITE_LABEL[data.site]}${data.model ? ` · ${data.model}` : ''}${data.aspect ? ` · ${data.aspect}` : ''}` : `${isVideo(data) ? 'Video · ' : ''}${comboLabel(data.combo ?? DEFAULT)}`}</span></div>
        </>
      )}
      {type === 'download' && <p className="hint">Lưu kết quả của node nối vào đây về thư mục Downloads/ToolFlow.</p>}
      {type === 'loop' && <p className="hint">Chạy lại node Tạo ảnh nối vào, tổng cộng {data.rounds} vòng. Mỗi vòng dùng ảnh của vòng trước làm ảnh tham chiếu.</p>}
      {type === 'frame' && <p className="hint">Khung hình cuối của mỗi video nối vào thành khung hình đầu cho node Tạo video phía sau.</p>}
      {type === 'merge' && (
        <>
          <p className="hint">Ghép các video nối vào thành một file MP4, theo thứ tự dây nối.</p>
          {r?.file && <div className="wf-row"><span className="wf-file">{r.file}</span><button className="small nodrag" onClick={() => t.reveal(id)}><Icon name="folder" />Mở thư mục</button></div>}
        </>
      )}
      {(type === 'loop' || type === 'merge') && running && <Loading text={type === 'merge' ? 'Đang ghép video' : phase(r, t.manual)} />}
      {type === 'csv' && (
        <>
          <p className="hint" data-testid="wf-csv-info">{live && 'prompts' in live ? `${live.prompts.length} prompt · cột: ${cols(data)}` : data.rows ? `Cột: ${cols(data)}` : 'Mỗi dòng của file thành một prompt.'}</p>
          <CsvButton id={id} has={!!data.rows} />
          <textarea className="nodrag nowheel" spellCheck={false} rows={2} aria-label="Mẫu prompt của node Bảng CSV" placeholder="Ví dụ: {Tên} đứng ở {Nơi}" value={data.text ?? ''} onChange={(e) => t.patch(id, { text: e.target.value })} />
        </>
      )}
      {type === 'branch' && (
        <>
          <p className="hint">Xét node Tạo ảnh nối vào bên trái, rồi chạy tiếp một trong hai nhánh:</p>
          <div className="wf-port">{COND[data.cond ?? 'all'].yes}<Port side="source" kind="image" node={id} id="ok" label={COND[data.cond ?? 'all'].yes} /></div>
          <div className="wf-port">{COND[data.cond ?? 'all'].no}<Port side="source" kind="image" node={id} id="fail" label={COND[data.cond ?? 'all'].no} /></div>
        </>
      )}
      {!gen && err && <p className="wf-err" role="alert">{err}</p>}
      {inp && <Port side="target" kind={inp} node={id} label="Đầu vào" />}
      {out && <Port side="source" kind={outPort(type, data)} node={id} label={outLabel(type, data)} />}
    </div>
  )
}
const NODE_TYPES = { text: Box, image: Box, generate: Box, download: Box, note: Box, branch: Box, loop: Box, csv: Box, frame: Box, merge: Box }
/** A wire is a 4 px bezier in its source's colour; into a running node it also carries a moving white dash (CSS, off for reduced motion). */
function Wire(p: EdgeProps): React.JSX.Element {
  const [d] = getBezierPath(p)
  return <><BaseEdge id={p.id} path={d} style={p.style} interactionWidth={p.interactionWidth} /><path d={d} className="wf-flow" /></>
}
const EDGE_TYPES = { default: Wire }

/** The form of a Tạo ảnh node, floating under it: centred on the node, kept inside the canvas (Toby clamps the same way). */
function Popup({ id, children }: { id: string; children: React.ReactNode }): React.JSX.Element | null {
  const n = useInternalNode(id), { x, y, zoom } = useViewport(), W = useStore((s) => s.width), H = useStore((s) => s.height)
  if (!n) return null
  const p = n.internals.positionAbsolute, w = (n.measured.width ?? 0) * zoom, h = (n.measured.height ?? 0) * zoom
  const pw = Math.min(680, W - 72), left = Math.max(60, Math.min(x + p.x * zoom + w / 2 - pw / 2, W - pw - 12)) // 60: right of the tool column
  const top = Math.max(12, Math.min(y + p.y * zoom + h + 16 + 28 * zoom, H - 252)) // 28: the provider line under the node
  return <div className="wf-pop nokey nowheel" role="dialog" aria-label="Cài đặt node Tạo ảnh" style={{ left, top, width: pw, maxHeight: H - top - 12 }}>{children}</div>
}

type PickAt = { x: number; y: number; from?: { node: string; handle: string | null }; flow?: { x: number; y: number } } // x, y: in the canvas box; flow: where the block lands
function Picker({ at, kinds, hint, onPick, onClose, box }: { at: PickAt; kinds: Pick[]; hint?: PortKind; onPick(k: Pick): void; onClose(): void; box: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const [q, setQ] = useState(''), [i, setI] = useState(0)
  const list = PICKS.filter((p) => kinds.includes(p.k) && `${p.name} ${p.desc}`.toLowerCase().includes(q.trim().toLowerCase())), cur = Math.min(i, list.length - 1)
  const key = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(0, Math.min(list.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))) }
    else if (e.key === 'Enter' && list[cur]) { e.preventDefault(); onPick(list[cur].k) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
  return (
    <div className="wf-picker nokey nowheel" ref={box} role="dialog" aria-label="Thêm khối" style={{ left: at.x, top: at.y }} onKeyDown={key}>
      <div className="wf-pick-hint">{hint && <>Gợi ý cho cổng <span className={`wf-tag wf-h-${hint}`}>{PORT_NAME[hint]}</span></>}<button className="x" aria-label="Đóng hộp thêm khối" onClick={onClose}>×</button></div>
      <input autoFocus aria-label="Tìm khối" placeholder="Tìm khối…" role="combobox" aria-expanded aria-controls="wf-pick-list" aria-activedescendant={list[cur] ? `wf-pick-${list[cur].k}` : undefined} value={q} onChange={(e) => { setQ(e.target.value); setI(0) }} />
      <ul role="listbox" id="wf-pick-list" aria-label="Các khối">
        {list.map((p, j) => (
          <li key={p.k} id={`wf-pick-${p.k}`} role="option" aria-label={p.name} aria-selected={j === cur} draggable title="Bấm để thêm, hoặc kéo thả vào khung"
            onDragStart={(e) => e.dataTransfer.setData(DRAG, p.k)} onMouseEnter={() => setI(j)} onClick={() => onPick(p.k)}>
            <span className="wf-pick-ic"><Icon name={p.icon} size={18} /></span><span><b>{p.name}</b><small>{p.desc}</small></span>
          </li>
        ))}
      </ul>
      {!list.length && <p className="hint wf-pick-none">Không có khối nào khớp.</p>}
      <footer><span><kbd>↑↓</kbd> Chọn</span><span><kbd>Enter</kbd> Thêm</span><span><kbd>Esc</kbd> Đóng</span></footer>
    </div>
  )
}

// the canvas survives a visit to another screen: mid-run the user goes to Hàng đợi (or to Flow to click Gửi) and comes back
let keep: { nodes: WNode[]; edges: Edge[]; vars: Var[]; name: string; runId: string | null; hist?: { past: string[]; future: string[]; cur: string } } = { nodes: [], edges: [], vars: [], name: '', runId: null }

export default function Workflow({ s }: { s: Session }): React.JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<WNode>(keep.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(keep.edges)
  const [vars, setVars] = useState<Var[]>(keep.vars)
  const [name, setName] = useState(keep.name)
  const [panel, setPanel] = useState(true) // a 1000 px window leaves the canvas ~460 px with the panel open
  const [runId, setRunId] = useState(keep.runId)
  const [run, setRun] = useState<RunView | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Saved[]>([])
  const [mode, setMode] = useState<'auto' | 'manual'>(s.autoEnabled ? 'auto' : 'manual')
  const [msg, setMsg] = useState('')
  const [preview, setPreview] = useState<Plan | null>(null)
  const [picker, setPicker] = useState<PickAt | null>(null)
  const [wide, setWide] = useState<string | null>(null) // a Tạo ảnh node whose form was moved from the popup to the right panel
  const [tab, setTab] = useState<{ id: string; tab: 'cfg' | 'res' | 'help' } | null>(null)
  const rf = useRef<ReactFlowInstance<WNode, Edge> | null>(null)
  const wrap = useRef<HTMLDivElement>(null), pickBox = useRef<HTMLDivElement>(null), pointer = useRef<{ x: number; y: number } | null>(null)
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
  // shortcut: a Bảng CSV's rows are copied into every snapshot (up to 100); keep tables out of the snapshot if big CSVs make editing slow
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

  const call = (f: () => Promise<unknown>): void => { setMsg(''); void f().catch((e: Error) => setMsg(why(clean(e.message)))) }
  const typeOf = (id: string | null): string => nodes.find((n) => n.id === id)?.type ?? ''
  const table = Object.fromEntries(vars.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value]))
  /** What is saved, exported and undone: texts as written, with their {biến}. */
  const raw = (): { nodes: { id: string; type: Kind; x: number; y: number; text?: string; assetIds?: string[]; combo?: Combo; cond?: Cond; site?: Site; aspect?: string; model?: string; rounds?: number; rows?: string[][] }[]; edges: object[]; vars: Record<string, string> } => ({
    nodes: nodes.map((n) => ({ id: n.id, type: n.type!, x: n.position.x, y: n.position.y, ...(n.data.text !== undefined ? { text: n.data.text } : {}), ...(n.data.assets ? { assetIds: n.data.assets.map((a) => a.id) } : {}),
      ...(n.type === 'generate' && n.data.site ? { site: n.data.site, ...(n.data.site === 'gemini' && n.data.aspect ? { aspect: n.data.aspect } : {}), ...(n.data.site === 'gemini' && n.data.model ? { model: n.data.model } : {}) } : n.type === 'generate' && n.data.combo ? { combo: n.data.combo } : {}), ...(n.type === 'branch' && n.data.cond ? { cond: n.data.cond } : {}),
      ...(n.type === 'loop' ? { rounds: n.data.rounds ?? 2 } : {}), ...(n.type === 'csv' && n.data.rows ? { rows: n.data.rows } : {}) })),
    edges: edges.map((e) => ({ from: e.source, to: e.target, ...(e.sourceHandle ? { port: e.sourceHandle } : {}) })),
    vars: table,
  })
  /** What runs: every Text node with its variables filled in, every Bảng CSV with its template filled per row (one prompt per line); a variable without a value or a bad row is an error on that node. */
  const filled = (): { graph: object; errs: Record<string, string> } => {
    const g = raw(), bad: Record<string, string> = {}
    const out = g.nodes.map((n) => {
      if (n.type === 'csv') {
        const r = fillRows(n.text ?? '', n.rows ?? [])
        if ('error' in r) { bad[n.id] = csvMsg(r.error); return { ...n, text: '', rows: undefined } }
        return { ...n, text: r.prompts.join('\n'), rows: undefined } // main reads it like a Text node; the table itself is not needed to run
      }
      if (n.type !== 'text') return n
      const r = fillLines(n.text ?? '', table)
      if ('error' in r) { bad[n.id] = varErr(r.error); return n }
      return { ...n, text: r.prompts.join('\n') }
    })
    return { graph: { nodes: out, edges: g.edges }, errs: bad }
  }
  const fit = (): void => void setTimeout(() => void rf.current?.fitView(FIT), 50)
  const reset = (): void => { setRunId(null); setRun(null); setErrs({}); setMsg('') }
  const open = (w: Canvas | undefined): void => {
    reset()
    setName(w?.name ?? '')
    setVars(Object.entries(w?.vars ?? {}).map(([n, value]) => ({ name: n, value })))
    setNodes((w?.nodes ?? []).map((n) => ({ id: n.id, type: n.type, position: { x: n.x, y: n.y }, data: { ...(n.text !== undefined ? { text: n.text } : {}), ...(n.assets ? { assets: n.assets } : {}), ...(n.combo ? { combo: n.combo } : {}), ...(n.cond ? { cond: n.cond } : {}), ...(n.site ? { site: n.site } : {}), ...(n.aspect ? { aspect: n.aspect } : {}), ...(n.model ? { model: n.model } : {}), ...(n.rounds ? { rounds: n.rounds } : {}), ...(n.rows ? { rows: n.rows } : {}) } })))
    setEdges((w?.edges ?? []).map((e) => ({ id: `${e.from}>${e.to}`, source: e.from, target: e.to, ...(e.port ? { sourceHandle: e.port } : {}) })))
    fit()
  }
  const add = (type: Kind, data: Data = {}, at?: { x: number; y: number }): string => { // at: where the user dropped it
    const id = crypto.randomUUID()
    setNodes((ns) => [...ns, { id, type, position: at ?? place(type, ns), data }])
    if (!at) fit() // a new node must be on screen
    return id
  }
  const blank = (k: Pick): Data => (k === 'text' || k === 'note' || k === 'csv' ? { text: '' } : k === 'loop' ? { rounds: 2 } : k === 'video' ? { combo: defaultCombo('video') } : {})
  const addKind = (k: Pick, at?: { x: number; y: number }): string => add(k === 'video' ? 'generate' : k, blank(k), at)
  const starter = (): void => { // the chain most people start from, already wired
    const t = add('text', { text: '' }), g = add('generate'), d = add('download')
    setEdges([{ id: `${t}>${g}`, source: t, target: g }, { id: `${g}>${d}`, source: g, target: d }])
  }
  const select = (id: string | null): void => setNodes((ns) => ns.map((n) => (!!n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })))
  /** Tự sắp xếp: each node one column right of the furthest node wired into it, top to bottom as they were; notes stay put. */
  const arrange = (): void => {
    const lv = new Map(nodes.map((n) => [n.id, 0]))
    for (let k = 0; k < nodes.length; k++) for (const e of edges) lv.set(e.target, Math.max(lv.get(e.target) ?? 0, Math.min(nodes.length, (lv.get(e.source) ?? 0) + 1))) // capped: a cycle cannot run away
    const row = new Map<number, number>(), at = new Map<string, { x: number; y: number }>()
    for (const n of [...nodes].sort((a, b) => a.position.y - b.position.y)) if (n.type !== 'note') { const l = lv.get(n.id)!, r = row.get(l) ?? 0; row.set(l, r + 1); at.set(n.id, { x: l * COL, y: r * ROW }) }
    setNodes((ns) => ns.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)! } : n))) // the array keeps its order: only positions change
    fit()
  }
  /** Opens the block picker at a screen point; from: the output port it was opened from (the new block gets wired to it). */
  const openAt = (cx: number, cy: number, from?: PickAt['from'], flow?: PickAt['flow']): void => {
    const b = wrap.current?.getBoundingClientRect()
    if (!b || !rf.current) return
    setPicker({ x: Math.max(8, Math.min(cx - b.left, b.width - 328)), y: Math.max(8, Math.min(cy - b.top, b.height - 430)), from, flow: flow ?? rf.current.screenToFlowPosition({ x: cx, y: cy }) })
  }
  const openTool = (): void => { const b = wrap.current?.getBoundingClientRect(); if (b) setPicker({ x: 60, y: Math.max(8, Math.min(b.height / 2 - 200, b.height - 430)) }) } // next to the + button; the block goes where place() puts it
  const pickIt = (k: Pick, at?: { x: number; y: number }): void => {
    const p = picker
    setPicker(null)
    const id = addKind(k, at ?? p?.flow)
    if (p?.from) setEdges((es) => addEdge({ source: p.from!.node, sourceHandle: p.from!.handle, target: id, targetHandle: null }, es))
  }
  const fromNode = picker?.from ? nodes.find((n) => n.id === picker.from!.node) : undefined
  const pickable: Pick[] = fromNode ? PICKS.map((p) => p.k).filter((k) => (WIRES[fromNode.type!] ?? []).filter((x) => !isVideo(fromNode.data) || VIDEO_OUT.includes(x)).includes(k === 'video' ? 'generate' : k)) : PICKS.map((p) => p.k)

  const tools: Tools = {
    run, errs, order: {}, manual: mode === 'manual',
    prompt: (id) => edges.filter((e) => e.target === id).map((e) => nodes.find((n) => n.id === e.source)).filter((n) => n?.type === 'text' || n?.type === 'csv').map((n) => n!.data.text ?? '').join('\n').trim(),
    patch: (id, d) => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...d } } : n))),
    del: (id) => void rf.current?.deleteElements({ nodes: [{ id }] }),
    dup: (id) => { const n = nodes.find((x) => x.id === id); if (n) add(n.type!, JSON.parse(JSON.stringify(n.data)) as Data, { x: n.position.x + 40, y: n.position.y + 40 }) },
    copy: (id) => call(() => navigator.clipboard.writeText(nodes.find((n) => n.id === id)?.data.text ?? '').then(() => setMsg('Đã sao chép chữ của node'))),
    cfg: (id) => { select(id); setWide(id); setTab({ id, tab: 'cfg' }) },
    reveal: (id) => call(() => window.api.revealWorkflowFile({ runId, node: id })),
    port: (e, id, handle) => {
      e.stopPropagation()
      const b = (e.currentTarget as HTMLElement).getBoundingClientRect(), n = rf.current?.getInternalNode(id)
      openAt(b.right + 8, b.top, { node: id, handle: handle ?? null }, n && { x: n.internals.positionAbsolute.x + (n.measured.width ?? 260) + 140, y: n.internals.positionAbsolute.y }) // the new block one step to the right
    },
    pick: (id) => call(async () => {
      const p = await window.api.pickRefs() as { assets: PresetAsset[]; errors: unknown[] }
      if (p.assets.length) tools.patch(id, { assets: p.assets.slice(0, 10) })
      setMsg(p.errors.length ? `${p.errors.length} file không dùng được (chỉ nhận PNG, JPG, WEBP dưới 20 MB)` : p.assets.length > 10 ? 'Chỉ lấy 10 ảnh đầu' : '')
    }),
    csv: (id, f) => call(async () => { // read here: main never sees the file, only the table inside the node
      if (!f) return
      const r = readCsv(await f.arrayBuffer())
      if ('error' in r) return setErrs((e) => ({ ...e, [id]: csvMsg(r.error) }))
      setErrs(({ [id]: _, ...e }) => e)
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, rows: r.rows, text: n.data.text?.trim() ? n.data.text : `{${r.rows[0][0].trim()}}` } } : n))) // the first column, until the user writes a template
    }),
  }
  // the running order on each node (a badge), from the same plan main would run; nothing is sent
  for (const id of [...(preview?.steps ?? []).map((x) => x.node.split('#')[0]), ...(preview?.merges ?? []).map((m) => m.node)]) tools.order[id] ??= Object.keys(tools.order).length + 1
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
  const pop = sel?.type === 'generate' && wide !== sel.id ? sel : undefined // a Tạo ảnh node shows its form under itself
  const wires = picked.length ? [] : edges.filter((e) => e.selected) // a clicked wire lights up; the side panel then offers to remove it
  const side1 = (id: string, port?: string | null): string => `${TITLE[typeOf(id) as Kind] ?? '?'}${port ? ` (nhánh “${COND[nodes.find((n) => n.id === id)?.data.cond ?? 'all'][port === 'ok' ? 'yes' : 'no']}”)` : ''}`
  useEffect(() => { // what main would really send for every node (same plan as a run, nothing sent): the popup's list and the order badges
    if (!nodes.length) return setPreview(null)
    let live = true
    const t = setTimeout(() => void window.api.runWorkflow({ graph: filled().graph, mode, dryRun: true }).then((p: Plan) => { if (live) setPreview(p) }, () => { if (live) setPreview(null) }), 250)
    return () => { live = false; clearTimeout(t) }
  }, [snap, mode])
  useEffect(() => { // a click anywhere outside the picker closes it
    if (!picker) return
    const f = (e: PointerEvent): void => { if (!pickBox.current?.contains(e.target as HTMLElement)) setPicker(null) }
    window.addEventListener('pointerdown', f, true)
    return () => window.removeEventListener('pointerdown', f, true)
  }, [picker])
  const keyNow = useRef<(e: KeyboardEvent) => void>(() => {})
  keyNow.current = (e) => {
    const el = e.target as HTMLElement, typing = /^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName) || el.isContentEditable
    if (e.key === 'Escape' && (picker || pop)) { if (picker) setPicker(null); else select(null); return }
    if (typing) return // text boxes keep their own undo and letters
    const k = e.key.toLowerCase()
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) { e.preventDefault(); travel(k === 'z' && !e.shiftKey) }
    else if (k === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); const b = wrap.current?.getBoundingClientRect(), p = pointer.current; if (b) openAt(p?.x ?? b.left + b.width / 2 - 160, p?.y ?? b.top + b.height / 2 - 200) }
  }
  useEffect(() => {
    const f = (e: KeyboardEvent): void => keyNow.current(e)
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [])
  const running = run?.status === 'running' || (!!runId && !run)
  const id = saved.find((w) => w.name === name.trim())?.id
  const h = hist.current
  const missing = [...new Set(nodes.flatMap((n) => (n.type === 'text' ? varsOf(n.data.text ?? '') : [])))].filter((n) => !(n in table))
  const setVar = (i: number, p: Partial<Var>): void => setVars((vs) => vs.map((v, j) => (j === i ? { ...v, ...p } : v)))
  const shown = edges.map((e): Edge => { const src = nodes.find((n) => n.id === e.source); return { ...e, className: `wf-e-${src ? outPort(src.type!, src.data) : 'any'}${run?.nodes[e.target]?.state === 'running' ? ' wf-e-on' : ''}` } })
  const prog = run ? Object.entries(run.nodes).filter(([k]) => !k.includes('#')) : [], fin = prog.filter(([, n]) => n.state !== 'waiting' && n.state !== 'running').length

  /** The settings of a Tạo ảnh node and what it will send: in the popup under the node, or in the right panel. */
  const genForm = (n: WNode): React.JSX.Element => {
    const step = preview?.steps.find((x) => x.node === n.id), perr = preview?.errors.find((x) => x.node === n.id)
    const prompts = step ? step.prompts.split('\n').filter((l) => l.trim()) : []
    const bad = filled().errs, wired = edges.filter((e) => e.target === n.id).map((e) => bad[e.source]).filter(Boolean) // a wired Text whose variable has no value
    const cur = n.data.combo ?? DEFAULT
    return (
      <>
        <div className="wf-set" data-testid="wf-site">
          <Opt label="Nền tảng" value={n.data.site ?? 'flow'} options={['flow', 'chatgpt', 'gemini']} show={(v) => SITE_NAME[v]} onChange={(v) => tools.patch(n.id, { site: v === 'flow' ? undefined : (v as Site), combo: undefined, aspect: undefined, model: undefined })} />
          {n.data.site === 'gemini' && <Opt label="Mô hình" value={n.data.model ?? ''} options={['', ...GEM_MODELS]} show={(v) => v || 'Theo Gemini'} onChange={(v) => tools.patch(n.id, { model: v || undefined })} />}
          {n.data.site === 'gemini' && <Opt label="Tỉ lệ khung hình" value={n.data.aspect ?? ''} options={['', ...GEM_ASPECTS]} show={(v) => v || 'Theo Gemini'} onChange={(v) => tools.patch(n.id, { aspect: v || undefined })} />}
          {n.data.site && <p className="hint">Node này gửi vào tab {n.data.site === 'gemini' ? 'gemini.google.com' : 'chatgpt.com'} đang mở: mỗi prompt một ảnh, app tự gửi và tự lưu. Ảnh nối vào được dùng làm ảnh tham chiếu.</p>}
        </div>
        {!n.data.site && (
          <div className="wf-set" data-testid="wf-settings">
            <h4>Cài đặt tạo {cur.kind === 'video' ? 'video' : 'ảnh'}</h4>
            <Opt label="Loại kết quả" value={cur.kind} options={['image', 'video']} show={(k) => (k === 'video' ? 'Video' : 'Ảnh')} onChange={(k) => tools.patch(n.id, { combo: k === 'video' ? defaultCombo('video') : undefined })} />
            <ComboFields value={cur} onChange={(combo) => tools.patch(n.id, { combo })} />
            <p className="hint">{n.data.combo ? 'Node này dùng cài đặt riêng.' : 'Đang dùng cài đặt mặc định của app.'} Trước khi gửi, app tự chọn đúng các mục này trong Flow; Flow không nhận thì node dừng lại, không gửi bằng cài đặt khác.</p>
            {n.data.combo && <button className="small" onClick={() => tools.patch(n.id, { combo: undefined })}>Về mặc định</button>}
          </div>
        )}
        <div className="wf-preview" data-testid="wf-preview">
          <h4>Sẽ gửi {prompts.length} prompt</h4>
          <ol className="wf-prompts">{prompts.slice(0, 20).map((p, i) => <li key={i}>{p}</li>)}</ol>
          {prompts.length > 20 && <p className="hint">… và {prompts.length - 20} prompt nữa</p>}
          {step && <p className="hint">Mỗi prompt tạo {step.site ? 1 : (step.combo ?? DEFAULT).count} {step.kind === 'video' ? 'video' : 'ảnh'}, tổng cộng {prompts.length * (step.site ? 1 : (step.combo ?? DEFAULT).count)} {step.kind === 'video' ? 'video' : 'ảnh'}.{step.feeds && !step.site && (step.combo ?? DEFAULT).count > 1 ? ' Node phía sau chỉ lấy ảnh đầu tiên của mỗi prompt làm tham chiếu.' : ''}</p>}
          {step?.kind === 'video' && <p className="hint">Video bắt đầu từ ảnh nối vào (khung hình đầu): một ảnh thì dùng chung, nhiều ảnh thì mỗi prompt một ảnh theo thứ tự. Nối từ Khung cuối thì prompt thứ i bắt đầu từ khung cuối của video thứ i. Không nối ảnh thì tạo video từ chữ.</p>}
          {step && step.kind !== 'video' && <p className="hint">Ảnh tham chiếu cho mỗi prompt: {step.images.length} ảnh chọn sẵn{step.deps.some(carries) ? `, cộng ảnh kết quả của ${step.deps.filter(carries).length} node phía trước` : ''}.</p>}
          {step?.deps.filter((x) => x.port !== 'direct').map((x) => <p key={x.node + x.port} className="hint">{COND[x.cond ?? 'all'].when[x.port === 'ok' ? 0 : 1]}</p>)}
          {step && <p className="hint">{step.save || step.feeds ? 'Kết quả sẽ được tải về máy.' : 'Kết quả chưa tự tải về: nối sang node Tự tải về nếu muốn lưu.'}</p>}
          {[...wired, ...(perr ? [why(perr.code)] : [])].map((m) => <p key={m} className="wf-err" role="alert">{m}</p>)}
        </div>
      </>
    )
  }
  const config = (n: WNode): React.JSX.Element => {
    const t = n.type!, fill = t === 'text' ? fillLines(n.data.text ?? '', table) : null
    return (
      <>
        {t === 'generate' && (wide === n.id ? genForm(n) : <><p className="hint">Cài đặt của node này đang mở ngay dưới node trên khung.</p><button className="small" onClick={() => setWide(n.id)}><Icon name="expand" />Sửa ở bảng này</button></>)}
        {(t === 'text' || t === 'note') && <textarea aria-label={t === 'text' ? 'Prompt (bảng cấu hình)' : 'Ghi chú (bảng cấu hình)'} rows={10} value={n.data.text ?? ''} onChange={(e) => tools.patch(n.id, { text: e.target.value })} />}
        {fill && ('error' in fill ? <p className="wf-err" role="alert">{varErr(fill.error)}</p> : <p className="hint" data-testid="wf-count">{fill.prompts.length} prompt sau khi thay biến</p>)}
        {t === 'image' && (
          <>
            {(n.data.assets ?? []).map((a) => (
              <div key={a.id} className="wf-row"><span className="wf-file">{a.missing ? 'Không còn file này' : a.name}</span>
                <button className="x" aria-label={`Bỏ ảnh ${a.name}`} onClick={() => tools.patch(n.id, { assets: n.data.assets!.filter((x) => x.id !== a.id) })}>×</button></div>
            ))}
            <button className="small" onClick={() => tools.pick(n.id)}>{n.data.assets?.length ? 'Chọn lại ảnh' : 'Chọn ảnh'}</button>
            <p className="hint">Tối đa 10 ảnh. Mọi prompt của node Tạo ảnh nối vào đều dùng các ảnh này.</p>
          </>
        )}
        {t === 'download' && <p className="hint">Nối chấm bên phải của node Tạo ảnh vào node này để ảnh tự lưu về Downloads/ToolFlow khi tạo xong. Node này không có gì để chỉnh.</p>}
        {t === 'frame' && <p className="hint">Nối đúng một node Tạo video vào bên trái, và chấm bên phải sang node Tạo video của cảnh sau. Hai node video nên có cùng số prompt: prompt thứ i của cảnh sau bắt đầu từ khung cuối của video thứ i. Node này không có gì để chỉnh.</p>}
        {t === 'merge' && <p className="hint">Nối các node Tạo video vào bên trái theo thứ tự muốn ghép. Ghép video là bước cuối: chạy sau mọi node khác và tự lưu file ghep-video-….mp4 cạnh video đầu tiên. Node này không có gì để chỉnh.</p>}
        {t === 'loop' && (
          <>
            <label className="wf-set">Số vòng (2 đến 10)<input type="number" aria-label="Số vòng" min={2} max={10} value={n.data.rounds ?? 2} onChange={(e) => tools.patch(n.id, { rounds: Math.min(10, Math.max(2, Math.trunc(Number(e.target.value)) || 2)) })} /></label>
            <p className="hint" data-testid="wf-loop-help">Nối một node Tạo ảnh vào bên trái. Vòng 1 là chính node đó; mỗi vòng sau gửi lại đúng các prompt của nó, prompt nào cũng kèm ảnh của chính nó ở vòng trước làm ảnh tham chiếu. Nối chấm bên phải sang Tự tải về, Tạo ảnh hoặc Điều kiện: chúng nhận ảnh của vòng cuối. Mỗi vòng tốn credit như một lần chạy node đó.</p>
          </>
        )}
        {t === 'csv' && (() => {
          const fill = n.data.rows ? fillRows(n.data.text ?? '', n.data.rows) : null
          return (
            <>
              <CsvButton id={n.id} has={!!n.data.rows} />
              <p className="hint">File .csv lưu dạng UTF-8 (Excel: Lưu thành → CSV UTF-8). Dòng đầu là tên cột; mỗi dòng sau thành một prompt, dòng trống được bỏ qua.</p>
              {n.data.rows && <p className="hint">Các cột: {cols(n.data)}</p>}
              <textarea aria-label="Mẫu prompt (bảng cấu hình)" rows={4} value={n.data.text ?? ''} onChange={(e) => tools.patch(n.id, { text: e.target.value })} />
              {fill && ('error' in fill ? <p className="wf-err" role="alert">{csvMsg(fill.error)}</p> : <p className="hint" data-testid="wf-count">{fill.prompts.length} prompt từ bảng</p>)}
            </>
          )
        })()}
        {t === 'branch' && (
          <>
            <Opt label="Xét node Tạo ảnh phía trước theo điều kiện" value={n.data.cond ?? 'all'} options={Object.keys(COND)} show={(c) => COND[c as Cond].name} onChange={(c) => tools.patch(n.id, { cond: c === 'all' ? undefined : (c as Cond) })} />
            <p className="hint" data-testid="wf-cond-help">{COND[n.data.cond ?? 'all'].help}</p>
          </>
        )}
        <button className="small" onClick={() => tools.del(n.id)}><Icon name="trash" />Xoá node này</button>
      </>
    )
  }
  const results = (n: WNode): React.JSX.Element => {
    const r = run?.nodes[n.id]
    if (!r) return <p className="hint">Node này chưa chạy. Bấm Chạy workflow ở cột công cụ bên trái khung.</p>
    return (
      <>
        <Chip tone={STATE[r.state]?.[0] ?? 'idle'}>{chip(r)}</Chip>
        {r.total > 0 && <p className="hint">Đã xong {r.done}/{r.total} prompt.</p>}
        {r.thumb && <Thumb attemptId={r.thumb.attemptId} media={r.thumb.mediaId} saved />}
        {r.file && <div className="wf-row"><span className="wf-file">{r.file}</span><button className="small" onClick={() => tools.reveal(n.id)}><Icon name="folder" />Mở thư mục</button></div>}
        {r.code && <p className="wf-err" role="alert">{why(r.code)}</p>}
        <p className="hint">Từng lượt gửi và lý do lỗi xem ở màn Hàng đợi; mọi ảnh, video đã lưu xem ở màn Kết quả.</p>
      </>
    )
  }
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
        <p className="hint">Bấm vào một node trên khung để xem và sửa cấu hình của node đó ở đây (node Tạo ảnh mở cài đặt ngay dưới node).</p>
        <p className="hint" data-testid="wf-wire-hint">Muốn bỏ một dây nối: bấm vào dây (dây sáng lên) rồi bấm Xoá dây này ở đây, hoặc nhấn phím Delete.</p>
      </>
    )
    const t = sel.type!, cur = tab?.id === sel.id ? tab.tab : pop ? 'res' : 'cfg' // the popup already shows the settings, so its panel opens on the results
    return (
      <>
        <h3><Icon name={t === 'generate' && isVideo(sel.data) ? 'video' : ICON[t]} /> {t === 'generate' ? genTitle(sel.data) : TITLE[t]}</h3>
        <div className="wf-tabs" role="tablist" aria-label="Bảng của node">
          {([['cfg', 'Cấu hình'], ['res', 'Kết quả'], ['help', 'Trợ giúp']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={cur === k} onClick={() => setTab({ id: sel.id, tab: k })}>{l}</button>)}
        </div>
        {cur === 'cfg' ? config(sel) : cur === 'res' ? results(sel) : (
          <>
            <p className="hint">{HELP[t][0]}</p>
            <h4>Công thức mẫu</h4>
            <p className="wf-recipe">{HELP[t][1]}</p>
          </>
        )}
      </>
    )
  }

  return (
    <section className="wf" aria-label="Workflow">
      <header className="wf-head">
        <input className="wf-name" aria-label="Tên workflow" maxLength={60} placeholder="Tên workflow" value={name} onChange={(e) => setName(e.target.value)} />
        <select aria-label="Workflow đã lưu" value={id ?? ''} onChange={(e) => open(saved.find((w) => w.id === e.target.value))}>
          <option value="">{saved.length ? 'Mở workflow đã lưu…' : 'Chưa lưu workflow nào'}</option>
          {saved.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select aria-label="Mẫu có sẵn" value="" onChange={(e) => { const t = TEMPLATES.find((x) => x.name === e.target.value); if (t) { open(t); setMsg('Đã mở mẫu. Sửa prompt trong các ô Text rồi bấm Chạy workflow') } }}>
          <option value="">Mẫu có sẵn…</option>
          {TEMPLATES.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
        <span className="spacer" />
        <div className="wf-mode" role="radiogroup" aria-label="Cách gửi prompt">
          <label><input type="radio" name="wf-mode" checked={mode === 'auto'} disabled={!s.autoEnabled} onChange={() => setMode('auto')} />Tự động</label>
          <label><input type="radio" name="wf-mode" checked={mode === 'manual'} onChange={() => setMode('manual')} />Thủ công</label>
        </div>
        <button className="small" onClick={() => call(async () => { const w = await window.api.importWorkflow() as Canvas | null; if (w) { open(w); setMsg('Đã mở file. Bấm Lưu nếu muốn giữ trong app') } })}>Nhập file</button>
        <button className="small" disabled={!nodes.length} onClick={() => call(() => window.api.exportWorkflow({ name, graph: raw() }).then((r: { saved: boolean }) => setMsg(r.saved ? 'Đã xuất file' : '')))}>Xuất file</button>
        <button className="small" disabled={!id} onClick={() => call(() => window.api.deleteWorkflow(id).then(list).then(() => setMsg('Đã xoá bản lưu. Các node vẫn còn trên màn hình, bấm Lưu nếu muốn giữ lại')))}>Xoá</button>
        <button className="small" disabled={!nodes.length} onClick={() => open(undefined)}>Mới</button>
        <button className="primary small" disabled={!name.trim() || !nodes.length} onClick={() => call(() => window.api.saveWorkflow({ name, graph: raw() }).then(list).then(() => setMsg('Đã lưu')))}>Lưu</button>
        <button className="small" aria-pressed={!panel} onClick={() => { setPanel(!panel); fit() }}>{panel ? 'Ẩn bảng bên phải' : 'Hiện bảng bên phải'}</button>
      </header>
      <div className="wf-body">
        <div className="wf-center">
          <div className="wf-canvas" ref={wrap} onPointerMove={(e) => { pointer.current = { x: e.clientX, y: e.clientY } }} onPointerLeave={() => { pointer.current = null }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG)) e.preventDefault() }}
            onDrop={(e) => { const k = e.dataTransfer.getData(DRAG) as Pick; if (PICKS.some((p) => p.k === k) && rf.current) { e.preventDefault(); pickIt(k, rf.current.screenToFlowPosition({ x: e.clientX, y: e.clientY })) } }}>
            <Ctx.Provider value={tools}>
              <ReactFlow nodes={nodes} edges={shown} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onInit={(i) => { rf.current = i }}
                onConnect={(c: Connection) => setEdges((es) => addEdge(c, es))} connectOnClick={false}
                onConnectEnd={(e, c) => { // a wire let go on empty canvas: pick the block it should go to
                  if (c.isValid || c.fromHandle?.type !== 'source' || !c.fromNode || !(e.target as HTMLElement).classList?.contains('react-flow__pane')) return
                  const pt = 'changedTouches' in e ? e.changedTouches[0] : e, f = rf.current!.screenToFlowPosition({ x: pt.clientX, y: pt.clientY })
                  openAt(pt.clientX, pt.clientY, { node: c.fromNode.id, handle: c.fromHandle.id ?? null }, { x: f.x + 50, y: f.y - 40 })
                }}
                onPaneContextMenu={(e) => { e.preventDefault(); openAt(e.clientX, e.clientY) }}
                isValidConnection={(c) => c.source !== c.target && !!WIRES[typeOf(c.source)]?.includes(typeOf(c.target) as Kind) && !(ONE_IN.includes(typeOf(c.target) as Kind) && edges.some((e) => e.target === c.target))}
                fitView fitViewOptions={FIT} minZoom={0.2} deleteKeyCode={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }} ariaLabelConfig={ARIA}>
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} />
                <Controls showInteractive={false} showFitView={false} orientation="horizontal" />
                {pop && <Popup id={pop.id}>
                  <div className="wf-pop-head"><Icon name={isVideo(pop.data) ? 'video' : 'layers'} /><b>{genTitle(pop.data)}</b>
                    <button className="x" aria-label="Mở rộng sang bảng bên phải" title="Mở rộng sang bảng bên phải" onClick={() => setWide(pop.id)}><Icon name="expand" /></button></div>
                  {genForm(pop)}
                </Popup>}
              </ReactFlow>
            </Ctx.Provider>
            <div className="wf-toolbar" role="toolbar" aria-label="Công cụ khung workflow" aria-orientation="vertical">
              <button className="add" aria-label="Thêm khối" data-tip="Thêm khối (N)" aria-expanded={!!picker} onClick={() => (picker ? setPicker(null) : openTool())}><Icon name="plus" size={18} /></button>
              <hr />
              <button aria-label="Thêm ghi chú" data-tip="Thêm ghi chú" onClick={() => void addKind('note')}><Icon name="note" size={18} /></button>
              <hr />
              {running
                ? <button className="stop" aria-label="Dừng workflow" data-tip="Dừng workflow" onClick={() => call(() => window.api.stopWorkflow(runId))}><Icon name="stop" size={18} /></button>
                : <button className="go" aria-label="Chạy workflow" data-tip="Chạy workflow" disabled={!nodes.length} onClick={start}><Icon name="play" size={18} /></button>}
              <hr />
              <button aria-label="Hoàn tác" data-tip="Hoàn tác (Ctrl+Z)" disabled={!h.past.length && snap === h.cur} onClick={() => travel(true)}><Icon name="undo" size={18} /></button>
              <button aria-label="Làm lại" data-tip="Làm lại (Ctrl+Y)" disabled={!h.future.length || snap !== h.cur} onClick={() => travel(false)}><Icon name="redo" size={18} /></button>
              <hr />
              <button aria-label="Căn giữa" data-tip="Căn giữa" disabled={!nodes.length} onClick={() => void rf.current?.fitView(FIT)}><Icon name="focus" size={18} /></button>
              <button aria-label="Tự sắp xếp" data-tip="Tự sắp xếp" disabled={!nodes.length} onClick={arrange}><Icon name="layout" size={18} /></button>
            </div>
            {running && prog.length > 0 && <div className="wf-prog" aria-label="Tiến độ chạy"><span className="num">{fin} / {prog.length}</span><i><b style={{ width: `${(fin / prog.length) * 100}%` }} /></i></div>}
            {picker && <Picker at={picker} box={pickBox} kinds={pickable} hint={fromNode && outPort(fromNode.type!, fromNode.data)} onPick={(k) => pickIt(k)} onClose={() => setPicker(null)} />}
            {!nodes.length && (
              <div className="wf-empty">
                <p>Mỗi khối là một bước. Bấm + (hoặc phím N, hoặc chuột phải vào nền) để thêm khối. Kéo từ chấm tròn bên phải của khối này sang chấm bên trái của khối kia để nối; thả dây ra chỗ trống hoặc bấm vào chấm bên phải để chọn khối nối tiếp.</p>
                <button className="primary" onClick={starter}>Tạo chuỗi mẫu: Text → Tạo ảnh → Tự tải về</button>
              </div>
            )}
          </div>
          <p className="wf-foot" role="status" data-testid="wf-status">
            {msg || (run ? { running: 'Đang chạy, theo dõi từng lượt ở Hàng đợi', done: 'Workflow đã chạy xong', failed: 'Workflow chạy xong, có node lỗi (xem dòng đỏ)', stopped: 'Workflow đã dừng' }[run.status] : !s.autoEnabled ? 'Tự bấm đang tắt (bật ở Cài đặt): bạn bấm Gửi trong Flow cho từng prompt' : '')}
          </p>
        </div>
        <aside className="wf-side nokey" aria-label="Cấu hình" hidden={!panel}>{side()}</aside>
      </div>
    </section>
  )
}
