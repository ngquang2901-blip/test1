import { useEffect, useState } from 'react'
import type { Session } from '../types'
import { Chip } from '../ui'
import { hintOf } from '../hints'

const WHY: Record<string, string> = { no_project: 'Mở một dự án', no_login: 'Chưa đăng nhập Google' }

const clean = (m: string): string => m.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')

/** What is done already (live ticks), buttons that open the right page in Chrome (main finds Chrome and holds the addresses),
 * and while the extension is not linked the by-hand steps: Chrome only takes an unpacked extension by hand (no store listing). */
function Setup({ s, picked }: { s: Session; picked: boolean }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dir = s.extDir ?? null
  const open = (page: 'extensions' | 'flow'): void => { setError(null); void window.api.openChrome(page).catch((e: Error) => setError(clean(e.message))) }
  const checks: [string, boolean][] = [['Chrome tìm thấy', s.chromeFound === true], ['Extension đã nối', s.connected === true], ['Có tab Flow', s.tabs.length > 0], ['Đã mở dự án', s.tabs.some((t) => !!t.projectId)], ['Đã chọn tab', picked]]
  return (
    <div className="panel setup" data-testid="setup">
      <div className="panel-head"><h3>{s.connected ? 'Kết nối Chrome' : 'Cài extension vào Chrome (làm một lần)'}</h3><span className="muted small-text">App tự nối khi xong, không cần khởi động lại</span></div>
      <div className="panel-body">
        <ul className="checks" aria-label="Các bước kết nối">
          {checks.map(([label, done]) => <li key={label} data-done={done}><span role="img" aria-label={done ? 'xong' : 'chưa xong'}>{done ? '✓' : '○'}</span>{label}</li>)}
        </ul>
        <div className="toolbar">
          <button className="small" onClick={() => open('extensions')}>Mở trang tiện ích trong Chrome</button>
          <button className="small" onClick={() => open('flow')}>Mở Google Flow</button>
        </div>
        {error && <p role="alert" className="notice">{hintOf(error) ?? `Lỗi ${error}`}</p>}
      </div>
      {s.connected !== true && (
        <ol className="panel-body steps">
          <li>Mở Chrome bằng hồ sơ có tài khoản Google dùng Flow: bấm <b>Mở trang tiện ích trong Chrome</b> ở trên (hoặc gõ <code>chrome://extensions</code> vào thanh địa chỉ rồi Enter).</li>
          <li>Bật <b>Developer mode</b> (Chế độ dành cho nhà phát triển) ở góc trên bên phải.</li>
          <li>Bấm <b>Load unpacked</b> (Tải tiện ích đã giải nén) rồi chọn thư mục này:
            <div className="toolbar path">
              <code>{dir ?? '—'}</code>
              <button className="small" disabled={!dir} onClick={() => { if (dir) void navigator.clipboard.writeText(dir).then(() => setCopied(true)) }}>{copied ? 'Đã chép' : 'Chép đường dẫn'}</button>
              <button className="small" onClick={() => void window.api.openExtensionFolder()}>Mở thư mục</button>
            </div>
          </li>
          <li>Bấm <b>Mở Google Flow</b>, vào một dự án. Sau vài giây, mục dưới đây chuyển sang <b>Đã kết nối</b> và tab Flow hiện ra để bấm <b>Dùng tab này</b>.</li>
          <li className="muted">Dùng nhiều tài khoản: làm lại bước 1–3 trong từng hồ sơ Chrome.</li>
        </ol>
      )}
    </div>
  )
}

export default function SessionScreen({ s, reload }: { s: Session | null; reload?: () => void }): React.JSX.Element {
  useEffect(() => { reload?.() }, []) // eslint-disable-line react-hooks/exhaustive-deps -- once per visit: the credit balance and tabs as they are now
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
      {s.connected !== null && !s.connectorError && <Setup s={s} picked={mine.length > 0} />}
      {sc && !sc.ok && sc.reasons.includes('RELOAD_TAB') && (
        <p role="alert" className="notice warn" data-testid="reload-ext">
          Extension trong Chrome chưa phải bản đi kèm app này (thường gặp ngay sau khi app cập nhật). Vào <code>chrome://extensions</code>, bấm nút tải lại (mũi tên vòng) ở thẻ <b>ToolFlow Connector</b>, rồi tải lại tab Flow. Dùng nhiều hồ sơ Chrome thì làm ở từng hồ sơ. Trong lúc này app không tự bấm Gửi.
        </p>
      )}
      <div className="panel">
        <div className="panel-head"><h3>Cầu nối Chrome</h3><Chip tone={linked ? 'done' : 'attn'}>{linked ? 'Đang nối' : 'Mất nối'}</Chip></div>
        <dl className="panel-body kv">
          <dt>Trình điều khiển</dt><dd>{s.fake ? 'giả lập (kiểm thử)' : 'extension ToolFlow Connector'}</dd>
          {!s.fake && <><dt>Cầu nối</dt><dd>Extension: {s.connected ? 'Đã kết nối' : 'Chưa kết nối'}</dd></>}
          <dt>Tài khoản Google</dt><dd>{(s.accounts?.length ?? 0) > 1 ? s.accounts!.map((a) => a.email).join(', ') : s.email ?? 'chưa đọc được'}</dd>
          {(s.credits?.length ?? 0) > 0 && <><dt>Credit Flow</dt><dd data-testid="credits">{s.credits!.map((c) => <div key={c.email}>Credit Flow còn: <span className="num">{c.credits}</span>, đọc lúc {new Date(c.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false })}{s.credits!.length > 1 && c.email ? ` (${c.email})` : ''}</div>)}</dd></>}
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
                {t.granted ? <><Chip tone="done">Đang dùng</Chip>{t.auto && <Chip tone="done">Tự chọn lại</Chip>}{mine.length > 1 && <button className="small" onClick={() => use(mine.filter((x) => x !== t.tabId))}>Thôi dùng</button>}</>
                  : t.status !== 'ok' ? <Chip tone="wait">{WHY[t.status]}</Chip>
                  : full ? <span className="hint">{s.speedInUse.tabs === 1 ? 'Tốc độ Mặc định chỉ dùng 1 tab — chọn Nhanh trong Cài đặt để chạy tới 4 tab' : `Đã đủ ${s.speedInUse.tabs} tab`}</span>
                  : <button className="primary" onClick={() => use([...mine, t.tabId])}>Dùng tab này</button>}
              </li>
            ))}
          </ul>
        )}
        {(s.remembered ?? 0) > 0 && (
          <div className="panel-body">
            <p className="muted small-text">App nhớ tab bạn chọn theo tài khoản và dự án: khi tab của dự án đó mở lại (kể cả sau khi tắt Chrome hay app), app tự chọn lại và chạy tiếp các lô đang dở.</p>
            <div><button className="small" onClick={() => void window.api.forgetTabs().then(() => reload?.())}>Quên các tab đã nhớ</button></div>
          </div>
        )}
      </div>
      <div className="panel">
        <div className="panel-head">
          <h3>Tab ChatGPT và Gemini</h3>
          <span className="muted small-text">Dùng cho lô có nền tảng ChatGPT hoặc Gemini (tạo ảnh).</span>
        </div>
        <p className="panel-body muted" data-testid="gem-tabs">{(s.gemTabs ?? 0) > 0 ? `Đã thấy ${s.gemTabs} tab gemini.google.com — lô Gemini sẽ chạy trong tab đó, mỗi lô một cuộc trò chuyện mới.` : 'Chưa thấy tab gemini.google.com. Muốn tạo ảnh bằng Gemini: mở gemini.google.com trong Chrome này và đăng nhập.'}</p>
        <p className="panel-body muted" data-testid="gpt-tabs">{(s.gptTabs ?? 0) > 0 ? `Đã thấy ${s.gptTabs} tab chatgpt.com — lô ChatGPT sẽ chạy trong tab đó, mỗi lô một cuộc trò chuyện mới.` : 'Chưa thấy tab chatgpt.com. Muốn tạo ảnh bằng ChatGPT: mở chatgpt.com trong Chrome này và đăng nhập (giao diện tiếng Anh).'}</p>
      </div>
    </section>
  )
}
