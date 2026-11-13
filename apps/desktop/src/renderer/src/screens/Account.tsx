import { useState } from 'react'
import type { License } from '../types'
import heroVideo from '../assets/login-bg.mp4' // the design's video, re-encoded to 720p without sound (190 KB): the app loads nothing from the network

const day = (t: number): string => new Date(t).toLocaleDateString('vi-VN')
const ERR: Record<string, string> = {
  LICENSE_NETWORK: 'Không kết nối được máy chủ tài khoản. Kiểm tra mạng rồi thử lại.',
  LICENSE_TIMEOUT: 'Hết thời gian chờ đăng nhập. Bấm đăng nhập lại.',
  LICENSE_REJECTED: 'Google hoặc máy chủ không chấp nhận lần đăng nhập này. Thử lại.',
  LICENSE_NOT_CONFIGURED: 'Bản app này chưa được gắn máy chủ tài khoản. Báo người bán app.',
}
const errOf = (m: string): string | null => /LICENSE_CANCELLED/.test(m) ? null : Object.entries(ERR).find(([k]) => m.includes(k))?.[1] ?? 'Không đăng nhập được, thử lại.'

/** Shown instead of the whole app until the account has an active plan. Layout after the "Aurora Sign Up" design: a video column
 * with the 3 steps, and the sign-in column. Google only (the accounts live in Firebase Auth with the Google provider). */
export default function Account({ lic }: { lic: License | null }): React.JSX.Element {
  const [err, setErr] = useState<string | null>(null)
  const act = (f: () => Promise<unknown>): void => { setErr(null); void f().catch((e: Error) => setErr(errOf(e.message))) }
  const s = lic?.status ?? 'checking'
  const signedIn = ['pending', 'expired', 'blocked'].includes(s)
  const google = <button className="auth-primary" onClick={() => act(() => window.api.signIn())}><GoogleIcon />{s === 'signing_in' ? 'Mở lại trang đăng nhập Google' : 'Đăng nhập bằng Google'}</button>
  const again = <button className="auth-primary" onClick={() => act(() => window.api.checkLicense())}>Kiểm tra lại</button>
  const out = <p className="auth-foot">Không phải tài khoản của bạn? <button className="auth-link" onClick={() => act(() => window.api.signOut())}>Đăng xuất</button></p>
  const buy = lic?.buyInfo && <div className="auth-box" aria-label="Cách mua gói"><b>Mua gói</b><p>{lic.buyInfo}</p></div>
  return (
    <main className="auth" aria-label="Tài khoản">
      <section className="auth-hero">
        <video className="auth-video" src={heroVideo} autoPlay muted loop playsInline aria-hidden="true" ref={(v) => { if (v) { v.muted = true; void v.play().catch(() => {}) } }} /* React leaves the muted attribute off, and Chromium only autoplays muted video */ />
        <div className="auth-hero-body">
          <div className="auth-brand"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" /></svg>ToolFlow</div>
          <div className="auth-intro"><h2>Bắt đầu trong 3 bước</h2><p>Tạo ảnh và video hàng loạt trên Google Flow, ChatGPT và Gemini.</p></div>
          <Step n={1} text="Đăng nhập bằng Google" active={!signedIn} />
          <Step n={2} text="Mua gói và chờ kích hoạt" active={signedIn} />
          <Step n={3} text="Bắt đầu tạo lô đầu tiên" />
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-form">
          <header>
            <h1>{signedIn ? 'Kích hoạt gói ToolFlow' : 'Đăng nhập ToolFlow'}</h1>
            <p>{signedIn ? <>Đang đăng nhập: <b>{lic?.email}</b></> : 'Dùng tài khoản Google của bạn. Lần đầu đăng nhập là đăng ký luôn.'}</p>
          </header>
          {s === 'checking' && <p className="auth-note" role="status">Đang kiểm tra tài khoản…</p>}
          {s === 'signed_out' && <>{google}{lic?.code && !err && <p className="auth-note warn" role="alert">{errOf(lic.code)}</p>}</>}
          {s === 'signing_in' && <><p className="auth-note" role="status">Trình duyệt đã mở trang đăng nhập Google. Chọn tài khoản ở đó rồi quay lại đây.</p>{google}</>}
          {s === 'offline' && <><p className="auth-note warn" role="alert">{ERR.LICENSE_NETWORK} ToolFlow cần mạng để kiểm tra gói.</p>{again}{out}</>}
          {s === 'pending' && <><p className="auth-note">Tài khoản đã đăng ký nhưng chưa có gói. Sau khi mua, bấm “Kiểm tra lại”.</p>{buy}{again}{out}</>}
          {s === 'expired' && <><p className="auth-note warn">Gói đã hết hạn{lic?.until ? ` ngày ${day(lic.until)}` : ''}. Gia hạn rồi bấm “Kiểm tra lại”.</p>{buy}{again}{out}</>}
          {s === 'blocked' && <><p className="auth-note warn" role="alert">Tài khoản đang bị khoá. Liên hệ người bán app.</p>{buy}{again}{out}</>}
          {err && <p className="auth-note warn" role="alert">{err}</p>}
        </div>
      </section>
    </main>
  )
}

function Step({ n, text, active = false }: { n: number; text: string; active?: boolean }): React.JSX.Element {
  return <div className={active ? 'auth-step active' : 'auth-step'} aria-current={active ? 'step' : undefined}><span className="auth-step-n">{n}</span>{text}</div>
}

const GoogleIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8z" />
    <path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9A11 11 0 0 0 12 23z" />
    <path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7H2.1a11 11 0 0 0 0 10z" />
    <path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z" />
  </svg>
)

/** Cài đặt → Tài khoản: who is signed in and until when. */
export function AccountBox({ lic }: { lic: License }): React.JSX.Element {
  return (
    <fieldset aria-label="Tài khoản">
      <legend>Tài khoản</legend>
      <div className="toolbar">
        <span><b>{lic.email}</b>{lic.plan ? ` · ${lic.plan}` : ''} · {lic.until ? `dùng đến ${day(lic.until)}` : 'không giới hạn ngày'}</span>
        <span className="spacer" />
        <button className="small" onClick={() => void window.api.signOut()}>Đăng xuất</button>
      </div>
    </fieldset>
  )
}
