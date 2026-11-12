import { test, expect } from 'vitest'
import { createFakeUpdater, createUpdates, type UpdateState } from '../src/main/updates'

const rig = (version: string, busy = false) => {
  const seen: UpdateState[] = []
  const timers: Array<[string, number]> = []
  const updater = createFakeUpdater(version)
  const b = { busy }, order: string[] = []
  const quit = updater.quitAndInstall.bind(updater); updater.quitAndInstall = (x, y) => { order.push('quitAndInstall'); quit(x, y) }
  const u = createUpdates({ updater, current: '0.4.1', emit: (s) => seen.push(s), busy: () => b.busy, beforeInstall: () => order.push('windows hidden'), setTimer: (_f, ms) => timers.push(['once', ms]), setRepeat: (_f, ms) => timers.push(['every', ms]) })
  return { u, seen, timers, updater, b, order }
}
const settle = () => new Promise((r) => setTimeout(r, 400))

test('a new version: checking → available → downloading % → ready; install restarts silently and starts the new one', async () => {
  const r = rig('0.4.2')
  expect(r.updater.autoDownload && r.updater.autoInstallOnAppQuit).toBe(true)
  expect(r.u.get()).toEqual({ state: 'idle', current: '0.4.1' })
  await r.u.check(); await settle()
  expect(r.seen.map((s) => s.state)).toEqual(['checking', 'available', 'downloading', 'ready'])
  expect(r.seen[2]).toEqual({ state: 'downloading', current: '0.4.1', version: '0.4.2', percent: 50 })
  expect(r.u.get()).toEqual({ state: 'ready', current: '0.4.1', version: '0.4.2' })
  await r.u.check() // a ready update is not checked again
  expect(r.seen).toHaveLength(4)
  r.u.install()
  expect(r.updater.installs).toEqual([[true, true]])
  expect(r.order).toEqual(['windows hidden', 'quitAndInstall']) // seen on Windows: the window showed "Not responding" until the installer replaced the app
})

test('never restarts while a batch is sending: BATCH_RUNNING, nothing installed; once it is done, install works', async () => {
  const r = rig('0.4.2', true)
  await r.u.check(); await settle()
  expect(() => r.u.install()).toThrow(/BATCH_RUNNING/)
  expect(r.updater.installs).toEqual([])
  expect(r.order).toEqual([]) // refused: the window stays
  r.b.busy = false
  r.u.install()
  expect(r.updater.installs).toHaveLength(1)
})

test('no update, an error (code only), nothing ready to install; start schedules a first check and a repeat', async () => {
  const none = rig('none')
  await none.u.check()
  expect(none.u.get()).toEqual({ state: 'none', current: '0.4.1' })
  expect(() => none.u.install()).toThrow(/NO_UPDATE_READY/)
  none.u.start()
  expect(none.timers).toEqual([['once', 15_000], ['every', 6 * 60 * 60 * 1000]])
  const bad = rig('error')
  await bad.u.check()
  expect(bad.u.get()).toEqual({ state: 'error', current: '0.4.1', code: 'ERR_UPDATER_FAKE' })
})

test('without an updater (dev, or no update source configured) the state is off and every call is a no-op', async () => {
  const seen: UpdateState[] = []
  const u = createUpdates({ updater: null, current: '0.4.1', emit: (s) => seen.push(s), busy: () => false })
  expect(await u.check()).toEqual({ state: 'off', current: '0.4.1' })
  u.start()
  expect(() => u.install()).toThrow(/NO_UPDATE_READY/)
  expect(seen).toEqual([])
})
