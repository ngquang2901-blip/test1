// D-18 parallel caps; one current cap per kind in the runner, halved on throttle, +1 per OK receipt.
export const CAPS = {
  default: { tabs: 1, image: 12, video: 8 },
  fast: { tabs: 4, image: 30, video: 20 },
} as const;

export const nextCap = (cur: number, signal: 'throttled' | 'ok', max: number): number =>
  signal === 'throttled' ? Math.max(1, Math.floor(cur / 2)) : Math.min(max, cur + 1);
