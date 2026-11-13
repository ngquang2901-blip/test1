// Prompt templates: "{món ăn} ở {nơi}" + one list of values per variable -> many prompts. Pure; the UI puts the result in the prompt list.
export const MAX_PROMPTS = 2000

export const VAR = /\{([^{}\n]{1,40})\}/g

/** Variable names in order of first appearance, each once. */
export function varsOf(template: string): string[] {
  return [...new Set([...template.matchAll(VAR)].map((m) => m[1].trim()).filter(Boolean))]
}

export const valuesOf = (text: string): string[] => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

export type ExpandError = { code: 'NO_VARS' } | { code: 'EMPTY_VAR'; name: string } | { code: 'ZIP_LENGTH'; name: string } | { code: 'TOO_MANY'; count: number }

/** 'all' = every combination (first variable outermost); 'zip' = line i of every list together (lists must be the same length). One line per prompt. */
export function expand(template: string, lists: Record<string, string[]>, how: 'all' | 'zip'): { prompts: string[] } | { error: ExpandError } {
  const names = varsOf(template)
  if (!names.length) return { error: { code: 'NO_VARS' } }
  for (const n of names) if (!lists[n]?.length) return { error: { code: 'EMPTY_VAR', name: n } }
  let rows: Record<string, string>[]
  if (how === 'zip') {
    const len = lists[names[0]].length
    const off = names.find((n) => lists[n].length !== len)
    if (off) return { error: { code: 'ZIP_LENGTH', name: off } }
    rows = Array.from({ length: len }, (_, i) => Object.fromEntries(names.map((n) => [n, lists[n][i]])))
  } else {
    const count = names.reduce((p, n) => p * lists[n].length, 1)
    if (count > MAX_PROMPTS) return { error: { code: 'TOO_MANY', count } }
    rows = names.reduce<Record<string, string>[]>((acc, n) => acc.flatMap((r) => lists[n].map((v) => ({ ...r, [n]: v }))), [{}])
  }
  const fill = (r: Record<string, string>): string => template.replace(VAR, (whole, raw: string) => r[raw.trim()] ?? whole).replace(/\s*\n\s*/g, ' ').trim()
  return { prompts: rows.map(fill) }
}

/** A workflow Text node: every line is a prompt; a line with {biến} becomes one prompt per combination of those variables' values (one value per line). */
export function fillLines(text: string, vars: Record<string, string>): { prompts: string[] } | { error: ExpandError } {
  const out: string[] = []
  for (const line of valuesOf(text)) {
    const names = varsOf(line)
    const r = names.length ? expand(line, Object.fromEntries(names.map((n) => [n, valuesOf(vars[n] ?? '')])), 'all') : { prompts: [line] }
    if ('error' in r) return r
    out.push(...r.prompts)
    if (out.length > MAX_PROMPTS) return { error: { code: 'TOO_MANY', count: out.length } }
  }
  return { prompts: out }
}
