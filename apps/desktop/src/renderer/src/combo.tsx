// Generation settings (model / aspect / thinking level / count) as the user picks them in Tạo lô and on a Workflow's Tạo ảnh node:
// only what the profile has qualified (profiles/flow.json "choices"), nothing typed by hand.
import flow from '../../../profiles/flow.json'

export type Combo = { kind: 'image' | 'video'; mode: string; model: string; aspect: string; quality?: string; count: number }
type Choice = { kind: string; mode: string; model: string; aspects: string[]; qualities?: string[]; counts: number[] }
const ALL = (flow as { choices?: Choice[] }).choices ?? []
export const choicesOf = (kind: Combo['kind']): Choice[] => ALL.filter((c) => c.kind === kind)
/** What runs when nothing was chosen; undefined while the profile has no qualified settings for this kind. */
export const defaultCombo = (kind: Combo['kind']): Combo | undefined => (flow.combos as Combo[]).find((c) => c.kind === kind)
const QUALITY: Record<string, string> = { Low: 'Thấp', Medium: 'Trung bình', High: 'Cao' } // the words Flow itself shows in Vietnamese
const ASPECT: Record<string, string> = { '16:9': '16:9 (ngang)', '1:1': '1:1 (vuông)', '9:16': '9:16 (dọc)' }
export const comboLabel = (c: Combo): string => [c.model, c.aspect, ...(c.quality ? [QUALITY[c.quality] ?? c.quality] : []), `x${c.count}`].join(' · ')
/** The settings after one of them changed: the others stay when the (new) model offers them, else the default's value, else the model's first. */
export const withChange = (cur: Combo, p: Partial<Combo>): Combo => {
  const next = { ...cur, ...p }, ch = choicesOf(cur.kind).find((c) => c.model === next.model), d = defaultCombo(cur.kind)
  if (!ch) return next
  const keep = <T,>(v: T | undefined, list: T[], dflt: T | undefined): T => (v !== undefined && list.includes(v) ? v : dflt !== undefined && list.includes(dflt) ? dflt : list[0])
  return { kind: cur.kind, mode: ch.mode, model: ch.model, aspect: keep(next.aspect, ch.aspects, d?.aspect), ...(ch.qualities ? { quality: keep(next.quality, ch.qualities, d?.quality) } : {}), count: keep(next.count, ch.counts, d?.count) }
}

export function Opt({ label, value, options, show = (v) => v, onChange }: { label: string; value: string; options: string[]; show?: (v: string) => string; onChange(v: string): void }): React.JSX.Element {
  return (
    <label className="wf-opt">{label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {!options.includes(value) && <option value={value} disabled>{value ? `${show(value)} (không còn dùng được)` : 'Chọn…'}</option>}
        {options.map((o) => <option key={o} value={o}>{show(o)}</option>)}
      </select>
    </label>
  )
}

/** The selects for one set of settings; the options of the others follow the chosen model. */
export function ComboFields({ value, onChange }: { value: Combo; onChange(c: Combo): void }): React.JSX.Element {
  const all = choicesOf(value.kind), ch = all.find((c) => c.model === value.model), unit = value.kind === 'video' ? 'video' : 'ảnh'
  const set = (p: Partial<Combo>): void => onChange(withChange(value, p))
  return (
    <>
      <Opt label="Mô hình" value={value.model} options={all.map((c) => c.model)} onChange={(model) => set({ model })} />
      <Opt label="Tỉ lệ khung hình" value={value.aspect} options={ch?.aspects ?? []} show={(a) => ASPECT[a] ?? a} onChange={(aspect) => set({ aspect })} />
      {(ch?.qualities || value.quality) && <Opt label="Mức suy nghĩ (Thinking level)" value={value.quality ?? ''} options={ch?.qualities ?? []} show={(q) => QUALITY[q] ?? q} onChange={(quality) => set({ quality })} />}
      <Opt label={`Số ${unit} mỗi prompt`} value={String(value.count)} options={(ch?.counts ?? []).map(String)} show={(n) => `${n} ${unit}`} onChange={(n) => set({ count: Number(n) })} />
    </>
  )
}
