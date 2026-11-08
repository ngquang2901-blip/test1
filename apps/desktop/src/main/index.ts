import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import extManifest from '../../../extension/manifest.json'
import { openDb } from './db'
import { createRunner } from './runner'
import { autoAllowed } from './account'
import { selfCheck, type Probe } from './profile'
import { createFakeDriver, type FakeScript } from './fake-driver'
import { createHandlers, registerIpc, revisioned, type Draft } from './ipc'
import { readOrCreateToken, installExtension } from './connector/pairing'
import { createExtDriver } from './connector/ext-driver'
import { startConnectorServer } from './connector/server'
import { EXT_ID } from './connector/ext-id'
import type { FlowDriver } from './driver'

if (process.env.TOOLFLOW_USER_DATA) app.setPath('userData', process.env.TOOLFLOW_USER_DATA) // before anything reads userData (R52)

const FAKE = process.env.TOOLFLOW_FAKE_DRIVER === '1'
const DEFAULT_DRAFT: Draft = { text: '', kind: 'image', mode: 'auto', speed: 'default' }

// Test only: the e2e "no outbound network" check reads every request of the session (AC-32).
const requests: string[] = []
;(globalThis as { __toolflowRequests?: string[] }).__toolflowRequests = requests

function readDraft(file: string): Draft {
  try { return { ...DEFAULT_DRAFT, ...JSON.parse(readFileSync(file, 'utf8')) } } catch { return DEFAULT_DRAFT }
}

async function boot(win: () => BrowserWindow | undefined): Promise<void> {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const db = openDb(join(userData, 'toolflow.db'))
  const draftFile = join(userData, 'draft.json')
  let draft = readDraft(draftFile)
  // E2E only: a clock that runs X times faster so the 30 s send deadline / 10 min reconcile fit a test (fake mode only).
  const t0 = Date.now()
  const x = FAKE ? Number(process.env.TOOLFLOW_CLOCK_X ?? 1) : 1
  const clock = { now: () => t0 + (Date.now() - t0) * x }

  let driver: FlowDriver
  let tabs: string[]
  let probe: () => Omit<Probe, 'extVersion' | 'ping'>
  let extVersion: string = extManifest.version
  if (FAKE) {
    const scripted = (process.env.TOOLFLOW_FAKE_SCRIPT ?? '').split(',').filter(Boolean) as FakeScript
    const fake = createFakeDriver([...scripted, ...Array<FakeScript[number]>(50).fill('image-ok')]) // default: everything succeeds
    driver = { ...fake, ping: async (t) => ({ ...(await fake.ping(t)), t: clock.now() }) } // heartbeat age is judged on the app clock
    tabs = ['t1']
    extVersion = '0.0.0-fake'
    probe = () => ({ present: { editor: true, submit: true }, listeners: 1, sawProjectLoad: true })
  } else {
    const token = readOrCreateToken(userData)
    const server = await startConnectorServer({ token, extensionId: EXT_ID })
    // shortcut: dev path only, packaged resources path in P4
    installExtension(join(app.getAppPath(), '../extension'), userData, server.port)
    driver = createExtDriver(server)
    tabs = [] // shortcut: tab discovery is not built, live in P2
    // shortcut: extension probe op, live in P2 — fail closed
    probe = () => ({ present: {}, listeners: 0, sawProjectLoad: false })
  }

  const runner = createRunner({ db, driver, clock, tabs, speed: draft.speed, autoAllowed: (e) => autoAllowed(db, e) })
  runner.recover()
  const email = async (): Promise<string | null> => (tabs[0] ? (await driver.ping(tabs[0])).email : null)
  const emit = revisioned((e) => win()?.webContents.send('state', e))
  const h = createHandlers({
    db, runner, clock, emit, email,
    projectId: FAKE ? 'fake-project' : 'unbound', // shortcut: project comes from the live tab in P2
    saveDraft: (d) => { draft = d; writeFileSync(draftFile, JSON.stringify(d)) },
    async session() {
      const em = await email()
      const ping = tabs[0] ? await driver.ping(tabs[0]) : null
      return {
        fake: FAKE, tabs, email: em, draft, speedInUse: runner.caps(),
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
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  mainWindow.on('ready-to-show', () => mainWindow.show())
  // AC-32: nothing leaves the app window
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
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
    await boot(() => win)
    win = createWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
