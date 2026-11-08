import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { Db } from './db'

export const MAX_ASSET_BYTES = 20 * 1024 * 1024
export type AssetErrorCode = 'ASSET_UNSUPPORTED' | 'ASSET_EMPTY' | 'ASSET_TOO_LARGE' | 'ASSET_UNREADABLE' | 'ASSET_CHANGED'
export class AssetError extends Error {
  constructor(public code: AssetErrorCode) { super(code) } // code only: a message with the path would leak into logs
}
export type Binding = { assetId: string; projectId: string; uploadName: string; mediaId: string | null; state: 'uploading' | 'bound' | 'uncertain'; intentAt: number }
/** What ext-driver needs from the asset layer; tests inject an in-memory one. */
export interface AssetStore {
  get(id: string): { name: string; mime: string; bytes(): Buffer } | null
  binding(assetId: string, projectId: string): Binding | null
  writeBinding(b: Binding): void
}

const starts = (b: Buffer, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x)
const sniff = (b: Buffer): string | null =>
  starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? 'image/png'
  : starts(b, [0xff, 0xd8, 0xff]) ? 'image/jpeg'
  : starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8) ? 'image/webp' : null
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Reads and validates the file (type by magic bytes, 1..20 MB) and records it; the same path with the same bytes is the same asset. */
export function registerAsset(db: Db, path: string, now: number): { id: string; name: string; mime: string; bytes: number } {
  let buf: Buffer
  try {
    if (statSync(path).size > MAX_ASSET_BYTES) throw new AssetError('ASSET_TOO_LARGE') // before reading it all
    buf = readFileSync(path)
  } catch (e) { throw e instanceof AssetError ? e : new AssetError('ASSET_UNREADABLE') }
  if (buf.length === 0) throw new AssetError('ASSET_EMPTY')
  if (buf.length > MAX_ASSET_BYTES) throw new AssetError('ASSET_TOO_LARGE')
  const mime = sniff(buf)
  if (!mime) throw new AssetError('ASSET_UNSUPPORTED')
  const digest = sha(buf), name = basename(path)
  const have = db.prepare('select id from asset where path=? and sha256=?').get(path, digest) as { id: string } | undefined
  const id = have?.id ?? randomUUID()
  if (!have) db.prepare('insert into asset(id,path,sha256,bytes,mime,name,created_at) values(?,?,?,?,?,?,?)').run(id, path, digest, buf.length, mime, name, now)
  return { id, name, mime, bytes: buf.length }
}

/** Unique per asset (id prefix) and per upload (time), so two assets with identical bytes never collide in the library. Generated once, then persisted in the binding. */
export const uploadName = (assetId: string, mime: string, now: number): string => `tf-${assetId.slice(0, 8)}-${now.toString(36)}.${EXT[mime] ?? 'bin'}`

export function createAssetStore(db: Db): AssetStore {
  return {
    get(id) {
      const r = db.prepare('select path, sha256, mime, name from asset where id=?').get(id) as { path: string; sha256: string; mime: string; name: string } | undefined
      if (!r) return null
      return { name: r.name, mime: r.mime, bytes() { // the file may have changed since it was registered: never upload other bytes under this id
        const b = (() => { try { return readFileSync(r.path) } catch { throw new AssetError('ASSET_UNREADABLE') } })()
        if (sha(b) !== r.sha256) throw new AssetError('ASSET_CHANGED')
        return b
      } }
    },
    binding(assetId, projectId) {
      const r = db.prepare('select asset_id a, project_id p, upload_name u, media_id m, state s, intent_at t from asset_binding where asset_id=? and project_id=?').get(assetId, projectId) as { a: string; p: string; u: string; m: string | null; s: Binding['state']; t: number } | undefined
      return r ? { assetId: r.a, projectId: r.p, uploadName: r.u, mediaId: r.m, state: r.s, intentAt: r.t } : null
    },
    writeBinding(b) {
      db.prepare(`insert into asset_binding(asset_id,project_id,upload_name,media_id,state,intent_at) values(?,?,?,?,?,?)
        on conflict(asset_id,project_id) do update set media_id=excluded.media_id, state=excluded.state`).run(b.assetId, b.projectId, b.uploadName, b.mediaId, b.state, b.intentAt) // upload_name and intent_at are written once
    },
  }
}
