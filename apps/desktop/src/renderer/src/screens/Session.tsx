import type { Session, SessionTab } from '../types'
import { Chip } from '../ui'

const WHY: Record<string, string> = { no_project: 'Mở một dự án', no_login: 'Chưa đăng nhập Google' }

export default function SessionScreen({ s, reload }: { s: Session | null; reload?: () => void }): React.JSX.Element {
  if (!s) return <p className="muted">Đang tải…</p>
  const sc = s.selfCheck
  const use = (t: SessionTab): void => { void window.api.useTabs([...s.tabs.filter((x) => x.granted).map((x) => x.tabId), t.tabId]).then(() => reload?.()) }
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
          <dt>Tài khoản Google</dt><dd>{s.email ?? 'chưa đọc được'}</dd>
          <dt>Kiểm tra trang</dt>
          <dd>
            <Chip tone={sc === null ? 'idle' : sc.ok ? 'done' : 'attn'}>
              {sc === null ? 'Self-check: chưa chạy (không có tab)' : sc.ok ? 'Self-check: đạt' : `Self-check: lỗi ${sc.code} — ${sc.reasons.join(', ')}`}
            </Chip>
          </dd>
        </dl>
      </div>
      <div className="panel">
        <div className="panel-head"><h3>Tab Flow</h3><span className="muted small-text">App chỉ thao tác trên tab bạn cho phép.</span></div>
        {s.tabs.length === 0 ? <p className="panel-body muted">Mở Flow trong Chrome</p> : (
          <ul aria-label="Tab Flow" className="tabs">
            {s.tabs.map((t) => (
              <li key={t.tabId} data-testid="flow-tab">
                <span className="meta">
                  <span>Tab {t.tabId}{t.projectId ? ` · dự án ${t.projectId.slice(0, 8)}` : ''}</span>
                  {t.email && <span className="muted small-text">{t.email}</span>}
                </span>
                {t.granted ? <Chip tone="done">Đang dùng</Chip> : t.status === 'ok' ? <button className="primary" onClick={() => use(t)}>Dùng tab này</button> : <Chip tone="wait">{WHY[t.status]}</Chip>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
