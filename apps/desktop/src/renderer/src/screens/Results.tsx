import { KIND_LABEL, current, type Batch } from '../types'

export default function Results({ batches }: { batches: Batch[] }): React.JSX.Element {
  const rows = batches.flatMap((b) => b.items.flatMap((it) => current(it).outputs.map((m) => ({ key: `${it.id}:${m}`, kind: b.kind, prompt: it.prompt, media: m }))))
  return (
    <section aria-label="Kết quả">
      <h2>Kết quả</h2>
      {rows.length === 0 ? <p>Chưa có kết quả.</p> : (
        <ul>{rows.map((r) => <li key={r.key} data-testid="output">{KIND_LABEL[r.kind]} {r.media} — {r.prompt}</li>)}</ul>
      )}
    </section>
  )
}
