import { useCallback, useEffect, useRef, useState } from 'react'
import { ACTIVE, BATCH_LABEL, current, type Batch, type Session } from './types'
import SessionScreen from './screens/Session'
import NewBatch from './screens/NewBatch'
import Queue from './screens/Queue'
import Results from './screens/Results'
import Settings from './screens/Settings'
import { newer } from './revision'
import { Chip, RegMark, batchTone, itemTone } from './ui'

const SCREENS = ['Kết nối', 'Tạo lô', 'Hàng đợi', 'Kết quả', 'Cài đặt'] as const
const run = (f: () => Promise<unknown>): void => void f().catch((e: Error) => alert(e.message))

/** The proof's slug line: the job's facts in one strip. Wording differs from S1 on purpose (tests and pair-check read S1's exact phrases). */
function Slug({ s }: { s: Session | null }): React.JSX.Element {
  if (!s) return <div className="slug">Đang đọc trạng thái…</div>
  const tab = s.tabs.find((t) => t.granted)
  const sc = s.selfCheck
  const linked = s.fake || s.connected === true
  return (
    <div className="slug" aria-label="Trạng thái phiên">
      <span className="reg"><RegMark on={linked} /> {s.fake ? 'Chế độ thử (Flow giả)' : linked ? 'Chrome đang nối' : 'Chrome mất nối'}</span>
      <span>Tab: {tab ? <b>dự án {tab.projectId?.slice(0, 8) ?? '—'}</b> : <span className="bad">chưa cấp</span>}</span>
      <span>Tài khoản: <b>{s.email ?? '—'}</b></span>
      <span>Trang Flow: {sc === null ? '—' : sc.ok ? <b>ổn</b> : <span className="bad">{sc.code}</span>}</span>
      <span>Tự bấm: <b>{s.autoEnabled ? 'bật' : 'tắt'}</b></span>
    </div>
  )
}

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<(typeof SCREENS)[number]>('Kết nối')
  const [batches, setBatches] = useState<Batch[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const rev = useRef(0)
  const applied = useRef(new Map<string, number>())

  const reload = useCallback(() => {
    void window.api.listBatches().then((r: { batches: Batch[]; session: Session }) => { setBatches(r.batches); setSession(r.session) })
  }, [])

  useEffect(() => {
    reload()
    const off = window.api.onState((e) => {
      if (!newer(rev.current, e.revision)) return // older than what we already have
      const missed = e.revision > rev.current + 1
      rev.current = e.revision
      if (missed) return reload() // lost connection or a gap: re-read everything
      void window.api.getBatch(e.id).then((b: Batch & { revision: number }) => {
        if (!newer(applied.current.get(b.id) ?? 0, b.revision)) return // a newer reply already landed
        applied.current.set(b.id, b.revision)
        setBatches((all) => (all.some((x) => x.id === b.id) ? all.map((x) => (x.id === b.id ? b : x)) : [b, ...all]))
      }).catch(() => reload())
    })
    window.addEventListener('focus', reload)
    return () => { off(); window.removeEventListener('focus', reload) }
  }, [reload])

  const active = batches.filter((b) => !b.archived && ACTIVE.includes(b.status))
  // items that wait for the human (click Gửi, confirm, fix): the count stays on the nav until they are resolved
  const needYou = batches.filter((b) => !b.archived).reduce((n, b) => n + b.items.filter((it) => ['wait', 'attn'].includes(itemTone(current(it)))).length, 0)
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand"><RegMark on light size={22} /><h1>ToolFlow</h1></div>
        <nav aria-label="Màn hình">
          {SCREENS.map((s) => (
            <button key={s} aria-label={s} aria-current={screen === s ? 'page' : undefined} onClick={() => setScreen(s)}>
              {s}{s === 'Hàng đợi' && needYou > 0 && <span className="count" aria-hidden="true">{needYou}</span>}
            </button>
          ))}
        </nav>
        {active.length > 0 && (
          <section aria-label="Đang chạy" className="running">
            <h2>Đang chạy</h2>
            {active.map((b) => {
              const done = b.items.filter((it) => current(it).item === 'ready').length
              return (
                <div key={b.id} className="run">
                  <div className="run-head"><span>Lô <b>{b.id.slice(0, 8)}</b></span><span className="num">{done}/{b.items.length}</span></div>
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
      </aside>
      <div className="work">
        <Slug s={session} />
        <main className="page">
          {screen === 'Kết nối' && <SessionScreen s={session} reload={reload} />}
          {screen === 'Tạo lô' && session && <NewBatch initial={session.draft} onCreated={() => { setScreen('Hàng đợi'); reload() }} />}
          {screen === 'Hàng đợi' && <Queue batches={batches} />}
          {screen === 'Kết quả' && <Results batches={batches} />}
          {screen === 'Cài đặt' && session && <Settings s={session} reload={reload} />}
        </main>
      </div>
    </div>
  )
}

export default App
