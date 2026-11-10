import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const extDir = (userDataDir: string): string => join(userDataDir, 'extension')

// Token is created once and survives updates; the server needs it before it has a port, so this is separate.
// Temp file created 0600 then renamed over pair.json: never world-readable, even replacing an old 0644 file.
function writePair(dir: string, data: { port?: number; token: string }): void {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `pair.json.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  renameSync(tmp, join(dir, 'pair.json'))
}

export function readOrCreateToken(userDataDir: string): string {
  try {
    const t = JSON.parse(readFileSync(join(extDir(userDataDir), 'pair.json'), 'utf8')).token
    if (typeof t === 'string' && /^[0-9a-f]{64}$/.test(t)) return t
  } catch {
    /* first run or unreadable: mint a new one */
  }
  const token = randomBytes(32).toString('hex')
  writePair(extDir(userDataDir), { token }) // persist now so the server and the installed extension share it
  return token
}

// The installed copy carries the app's version: after an app update Chrome keeps running the old extension (and the old
// content script in open tabs) until the user reloads it; the page reports that loaded version, so the self-check sees
// the mismatch (RELOAD_TAB) and S1 asks for a reload instead of running on stale code.
export function installExtension(bundledDir: string, userDataDir: string, port: number, version?: string): { dir: string; token: string; version: string } {
  const dir = extDir(userDataDir)
  const token = readOrCreateToken(userDataDir)
  mkdirSync(dir, { recursive: true })
  cpSync(bundledDir, dir, { recursive: true, force: true })
  let v = ''
  const mf = join(dir, 'manifest.json')
  if (existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, 'utf8')) as { version?: string }
    if (version && /^\d{1,5}(\.\d{1,5}){0,3}$/.test(version) && m.version !== version) { // Chrome: 1-4 dot-separated integers
      m.version = version
      writeFileSync(mf, JSON.stringify(m, null, 2) + '\n')
    }
    v = String(m.version ?? '')
  }
  writePair(dir, { port, token })
  return { dir, token, version: v }
}
