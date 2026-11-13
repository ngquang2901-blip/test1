import { test, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, SCHEMA_VERSION } from '../src/main/db'
import { enqueueBatch } from '../src/main/batch'
import { applyRestore, backupTo, checkBackup, stageRestore } from '../src/main/backup'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tf-bak-'))
const batches = (file: string): number => { const db = new Database(file, { readonly: true }); try { return (db.prepare('select count(*) n from batch').get() as { n: number }).n } finally { db.close() } }
function appDir(prompts: string[]): { dir: string; db: ReturnType<typeof openDb> } {
  const dir = tmp(), db = openDb(join(dir, 'toolflow.db'))
  prompts.forEach((p, i) => enqueueBatch(db, { commandId: `c${i}`, kind: 'image', provider: 'flow', projectId: 'p', settings: {}, prompts: [p], refs: [[]], mode: 'auto' }))
  return { dir, db }
}

test('a backup is one SQLite file with every table, the app settings (no token-like field) and the app version; it reads back as valid', async () => {
  const { dir, db } = appDir(['một', 'hai'])
  const file = join(dir, 'out', 'sao-luu.db')
  mkdirSync(join(dir, 'out'))
  await backupTo(db, file, { draft: { text: 'x', speed: 'fast', autoSave: false, telegramToken: '123:abc' }, version: '1.2.3', now: 5 })
  expect(readdirSync(join(dir, 'out'))).toEqual(['sao-luu.db']) // one file, nothing left beside it
  expect(batches(file)).toBe(2)
  expect(checkBackup(file, SCHEMA_VERSION)).toEqual({ draft: { text: 'x', speed: 'fast', autoSave: false }, version: '1.2.3' })
  expect(readFileSync(file).toString('latin1')).not.toContain('123:abc')
})

test('checkBackup refuses a file that is not SQLite, a SQLite file that is not ToolFlow, and one from a newer app', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'junk.db'), 'không phải sqlite'.repeat(100))
  expect(() => checkBackup(join(dir, 'junk.db'), SCHEMA_VERSION)).toThrow(/BACKUP_INVALID/)
  expect(() => checkBackup(join(dir, 'nope.db'), SCHEMA_VERSION)).toThrow(/BACKUP_INVALID/)
  const other = new Database(join(dir, 'other.db')); other.exec('create table x(a)'); other.close()
  expect(() => checkBackup(join(dir, 'other.db'), SCHEMA_VERSION)).toThrow(/BACKUP_INVALID/)
  const { db } = appDir(['a'])
  await backupTo(db, join(dir, 'new.db'), { draft: {}, version: '9', now: 1 })
  const n = new Database(join(dir, 'new.db')); n.pragma(`user_version = ${SCHEMA_VERSION + 1}`); n.close()
  expect(() => checkBackup(join(dir, 'new.db'), SCHEMA_VERSION)).toThrow(/BACKUP_TOO_NEW/)
})

test('restore: staged after a check, applied at the next start before the DB opens; the old DB (with -wal/-shm) is kept beside it, settings come back', async () => {
  const src = appDir(['một', 'hai', 'ba'])
  const file = join(src.dir, 'bak.db')
  await backupTo(src.db, file, { draft: { text: 'cũ', speed: 'fast' }, version: '1.0.0', now: 1 })
  const app = appDir(['khác'])
  writeFileSync(join(app.dir, 'draft.json'), '{"text":"mới"}')
  expect(() => stageRestore(app.dir, join(app.dir, 'nope.db'), SCHEMA_VERSION)).toThrow(/BACKUP_INVALID/)
  expect(existsSync(join(app.dir, 'restore.db'))).toBe(false)
  stageRestore(app.dir, file, SCHEMA_VERSION)
  expect(existsSync(join(app.dir, 'restore.db'))).toBe(true)
  expect(applyRestore(tmp(), 7)).toBeNull() // nothing staged: nothing happens
  app.db.close()
  writeFileSync(join(app.dir, 'toolflow.db-wal'), 'w'); writeFileSync(join(app.dir, 'toolflow.db-shm'), 's') // as an app that did not close its DB leaves them
  expect(applyRestore(app.dir, Date.UTC(2026, 10, 13, 1, 2, 3))).toEqual({ ok: true })
  const kept = 'toolflow.db.before-restore-2026-11-13T01-02-03-000Z'
  expect(readdirSync(app.dir).sort()).toEqual(['draft.json', 'toolflow.db', kept, `${kept}-shm`, `${kept}-wal`].sort())
  expect(batches(join(app.dir, 'toolflow.db'))).toBe(3)
  expect(JSON.parse(readFileSync(join(app.dir, 'draft.json'), 'utf8'))).toEqual({ text: 'cũ', speed: 'fast' })
  expect(openDb(join(app.dir, 'toolflow.db')).pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
})

test('restore: a staged file that broke before the next start leaves the current DB and settings untouched', () => {
  const app = appDir(['khác'])
  app.db.close()
  writeFileSync(join(app.dir, 'draft.json'), '{"text":"mới"}')
  writeFileSync(join(app.dir, 'restore.db'), 'hỏng')
  expect(applyRestore(app.dir, 1)).toEqual({ ok: false, code: 'BACKUP_INVALID' })
  expect(readdirSync(app.dir).sort()).toEqual(['draft.json', 'toolflow.db']) // the broken copy is gone, so it is not tried at every start
  expect(batches(join(app.dir, 'toolflow.db'))).toBe(1)
  expect(readFileSync(join(app.dir, 'draft.json'), 'utf8')).toBe('{"text":"mới"}')
})
