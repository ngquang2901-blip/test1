import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

export function installExtension(bundledDir: string, userDataDir: string, port: number): { dir: string; token: string } {
  const dir = extDir(userDataDir)
  const token = readOrCreateToken(userDataDir)
  mkdirSync(dir, { recursive: true })
  cpSync(bundledDir, dir, { recursive: true, force: true })
  writePair(dir, { port, token })
  return { dir, token }
}
