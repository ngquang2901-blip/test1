import { useEffect, useState } from 'react'
import type { Draft, Session, UpdateState } from '../types'
import type { Theme } from '../theme'
import { Chip } from '../ui'

const updText = (u?: UpdateState | null): string => !u ? '' :
  u.state === 'off' ? (u.current ? 'Chưa có nơi đặt bản cập nhật, app chưa tự kiểm tra được' : 'Chỉ có ở bản cài đặt')
  : u.state === 'idle' ? 'Chưa kiểm tra'
  : u.state === 'checking' ? 'Đang kiểm tra…'
  : u.state === 'none' ? 'Bạn đang dùng bản mới nhất'
  : u.state === 'available' || u.state === 'downloading' ? `Đang tải bản ${u.version ?? ''}${u.percent !== undefined ? ` · ${u.percent}%` : '…'}`
  : u.state === 'ready' ? `Bản ${u.version} đã tải xong`
  : `Không kiểm tra được bản mới (mạng hoặc máy chủ cập nhật) · ${u.code ?? ''}`

export default function Settings({ s, reload, theme = 'system', onTheme, upd, onUpd, onInstall }: { s: Session; reload(): void; theme?: Theme; onTheme?(t: Theme): void; upd?: UpdateState | null; onUpd?(u: UpdateState): void; onInstall?(): void }): React.JSX.Element {
  const [ack, setAck] = useState(false)
  const [msg, setMsg] = useState('')
  const act = (f: () => Promise<unknown>): void => void f().then(() => { setMsg(''); reload() }, (e: Error) => setMsg(e.message))
  const speed = (v: Draft['speed']): void => act(() => window.api.saveDraft({ speed: v }))
  const [mcp, setMcp] = useState<{ enabled: boolean; url: string | null; file: string } | null>(null)
  useEffect(() => { void window.api.getMcp().then(setMcp) }, [])
  const MCP_ERR: Record<string, string> = { MCP_PORT_BUSY: 'Cổng 47615 trên máy đang bị chương trình khác dùng (có thể một ToolFlow khác đang mở). Tắt chương trình đó rồi bật lại', MCP_START_FAILED: 'Không mở được cổng cho trợ lý AI. Thử bật lại' }
  const toggleMcp = (on: boolean): void => { setMcp((m) => m && { ...m, enabled: on, url: null }) /* shown at once; main's answer below is what counts */; void window.api.setMcp(on).then((m: typeof mcp) => { setMcp(m); setMsg('') }, (e: Error) => { void window.api.getMcp().then(setMcp); setMsg(Object.entries(MCP_ERR).find(([k]) => e.message.includes(k))?.[1] ?? e.message) }) }
  return (
    <section aria-label="Cài đặt">
      <h2>Cài đặt</h2>
      <fieldset>
        <legend>Giao diện</legend>
        <label><input type="radio" name="theme" checked={theme === 'light'} onChange={() => onTheme?.('light')} /> Sáng</label>
        <label><input type="radio" name="theme" checked={theme === 'dark'} onChange={() => onTheme?.('dark')} /> Tối</label>
        <label><input type="radio" name="theme" checked={theme === 'system'} onChange={() => onTheme?.('system')} /> Theo hệ thống</label>
      </fieldset>
      <fieldset aria-label="Cập nhật">
        <legend>Cập nhật</legend>
        <div className="toolbar">
          <span>Phiên bản đang dùng: <b className="num">{upd?.current || '—'}</b></span>
          <span className="muted" data-testid="update-state">{updText(upd)}</span>
          <span className="spacer" />
          {upd?.state === 'ready'
            ? <button className="small primary" onClick={() => onInstall?.()}>Khởi động lại để cập nhật</button>
            : <button className="small" disabled={!upd || ['off', 'checking', 'available', 'downloading'].includes(upd.state)} onClick={() => void window.api.checkUpdate().then((u: UpdateState) => onUpd?.(u))}>Kiểm tra bản mới</button>}
        </div>
        <p className="hint">App tự kiểm tra khi mở và vài giờ một lần, tự tải bản mới trong nền. Bản đã tải sẽ tự cài khi bạn tắt app.</p>
      </fieldset>
      <fieldset>
        <legend>Tốc độ</legend>
        <label><input type="radio" name="speed" checked={s.draft.speed === 'default'} onChange={() => speed('default')} /> Mặc định</label>
        <label><input type="radio" name="speed" checked={s.draft.speed === 'fast'} onChange={() => speed('fast')} /> Nhanh</label>
        <p className="hint">Nhanh: tối đa 4 tab Flow cùng lúc (Mặc định: 1). Áp dụng từ lần mở app sau. Đang dùng: <span className="num">{s.speedInUse.tabs}</span> tab, ảnh <span className="num">{s.speedInUse.image}</span> song song, video <span className="num">{s.speedInUse.video}</span> song song.</p>
      </fieldset>
      <fieldset aria-label="Trợ lý AI">
        <legend>Trợ lý AI (MCP)</legend>
        <label><input type="checkbox" checked={!!mcp?.enabled} disabled={!mcp} onChange={(e) => toggleMcp(e.target.checked)} /> Cho trợ lý AI trên máy này điều khiển ToolFlow</label>
        {mcp?.enabled && mcp.url && (
          <div className="toolbar">
            <span>Địa chỉ: <code data-testid="mcp-url">{mcp.url}</code></span>
            <span className="spacer" />
            <button className="small" onClick={() => void window.api.openMcpFile()}>Mở thư mục chứa mã khoá</button>
          </div>
        )}
        <p className="hint">MCP là cổng để một trợ lý AI (Claude, Hermes…) tạo lô, xem tiến độ và tải kết quả thay bạn. Trợ lý gửi prompt sẽ tốn credit Flow như khi bạn tự chạy. Nó không bật được “Tự động gửi”, không đổi cài đặt, chỉ nghe trên máy này và cần mã khoá trong file <code>mcp.json</code> (ai đọc được file đó cũng điều khiển được app).</p>
      </fieldset>
      <div className="panel">
        <div className="panel-head">
          <h3>Tự động gửi theo tài khoản{(s.accounts?.length ?? 0) > 1 ? ` (${s.accounts!.length} tài khoản)` : s.email ? `: ${s.email}` : ''}</h3>
          <Chip tone={s.autoEnabled ? 'run' : 'idle'}>{s.autoEnabled ? 'Auto: bật' : 'Auto: tắt'}</Chip>
        </div>
        <div className="panel-body">
          {!s.email && <p className="muted">Chưa đọc được tài khoản, auto luôn tắt.</p>}
          {(s.accounts?.length ?? 0) > 1 && <ul className="small-text">{s.accounts!.map((a) => <li key={a.email}>{a.email}: {a.auto ? 'auto bật' : 'auto tắt'}</li>)}</ul>}
          {s.autoEnabled ? (
            <div><button onClick={() => act(() => window.api.disableAuto())}>Tắt auto</button></div>
          ) : (
            <>
              <p className="notice warn">Cảnh báo: auto sẽ tự bấm Gửi trong Flow thay bạn và có thể tốn credit; lượt không rõ vẫn tính là đã tốn. Chỉ bật cho tài khoản bạn tin tưởng.</p>
              <div className="toolbar">
                <label><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Tôi hiểu rủi ro</label>
                <button className="primary" disabled={!ack || !s.email} onClick={() => act(() => window.api.enableAuto({ ack }))}>Bật auto</button>
              </div>
            </>
          )}
        </div>
      </div>
      {msg && <p role="alert" className="notice">{msg}</p>}
    </section>
  )
}
