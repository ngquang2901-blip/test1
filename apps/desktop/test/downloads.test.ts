import { test, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { openDb, type Db } from '../src/main/db'
import { createFakeDriver, TINY_PNG, type DownloadScript } from '../src/main/fake-driver'
import { enqueueBatch } from '../src/main/batch'
import { ConnectorError } from '../src/main/driver'
import { createDownloader, ensureDir, planName, recoverDownloads, requestDownload, safeComponent, type DlDriver, type DlInfo, type PlanInput } from '../src/main/downloads'

const ID = '3f2b9c1e-1111-4222-8333-444455556666'
const base: PlanInput = { batchLabel: 'b1b2b3b4', at: Date.UTC(2026, 10, 9, 5, 0), index: 1, prompt: 'a cat', outputId: ID, ext: 'png', root: '/r', tz: 'UTC' }
const DAY = '2026-11-09_b1b2b3b4'

// ---------- planName (AC-28) ----------
test.each<[string, Partial<PlanInput>, string]>([
  ['plain', {}, `${DAY}/001_a cat_3f2b9c1e.png`],
  ['Vietnamese, NFD input comes out NFC', { prompt: 'Một con mèo đang ngủ'.normalize('NFD') }, `${DAY}/001_${'Một con mèo đang ngủ'.normalize('NFC')}_3f2b9c1e.png`],
  ['300-char prompt: file name capped at 80', { prompt: 'a'.repeat(300) }, `${DAY}/001_${'a'.repeat(63)}_3f2b9c1e.png`],
  ['emoji are cut on a code point, never inside a surrogate pair', { prompt: '🐱'.repeat(100) }, `${DAY}/001_${'🐱'.repeat(31)}_3f2b9c1e.png`],
  ['prompt CON is harmless inside a longer name', { prompt: 'CON' }, `${DAY}/001_CON_3f2b9c1e.png`],
  ['backslash traversal in the prompt', { prompt: '..\\..\\evil' }, `${DAY}/001_evil_3f2b9c1e.png`],
  ['encoded %2e%2e is neutralised, not decoded', { prompt: '%2e%2e/%2e%2e/etc' }, `${DAY}/001_2e 2e 2e 2e etc_3f2b9c1e.png`],
  ['absolute path in the prompt', { prompt: '/etc/passwd' }, `${DAY}/001_etc passwd_3f2b9c1e.png`],
  ['trailing dot and spaces', { prompt: 'hello . .' }, `${DAY}/001_hello_3f2b9c1e.png`],
  ['forbidden characters', { prompt: 'a<b>c:d"e|f?g*h' }, `${DAY}/001_a b c d e f g h_3f2b9c1e.png`],
  ['control characters and runs of spaces', { prompt: '\u0007x\t\ty   z' }, `${DAY}/001_x y z_3f2b9c1e.png`],
  ['prompt part is optional', { prompt: 'a cat', withPrompt: false }, `${DAY}/001_3f2b9c1e.png`],
  ['a prompt that is only junk drops the part', { prompt: '../..' }, `${DAY}/001_3f2b9c1e.png`],
  ['batch label with traversal stays one component', { batchLabel: '../../x' }, `2026-11-09_.. .. x/001_a cat_3f2b9c1e.png`],
  ['index is 3 digits, wider when needed', { index: 1000 }, `${DAY}/1000_a cat_3f2b9c1e.png`],
  ['extension is lower-cased and cleaned', { ext: 'PNG' }, `${DAY}/001_a cat_3f2b9c1e.png`],
  ['one timezone decides the day: Ho Chi Minh is already tomorrow', { at: Date.UTC(2026, 10, 9, 18, 30), tz: 'Asia/Ho_Chi_Minh' }, `2026-11-10_b1b2b3b4/001_a cat_3f2b9c1e.png`],
  ['one timezone decides the day: Los Angeles is still today', { at: Date.UTC(2026, 10, 9, 18, 30), tz: 'America/Los_Angeles' }, `2026-11-09_b1b2b3b4/001_a cat_3f2b9c1e.png`],
])('planName: %s', (_n, over, want) => {
  const got = planName({ ...base, ...over })
  expect(got).toBe(want)
  expect(planName({ ...base, ...over })).toBe(got) // same inputs, same name
  const root = resolve(base.root)
  expect(resolve(root, got).startsWith(root + sep)).toBe(true)
  expect(got.split('/').every((c) => c !== '..' && c !== '.' && c.length <= 80)).toBe(true)
})

test('planName: whole path capped at 200 including the root; impossible roots are refused', () => {
  const root = '/' + 'r'.repeat(150)
  const got = planName({ ...base, root, prompt: 'x'.repeat(300) })
  expect(root.length + 1 + got.length).toBeLessThanOrEqual(200)
  expect(got).toBe(`${DAY}/001_${'x'.repeat(11)}_3f2b9c1e.png`)
  expect(() => planName({ ...base, root: '/' + 'r'.repeat(190) })).toThrow(/PATH_TOO_LONG/)
  expect(() => planName({ ...base, index: 0 })).toThrow()
})

test('safeComponent: Windows reserved names (also with an extension), dots, empties', () => {
  const t: Array<[string, string]> = [['CON', '_CON'], ['con.png', '_con.png'], ['LPT1.txt', '_LPT1.txt'], ['COM9', '_COM9'], ['COM10', 'COM10'], ['nul.tar.gz', '_nul.tar.gz'],
    ['CONSOLE', 'CONSOLE'], ['aux. ', '_aux'], ['name.', 'name'], ['..', '_'], ['', '_'], [' . ', '_'], ['a\\b', 'a b'], ['x'.repeat(200), 'x'.repeat(80)]]
  for (const [i, o] of t) expect(safeComponent(i)).toBe(o)
})

test('ensureDir: a symlink inside root that points outside is refused; a normal folder is created', () => {
  const d = mkdtempSync(join(tmpdir(), 'tf-ens-'))
  const root = join(d, 'root'), outside = join(d, 'outside')
  mkdirSync(root); mkdirSync(outside)
  symlinkSync(outside, join(root, 'evil'), 'junction') // junction on Windows: same escape, and creating one needs no admin (Linux ignores the type)
  expect(() => ensureDir(root, 'evil/001_x.png')).toThrow(/PATH_ESCAPE/)
  expect(readdirSync(outside)).toEqual([])
  const ok = ensureDir(root, 'day/001_x.png')
  expect(existsSync(ok)).toBe(true)
  expect(ok.startsWith(realpathSync(root) + sep)).toBe(true)
})

// ---------- state machine ----------
const A = 'attempt-1'
const M = ID
function rig(script: DownloadScript[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-dl-'))
  const root = join(dir, 'root'), tmp = join(dir, 'tmp', 'ToolFlow-tmp')
  const db = openDb(join(dir, 't.db'))
  const fake = createFakeDriver([], { downloads: script, downloadsDir: tmp })
  const calls: string[] = []
  const spy = new Proxy(fake, { get: (t, k) => { const v = (t as never)[k]; return typeof v === 'function' ? (...a: unknown[]) => { calls.push(String(k)); return (v as (...x: unknown[]) => unknown)(...a) } : v } }) as typeof fake
  let t = 1_000_000
  const env = { root, now: () => t, sleep: async (ms: number) => { t += ms }, budgetMs: 120_000 }
  const args = (o: object = {}) => ({ attemptId: A, mediaId: M, tab: 't1', batchLabel: 'b1b2b3b4', at: base.at, index: 1, prompt: 'một con mèo', tz: 'Asia/Ho_Chi_Minh', ...o })
  return { dir, root, tmp, db, fake, spy, calls, env, args }
}
type Row = { state: string; planned_name: string; actual_name: string | null; bytes: number | null; error_code: string | null; handle: string | null }
const rows = (db: Db) => db.prepare('select * from download').all() as Row[]
const onlyFiles = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).filter((f) => statSync(join(dir, f)).isFile()).sort() : [])
const magic = (p: string) => readFileSync(p).subarray(0, 4).toString('hex')
const insertRow = (db: Db, state: string, handle: string | null = null, planned = 'day/001_x_3f2b9c1e.png') =>
  db.prepare('insert into download(id,attempt_id,media_id,planned_name,state,handle,created_at,updated_at) values(?,?,?,?,?,?,1,1)').run('d1', A, M, planned, state, handle)
const info = (o: Partial<DlInfo> & { id: number }): DlInfo => ({ state: 'in_progress', filename: '', fileSize: -1, mime: '', error: null, ...o })
type Fetch = Awaited<ReturnType<DlDriver['fetchMedia']>>
function stub(o: { fetch?: (n: number) => Promise<Fetch>; list?: (q: { id?: number; filenamePrefix?: string }, n: number) => DlInfo[] } = {}) {
  const s = {
    fetches: 0, searches: [] as Array<{ id?: number; filenamePrefix?: string }>,
    drv: {
      async fetchMedia() { s.fetches++; return o.fetch ? o.fetch(s.fetches) : { ok: true as const, downloadId: 1 } },
      async downloads(q: { id?: number; filenamePrefix?: string }) { s.searches.push(q); return o.list ? o.list(q, s.searches.length) : [] },
    } satisfies DlDriver,
  }
  return s
}

test('migration: one download row per (attempt, media)', () => {
  const { db } = rig()
  insertRow(db, 'intent')
  expect(() => db.prepare('insert into download(id,attempt_id,media_id,planned_name,state,created_at,updated_at) values(?,?,?,?,?,1,1)').run('d2', A, M, 'p', 'intent')).toThrow(/UNIQUE/)
  expect(() => db.prepare('insert into download(id,attempt_id,media_id,planned_name,state,created_at,updated_at) values(?,?,?,?,?,1,1)').run('d3', A, 'm2', 'p', 'done')).toThrow(/CHECK/)
})

test('happy path: intent first, PNG verified, moved to root/plannedName, temp file gone', async () => {
  const r = rig()
  const row = await requestDownload(r.db, r.spy, r.args(), r.env)
  const [d] = rows(r.db)
  expect([row.state, d.state, d.error_code]).toEqual(['completed', 'completed', null])
  expect(d.planned_name).toBe(`2026-11-09_b1b2b3b4/001_một con mèo_3f2b9c1e.png`) // Ho Chi Minh day, NFC
  expect(d.actual_name).toBe(d.planned_name)
  expect(magic(join(r.root, d.actual_name!))).toBe('89504e47')
  expect(d.bytes).toBe(TINY_PNG.length)
  expect(onlyFiles(r.tmp)).toEqual([]) // nothing left in ToolFlow-tmp
  expect(r.fake.ledger.fetches).toBe(1)
  expect(new Set(r.calls)).toEqual(new Set(['fetchMedia', 'downloads'])) // no prepare / click / arm / check
})

test('the intent row is written BEFORE fetchMedia is sent', async () => {
  const r = rig()
  const seen: string[] = []
  const s = stub({ fetch: async () => { seen.push((rows(r.db)[0] ?? { state: 'none' }).state); return { ok: false, code: 'DOWNLOAD_REFUSED' } } })
  await requestDownload(r.db, s.drv, r.args(), r.env)
  expect(seen).toEqual(['intent'])
  expect(rows(r.db)[0]).toMatchObject({ state: 'failed', error_code: 'DOWNLOAD_REFUSED' })
})

test('completed is a no-op: no search, no transfer', async () => {
  const r = rig()
  await requestDownload(r.db, r.spy, r.args(), r.env)
  r.calls.length = 0
  const again = await requestDownload(r.db, r.spy, r.args({ explicit: true }), r.env)
  expect(again.state).toBe('completed')
  expect(r.calls).toEqual([])
  expect(r.fake.ledger.fetches).toBe(1)
})

test('ACK lost (transfer happened): reconcile finds it, no second transfer (AC-26)', async () => {
  const r = rig(['download-ack-lost'])
  const row = await requestDownload(r.db, r.spy, r.args(), r.env)
  expect(row.state).toBe('completed')
  expect(r.fake.ledger.fetches).toBe(1)
  expect(r.calls.indexOf('downloads')).toBeGreaterThan(r.calls.indexOf('fetchMedia'))
  expect(onlyFiles(r.root)).toHaveLength(1)
})

test('ACK lost and nothing found: needs_review; a plain request never starts a transfer, an explicit retry does', async () => {
  const r = rig()
  const s = stub({ fetch: async () => { throw new ConnectorError('connection lost') } })
  expect((await requestDownload(r.db, s.drv, r.args(), r.env)).state).toBe('needs_review')
  expect(rows(r.db)[0].error_code).toBe('DOWNLOAD_ACK_LOST')
  expect(s.fetches).toBe(1)
  expect(s.searches.length).toBeGreaterThan(0) // it looked
  expect((await requestDownload(r.db, s.drv, r.args(), r.env)).state).toBe('needs_review')
  expect(s.fetches).toBe(1) // still one: never a blind second transfer
  const fresh = await requestDownload(r.db, r.spy, r.args({ explicit: true }), r.env)
  expect(fresh.state).toBe('completed')
  expect(r.fake.ledger.fetches).toBe(1)
})

test('started row: reconcile FIRST; an in-progress transfer is waited for, not duplicated', async () => {
  const r = rig()
  insertRow(r.db, 'started', '5')
  mkdirSync(r.tmp, { recursive: true })
  const path = join(r.tmp, `${A}_${M}.bin`)
  writeFileSync(path, TINY_PNG)
  const s = stub({ list: (_q, n) => (n < 4 ? [info({ id: 5, filename: path })] : [info({ id: 5, filename: path, state: 'complete', fileSize: TINY_PNG.length })]) })
  const row = await requestDownload(r.db, s.drv, r.args(), r.env)
  expect(row.state).toBe('completed')
  expect(s.fetches).toBe(0)
  expect(s.searches[0]).toEqual({ filenamePrefix: `${A}_${M}` })
})

test('started row whose transfer is already complete in the browser: finish it, no fetch', async () => {
  const r = rig()
  insertRow(r.db, 'started', '5')
  mkdirSync(r.tmp, { recursive: true })
  const path = join(r.tmp, `${A}_${M}.bin`)
  writeFileSync(path, TINY_PNG)
  const s = stub({ list: () => [info({ id: 5, filename: path, state: 'complete', fileSize: TINY_PNG.length })] })
  expect((await requestDownload(r.db, s.drv, r.args(), r.env)).state).toBe('completed')
  expect(s.fetches).toBe(0)
})

test('started row and the browser knows nothing: needs_review, no blind transfer (explicit retry may start one)', async () => {
  const r = rig()
  insertRow(r.db, 'started', '5')
  const s = stub()
  expect((await requestDownload(r.db, s.drv, r.args(), r.env)).state).toBe('needs_review')
  expect(s.fetches).toBe(0)
  await requestDownload(r.db, s.drv, r.args({ explicit: true }), r.env)
  expect(s.fetches).toBe(1) // a fresh transfer, but only on the explicit retry
})

for (const script of ['download-html', 'download-empty'] as const) test(`${script} is never completed: DOWNLOAD_NOT_IMAGE, temp file deleted, nothing in root; retry keeps the planned name`, async () => {
  const r = rig([script])
  const row = await requestDownload(r.db, r.spy, r.args(), r.env)
  expect([row.state, row.error_code]).toEqual(['failed', 'DOWNLOAD_NOT_IMAGE'])
  expect(onlyFiles(r.root)).toEqual([])
  expect(onlyFiles(r.tmp)).toEqual([])
  const planned = rows(r.db)[0].planned_name
  const retry = await requestDownload(r.db, r.spy, r.args({ at: base.at + 5 * 86_400_000, tz: 'UTC', prompt: 'different now' }), r.env) // inputs changed: the stored name wins
  expect(retry.state).toBe('completed')
  expect(rows(r.db)).toHaveLength(1)
  expect(rows(r.db)[0].planned_name).toBe(planned)
  expect(onlyFiles(r.root)).toEqual([planned.replace('/', sep)])
  expect(r.fake.ledger.fetches).toBe(2)
})

test('a target that already exists is never overwritten: numeric suffix, actual_name stored separately', async () => {
  const r = rig()
  const planned = planName({ ...base, root: r.root, batchLabel: 'b1b2b3b4', prompt: 'một con mèo', tz: 'Asia/Ho_Chi_Minh', ext: 'png' })
  mkdirSync(join(r.root, planned.split('/')[0]), { recursive: true })
  writeFileSync(join(r.root, planned), 'OLD CONTENT')
  const row = await requestDownload(r.db, r.spy, r.args(), r.env)
  expect(row.state).toBe('completed')
  expect(row.planned_name).toBe(planned)
  expect(row.actual_name).not.toBe(planned)
  expect(row.actual_name).toBe(planned.replace(/\.png$/, '-2.png'))
  expect(readFileSync(join(r.root, planned), 'utf8')).toBe('OLD CONTENT')
  expect(magic(join(r.root, row.actual_name!))).toBe('89504e47')
})

test('the real type decides the extension (JPEG, WEBP); the planned name is unchanged', async () => {
  for (const [bytes, ext] of [[Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'jpg'], [Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]), 'webp']] as const) {
    const r = rig()
    mkdirSync(r.tmp, { recursive: true })
    const path = join(r.tmp, `${A}_${M}.bin`)
    writeFileSync(path, bytes)
    const s = stub({ list: () => [info({ id: 1, filename: path, state: 'complete', fileSize: bytes.length })] })
    const row = await requestDownload(r.db, s.drv, r.args(), r.env)
    expect([row.state, row.actual_name!.endsWith(`.${ext}`), row.planned_name.endsWith('.png')]).toEqual(['completed', true, true])
  }
})

test('retry after a failed transfer: same row, same planned name, no generate/prepare/click/arm call (AC-16)', async () => {
  const r = rig(['download-fail-once'])
  const first = await requestDownload(r.db, r.spy, r.args(), r.env)
  expect(first.state).toBe('failed')
  expect(first.error_code).toMatch(/^DOWNLOAD_/)
  const planned = first.planned_name
  const before = { ...r.fake.ledger, uploads: 0, refs: 0, armLog: 0 }
  for (let i = 0; i < 3; i++) await requestDownload(r.db, r.spy, r.args({ explicit: true }), r.env) // later calls are no-ops once completed
  const [d] = rows(r.db)
  expect(rows(r.db)).toHaveLength(1)
  expect([d.state, d.planned_name]).toEqual(['completed', planned])
  const l = r.fake.ledger
  expect([l.clicks, l.prepares, l.arms, l.checks, l.readProject]).toEqual([before.clicks, before.prepares, before.arms, before.checks, before.readProject])
  expect(r.calls.filter((c) => !['fetchMedia', 'downloads'].includes(c))).toEqual([])
})

test('crash after the intent, before the send: recover() => needs_review; reconcile finds nothing; a fresh start only after an explicit retry', async () => {
  const r = rig()
  insertRow(r.db, 'intent')
  recoverDownloads(r.db)
  expect(rows(r.db)[0]).toMatchObject({ state: 'needs_review', error_code: 'DOWNLOAD_ACK_LOST' })
  const plain = await requestDownload(r.db, r.spy, r.args(), r.env)
  expect(plain.state).toBe('needs_review')
  expect(r.fake.ledger.fetches).toBe(0)
  expect(r.calls).toContain('downloads') // it did reconcile
  const fresh = await requestDownload(r.db, r.spy, r.args({ explicit: true }), r.env)
  expect(fresh.state).toBe('completed')
  expect(r.fake.ledger.fetches).toBe(1)
  expect(rows(r.db)).toHaveLength(1)
  expect(rows(r.db)[0].planned_name).toBe('day/001_x_3f2b9c1e.png') // the stored plan, not a new one
})

test('recover() leaves started / completed / failed rows alone', () => {
  const r = rig()
  insertRow(r.db, 'started', '9')
  recoverDownloads(r.db)
  expect(rows(r.db)[0].state).toBe('started')
})

test('the browser reports a path outside ToolFlow-tmp: nothing is read, moved or deleted', async () => {
  const r = rig()
  const victim = join(r.dir, 'victim.png')
  writeFileSync(victim, TINY_PNG)
  const s = stub({ list: () => [info({ id: 1, filename: victim, state: 'complete', fileSize: 1 })] })
  const row = await requestDownload(r.db, s.drv, r.args(), r.env)
  expect([row.state, row.error_code]).toEqual(['failed', 'DOWNLOAD_BAD_PATH'])
  expect(readFileSync(victim).length).toBe(TINY_PNG.length)
  expect(onlyFiles(r.root)).toEqual([])
})

test('m1/m3: a file the browser reports inside ToolFlow-tmp but not named <attempt>_<media>… is never touched', async () => {
  const r = rig()
  mkdirSync(r.tmp, { recursive: true })
  const other = join(r.tmp, 'someone-elses-download.png')
  writeFileSync(other, TINY_PNG)
  const s = stub({ list: () => [info({ id: 1, filename: other, state: 'complete', fileSize: 1 })] })
  const row = await requestDownload(r.db, s.drv, r.args(), r.env)
  expect([row.state, row.error_code]).toEqual(['failed', 'DOWNLOAD_BAD_PATH'])
  expect(readFileSync(other).length).toBe(TINY_PNG.length)
  expect(onlyFiles(r.root)).toEqual([])
})

test('m3: ToolFlow-tmp must be the folder SEGMENT: a lookalike or a nested folder is refused', async () => {
  for (const sub of ['xToolFlow-tmp', join('ToolFlow-tmp', 'sub'), 'ToolFlow-tmp-2']) {
    const r = rig()
    const d = join(r.dir, 'tmp', sub)
    mkdirSync(d, { recursive: true })
    const f = join(d, `${A}_${M}.bin`)
    writeFileSync(f, TINY_PNG)
    const row = await requestDownload(r.db, stub({ list: () => [info({ id: 1, filename: f, state: 'complete', fileSize: 1 })] }).drv, r.args(), r.env)
    expect([row.state, row.error_code], sub).toEqual(['failed', 'DOWNLOAD_BAD_PATH'])
    expect(existsSync(f)).toBe(true)
    expect(onlyFiles(r.root)).toEqual([])
  }
})

test('m3: a reported path that is a symlink or a directory is refused (DOWNLOAD_BAD_FILE); the target is never moved or deleted', async () => {
  for (const kind of ['symlink', 'dir'] as const) {
    const r = rig()
    mkdirSync(r.tmp, { recursive: true })
    const target = join(r.dir, 'real.png')
    writeFileSync(target, TINY_PNG)
    const f = join(r.tmp, `${A}_${M}.bin`)
    if (kind === 'symlink') {
      try { symlinkSync(target, f) } catch (e) {
        if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') continue // Windows: a file symlink needs admin or Developer Mode; the dir case still runs
        throw e
      }
    } else mkdirSync(f)
    const row = await requestDownload(r.db, stub({ list: () => [info({ id: 1, filename: f, state: 'complete', fileSize: 1 })] }).drv, r.args(), r.env)
    expect([row.state, row.error_code], kind).toEqual(['failed', 'DOWNLOAD_BAD_FILE'])
    expect(readFileSync(target).length).toBe(TINY_PNG.length)
    expect(onlyFiles(r.root)).toEqual([])
  }
})

test('an interrupted transfer is failed with the browser code; a transfer that never ends is needs_review after the budget', async () => {
  const r = rig()
  const dead = stub({ list: () => [info({ id: 1, state: 'interrupted', error: 'NETWORK_FAILED' })] })
  expect(rows(r.db)).toHaveLength(0)
  const row = await requestDownload(r.db, dead.drv, r.args(), r.env)
  expect([row.state, row.error_code]).toEqual(['failed', 'DOWNLOAD_NETWORK_FAILED'])
  const r2 = rig()
  const stuck = stub({ list: () => [info({ id: 1 })] })
  const slow = await requestDownload(r2.db, stuck.drv, r2.args(), r2.env)
  expect([slow.state, slow.error_code]).toEqual(['needs_review', 'DOWNLOAD_TIMEOUT'])
  expect(stuck.fetches).toBe(1)
})

test('a failed move (disk) keeps the finished temp file for a reconcile instead of downloading again', async () => {
  const r = rig()
  mkdirSync(r.root, { recursive: true })
  writeFileSync(join(r.root, '2026-11-09_b1b2b3b4'), 'a file where the batch folder must go') // mkdir will fail
  const row = await requestDownload(r.db, r.spy, r.args(), r.env)
  expect([row.state, row.error_code]).toEqual(['needs_review', 'DOWNLOAD_MOVE_FAILED'])
  expect(onlyFiles(r.tmp)).toHaveLength(1)
  const fetches = r.fake.ledger.fetches
  rmSync(join(r.root, '2026-11-09_b1b2b3b4'))
  expect((await requestDownload(r.db, r.spy, r.args(), r.env)).state).toBe('completed')
  expect(r.fake.ledger.fetches).toBe(fetches)
})

// ---------- downloader over a batch ----------
function batchRig(script: DownloadScript[] = [], n = 3, tab: () => string | null = () => 't1') {
  const r = rig(script)
  const ids = Array.from({ length: n }, (_, i) => `3f2b9c1e-1111-4222-8333-44445555666${i}`)
  const { batchId } = enqueueBatch(r.db, { commandId: 'c1', kind: 'image', projectId: 'p', settings: {}, prompts: ids.map((_, i) => `prompt ${i}`), refs: ids.map(() => []), mode: 'auto' })
  const atts = r.db.prepare('select a.id id from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(batchId) as { id: string }[]
  atts.forEach((a, i) => r.db.prepare("update attempt set state_json=json_set(state_json,'$.outputs',json(?)) where id=?").run(JSON.stringify([{ mediaId: ids[i] }]), a.id))
  let active = 0, max = 0
  const driver: DlDriver = {
    async fetchMedia(t, p) { active++; max = Math.max(max, active); await new Promise((res) => setTimeout(res, 15)); try { return await r.fake.fetchMedia(t, p) } finally { active-- } },
    downloads: (q) => r.fake.downloads(q),
  }
  const changes: string[] = []
  const dl = createDownloader({ db: r.db, driver, root: r.root, tz: 'UTC', now: r.env.now, sleep: r.env.sleep, tab, onChange: (b) => changes.push(b) })
  return { ...r, batchId, atts, ids, dl, maxActive: () => max, changes }
}

test('downloadBatch: every output, at most 2 at a time, three PNG files on disk', async () => {
  const b = batchRig()
  await b.dl.batch(b.batchId)
  expect(rows(b.db).map((x) => x.state)).toEqual(['completed', 'completed', 'completed'])
  expect(b.maxActive()).toBe(2)
  const pngs = onlyFiles(b.root)
  expect(pngs).toHaveLength(3)
  for (const f of pngs) expect(magic(join(b.root, f))).toBe('89504e47')
  expect(b.changes.length).toBeGreaterThan(3)
  await b.dl.batch(b.batchId) // completed rows are skipped
  expect(b.fake.ledger.fetches).toBe(3)
})

test('the same output requested twice at once makes one transfer', async () => {
  const b = batchRig([], 1)
  await Promise.all([b.dl.retry(b.atts[0].id, b.ids[0]), b.dl.retry(b.atts[0].id, b.ids[0]), b.dl.batch(b.batchId)])
  expect(b.fake.ledger.fetches).toBe(1)
  expect(rows(b.db)).toHaveLength(1)
})

test('batch with one bad file: that output fails, the others complete, Thử lại (retry) fixes it with the same name', async () => {
  const b = batchRig(['download-html'], 3)
  await b.dl.batch(b.batchId)
  const states = rows(b.db).map((x) => x.state).sort()
  expect(states).toEqual(['completed', 'completed', 'failed'])
  const bad = rows(b.db).find((x) => x.state === 'failed')!
  const clicks = b.fake.ledger.clicks
  const att = b.db.prepare('select attempt_id a, media_id m from download where state=?').get('failed') as { a: string; m: string }
  await b.dl.retry(att.a, att.m)
  expect(rows(b.db).map((x) => x.state)).toEqual(['completed', 'completed', 'completed'])
  expect(rows(b.db).find((x) => x.planned_name === bad.planned_name)!.actual_name).toBe(bad.planned_name)
  expect(b.fake.ledger.clicks).toBe(clicks)
})

test('downloader refuses what it does not own, and a missing tab', async () => {
  const b = batchRig()
  await expect(b.dl.retry(b.atts[0].id, 'aaaaaaaa-1111-4222-8333-444455556666')).rejects.toMatchObject({ code: 'NOT_FOUND' }) // not an output of that attempt
  await expect(b.dl.retry('nope', b.ids[0])).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(b.dl.batch('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  const noTab = batchRig([], 1, () => null)
  await expect(noTab.dl.batch(noTab.batchId)).rejects.toMatchObject({ code: 'NO_PROJECT_TAB' })
  expect(rows(noTab.db)).toHaveLength(0)
  expect(rows(b.db)).toHaveLength(0)
})

test('Tải tất cả never restarts a needs_review output (only Thử lại does)', async () => {
  const b = batchRig([], 1)
  b.db.prepare('insert into download(id,attempt_id,media_id,planned_name,state,error_code,created_at,updated_at) values(?,?,?,?,?,?,1,1)').run('d1', b.atts[0].id, b.ids[0], 'day/001_x_3f2b9c1e.png', 'needs_review', 'DOWNLOAD_ACK_LOST')
  await b.dl.batch(b.batchId)
  expect(rows(b.db)[0].state).toBe('needs_review')
  expect(b.fake.ledger.fetches).toBe(0)
  await b.dl.retry(b.atts[0].id, b.ids[0])
  expect(rows(b.db)[0].state).toBe('completed')
  expect(b.fake.ledger.fetches).toBe(1)
})
