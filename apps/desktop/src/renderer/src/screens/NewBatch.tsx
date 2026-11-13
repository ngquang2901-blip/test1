import { useEffect, useRef, useState } from 'react'
import type { Draft, Preset } from '../types'
import TemplateBuilder, { EMPTY_TEMPLATE, type TemplateState } from './TemplateBuilder'
import { ComboFields, choicesOf, comboLabel, defaultCombo, withChange, type Combo } from '../combo'
import { csvMsg, fillRows, readCsv } from '../csv'

type Row = { n: number; prompt: string; refs: string[]; error: string | null }
type Asset = { id: string; name: string; bytes: number }
type RefMode = 'none' | 'sequential' | 'all'
const MAP_ERR: Record<string, string> = { NOT_ENOUGH_REFS: 'Thiếu ảnh', TOO_MANY_REFS: 'Quá nhiều ảnh' }
const PICK_ERR: Record<string, string> = { ASSET_UNSUPPORTED: 'không phải ảnh png/jpg/webp', ASSET_EMPTY: 'file trống', ASSET_TOO_LARGE: 'quá 20 MB', ASSET_UNREADABLE: 'không đọc được' }
const size = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
let kept: Asset[] = [] // shortcut: the picked pool outlives screen switches but not a restart; persist ids in draft.json when it must
let keptTpl: TemplateState = EMPTY_TEMPLATE // same lifetime as the pool
type Provider = 'flow' | 'chatgpt' | 'gemini'
const SITE: Record<Exclude<Provider, 'flow'>, { name: string; tool: string; note: string }> = {
  chatgpt: { name: 'ChatGPT', tool: 'Create image', note: 'Mỗi lô mở một cuộc trò chuyện mới trong tab chatgpt.com đang mở, app tự gửi lần lượt từng prompt ở chế độ “Create image” và lưu ảnh về máy. Cần tab ChatGPT đã đăng nhập, giao diện tiếng Anh. Muốn tỉ lệ khung hình nào thì ghi ngay trong prompt.' },
  gemini: { name: 'Gemini', tool: 'Tạo hình ảnh', note: 'Mỗi lô mở một cuộc trò chuyện mới trong tab gemini.google.com đang mở, app tự bật công cụ tạo hình ảnh, gửi lần lượt từng prompt và lưu ảnh cỡ đầy đủ về máy. Cần tab Gemini đã đăng nhập. Chọn mô hình ở đây thì tab Gemini cũng đổi sang mô hình đó.' },
}
const GEM_ASPECTS = ['1:1', '9:16', '3:4', '4:3', '16:9']
let keptAspect = '' // Gemini's aspect ratio for this batch; '' = whatever is chosen in Gemini
const GEM_MODELS = ['Flash-Lite', 'Flash', 'Pro']
let keptModel = '' // …and its model, the same way
let keptProvider: Provider = 'flow' // the site this batch goes to; same lifetime as the pool
let keptCombo: Partial<Record<Draft['kind'], Combo>> = {} // the settings chosen per kind (absent = the app default); same lifetime as the pool

export default function NewBatch({ initial, onCreated, preset, onDraft }: { initial: Draft; onCreated(): void; preset?: Preset | null; onDraft?(d: Draft): void }): React.JSX.Element {
  const [d, setD] = useState<Draft>(initial)
  const [rows, setRows] = useState<Row[]>([])
  const [msg, setMsg] = useState('')
  const [pool, setPool] = useState<Asset[]>(kept)
  const [tpl, setTpl] = useState<TemplateState>(keptTpl)
  const [refMode, setRefMode] = useState<RefMode>('none')
  const [perItem, setPerItem] = useState(1)
  const [endFrame, setEndFrame] = useState(false) // a video's second image is its end frame
  const [combos, setCombos] = useState(keptCombo)
  const [provider, setProv] = useState(keptProvider)
  const setProvider = (p: Provider): void => { keptProvider = p; setProv(p) }
  const gpt = provider !== 'flow' // a chat site (ChatGPT, Gemini): images only, always sent by the app, no Flow settings
  const site = provider !== 'flow' ? SITE[provider] : null
  const gem = provider === 'gemini' // Gemini also takes reference images and an aspect ratio
  const [aspect, setAsp] = useState(keptAspect)
  const setAspect = (a: string): void => { keptAspect = a; setAsp(a) }
  const [model, setMod] = useState(keptModel)
  const setModel = (m: string): void => { keptModel = m; setMod(m) }
  const putCombo = (kind: Draft['kind'], c: Combo | undefined): void => { keptCombo = { ...keptCombo, [kind]: c }; setCombos(keptCombo) }
  const chosen = combos[d.kind], combo = chosen ?? defaultCombo(d.kind) // what this batch will be sent with
  const [errs, setErrs] = useState<{ index: number; code: string }[]>([])
  const pickBtn = useRef<HTMLButtonElement>(null)
  const [cmd, setCmd] = useState(() => crypto.randomUUID()) // same id on a double click = one batch
  const set = (p: Partial<Draft>): void => setD((x) => ({ ...x, ...p }))
  const [presets, setPresets] = useState<Preset[]>([])
  const [naming, setNaming] = useState<string | null>(null) // the name being typed for "Lưu làm mẫu"
  const loadPresets = (): void => void window.api.listPresets().then(setPresets, () => setPresets([]))
  useEffect(loadPresets, [])
  /** A saved setup: kind, mode, settings, refs and template come back; the prompt list stays what it is. */
  const applyPreset = (p: Preset): void => {
    set({ kind: p.kind, mode: p.mode }); setProvider('flow') // a saved setup is a Flow setup
    putCombo(p.kind, p.combo && choicesOf(p.kind).some((c) => c.model === p.combo!.model) ? withChange(p.combo, {}) : undefined) // a setup older than the profile: what is no longer offered falls back
    const ok = p.refs.assets.filter((a) => !a.missing)
    keep(ok); setRefMode(p.refs.mode); setPerItem(p.refs.perItem); setEndFrame(p.refs.perItem === 2)
    keptTpl = p.template; setTpl(p.template)
    setMsg(ok.length < p.refs.assets.length ? `${p.refs.assets.length - ok.length} ảnh tham chiếu của mẫu “${p.name}” không còn trong app, đã bỏ qua — chọn lại ảnh nếu cần.` : '')
  }
  useEffect(() => { if (preset) applyPreset(preset) }, [preset]) // eslint-disable-line react-hooks/exhaustive-deps -- once per preset handed over from Hàng đợi
  const savePreset = async (name: string): Promise<void> => {
    try {
      await window.api.savePreset({ name, kind: d.kind, mode: d.mode, ...(chosen ? { combo: chosen } : {}), refs: { assetIds: pool.map((a) => a.id), mode: refMode, perItem }, template: tpl })
      setNaming(null); setMsg(''); loadPresets()
    } catch { setMsg('Không lưu được mẫu: tên cần 1–60 ký tự.') }
  }

  const video = !gpt && d.kind === 'video' // a chat site's batch is always images
  const refs = { assetIds: pool.map((a) => a.id), mode: refMode, perItem: video ? (endFrame ? 2 : 1) : perItem } // a video takes its start frame, and with the box its end frame
  const refsKey = JSON.stringify(refs), comboKey = JSON.stringify(chosen ?? null)
  /** What goes to main for this batch (preview and create alike). */
  const args = (r: unknown): object => (gpt ? { text: d.text, kind: 'image', mode: 'auto', provider, commandId: cmd, refs: r, ...(gem && aspect ? { aspect } : {}), ...(gem && model ? { model } : {}) } : { ...d, commandId: cmd, refs: r, ...(chosen ? { combo: chosen } : {}) })
  useEffect(() => {
    let live = true
    window.api.enqueueBatch({ ...args(JSON.parse(refsKey)), dryRun: true }).then((r: { rows: Row[]; errors: { index: number; code: string }[] }) => { if (live) { setRows(r.rows); setErrs(r.errors.filter((e) => e.code in MAP_ERR)) } }, () => { if (live) { setRows([]); setErrs([]) } })
    onDraft?.(d) // the app's copy follows at once: coming back to Tạo lô shows this text, not the last one read from main
    const t = setTimeout(() => void window.api.saveDraft(d), 400)
    return () => { live = false; clearTimeout(t) }
  }, [d, cmd, refsKey, comboKey, provider, aspect, model]) // eslint-disable-line react-hooks/exhaustive-deps -- onDraft is a fresh closure each render

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
  // CSV: one column becomes the prompt list at once, or '' = the columns are the {variables} of the template box above
  const [csv, setCsv] = useState<string[][] | null>(null)
  const [col, setCol] = useState('')
  const [csvErr, setCsvErr] = useState('')
  const fromColumn = (rows: string[][], c: string): void => { // shortcut: a header over 40 characters cannot be a {variable}; rename the column in the file
    setCol(c)
    if (!c) return setCsvErr('')
    const r = fillRows(`{${c}}`, rows)
    setCsvErr('error' in r ? csvMsg(r.error) : '')
    if ('prompts' in r) set({ text: r.prompts.join('\n') })
  }
  const loadCsv = async (f?: File): Promise<void> => {
    if (!f) return
    const r = readCsv(await f.arrayBuffer())
    setCsv('rows' in r ? r.rows : null)
    if ('error' in r) return setCsvErr(csvMsg(r.error))
    fromColumn(r.rows, r.rows[0][0].trim())
  }
  const create = async (): Promise<void> => {
    try {
      const r = await window.api.enqueueBatch(args(refs))
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
      <TemplateBuilder value={tpl} onChange={(t) => { keptTpl = t; setTpl(t) }} hasText={d.text.trim() !== ''} onApply={(ps) => set({ text: ps.join('\n') })} table={csv && !col ? csv : null} />
      <div>
        <label className="field-label" htmlFor="prompts">Danh sách prompt</label>
        <textarea id="prompts" value={d.text} onChange={(e) => set({ text: e.target.value })} placeholder="Mỗi dòng một prompt" />
        <div className="toolbar small-text muted">
          <label className="filebtn">Nạp file TXT<input type="file" accept=".txt,text/plain" onChange={(e) => void file(e.target.files?.[0])} /></label>
          <label className="filebtn">Nạp file CSV<input type="file" accept=".csv,text/csv" onChange={(e) => { void loadCsv(e.target.files?.[0]); e.target.value = '' }} /></label>
          {csv && (
            <>
              <select aria-label="Lấy prompt từ cột" value={col} onChange={(e) => fromColumn(csv, e.target.value)}>
                {csv[0].map((h, i) => <option key={i} value={h.trim()}>Cột “{h.trim()}”</option>)}
                <option value="">Ghép nhiều cột bằng mẫu ở trên</option>
              </select>
              <button className="small x" aria-label="Bỏ file CSV" onClick={() => { setCsv(null); setCsvErr('') }}>×</button>
            </>
          )}
          <span className="spacer" />
          <span><span className="num">{rows.length}</span> prompt</span>
        </div>
        {csvErr && <p role="alert" className="notice" data-testid="csv-error">{csvErr}</p>}
      </div>
      <div className="choices">
        <fieldset className="wide">
          <legend>Nền tảng</legend>
          <label><input type="radio" name="provider" checked={!gpt} onChange={() => setProvider('flow')} /> Google Flow</label>
          <label><input type="radio" name="provider" checked={provider === 'chatgpt'} onChange={() => setProvider('chatgpt')} /> ChatGPT (tạo ảnh)</label>
          <label><input type="radio" name="provider" checked={provider === 'gemini'} onChange={() => setProvider('gemini')} /> Gemini (tạo ảnh)</label>
          {site && <p className="hint" data-testid="gpt-note">{site.note}</p>}
        </fieldset>
        {!gpt && <fieldset>
          <legend>Loại (mỗi lô một loại)</legend>
          <label><input type="radio" name="kind" checked={d.kind === 'image'} onChange={() => set({ kind: 'image' })} /> Ảnh</label>
          <label><input type="radio" name="kind" checked={d.kind === 'video'} onChange={() => set({ kind: 'video' })} /> Video</label>
        </fieldset>}
        {!gpt && <fieldset>
          <legend>Chế độ gửi</legend>
          <label><input type="radio" name="mode" checked={d.mode === 'auto'} onChange={() => set({ mode: 'auto' })} /> Tự động</label>
          <label><input type="radio" name="mode" checked={d.mode === 'manual'} onChange={() => set({ mode: 'manual' })} /> Thủ công (bạn bấm Gửi trong Flow)</label>
        </fieldset>}
        {!gpt && combo && (
          <fieldset className="wide" data-testid="batch-settings">
            <legend>{d.kind === 'video' ? 'Cài đặt tạo video' : 'Cài đặt tạo ảnh'}</legend>
            <div className="combo-row">
              <ComboFields value={combo} onChange={(c) => putCombo(d.kind, c)} />
              {chosen && <button className="small" onClick={() => putCombo(d.kind, undefined)}>Về mặc định</button>}
            </div>
            <p className="hint">Trước khi gửi, app tự chọn đúng các mục này trong Flow; Flow không nhận thì dòng đó dừng lại, không gửi bằng cài đặt khác.</p>
          </fieldset>
        )}
        {gem && <fieldset>
          <legend>Mô hình</legend>
          <select aria-label="Mô hình Gemini" data-testid="gem-model" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Theo Gemini (cái đang chọn trong tab)</option>
            {GEM_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </fieldset>}
        {gem && <fieldset>
          <legend>Tỉ lệ khung hình</legend>
          <select aria-label="Tỉ lệ khung hình" data-testid="gem-aspect" value={aspect} onChange={(e) => setAspect(e.target.value)}>
            <option value="">Theo Gemini (cái đang chọn trong tab)</option>
            {GEM_ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </fieldset>}
        <fieldset aria-label={video ? 'Khung hình đầu' : 'Ảnh tham chiếu'} className="wide">
          <legend>{video ? (endFrame ? 'Khung hình đầu và cuối (ảnh 1 mở đầu, ảnh 2 kết thúc video)' : 'Khung hình đầu (video bắt đầu từ ảnh này)') : 'Ảnh tham chiếu'}</legend>
          <div className="status">
              <div className="toolbar">
                <button ref={pickBtn} className="small" onClick={() => void pick()}>Chọn ảnh…</button>
                <ul aria-label="Ảnh đã chọn" data-testid="pool" className="pool">
                  {pool.map((a) => <li key={a.id}>{a.name} · {size(a.bytes)} <button className="small" aria-label={`Bỏ ảnh ${a.name}`} onClick={() => remove(a.id)}>Bỏ ảnh</button></li>)}
                </ul>
              </div>
              <div>
                <label><input type="radio" name="refmode" checked={refMode === 'none'} onChange={() => setRefMode('none')} /> Không dùng</label>
                <label><input type="radio" name="refmode" checked={refMode === 'sequential'} onChange={() => setRefMode('sequential')} /> {video ? (endFrame ? 'Mỗi prompt hai ảnh theo thứ tự' : 'Mỗi prompt một ảnh theo thứ tự') : 'Mỗi prompt một nhóm ảnh theo thứ tự'}</label>
                <label><input type="radio" name="refmode" checked={refMode === 'all'} onChange={() => setRefMode('all')} /> {video ? (endFrame ? 'Dùng chung hai ảnh cho mọi prompt' : 'Dùng chung một ảnh cho mọi prompt') : 'Dùng chung tất cả ảnh cho mọi prompt'}</label>
                {video && <label><input type="checkbox" checked={endFrame} onChange={(e) => setEndFrame(e.target.checked)} /> Có khung hình cuối (ảnh thứ hai của mỗi prompt)</label>}
                {!video && <label>Số ảnh tham chiếu mỗi prompt <input type="number" min={1} max={10} value={perItem} onChange={(e) => setPerItem(Math.min(10, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))} /></label>}
              </div>
          </div>
        </fieldset>
      </div>
      {errs.length > 0 && (
        <p role="alert" className="notice" data-testid="map-errors">
          {errs.some((e) => e.code === 'NOT_ENOUGH_REFS') && <>Thiếu ảnh cho prompt nào: {errs.filter((e) => e.code === 'NOT_ENOUGH_REFS').map((e) => `#${e.index + 1}`).join(', ')}. </>}
          {errs.some((e) => e.code === 'TOO_MANY_REFS') && <>{video ? `Quá nhiều ảnh: mỗi video dùng ${endFrame ? 'hai ảnh' : 'một ảnh'}, bỏ bớt ảnh hoặc chọn “Mỗi prompt ${endFrame ? 'hai ảnh' : 'một ảnh'} theo thứ tự”. ` : 'Quá nhiều ảnh: tăng “Số ảnh tham chiếu mỗi prompt” hoặc bỏ bớt ảnh. '}</>}
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
        <span className="muted small-text" data-testid="combo">{site ? `Sẽ gửi: ${site.name} · ${site.tool}${gem && model ? ` · ${model}` : ''}${gem && aspect ? ` · ${aspect}` : ''} · tự động` : combo ? `Sẽ gửi: ${d.kind === 'video' ? 'Video' : 'Ảnh'} · ${comboLabel(combo)}` : ''}</span>
        <span className="spacer" />
        <button className="primary" onClick={() => void create()} disabled={rows.length === 0 || errs.length > 0}>Tạo lô và chạy</button>
      </div>
    </section>
  )
}
