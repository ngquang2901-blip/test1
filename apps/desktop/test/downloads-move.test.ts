import { test, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// m1c: hard links across devices fail with EXDEV; the copy fallback must still never replace an existing file.
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), linkSync: () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }) } }))
const { moveNoClobber } = await import('../src/main/downloads')

test('EXDEV fallback: exclusive copy never overwrites an existing target (numeric suffix), the source is removed', () => {
  const d = mkdtempSync(join(tmpdir(), 'tf-mv-'))
  const src = join(d, 'src.bin'), want = join(d, '001_x.png')
  writeFileSync(want, 'ORIGINAL'); writeFileSync(join(d, '001_x-2.png'), 'SECOND')
  writeFileSync(src, 'NEW-BYTES')
  const got = moveNoClobber(src, want)
  expect(got).toBe(join(d, '001_x-3.png'))
  expect(readFileSync(want, 'utf8')).toBe('ORIGINAL')
  expect(readFileSync(join(d, '001_x-2.png'), 'utf8')).toBe('SECOND')
  expect(readFileSync(got, 'utf8')).toBe('NEW-BYTES')
  expect(existsSync(src)).toBe(false)
})

test('EXDEV fallback: a free target is written by the copy', () => {
  const d = mkdtempSync(join(tmpdir(), 'tf-mv-'))
  const src = join(d, 'src.bin'), want = join(d, 'a.png')
  writeFileSync(src, 'BYTES')
  expect(moveNoClobber(src, want)).toBe(want)
  expect(readFileSync(want, 'utf8')).toBe('BYTES')
  expect(existsSync(src)).toBe(false)
})
