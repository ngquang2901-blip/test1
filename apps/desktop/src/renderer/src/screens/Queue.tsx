import { useState } from 'react'
import { hintOf } from '../hints'
import { ACTIVE, BATCH_LABEL, KIND_LABEL, MODE_LABEL, current, itemLabel, time, type Attempt, type Batch, type Draft } from '../types'
import { Chip, Icon, itemTone } from '../ui'

const reasons = (a: Attempt): string => [a.error?.code, a.error?.why, ...(a.error?.reasons ?? [])].filter(Boolean).join(' · ')
const Hint = ({ a }: { a: Attempt }): React.JSX.Element | null => { const h = hintOf(a.error?.code); return h ? <div className="hint" data-testid="hint">{h}</div> : null } // what to do, next to the raw code
const run = (f: () => Promise<unknown>): void => void f().catch((e: Error) => alert(e.message))

function Uncertain({ a }: { a: Attempt }): React.JSX.Element {
  return (
    <div className="status">
      <div className="hint">Lý do: {reasons(a) || 'không rõ'}</div>
      <div className="hint">{a.reconcileAt ? `Đối soát lúc ${time(a.reconcileAt)}` : 'Đã đối soát nhưng chưa thấy kết quả — cần bạn xác nhận'}</div>
      <div className="toolbar">
        <button className="small" onClick={() => run(() => window.api.confirmUncertain({ attemptId: a.id, to: 'sent' }))}>Đã gửi</button>
        <button className="small" onClick={() => run(() => window.api.confirmUncertain({ attemptId: a.id, to: 'not_sent' }))}>Chưa gửi</button>
      </div>
    </div>
  )
}

/** Inline two-step confirm (no window.confirm): the first button asks, the second does it (a costly one focuses Huỷ, so a stray Enter never pays); both are plain buttons, so the keyboard reaches them. */
function TwoStep({ label, ask, yes, go, safeFocus }: { label: string; ask: string; yes: string; go: () => void; safeFocus?: boolean }): React.JSX.Element {
  const [on, setOn] = useState(false)
  if (!on) return <button className={safeFocus ? 'small danger' : 'small'} onClick={() => setOn(true)}>{label}</button>
  return (
    <span className="confirm" role="group" aria-label={ask}>
      <span>{ask}</span>
      <button className="small primary" autoFocus={!safeFocus} onClick={() => { setOn(false); go() }}>{yes}</button>
      <button className="small" autoFocus={safeFocus} onClick={() => setOn(false)}>Huỷ</button>
    </span>
  )
}

// AC-07: only when every output of the attempt is on disk; otherwise the item says what it is (ready = not downloaded yet)
const savedAll = (a: Attempt): boolean => a.item === 'ready' && a.outputs.length > 0 && a.outputs.every((m) => a.downloads?.[m]?.state === 'completed')

/** Asset ids of the items that stopped on REF_UPLOAD_UNCERTAIN, each once. */
const stuckRefs = (b: Batch): string[] => [...new Set(b.items.filter((it) => current(it).error?.code === 'REF_UPLOAD_UNCERTAIN').flatMap((it) => it.refs))]

/** One band for the single next thing the human has to do (wayfinding: only the decision ahead). */
function NextStep({ batches }: { batches: Batch[] }): React.JSX.Element | null {
  for (const tone of ['attn', 'wait'] as const) {
    for (const b of batches.filter((x) => !x.archived)) {
      const it = b.items.find((i) => itemTone(current(i)) === tone)
      if (!it) continue
      const a = current(it)
      const what = tone === 'wait' ? 'Mở tab Flow và bấm Gửi' : a.stage === 'uncertain' ? 'Xác nhận lượt này đã gửi hay chưa' : 'Xem lỗi và chọn cách xử lý'
      return <div className="band" data-tone={tone} role="status">{what} — lô {b.id.slice(0, 8)}, dòng {it.ord + 1}</div>
    }
  }
  return null
}

type Preset = { kind: Draft['kind']; mode: Draft['mode']; title: string; sub: string; art: 'wide' | 'hand' | 'video' }
const PRESETS: Preset[] = [
  { kind: 'image', mode: 'auto', title: 'Ảnh từ danh sách prompt', sub: 'App tự bấm Gửi từng dòng', art: 'wide' },
  { kind: 'image', mode: 'manual', title: 'Ảnh, tôi tự bấm Gửi', sub: 'App điền sẵn, bạn bấm trong Flow', art: 'hand' },
  { kind: 'video', mode: 'auto', title: 'Video từ prompt', sub: 'Cần tài khoản có credit video', art: 'video' },
]

/** Shortcuts into Tạo lô with the kind and mode already chosen (the owner's "Bắt đầu nhanh"). */
function QuickStart({ onStart }: { onStart: (p: Pick<Draft, 'kind' | 'mode'>) => void }): React.JSX.Element {
  return (
    <div className="quick">
      <p className="quick-title">Bắt đầu nhanh</p>
      <ul>{PRESETS.map((p) => (
        <li key={p.title}>
          <button className="card" onClick={() => onStart({ kind: p.kind, mode: p.mode })}>
            <span className="art" data-art={p.art} aria-hidden="true"><i /><i /><i /></span>
            <span className="card-title">{p.title}</span>
            <span className="muted small-text">{p.sub}</span>
          </button>
        </li>
      ))}</ul>
    </div>
  )
}

export default function Queue({ batches, q = '', onNew, onStart }: { batches: Batch[]; q?: string; onNew: () => void; onStart: (p: Pick<Draft, 'kind' | 'mode'>) => void }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const head = <div className="head"><h2>Hàng đợi</h2><button className="primary" onClick={onNew}><Icon name="plus" />Lô mới</button></div>
  const needle = q.trim().toLowerCase()
  const hit = (b: Batch, prompt: string): boolean => !needle || b.id.startsWith(needle) || prompt.toLowerCase().includes(needle)
  const shown = batches.filter((b) => b.items.some((it) => hit(b, it.prompt)))
  if (!batches.length) return (
    <section aria-label="Hàng đợi">
      {head}
      <QuickStart onStart={onStart} />
      <p className="empty">Chưa có lô nào. Vào <b>Tạo lô</b>, dán danh sách prompt rồi bấm <b>Tạo lô và chạy</b>; các lượt sẽ hiện ở đây.</p>
    </section>
  )
  return (
    <section aria-label="Hàng đợi">
      {head}
      <NextStep batches={batches} />
      {!needle && <QuickStart onStart={onStart} />}
      {shown.length === 0 && <p className="empty">Không có prompt hay lô nào khớp “{q}”.</p>}
      {shown.map((b) => {
        const done = b.items.filter((it) => current(it).item === 'ready').length
        return (
          <div key={b.id} className="batch">
            <div className="batch-head">
              <div>
                <h3>Lô {b.id.slice(0, 8)} · {KIND_LABEL[b.kind]} · {BATCH_LABEL[b.status]}{b.archived ? ' · đã lưu hồ sơ' : ''}</h3>
                <p className="muted">{b.items.length} prompt · {MODE_LABEL[b.settings.mode ?? 'auto']} · <span className="num">{done}/{b.items.length}</span> có kết quả</p>
              </div>
              <button onClick={() => setOpen(open === b.id ? null : b.id)} aria-expanded={open === b.id}>Chi tiết</button>
            </div>
            {b.status === 'paused' && (hintOf(b.pauseReason) || b.pauseReason === 'REF_UPLOAD_UNCERTAIN') && (
              <div className="status">
                {hintOf(b.pauseReason) && <p className="notice warn" role="status" data-testid="pause-reason">Lô tạm dừng: {hintOf(b.pauseReason)}</p>}
                {b.pauseReason === 'REF_UPLOAD_UNCERTAIN' && stuckRefs(b).map((id, k) => ( // the way out of a binding stuck in uploading/uncertain: Huỷ has the focus, so a stray Enter changes nothing
                  <div key={id}><TwoStep label={`Cho phép tải lại ảnh tham chiếu ${k + 1}`} ask="Xoá trạng thái tải lên cũ và cho phép tải lại ảnh này? Chỉ làm khi đã kiểm tra thư viện Flow không có ảnh này." yes="Có, cho phép tải lại" safeFocus go={() => run(() => window.api.resetAssetBinding({ assetId: id, confirm: true }))} /></div>
                ))}
              </div>
            )}
            <div className="table-box">
            <table>
              <thead><tr><th className="n">Số</th><th>Prompt</th><th className="st">Trạng thái</th></tr></thead>
              <tbody>
                {b.items.filter((it) => hit(b, it.prompt)).map((it) => {
                  const a = current(it)
                  const tone = itemTone(a)
                  return (
                    <tr key={it.id} data-testid="item" data-tone={tone}>
                      <td className="n">{it.ord + 1}</td>
                      <td className="prompt">{it.prompt}</td>
                      <td className="st">
                        <div className="status">
                          <div className="line">
                            <Chip tone={tone}>{savedAll(a) ? 'Có kết quả · đã lưu về máy' : itemLabel(a)}{a.item === 'failed' && a.error?.code ? ` (${reasons(a)})` : ''}</Chip>
                          </div>
                          {(a.item === 'failed' || a.item === 'needs_review') && <Hint a={a} />}
                          {a.item === 'needs_review' && a.stage === 'uncertain' && (
                            <>
                              <Uncertain a={a} />
                              <div><TwoStep label="Lưu hồ sơ chưa rõ" ask="Chắc chắn lưu hồ sơ?" yes="Có, lưu hồ sơ" go={() => run(() => window.api.archiveBatch({ batchId: b.id, confirm: true }))} /></div>
                            </>
                          )}
                          {a.item === 'failed' && a.error?.resolution && ( // R30: the user settled it as not sent; a new paid copy needs a second click
                            <div><TwoStep label="Chạy lại (tốn credit)" ask="Chạy lại sẽ gửi prompt này lần nữa và tốn thêm credit. Chắc chắn?" yes="Có, chạy lại" safeFocus go={() => run(() => window.api.rerun({ attemptId: a.id, confirmCost: true }))} /></div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {open === b.id && <Detail b={b} />}
            </div>
          </div>
        )
      })}
    </section>
  )
}

function Detail({ b }: { b: Batch }): React.JSX.Element {
  return (
    <div data-testid="detail" className="detail">
      <p>Loại: {KIND_LABEL[b.kind]} · Chế độ: {MODE_LABEL[b.settings.mode ?? 'auto']} · Tạo lúc {new Date(b.createdAt).toLocaleString('vi-VN')} · {ACTIVE.includes(b.status) ? 'đang hoạt động' : 'đã kết thúc'}</p>
      {b.items.map((it) => (
        <div key={it.id}>
          <h4>Dòng {it.ord + 1}: {it.prompt}</h4>
          {it.attempts.map((a) => (
            <div key={a.id}>
              Lượt {a.ordinal}: {itemLabel(a)}{a.error ? ` — lỗi ${reasons(a)}${a.error.resolution ? ` (${a.error.resolution})` : ''}` : ''}
              {a.profileVersion && ` · cấu hình ${a.profileVersion}`}
              {a.clickAt && ` · bấm gửi lúc ${time(a.clickAt)}`}
              <ul data-testid="journal">{a.journal.map((j, i) => <li key={i}>{time(j.at)} {j.type}</li>)}</ul>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
