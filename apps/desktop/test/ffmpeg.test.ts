import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concatVideos, ffmpegBin, lastFrame, probe } from '../src/main/ffmpeg'

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
