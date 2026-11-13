import { useState } from 'react'
import type { License } from '../types'

const day = (t: number): string => new Date(t).toLocaleDateString('vi-VN')
const ERR: Record<string, string> = {
  LICENSE_NETWORK: 'Không kết nối được máy chủ tài khoản. Kiểm tra mạng rồi thử lại.',
  LICENSE_TIMEOUT: 'Hết thời gian chờ đăng nhập. Bấm đăng nhập lại.',
  LICENSE_REJECTED: 'Google hoặc máy chủ không chấp nhận lần đăng nhập này. Thử lại.',
  LICENSE_NOT_CONFIGURED: 'Bản app này chưa được gắn máy chủ tài khoản. Báo người bán app.',
}
const errOf = (m: string): string | null => /LICENSE_CANCELLED/.test(m) ? null : Object.entries(ERR).find(([k]) => m.includes(k))?.[1] ?? 'Không đăng nhập được, thử lại.'

/** Shown instead of the whole app until the account has an active plan. */
export default function Account({ lic }: { lic: License | null }): React.JSX.Element {
  const [err, setErr] = useState<string | null>(null)
  const act = (f: () => Promise<unknown>): void => { setErr(null); void f().catch((e: Error) => setErr(errOf(e.message))) }
  const s = lic?.status ?? 'checking'
  const signIn = <button className="primary" onClick={() => act(() => window.api.signIn())}>{s === 'signing_in' ? 'Mở lại trang đăng nhập Google' : 'Đăng nhập bằng Google'}</button>
  const again = <button onClick={() => act(() => window.api.checkLicense())}>Kiểm tra lại</button>
  const out = <button onClick={() => act(() => window.api.signOut())}>Đăng xuất</button>
  const buy = lic?.buyInfo && <div className="notice" aria-label="Cách mua gói"><b>Mua gói</b><p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{lic.buyInfo}</p></div>
  return (
    <main className="page login" aria-label="Tài khoản">
      <h1>ToolFlow</h1>
      {s === 'checking' && <p role="status">Đang kiểm tra tài khoản…</p>}
      {s === 'signed_out' && <><p>Đăng nhập bằng tài khoản Google để dùng ToolFlow. Lần đầu đăng nhập là đăng ký luôn.</p>{signIn}{lic?.code && !err && <p className="notice warn" role="alert">{errOf(lic.code)}</p>}</>}
      {s === 'signing_in' && <><p role="status">Trình duyệt đã mở trang đăng nhập Google. Chọn tài khoản ở đó rồi quay lại đây.</p>{signIn}</>}
      {s === 'offline' && <><p className="notice warn" role="alert">{ERR.LICENSE_NETWORK} ToolFlow cần mạng để kiểm tra gói.</p>{again}{out}</>}
      {s === 'pending' && <><p>Tài khoản <b>{lic?.email}</b> đã đăng ký nhưng chưa có gói. Sau khi mua, bấm “Kiểm tra lại”.</p>{buy}{again}{out}</>}
      {s === 'expired' && <><p>Gói của <b>{lic?.email}</b> đã hết hạn{lic?.until ? ` ngày ${day(lic.until)}` : ''}. Gia hạn rồi bấm “Kiểm tra lại”.</p>{buy}{again}{out}</>}
      {s === 'blocked' && <><p className="notice warn" role="alert">Tài khoản <b>{lic?.email}</b> đang bị khoá. Liên hệ người bán app.</p>{buy}{again}{out}</>}
      {err && <p className="notice warn" role="alert">{err}</p>}
    </main>
  )
}

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
