import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PUBLIC_ERRORS, CLIENT_SIGNALS } from '@toolflow/flow-protocol/errors'
import { HINTS, hintOf } from '../src/renderer/src/hints'

const root = resolve(__dirname, '../../..')
const src = (p: string) => readFileSync(join(root, p), 'utf8')
const lits = (s: string) => [...s.matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)].map((m) => m[1])

// Codes thrown to the caller of an IPC command (shown by the command's own error), never stored on an attempt or a pause.
const IPC_ONLY = ['ALREADY_RERUN', 'BATCH_ARCHIVED', 'ATTRIBUTION_AMBIGUOUS', 'CLICK_IN_FLIGHT', 'COST_NOT_CONFIRMED', 'NOT_RERUNNABLE', 'TARGET_BLOCKED']
// Internal comparisons / signals inside a code, not codes themselves.
const NOT_CODES = ['NOT_FOUND', 'OBSERVER_DEAD', 'SUBMIT_LISTENER_MISSING']

// codes of the extension's locate/fetchMedia; downloads.ts stores them as DOWNLOAD_<code>
function extDownloadCodes(): string[] {
  const tile = src('apps/extension/page-ops.js'), ops = src('apps/extension/ops.js')
  const fromTile = [...tile.slice(tile.indexOf('const tile'), tile.indexOf('const OPS')).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])
  return [...fromTile, ...[...ops.matchAll(/code: '([A-Z_]+)'/g)].map((m) => m[1])].map((c) => (c.startsWith('DOWNLOAD_') ? c : `DOWNLOAD_${c}`))
}

function emitted(): string[] {
  const refLogic = [...src('apps/extension/ref-logic.js').matchAll(/code: '([A-Z_]+)'/g)].map((m) => `REF_${m[1]}`) // ext-driver prefixes the page's attach codes
  return [...new Set([
    ...lits(src('apps/desktop/src/main/connector/ext-driver.ts')), ...lits(src('apps/desktop/src/main/downloads.ts')), ...extDownloadCodes(), ...lits(src('apps/desktop/src/main/runner.ts')), ...lits(src('packages/flow-protocol/src/attempt.mjs')),
    ...lits(src('apps/desktop/src/main/gpt-runner.ts')), ...[...(src('apps/extension/gpt-ops.js') + src('apps/extension/gem-ops.js')).matchAll(/code: '([A-Z_]+)'/g)].map((m) => m[1]).flatMap((c) => [`GPT_${c}`, `DOWNLOAD_${c}`]).filter((c) => !['DOWNLOAD_NO_EDITOR', 'DOWNLOAD_NO_PLUS', 'DOWNLOAD_OTHER_MODE', 'DOWNLOAD_MODE_NOT_FOUND', 'DOWNLOAD_MODE_NOT_SET', 'DOWNLOAD_COMPOSER_NOT_EMPTY', 'DOWNLOAD_PROMPT_MISMATCH', 'DOWNLOAD_NO_SEND', 'DOWNLOAD_SEND_DISABLED', 'GPT_NOT_FOUND', 'GPT_NOT_IMAGE', 'GPT_FETCH_FAILED', 'GPT_BUSY', 'GPT_NO_FULL_SIZE', 'DOWNLOAD_ASPECT_NOT_FOUND', 'DOWNLOAD_ASPECT_NOT_SET', 'DOWNLOAD_ATTACH_NOT_CLEARED', 'DOWNLOAD_ATTACH_REFUSED', 'DOWNLOAD_ATTACH_NOT_READY', 'DOWNLOAD_REF_MISMATCH'].includes(c)), // the page's composer codes pause a batch as GPT_<code>; its image codes fail a download as DOWNLOAD_<code>
    ...refLogic, ...Object.values(PUBLIC_ERRORS).map((r) => r.code), ...Object.values(CLIENT_SIGNALS).map((r) => r.code), 'NO_PROJECT_TAB', 'UNUSUAL_ACTIVITY',
  ])].filter((c) => !IPC_ONLY.includes(c) && !NOT_CODES.includes(c)).sort()
}

test('every code the driver, runner and Flow error table can emit has a Vietnamese hint', () => {
  const codes = emitted()
  expect(codes.length).toBeGreaterThan(25) // the scan itself must find the codes
  for (const c of ['REF_UPLOAD_UNCERTAIN', 'REF_NO_CHIP', 'HUMAN_REQUIRED', 'COMBO_NOT_QUALIFIED', 'UNEXPECTED_GENERATE', 'NO_PROJECT_TAB']) expect(codes).toContain(c)
  expect(codes.filter((c) => !HINTS[c])).toEqual([])
  for (const c of codes) expect(hintOf(c)).toMatch(/[\u00C0-\u1EF9]/) // diacritics: written in Vietnamese
})

test('the ref-upload and unusual-activity hints say what to do', () => {
  expect(hintOf('REF_UPLOAD_UNCERTAIN')).toBe('Ảnh tham chiếu có thể đã tải lên Flow nhưng chưa thấy trong thư viện. Kiểm tra thư viện Flow rồi bấm Tiếp tục (app sẽ KHÔNG tải lại)')
  expect(hintOf('HUMAN_REQUIRED')).toBe('Flow báo hoạt động bất thường. Dừng lại, mở Flow thủ công và đợi; app không tự thử lại')
  expect(hintOf('UNUSUAL_ACTIVITY')).toBe(hintOf('HUMAN_REQUIRED'))
  expect(hintOf('SOMETHING_UNKNOWN')).toBeUndefined()
})

test('a ChatGPT batch reads its hints with ChatGPT in them, never Flow; the download folder name is left alone', () => {
  expect(hintOf('SUBMIT_UNCERTAIN', 'chatgpt')).toBe('Không rõ ChatGPT đã nhận lượt này chưa. Mở ChatGPT kiểm tra rồi chọn “Đã gửi” hoặc “Chưa gửi”')
  expect(hintOf('DOWNLOAD_ACK_LOST', 'chatgpt')).toContain('Downloads/ToolFlow')
  for (const c of Object.keys(HINTS)) expect(hintOf(c, 'chatgpt'), c).not.toMatch(/(?<![A-Za-z])Flow/)
  expect(hintOf('SUBMIT_UNCERTAIN')).toContain('Flow')
  for (const c of ['NO_CHATGPT_TAB', 'GPT_NO_IMAGE', 'GPT_CONVERSATION_CHANGED', 'GPT_MODE_NOT_FOUND', 'GPT_COMPOSER_NOT_EMPTY']) expect(hintOf(c), c).toMatch(/ChatGPT/)
})

test('a Gemini batch reads its hints with Gemini in them: no Flow, no ChatGPT, no English-UI advice (Gemini is driven by icons, not labels)', () => {
  expect(hintOf('SUBMIT_UNCERTAIN', 'gemini')).toBe('Không rõ Gemini đã nhận lượt này chưa. Mở Gemini kiểm tra rồi chọn “Đã gửi” hoặc “Chưa gửi”')
  expect(hintOf('NO_CHATGPT_TAB', 'gemini')).toContain('gemini.google.com')
  for (const c of Object.keys(HINTS)) expect(hintOf(c, 'gemini'), c).not.toMatch(/(?<![A-Za-z])Flow|ChatGPT|chatgpt|tiếng Anh|English|Create image/)
  expect(hintOf('DOWNLOAD_ACK_LOST', 'gemini')).toContain('Downloads/ToolFlow')
  for (const c of ['DOWNLOAD_NO_FULL_SIZE', 'DOWNLOAD_NOT_GEMINI_TAB', 'DOWNLOAD_BUSY']) expect(hintOf(c), c).toMatch(/Gemini/)
  expect(hintOf('GPT_NO_IMAGE', 'gemini')).toContain('để trống câu trả lời')
  expect(hintOf('GPT_NO_IMAGE', 'chatgpt')).toContain('ChatGPT') // the ChatGPT wording is untouched
})
