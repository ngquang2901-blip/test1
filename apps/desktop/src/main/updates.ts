// Auto-update: check at start and every few hours, download in the background, install on the user's click (never while a
// batch is sending) or when the app quits. The updater is injected: electron-updater when packaged, a fake in e2e, none in dev.
import { EventEmitter } from 'node:events'

export type UpdateState = {
  state: 'off' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'
  current: string; version?: string; percent?: number; code?: string
}
/** The part of electron-updater's AppUpdater this module uses. */
export type Updater = Pick<EventEmitter, 'on'> & {
  autoDownload: boolean; autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}
const coded = (code: string): Error => Object.assign(new Error(code), { code })
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export function createUpdates(o: {
  updater: Updater | null; current: string; emit(s: UpdateState): void
  busy(): boolean // a batch is sending: a restart now could turn an attempt uncertain
  beforeInstall?(): void // right before the installer starts and the app quits
  every?: number; first?: number; setTimer?: (f: () => void, ms: number) => unknown; setRepeat?: (f: () => void, ms: number) => unknown
}) {
  let s: UpdateState = { state: o.updater ? 'idle' : 'off', current: o.current }
  const set = (p: Partial<UpdateState>): void => { s = { current: o.current, ...p } as UpdateState; o.emit(s) }
  const u = o.updater
  if (u) {
    u.autoDownload = true
    u.autoInstallOnAppQuit = true // a downloaded update goes in when the user closes the app anyway
    u.on('checking-for-update', () => { if (s.state !== 'ready' && s.state !== 'downloading') set({ state: 'checking' }) })
    u.on('update-available', (i: { version: string }) => set({ state: 'available', version: i.version }))
    u.on('update-not-available', () => { if (s.state !== 'ready') set({ state: 'none' }) })
    u.on('download-progress', (p: { percent: number }) => set({ state: 'downloading', version: s.version, percent: Math.floor(p.percent) }))
    u.on('update-downloaded', (i: { version: string }) => set({ state: 'ready', version: i.version }))
    u.on('error', (e: { code?: string }) => { if (s.state !== 'ready') set({ state: 'error', code: e?.code ?? 'UPDATE_FAILED' }) }) // codes only: messages carry URLs and paths
  }
  const check = async (): Promise<UpdateState> => {
    if (!u) return s
    if (s.state === 'ready' || s.state === 'downloading' || s.state === 'checking') return s // one at a time; a ready one waits for the restart
    try { await u.checkForUpdates() } catch (e) { if ((s as UpdateState).state !== 'ready') set({ state: 'error', code: (e as { code?: string }).code ?? 'UPDATE_FAILED' }) }
    return s
  }
  return {
    get: (): UpdateState => s,
    check,
    start(): void {
      if (!u) return
      ;(o.setTimer ?? setTimeout)(() => void check(), o.first ?? 15_000) // after the window is up and the connector settled
      ;(o.setRepeat ?? setInterval)(() => void check(), o.every ?? CHECK_EVERY_MS)
    },
    /** The user's "Khởi động lại để cập nhật". Refused while a batch is sending; the update then installs when the app quits. */
    install(): void {
      if (!u || s.state !== 'ready') throw coded('NO_UPDATE_READY')
      if (o.busy()) throw coded('BATCH_RUNNING')
      o.beforeInstall?.()
      u.quitAndInstall(true, true) // silent installer, the new version starts by itself
    },
  }
}
export type Updates = ReturnType<typeof createUpdates>

/** e2e only: plays a release `version` (available → 50% → downloaded) on the first check, or `none`. Records quitAndInstall. */
export function createFakeUpdater(version: string): Updater & { installs: Array<[boolean?, boolean?]> } {
  const em = new EventEmitter()
  const f = Object.assign(em, {
    autoDownload: false, autoInstallOnAppQuit: false, installs: [] as Array<[boolean?, boolean?]>,
    async checkForUpdates() {
      em.emit('checking-for-update')
      if (version === 'none') { em.emit('update-not-available', {}); return null }
      if (version === 'error') { em.emit('error', Object.assign(new Error('net'), { code: 'ERR_UPDATER_FAKE' })); return null }
      em.emit('update-available', { version })
      setTimeout(() => em.emit('download-progress', { percent: 50.7 }), 50)
      setTimeout(() => em.emit('update-downloaded', { version }), 300)
      return { updateInfo: { version } }
    },
    quitAndInstall(a?: boolean, b?: boolean) { f.installs.push([a, b]) },
  })
  return f
}
