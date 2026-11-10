import { useState } from 'react'
import { hintOf } from '../hints'
import { KIND_LABEL, current, type Batch, type Download } from '../types'
import { Chip, Icon, type Tone } from '../ui'

// AC-07: "Đã lưu" exists only for a completed row; every other state (and no row at all) says what it really is.
const LABEL: Record<Download['state'], string> = { intent: 'Đang tải', started: 'Đang tải', completed: 'Đã lưu', needs_review: 'Cần kiểm tra', failed: 'Lỗi tải' }
export const dlLabel = (d?: Download): string => (d ? LABEL[d.state] : 'Chưa tải')
const dlTone = (d?: Download): Tone => (!d ? 'idle' : d.state === 'completed' ? 'done' : d.state === 'failed' || d.state === 'needs_review' ? 'attn' : 'run')

export default function Results({ batches }: { batches: Batch[] }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const run = (f: () => Promise<unknown>): void => { setError(null); void f().catch((e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))) } // inline, never a blocking dialog
  const rows = batches.flatMap((b) => b.items.flatMap((it) => {
    const a = current(it)
    return a.outputs.map((m) => ({ key: `${it.id}:${m}`, batchId: b.id, attemptId: a.id, kind: b.kind, n: it.ord + 1, prompt: it.prompt, media: m, dl: a.downloads?.[m] }))
  }))
  const pending = [...new Set(rows.filter((r) => r.dl?.state !== 'completed').map((r) => r.batchId))]
  const saved = rows.filter((r) => r.dl?.state === 'completed').length
  return (
    <section aria-label="Kết quả">
      <div className="head">
        <h2>Kết quả</h2>
        <button className="primary" disabled={pending.length === 0} onClick={() => run(() => Promise.all(pending.map((id) => window.api.downloadBatch(id))))}><Icon name="download" />Tải tất cả kết quả</button>
      </div>
      <p className="muted"><span className="num">{saved}/{rows.length}</span> tệp đã nằm trong thư mục Downloads/ToolFlow</p>
      {error && <p className="notice" role="alert">Không tải được: {error}</p>}
      {rows.length === 0 ? <p className="empty">Chưa có kết quả. Ảnh và video Flow tạo xong cho các lô sẽ hiện ở đây để tải về máy.</p> : (
        <ul className="panel outputs">{rows.map((r) => (
          <li key={r.key} data-testid="output">
            <div className="what">
              <span>{r.prompt}</span>
              <span className="file">{KIND_LABEL[r.kind]} · dòng {r.n} · mã {r.media.slice(0, 8)}{r.dl?.state === 'completed' && r.dl.actualName && <> · {r.dl.actualName}</>}</span>
              {(r.dl?.state === 'failed' || r.dl?.state === 'needs_review') && hintOf(r.dl.errorCode) && <div className="hint" data-testid="hint">{hintOf(r.dl.errorCode)}</div>}
            </div>
            <div className="end">
              <Chip tone={dlTone(r.dl)}>{dlLabel(r.dl)}{(r.dl?.state === 'failed' || r.dl?.state === 'needs_review') && r.dl.errorCode ? ` (${r.dl.errorCode})` : ''}</Chip>
              {(r.dl?.state === 'failed' || r.dl?.state === 'needs_review') && <button className="small" onClick={() => run(() => window.api.retryDownload({ attemptId: r.attemptId, mediaId: r.media }))}>Thử lại</button>}
            </div>
          </li>
        ))}</ul>
      )}
    </section>
  )
}
