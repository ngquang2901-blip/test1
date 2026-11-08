import { useState } from 'react'
import { ACTIVE, BATCH_LABEL, KIND_LABEL, MODE_LABEL, current, itemLabel, time, type Attempt, type Batch } from '../types'

const reasons = (a: Attempt): string => [a.error?.code, a.error?.why, ...(a.error?.reasons ?? [])].filter(Boolean).join(' · ')
const run = (f: () => Promise<unknown>): void => void f().catch((e: Error) => alert(e.message))

function Uncertain({ a }: { a: Attempt }): React.JSX.Element {
  return (
    <div>
      <div>Lý do: {reasons(a) || 'không rõ'}</div>
      <div>{a.reconcileAt ? `Đối soát lúc ${time(a.reconcileAt)}` : 'Đã đối soát nhưng chưa thấy kết quả — cần bạn xác nhận'}</div>
      <button onClick={() => run(() => window.api.confirmUncertain({ attemptId: a.id, to: 'sent' }))}>Đã gửi</button>{' '}
      <button onClick={() => run(() => window.api.confirmUncertain({ attemptId: a.id, to: 'not_sent' }))}>Chưa gửi</button>{' '}
    </div>
  )
}

/** Inline two-step confirm (no window.confirm): the first button asks, the second does it; both are plain buttons, so the keyboard reaches them. */
function TwoStep({ label, ask, yes, go }: { label: string; ask: string; yes: string; go: () => void }): React.JSX.Element {
  const [on, setOn] = useState(false)
  if (!on) return <button onClick={() => setOn(true)}>{label}</button>
  return (
    <span role="group" aria-label={ask}>
      <span>{ask}</span>{' '}
      <button autoFocus onClick={() => { setOn(false); go() }}>{yes}</button>{' '}
      <button onClick={() => setOn(false)}>Huỷ</button>
    </span>
  )
}

export default function Queue({ batches }: { batches: Batch[] }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  if (!batches.length) return <p>Chưa có lô nào.</p>
  return (
    <section aria-label="Hàng đợi">
      <h2>Hàng đợi</h2>
      {batches.map((b) => (
        <div key={b.id}>
          <h3>Lô {b.id.slice(0, 8)} · {KIND_LABEL[b.kind]} · {BATCH_LABEL[b.status]}{b.archived ? ' · đã lưu hồ sơ' : ''}</h3>
          <button onClick={() => setOpen(open === b.id ? null : b.id)} aria-expanded={open === b.id}>Chi tiết</button>
          <table>
            <thead><tr><th>#</th><th>prompt</th><th>trạng thái</th></tr></thead>
            <tbody>
              {b.items.map((it) => {
                const a = current(it)
                return (
                  <tr key={it.id} data-testid="item">
                    <td>{it.ord + 1}</td><td>{it.prompt}</td>
                    <td>
                      {itemLabel(a)}{a.item === 'failed' && a.error?.code ? ` (${reasons(a)})` : ''}
                      {a.item === 'needs_review' && a.stage === 'uncertain' && (
                        <>
                          <Uncertain a={a} />
                          <TwoStep label="Lưu hồ sơ chưa rõ" ask="Chắc chắn lưu hồ sơ?" yes="Có, lưu hồ sơ" go={() => run(() => window.api.archiveBatch({ batchId: b.id, confirm: true }))} />
                        </>
                      )}
                      {a.item === 'failed' && a.error?.resolution && ( // R30: the user settled it as not sent; a new paid copy needs a second click
                        <TwoStep label="Chạy lại (tốn credit)" ask="Chạy lại sẽ gửi prompt này lần nữa và tốn thêm credit. Chắc chắn?" yes="Có, chạy lại" go={() => run(() => window.api.rerun({ attemptId: a.id, confirmCost: true }))} />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {open === b.id && <Detail b={b} />}
        </div>
      ))}
    </section>
  )
}

function Detail({ b }: { b: Batch }): React.JSX.Element {
  return (
    <div data-testid="detail" className="box">
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
