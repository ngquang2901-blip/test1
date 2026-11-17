import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concatVideos, ffmpegBin, lastFrame, probe, pruneFrames } from '../src/main/ffmpeg'

const bin = ffmpegBin(), has = (() => { try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()
const dir = mkdtempSync(join(tmpdir(), 'tf-ff-'))
const clip = (name: string, size: string, sec: number, audio: boolean): string => { // a test clip made by ffmpeg itself
  const f = join(dir, name)
  execFileSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24:duration=${sec}`, ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${sec}`] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), f])
  return f
}

test.skipIf(!has)('concat: clips of other sizes and one without sound become one mp4 at the first clip\'s size, sound all along', async () => {
  const a = clip('a.mp4', '1280x720', 2, true), b = clip('b.mp4', '720x1280', 1, false), c = clip('c.mp4', '640x360', 1, true)
  const out = join(dir, 'out.mp4')
  await concatVideos([a, b, c], out)
  const p = await probe(out)
  expect(p).toMatchObject({ w: 1280, h: 720, audio: true })
  expect(p.dur).toBeGreaterThan(3.8)
  expect(p.dur).toBeLessThan(4.3)
})

test.skipIf(!has)('lastFrame: a png of the clip\'s own size; a file that is not a video is an error with a code', async () => {
  const v = clip('d.mp4', '640x360', 1, false), png = join(dir, 'd.png')
  await lastFrame(v, png)
  expect(existsSync(png)).toBe(true)
  expect(await probe(png)).toMatchObject({ w: 640, h: 360 })
  await expect(lastFrame(join(dir, 'nope.mp4'), join(dir, 'x.png'))).rejects.toMatchObject({ code: 'FFMPEG_FAILED' })
  await expect(concatVideos([], join(dir, 'y.mp4'))).rejects.toMatchObject({ code: 'INVALID_ARGS' })
})

test('packaged: only TOOLFLOW_FFMPEG and the shipped copy; unpackaged still falls back to PATH', () => {
  const prev = process.env.TOOLFLOW_FFMPEG; delete process.env.TOOLFLOW_FFMPEG
  try {
    const planted = join(dir, 'resources', 'ffmpeg'); mkdirSync(planted, { recursive: true }); writeFileSync(join(planted, 'ffmpeg.exe'), 'x')
    const cwd = process.cwd(); process.chdir(dir)
    try { expect(ffmpegBin(false)).toMatch(/resources.ffmpeg.ffmpeg\.exe$/); expect(ffmpegBin(true)).not.toBe(join(planted, 'ffmpeg.exe')) } finally { process.chdir(cwd) } // packaged: the planted cwd copy is ignored (no resourcesPath under vitest)
    process.env.TOOLFLOW_FFMPEG = join(planted, 'ffmpeg.exe'); expect(ffmpegBin(true)).toBe(join(planted, 'ffmpeg.exe'))
  } finally { if (prev === undefined) delete process.env.TOOLFLOW_FFMPEG; else process.env.TOOLFLOW_FFMPEG = prev }
})

test.skipIf(!has)('a failed merge leaves no output file', async () => {
  const a = clip('f.mp4', '320x180', 1, false), out = join(dir, 'half.nope')
  writeFileSync(out, 'half')
  await expect(concatVideos([a], out)).rejects.toMatchObject({ code: 'FFMPEG_FAILED' })
  expect(existsSync(out)).toBe(false)
})

test('pruneFrames deletes frames older than 7 days only', () => {
  const d = join(dir, 'frames'); mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'old.png'), 'x'); writeFileSync(join(d, 'new.png'), 'x')
  const old = new Date(Date.now() - 8 * 86_400_000); utimesSync(join(d, 'old.png'), old, old)
  pruneFrames(d, Date.now())
  expect(existsSync(join(d, 'old.png'))).toBe(false); expect(existsSync(join(d, 'new.png'))).toBe(true)
})
