// Shared visual pieces of the press-proof design: state tones, the colour-bar strip, the registration mark.
import type { Attempt } from './types'

export type Tone = 'run' | 'wait' | 'attn' | 'done' | 'idle'

export function itemTone(a: Attempt): Tone {
  if (a.item === 'awaiting_user') return 'wait'
  if (a.item === 'needs_review' || a.item === 'failed') return 'attn'
  if (a.item === 'ready') return 'done'
  if (a.item === 'preparing' || a.item === 'submitting' || a.item === 'generating') return 'run'
  return 'idle'
}

export const batchTone = (status: string): Tone =>
  ({ running: 'run', paused: 'wait', needs_review: 'attn', failed: 'attn', partial_failed: 'attn', completed: 'done' } as Record<string, Tone>)[status] ?? 'idle'

export const Chip = ({ tone, children }: { tone: Tone; children: React.ReactNode }): React.JSX.Element => <span className="chip" data-tone={tone}>{children}</span>

const STEPS: [string, string][] = [['intent', 'Ghi ý định'], ['sent', 'Đã gửi'], ['receipt', 'Có kết quả'], ['saved', 'Đã lưu']]

/** The journal printed in as four patches; the first missing one takes the item's state colour. */
export function Strip({ a }: { a: Attempt }): React.JSX.Element {
  const types = new Set(a.journal.map((j) => j.type))
  if (Object.values(a.downloads ?? {}).some((d) => d.state === 'completed')) types.add('saved')
  const tone = itemTone(a)
  const reached = STEPS.map(([t]) => types.has(t))
  const next = reached.indexOf(false)
  const said = STEPS.filter((_, i) => reached[i]).map(([, l]) => l)
  return (
    <span className="bar" role="img" aria-label={`Tiến trình: ${said.length ? said.join(', ') : 'chưa bắt đầu'}`}>
      {STEPS.map(([t, label], i) => (
        <i key={t} title={label} data-on={reached[i] ? '' : undefined} data-next={i === next && tone !== 'idle' && tone !== 'done' ? tone : undefined} />
      ))}
    </span>
  )
}

/** Registration mark: inked and aligned when the extension is connected. */
export function RegMark({ on, size = 18, light = false }: { on: boolean; size?: number; light?: boolean }): React.JSX.Element {
  const c = light ? '#ece7da' : on ? '#1b1a17' : '#b0124f'
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="5.5" fill="none" stroke={c} strokeWidth="1.5" />
      {on && <circle cx="10" cy="10" r="2.5" fill={c} />}
      <path d={on ? 'M10 0v20M0 10h20' : 'M10 0v7M10 13v7M0 10h7M13 10h7'} stroke={c} strokeWidth="1.2" />
    </svg>
  )
}
