// Puts ffmpeg.exe (+ its licence) in resources/ffmpeg/, which electron-builder ships next to the app (extraResources).
// Pinned build: the zip's sha256 must match, so a changed or tampered download never gets packaged. Run before `electron-builder`.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = '9.0.2'
const URL = `https://github.com/GyanD/codexffmpeg/releases/download/${VERSION}/ffmpeg-${VERSION}-essentials_build.zip`
const SHA256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
const out = join(import.meta.dirname, '..', 'resources', 'ffmpeg')

if (existsSync(join(out, 'ffmpeg.exe'))) { console.log('ffmpeg: already there'); process.exit(0) }
const res = await fetch(URL)
if (!res.ok) throw new Error(`ffmpeg download: HTTP ${res.status}`)
const zip = Buffer.from(await res.arrayBuffer())
const got = createHash('sha256').update(zip).digest('hex')
if (got !== SHA256) throw new Error(`ffmpeg download: sha256 ${got} is not the pinned one`)
const tmp = join(tmpdir(), `tf-ffmpeg-${process.pid}`)
mkdirSync(tmp, { recursive: true })
writeFileSync(join(tmp, 'f.zip'), zip)
execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', 'f.zip'], { cwd: tmp }) // Windows' own bsdtar reads zip (git-bash's GNU tar on PATH does not)
const dir = join(tmp, `ffmpeg-${VERSION}-essentials_build`)
mkdirSync(out, { recursive: true })
copyFileSync(join(dir, 'bin', 'ffmpeg.exe'), join(out, 'ffmpeg.exe'))
copyFileSync(join(dir, 'LICENSE'), join(out, 'LICENSE.txt'))
writeFileSync(join(out, 'SOURCE.txt'), `FFmpeg ${VERSION} essentials build by Gyan Doshi (GPLv3).\nBinary: ${URL}\nSource: https://ffmpeg.org/releases/ and https://github.com/GyanD/codexffmpeg\n`)
rmSync(tmp, { recursive: true, force: true })
console.log('ffmpeg:', readFileSync(join(out, 'ffmpeg.exe')).length, 'bytes')
