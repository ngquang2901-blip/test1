// Tổng quan: the home screen, laid out as a "product mosaic" of five pastel cards. Every number and word that is not
// decoration comes from the batches, the session and the notices the app already has; nothing here is a placeholder.
import { useEffect, useState } from 'react'
import { ACTIVE, BATCH_LABEL, KIND_LABEL, current, itemLabel, siteLabel, type Batch, type Notice, type Session } from '../types'
import { Icon, batchTone, itemTone, type Tone } from '../ui'

type Go = (screen: 'Workflow' | 'Hàng đợi' | 'Kết quả' | 'Kết nối') => void
const DAY = 86_400_000
const dayKey = (t: number): string => new Date(t).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
const weekday = (t: number): string => ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][new Date(t).getDay()]
const hhmm = (t: number): string => new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
const PILL: Record<Tone, string> = { run: 'run', wait: 'wait', attn: 'attn', done: 'done', idle: 'idle' }
// the entrance plays once per session (not on every click on the nav), and never for people who ask for less motion
let played = false
const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches

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

const Sparkle = (): React.JSX.Element => (
  <svg width="27" height="27" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="currentColor" />
    <path d="M12 5.2c.5 3.7 3 6.2 6.8 6.8-3.8.6-6.3 3.1-6.8 6.8-.5-3.7-3-6.2-6.8-6.8C9 11.4 11.5 8.9 12 5.2z" fill="var(--mo-white)" />
  </svg>
)

// plain hand-drawn marks, not the brands' own logos
const MARKS: Record<string, React.JSX.Element> = {
  flow: <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="7" fill="#141414" /><path d="M5 15c3-7 5 3 7-3s4 1 7-3" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" /></svg>,
  chatgpt: <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#10a37f" /><path d="M7 8.5h10v6H11l-3 2.5v-2.5H7z" fill="#fff" /></svg>,
  gemini: <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1c.8 6.4 4.6 10.2 11 11-6.4.8-10.2 4.6-11 11-.8-6.4-4.6-10.2-11-11C7.4 11.2 11.2 7.4 12 1z" fill="#4285f4" /></svg>,
  chrome: <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#ea4335" /><path d="M12 12L1.9 17.9A11 11 0 0 0 12 23a11 11 0 0 0 9.9-6.1z" fill="#34a853" /><path d="M12 12h11a11 11 0 0 0-1.1-4.9H12z" fill="#fbbc04" /><circle cx="12" cy="12" r="4.2" fill="#fff" /><circle cx="12" cy="12" r="3" fill="#4285f4" /></svg>
}

function Chip({ mark, name, n, cls }: { mark: string; name: string; n: number; cls?: string }): React.JSX.Element {
  return (
    <span className={`mo-chip ${cls ?? ''}`} data-on={n > 0} title={n > 0 ? `${name}: ${n} tab đang mở` : `${name}: chưa có tab`}>
      {MARKS[mark]}{name}<i className="mo-dot" aria-hidden="true" />
    </span>
  )
}

export default function Overview({ batches, s, go }: { batches: Batch[]; s: Session | null; go: Go }): React.JSX.Element {
  const [enter, setEnter] = useState(() => !played && !reduced())
  useEffect(() => {
    played = true
    if (!enter) return
    const t = setTimeout(() => setEnter(false), 1850)
    return () => clearTimeout(t)
  }, [enter])
  const [notice, setNotice] = useState<Notice | null>(null)
  useEffect(() => {
    const load = (): void => void window.api.listNotices().then((n) => setNotice([...n.items].sort((a, b) => b.at - a.at)[0] ?? null))
    load()
    return window.api.onNotice(load)
  }, [])

  const live = batches.filter((b) => !b.archived)
  const rows = live.flatMap((b) => b.items.map((it) => ({ b, it, a: current(it) })))
  const now = Date.now()
  const active = live.filter((b) => ACTIVE.includes(b.status))
  const waiting = rows.filter((r) => r.a.item === 'queued').length
  const outputs30 = rows.filter((r) => r.a.item === 'ready' && r.b.createdAt >= now - 30 * DAY).reduce((n, r) => n + r.a.outputs.length, 0)
  const needYou = rows.filter((r) => ['wait', 'attn'].includes(itemTone(r.a)))
  const credit = [...(s?.credits ?? [])].sort((x, y) => y.at - x.at)[0]
  const recent = [...live].sort((x, y) => y.createdAt - x.createdAt).slice(0, 6)
  // last 7 days: prompts that got a result, by the day they were sent (or the batch day before the first send)
  const stamps = Array.from({ length: 7 }, (_, i) => now - (6 - i) * DAY)
  const days = stamps.map(dayKey)
  const perDay = days.map((d) => rows.filter((r) => r.a.item === 'ready' && dayKey(r.a.clickAt ?? r.b.createdAt) === d).length)
  const top = Math.max(1, ...perDay)
  const week = perDay.reduce((n, v) => n + v, 0)
  const flowTabs = s?.tabs.filter((t) => t.granted).length ?? 0
  const gpt = s?.gptTabs ?? 0
  const gem = s?.gemTabs ?? 0
  const chrome = s && (s.fake || s.connected === true) ? 1 : 0
  const usedSites = [flowTabs, gpt, gem].filter((n) => n > 0).length
  const step = !((s?.fake ? s.connected !== false : s?.connected === true) && flowTabs > 0) ? { text: 'Bước 1/2: nối ToolFlow với Google Flow (làm một lần).', btn: 'Bắt đầu kết nối', to: 'Kết nối' as const }
    : !live.length ? { text: 'Bước 2/2: tạo ảnh đầu tiên từ một mẫu có sẵn.', btn: 'Tạo ảnh đầu tiên', to: 'Workflow' as const }
      : { text: 'Đã sẵn sàng. Chạy một workflow khi bạn cần.', btn: 'Tới Workflow', to: 'Workflow' as const }
  const searchNow = (): void => { go('Kết quả'); setTimeout(() => document.querySelector<HTMLInputElement>('input[aria-label="Tìm prompt hoặc lô"]')?.focus(), 80) }

  return (
    <section className="ov" aria-label="Tổng quan">
      <div className={`mo${enter ? ' mo-enter' : ''}`}>
        <div className="mo-card mo-notif" role="group" aria-label="Thông báo mới nhất">
          <div className="mo-toast-wrap">
            <div className="mo-ledge" aria-hidden="true" />
            <div className="mo-toast">
              <Sparkle />
              <div className="mo-toast-text">
                <b>{notice ? notice.title : 'Chưa có thông báo'}</b>
                <span>{notice ? notice.body : 'Kết quả và việc cần bạn xem sẽ hiện ở đây.'}</span>
              </div>
            </div>
          </div>
          {notice && <time className="mo-time num">{hhmm(notice.at)}</time>}
        </div>

        <div className="mo-card mo-connect" role="group" aria-label="Kết nối công cụ">
          <h3 className="mo-h">Kết nối<br />công cụ của bạn.</h3>
          <p className="mo-sub">{usedSites} trong 3 nền tảng đang có tab · {flowTabs} tab Flow đang dùng</p>
          <div className="mo-chips">
            <div className="mo-row r1"><Chip mark="flow" name="Google Flow" n={flowTabs} /><Chip mark="chrome" name="Chrome" n={chrome} cls="mo-tilt" /></div>
            <div className="mo-row r2"><Chip mark="chatgpt" name="ChatGPT" n={gpt} /><Chip mark="gemini" name="Gemini" n={gem} /></div>
          </div>
        </div>

        <div className="mo-card mo-auto" role="group" aria-label="Tự động hoá">
          <div className="mo-copy">
            <h3 className="mo-h"><span className="g">Tự động</span> việc của bạn.<br />Tập trung vào điều quan trọng.</h3>
            <div className="mo-next" role="group" aria-label="Bước tiếp theo"><p className="mo-sub">{step.text}</p><button className="primary" onClick={() => go(step.to)}>{step.btn}</button></div>
          </div>
          <div className="mo-illo" aria-hidden="true">
            <div className="mo-win mo-back"><div className="mo-bar"><i /><i /><i /></div><div className="mo-body"><span /></div></div>
            <div className="mo-win mo-front"><div className="mo-bar"><i /><i /><i /></div><div className="mo-body"><span /></div></div>
            <div className="mo-pill-ai"><span className="mo-skel"><i /><i /></span>
              <svg width="23" height="23" viewBox="0 0 24 24"><path d="M14 4c.6 4.3 2.7 6.4 7 7-4.3.6-6.4 2.7-7 7-.6-4.3-2.7-6.4-7-7 4.3-.6 6.4-2.7 7-7z" fill="#eff4e6" stroke="#4f7433" strokeWidth="2.2" strokeLinejoin="round" /><path d="M6.5 13.5c.3 2 1.2 2.9 3 3.2-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3.2z" fill="#eff4e6" stroke="#4f7433" strokeWidth="2.25" strokeLinejoin="round" /></svg>
            </div>
            <div className="mo-pill-wf"><span className="mo-tick"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.3l2.4 2.4 4.6-5" fill="none" stroke="#161616" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Workflow đã chạy xong</div>
            <svg className="mo-cursor" width="30" height="35" viewBox="0 0 24 28"><path d="M3 2v21l5.4-5 3.6 8 3.4-1.5-3.5-7.7H20z" fill="#fff" stroke="#2b2b2b" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          </div>
        </div>

        <div className="mo-card mo-insights" role="group" aria-label="Kết quả 7 ngày qua">
          <span className="mo-tag">Kết quả 7 ngày qua</span>
          <h3 className="mo-big num">{week} kết quả</h3>
          <p className="mo-sub">{week > 0 ? `cao nhất ${top} lượt trong một ngày` : 'chưa có lượt nào có kết quả'}</p>
          <div className="mo-chart" role="img" aria-label={`Số lượt có kết quả mỗi ngày: ${days.map((d, i) => `${d}: ${perDay[i]}`).join(', ')}`}>
            {perDay.map((v, i) => (
              <div key={days[i]} className="mo-col">
                <div className="mo-barv" data-today={i === 6} style={{ '--r': v / top } as React.CSSProperties}><span className="num">{v || ''}</span></div>
                <small className="num">{weekday(stamps[i])}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="mo-card mo-search" role="group" aria-label="Tìm nhanh">
          <h3 className="mo-h2">Tìm mọi thứ<br />nhanh</h3>
          <button className="mo-qbar" onClick={searchNow}>
            <span className="mo-mag"><Icon name="search" size={18} /></span><span className="mo-ph">Tìm prompt, mã lô…</span>
          </button>
        </div>
      </div>

      <div className="ov-stats">
        <Stat icon="layers" tint="orange" label="Lô đang chạy" value={String(active.length)} sub={waiting ? `${waiting} lượt đang chờ đến lượt` : 'Không có lượt nào đang chờ'} />
        <Stat icon="image" tint="blue" label="Kết quả 30 ngày" value={String(outputs30)} sub="ảnh và video có trong các lô tạo 30 ngày qua (Flow, ChatGPT, Gemini)" />
        <Stat icon="coin" tint="green" label="Credit Flow" value={credit ? String(credit.credits) : '—'} sub={credit ? `đọc lúc ${new Date(credit.at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}` : 'Có số sau lần tạo video đầu tiên'} />
        <Stat icon="bell" tint="red" label="Cần bạn xem" value={String(needYou.length)} sub="lượt chờ bấm Gửi, lỗi hoặc chưa rõ" />
      </div>

      <div className="ov-grid">
        <div className="ov-card ov-recent">
          <div className="ov-card-head"><h3 className="ov-title">Lô gần đây</h3><button className="ov-ghost" onClick={() => go('Hàng đợi')}>Xem tất cả</button></div>
          {recent.length === 0 ? (
            <div className="ov-empty"><p>Chưa có lô nào. Nhờ bot trong VVO tạo ảnh, hoặc chạy một Workflow.</p><button className="primary" onClick={() => go('Workflow')}>Mở Workflow</button></div>
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
      </div>
    </section>
  )
}
