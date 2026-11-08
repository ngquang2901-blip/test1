import type { Session } from '../types'

export default function SessionScreen({ s }: { s: Session | null }): React.JSX.Element {
  if (!s) return <p>Đang tải…</p>
  const sc = s.selfCheck
  return (
    <section aria-label="Kết nối">
      <h2>Kết nối</h2>
      <p>Trình điều khiển: {s.fake ? 'giả lập (kiểm thử)' : 'extension ToolFlow Connector'}</p>
      {!s.fake && <p>Extension: {s.connected ? 'Đã kết nối' : 'Chưa kết nối'}</p>}
      {s.connectorError && <p role="alert" className="err">Không khởi động được cầu nối extension (mã lỗi {s.connectorError}).</p>}
      <p>Tab Flow: {s.tabs.length ? s.tabs.join(', ') : 'chưa có tab nào (phát hiện tab sẽ có ở bản sau)'}</p>
      <p>Tài khoản: {s.email ?? 'chưa đọc được'}</p>
      <p>
        {sc === null ? 'Self-check: chưa chạy (không có tab)' : sc.ok ? 'Self-check: đạt' : `Self-check: lỗi ${sc.code} — ${sc.reasons.join(', ')}`}
      </p>
    </section>
  )
}
