import { useEffect, useState } from 'react'
import type { Session } from '../types'
import { Chip } from '../ui'
import { checkHint, hintOf } from '../hints'

const WHY: Record<string, string> = { no_project: 'Mở một dự án', no_login: 'Chưa đăng nhập Google' }

const clean = (m: string): string => m.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')

const copy = (text: string, done: () => void): void => { void navigator.clipboard.writeText(text).then(done) }

/** One step at a time, advanced by the live session state. Chrome only takes an unpacked extension by hand (no store listing),
 * and never opens a chrome:// page for another program, so the address is copied for the user to paste. */
function Setup({ s, picked }: { s: Session; picked: boolean }): React.JSX.Element {
  const [copied, setCopied] = useState<'page' | 'dir' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dir = s.extDir ?? null
  const [auto, setAuto] = useState<'running' | 'ok' | string | null>(null) // string: the failure code
  const openFlow = (): void => { setError(null); void window.api.openChrome('flow').catch((e: Error) => setError(clean(e.message))) }
  const runAuto = (): void => { setAuto('running'); void window.api.autoConnect().then((r: { ok: boolean; code?: string }) => setAuto(r.ok ? 'ok' : r.code ?? 'AUTO_SCRIPT_ERROR'), (e: Error) => setAuto(clean(e.message))) }
  const steps: { title: string; done: boolean; body: React.JSX.Element }[] = [
    { title: 'Cài Google Chrome', done: s.chromeFound === true, body: <p>Không tìm thấy Google Chrome trên máy này. Hãy cài Chrome từ google.com/chrome, rồi quay lại đây — app tự nhận ra.</p> },
    { title: 'Thêm tiện ích ToolFlow vào Chrome (làm một lần)', done: s.connected === true, body: (
      <>
        <div className="auto-connect">
          <p>ToolFlow tự làm hết: đóng Chrome, mở lại, thêm tiện ích rồi mở Google Flow (khoảng 20 giây). Các tab đang mở sẽ được mở lại.</p>
          <div className="toolbar"><button className="primary" disabled={auto === 'running'} onClick={runAuto}>{auto === 'running' ? 'Đang kết nối… đừng bấm vào Chrome' : 'Kết nối tự động'}</button></div>
          {auto === 'ok' && <p className="setup-ready">✓ Đã thêm tiện ích vào Chrome</p>}
          {auto && auto !== 'running' && auto !== 'ok' && <p role="alert" className="notice">{hintOf(auto) ?? `Chưa tự làm xong (mã ${auto}). Làm theo các bước bên dưới`}</p>}
          <p className="muted small-text">Hoặc tự làm theo các bước:</p>
        </div>
        {s.oldExt && <p role="alert" className="notice" data-testid="old-ext">Chrome vẫn chạy tiện ích ToolFlow bản cũ nên app không nhận. Chép địa chỉ trang tiện ích (bên dưới), dán vào Chrome, tìm <b>ToolFlow Connector</b> và bấm nút tải lại (↻) — hoặc tắt hẳn Chrome rồi mở lại.</p>}
        <ol className="steps">
          <li>Mở Chrome, bấm vào thanh địa chỉ, bấm Ctrl+V rồi Enter.
            <div className="toolbar"><button className="small" onClick={() => copy('chrome://extensions', () => setCopied('page'))}>{copied === 'page' ? 'Đã chép' : 'Chép địa chỉ trang tiện ích'}</button></div>
          </li>
          <li>Bật <b>Chế độ dành cho nhà phát triển</b> (Developer mode) ở góc trên bên phải.</li>
          <li>Bấm <b>Mở thư mục tiện ích</b>, rồi kéo thư mục <b>extension</b> thả vào trang Chrome. Hoặc bấm <b>Tải tiện ích đã giải nén</b> (Load unpacked) và chọn thư mục đó.
            <div className="toolbar path">
              <code>{dir ?? '—'}</code>
              <button className="small" disabled={!dir} onClick={() => { if (dir) copy(dir, () => setCopied('dir')) }}>{copied === 'dir' ? 'Đã chép' : 'Chép đường dẫn'}</button>
              <button className="small" onClick={() => void window.api.openExtensionFolder()}>Mở thư mục tiện ích</button>
            </div>
          </li>
        </ol>
        <p className="muted small-text">Xong là app tự nối, không cần khởi động lại. Dùng nhiều tài khoản: làm lại trong từng hồ sơ Chrome.</p>
      </>) },
    { title: 'Mở một dự án Google Flow', done: s.tabs.some((t) => !!t.projectId), body: (
      <>
        {auto === 'ok' ? <p>Chrome đã mở sẵn Google Flow. Đăng nhập Google nếu được hỏi, rồi mở (hoặc tạo) một dự án.</p>
          : <p>Nếu Chrome đang mở, hãy đóng hết các cửa sổ Chrome trước, rồi bấm nút dưới đây (chỉ cần một lần) để Flow vẫn chạy khi Chrome bị che. Sau đó mở một dự án.</p>}
        <div className="toolbar"><button className="primary" onClick={openFlow}>Mở Google Flow</button></div>
        {error && <p role="alert" className="notice">{hintOf(error) ?? `Lỗi ${error}`}</p>}
      </>) },
    { title: 'Chọn tab Flow', done: picked, body: <p>Chỉ có một tab Flow thì app tự chọn. Có nhiều tab thì bấm <b>Dùng tab này</b> ở tab muốn dùng (danh sách bên dưới).</p> },
  ]
  const cur = steps.findIndex((x) => !x.done)
  return (
    <div className="panel setup" data-testid="setup">
      {cur < 0 ? <p className="panel-body setup-ready">✓ Đã sẵn sàng — ToolFlow đã nối với Google Flow</p> : (
        <ol className="panel-body guide" aria-label="Các bước kết nối">
          {steps.map((x, i) => i < cur ? <li key={x.title} className="past">✓ {x.title}</li>
            : i > cur ? <li key={x.title} className="next">{i + 1}. {x.title}</li>
            : <li key={x.title} className="now" aria-current="step"><h3>Bước {i + 1}: {x.title}</h3>{x.body}</li>)}
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
            {sc && !sc.ok && checkHint(sc) && <div className="hint" data-testid="check-hint">{checkHint(sc)}</div>}
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
                  : full ? <span className="hint">{s.speedInUse.tabs === 1 ? 'Tốc độ Mặc định chỉ dùng 1 tab — chọn Nhanh trong Cài đặt (rồi tắt hẳn app: khay hệ thống → Thoát, và mở lại) để chạy tới 4 tab' : `Đã đủ ${s.speedInUse.tabs} tab`}</span>
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
