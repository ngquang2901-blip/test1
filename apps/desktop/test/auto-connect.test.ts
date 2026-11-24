import { test, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createAutoConnect } from '../src/main/auto-connect'

/** A stand-in for spawn: each call plays the script's printed lines for that mode, then exits. */
function fakeRun(plan: Record<string, string[]>) {
  const calls: { cmd: string; args: string[] }[] = []
  const run = (cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    const mode = args[args.indexOf('-mode') + 1]
    const p = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
    setTimeout(() => {
      for (const l of plan[mode] ?? []) p.stdout.write(l + '\r\n')
      p.stdout.end(); p.stderr.end()
      setTimeout(() => p.emit('close', (plan[mode] ?? []).some((l) => l.startsWith('FAIL')) ? 1 : 0), 1)
    }, 1)
    return p as never
  }
  return { run, calls }
}

const base = { script: 'C:/app/auto-connect.ps1', ext: 'C:/u/extension', flags: ['--disable-features=X'], busy: () => false, waitMs: 50 }

test('auto-connect: loads the extension, waits for it to connect, then restarts Chrome without the accessibility switch', async () => {
  const f = fakeRun({ setup: ['STEP closing', 'STEP opening', 'STEP loading', 'LOADED'], restart: ['STEP closing', 'STEP opening', 'DONE'] })
  let connected = false
  const ac = createAutoConnect({ ...base, chrome: () => 'C:/chrome.exe', connected: () => connected, run: f.run })
  setTimeout(() => { connected = true }, 20) // the extension pairs a moment after Chrome loaded it
  await expect(ac.start()).resolves.toEqual({ ok: true })
  expect(f.calls.map((c) => c.args[c.args.indexOf('-mode') + 1])).toEqual(['setup', 'restart'])
  const a = f.calls[0].args
  expect(f.calls[0].cmd).toMatch(/powershell/i)
  expect(a).toEqual(expect.arrayContaining(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/app/auto-connect.ps1', '-chrome', 'C:/chrome.exe', '-ext', 'C:/u/extension']))
  expect(a[a.indexOf('-flags') + 1]).toBe('--disable-features=X')
})

test('auto-connect: a failing step comes back as its code, Chrome is still restarted plainly, and nothing waits for a connection', async () => {
  const f = fakeRun({ setup: ['STEP closing', 'STEP opening', 'STEP loading', 'FAIL NO_FOLDER_DIALOG'], restart: ['DONE'] })
  const ac = createAutoConnect({ ...base, chrome: () => 'C:/chrome.exe', connected: () => false, run: f.run })
  await expect(ac.start()).resolves.toEqual({ ok: false, code: 'AUTO_NO_FOLDER_DIALOG' })
  expect(f.calls.map((c) => c.args[c.args.indexOf('-mode') + 1])).toEqual(['setup', 'restart']) // never leave Chrome on the slow accessibility switch
})

test('auto-connect: Chrome closed by nobody (a "leave site?" question) stops before anything is started again', async () => {
  const f = fakeRun({ setup: ['STEP closing', 'FAIL CHROME_WONT_CLOSE'], restart: ['DONE'] })
  const ac = createAutoConnect({ ...base, chrome: () => 'C:/chrome.exe', connected: () => false, run: f.run })
  await expect(ac.start()).resolves.toEqual({ ok: false, code: 'AUTO_CHROME_WONT_CLOSE' })
  expect(f.calls).toHaveLength(1) // Chrome is still open as the user left it
})

test('auto-connect: loaded but never connected is its own code; no Chrome, a running batch, or a second start are refused up front', async () => {
  const f = fakeRun({ setup: ['LOADED'], restart: ['DONE'] })
  const never = createAutoConnect({ ...base, chrome: () => 'C:/chrome.exe', connected: () => false, run: f.run })
  await expect(never.start()).resolves.toEqual({ ok: false, code: 'AUTO_NOT_CONNECTED' })
  expect(f.calls).toHaveLength(2)

  const g = fakeRun({})
  await expect(createAutoConnect({ ...base, chrome: () => null, connected: () => false, run: g.run }).start()).resolves.toEqual({ ok: false, code: 'CHROME_NOT_FOUND' })
  await expect(createAutoConnect({ ...base, busy: () => true, chrome: () => 'C:/chrome.exe', connected: () => false, run: g.run }).start()).resolves.toEqual({ ok: false, code: 'BATCH_RUNNING' })
  expect(g.calls).toHaveLength(0) // closing Chrome mid-send would lose the prompt being sent

  const h = fakeRun({ setup: ['LOADED'], restart: ['DONE'] })
  const once = createAutoConnect({ ...base, chrome: () => 'C:/chrome.exe', connected: () => true, run: h.run })
  const first = once.start()
  await expect(once.start()).resolves.toEqual({ ok: false, code: 'AUTO_RUNNING' })
  await expect(first).resolves.toEqual({ ok: true })
})

test('auto-connect: a script that prints nothing it knows (crashed PowerShell) is AUTO_SCRIPT_ERROR, never success', async () => {
  const f = fakeRun({ setup: ['garbage'], restart: ['DONE'] })
  await expect(createAutoConnect({ ...base, chrome: () => 'C:/chrome.exe', connected: () => true, run: f.run }).start()).resolves.toEqual({ ok: false, code: 'AUTO_SCRIPT_ERROR' })
})
