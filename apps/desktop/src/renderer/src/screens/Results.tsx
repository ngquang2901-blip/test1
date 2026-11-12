import { useEffect, useRef, useState } from 'react'
import { hintOf } from '../hints'
import { KIND_LABEL, current, type Batch, type Download, siteLabel } from '../types'
import { Chip, Icon, type Tone } from '../ui'

// AC-07: "Đã lưu" exists only for a completed row; every other state (and no row at all) says what it really is.
const LABEL: Record<Download['state'], string> = { intent: 'Đang tải', started: 'Đang tải', completed: 'Đã lưu', needs_review: 'Cần kiểm tra', failed: 'Lỗi tải' }
export const dlLabel = (d?: Download): string => (d ? LABEL[d.state] : 'Chưa tải')
const dlTone = (d?: Download): Tone => (!d ? 'idle' : d.state === 'completed' ? 'done' : d.state === 'failed' || d.state === 'needs_review' ? 'attn' : 'run')

/** The saved file itself, read from disk by main; before it is saved there is nothing to show (the Flow URL never reaches the app). */
export function Thumb({ attemptId, media, saved }: { attemptId: string; media: string; saved: boolean }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const [video, setVideo] = useState(false)
  // asked for only once the card is near the visible part of the list: a long history does not decode every saved image at once
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (near || !box.current) return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setNear(true); io.disconnect() } }, { rootMargin: '600px' })
    io.observe(box.current)
    return () => io.disconnect()
  }, [near])
  useEffect(() => {
    if (!saved || !near) return
    let live = true
    window.api.previewOutput({ attemptId, mediaId: media }).then((r: { url: string | null; video?: boolean }) => { if (live) { setUrl(r.url); setVideo(!!r.video) } }, () => { if (live) setGone(true) })
    return () => { live = false }
  }, [attemptId, media, saved, near])
  const play = (): void => { window.api.previewOutput({ attemptId, mediaId: media, play: true }).then((r: { url: string | null }) => (r.url ? setUrl(r.url) : setGone(true)), () => setGone(true)) }
  if (video && url) return <div className="thumb"><video src={url} controls autoPlay loop /></div>
  return <div className="thumb" ref={box}>{url ? <img src={url} alt="" /> : <span>{gone ? 'Không thấy tệp trên máy' : video ? <>Video đã lưu <button className="small nodrag" onClick={play}>Xem video</button></> : saved ? '…' : 'Chưa tải về'}</span>}</div>
}

const PAGE = 120

export default function Results({ batches, q = '' }: { batches: Batch[]; q?: string }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const run = (f: () => Promise<unknown>): void => { setError(null); void f().catch((e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))) } // inline, never a blocking dialog
  const rows = batches.flatMap((b) => b.items.flatMap((it) => {
    const a = current(it)
    return a.outputs.map((m) => ({ key: `${it.id}:${m}`, batchId: b.id, attemptId: a.id, kind: b.kind, provider: b.provider, n: it.ord + 1, prompt: it.prompt, media: m, dl: a.downloads?.[m] }))
  }))
  const pending = [...new Set(rows.filter((r) => r.dl?.state !== 'completed').map((r) => r.batchId))]
  const saved = rows.filter((r) => r.dl?.state === 'completed').length
  const needle = q.trim().toLowerCase()
  const found = needle ? rows.filter((r) => r.prompt.toLowerCase().includes(needle) || r.batchId.startsWith(needle)) : rows
  // a long history is shown a page at a time (measured: 3000 cards took one 0.45 s block to draw); a search still looks through all of them
  const [limit, setLimit] = useState(PAGE)
  useEffect(() => setLimit(PAGE), [needle])
  const shown = found.slice(0, limit)
  return (
    <section aria-label="Kết quả">
      <div className="head">
        <h2>Kết quả</h2>
        <button className="primary" disabled={pending.length === 0} onClick={() => run(() => Promise.all(pending.map((id) => window.api.downloadBatch(id))))}><Icon name="download" />Tải tất cả kết quả</button>
      </div>
      <p className="muted"><span className="num">{saved}/{rows.length}</span> tệp đã nằm trong thư mục Downloads/ToolFlow</p>
      {error && <p className="notice" role="alert">Không tải được: {error}</p>}
      {rows.length === 0 ? <p className="empty">Chưa có kết quả. Ảnh và video tạo xong cho các lô sẽ hiện ở đây để tải về máy.</p>
        : found.length === 0 ? <p className="empty">Không có kết quả nào khớp “{q}”.</p> : (
          <ul className="gallery">{shown.map((r) => {
            const bad = r.dl?.state === 'failed' || r.dl?.state === 'needs_review'
            return (
              <li key={r.key} data-testid="output">
                <Thumb attemptId={r.attemptId} media={r.media} saved={r.dl?.state === 'completed'} />
                <div className="what">
                  <span className="prompt-line" title={r.prompt}>{r.prompt}</span>
                  <span className="file">{siteLabel(r.provider)}{KIND_LABEL[r.kind]} · lô {r.batchId.slice(0, 8)} · dòng {r.n}</span>
                  {r.dl?.state === 'completed' && r.dl.actualName && <span className="file name" title={r.dl.actualName}>{r.dl.actualName}</span>}
                  {bad && hintOf(r.dl?.errorCode, r.provider) && <div className="hint" data-testid="hint">{hintOf(r.dl?.errorCode, r.provider)}</div>}
                </div>
                <div className="end">
                  <Chip tone={dlTone(r.dl)}>{dlLabel(r.dl)}{bad && r.dl?.errorCode ? ` (${r.dl.errorCode})` : ''}</Chip>
                  {bad && <button className="small" onClick={() => run(() => window.api.retryDownload({ attemptId: r.attemptId, mediaId: r.media }))}>Thử lại</button>}
                  {r.dl?.state === 'completed' && <button className="small" onClick={() => run(() => window.api.revealOutput({ attemptId: r.attemptId, mediaId: r.media }))}>Mở thư mục</button>}
                </div>
              </li>
            )
          })}</ul>
        )}
      {found.length > shown.length && <button className="more" onClick={() => setLimit((n) => n + PAGE)}>Xem thêm (còn {found.length - shown.length})</button>}
    </section>
  )
}
