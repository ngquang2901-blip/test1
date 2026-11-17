import { test, expect } from 'vitest'
import { csv } from '../src/main/export'

test('csv: text a spreadsheet would run as a formula gets a leading quote; numbers and plain text stay', () => {
  const out = csv([['=1+1', '+SUM(A1)', '-2+3', '@x', '\tx', '\rx', 'a=b', 'cảnh "đẹp"', 5, -5]])
  expect(out).toBe('\ufeff"\'=1+1","\'+SUM(A1)","\'-2+3","\'@x","\'\tx","\'\rx","a=b","cảnh ""đẹp""","5","-5"\r\n')
})
