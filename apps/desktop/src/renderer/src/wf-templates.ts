// Ready-made workflows the user can open from the Workflow bar and then edit. Each one must pass main's own check (parseGraph + plan):
// test/wf-templates.test.ts runs them through it, so a template can never be a graph the app refuses to run.
import flow from '../../../profiles/flow.json'

type Combo = { kind: 'image' | 'video'; mode: string; model: string; aspect: string; quality?: string; count: number }

type Node = { id: string; type: 'text' | 'generate' | 'download' | 'note' | 'branch' | 'loop'; x: number; y: number; text?: string; combo?: Combo; cond?: 'all' | 'any' | 'filtered'; rounds?: number }
export type Template = { name: string; nodes: Node[]; edges: { from: string; to: string; port?: string }[] }
const VIDEO = (flow.combos as Combo[]).find((c) => c.kind === 'video') // the app's default video settings (same rule as combo.tsx; not imported: this file is also read by the node-side test)
const video = VIDEO ? { combo: VIDEO } : {}

export const TEMPLATES: Template[] = [
  {
    name: 'Ảnh hàng loạt từ danh sách prompt',
    nodes: [
      { id: 't', type: 'text', x: 0, y: 0, text: 'một con mèo cam nằm trên bậu cửa sổ, nắng sớm, ảnh đời thường\nmột chiếc xe đạp cũ dựng cạnh tường vàng, trời chiều, ảnh đời thường' },
      { id: 'g', type: 'generate', x: 340, y: 0 }, { id: 'd', type: 'download', x: 680, y: 0 },
    ],
    edges: [{ from: 't', to: 'g' }, { from: 'g', to: 'd' }],
  },
  {
    name: 'Nhân vật trước, cảnh sau (giữ đúng nhân vật)',
    nodes: [
      { id: 't1', type: 'text', x: 0, y: 0, text: 'một cô gái tóc ngắn mặc áo khoác xanh, đứng thẳng, nền trơn, ảnh chân dung rõ mặt' },
      { id: 'g1', type: 'generate', x: 340, y: 0 },
      { id: 't2', type: 'text', x: 340, y: 300, text: 'cùng nhân vật trong ảnh tham chiếu đang ngồi uống cà phê ở quán vỉa hè, ảnh đời thường' },
      { id: 'g2', type: 'generate', x: 680, y: 150 }, { id: 'd', type: 'download', x: 1020, y: 150 },
      { id: 'n', type: 'note', x: 0, y: 300, text: 'Ảnh nhân vật ở bước 1 tự thành ảnh tham chiếu cho bước 2.' },
    ],
    edges: [{ from: 't1', to: 'g1' }, { from: 'g1', to: 'g2' }, { from: 't2', to: 'g2' }, { from: 'g2', to: 'd' }],
  },
  {
    name: 'Tạo ảnh rồi làm video từ ảnh đó',
    nodes: [
      { id: 't1', type: 'text', x: 0, y: 0, text: 'một chiếc thuyền giấy đỏ trên mặt hồ phẳng lặng, nắng sớm' },
      { id: 'g1', type: 'generate', x: 340, y: 0 },
      { id: 't2', type: 'text', x: 340, y: 300, text: 'chiếc thuyền trôi chậm sang phải, mặt nước gợn nhẹ, máy quay đứng yên' },
      { id: 'v', type: 'generate', x: 680, y: 150, ...video }, { id: 'd', type: 'download', x: 1020, y: 150 },
      { id: 'n', type: 'note', x: 0, y: 300, text: 'Ảnh ở bước 1 là khung hình đầu của video. Số prompt ở hai ô Text phải bằng nhau (hoặc bước 1 chỉ có 1 prompt).' },
    ],
    edges: [{ from: 't1', to: 'g1' }, { from: 'g1', to: 'v' }, { from: 't2', to: 'v' }, { from: 'v', to: 'd' }],
  },
  {
    name: 'Video từ chữ',
    nodes: [
      { id: 't', type: 'text', x: 0, y: 0, text: 'một ngọn nến cháy lung linh trên bàn gỗ trong phòng tối, máy quay đứng yên' },
      { id: 'v', type: 'generate', x: 340, y: 0, ...video }, { id: 'd', type: 'download', x: 680, y: 0 },
    ],
    edges: [{ from: 't', to: 'v' }, { from: 'v', to: 'd' }],
  },
  {
    name: 'Prompt dự phòng khi bị Flow lọc',
    nodes: [
      { id: 't1', type: 'text', x: 0, y: 0, text: 'prompt chính của bạn' },
      { id: 'g1', type: 'generate', x: 340, y: 0 }, { id: 'b', type: 'branch', x: 680, y: 0, cond: 'filtered' },
      { id: 't2', type: 'text', x: 680, y: 320, text: 'prompt viết lại nhẹ hơn, dùng khi prompt chính bị từ chối' },
      { id: 'g2', type: 'generate', x: 1020, y: 160 }, { id: 'd', type: 'download', x: 1360, y: 0 },
    ],
    edges: [{ from: 't1', to: 'g1' }, { from: 'g1', to: 'b' }, { from: 'b', to: 'g2', port: 'ok' }, { from: 't2', to: 'g2' }, { from: 'g1', to: 'd' }, { from: 'g2', to: 'd' }],
  },
  {
    name: 'Ảnh tinh chỉnh 3 vòng',
    nodes: [
      { id: 't', type: 'text', x: 0, y: 0, text: 'chân dung một ông lão đánh cá, nếp nhăn rõ nét, ánh sáng tự nhiên, ảnh chụp chi tiết cao' },
      { id: 'g', type: 'generate', x: 340, y: 0 }, { id: 'l', type: 'loop', x: 680, y: 0, rounds: 3 }, { id: 'd', type: 'download', x: 1020, y: 0 },
      { id: 'n', type: 'note', x: 0, y: 300, text: 'Vòng 2 và 3 gửi lại đúng prompt này, kèm ảnh của vòng trước làm ảnh tham chiếu, để ảnh rõ và đẹp dần. Chỉ ảnh vòng cuối được tải về.' },
    ],
    edges: [{ from: 't', to: 'g' }, { from: 'g', to: 'l' }, { from: 'l', to: 'd' }],
  },
]
