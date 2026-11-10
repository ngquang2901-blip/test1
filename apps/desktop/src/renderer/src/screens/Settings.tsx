import { useState } from 'react'
import type { Draft, Session } from '../types'
import type { Theme } from '../theme'
import { Chip } from '../ui'

export default function Settings({ s, reload, theme = 'system', onTheme }: { s: Session; reload(): void; theme?: Theme; onTheme?(t: Theme): void }): React.JSX.Element {
  const [ack, setAck] = useState(false)
  const [msg, setMsg] = useState('')
  const act = (f: () => Promise<unknown>): void => void f().then(() => { setMsg(''); reload() }, (e: Error) => setMsg(e.message))
  const speed = (v: Draft['speed']): void => act(() => window.api.saveDraft({ speed: v }))
  return (
    <section aria-label="Cài đặt">
      <h2>Cài đặt</h2>
      <fieldset>
        <legend>Giao diện</legend>
        <label><input type="radio" name="theme" checked={theme === 'light'} onChange={() => onTheme?.('light')} /> Sáng</label>
        <label><input type="radio" name="theme" checked={theme === 'dark'} onChange={() => onTheme?.('dark')} /> Tối</label>
        <label><input type="radio" name="theme" checked={theme === 'system'} onChange={() => onTheme?.('system')} /> Theo hệ thống</label>
      </fieldset>
      <fieldset>
        <legend>Tốc độ</legend>
        <label><input type="radio" name="speed" checked={s.draft.speed === 'default'} onChange={() => speed('default')} /> Mặc định</label>
        <label><input type="radio" name="speed" checked={s.draft.speed === 'fast'} onChange={() => speed('fast')} /> Nhanh</label>
        <p className="hint">Nhanh: tối đa 4 tab Flow cùng lúc (Mặc định: 1). Áp dụng từ lần mở app sau. Đang dùng: <span className="num">{s.speedInUse.tabs}</span> tab, ảnh <span className="num">{s.speedInUse.image}</span> song song, video <span className="num">{s.speedInUse.video}</span> song song.</p>
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
