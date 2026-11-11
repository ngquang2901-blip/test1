export type Attempt = {
  id: string; ordinal: number; item: string; stage: string; clickAt: number | null; reconcileAt: number | null
  error: { code?: string; why?: string; reasons?: string[]; resolution?: string } | null
  profileVersion: string | null; outputs: string[]; journal: { type: string; at: number }[]
  downloads: Record<string, Download> // by output (media) id; absent = not requested yet
}
export type Download = { state: 'intent' | 'started' | 'completed' | 'failed' | 'needs_review'; actualName: string | null; errorCode: string | null }
export type Item = { id: string; ord: number; prompt: string; refs: string[]; attemptId: string; attempts: Attempt[] } // refs: asset ids
export type Batch = { pauseReason?: string | null; id: string; kind: 'image' | 'video'; status: string; archived: boolean; createdAt: number; settings: { mode?: string; split?: { part: number; of: number } }; project?: string | null; items: Item[] }
export type Draft = { text: string; kind: 'image' | 'video'; mode: 'auto' | 'manual'; speed: 'default' | 'fast' }
export type UpdateState = { state: 'off' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'; current: string; version?: string; percent?: number; code?: string }
export type PresetAsset = { id: string; name: string; bytes: number; missing?: boolean }
export type Preset = { id: string; name: string; kind: Draft['kind']; mode: Draft['mode']; combo?: import('./combo').Combo; refs: { assetIds: string[]; mode: 'none' | 'sequential' | 'all'; perItem: number; assets: PresetAsset[] }; template: { template: string; how: 'all' | 'zip'; lists: Record<string, string> } }
export type SessionTab = { tabId: string; projectId: string | null; email: string | null; active: boolean; status: 'ok' | 'no_project' | 'no_login'; granted: boolean }
export type Session = {
  extDir?: string | null; fake: boolean; connected: boolean | null; connectorError: string | null; speedInUse: { image: number; video: number; tabs: number }; tabs: SessionTab[]; email: string | null; accounts?: { email: string; auto: boolean }[]; draft: Draft; autoEnabled: boolean
  selfCheck: { ok: true } | { ok: false; code: string; reasons: string[] } | null
}

export const BATCH_LABEL: Record<string, string> = {
  queued: 'Đang chờ', running: 'Đang chạy', paused: 'Tạm dừng', needs_review: 'Cần xem lại',
  completed: 'Có kết quả (chưa tải)', partial_failed: 'Xong một phần', failed: 'Lỗi', stopped: 'Đã dừng'
}
export const ACTIVE = ['queued', 'running', 'paused', 'needs_review']
export const KIND_LABEL = { image: 'Ảnh', video: 'Video' }
export const MODE_LABEL: Record<string, string> = { auto: 'Tự động', manual: 'Thủ công' }

export function itemLabel(a: Attempt): string {
  if (a.item === 'needs_review') return a.stage === 'uncertain' ? 'Không rõ' : 'Cần xem lại'
  return ({ queued: 'Đang chờ', preparing: 'Đang chuẩn bị', submitting: 'Đang gửi', awaiting_user: 'Chờ bạn bấm Gửi', generating: 'Đang tạo', ready: 'Có kết quả (chưa tải)', failed: 'Lỗi', cancelled: 'Đã huỷ' } as Record<string, string>)[a.item] ?? a.item
}
export const time = (ms: number): string => new Date(ms).toLocaleTimeString('vi-VN')
export const current = (it: Item): Attempt => it.attempts.find((a) => a.id === it.attemptId) ?? it.attempts[it.attempts.length - 1]
