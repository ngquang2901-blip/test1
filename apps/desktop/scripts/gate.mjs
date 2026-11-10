// P1 gate runner (Task 12 Step 2). Same on Windows and Linux:  node apps/desktop/scripts/gate.mjs   (from the repo root, after `npm ci`)
// Linux without a display: xvfb-run -a node apps/desktop/scripts/gate.mjs     Windows: CHROME_PATH is auto-detected, override if Chrome is elsewhere.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const win = process.platform === 'win32'
const chrome = process.env.CHROME_PATH ?? [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'), '/usr/bin/google-chrome'].find(existsSync)
const steps = [
  ['unit (desktop)', 'npm test -w apps/desktop', /Tests\s+\d+ passed[^\n]*/],
  ['flow-protocol', 'node --test', /# pass \d+/, 'packages/flow-protocol'],
  ['extension', 'node --test', /# pass \d+/, 'apps/extension'],
  ['typecheck', 'npm run typecheck -w apps/desktop', null],
  ['e2e (fake driver)', 'npm run e2e -w apps/desktop', /\d+ passed[^\n]*/],
  ['pairing with real Chrome', 'npm run build -w apps/desktop && node apps/desktop/scripts/pair-check.mjs', /reconnect after restart:[^\n]*/],
]
const rows = []
for (const [name, cmd, pick, cwd] of steps) {
  if (name.startsWith('pairing') && !chrome) { rows.push([name, 'SKIPPED', 'Chrome not found: set CHROME_PATH']); continue }
  console.log(`\n=== ${name}: ${cmd}`)
  const r = spawnSync(cmd, { cwd: join(root, cwd ?? '.'), shell: true, encoding: 'utf8', env: { ...process.env, CHROME_PATH: chrome ?? '' } })
  const out = `${r.stdout}\n${r.stderr}`
  const lines = out.split('\n'), tail = Math.max(0, lines.length - 12)
  const sum = lines.findIndex((l) => /^\s*\d+ (failed|flaky)\b/.test(l)) // Playwright lists every failed test under this line: never cut it off
  if (sum >= 0 && sum < tail) console.log(lines.slice(sum, tail).join('\n'))
  console.log(lines.slice(tail).join('\n'))
  const note = pick ? out.match(pick)?.[0] ?? '' : ''
  const ok = r.status === 0 && !(name.startsWith('pairing') && !/connected after \d+ s/.test(out.split('reconnect after restart:')[1] ?? ''))
  rows.push([name, ok ? 'PASS' : 'FAIL', note])
}
console.log(`\n===== P1 gate on ${process.platform} (${process.version}) =====`)
for (const [n, s, note] of rows) console.log(`${s.padEnd(8)} ${n.padEnd(26)} ${note}`)
process.exit(rows.some((r) => r[1] === 'FAIL') ? 1 : 0)
