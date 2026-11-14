import { useEffect, useState } from 'react'
import type { Draft, License, Session, TelegramState, UpdateState } from '../types'
import { AccountBox } from './Account'
import { codeIn, hintOf } from '../hints'
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

export default function Settings({ lic, s, reload, theme = 'system', onTheme, upd, onUpd, onInstall }: { lic?: License; s: Session; reload(): void; theme?: Theme; onTheme?(t: Theme): void; upd?: UpdateState | null; onUpd?(u: UpdateState): void; onInstall?(): void }): React.JSX.Element {
  const [ack, setAck] = useState(false)
  const [msg, setMsg] = useState('')
  const act = (f: () => Promise<unknown>): void => void f().then(() => { setMsg(''); reload() }, (e: Error) => setMsg(e.message))
  const speed = (v: Draft['speed']): void => act(() => window.api.saveDraft({ speed: v }))
  const box = (k: 'notifyApp' | 'notifyWindows' | 'notifyTelegram' | 'tray' | 'openAtLogin', label: string): React.JSX.Element => (
    <label><input type="checkbox" checked={s.draft[k]} onChange={(e) => act(() => window.api.saveDraft({ [k]: e.target.checked }))} /> {label}</label>
  )
  const [blocked, setBlocked] = useState(false) // a Windows notification failed: Windows has them switched off
  useEffect(() => { const f = (): void => void window.api.listNotices().then((n: { windowsBlocked: boolean }) => setBlocked(n.windowsBlocked)); f(); return window.api.onNotice(f) }, [])
  const [tg, setTg] = useState<TelegramState | null>(null)
  const [token, setToken] = useState('') // goes to main once; never read back
  const [tgMsg, setTgMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { void window.api.getTelegram().then(setTg) }, [])
  const tgAct = (f: () => Promise<TelegramState | void>, ok: string): void => {
    setTgMsg(null)
    void f().then((st) => { if (st) setTg(st); setTgMsg({ ok: true, text: ok }) }, (e: Error) => setTgMsg({ ok: false, text: hintOf(codeIn(e.message)) ?? 'Không làm được, thử lại.' }))
  }
  const [mcp, setMcp] = useState<{ enabled: boolean; url: string | null; file: string } | null>(null)
  useEffect(() => { void window.api.getMcp().then(setMcp) }, [])
  const MCP_ERR: Record<string, string> = { MCP_PORT_BUSY: 'Cổng 47615 trên máy đang bị chương trình khác dùng (có thể một ToolFlow khác đang mở). Tắt chương trình đó rồi bật lại', MCP_START_FAILED: 'Không mở được cổng cho trợ lý AI. Thử bật lại' }
  const [bak, setBak] = useState<{ ok: boolean; text: string } | null>(null)
  const bakErr = (e: Error): void => { const c = e.message.match(/\b[A-Z][A-Z_]{2,}\b/)?.[0]; setBak({ ok: false, text: hintOf(c) ?? e.message }) }
  const backup = (): void => { setBak(null); void window.api.backupData().then((r: { saved: boolean; name?: string }) => r.saved && setBak({ ok: true, text: `Đã sao lưu vào tệp ${r.name}` }), bakErr) }
  const restore = (): void => { setBak(null); void window.api.restoreBackup().then((r: { staged: boolean }) => r.staged && setBak({ ok: true, text: 'Bản sao lưu hợp lệ. App đang tự đóng và mở lại để dùng nó…' }), bakErr) }
  const toggleMcp = (on: boolean): void => { setMcp((m) => m && { ...m, enabled: on, url: null }) /* shown at once; main's answer below is what counts */; void window.api.setMcp(on).then((m: typeof mcp) => { setMcp(m); setMsg('') }, (e: Error) => { void window.api.getMcp().then(setMcp); setMsg(Object.entries(MCP_ERR).find(([k]) => e.message.includes(k))?.[1] ?? e.message) }) }
  return (
    <section aria-label="Cài đặt">
      <h2>Cài đặt</h2>
      {lic?.email && <AccountBox lic={lic} />}
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
      <fieldset aria-label="Thông báo">
        <legend>Thông báo</legend>
        <p className="hint">Báo khi một lô xong, khi lô dừng lại và cần bạn, khi lô hẹn giờ bắt đầu và khi credit Flow sắp hết.</p>
        {box('notifyApp', 'Trong app (chuông ở thanh trên cùng)')}
        {box('notifyWindows', 'Thông báo của Windows (góc màn hình)')}
        {blocked && <p className="notice warn" role="status" data-testid="windows-blocked">Windows đang tắt thông báo của app. Muốn bật: mở Cài đặt Windows → Hệ thống → Thông báo, bật “Thông báo” rồi bật mục ToolFlow. Trong lúc đó tin vẫn có ở chuông trong app.</p>}
        {box('notifyTelegram', 'Telegram (qua bot của riêng bạn)')}
        <div className="status">
          <span data-testid="tg-state">{!tg ? '…' : tg.linked ? 'Telegram: đã kết nối' : tg.configured ? 'Telegram: đã có mã bot, chưa kết nối' : 'Telegram: chưa có mã bot'}</span>
          <div className="toolbar">
            <input type="password" aria-label="Mã bot Telegram" placeholder="Dán mã bot (123456:ABC…)" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="small" disabled={!token.trim()} onClick={() => tgAct(() => window.api.setTelegram(token).then((st: TelegramState) => { setToken(''); return st }), 'Đã lưu mã bot. Gửi /start cho bot rồi bấm Kết nối Telegram.')}>Lưu mã</button>
            <button className="small" disabled={!tg?.configured} onClick={() => tgAct(() => window.api.connectTelegram(), 'Đã kết nối Telegram.')}>Kết nối Telegram</button>
            <button className="small" disabled={!tg?.linked} onClick={() => tgAct(() => window.api.testTelegram(), 'Đã gửi tin thử, xem trong Telegram.')}>Gửi tin thử</button>
          </div>
          {tgMsg && <p role={tgMsg.ok ? 'status' : 'alert'} className={tgMsg.ok ? 'hint' : 'notice'}>{tgMsg.text}</p>}
          <p className="hint">Cách làm: trong Telegram mở <b>@BotFather</b>, gửi <code>/newbot</code>, đặt tên, chép mã bot nó đưa rồi dán vào đây và bấm Lưu mã. Mở bot vừa tạo, bấm <b>Start</b> (gửi <code>/start</code>), quay lại bấm <b>Kết nối Telegram</b>. Tin Telegram chỉ có mã lô, nền tảng, số kết quả, mã lỗi và giờ: không có prompt, tên file hay tài khoản.</p>
        </div>
      </fieldset>
      <fieldset aria-label="Khi đóng cửa sổ">
        <legend>Khi đóng cửa sổ</legend>
        {box('tray', 'Đóng cửa sổ thì thu xuống khay (lịch vẫn chạy)')}
        {box('openAtLogin', 'Tự mở cùng Windows')}
        <p className="hint">Khay là góc phải thanh taskbar: bấm biểu tượng ToolFlow ở đó để mở lại, chuột phải → Thoát để tắt hẳn. Tự mở cùng Windows thì app mở sẵn trong khay để lô hẹn giờ vẫn chạy.</p>
      </fieldset>
      <fieldset aria-label="Credit Flow">
        <legend>Credit Flow</legend>
        <label>Cảnh báo khi credit dưới <input type="number" min={0} max={1000000} defaultValue={s.draft.creditWarn} onChange={(e) => { const n = Number(e.target.value); if (e.target.value !== '' && Number.isInteger(n) && n >= 0 && n <= 1_000_000) act(() => window.api.saveDraft({ creditWarn: n })) }} /></label>
        <p className="hint">App đọc số credit Flow còn lại mỗi khi Flow trả lời một lượt video, và báo một lần mỗi khi số đó xuống dưới mức này. Số mới nhất hiện ở màn Kết nối.</p>
      </fieldset>
      <fieldset>
        <legend>Lưu kết quả</legend>
        <label><input type="checkbox" checked={s.draft.autoSave} onChange={(e) => act(() => window.api.saveDraft({ autoSave: e.target.checked }))} /> Tự lưu kết quả của lô Flow về máy khi tạo xong</label>
        <p className="hint">Bỏ tích thì lô Flow chờ bạn bấm Tải. Lô ChatGPT và Gemini luôn tự lưu. Lượt lưu bị lỗi được app tự thử lại 2 lần, cách nhau 30 giây.</p>
      </fieldset>
      <fieldset aria-label="Sao lưu">
        <legend>Sao lưu và khôi phục</legend>
        <div className="toolbar">
          <button className="small" onClick={backup}>Sao lưu dữ liệu</button>
          <button className="small" onClick={restore}>Khôi phục từ bản sao lưu</button>
        </div>
        {bak && <p role={bak.ok ? 'status' : 'alert'} className={bak.ok ? 'hint' : 'notice'}>{bak.text}</p>}
        <p className="hint">Bản sao lưu là một tệp chứa lịch sử lô, prompt, trạng thái và thẻ của kết quả, mẫu lô, workflow và cài đặt. Ảnh và video không nằm trong đó (tệp vẫn ở thư mục Downloads/ToolFlow), mã khoá trợ lý AI và mã ghép nối extension cũng không. Khôi phục thay dữ liệu hiện tại bằng bản sao lưu rồi app tự mở lại; dữ liệu cũ được giữ thành một tệp bên cạnh, không bị xoá.</p>
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
