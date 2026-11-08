import { useCallback, useEffect, useRef, useState } from 'react'
import { ACTIVE, BATCH_LABEL, type Batch, type Session } from './types'
import SessionScreen from './screens/Session'
import NewBatch from './screens/NewBatch'
import Queue from './screens/Queue'
import Results from './screens/Results'
import Settings from './screens/Settings'
import { newer } from './revision'

const SCREENS = ['Kết nối', 'Tạo lô', 'Hàng đợi', 'Kết quả', 'Cài đặt'] as const
const run = (f: () => Promise<unknown>): void => void f().catch((e: Error) => alert(e.message))

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
  return (
    <main>
      <h1>ToolFlow</h1>
      {active.length > 0 && (
        <section aria-label="Đang chạy" className="box">
          {active.map((b) => (
            <div key={b.id}>
              Lô {b.id.slice(0, 8)}: {BATCH_LABEL[b.status]}{' '}
              {b.status === 'paused'
                ? <button onClick={() => run(() => window.api.resumeBatch(b.id))}>Tiếp tục</button>
                : <button onClick={() => run(() => window.api.pauseBatch(b.id))}>Tạm dừng</button>}{' '}
              <button onClick={() => run(() => window.api.stopBatch(b.id))}>Dừng</button>
            </div>
          ))}
        </section>
      )}
      <nav aria-label="Màn hình">
        {SCREENS.map((s) => <button key={s} aria-current={screen === s ? 'page' : undefined} onClick={() => setScreen(s)}>{s}</button>)}
      </nav>
      {screen === 'Kết nối' && <SessionScreen s={session} />}
      {screen === 'Tạo lô' && session && <NewBatch initial={session.draft} onCreated={() => { setScreen('Hàng đợi'); reload() }} />}
      {screen === 'Hàng đợi' && <Queue batches={batches} />}
      {screen === 'Kết quả' && <Results batches={batches} />}
      {screen === 'Cài đặt' && session && <Settings s={session} reload={reload} />}
    </main>
  )
}

export default App
