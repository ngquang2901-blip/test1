// Kết quả's Xuất file: writes into a folder the user picked, so a file already there is never replaced ("a.png" taken ⇒ "a (2).png").
import { constants, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const coded = (code: string): Error => Object.assign(new Error(code), { code })

/** Calls write(path) with the first free name; write must fail with EEXIST when the file exists. Returns the name used. */
export function placeNoClobber(dir: string, name: string, write: (path: string) => void): string {
  const ext = extname(name), stem = name.slice(0, name.length - ext.length)
  for (let n = 1; n < 1000; n++) {
    const file = n === 1 ? name : `${stem} (${n})${ext}`, path = join(dir, file)
    try { write(path); return file } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      rmSync(path, { force: true }) // a half-written copy (disk full) must not stay behind; an existing file never gets here
      throw e
    }
  }
  throw coded('EXPORT_NAME_TAKEN')
}

export const copyInto = (src: string, dir: string, name: string): string => placeNoClobber(dir, name, (p) => copyFileSync(src, p, constants.COPYFILE_EXCL))
export const writeInto = (dir: string, name: string, data: string): string => placeNoClobber(dir, name, (p) => writeFileSync(p, data, { flag: 'wx' }))

/** Every field quoted; the BOM makes Excel read the file as UTF-8, so Vietnamese stays readable. */
export const csv = (rows: (string | number)[][]): string => '\ufeff' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n'
