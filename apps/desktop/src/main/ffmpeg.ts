// ffmpeg for the workflow's video nodes: the last frame of a clip (the start frame of the next scene) and several clips made into one.
// The app ships its own ffmpeg.exe (resources/ffmpeg, fetched by scripts/fetch-ffmpeg.mjs); nothing here goes to the network.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const coded = (code: string): Error => Object.assign(new Error(code), { code })

/** TOOLFLOW_FFMPEG (tests), then the copy shipped with the installed app, then the one fetched into the repo, then PATH. */
export function ffmpegBin(): string {
  const own = [process.env.TOOLFLOW_FFMPEG, process.resourcesPath && join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'), join(__dirname, '..', '..', 'resources', 'ffmpeg', 'ffmpeg.exe'), join(process.cwd(), 'resources', 'ffmpeg', 'ffmpeg.exe')]
  return own.find((p): p is string => !!p && existsSync(p)) ?? 'ffmpeg'
}

function run(args: string[]): Promise<string> { // resolves with stderr (ffmpeg writes its report there)
  return new Promise((ok, fail) => {
    execFile(ffmpegBin(), ['-hide_banner', ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 }, (e, _out, err) => (e ? fail(coded('FFMPEG_FAILED')) : ok(String(err))))
  })
}

/** Size, sound and length of a file, read from ffmpeg's own report (no ffprobe shipped). */
export async function probe(file: string): Promise<{ w: number; h: number; audio: boolean; dur: number; fps: number }> {
  const err = await new Promise<string>((ok) => execFile(ffmpegBin(), ['-hide_banner', '-i', file], { windowsHide: true }, (_e, _o, se) => ok(String(se)))) // with no output named ffmpeg exits 1 after the report
  const v = /Stream #\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(err)
  if (!v) throw coded('FFMPEG_NOT_VIDEO')
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err), f = /(\d+(?:\.\d+)?) fps/.exec(err)
  return { w: +v[1], h: +v[2], audio: /Stream #\d+:\d+.*Audio:/.test(err), dur: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0, fps: f ? +f[1] : 24 }
}

/** The clip's last frame as a PNG (seeks near the end, keeps overwriting one file: what is left is the last decoded frame). */
export async function lastFrame(video: string, png: string): Promise<void> {
  await run(['-y', '-v', 'error', '-sseof', '-1', '-i', video, '-an', '-update', '1', png])
  if (!existsSync(png)) throw coded('FFMPEG_FAILED')
}

/** Clips in this order, cut straight one after another, as one MP4 (H.264 + AAC). Picture: the first clip's size and frame rate,
 *  other sizes scaled to fit with black bars (never cropped or stretched). Sound: 48 kHz stereo; a clip without sound gets silence for its length. */
export async function concatVideos(files: string[], out: string): Promise<void> {
  if (!files.length) throw coded('INVALID_ARGS')
  const ps = await Promise.all(files.map(probe))
  const W = ps[0].w & ~1, H = ps[0].h & ~1, F = ps[0].fps
  const parts = ps.map((p, i) => {
    const v = `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${F},format=yuv420p[v${i}]`
    const a = p.audio ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${p.dur}[a${i}]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${p.dur}[a${i}]`
    return `${v};${a}`
  })
  const filter = `${parts.join(';')};${ps.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${ps.length}:v=1:a=1[v][a]`
  await run(['-y', '-v', 'error', ...files.flatMap((f) => ['-i', f]), '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out])
}
