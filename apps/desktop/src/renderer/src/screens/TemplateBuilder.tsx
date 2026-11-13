import { useEffect, useState } from 'react'
import { expand, valuesOf, varsOf, MAX_PROMPTS, type ExpandError } from '../template'
import { csvMsg, fillRows, type CsvError } from '../csv'

const ERR = (e: ExpandError): string =>
  e.code === 'NO_VARS' ? 'Mẫu chưa có biến nào. Viết tên biến trong dấu ngoặc nhọn, ví dụ {món ăn}.'
  : e.code === 'EMPTY_VAR' ? `Biến {${e.name}} chưa có giá trị nào.`
  : e.code === 'ZIP_LENGTH' ? `Ghép theo dòng cần mọi danh sách dài bằng nhau; {${e.name}} đang khác.`
  : `${e.count} tổ hợp là quá nhiều (tối đa ${MAX_PROMPTS}). Bớt giá trị hoặc dùng “Ghép theo dòng”.`

export type TemplateState = { template: string; lists: Record<string, string>; how: 'all' | 'zip' }
export const EMPTY_TEMPLATE: TemplateState = { template: '', lists: {}, how: 'all' }

/** "{món ăn} ở {nơi}" + one value list per variable -> the prompt list (replaces what is in it, the button says so). table: a loaded CSV whose columns are the variables, one prompt per row. */
export default function TemplateBuilder({ value, onChange, onApply, hasText, table }: { value: TemplateState; onChange: (t: TemplateState) => void; onApply: (prompts: string[]) => void; hasText: boolean; table?: string[][] | null }): React.JSX.Element {
  const [open, setOpen] = useState(value.template !== '')
  useEffect(() => { if (table) setOpen(true) }, [table])
  const names = table ? [] : varsOf(value.template)
  const r = !value.template.trim() ? null : table ? fillRows(value.template, table) : expand(value.template, Object.fromEntries(names.map((n) => [n, valuesOf(value.lists[n] ?? '')])), value.how)
  const set = (p: Partial<TemplateState>): void => onChange({ ...value, ...p })
  return (
    <details className="panel builder" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Ghép prompt từ mẫu</summary>
      <div className="panel-body">
        <label className="small-text" htmlFor="tpl">Mẫu prompt — đặt biến trong ngoặc nhọn</label>
        <textarea id="tpl" className="short" value={value.template} onChange={(e) => set({ template: e.target.value })} placeholder="{món ăn} trên bàn gỗ ở {nơi}, ánh sáng buổi sáng, ảnh đời thường" />
        {names.length > 0 && (
          <div className="vars">
            {names.map((n) => (
              <label key={n} className="var">
                <span>{`{${n}}`} <span className="muted">· {valuesOf(value.lists[n] ?? '').length} giá trị</span></span>
                <textarea aria-label={`Giá trị cho ${n}`} value={value.lists[n] ?? ''} onChange={(e) => set({ lists: { ...value.lists, [n]: e.target.value } })} placeholder="Mỗi dòng một giá trị" />
              </label>
            ))}
          </div>
        )}
        {table && <p className="hint" data-testid="csv-cols">Biến lấy từ file CSV, mỗi dòng của file thành một prompt. Các cột: {table[0].map((h) => `{${h.trim()}}`).join(' ')}</p>}
        <div className="toolbar">
          {!table && <label><input type="radio" name="how" checked={value.how === 'all'} onChange={() => set({ how: 'all' })} /> Mọi tổ hợp</label>}
          {!table && <label><input type="radio" name="how" checked={value.how === 'zip'} onChange={() => set({ how: 'zip' })} /> Ghép theo dòng</label>}
          <span className="spacer" />
          {r && 'error' in r && <span className="err small-text" role={table ? 'alert' : 'status'}>{table ? csvMsg(r.error as CsvError) : ERR(r.error as ExpandError)}</span>}
          {r && 'prompts' in r && <button onClick={() => onApply(r.prompts)}>{hasText ? `Thay danh sách bằng ${r.prompts.length} prompt` : `Tạo ${r.prompts.length} prompt`}</button>}
        </div>
      </div>
    </details>
  )
}
