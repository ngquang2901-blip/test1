/** Test clock multiplier: anything but a finite number > 0 means real time. */
export const clockFactor = (v: string | undefined): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 1)

/** Only a bare error code may reach the renderer: messages carry paths and tokens. */
export const errorCode = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]*$/.test(c) ? c : 'CONNECTOR_FAILED'
}
