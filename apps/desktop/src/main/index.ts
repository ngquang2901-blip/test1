import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session as electronSession, shell, Tray } from 'electron'
import { basename, join } from 'path'
import { homedir } from 'os'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import extManifest from '../../../extension/manifest.json'
import { openDb, SCHEMA_VERSION } from './db'
import { applyRestore, backupTo, stageRestore } from './backup'
import { createAssetStore, registerAsset } from './assets'
import { batchStatus, createRunner } from './runner'
import { autoAllowed, autoGate, enableAuto } from './account'
import { selfCheckTab, validateProfile, profile, PROFILE_PATH } from './profile'
import { createFakeDriver, type DownloadScript, type FakeScript } from './fake-driver'
import { createDownloader, recoverDownloads } from './downloads'
import { createAutoSaver } from './autosave'
import { createMcpSwitch, toolsOf } from './mcp'
import { autoUpdater } from 'electron-updater'
import { createFakeUpdater, createUpdates, type Updater } from './updates'
import { createWorkflows } from './workflow'
import { createExtGpt, createFakeGpt, isGemMedia, isGptMedia, type GptDriver, type GptScript } from './gpt-driver'
import { createGptRunner, routeRunner } from './gpt-runner'
import { createHandlers, registerIpc, revisioned, parseDraft, type Draft } from './ipc'
import { batchSignatures } from './batch-view'
import { createNotifier } from './notify'
import { createTelegram } from './telegram'
import { createScheduler } from './schedule'
import { clockFactor, errorCode } from './boot-util'
import { readOrCreateToken, installExtension } from './connector/pairing'
import { createExtDriver } from './connector/ext-driver'
import { startConnectorServer } from './connector/server'
import { EXT_ID } from './connector/ext-id'
import type { FlowDriver } from './driver'
import { createGrants, tabStatus, type Grants } from './tabs'
import { findChrome, launchChrome } from './chrome'

if (process.env.TOOLFLOW_USER_DATA) app.setPath('userData', process.env.TOOLFLOW_USER_DATA) // before anything reads userData (R52)

const FAKE = process.env.TOOLFLOW_FAKE_DRIVER === '1'
let prefs = (): Draft => parseDraft(null) // the saved settings once boot has read them (the window's close reads tray)
let quitting = false // a real quit (tray Thoát, update install, app.quit from a test, OS shutdown): the window closes for good
app.on('before-quit', () => { quitting = true })
function showWindow(): void { // from the tray, a notice click, a second launch
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show(); w.focus()
}

// Test only: the e2e "no outbound network" check reads every request of the session (AC-32).
const requests: string[] = []
;(globalThis as { __toolflowRequests?: string[] }).__toolflowRequests = requests

function readDraft(file: string): Draft {
  try { return parseDraft(JSON.parse(readFileSync(file, 'utf8'))) } catch { return parseDraft(null) }
}

async function boot(win: () => BrowserWindow | undefined): Promise<void> {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const restored = applyRestore(userData, Date.now()) // a backup the user picked last time becomes the DB now, before anything opens it
  if (restored && !restored.ok) console.error('restore failed', restored.code)
  const db = openDb(join(userData, 'toolflow.db'))
  const draftFile = join(userData, 'draft.json')
  let draft = readDraft(draftFile)
  prefs = () => draft
  const assets = createAssetStore(db)
  // E2E only: a clock that runs X times faster so the 30 s send deadline / 10 min reconcile fit a test (fake mode only).
  const t0 = Date.now()
  const x = FAKE ? clockFactor(process.env.TOOLFLOW_CLOCK_X) : 1
  const clock = { now: () => t0 + (Date.now() - t0) * x }
  if (process.env.TOOLFLOW_E2E === '1') (globalThis as { __toolflowClock?: unknown }).__toolflowClock = clock // test-only: e2e picks a schedule time on the app clock

  let driver: FlowDriver
  let gptDriver: GptDriver = { tabs: async () => [] } as unknown as GptDriver // no connector: no ChatGPT tab, so its runner never asks anything else
  let gemDriver: GptDriver = gptDriver // the same for Gemini
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
    // the built-in test ChatGPT: TOOLFLOW_FAKE_GPT scripts its answers, TOOLFLOW_FAKE_GPT_TABS=0 means no ChatGPT tab is open
    const fakeGpt = createFakeGpt((process.env.TOOLFLOW_FAKE_GPT ?? '').split(',').filter(Boolean) as GptScript[], { tabs: Number(process.env.TOOLFLOW_FAKE_GPT_TABS ?? 1), fetchMedia: fake.fetchMedia })
    gptDriver = fakeGpt.driver
    const fakeGem = createFakeGpt((process.env.TOOLFLOW_FAKE_GEM ?? '').split(',').filter(Boolean) as GptScript[], { site: 'gemini', tabs: Number(process.env.TOOLFLOW_FAKE_GEM_TABS ?? 1), fetchMedia: fake.fetchMedia }) // the built-in test Gemini
    gemDriver = fakeGem.driver
    if (process.env.TOOLFLOW_E2E === '1') (globalThis as { __toolflowFakeGem?: unknown }).__toolflowFakeGem = fakeGem
    if (process.env.TOOLFLOW_E2E === '1') (globalThis as { __toolflowFakeGpt?: unknown }).__toolflowFakeGpt = fakeGpt // test-only: e2e plays the user in the ChatGPT tab
  } else {
    rawPing = () => Promise.reject(new Error('no driver'))
    driver = { onEvent: () => () => {} } as unknown as FlowDriver // connector failed: no tabs, so the runner never calls it
    try {
      const token = readOrCreateToken(userData)
      const server = await startConnectorServer({ token, extensionId: EXT_ID, onConnect: () => void grants?.list().catch(() => {}) }) // a Chrome profile came (back): pick its remembered tabs at once
      // packaged: electron-builder copies apps/extension to resources/extension (extraResources)
      const ext = installExtension(process.env.TOOLFLOW_EXT_DIR ?? (app.isPackaged ? join(process.resourcesPath, 'extension') : join(app.getAppPath(), '../extension')), userData, server.port, app.getVersion())
      extVersion = ext.version || extVersion // what the page must report; a mismatch means Chrome still runs an older copy
      driver = createExtDriver(server, { allow: (id) => grants.has(id), assets })
      gptDriver = createExtGpt(server)
      gemDriver = createExtGpt(server, 'gemini')
      rawPing = driver.ping
      connected = server.connected
    } catch (e) {
      connectorError = errorCode(e) // code only: messages carry paths and tokens
      console.error('connector setup failed', connectorError)
    }
  }

  const flowRunner = createRunner({ db, driver, clock, tabs: [], speed: draft.speed, autoAllowed: (e) => autoGate(db, e, validateProfile(profile)),
    projectOf: (t) => grants.projectOf(t), // each tab only takes batches of the project it shows
    onCredits: (t, n) => notifier.credits(grants.emailOf(t), n),
    selfCheckOk: async (t) => (await selfCheckTab(driver, await rawPing(t), t, extVersion)).ok }) // wall-clock ping like session(); no probeTab ⇒ manual
  // ChatGPT batches have their own runner (one prompt at a time in the open chatgpt.com tab); each finished image is saved while it is still on the page
  const hands = { busy: false } // ChatGPT and Gemini tabs are worked one at a time
  const gptRunner = createGptRunner({ db, driver: gptDriver, assets, clock, hands, download: (b) => downloader.batch(b) })
  const gemRunner = createGptRunner({ db, driver: gemDriver, provider: 'gemini', assets, clock, hands, download: (b) => downloader.batch(b) }) // Gemini: the same kind of runner on the gemini.google.com tab
  const runner = routeRunner(flowRunner, gptRunner, gemRunner)
  const siteOf = (b: string): typeof gptRunner | null => { const p = (db.prepare('select provider p from batch where id=?').get(b) as { p: string } | undefined)?.p; return p === 'chatgpt' ? gptRunner : p === 'gemini' ? gemRunner : null }
  grants = createGrants(driver, runner, { db, cap: () => runner.caps().tabs })
  if (FAKE && process.env.TOOLFLOW_FAKE_GRANT !== '0') { await grants.list(); grants.use(['t1']) } // test fixture: t1 pre-granted; '0' lets e2e click "Dùng tab này"
  runner.recover()
  // Main, not the renderer: the remembered tabs are chosen again (and their batches go on) while the window is hidden too
  const relist = (): void => void grants.list().catch(() => {}) // no extension yet: the next round
  relist(); setInterval(relist, 5000)
  // 'Mở trang tiện ích' / 'Mở Google Flow'. FAKE: never starts a program, records the address for e2e; TOOLFLOW_FAKE_CHROME=0 plays a PC without Chrome
  let chromeExe = FAKE ? (process.env.TOOLFLOW_FAKE_CHROME === '0' ? null : 'chrome.exe') : findChrome()
  const chromeOpened: string[] = []
  if (FAKE && process.env.TOOLFLOW_E2E === '1') (globalThis as { __toolflowChrome?: string[] }).__toolflowChrome = chromeOpened
  const openChrome = (url: string): boolean => {
    if (!FAKE) chromeExe = findChrome() // installed since the start, or moved
    if (!chromeExe) return false
    if (FAKE) chromeOpened.push(url); else launchChrome(chromeExe, url)
    return true
  }
  const email = async (): Promise<string | null> => { const t = grants.granted()[0]; return t ? (await driver.ping(t)).email : null }
  const emails = async (): Promise<string[]> => [...new Set((await grants.list().catch(() => [])).filter((t) => grants.has(t.tabId)).map((t) => t.email).filter((e): e is string => !!e))]
  const emit = revisioned((e) => win()?.webContents.send('state', e))
  // Notices. Telegram is called from main only (the renderer's no-network check stays true); its base URL is a test fake in e2e.
  const telegram = createTelegram({ file: join(userData, 'telegram.json'), base: FAKE ? process.env.TOOLFLOW_TELEGRAM_API : undefined })
  const toasts = new Set<Notification>() // shortcut: kept until closed so a click still reaches us; a toast left in the Action Center past that is not followed
  const notifier = createNotifier({
    db, now: () => clock.now(), prefs: () => draft, lastError: (b) => runner.lastError(b), changed: () => win()?.webContents.send('notice'),
    channels: {
      windows: (n) => {
        if (!Notification.isSupported()) return
        const t = new Notification({ title: n.title, body: n.body })
        toasts.add(t)
        t.on('click', () => { toasts.delete(t); showWindow() })
        t.on('close', () => toasts.delete(t))
        t.on('failed', () => { toasts.delete(t); notifier.windowsFailed() }) // measured: Windows notifications switched off for the user ⇒ 'failed'
        t.show()
      },
      telegram: async (text) => { if (telegram.state().linked) await telegram.send(text) },
    },
  })
  recoverDownloads(db) // an intent without a reply may or may not have started: needs_review, reconciled on the next request
  // The root is not user-configurable yet. The built-in test Flow never writes into the user's Downloads: its files go to
  // TOOLFLOW_DOWNLOAD_ROOT (e2e) or into the test's own user-data folder.
  const downloadRoot = FAKE ? process.env.TOOLFLOW_DOWNLOAD_ROOT ?? join(userData, 'downloads') : join(homedir(), 'Downloads', 'ToolFlow')
  const downloader = createDownloader({
    db, root: downloadRoot, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now, onChange: (b) => emit('batch', b),
    // an output is fetched from the tab of its own site: a ChatGPT image id is a message id + image number, a Flow one a plain uuid
    driver: { fetchMedia: (tab, p) => (isGptMedia(p.mediaId) ? gptRunner.fetchMedia(tab, p) : isGemMedia(p.mediaId) ? gemRunner.fetchMedia(tab, p) : driver.fetchMedia(tab, p)), downloads: (q) => driver.downloads(q) },
    async tab(b) {
      const site = siteOf(b)
      if (!site) return grants.granted()[0] ?? null
      const t = await site.findTab()
      if (!t) throw Object.assign(new Error('NO_CHATGPT_TAB'), { code: 'NO_CHATGPT_TAB' })
      return t
    },
  })
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
  const inFlight = db.prepare("select a.state_json j from attempt a join item i on i.attempt_id=a.id join batch b on b.id=i.batch_id where b.archived=0 and json_extract(a.state_json, '$.item') in ('preparing', 'submitting', 'awaiting_user', 'generating')")
  // only an attempt between prepare and its result is at risk from a restart (update, restore); queued ones simply go on after it
  const busy = (): boolean => wfActive() || (inFlight.all() as { j: string }[]).some((r) => ['preparing', 'submitting', 'awaiting_user', 'generating'].includes(JSON.parse(r.j).item)) // a workflow between two nodes would lose its later nodes
  const updates = createUpdates({
    updater, current: app.getVersion(), emit: (s) => win()?.webContents.send('update', s), busy,
    // Reported on Windows: after the click the window read "Not responding". Measured: Defender scans the new installer ~22 s while
    // electron-updater starts it from this process, so the window is hidden first (the bar has said what comes); update.log keeps the times.
    beforeInstall: () => {
      const log = (step: string): void => { try { appendFileSync(join(userData, 'update.log'), `${new Date().toISOString()} ${step}\n`) } catch { /* the log must never stop the update */ } }
      log(`install ${app.getVersion()}`)
      app.once('before-quit', () => log('before-quit')); app.once('will-quit', () => log('will-quit')); app.once('quit', () => log('quit'))
      for (const w of BrowserWindow.getAllWindows()) w.hide()
      // measured on Windows: Defender scans the new unsigned installer before it starts (about 20 s), then it installs (about 20 s): nothing is on screen meanwhile
      if (Notification.isSupported()) new Notification({ title: 'ToolFlow đang cập nhật', body: 'Khoảng 1 phút nữa app tự mở lại bản mới, bạn không cần mở lại.' }).show()
      setTimeout(() => { log('still running: window shown again'); for (const w of BrowserWindow.getAllWindows()) w.show() }, 60_000).unref() // the installer did not take over: never leave the app invisible
    },
    ...(FAKE ? { first: 500 } : {}),
  })
  updates.start()
  const h = createHandlers({
    updates,
    db, runner, clock, emit, email, emails, grants, downloader, openExtensionFolder: () => void shell.openPath(join(userData, 'extension')), openChrome, forgetTabs: () => grants.forget(), reveal: (p) => shell.showItemInFolder(p),
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
    saveDraft: (d) => {
      const login = d.openAtLogin !== draft.openAtLogin
      draft = d; writeFileSync(draftFile, JSON.stringify(d))
      if (!login) return
      const item = { openAtLogin: d.openAtLogin, args: ['--hidden'] } // starts in the tray, so the schedule runs after a reboot
      if (FAKE || !app.isPackaged) (((globalThis as { __toolflowLoginItem?: unknown[] }).__toolflowLoginItem ??= []).push(item)) // never the real registry from a test or dev run
      else app.setLoginItemSettings(item)
    },
    // FAKE: a deleted file goes to <userData>/fake-trash, never into the Recycle Bin of the PC running the tests
    trash: FAKE ? async (p) => { mkdirSync(join(userData, 'fake-trash'), { recursive: true }); renameSync(p, join(userData, 'fake-trash', basename(p))) } : (p) => shell.trashItem(p),
    async pickFolder() { // FAKE: e2e names the folder (Playwright cannot drive a native dialog)
      if (FAKE) return process.env.TOOLFLOW_EXPORT_DIR ?? null
      const w = win(), o = { title: 'Chọn thư mục để xuất kết quả', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
      return (await (w ? dialog.showOpenDialog(w, o) : dialog.showOpenDialog(o))).filePaths[0] ?? null
    },
    async session() {
      const em = await email()
      const t0 = grants.granted()[0]
      const ping = t0 ? await rawPing(t0) : null
      const list = await grants.list().catch(() => []) // extension absent ⇒ empty list
      const tabs = list.map((t) => ({ ...t, status: tabStatus(t), granted: grants.has(t.tabId), auto: grants.isAuto(t.tabId) })) // auto: chosen again from memory
      const accts = [...new Set(tabs.filter((t) => t.granted).map((t) => t.email).filter((e): e is string => !!e))]
      return {
        extDir: FAKE ? null : join(userData, 'extension'), // shown in S1 so the user can paste it into Chrome's folder dialog (not secret: pair.json inside is)
        fake: FAKE, connected: FAKE && process.env.TOOLFLOW_FAKE_CONNECTED === '0' ? false : connected ? connected() : null, connectorError, // '0': e2e of the setup panel
        chromeFound: chromeExe !== null, remembered: grants.remembered(), tabs, email: em, draft, speedInUse: runner.caps(),
        accounts: accts.map((e) => ({ email: e, auto: autoAllowed(db, e) })), // auto is per account; the runner checks each tab's own
        gptTabs: await gptDriver.tabs().then((t) => t.length, () => 0), // how many chatgpt.com tabs the extension sees (a ChatGPT batch uses one)
        gemTabs: await gemDriver.tabs().then((t) => t.length, () => 0), // the same for gemini.google.com
        autoEnabled: accts.length ? accts.every((e) => autoAllowed(db, e)) : autoAllowed(db, em),
        credits: notifier.creditList(), // the last Flow balance read per account, with its time
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
  // Sao lưu / khôi phục (Cài đặt). FAKE: e2e names the file in TOOLFLOW_BACKUP_FILE, and the restart is only counted
  const backupDialog = async (save: boolean): Promise<string | null> => {
    if (FAKE) return process.env.TOOLFLOW_BACKUP_FILE ?? null
    const w = win(), filters = [{ name: 'Bản sao lưu ToolFlow', extensions: ['db'] }]
    if (save) { const o = { defaultPath: join(app.getPath('documents'), `toolflow-sao-luu-${new Date().toISOString().slice(0, 10)}.db`), filters }; return (await (w ? dialog.showSaveDialog(w, o) : dialog.showSaveDialog(o))).filePath || null }
    const o = { properties: ['openFile' as const], filters }
    return (await (w ? dialog.showOpenDialog(w, o) : dialog.showOpenDialog(o))).filePaths[0] ?? null
  }
  const coded = (code: string): Error => Object.assign(new Error(code), { code })
  const restart = (): void => {
    if (FAKE) { const g = globalThis as { __toolflowRestarts?: number }; g.__toolflowRestarts = (g.__toolflowRestarts ?? 0) + 1; return }
    db.close() // checkpointed: no -wal left for the next start to keep beside the old DB
    app.relaunch(); app.exit(0)
  }
  const backupHandlers = {
    async backupData() { // names only to the renderer, never the path
      const file = await backupDialog(true)
      if (!file) return { saved: false }
      await backupTo(db, file, { draft, version: app.getVersion(), now: Date.now() })
      return { saved: true, name: basename(file) }
    },
    async restoreBackup() { // checked and staged now, applied by the next start (applyRestore above), so the DB is never swapped under a running app
      if (busy()) throw coded('BATCH_RUNNING')
      const file = await backupDialog(false)
      if (!file) return { staged: false }
      if (busy()) throw coded('BATCH_RUNNING') // a batch may have started while the dialog was open
      stageRestore(userData, file, SCHEMA_VERSION)
      setTimeout(restart, 300) // the screen gets its answer first
      return { staged: true }
    },
  }
  const noticeHandlers = { // the token goes in, never out: the renderer sees configured / linked only
    async listNotices() { return notifier.list() },
    async readNotices() { notifier.markRead() },
    async getTelegram() { return telegram.state() },
    async setTelegram(a: unknown) { return telegram.setToken(a) },
    async connectTelegram() { return telegram.connect() },
    async testTelegram() { await telegram.send('ToolFlow: tin thử. Bạn sẽ nhận tin ở đây khi một lô xong, cần bạn xem, bắt đầu theo hẹn giờ hoặc khi credit Flow sắp hết.') },
  }
  registerIpc(ipcMain, { ...h, ...wf.handlers, ...mcpHandlers, ...backupHandlers, ...noticeHandlers })
  // Hẹn giờ chạy: due batches start through the button's own start; the first tick (now) catches times missed while the app was closed
  const sched = createScheduler({ db, now: () => clock.now(), start: (b) => h.startBatch(b), notify: (b, at, late) => notifier.scheduled(b, at, late) })
  const schedTick = (): void => void sched.tick().catch((e) => console.error('schedule', (e as { code?: string }).code ?? 'INTERNAL_ERROR'))
  schedTick()
  setInterval(schedTick, 5000)

  // The runner changes rows on its own: tell the renderer when a batch's rows moved.
  const seen = new Map<string, string>()
  const scan = (): void => {
    for (const r of batchSignatures(db)) {
      if (seen.get(r.id) !== r.sig) { seen.set(r.id, r.sig); emit('batch', r.id); notifier.batchChanged(r.id) }
    }
  }
  setInterval(() => { runner.tick().catch((e) => console.error('tick', e)).finally(scan) }, 200)
  const saver = createAutoSaver({ db, now: () => clock.now(), enabled: () => draft.autoSave, downloader })
  if (process.env.TOOLFLOW_AUTOSAVE !== '0') setInterval(() => { saver.tick().catch((e) => console.error('autosave', (e as { code?: string }).code ?? 'INTERNAL_ERROR')) }, 3000) // '0': the specs that press Tải themselves
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
  mainWindow.on('ready-to-show', () => { if (!process.argv.includes('--hidden')) mainWindow.show() }) // --hidden: started with Windows, stays in the tray
  // Closing hides to the tray so scheduled batches still run; a real quit (before-quit) or the OS ending the session closes it
  mainWindow.on('close', (e) => { if (!quitting && prefs().tray) { e.preventDefault(); mainWindow.hide() } })
  mainWindow.on('query-session-end', () => { quitting = true })
  mainWindow.on('session-end', () => { quitting = true })
  // AC-32: nothing leaves the app window
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  return mainWindow
}

let tray: Tray | null = null // kept here: a collected Tray disappears from the taskbar
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (process.env.TOOLFLOW_E2E === '1') (globalThis as { __secondInstance?: number }).__secondInstance = ((globalThis as { __secondInstance?: number }).__secondInstance ?? 0) + 1 // test-only flag (AC-06)
    showWindow() // also when it sits hidden in the tray
  })
  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.toolflow.desktop') // = appId in electron-builder.yml: Windows shows a notification only for the id of an installed shortcut
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
    if (process.env.TOOLFLOW_E2E === '1') {
      electronSession.defaultSession.webRequest.onBeforeRequest((d, cb) => { requests.push(d.url); cb({}) })
    }
    let win: BrowserWindow | undefined
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
    tray.setToolTip('ToolFlow')
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Mở ToolFlow', click: showWindow }, { label: 'Thoát', click: () => app.quit() }]))
    tray.on('click', showWindow)
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
