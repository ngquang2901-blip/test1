import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import extManifest from '../../../extension/manifest.json'
import { openDb } from './db'
import { createRunner } from './runner'
import { autoAllowed, enableAuto } from './account'
import { selfCheck, type Probe } from './profile'
import { createFakeDriver, type FakeScript } from './fake-driver'
import { createHandlers, registerIpc, revisioned, parseDraft, type Draft } from './ipc'
import { clockFactor, errorCode } from './boot-util'
import { readOrCreateToken, installExtension } from './connector/pairing'
import { createExtDriver } from './connector/ext-driver'
import { startConnectorServer } from './connector/server'
import { EXT_ID } from './connector/ext-id'
import type { FlowDriver } from './driver'

if (process.env.TOOLFLOW_USER_DATA) app.setPath('userData', process.env.TOOLFLOW_USER_DATA) // before anything reads userData (R52)

const FAKE = process.env.TOOLFLOW_FAKE_DRIVER === '1'

// Test only: the e2e "no outbound network" check reads every request of the session (AC-32).
const requests: string[] = []
;(globalThis as { __toolflowRequests?: string[] }).__toolflowRequests = requests

function readDraft(file: string): Draft {
  try { return parseDraft(JSON.parse(readFileSync(file, 'utf8'))) } catch { return parseDraft(null) }
}

async function boot(win: () => BrowserWindow | undefined): Promise<void> {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const db = openDb(join(userData, 'toolflow.db'))
  const draftFile = join(userData, 'draft.json')
  let draft = readDraft(draftFile)
  // E2E only: a clock that runs X times faster so the 30 s send deadline / 10 min reconcile fit a test (fake mode only).
  const t0 = Date.now()
  const x = FAKE ? clockFactor(process.env.TOOLFLOW_CLOCK_X) : 1
  const clock = { now: () => t0 + (Date.now() - t0) * x }

  let driver: FlowDriver
  let tabs: string[]
  let rawPing: FlowDriver['ping'] // self-check judges heartbeat age on the wall clock, not the accelerated test clock
  let probe: () => Omit<Probe, 'extVersion' | 'ping'>
  let connected: (() => boolean) | null = null // real mode only
  let connectorError: string | null = null
  let extVersion: string = extManifest.version
  if (FAKE) {
    const scripted = (process.env.TOOLFLOW_FAKE_SCRIPT ?? '').split(',').filter(Boolean) as FakeScript
    const fake = createFakeDriver([...scripted, ...Array<FakeScript[number]>(50).fill('image-ok')]) // default: everything succeeds
    rawPing = fake.ping
    driver = { ...fake, ping: async (t) => ({ ...(await fake.ping(t)), t: clock.now() }) } // heartbeat age is judged on the app clock
    tabs = ['t1']
    if (process.env.TOOLFLOW_FAKE_AUTO !== '0') enableAuto(db, 'fake@example.invalid', Date.now()) // test fixture: the fake account has opted in; '0' keeps D-19 default (off)
    extVersion = '0.0.0-fake'
    probe = () => ({ present: { editor: true, submit: true }, listeners: 1, sawProjectLoad: true })
  } else {
    tabs = [] // shortcut: tab discovery is not built, live in P2
    // shortcut: extension probe op, live in P2 — fail closed
    probe = () => ({ present: {}, listeners: 0, sawProjectLoad: false })
    rawPing = () => Promise.reject(new Error('no driver'))
    driver = { onEvent: () => () => {} } as unknown as FlowDriver // connector failed: no tabs, so the runner never calls it
    try {
      const token = readOrCreateToken(userData)
      const server = await startConnectorServer({ token, extensionId: EXT_ID })
      // shortcut: dev path only, packaged resources path in P4
      installExtension(process.env.TOOLFLOW_EXT_DIR ?? join(app.getAppPath(), '../extension'), userData, server.port)
      driver = createExtDriver(server)
      rawPing = driver.ping
      connected = server.connected
    } catch (e) {
      connectorError = errorCode(e) // code only: messages carry paths and tokens
      console.error('connector setup failed', connectorError)
    }
  }

  const runner = createRunner({ db, driver, clock, tabs, speed: draft.speed, autoAllowed: (e) => autoAllowed(db, e) })
  runner.recover()
  const email = async (): Promise<string | null> => (tabs[0] ? (await driver.ping(tabs[0])).email : null)
  const emit = revisioned((e) => win()?.webContents.send('state', e))
  const h = createHandlers({
    db, runner, clock, emit, email,
    projectId: FAKE ? 'fake-project' : 'unbound', // shortcut: project comes from the live tab in P2
    getDraft: () => draft,
    saveDraft: (d) => { draft = d; writeFileSync(draftFile, JSON.stringify(d)) },
    async session() {
      const em = await email()
      const ping = tabs[0] ? await rawPing(tabs[0]) : null
      return {
        fake: FAKE, connected: connected ? connected() : null, connectorError, tabs, email: em, draft, speedInUse: runner.caps(),
        autoEnabled: autoAllowed(db, em),
        selfCheck: ping ? selfCheck({ ...probe(), ping, extVersion }) : null,
      }
    },
  })
  registerIpc(ipcMain, h)

  // The runner changes rows on its own: tell the renderer when a batch's rows moved.
  const seen = new Map<string, string>()
  const scan = (): void => {
    for (const r of db.prepare("select b.id, b.revision || ':' || coalesce((select sum(a.revision) from item i join attempt a on a.item_id=i.id where i.batch_id=b.id),0) sig from batch b").all() as { id: string; sig: string }[]) {
      if (seen.get(r.id) !== r.sig) { seen.set(r.id, r.sig); emit('batch', r.id) }
    }
  }
  setInterval(() => { runner.tick().catch((e) => console.error('tick', e)).finally(scan) }, 200)
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  mainWindow.on('ready-to-show', () => mainWindow.show())
  // AC-32: nothing leaves the app window
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  return mainWindow
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.focus()
  })
  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.toolflow')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
    if (process.env.TOOLFLOW_E2E === '1') {
      electronSession.defaultSession.webRequest.onBeforeRequest((d, cb) => { requests.push(d.url); cb({}) })
    }
    let win: BrowserWindow | undefined
    try { await boot(() => win) } catch (e) { console.error('boot failed', errorCode(e)) } // the window must still appear
    win = createWindow()
  })
}

// AC-32: every webContents, not just ours, may neither navigate nor open windows
app.on('web-contents-created', (_, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => e.preventDefault())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
