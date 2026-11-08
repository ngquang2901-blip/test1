import { useEffect, useRef, useState } from 'react'
import type { Draft } from '../types'
import flow from '../../../../profiles/flow.json'

const C = flow.combos[0] // the one qualified combo; no user choice yet
const COMBO_LABEL = `Chế độ đã qualify: Ảnh · ${C.model} · ${C.aspect} · ${C.quality} · x${C.count}`

type Row = { n: number; prompt: string; refs: string[]; error: string | null }
type Asset = { id: string; name: string; bytes: number }
type RefMode = 'none' | 'sequential' | 'all'
const MAP_ERR: Record<string, string> = { NOT_ENOUGH_REFS: 'Thiếu ảnh', TOO_MANY_REFS: 'Quá nhiều ảnh' }
const PICK_ERR: Record<string, string> = { ASSET_UNSUPPORTED: 'không phải ảnh png/jpg/webp', ASSET_EMPTY: 'file trống', ASSET_TOO_LARGE: 'quá 20 MB', ASSET_UNREADABLE: 'không đọc được' }
const size = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
let kept: Asset[] = [] // shortcut: the picked pool outlives screen switches but not a restart; persist ids in draft.json when it must

export default function NewBatch({ initial, onCreated }: { initial: Draft; onCreated(): void }): React.JSX.Element {
  const [d, setD] = useState<Draft>(initial)
  const [rows, setRows] = useState<Row[]>([])
  const [msg, setMsg] = useState('')
  const [pool, setPool] = useState<Asset[]>(kept)
  const [refMode, setRefMode] = useState<RefMode>('none')
  const [perItem, setPerItem] = useState(1)
  const [errs, setErrs] = useState<{ index: number; code: string }[]>([])
  const pickBtn = useRef<HTMLButtonElement>(null)
  const [cmd, setCmd] = useState(() => crypto.randomUUID()) // same id on a double click = one batch
  const set = (p: Partial<Draft>): void => setD((x) => ({ ...x, ...p }))

  const refs = d.kind === 'image' ? { assetIds: pool.map((a) => a.id), mode: refMode, perItem } : { assetIds: [], mode: 'none', perItem: 1 } // video refs are not supported in P2
  const refsKey = JSON.stringify(refs)
  useEffect(() => {
    let live = true
    window.api.enqueueBatch({ ...d, commandId: cmd, refs: JSON.parse(refsKey), dryRun: true }).then((r: { rows: Row[]; errors: { index: number; code: string }[] }) => { if (live) { setRows(r.rows); setErrs(r.errors.filter((e) => e.code in MAP_ERR)) } }, () => { if (live) { setRows([]); setErrs([]) } })
    const t = setTimeout(() => void window.api.saveDraft(d), 400)
    return () => { live = false; clearTimeout(t) }
  }, [d, cmd, refsKey])

  const keep = (p: Asset[]): void => { kept = p; setPool(p) }
  const pick = async (): Promise<void> => {
    const r: { assets: Asset[]; errors: { code: string }[] } = await window.api.pickRefs()
    keep([...pool, ...r.assets.filter((a) => !pool.some((x) => x.id === a.id))])
    setMsg(r.errors.length ? `${r.errors.length} file bị bỏ qua: ${[...new Set(r.errors.map((e) => PICK_ERR[e.code] ?? e.code))].join(', ')}.` : '')
  }
  const remove = (id: string): void => { keep(pool.filter((a) => a.id !== id)); pickBtn.current?.focus() } // the removed button is gone: keep focus in the section

  const file = async (f?: File): Promise<void> => {
    if (!f) return
    try { set({ text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await f.arrayBuffer()) }); setMsg('') }
    catch { setMsg('File không phải UTF-8 hợp lệ.') }
  }
  const create = async (): Promise<void> => {
    try {
      const r = await window.api.enqueueBatch({ ...d, commandId: cmd, refs })
      if (!('batchId' in r)) return setMsg('Không tạo được lô: ảnh tham chiếu chưa khớp số prompt.')
      const { batchId } = r
      await window.api.startBatch(batchId)
      setCmd(crypto.randomUUID())
      onCreated()
    } catch (e) { setMsg((e as Error).message.includes('NO_PROJECT_TAB') ? 'Chưa có tab Flow nào được cấp quyền — mở một dự án Flow rồi bấm “Dùng tab này”' : `Không tạo được lô: ${(e as Error).message}`) }
  }

  return (
    <section aria-label="Tạo lô">
      <h2>Tạo lô</h2>
      <label htmlFor="prompts">Danh sách prompt</label>
      <textarea id="prompts" value={d.text} onChange={(e) => set({ text: e.target.value })} placeholder="Mỗi dòng một prompt" />
      <p><label>Nạp file TXT <input type="file" accept=".txt,text/plain" onChange={(e) => void file(e.target.files?.[0])} /></label></p>
      <fieldset>
        <legend>Loại (mỗi lô một loại)</legend>
        <label><input type="radio" name="kind" checked={d.kind === 'image'} onChange={() => set({ kind: 'image' })} /> Ảnh</label>{' '}
        <label><input type="radio" name="kind" checked={d.kind === 'video'} onChange={() => set({ kind: 'video' })} /> Video</label>
      </fieldset>
      <fieldset>
        <legend>Chế độ gửi</legend>
        <label><input type="radio" name="mode" checked={d.mode === 'auto'} onChange={() => set({ mode: 'auto' })} /> Tự động</label>{' '}
        <label><input type="radio" name="mode" checked={d.mode === 'manual'} onChange={() => set({ mode: 'manual' })} /> Thủ công (bạn bấm Gửi trong Flow)</label>
      </fieldset>
      <fieldset aria-label="Ảnh tham chiếu">
        <legend>Ảnh tham chiếu</legend>
        {d.kind === 'video' ? <p>Video chưa hỗ trợ ảnh tham chiếu.</p> : (
          <>
            <button ref={pickBtn} onClick={() => void pick()}>Chọn ảnh…</button>
            <ul aria-label="Ảnh đã chọn" data-testid="pool">
              {pool.map((a) => <li key={a.id}>{a.name} · {size(a.bytes)} <button aria-label={`Bỏ ảnh ${a.name}`} onClick={() => remove(a.id)}>Bỏ ảnh</button></li>)}
            </ul>
            <label><input type="radio" name="refmode" checked={refMode === 'none'} onChange={() => setRefMode('none')} /> Không dùng</label>{' '}
            <label><input type="radio" name="refmode" checked={refMode === 'sequential'} onChange={() => setRefMode('sequential')} /> Mỗi prompt một nhóm ảnh theo thứ tự</label>{' '}
            <label><input type="radio" name="refmode" checked={refMode === 'all'} onChange={() => setRefMode('all')} /> Dùng chung tất cả ảnh cho mọi prompt</label>{' '}
            <label>Số ảnh mỗi prompt <input type="number" min={1} max={8} value={perItem} onChange={(e) => setPerItem(Math.min(8, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))} /></label>
          </>
        )}
      </fieldset>
      {errs.length > 0 && (
        <p role="alert" className="err" data-testid="map-errors">
          {errs.some((e) => e.code === 'NOT_ENOUGH_REFS') && <>Thiếu ảnh cho prompt nào: {errs.filter((e) => e.code === 'NOT_ENOUGH_REFS').map((e) => `#${e.index + 1}`).join(', ')}. </>}
          {errs.some((e) => e.code === 'TOO_MANY_REFS') && <>Quá nhiều ảnh: tăng “Số ảnh mỗi prompt” hoặc bỏ bớt ảnh. </>}
          Sửa cách gán ảnh hoặc chọn “Không dùng” để tạo lô.
        </p>
      )}
      <p data-testid="combo">{COMBO_LABEL}</p>
      <table data-testid="preview" aria-label="Xem trước">
        <thead><tr><th>#</th><th>prompt</th><th>refs</th><th>lỗi</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.n}><td>{r.n}</td><td>{r.prompt}</td><td>{r.refs.length ? r.refs.join(', ') : '—'}</td><td className="err">{r.error && (MAP_ERR[r.error] ?? r.error)}</td></tr>)}</tbody>
      </table>
      {msg && <p role="alert" className="err">{msg}</p>}
      <button onClick={() => void create()} disabled={rows.length === 0 || errs.length > 0}>Tạo lô và chạy</button>
    </section>
  )
}
