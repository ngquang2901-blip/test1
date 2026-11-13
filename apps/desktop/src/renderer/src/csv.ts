// CSV files (RFC 4180) for Tạo lô and the workflow's Bảng CSV node: one parser and one row filler for both. Pure, no dependency.
import { VAR, varsOf } from './template'
import { hintOf } from './hints'

export const MAX_ROWS = 2000, MAX_COLS = 50 // data rows (= the batch's prompt cap) and columns
export type CsvError = { code: 'CSV_NOT_UTF8' | 'CSV_BAD_QUOTE' | 'CSV_EMPTY' | 'CSV_TOO_BIG' | 'CSV_NO_PLACEHOLDER' } | { code: 'CSV_NO_COLUMN'; name: string } | { code: 'CSV_EMPTY_CELL'; row: number; name: string }

/** Records as written (row 0 = the header). Quoted fields may hold the separator, "" and newlines; ';' is the separator when the header has no ',' outside quotes. */
export function parseCsv(text: string): { rows: string[][] } | { error: CsvError } {
  const s = text.replace(/^\uFEFF/, '')
  let head = '', q = false
  for (const ch of s) { if (ch === '"') q = !q; else if (!q && (ch === '\n' || ch === '\r')) break; else if (!q) head += ch }
  const sep = !head.includes(',') && head.includes(';') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = [], cell = '', i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"' && cell === '') { // a quoted field runs to the next lone quote
      let j = i + 1
      for (;;) {
        const k = s.indexOf('"', j)
        if (k < 0) return { error: { code: 'CSV_BAD_QUOTE' } }
        cell += s.slice(j, k)
        if (s[k + 1] === '"') { cell += '"'; j = k + 2; continue }
        i = k + 1
        break
      }
      if (i < s.length && s[i] !== sep && s[i] !== '\r' && s[i] !== '\n') return { error: { code: 'CSV_BAD_QUOTE' } } // text after the closing quote
      continue
    }
    if (ch === sep) { row.push(cell); cell = ''; i++; continue }
    if (ch === '\r' || ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1
      if (rows.length > MAX_ROWS + 1) return { error: { code: 'CSV_TOO_BIG' } }
      continue
    }
    cell += ch; i++
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  if (rows.length > MAX_ROWS + 1 || rows.some((r) => r.length > MAX_COLS)) return { error: { code: 'CSV_TOO_BIG' } }
  if (!rows.length || rows[0].every((c) => !c.trim())) return { error: { code: 'CSV_EMPTY' } }
  return { rows }
}

/** One prompt per data row: {Cột} takes that row's cell. Blank rows are skipped; a used cell that is empty is an error (row = its number in a spreadsheet, the header being 1). */
export function fillRows(template: string, rows: string[][]): { prompts: string[] } | { error: CsvError } {
  const head = (rows[0] ?? []).map((h) => h.trim()), names = varsOf(template)
  if (!names.length) return { error: { code: 'CSV_NO_PLACEHOLDER' } }
  const missing = names.find((n) => !head.includes(n))
  if (missing && rows.length) return { error: { code: 'CSV_NO_COLUMN', name: missing } }
  const prompts: string[] = []
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].map((c) => c.trim())
    if (cells.every((c) => !c)) continue
    const empty = names.find((n) => !cells[head.indexOf(n)])
    if (empty) return { error: { code: 'CSV_EMPTY_CELL', row: r + 1, name: empty } }
    prompts.push(template.replace(VAR, (_, n: string) => cells[head.indexOf(n.trim())]).replace(/\s*\n\s*/g, ' ').trim())
  }
  return prompts.length ? { prompts } : { error: { code: 'CSV_EMPTY' } }
}

/** A file's bytes: only UTF-8 is read (Excel's plain "CSV" is the Windows code page and would come out garbled, so it is refused, not guessed). */
export function readCsv(bytes: ArrayBuffer): { rows: string[][] } | { error: CsvError } {
  try { return parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return { error: { code: 'CSV_NOT_UTF8' } } }
}

/** The Vietnamese line for an error, with the row / column it is about in front. */
export const csvMsg = (e: CsvError): string => `${'row' in e ? `Dòng ${e.row}, cột “${e.name}”: ` : 'name' in e ? `Cột “${e.name}”: ` : ''}${hintOf(e.code)}`
