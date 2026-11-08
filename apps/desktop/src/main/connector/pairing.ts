import { randomBytes } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const extDir = (userDataDir: string): string => join(userDataDir, 'extension')

// Token is created once and survives updates; the server needs it before it has a port, so this is separate.
export function readOrCreateToken(userDataDir: string): string {
  try {
    const t = JSON.parse(readFileSync(join(extDir(userDataDir), 'pair.json'), 'utf8')).token
    if (typeof t === 'string' && /^[0-9a-f]{64}$/.test(t)) return t
  } catch {
    /* first run or unreadable: mint a new one */
  }
  return randomBytes(32).toString('hex')
}

export function installExtension(bundledDir: string, userDataDir: string, port: number): { dir: string; token: string } {
  const dir = extDir(userDataDir)
  const token = readOrCreateToken(userDataDir)
  mkdirSync(dir, { recursive: true })
  cpSync(bundledDir, dir, { recursive: true, force: true })
  const f = join(dir, 'pair.json')
  writeFileSync(f, JSON.stringify({ port, token }), { mode: 0o600 })
  try {
    chmodSync(f, 0o600) // writeFile's mode is ignored when the file exists
  } catch {
    /* shortcut: Windows has no POSIX modes, rely on the per-user profile dir */
  }
  return { dir, token }
}
