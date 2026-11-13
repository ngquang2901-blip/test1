// Tổng quan: the home screen (owner's reference: "Promage" project dashboard). Every number comes from the batches and the
// session the app already has; nothing here is a placeholder.
import { ACTIVE, BATCH_LABEL, KIND_LABEL, current, itemLabel, siteLabel, type Batch, type Session } from '../types'
import { Icon, batchTone, itemTone, type Tone } from '../ui'

type Go = (screen: 'Tạo lô' | 'Hàng đợi' | 'Kết quả' | 'Kết nối') => void
const DAY = 86_400_000
const dayKey = (t: number): string => new Date(t).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
const PILL: Record<Tone, string> = { run: 'run', wait: 'wait', attn: 'attn', done: 'done', idle: 'idle' }

function Stat({ icon, tint, value, label, sub }: { icon: Parameters<typeof Icon>[0]['name']; tint: string; value: string; label: string; sub: string }): React.JSX.Element {
  return (
    <div className="ov-card ov-stat">
      <span className="ov-stat-icon" data-tint={tint}><Icon name={icon} size={18} /></span>
      <div className="ov-stat-label">{label}</div>
      <div className="ov-stat-value num">{value}</div>
      <div className="ov-stat-sub">{sub}</div>
    </div>
  )
}

/** A progress ring: share of a batch's prompts that have a result. */
function Ring({ pct }: { pct: number }): React.JSX.Element {
  const c = 2 * Math.PI * 15
  return (
    <span className="ov-ring" title={`${pct}%`}>
      <svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
        <circle cx="18" cy="18" r="15" className="ov-ring-bg" />
        <circle cx="18" cy="18" r="15" className="ov-ring-fg" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 18 18)" />
      </svg>
      <span className="num">{pct}%</span>
    </span>
  )
}

/** Half-circle gauge for the success rate, coloured from red (left) to green (right). */
function Gauge({ pct }: { pct: number | null }): React.JSX.Element {
  const L = Math.PI * 80
  return (
    <svg className="ov-gauge" viewBox="0 0 200 116" role="img" aria-label={pct === null ? 'Chưa có lượt nào xong' : `${pct}% lượt thành công`}>
      <defs><linearGradient id="ov-g" x1="0" x2="1"><stop offset="0" stopColor="#EE201C" /><stop offset=".5" stopColor="#DFA510" /><stop offset="1" stopColor="#1A932E" /></linearGradient></defs>
      <path d="M20 100a80 80 0 0 1 160 0" className="ov-gauge-bg" />
      <path d="M20 100a80 80 0 0 1 160 0" stroke="url(#ov-g)" className="ov-gauge-fg" strokeDasharray={`${((pct ?? 0) / 100) * L} ${L}`} />
      <text x="100" y="92" textAnchor="middle" className="ov-gauge-num">{pct === null ? '—' : `${pct}%`}</text>
      <text x="100" y="112" textAnchor="middle" className="ov-gauge-cap">thành công</text>
    </svg>
  )
}

export default function Overview({ batches, s, go }: { batches: Batch[]; s: Session | null; go: Go }): React.JSX.Element {
  const live = batches.filter((b) => !b.archived)
  const rows = live.flatMap((b) => b.items.map((it) => ({ b, it, a: current(it) })))
  const now = Date.now()
  const active = live.filter((b) => ACTIVE.includes(b.status))
  const waiting = rows.filter((r) => r.a.item === 'queued').length
  const outputs30 = rows.filter((r) => r.a.item === 'ready' && r.b.createdAt >= now - 30 * DAY).reduce((n, r) => n + r.a.outputs.length, 0)
  const needYou = rows.filter((r) => ['wait', 'attn'].includes(itemTone(r.a)))
  const credit = [...(s?.credits ?? [])].sort((x, y) => y.at - x.at)[0]
  const ok = rows.filter((r) => r.a.item === 'ready').length
  const bad = rows.filter((r) => r.a.item === 'failed').length
  const working = rows.filter((r) => itemTone(r.a) === 'run').length
  const rate = ok + bad ? Math.round((ok / (ok + bad)) * 100) : null
  const recent = [...live].sort((x, y) => y.createdAt - x.createdAt).slice(0, 6)
  // last 7 days: prompts that got a result, by the day they were sent (or the batch day before the first send)
  const days = Array.from({ length: 7 }, (_, i) => dayKey(now - (6 - i) * DAY))
  const perDay = days.map((d) => rows.filter((r) => r.a.item === 'ready' && dayKey(r.a.clickAt ?? r.b.createdAt) === d).length)
  const top = Math.max(1, ...perDay)

  return (
    <section className="ov" aria-label="Tổng quan">
      <div className="ov-stats">
        <Stat icon="layers" tint="orange" label="Lô đang chạy" value={String(active.length)} sub={waiting ? `${waiting} lượt đang chờ đến lượt` : 'Không có lượt nào đang chờ'} />
        <Stat icon="image" tint="blue" label="Kết quả 30 ngày" value={String(outputs30)} sub="ảnh và video Flow đã trả về" />
        <Stat icon="coin" tint="green" label="Credit Flow" value={credit ? String(credit.credits) : '—'} sub={credit ? `đọc lúc ${new Date(credit.at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}` : 'Có số sau lần tạo video đầu tiên'} />
        <Stat icon="bell" tint="red" label="Cần bạn xem" value={String(needYou.length)} sub="lượt chờ bấm Gửi, lỗi hoặc chưa rõ" />
      </div>

      <div className="ov-grid">
        <div className="ov-card ov-recent">
          <div className="ov-card-head"><h3 className="ov-title">Lô gần đây</h3><button className="ov-ghost" onClick={() => go('Hàng đợi')}>Xem tất cả</button></div>
          {recent.length === 0 ? (
            <div className="ov-empty"><p>Chưa có lô nào.</p><button className="primary" onClick={() => go('Tạo lô')}><Icon name="plus" />Tạo lô đầu tiên</button></div>
          ) : (
            <table className="ov-table">
              <thead><tr><th>Lô</th><th>Loại</th><th>Tạo lúc</th><th>Trạng thái</th><th>Tiến độ</th></tr></thead>
              <tbody>
                {recent.map((b) => {
                  const done = b.items.filter((it) => current(it).item === 'ready').length
                  return (
                    <tr key={b.id}>
                      <td><b className="num">{b.id.slice(0, 8)}</b><span className="ov-prompt">{b.items[0]?.prompt ?? ''}</span></td>
                      <td>{siteLabel(b.provider)}{KIND_LABEL[b.kind]} · {b.items.length}</td>
                      <td className="num">{new Date(b.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}</td>
                      <td><span className="ov-pill" data-tone={PILL[batchTone(b.status)]}>{BATCH_LABEL[b.status] ?? b.status}</span></td>
                      <td><Ring pct={b.items.length ? Math.round((done / b.items.length) * 100) : 0} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="ov-card ov-rate">
          <h3 className="ov-title">Tỉ lệ thành công</h3>
          <Gauge pct={rate} />
          <dl className="ov-figures">
            <div><dt>Tổng lượt</dt><dd className="num">{rows.length}</dd></div>
            <div><dt>Có kết quả</dt><dd className="num" data-tone="done">{ok}</dd></div>
            <div><dt>Lỗi</dt><dd className="num" data-tone="attn">{bad}</dd></div>
            <div><dt>Đang làm</dt><dd className="num" data-tone="run">{working}</dd></div>
          </dl>
        </div>

        <div className="ov-card ov-todo">
          <div className="ov-card-head"><h3 className="ov-title">Việc cần bạn làm</h3>{needYou.length > 0 && <button className="ov-ghost" onClick={() => go('Hàng đợi')}>Mở danh sách lô</button>}</div>
          {needYou.length === 0 ? <p className="ov-muted">Không có việc nào đang chờ bạn.</p> : (
            <ul>
              {needYou.slice(0, 6).map((r) => (
                <li key={r.it.id}>
                  <span className="ov-check" data-tone={itemTone(r.a)} aria-hidden="true" />
                  <span className="ov-todo-text">{r.it.prompt}<small className="num">Lô {r.b.id.slice(0, 8)} · dòng {r.it.ord + 1}</small></span>
                  <span className="ov-pill" data-tone={itemTone(r.a)}>{itemLabel(r.a)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ov-card ov-week">
          <h3 className="ov-title">Kết quả 7 ngày qua</h3>
          <div className="ov-dots" role="img" aria-label={`Số lượt có kết quả mỗi ngày: ${days.map((d, i) => `${d}: ${perDay[i]}`).join(', ')}`}>
            {days.map((d, i) => (
              <div key={d} className="ov-dotcol">
                <span className="ov-dotnum num">{perDay[i] || ''}</span>
                {Array.from({ length: 8 }, (_, k) => <i key={k} data-on={perDay[i] > 0 && 7 - k < Math.ceil((perDay[i] / top) * 8)} />)}
                <span className="ov-dotday num">{d}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
