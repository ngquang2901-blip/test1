import { test, expect } from 'vitest'
import { csvMsg, fillRows, parseCsv, readCsv, MAX_ROWS } from '../src/renderer/src/csv'

const rows = (s: string) => (parseCsv(s) as { rows: string[][] }).rows

test('RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, UTF-8 BOM', () => {
  expect(rows('\uFEFFTên,Mô tả\r\n"mèo, cam","nói ""meo""\r\ndòng 2"\r\nchó,\r\n')).toEqual([['Tên', 'Mô tả'], ['mèo, cam', 'nói "meo"\r\ndòng 2'], ['chó', '']])
  expect(rows('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]) // LF, no newline at the end
  expect(rows('a\n\n1\n')).toEqual([['a'], [''], ['1']]) // an empty line is a row (fillRows skips it)
})

test('separator: ";" when the header has no comma (Excel in Vietnamese / European locales), "," otherwise', () => {
  expect(rows('Tên;Màu\nmèo;cam, trắng')).toEqual([['Tên', 'Màu'], ['mèo', 'cam, trắng']])
  expect(rows('Tên,Màu\nmèo;cam,trắng')).toEqual([['Tên', 'Màu'], ['mèo;cam', 'trắng']])
  expect(rows('"a;b";c\n1;2')).toEqual([['a;b', 'c'], ['1', '2']]) // a ';' inside quotes of the header does not count
})

test('refused: an unclosed quote, an empty file, too many rows', () => {
  expect(parseCsv('a,b\n"1,2')).toEqual({ error: { code: 'CSV_BAD_QUOTE' } })
  expect(parseCsv('a\n"x"y')).toEqual({ error: { code: 'CSV_BAD_QUOTE' } }) // text after a closing quote
  expect(parseCsv('\uFEFF \r\n')).toEqual({ error: { code: 'CSV_EMPTY' } })
  expect(parseCsv('a\n' + 'x\n'.repeat(MAX_ROWS + 1))).toEqual({ error: { code: 'CSV_TOO_BIG' } })
  expect(rows('a\n' + 'x\n'.repeat(MAX_ROWS))).toHaveLength(MAX_ROWS + 1)
})

test('fillRows: one prompt per row from a {Cột} template; empty rows skipped; newlines in a cell become one line', () => {
  const t = rows('Tên,Nơi\nmèo,"bậu\ncửa sổ"\n,\n chó , sân ')
  expect(fillRows('{Tên} ở {Nơi}', t)).toEqual({ prompts: ['mèo ở bậu cửa sổ', 'chó ở sân'] })
  expect(fillRows('{ Tên }', t)).toEqual({ prompts: ['mèo', 'chó'] })
})

test('fillRows: an empty cell the template uses is an error naming its row (as numbered in a spreadsheet) and column, never dropped', () => {
  const t = rows('Tên,Nơi\nmèo,sân\nchó,\n')
  expect(fillRows('{Tên}', t)).toEqual({ prompts: ['mèo', 'chó'] }) // Nơi is not used
  expect(fillRows('{Tên} ở {Nơi}', t)).toEqual({ error: { code: 'CSV_EMPTY_CELL', row: 3, name: 'Nơi' } })
  expect(fillRows('{Màu}', t)).toEqual({ error: { code: 'CSV_NO_COLUMN', name: 'Màu' } })
  expect(fillRows('không có cột', t)).toEqual({ error: { code: 'CSV_NO_PLACEHOLDER' } })
  expect(fillRows('{Tên}', rows('Tên\n\n'))).toEqual({ error: { code: 'CSV_EMPTY' } })
  expect(fillRows('{Tên}', [])).toEqual({ error: { code: 'CSV_EMPTY' } })
})

test('readCsv: UTF-8 only (with or without BOM); a Windows code page file is refused with its own code; errors read in Vietnamese with their row and column', () => {
  expect(readCsv(new TextEncoder().encode('\uFEFFTên\nmèo').buffer as ArrayBuffer)).toEqual({ rows: [['Tên'], ['mèo']] })
  expect(readCsv(new Uint8Array([0x54, 0xea, 0x6e, 0x0a, 0x6d, 0xe8, 0x6f]).buffer)).toEqual({ error: { code: 'CSV_NOT_UTF8' } }) // "Tên\nmèo" in Windows-1258
  expect(csvMsg({ code: 'CSV_EMPTY_CELL', row: 3, name: 'Nơi' })).toMatch(/^Dòng 3, cột “Nơi”: Ô này đang trống/)
  expect(csvMsg({ code: 'CSV_NOT_UTF8' })).toContain('CSV UTF-8')
})
