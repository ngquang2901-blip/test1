import { useCallback, useEffect, useRef, useState } from 'react'
import { ACTIVE, BATCH_LABEL, current, type Batch, type Draft, type Preset, type Session, type UpdateState } from './types'
import SessionScreen from './screens/Session'
import NewBatch from './screens/NewBatch'
import Queue from './screens/Queue'
import Results from './screens/Results'
import Workflow from './screens/Workflow'
import Settings from './screens/Settings'
import { newer } from './revision'
import { Chip, Icon, batchTone, itemTone } from './ui'
import { getTheme, isDark, setTheme, type Theme } from './theme'

const SCREENS = ['Kết nối', 'Tạo lô', 'Workflow', 'Hàng đợi', 'Kết quả', 'Cài đặt'] as const
const ICON = { 'Kết nối': 'plug', 'Tạo lô': 'plus', Workflow: 'nodes', 'Hàng đợi': 'list', 'Kết quả': 'image', 'Cài đặt': 'sliders' } as const
const run = (f: () => Promise<unknown>): void => void f().catch((e: Error) => alert(e.message))

/** Session facts in the top bar. Wording differs from S1 on purpose (tests and pair-check read S1's exact phrases). */
function Status({ s }: { s: Session | null }): React.JSX.Element {
  if (!s) return <div className="status-line">Đang đọc trạng thái…</div>
  const tab = s.tabs.find((t) => t.granted)
  const n = s.tabs.filter((t) => t.granted).length
  const sc = s.selfCheck
  const linked = s.fake || s.connected === true
  return (
    <div className="status-line" aria-label="Trạng thái phiên">
      <Chip tone={linked ? 'done' : 'attn'}>{s.fake ? 'Chế độ thử (Flow giả)' : linked ? 'Chrome đang nối' : 'Chrome mất nối'}</Chip>
      <Chip tone={tab ? 'done' : 'attn'}>{n > 1 ? `${n} tab Flow` : tab ? `Tab dự án ${tab.projectId?.slice(0, 8) ?? '—'}` : 'Chưa cấp tab'}</Chip>
      {sc && !sc.ok && <Chip tone="attn">{sc.reasons.includes('RELOAD_TAB') ? 'Extension cần tải lại' : `Trang Flow: ${sc.code}`}</Chip>}
      <span>Tự bấm {s.autoEnabled ? 'bật' : 'tắt'}</span>
      <span className="avatar" title={s.email ?? 'chưa đọc được tài khoản'}>{s.email ? s.email.slice(0, 2).toUpperCase() : '—'}</span>
    </div>
  )
}

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<(typeof SCREENS)[number]>('Kết nối')
  const [batches, setBatches] = useState<Batch[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const rev = useRef(0)
  const applied = useRef(new Map<string, number>())

  const [q, setQ] = useState('')
  const [upd, setUpd] = useState<UpdateState | null>(null)
  const [later, setLater] = useState<string | null>(null) // the version the user said "Để sau" to (this session only)
  const [updMsg, setUpdMsg] = useState('')
  useEffect(() => { void window.api.getUpdate().then(setUpd); return window.api.onUpdate((s) => setUpd(s as UpdateState)) }, [])
  const install = (): void => {
    setUpdMsg('')
    void window.api.installUpdate().catch((e: Error) => setUpdMsg(e.message.includes('BATCH_RUNNING')
      ? 'Đang có lượt đang gửi nên app chưa khởi động lại. Bản mới sẽ tự cài khi bạn tắt app, hoặc bấm lại khi lô xong.'
      : 'Chưa cài được bản mới, thử lại sau.'))
  }
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const pickTheme = (t: Theme): void => { setTheme(t); setThemeState(t) }
  const [, osTick] = useState(0)
  useEffect(() => { // 'Theo hệ thống': the CSS follows the OS by itself; this keeps the sun/moon button in step
    const m = matchMedia('(prefers-color-scheme: dark)'), f = (): void => osTick((n) => n + 1)
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [])
  const dark = isDark(theme)
  const [preset, setPreset] = useState<Preset | null>(null) // a saved setup picked on Hàng đợi, applied once by Tạo lô
  const reload = useCallback(() => window.api.listBatches().then((r: { batches: Batch[]; session: Session }) => { setBatches(r.batches); setSession(r.session) }), [])
  // quick start: the preset lands in the saved draft first, so Tạo lô opens with it (NewBatch reads session.draft once)
  const start = (p: Pick<Draft, 'kind' | 'mode'>): void => run(() => window.api.saveDraft(p).then(reload).then(() => setScreen('Tạo lô')))

  useEffect(() => {
    void reload()
    const off = window.api.onState((e) => {
      if (!newer(rev.current, e.revision)) return // older than what we already have
      const missed = e.revision > rev.current + 1
      rev.current = e.revision
      if (missed) return void reload() // lost connection or a gap: re-read everything
      void window.api.getBatch(e.id).then((b: Batch & { revision: number }) => {
        if (!newer(applied.current.get(b.id) ?? 0, b.revision)) return // a newer reply already landed
        applied.current.set(b.id, b.revision)
        setBatches((all) => (all.some((x) => x.id === b.id) ? all.map((x) => (x.id === b.id ? b : x)) : [b, ...all]))
      }).catch(() => void reload())
    })
    const onFocus = (): void => void reload()
    window.addEventListener('focus', onFocus)
    return () => { off(); window.removeEventListener('focus', onFocus) }
  }, [reload])

  // main pushes batch changes but not the session: until Chrome is paired and a tab granted, re-read it so S1 follows what the user does in Chrome
  // shortcut: a lost connection after that shows on the next batch event or window focus; push a session event from main if that proves too late
  const ready = !!session && (session.fake || (session.connected === true && session.tabs.some((t) => t.granted)))
  useEffect(() => {
    if (ready) return
    const t = setInterval(() => void reload(), 3000)
    return () => clearInterval(t)
  }, [ready, reload])

  const active = batches.filter((b) => !b.archived && ACTIVE.includes(b.status))
  // items that wait for the human (click Gửi, confirm, fix): the count stays on the nav until they are resolved
  const needYou = batches.filter((b) => !b.archived).reduce((n, b) => n + b.items.filter((it) => ['wait', 'attn'].includes(itemTone(current(it)))).length, 0)
  const navItem = (s: (typeof SCREENS)[number]): React.JSX.Element => (
    <button key={s} aria-label={s} aria-current={screen === s ? 'page' : undefined} onClick={() => setScreen(s)}>
      <Icon name={ICON[s]} /><span>{s}</span>{s === 'Hàng đợi' && needYou > 0 && <span className="count" aria-hidden="true">{needYou}</span>}
    </button>
  )
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand"><h1>ToolFlow</h1></div>
        <nav aria-label="Màn hình">
          {SCREENS.slice(0, 5).map(navItem)}
        </nav>
        {active.length > 0 && (
          <section aria-label="Đang chạy" className="running">
            <h2>Đang chạy</h2>
            {active.map((b) => {
              const done = b.items.filter((it) => current(it).item === 'ready').length
              return (
                <div key={b.id} className="run">
                  <div className="run-head"><Icon name="layers" /><span>Lô {b.id.slice(0, 8)}</span><span className="num">{done}/{b.items.length}</span></div>
                  <Chip tone={batchTone(b.status)}>{BATCH_LABEL[b.status]}</Chip>
                  <div className="actions">
                    {b.status === 'paused'
                      ? <button onClick={() => run(() => window.api.resumeBatch(b.id))}>Tiếp tục</button>
                      : <button onClick={() => run(() => window.api.pauseBatch(b.id))}>Tạm dừng</button>}
                    <button onClick={() => run(() => window.api.stopBatch(b.id))}>Dừng</button>
                  </div>
                </div>
              )
            })}
          </section>
        )}
        <nav aria-label="Cài đặt" className="foot">{navItem('Cài đặt')}</nav>
      </aside>
      <div className="work">
        <header className="topbar">
          <span className="topbar-title">{screen}</span>
          {(screen === 'Hàng đợi' || screen === 'Kết quả') && (
            <label className="search"><Icon name="search" /><input type="search" aria-label="Tìm prompt hoặc lô" placeholder="Tìm prompt, mã lô…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          )}
          {(upd?.state === 'downloading' || upd?.state === 'available') && <span className="muted small-text" role="status">Đang tải bản {upd.version}{upd.percent !== undefined ? ` · ${upd.percent}%` : '…'}</span>}
          <button className="icon-btn" aria-label={dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'} title={dark ? 'Giao diện sáng' : 'Giao diện tối'} onClick={() => pickTheme(dark ? 'light' : 'dark')}>
            <Icon name={dark ? 'sun' : 'moon'} />
          </button>
          <Status s={session} />
        </header>
        {upd?.state === 'ready' && later !== upd.version && (
          <div className="update-bar" role="status">
            <span>Bản mới <b>{upd.version}</b> đã tải xong. Khởi động lại để cập nhật — lô và kết quả của bạn được giữ nguyên.</span>
            <span className="spacer" />
            <button className="primary small" onClick={install}>Khởi động lại để cập nhật</button>
            <button className="small" onClick={() => setLater(upd.version ?? null)}>Để sau</button>
            {updMsg && <span className="update-msg" role="alert">{updMsg}</span>}
          </div>
        )}
        <main className={screen === 'Workflow' ? 'page flush' : 'page'} key={screen}>{/* a new screen starts at the top, not at the last one's scroll */}
          {screen === 'Kết nối' && <SessionScreen s={session} reload={() => void reload()} />}
          {screen === 'Tạo lô' && session && <NewBatch initial={session.draft} preset={preset} onDraft={(dr) => setSession((x) => x && { ...x, draft: dr })} onCreated={() => { setPreset(null); setScreen('Hàng đợi'); void reload() }} />}
          {screen === 'Workflow' && session && <Workflow s={session} />}
          {screen === 'Hàng đợi' && <Queue batches={batches} q={q} onNew={() => setScreen('Tạo lô')} onStart={start} onPreset={(p) => { setPreset(p); setScreen('Tạo lô') }} />}
          {screen === 'Kết quả' && <Results batches={batches} q={q} />}
          {screen === 'Cài đặt' && session && <Settings s={session} reload={() => void reload()} theme={theme} onTheme={pickTheme} upd={upd} onUpd={setUpd} onInstall={install} />}
        </main>
      </div>
    </div>
  )
}

export default App
