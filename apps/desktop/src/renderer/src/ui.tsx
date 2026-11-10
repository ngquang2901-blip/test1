// Shared visual pieces: state tones, the status dot, a few line icons (inline, no icon library).
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

const PATHS = {
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  plus: 'M12 5v14M5 12h14',
  list: 'M4 6h16M4 12h16M4 18h10',
  image: 'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  layers: 'M3 6h18v12H3zM3 10h18',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
} as const

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS; size?: number }): React.JSX.Element {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}
