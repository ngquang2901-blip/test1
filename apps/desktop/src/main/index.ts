import { app, BrowserWindow, dialog, ipcMain, nativeImage, session as electronSession, shell } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import extManifest from '../../../extension/manifest.json'
import { openDb } from './db'
import { createAssetStore, registerAsset } from './assets'
import { batchStatus, createRunner } from './runner'
import { autoAllowed, autoGate, enableAuto } from './account'
import { selfCheckTab, validateProfile, profile, PROFILE_PATH } from './profile'
import { createFakeDriver, type DownloadScript, type FakeScript } from './fake-driver'
import { createDownloader, recoverDownloads } from './downloads'
import { createMcpSwitch, toolsOf } from './mcp'
import { autoUpdater } from 'electron-updater'
import { createFakeUpdater, createUpdates, type Updater } from './updates'
import { createWorkflows } from './workflow'
import { createHandlers, registerIpc, revisioned, parseDraft, type Draft } from './ipc'
import { clockFactor, errorCode } from './boot-util'
import { readOrCreateToken, installExtension } from './connector/pairing'
import { createExtDriver } from './connector/ext-driver'
import { startConnectorServer } from './connector/server'
import { EXT_ID } from './connector/ext-id'
import type { FlowDriver } from './driver'
import { createGrants, tabStatus, type Grants } from './tabs'

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
  const assets = createAssetStore(db)
  // E2E only: a clock that runs X times faster so the 30 s send deadline / 10 min reconcile fit a test (fake mode only).
  const t0 = Date.now()
  const x = FAKE ? clockFactor(process.env.TOOLFLOW_CLOCK_X) : 1
  const clock = { now: () => t0 + (Date.now() - t0) * x }

  let driver: FlowDriver
  let grants!: Grants // assigned once the runner exists; the ext driver only asks it lazily
  let rawPing: FlowDriver['ping'] // self-check judges heartbeat age on the wall clock, not the accelerated test clock
  let connected: (() => boolean) | null = null // real mode only
  let connectorError: string | null = null
  let extVersion: string = extManifest.version
  if (FAKE) {
    const scripted = (process.env.TOOLFLOW_FAKE_SCRIPT ?? '').split(',').filter(Boolean) as FakeScript
    const fake = createFakeDriver([...scripted, ...Array<FakeScript[number]>(50).fill('image-ok')], { assets, version: process.env.TOOLFLOW_FAKE_EXT_VERSION, tabs: Number(process.env.TOOLFLOW_FAKE_TABS ?? 1), downloads: (process.env.TOOLFLOW_FAKE_DOWNLOADS ?? '').split(',').filter(Boolean) as DownloadScript[], prepare: (process.env.TOOLFLOW_FAKE_PREPARE ?? '').split(',').filter(Boolean), autoPollMs: 400 }) // default: everything succeeds
    rawPing = fake.ping
    if (process.env.TOOLFLOW_E2E === '1') (globalThis as { __toolflowFake?: unknown }).__toolflowFake = fake.ledger // test-only: lets e2e count uploads
    driver = { ...fake, ping: async (t) => ({ ...(await fake.ping(t)), t: clock.now() }) } // heartbeat age is judged on the app clock
    if (process.env.TOOLFLOW_FAKE_AUTO !== '0') enableAuto(db, 'fake@example.invalid', Date.now()) // test fixture: the fake account has opted in; '0' keeps D-19 default (off)
    extVersion = '0.0.0-fake'
  } else {
    rawPing = () => Promise.reject(new Error('no driver'))
    driver = { onEvent: () => () => {} } as unknown as FlowDriver // connector failed: no tabs, so the runner never calls it
    try {
      const token = readOrCreateToken(userData)
      const server = await startConnectorServer({ token, extensionId: EXT_ID })
      // packaged: electron-builder copies apps/extension to resources/extension (extraResources)
      const ext = installExtension(process.env.TOOLFLOW_EXT_DIR ?? (app.isPackaged ? join(process.resourcesPath, 'extension') : join(app.getAppPath(), '../extension')), userData, server.port, app.getVersion())
      extVersion = ext.version || extVersion // what the page must report; a mismatch means Chrome still runs an older copy
      driver = createExtDriver(server, { allow: (id) => grants.has(id), assets })
      rawPing = driver.ping
      connected = server.connected
    } catch (e) {
      connectorError = errorCode(e) // code only: messages carry paths and tokens
      console.error('connector setup failed', connectorError)
    }
  }

  const runner = createRunner({ db, driver, clock, tabs: [], speed: draft.speed, autoAllowed: (e) => autoGate(db, e, validateProfile(profile)),
    projectOf: (t) => grants.projectOf(t), // each tab only takes batches of the project it shows
    selfCheckOk: async (t) => (await selfCheckTab(driver, await rawPing(t), t, extVersion)).ok }) // wall-clock ping like session(); no probeTab ⇒ manual
  grants = createGrants(driver, runner)
  if (FAKE && process.env.TOOLFLOW_FAKE_GRANT !== '0') { await grants.list(); grants.use(['t1']) } // test fixture: t1 pre-granted; '0' lets e2e click "Dùng tab này"
  runner.recover()
  const email = async (): Promise<string | null> => { const t = grants.granted()[0]; return t ? (await driver.ping(t)).email : null }
  const emails = async (): Promise<string[]> => [...new Set((await grants.list().catch(() => [])).filter((t) => grants.has(t.tabId)).map((t) => t.email).filter((e): e is string => !!e))]
  const emit = revisioned((e) => win()?.webContents.send('state', e))
  recoverDownloads(db) // an intent without a reply may or may not have started: needs_review, reconciled on the next request
  // The root is not user-configurable yet; TOOLFLOW_DOWNLOAD_ROOT redirects it in fake mode only (e2e).
  const downloadRoot = FAKE && process.env.TOOLFLOW_DOWNLOAD_ROOT ? process.env.TOOLFLOW_DOWNLOAD_ROOT : join(homedir(), 'Downloads', 'ToolFlow')
  const downloader = createDownloader({ db, driver, root: downloadRoot, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now, tab: () => grants.granted()[0] ?? null, onChange: (b) => emit('batch', b) })
  // Update source: TOOLFLOW_UPDATE_URL (http/https) or the URL baked into resources/app-update.yml at build; a placeholder
  // (*.invalid, see electron-builder.yml) or a dev run means no updater. FAKE + TOOLFLOW_FAKE_UPDATE plays a fake release (e2e).
  const updater = ((): Updater | null => {
    if (FAKE) { const f = process.env.TOOLFLOW_FAKE_UPDATE ? createFakeUpdater(process.env.TOOLFLOW_FAKE_UPDATE) : null; (globalThis as { __toolflowUpdater?: unknown }).__toolflowUpdater = f; return f } // e2e reads its installs
    if (!app.isPackaged) return null
    const url = process.env.TOOLFLOW_UPDATE_URL
    if (url && /^https?:\/\//.test(url)) autoUpdater.setFeedURL({ provider: 'generic', url })
    else { try { if (/\.invalid\b/.test(readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8'))) return null } catch { return null } }
    autoUpdater.logger = null // its log lines carry the feed URL and file paths
    return autoUpdater as unknown as Updater
  })()
  let wfActive = (): boolean => false // set once the workflows exist (below)
  const inFlight = db.prepare("select a.state_json j from attempt a join item i on i.attempt_id=a.id join batch b on b.id=i.batch_id where b.archived=0")
  const updates = createUpdates({
    updater, current: app.getVersion(), emit: (s) => win()?.webContents.send('update', s),
    // only an attempt between prepare and its result is at risk; queued ones simply go on after the restart
    busy: () => wfActive() || (inFlight.all() as { j: string }[]).some((r) => ['preparing', 'submitting', 'awaiting_user', 'generating'].includes(JSON.parse(r.j).item)), // a workflow between two nodes would lose its later nodes
    ...(FAKE ? { first: 500 } : {}),
  })
  updates.start()
  const h = createHandlers({
    updates,
    db, runner, clock, emit, email, emails, grants, downloader, openExtensionFolder: () => void shell.openPath(join(userData, 'extension')), reveal: (p) => shell.showItemInFolder(p),
    thumb(file) { // PNG/JPEG decode everywhere; a format Electron cannot decode (WEBP on some builds) comes back empty and the full file is shown
      const im = nativeImage.createFromBuffer(file)
      return im.isEmpty() || im.getSize().width <= 640 ? null : im.resize({ width: 640, quality: 'good' }).toJPEG(82)
    },
    projects: async () => (grants.projects().length ? grants.projects() : (await grants.list().catch(() => []), grants.projects())), // projects of the granted tabs (fake: its tabs' projects too)
    // FAKE only: e2e names the files in a JSON list because Playwright cannot drive a native dialog; real mode always opens the dialog
    async pickPaths() {
      if (FAKE && process.env.TOOLFLOW_PICK_REFS) return JSON.parse(readFileSync(process.env.TOOLFLOW_PICK_REFS, 'utf8')) as string[]
      const w = win(), o = { properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[], filters: [{ name: 'Ảnh', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }
      const r = await (w ? dialog.showOpenDialog(w, o) : dialog.showOpenDialog(o))
      return r.canceled ? [] : r.filePaths
    },
    getDraft: () => draft,
    saveDraft: (d) => { draft = d; writeFileSync(draftFile, JSON.stringify(d)) },
    async session() {
      const em = await email()
      const t0 = grants.granted()[0]
      const ping = t0 ? await rawPing(t0) : null
      const list = await grants.list().catch(() => []) // extension absent ⇒ empty list
      const tabs = list.map((t) => ({ ...t, status: tabStatus(t), granted: grants.has(t.tabId) }))
      const accts = [...new Set(tabs.filter((t) => t.granted).map((t) => t.email).filter((e): e is string => !!e))]
      return {
        extDir: FAKE ? null : join(userData, 'extension'), // shown in S1 so the user can paste it into Chrome's folder dialog (not secret: pair.json inside is)
        fake: FAKE, connected: connected ? connected() : null, connectorError, tabs, email: em, draft, speedInUse: runner.caps(),
        accounts: accts.map((e) => ({ email: e, auto: autoAllowed(db, e) })), // auto is per account; the runner checks each tab's own
        autoEnabled: accts.length ? accts.every((e) => autoAllowed(db, e)) : autoAllowed(db, em),
        selfCheck: t0 && ping ? await selfCheckTab(driver, ping, t0, extVersion) : validateProfile(profile) ? { ok: false, code: 'CONFIG_INCOMPLETE', reasons: [`PROFILE_INVALID:${PROFILE_PATH}`] } : null,
      }
    },
  })
  // Node workflows run through the very handlers the screens call; a result becomes a ref by registering its saved file.
  // FAKE only: e2e names the file because Playwright cannot drive a native dialog (same idea as TOOLFLOW_PICK_REFS)
  const wfDialog = async (save: string | null): Promise<string | null> => {
    if (FAKE) return process.env.TOOLFLOW_WF_FILE ?? null
    const w = win(), filters = [{ name: 'Workflow ToolFlow', extensions: ['json'] }]
    if (save !== null) { const o = { defaultPath: save, filters }; return (await (w ? dialog.showSaveDialog(w, o) : dialog.showSaveDialog(o))).filePath || null }
    const o = { properties: ['openFile' as const], filters }
    return (await (w ? dialog.showOpenDialog(w, o) : dialog.showOpenDialog(o))).filePaths[0] ?? null
  }
  const wf = createWorkflows({
    savePath: (name) => wfDialog(name), openPath: () => wfDialog(null),
    db, now: () => clock.now(), enqueue: (a) => h.enqueueBatch(a), start: (b) => h.startBatch(b), stop: (b) => h.stopBatch(b), download: (b) => h.downloadBatch(b),
    status: (b) => batchStatus(db, b), register: (p) => registerAsset(db, p, clock.now()).id,
    outputs: (b) => (db.prepare('select a.id aid, a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(b) as { aid: string; j: string }[]).map((r) => {
      for (const o of (JSON.parse(r.j).outputs ?? []) as { mediaId: string }[]) try { return downloader.file(r.aid, o.mediaId) } catch { /* not saved: try the next one */ }
      return null
    }),
    codes: (b) => (db.prepare("select json_extract(a.state_json,'$.error.code') c from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord").all(b) as { c: string | null }[]).map((r) => r.c),
  })
  wfActive = wf.active
  // MCP: an AI agent on this machine drives the same handlers the screens call. Off until the user turns it on in Cài đặt.
  const mcp = createMcpSwitch({
    file: join(userData, 'mcp.json'), port: Number(process.env.TOOLFLOW_MCP_PORT ?? 47615), version: app.getVersion(), // a fixed port, so the agent's config survives restarts
    tools: toolsOf({ enqueue: (a) => h.enqueueBatch(a), start: (b) => h.startBatch(b), download: (b) => h.downloadBatch(b), list: () => h.listBatches(), file: (a, m) => downloader.file(a, m) }),
  })
  mcp.start().catch((e) => console.error('mcp', (e as { code?: string })?.code ?? 'INTERNAL_ERROR'))
  const mcpHandlers = {
    async getMcp() { return mcp.state() },
    async setMcp(a: unknown) { try { return await mcp.set(a === true) } catch (e) { throw new Error((e as { code?: string })?.code === 'EADDRINUSE' ? 'MCP_PORT_BUSY' : 'MCP_START_FAILED') } },
    async openMcpFile() { shell.showItemInFolder(mcp.state().file) },
  }
  registerIpc(ipcMain, { ...h, ...wf.handlers, ...mcpHandlers })

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
    if (process.env.TOOLFLOW_E2E === '1') (globalThis as { __secondInstance?: number }).__secondInstance = ((globalThis as { __secondInstance?: number }).__secondInstance ?? 0) + 1 // test-only flag (AC-06)
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
