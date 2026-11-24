import { spawn } from 'node:child_process'

export type AutoResult = { ok: true } | { ok: false; code: string }

type Proc = { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; on(e: 'close', f: (code: number | null) => void): unknown; on(e: 'error', f: (e: Error) => void): unknown }

/** "Kết nối tự động": resources/auto-connect/auto-connect.ps1 closes the user's Chrome, starts it again with accessibility on, and adds
 *  ToolFlow's extension folder through chrome://extensions (Developer mode + Load unpacked) with no click from the user; once the
 *  extension pairs, Chrome is started once more without that switch (it slows heavy pages like Flow) and on Google Flow. */
export function createAutoConnect(o: {
  script: string; ext: string; flags: string[]; profileDir?: string; chrome(): string | null; connected(): boolean; busy(): boolean
  run?: (cmd: string, args: string[]) => Proc; waitMs?: number
}): { start(): Promise<AutoResult>; running(): boolean } {
  const run = o.run ?? ((cmd: string, args: string[]) => spawn(cmd, args, { windowsHide: true }) as unknown as Proc)
  let busy = false
  // One script run; resolves with the last word it printed: LOADED / DONE, or the FAIL code
  const script = (mode: 'setup' | 'restart', exe: string): Promise<string> => new Promise((resolve) => {
    const p = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', o.script, '-mode', mode, '-chrome', exe, '-ext', o.ext, '-flags', o.flags.join(' '), ...(o.profileDir ? ['-profileDir', o.profileDir] : [])]) // profileDir: live tests on a throwaway Chrome profile
    let last = 'SCRIPT_ERROR', buf = ''
    const line = (l: string): void => { const m = /^(LOADED|DONE|FAIL (\w+))$/.exec(l.trim()); if (m) last = m[2] ?? m[1] } // STEP lines are for a person reading the log
    p.stdout.on('data', (d: Buffer) => { buf += d.toString(); const ls = buf.split('\n'); buf = ls.pop() ?? ''; ls.forEach(line) })
    p.stderr.on('data', (d: Buffer) => console.error('auto-connect', mode, d.toString().trim().slice(0, 300))) // the script's own line number and message, never page content
    p.on('error', () => resolve('SCRIPT_ERROR'))
    p.on('close', () => { line(buf); resolve(last) })
  })
  const waitConnected = async (): Promise<boolean> => {
    const end = Date.now() + (o.waitMs ?? 20_000) // measured: the extension pairs within ~2 s of being loaded
    while (Date.now() < end) { if (o.connected()) return true; await new Promise((r) => setTimeout(r, Math.min(250, o.waitMs ?? 250))) }
    return o.connected()
  }
  return {
    running: () => busy,
    async start() {
      if (busy) return { ok: false, code: 'AUTO_RUNNING' }
      const exe = o.chrome()
      if (!exe) return { ok: false, code: 'CHROME_NOT_FOUND' }
      if (o.busy()) return { ok: false, code: 'BATCH_RUNNING' } // closing Chrome mid-send would lose the prompt being sent
      busy = true
      try {
        const r = await script('setup', exe)
        if (r === 'CHROME_WONT_CLOSE') return { ok: false, code: 'AUTO_CHROME_WONT_CLOSE' } // Chrome is still as the user left it
        let ok = r === 'LOADED'
        if (ok) ok = await waitConnected()
        await script('restart', exe) // also after a failure: never leave Chrome on the accessibility switch
        return ok ? { ok: true } : { ok: false, code: r === 'LOADED' ? 'AUTO_NOT_CONNECTED' : `AUTO_${r}` }
      } finally { busy = false }
    },
  }
}
