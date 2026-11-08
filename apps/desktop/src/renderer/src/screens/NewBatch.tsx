import { useEffect, useState } from 'react'
import type { Draft } from '../types'

type Row = { n: number; prompt: string; refs: string[]; error: string | null }

export default function NewBatch({ initial, onCreated }: { initial: Draft; onCreated(): void }): React.JSX.Element {
  const [d, setD] = useState<Draft>(initial)
  const [rows, setRows] = useState<Row[]>([])
  const [msg, setMsg] = useState('')
  const [cmd, setCmd] = useState(() => crypto.randomUUID()) // same id on a double click = one batch
  const set = (p: Partial<Draft>): void => setD((x) => ({ ...x, ...p }))

  useEffect(() => {
    let live = true
    window.api.enqueueBatch({ ...d, commandId: cmd, dryRun: true }).then((r: { rows: Row[] }) => live && setRows(r.rows), () => live && setRows([]))
    const t = setTimeout(() => void window.api.saveDraft(d), 400)
    return () => { live = false; clearTimeout(t) }
  }, [d, cmd])

  const file = async (f?: File): Promise<void> => {
    if (!f) return
    try { set({ text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await f.arrayBuffer()) }); setMsg('') }
    catch { setMsg('File không phải UTF-8 hợp lệ.') }
  }
  const create = async (): Promise<void> => {
    try {
      const { batchId } = await window.api.enqueueBatch({ ...d, commandId: cmd })
      await window.api.startBatch(batchId)
      setCmd(crypto.randomUUID())
      onCreated()
    } catch (e) { setMsg(`Không tạo được lô: ${(e as Error).message}`) }
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
      <table data-testid="preview" aria-label="Xem trước">
        <thead><tr><th>#</th><th>prompt</th><th>refs</th><th>lỗi</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.n}><td>{r.n}</td><td>{r.prompt}</td><td>{r.refs.length ? r.refs.join(', ') : '—'}</td><td className="err">{r.error}</td></tr>)}</tbody>
      </table>
      {msg && <p role="alert" className="err">{msg}</p>}
      <button onClick={() => void create()} disabled={rows.length === 0}>Tạo lô và chạy</button>
    </section>
  )
}
