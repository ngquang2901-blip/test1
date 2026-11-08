import { useState } from 'react'
import type { Draft, Session } from '../types'

export default function Settings({ s, reload }: { s: Session; reload(): void }): React.JSX.Element {
  const [ack, setAck] = useState(false)
  const [msg, setMsg] = useState('')
  const act = (f: () => Promise<unknown>): void => void f().then(() => { setMsg(''); reload() }, (e: Error) => setMsg(e.message))
  const speed = (v: Draft['speed']): void => act(() => window.api.saveDraft({ speed: v }))
  return (
    <section aria-label="Cài đặt">
      <h2>Cài đặt</h2>
      <fieldset>
        <legend>Tốc độ</legend>
        <label><input type="radio" name="speed" checked={s.draft.speed === 'default'} onChange={() => speed('default')} /> Mặc định</label>{' '}
        <label><input type="radio" name="speed" checked={s.draft.speed === 'fast'} onChange={() => speed('fast')} /> Nhanh</label>
        <p>Áp dụng từ lần mở app sau. Đang dùng: ảnh {s.speedInUse.image} song song, video {s.speedInUse.video} song song.</p>
      </fieldset>
      <h3>Tự động gửi theo tài khoản{s.email ? `: ${s.email}` : ''}</h3>
      <p>{s.autoEnabled ? 'Auto: bật' : 'Auto: tắt'}</p>
      {!s.email && <p>Chưa đọc được tài khoản, auto luôn tắt.</p>}
      {s.autoEnabled ? (
        <button onClick={() => act(() => window.api.disableAuto())}>Tắt auto</button>
      ) : (
        <div className="box">
          <p>Cảnh báo: auto sẽ tự bấm Gửi trong Flow thay bạn và có thể tốn credit; lượt không rõ vẫn tính là đã tốn. Chỉ bật cho tài khoản bạn tin tưởng.</p>
          <label><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Tôi hiểu rủi ro</label>{' '}
          <button disabled={!ack || !s.email} onClick={() => act(() => window.api.enableAuto({ ack }))}>Bật auto</button>
        </div>
      )}
      {msg && <p role="alert" className="err">{msg}</p>}
    </section>
  )
}
