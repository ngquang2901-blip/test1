import { useEffect, useRef, useState } from 'react'
import { hintOf } from '../hints'
import { KIND_LABEL, current, type Batch, type Download, siteLabel } from '../types'
import { Chip, Icon, TwoStep, type Tone } from '../ui'

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
type Save = '' | 'saved' | 'unsaved' | 'error'
const saveOf = (d?: Download): Save => (d?.state === 'completed' ? 'saved' : d?.state === 'failed' || d?.state === 'needs_review' ? 'error' : 'unsaved')

export default function Results({ batches, q = '' }: { batches: Batch[]; q?: string }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const run = (f: () => Promise<unknown>, what = 'Không tải được'): void => { // inline, never a blocking dialog
    setError(null); setNote('')
    void f().catch((e: Error) => { const c = e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''); setError(`${what}: ${hintOf(c) ? `${hintOf(c)} (${c})` : c}`) })
  }
  const rows = batches.flatMap((b) => b.items.flatMap((it) => {
    const a = current(it)
    return a.outputs.map((m) => ({ key: `${a.id}:${m}`, batchId: b.id, attemptId: a.id, kind: b.kind, provider: b.provider ?? 'flow', n: it.ord + 1, prompt: it.prompt, media: m, dl: a.downloads?.[m], tags: a.tags?.[m] ?? [] }))
  }))
  const pending = [...new Set(rows.filter((r) => r.dl?.state !== 'completed').map((r) => r.batchId))]
  // filters work on the list already here (no new query per change); they combine with the top bar's search
  const [save, setSave] = useState<Save>('')
  const [site, setSite] = useState('')
  const [kind, setKind] = useState('')
  const [tag, setTag] = useState('')
  const tags = [...new Set([...rows.flatMap((r) => r.tags), ...(tag ? [tag] : [])])].sort((x, y) => x.localeCompare(y, 'vi'))
  const needle = q.trim().toLowerCase()
  const found = rows.filter((r) => (!needle || r.prompt.toLowerCase().includes(needle) || r.batchId.startsWith(needle)) && (!save || saveOf(r.dl) === save) && (!site || r.provider === site) && (!kind || r.kind === kind) && (!tag || r.tags.includes(tag)))
  const saved = found.filter((r) => r.dl?.state === 'completed').length
  // a long history is shown a page at a time (measured: 3000 cards took one 0.45 s block to draw); a search still looks through all of them
  const [limit, setLimit] = useState(PAGE)
  useEffect(() => setLimit(PAGE), [needle, save, site, kind, tag])
  const shown = found.slice(0, limit)
  // the selection only ever acts on what the filters show, so a hidden card is never deleted by surprise
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const chosen = found.filter((r) => picked.has(r.key))
  const toggle = (k: string): void => setPicked((s) => { const n = new Set(s); if (!n.delete(k)) n.add(k); return n })
  const ids = (list: typeof rows): { attemptId: string; mediaId: string }[] => list.map((r) => ({ attemptId: r.attemptId, mediaId: r.media }))
  const [tagText, setTagText] = useState('')
  const tagIt = (how: 'add' | 'remove'): void => run(() => window.api.tagOutputs({ outputs: ids(chosen), [how]: tagText.trim() }), how === 'add' ? 'Không gắn được thẻ' : 'Không gỡ được thẻ')
  const remove = (): void => run(async () => {
    const r = (await window.api.deleteOutputs({ outputs: ids(chosen), confirm: true })) as { deleted: number; trashed: number; missing: number; failed: number }
    setPicked(new Set())
    setNote(`Đã xoá ${r.deleted} kết quả khỏi màn này: ${r.trashed} tệp đã vào Thùng rác${r.missing ? `, ${r.missing} tệp không còn trên máy` : ''}.${r.failed ? ` ${r.failed} tệp không chuyển được vào Thùng rác nên vẫn giữ lại.` : ''}`)
  }, 'Không xoá được')
  const exportIt = (): void => run(async () => {
    const r = (await window.api.exportOutputs({ outputs: ids(chosen.length ? chosen : found) })) as { canceled?: boolean; copied: number; skipped: number; csv: string | null }
    if (r.canceled) return
    setNote(r.copied ? `Đã xuất ${r.copied} tệp và ${r.csv}${r.skipped ? `; bỏ qua ${r.skipped} kết quả chưa tải về máy` : ''}.` : `Không có tệp nào đã tải về máy để xuất (${r.skipped} kết quả chưa tải về).`)
  }, 'Không xuất được')
  return (
    <section aria-label="Kết quả">
      <div className="head">
        <h2>Kết quả</h2>
        <button className="primary" disabled={pending.length === 0} onClick={() => run(() => Promise.all(pending.map((id) => window.api.downloadBatch(id))))}><Icon name="download" />Tải tất cả kết quả</button>
      </div>
      <p className="muted"><span className="num">{saved}/{found.length}</span> tệp đã nằm trong thư mục Downloads/ToolFlow</p>
      {rows.length > 0 && (
        <div className="results-bar">
          <div className="toolbar" role="group" aria-label="Lọc kết quả">
            <select aria-label="Lọc theo trạng thái lưu" value={save} onChange={(e) => setSave(e.target.value as Save)}>
              <option value="">Mọi trạng thái</option><option value="saved">Đã tải về máy</option><option value="unsaved">Chưa tải về</option><option value="error">Lỗi khi tải</option>
            </select>
            <select aria-label="Lọc theo nền tảng" value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">Mọi nền tảng</option><option value="flow">Flow</option><option value="chatgpt">ChatGPT</option><option value="gemini">Gemini</option>
            </select>
            <select aria-label="Lọc theo loại" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Ảnh và video</option><option value="image">Ảnh</option><option value="video">Video</option>
            </select>
            <select aria-label="Lọc theo thẻ" value={tag} disabled={!tags.length} onChange={(e) => setTag(e.target.value)}>
              <option value="">Mọi thẻ</option>{tags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="toolbar">
            <button className="small" disabled={!found.length} onClick={() => setPicked(new Set(found.map((r) => r.key)))}>Chọn tất cả</button>
            <button className="small" disabled={!chosen.length} onClick={() => setPicked(new Set())}>Bỏ chọn</button>
            <span className="muted" data-testid="picked">Đã chọn <span className="num">{chosen.length}</span></span>
            <span className="spacer" />
            <button className="small" disabled={!found.length} title="Chép các tệp đã chọn (chưa chọn gì: mọi kết quả đang hiện theo bộ lọc) vào một thư mục, kèm bảng toolflow-export.csv" onClick={exportIt}>Xuất file</button>
          </div>
          {chosen.length > 0 && (
            <div className="toolbar">
              <input aria-label="Tên thẻ" list="tf-tags" maxLength={30} placeholder="Tên thẻ, ví dụ: bìa sách" value={tagText} onChange={(e) => setTagText(e.target.value)} />
              <datalist id="tf-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
              <button className="small" disabled={!tagText.trim()} onClick={() => tagIt('add')}>Gắn thẻ</button>
              <button className="small" disabled={!tagText.trim()} onClick={() => tagIt('remove')}>Gỡ thẻ</button>
              <span className="spacer" />
              <TwoStep label={`Xoá ${chosen.length} kết quả`} ask={`Xoá ${chosen.length} kết quả khỏi màn này? Tệp đã tải về sẽ vào Thùng rác của Windows (lấy lại được từ đó). Không có gì bị xoá trên Flow, ChatGPT hay Gemini.`} yes="Có, xoá" safeFocus go={remove} />
            </div>
          )}
        </div>
      )}
      {error && <p className="notice" role="alert">{error}</p>}
      {note && <p className="hint" role="status">{note}</p>}
      {rows.length === 0 ? <p className="empty">Chưa có kết quả. Ảnh và video tạo xong cho các lô sẽ hiện ở đây để tải về máy.</p>
        : found.length === 0 ? <p className="empty">Không có kết quả nào khớp {q ? `“${q}”` : 'bộ lọc đang chọn'}.</p> : (
          <ul className="gallery">{shown.map((r) => {
            const bad = r.dl?.state === 'failed' || r.dl?.state === 'needs_review'
            return (
              <li key={r.key} data-testid="output" data-picked={picked.has(r.key) || undefined}>
                <Thumb attemptId={r.attemptId} media={r.media} saved={r.dl?.state === 'completed'} />
                <div className="what">
                  <span className="prompt-line" title={r.prompt}>{r.prompt}</span>
                  <span className="file">{siteLabel(r.provider)}{KIND_LABEL[r.kind]} · lô {r.batchId.slice(0, 8)} · dòng {r.n}</span>
                  {r.dl?.state === 'completed' && r.dl.actualName && <span className="file name" title={r.dl.actualName}>{r.dl.actualName}</span>}
                  {r.tags.length > 0 && <span className="tags" data-testid="tags">{r.tags.map((t) => <span key={t} className="tag">{t}</span>)}</span>}
                  {bad && hintOf(r.dl?.errorCode, r.provider) && <div className="hint" data-testid="hint">{hintOf(r.dl?.errorCode, r.provider)}</div>}
                </div>
                <div className="end">
                  <input type="checkbox" aria-label="Chọn kết quả này" checked={picked.has(r.key)} onChange={() => toggle(r.key)} />
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
