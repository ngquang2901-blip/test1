import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/** The only pages the app opens in Chrome; the renderer names one of these keys, never an address. */
export const CHROME_PAGES = { extensions: 'chrome://extensions', flow: 'https://labs.google/fx/tools/flow' } as const

const APP_PATHS = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'
const regQuery = (key: string): string => execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 3000 })

/** chrome.exe: the App Paths key Chrome's installer writes (machine, then user), then the usual install folders; only a file that exists. */
export function findChrome(o: { platform: string; env: Record<string, string | undefined>; exists(p: string): boolean; reg(key: string): string } = { platform: process.platform, env: process.env, exists: existsSync, reg: regQuery }): string | null {
  if (o.platform !== 'win32') return null // shortcut: Windows only, as the app ships; add the Linux/macOS paths if it ever ships there
  for (const root of ['HKLM', 'HKCU']) {
    let out = ''
    try { out = o.reg(`${root}\\${APP_PATHS}`) } catch { continue } // key absent
    const p = /REG_SZ\s+(.+?)\s*$/m.exec(out)?.[1].replace(/^"(.*)"$/, '$1')
    if (p && o.exists(p)) return p
  }
  for (const base of [o.env.ProgramFiles, o.env['ProgramFiles(x86)'], o.env.LOCALAPPDATA]) {
    const p = base && win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (p && o.exists(p)) return p
  }
  return null
}

/** Measured: without it a Chrome window covered by another app counts as hidden (Flow draws nothing, its settings panel does not open).
 *  Chrome reads it only when it starts; a running Chrome ignores it. */
export const CHROME_FLAGS = ['--disable-features=CalculateNativeWinOcclusion']

/** Starts Chrome on one page (a running Chrome opens it in a new tab). Detached: closing the app leaves Chrome open. */
export function launchChrome(exe: string, url: string, run = spawn): void {
  const c = run(exe, [...CHROME_FLAGS, url], { detached: true, stdio: 'ignore' })
  c.on('error', (e) => console.error('chrome launch', (e as { code?: string }).code ?? 'ERROR')) // an unhandled spawn error would end the main process
  c.unref()
}

/** Adds CHROME_FLAGS to every Chrome shortcut in `dirs` (desktop, taskbar, Start menu) that lacks it, so a Chrome the user starts
 *  himself also keeps running while covered. Run at every app start: a Chrome update can rewrite its shortcuts. Returns how many changed. */
export function flagChromeShortcuts(o: { dirs: string[]; list(dir: string): string[]; read(file: string): { target: string; args: string }; write(file: string, args: string): void }): number {
  let n = 0
  for (const d of o.dirs) {
    let files: string[] = []
    try { files = o.list(d) } catch { continue } // folder absent
    for (const f of files) {
      try {
        const l = o.read(f)
        if (!/(^|\\)chrome\.exe$/i.test(l.target) || CHROME_FLAGS.every((x) => l.args.includes(x))) continue
        o.write(f, [...CHROME_FLAGS, l.args].join(' ').trim()); n++
      } catch { /* not readable or not ours to write (a machine-wide Start menu entry without admin rights) */ }
    }
  }
  return n
}
