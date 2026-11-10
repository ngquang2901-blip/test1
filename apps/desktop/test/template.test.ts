import { test, expect } from 'vitest'
import { expand, fillLines, valuesOf, varsOf, MAX_PROMPTS } from '../src/renderer/src/template'

test('variables: Vietnamese names, spaces trimmed, each once, in order', () => {
  expect(varsOf('{món ăn} ở { nơi }, {món ăn} nóng')).toEqual(['món ăn', 'nơi'])
  expect(varsOf('không có biến')).toEqual([])
  expect(varsOf('{}{\n}')).toEqual([])
})

test('every combination, first variable outermost; the same variable twice gets the same value', () => {
  const r = expand('{món} ở {nơi}, {món} nóng', { món: ['phở', 'bún'], nơi: ['Hà Nội', 'Huế'] }, 'all')
  expect(r).toEqual({ prompts: ['phở ở Hà Nội, phở nóng', 'phở ở Huế, phở nóng', 'bún ở Hà Nội, bún nóng', 'bún ở Huế, bún nóng'] })
})

test('zip: line i of every list together; unequal lists are an error naming the odd one', () => {
  expect(expand('{a} và {b}', { a: ['1', '2'], b: ['x', 'y'] }, 'zip')).toEqual({ prompts: ['1 và x', '2 và y'] })
  expect(expand('{a} và {b}', { a: ['1', '2'], b: ['x'] }, 'zip')).toEqual({ error: { code: 'ZIP_LENGTH', name: 'b' } })
})

test('errors: no variable, an empty list, too many combinations', () => {
  expect(expand('chỉ chữ', {}, 'all')).toEqual({ error: { code: 'NO_VARS' } })
  expect(expand('{a} {b}', { a: ['1'], b: [] }, 'all')).toEqual({ error: { code: 'EMPTY_VAR', name: 'b' } })
  const big = Array.from({ length: 50 }, (_, i) => String(i))
  expect(expand('{a}{b}', { a: big, b: big }, 'all')).toEqual({ error: { code: 'TOO_MANY', count: 2500 } })
  expect(2500 > MAX_PROMPTS).toBe(true)
})

test('one prompt per line: newlines in the template collapse; value lists drop blanks and trim', () => {
  expect(valuesOf(' phở \r\n\n bún\n')).toEqual(['phở', 'bún'])
  expect(expand('{a}\n  ở chợ', { a: ['cá'] }, 'all')).toEqual({ prompts: ['cá ở chợ'] })
})

test('fillLines (workflow Text node): plain lines pass through; a line with a variable becomes one prompt per value; errors name the variable', () => {
  const vars = { 'nhân vật': 'mèo cam\n chó vàng ', nơi: 'công viên' }
  expect(fillLines('một bức tranh\n\n{nhân vật} đi dạo ở {nơi}\n{nơi} lúc sáng', vars)).toEqual({ prompts: ['một bức tranh', 'mèo cam đi dạo ở công viên', 'chó vàng đi dạo ở công viên', 'công viên lúc sáng'] })
  expect(fillLines('  \n', vars)).toEqual({ prompts: [] })
  expect(fillLines('{nhân vật} và {bạn}', vars)).toEqual({ error: { code: 'EMPTY_VAR', name: 'bạn' } })
  expect(fillLines('{nơi}', { nơi: '  ' })).toEqual({ error: { code: 'EMPTY_VAR', name: 'nơi' } })
  const big = Array.from({ length: 50 }, (_, i) => `v${i}`).join('\n')
  expect(fillLines('{a} {b}', { a: big, b: big })).toEqual({ error: { code: 'TOO_MANY', count: 2500 } })
  const many = Array.from({ length: 1001 }, () => '{a}').join('\n') // each line fits, the total does not
  expect(fillLines(many, { a: 'x\ny' })).toMatchObject({ error: { code: 'TOO_MANY' } })
})
