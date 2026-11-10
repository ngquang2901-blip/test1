import { useEffect, useRef, useState } from 'react'
import type { Draft, Preset } from '../types'
import TemplateBuilder, { EMPTY_TEMPLATE, type TemplateState } from './TemplateBuilder'
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
let keptTpl: TemplateState = EMPTY_TEMPLATE // same lifetime as the pool

export default function NewBatch({ initial, onCreated, preset, onDraft }: { initial: Draft; onCreated(): void; preset?: Preset | null; onDraft?(d: Draft): void }): React.JSX.Element {
  const [d, setD] = useState<Draft>(initial)
  const [rows, setRows] = useState<Row[]>([])
  const [msg, setMsg] = useState('')
  const [pool, setPool] = useState<Asset[]>(kept)
  const [tpl, setTpl] = useState<TemplateState>(keptTpl)
  const [refMode, setRefMode] = useState<RefMode>('none')
  const [perItem, setPerItem] = useState(1)
  const [errs, setErrs] = useState<{ index: number; code: string }[]>([])
  const pickBtn = useRef<HTMLButtonElement>(null)
  const [cmd, setCmd] = useState(() => crypto.randomUUID()) // same id on a double click = one batch
  const set = (p: Partial<Draft>): void => setD((x) => ({ ...x, ...p }))
  const [presets, setPresets] = useState<Preset[]>([])
  const [naming, setNaming] = useState<string | null>(null) // the name being typed for "Lưu làm mẫu"
  const loadPresets = (): void => void window.api.listPresets().then(setPresets, () => setPresets([]))
  useEffect(loadPresets, [])
  /** A saved setup: kind, mode, refs and template come back; the prompt list stays what it is. */
  const applyPreset = (p: Preset): void => {
    set({ kind: p.kind, mode: p.mode })
    const ok = p.refs.assets.filter((a) => !a.missing)
    keep(ok); setRefMode(p.refs.mode); setPerItem(p.refs.perItem)
    keptTpl = p.template; setTpl(p.template)
    setMsg(ok.length < p.refs.assets.length ? `${p.refs.assets.length - ok.length} ảnh tham chiếu của mẫu “${p.name}” không còn trong app, đã bỏ qua — chọn lại ảnh nếu cần.` : '')
  }
  useEffect(() => { if (preset) applyPreset(preset) }, [preset]) // eslint-disable-line react-hooks/exhaustive-deps -- once per preset handed over from Hàng đợi
  const savePreset = async (name: string): Promise<void> => {
    try {
      await window.api.savePreset({ name, kind: d.kind, mode: d.mode, refs: { assetIds: pool.map((a) => a.id), mode: refMode, perItem }, template: tpl })
      setNaming(null); setMsg(''); loadPresets()
    } catch { setMsg('Không lưu được mẫu: tên cần 1–60 ký tự.') }
  }

  const refs = d.kind === 'image' ? { assetIds: pool.map((a) => a.id), mode: refMode, perItem } : { assetIds: [], mode: 'none', perItem: 1 } // video refs are not supported in P2
  const refsKey = JSON.stringify(refs)
  useEffect(() => {
    let live = true
    window.api.enqueueBatch({ ...d, commandId: cmd, refs: JSON.parse(refsKey), dryRun: true }).then((r: { rows: Row[]; errors: { index: number; code: string }[] }) => { if (live) { setRows(r.rows); setErrs(r.errors.filter((e) => e.code in MAP_ERR)) } }, () => { if (live) { setRows([]); setErrs([]) } })
    onDraft?.(d) // the app's copy follows at once: coming back to Tạo lô shows this text, not the last one read from main
    const t = setTimeout(() => void window.api.saveDraft(d), 400)
    return () => { live = false; clearTimeout(t) }
  }, [d, cmd, refsKey]) // eslint-disable-line react-hooks/exhaustive-deps -- onDraft is a fresh closure each render

  const latest = useRef(d)
  latest.current = d
  useEffect(() => () => void window.api.saveDraft(latest.current), []) // leaving the screen inside the 400 ms debounce must not lose the text
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
      for (const id of (r.batchIds as string[] | undefined) ?? [r.batchId]) await window.api.startBatch(id) // one batch per granted project
      setCmd(crypto.randomUUID())
      onCreated()
    } catch (e) { setMsg((e as Error).message.includes('NO_PROJECT_TAB') ? 'Chưa có tab Flow nào được cấp quyền — mở một dự án Flow rồi bấm “Dùng tab này”' : `Không tạo được lô: ${(e as Error).message}`) }
  }

  return (
    <section aria-label="Tạo lô">
      <h2>Tạo lô</h2>
      <div className="presets toolbar" aria-label="Mẫu lô">
        <span className="muted small-text">Mẫu lô</span>
        {presets.length === 0 && naming === null && <span className="muted small-text">chưa có — chỉnh xong rồi bấm “Lưu làm mẫu”</span>}
        {presets.map((p) => (
          <span key={p.id} className="preset">
            <button className="small" onClick={() => applyPreset(p)}>{p.name}</button>
            <button className="small x" aria-label={`Xoá mẫu ${p.name}`} onClick={() => void window.api.deletePreset(p.id).then(loadPresets)}>×</button>
          </span>
        ))}
        <span className="spacer" />
        {naming === null ? <button className="small" onClick={() => setNaming('')}>Lưu làm mẫu…</button> : (
          <form className="confirm" onSubmit={(e) => { e.preventDefault(); void savePreset(naming) }}>
            <input aria-label="Tên mẫu" autoFocus maxLength={60} value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Tên mẫu" />
            <button className="small primary" type="submit" disabled={!naming.trim()}>Lưu</button>
            <button className="small" type="button" onClick={() => setNaming(null)}>Huỷ</button>
          </form>
        )}
      </div>
      <TemplateBuilder value={tpl} onChange={(t) => { keptTpl = t; setTpl(t) }} hasText={d.text.trim() !== ''} onApply={(ps) => set({ text: ps.join('\n') })} />
      <div>
        <label className="field-label" htmlFor="prompts">Danh sách prompt</label>
        <textarea id="prompts" value={d.text} onChange={(e) => set({ text: e.target.value })} placeholder="Mỗi dòng một prompt" />
        <div className="toolbar small-text muted">
          <label className="filebtn">Nạp file TXT<input type="file" accept=".txt,text/plain" onChange={(e) => void file(e.target.files?.[0])} /></label>
          <span className="spacer" />
          <span><span className="num">{rows.length}</span> prompt</span>
        </div>
      </div>
      <div className="choices">
        <fieldset>
          <legend>Loại (mỗi lô một loại)</legend>
          <label><input type="radio" name="kind" checked={d.kind === 'image'} onChange={() => set({ kind: 'image' })} /> Ảnh</label>
          <label><input type="radio" name="kind" checked={d.kind === 'video'} onChange={() => set({ kind: 'video' })} /> Video</label>
        </fieldset>
        <fieldset>
          <legend>Chế độ gửi</legend>
          <label><input type="radio" name="mode" checked={d.mode === 'auto'} onChange={() => set({ mode: 'auto' })} /> Tự động</label>
          <label><input type="radio" name="mode" checked={d.mode === 'manual'} onChange={() => set({ mode: 'manual' })} /> Thủ công (bạn bấm Gửi trong Flow)</label>
        </fieldset>
        <fieldset aria-label="Ảnh tham chiếu" className="wide">
          <legend>Ảnh tham chiếu</legend>
          {d.kind === 'video' ? <p className="muted">Video chưa hỗ trợ ảnh tham chiếu.</p> : (
            <div className="status">
              <div className="toolbar">
                <button ref={pickBtn} className="small" onClick={() => void pick()}>Chọn ảnh…</button>
                <ul aria-label="Ảnh đã chọn" data-testid="pool" className="pool">
                  {pool.map((a) => <li key={a.id}>{a.name} · {size(a.bytes)} <button className="small" aria-label={`Bỏ ảnh ${a.name}`} onClick={() => remove(a.id)}>Bỏ ảnh</button></li>)}
                </ul>
              </div>
              <div>
                <label><input type="radio" name="refmode" checked={refMode === 'none'} onChange={() => setRefMode('none')} /> Không dùng</label>
                <label><input type="radio" name="refmode" checked={refMode === 'sequential'} onChange={() => setRefMode('sequential')} /> Mỗi prompt một nhóm ảnh theo thứ tự</label>
                <label><input type="radio" name="refmode" checked={refMode === 'all'} onChange={() => setRefMode('all')} /> Dùng chung tất cả ảnh cho mọi prompt</label>
                <label>Số ảnh mỗi prompt <input type="number" min={1} max={8} value={perItem} onChange={(e) => setPerItem(Math.min(8, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))} /></label>
              </div>
            </div>
          )}
        </fieldset>
      </div>
      {errs.length > 0 && (
        <p role="alert" className="notice" data-testid="map-errors">
          {errs.some((e) => e.code === 'NOT_ENOUGH_REFS') && <>Thiếu ảnh cho prompt nào: {errs.filter((e) => e.code === 'NOT_ENOUGH_REFS').map((e) => `#${e.index + 1}`).join(', ')}. </>}
          {errs.some((e) => e.code === 'TOO_MANY_REFS') && <>Quá nhiều ảnh: tăng “Số ảnh mỗi prompt” hoặc bỏ bớt ảnh. </>}
          Sửa cách gán ảnh hoặc chọn “Không dùng” để tạo lô.
        </p>
      )}
      {rows.length > 0 && (
        <div className="panel">
          <table data-testid="preview" aria-label="Xem trước">
            <thead><tr><th className="n">#</th><th>Prompt</th><th>Ảnh tham chiếu</th><th>Lỗi</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.n} data-tone={r.error ? 'attn' : undefined}><td className="n">{r.n}</td><td className="prompt">{r.prompt}</td><td className="small-text">{r.refs.length ? r.refs.join(', ') : '—'}</td><td className="err">{r.error && (MAP_ERR[r.error] ?? r.error)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {msg && <p role="alert" className="notice">{msg}</p>}
      <div className="actionbar">
        <span className="muted small-text" data-testid="combo">{COMBO_LABEL}</span>
        <span className="spacer" />
        <button className="primary" onClick={() => void create()} disabled={rows.length === 0 || errs.length > 0}>Tạo lô và chạy</button>
      </div>
    </section>
  )
}
