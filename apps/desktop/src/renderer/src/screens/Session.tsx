import type { Session, SessionTab } from '../types'

const WHY: Record<string, string> = { no_project: 'Mở một dự án', no_login: 'Chưa đăng nhập Google' }

export default function SessionScreen({ s, reload }: { s: Session | null; reload?: () => void }): React.JSX.Element {
  if (!s) return <p>Đang tải…</p>
  const sc = s.selfCheck
  const use = (t: SessionTab): void => { void window.api.useTabs([...s.tabs.filter((x) => x.granted).map((x) => x.tabId), t.tabId]).then(() => reload?.()) }
  return (
    <section aria-label="Kết nối">
      <h2>Kết nối</h2>
      <p>Trình điều khiển: {s.fake ? 'giả lập (kiểm thử)' : 'extension ToolFlow Connector'}</p>
      {!s.fake && <p>Extension: {s.connected ? 'Đã kết nối' : 'Chưa kết nối'}</p>}
      {s.connectorError && <p role="alert" className="err">Không khởi động được cầu nối extension (mã lỗi {s.connectorError}).</p>}
      <h3>Tab Flow</h3>
      {s.tabs.length === 0 ? <p>Mở Flow trong Chrome</p> : (
        <ul aria-label="Tab Flow">
          {s.tabs.map((t) => (
            <li key={t.tabId} data-testid="flow-tab">
              Tab {t.tabId}{t.projectId ? ` · dự án ${t.projectId.slice(0, 8)}` : ''}{t.email ? ` · ${t.email}` : ''}{' — '}
              {t.granted ? 'Đang dùng' : t.status === 'ok' ? <button onClick={() => use(t)}>Dùng tab này</button> : WHY[t.status]}
            </li>
          ))}
        </ul>
      )}
      <p>Tài khoản: {s.email ?? 'chưa đọc được'}</p>
      <p>
        {sc === null ? 'Self-check: chưa chạy (không có tab)' : sc.ok ? 'Self-check: đạt' : `Self-check: lỗi ${sc.code} — ${sc.reasons.join(', ')}`}
      </p>
    </section>
  )
}
