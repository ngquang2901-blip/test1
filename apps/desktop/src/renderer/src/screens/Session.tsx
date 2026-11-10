import type { Session } from '../types'
import { Chip } from '../ui'

const WHY: Record<string, string> = { no_project: 'Mở một dự án', no_login: 'Chưa đăng nhập Google' }

export default function SessionScreen({ s, reload }: { s: Session | null; reload?: () => void }): React.JSX.Element {
  if (!s) return <p className="muted">Đang tải…</p>
  const sc = s.selfCheck
  const mine = s.tabs.filter((x) => x.granted).map((x) => x.tabId)
  const use = (ids: string[]): void => { void window.api.useTabs(ids).then(() => reload?.(), () => reload?.()) }
  const full = mine.length >= s.speedInUse.tabs
  const linked = s.fake || s.connected === true
  return (
    <section aria-label="Kết nối">
      <h2>Kết nối</h2>
      {s.connectorError && <p role="alert" className="notice">Không khởi động được cầu nối extension (mã lỗi {s.connectorError}). Đóng app rồi mở lại; nếu vẫn lỗi, gửi mã này cho người hỗ trợ.</p>}
      <div className="panel">
        <div className="panel-head"><h3>Cầu nối Chrome</h3><Chip tone={linked ? 'done' : 'attn'}>{linked ? 'Đang nối' : 'Mất nối'}</Chip></div>
        <dl className="panel-body kv">
          <dt>Trình điều khiển</dt><dd>{s.fake ? 'giả lập (kiểm thử)' : 'extension ToolFlow Connector'}</dd>
          {!s.fake && <><dt>Cầu nối</dt><dd>Extension: {s.connected ? 'Đã kết nối' : 'Chưa kết nối'}</dd></>}
          <dt>Tài khoản Google</dt><dd>{(s.accounts?.length ?? 0) > 1 ? s.accounts!.map((a) => a.email).join(', ') : s.email ?? 'chưa đọc được'}</dd>
          <dt>Kiểm tra trang</dt>
          <dd>
            <Chip tone={sc === null ? 'idle' : sc.ok ? 'done' : 'attn'}>
              {sc === null ? 'Self-check: chưa chạy (không có tab)' : sc.ok ? 'Self-check: đạt' : `Self-check: lỗi ${sc.code} — ${sc.reasons.join(', ')}`}
            </Chip>
          </dd>
        </dl>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h3>Tab Flow</h3>
          <span className="muted small-text">Đang dùng <span className="num">{mine.length}/{s.speedInUse.tabs}</span> tab · app chỉ thao tác trên tab bạn cho phép.</span>
        </div>
        {mine.length > 1 && <p className="panel-body small-text muted">Nhiều tab ở nhiều dự án: lô mới được chia đều, mỗi dự án một phần. Các tab cùng một dự án cùng làm phần của dự án đó.</p>}
        {s.tabs.length === 0 ? <p className="panel-body muted">Mở Flow trong Chrome</p> : (
          <ul aria-label="Tab Flow" className="tabs">
            {s.tabs.map((t, i) => (
              <li key={t.tabId} data-testid="flow-tab">
                <span className="meta">
                  <span>Tab {i + 1}{t.projectId ? ` · dự án ${t.projectId.slice(0, 8)}` : ''}</span>
                  {t.email && <span className="muted small-text">{t.email}</span>}
                </span>
                {t.granted ? <><Chip tone="done">Đang dùng</Chip>{mine.length > 1 && <button className="small" onClick={() => use(mine.filter((x) => x !== t.tabId))}>Thôi dùng</button>}</>
                  : t.status !== 'ok' ? <Chip tone="wait">{WHY[t.status]}</Chip>
                  : full ? <span className="hint">{s.speedInUse.tabs === 1 ? 'Tốc độ Mặc định chỉ dùng 1 tab — chọn Nhanh trong Cài đặt để chạy tới 4 tab' : `Đã đủ ${s.speedInUse.tabs} tab`}</span>
                  : <button className="primary" onClick={() => use([...mine, t.tabId])}>Dùng tab này</button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
