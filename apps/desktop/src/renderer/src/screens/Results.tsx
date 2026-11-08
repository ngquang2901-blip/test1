import { hintOf } from '../hints'
import { KIND_LABEL, current, type Batch, type Download } from '../types'

const run = (f: () => Promise<unknown>): void => void f().catch((e: Error) => alert(e.message))
// AC-07: "Đã lưu" exists only for a completed row; every other state (and no row at all) says what it really is.
const LABEL: Record<Download['state'], string> = { intent: 'Đang tải', started: 'Đang tải', completed: 'Đã lưu', needs_review: 'Cần kiểm tra', failed: 'Lỗi tải' }
export const dlLabel = (d?: Download): string => (d ? LABEL[d.state] : 'Chưa tải')

export default function Results({ batches }: { batches: Batch[] }): React.JSX.Element {
  const rows = batches.flatMap((b) => b.items.flatMap((it) => {
    const a = current(it)
    return a.outputs.map((m) => ({ key: `${it.id}:${m}`, batchId: b.id, attemptId: a.id, kind: b.kind, prompt: it.prompt, media: m, dl: a.downloads?.[m] }))
  }))
  const pending = [...new Set(rows.filter((r) => r.dl?.state !== 'completed').map((r) => r.batchId))]
  return (
    <section aria-label="Kết quả">
      <h2>Kết quả</h2>
      <button disabled={pending.length === 0} onClick={() => run(() => Promise.all(pending.map((id) => window.api.downloadBatch(id))))}>Tải tất cả kết quả</button>
      {rows.length === 0 ? <p>Chưa có kết quả.</p> : (
        <ul>{rows.map((r) => (
          <li key={r.key} data-testid="output">
            {KIND_LABEL[r.kind]} {r.media} — {r.prompt} — <strong>{dlLabel(r.dl)}</strong>
            {r.dl?.state === 'completed' && r.dl.actualName && <> · {r.dl.actualName}</>}
            {(r.dl?.state === 'failed' || r.dl?.state === 'needs_review') && (
              <>
                {r.dl.errorCode && <> ({r.dl.errorCode})</>} <button onClick={() => run(() => window.api.retryDownload({ attemptId: r.attemptId, mediaId: r.media }))}>Thử lại</button>
                {hintOf(r.dl.errorCode) && <div data-testid="hint">{hintOf(r.dl.errorCode)}</div>}
              </>
            )}
          </li>
        ))}</ul>
      )}
    </section>
  )
}
