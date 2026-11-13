// Sao lưu / khôi phục: one SQLite file with the journal and the app settings. Never mcp.json, pair.json or any key, never the
// image/video files (they stay in Downloads/ToolFlow). A restore is staged here and applied at the next start, before the DB opens.
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_VERSION, type Db } from './db'

const coded = (code: string): Error => Object.assign(new Error(code), { code })
const TABLES = ['batch', 'item', 'attempt', 'download']
export const STAGED = 'restore.db'

/** A consistent copy of the live DB (SQLite's online backup) plus the settings and the app version, written to `file`. */
export async function backupTo(db: Db, file: string, o: { draft: object; version: string; now: number }): Promise<void> {
  const part = `${file}.part` // the chosen name only ever holds a finished backup
  rmSync(part, { force: true })
  try {
    await db.backup(part)
    const c = new Database(part)
    try {
      c.pragma('journal_mode = DELETE') // one file, no -wal beside it
      const draft = Object.fromEntries(Object.entries(o.draft).filter(([k]) => !/token|secret|key|password/i.test(k))) // a future setting holding a secret never travels in a backup
      c.exec('create table if not exists toolflow_backup(key text primary key, value text not null)')
      const put = c.prepare('insert or replace into toolflow_backup(key, value) values(?, ?)')
      put.run('draft', JSON.stringify(draft)); put.run('version', o.version); put.run('at', String(o.now))
    } finally { c.close() }
    renameSync(part, file) // replaces: the save dialog already asked the user about an existing file
  } finally { rmSync(part, { force: true }) }
}

/** Readable SQLite with the ToolFlow tables and a schema this app knows; returns the settings it carries (null when none). */
export function checkBackup(file: string, schema: number): { draft: object | null; version: string | null } {
  let c: Database.Database
  try { c = new Database(file, { readonly: true, fileMustExist: true }) } catch { throw coded('BACKUP_INVALID') }
  try {
    if (c.pragma('quick_check', { simple: true }) !== 'ok') throw coded('BACKUP_INVALID')
    const have = new Set(c.prepare("select name from sqlite_master where type='table'").pluck().all() as string[])
    if (!TABLES.every((t) => have.has(t))) throw coded('BACKUP_INVALID')
    if ((c.pragma('user_version', { simple: true }) as number) > schema) throw coded('BACKUP_TOO_NEW')
    const get = (k: string): string | null => (have.has('toolflow_backup') ? ((c.prepare('select value from toolflow_backup where key=?').pluck().get(k) as string | undefined) ?? null) : null)
    const draft = get('draft')
    return { draft: draft ? (JSON.parse(draft) as object) : null, version: get('version') }
  } catch (e) {
    throw (e as { code?: string }).code?.startsWith('BACKUP_') ? e : coded('BACKUP_INVALID')
  } finally { c.close() }
}

/** Copies the picked file into userData and checks that copy (what is checked is what will be applied). */
export function stageRestore(userData: string, file: string, schema: number): void {
  const staged = join(userData, STAGED)
  try { copyFileSync(file, staged); checkBackup(staged, schema) } catch (e) {
    rmSync(staged, { force: true })
    throw (e as { code?: string }).code?.startsWith('BACKUP_') ? e : coded('BACKUP_INVALID')
  }
}

/**
 * At start, before openDb: a staged backup becomes toolflow.db. The current DB (with its -wal/-shm) is kept as
 * toolflow.db.before-restore-<time>, never deleted; the settings come back into draft.json. A staged file that is no longer
 * a valid backup is removed and nothing else changes. null = nothing staged.
 */
export function applyRestore(userData: string, now: number, schema = SCHEMA_VERSION): { ok: true } | { ok: false; code: string } | null {
  const staged = join(userData, STAGED)
  if (!existsSync(staged)) return null
  let draft: object | null
  try { draft = checkBackup(staged, schema).draft } catch (e) { rmSync(staged, { force: true }); return { ok: false, code: (e as { code: string }).code } }
  const db = join(userData, 'toolflow.db'), keep = `${db}.before-restore-${new Date(now).toISOString().replace(/[:.]/g, '-')}`
  const moved: string[] = []
  try {
    for (const s of ['', '-wal', '-shm']) if (existsSync(db + s)) { renameSync(db + s, keep + s); moved.push(s) } // a -wal left beside the new DB would be replayed into it
    renameSync(staged, db)
  } catch {
    for (const s of moved.reverse()) try { renameSync(keep + s, db + s) } catch { /* left as before-restore: still on disk */ }
    return { ok: false, code: 'RESTORE_FAILED' }
  }
  if (draft) writeFileSync(join(userData, 'draft.json'), JSON.stringify(draft))
  return { ok: true }
}
