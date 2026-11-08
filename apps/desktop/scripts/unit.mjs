// Cross-platform `npm test`: vitest must run inside Electron's Node (better-sqlite3 is built for Electron's ABI).
// `ELECTRON_RUN_AS_NODE=1 cmd` in package.json only works in POSIX shells, so set the variable here.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const electron = require('electron') // path to the electron binary
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const r = spawnSync(electron, [vitest, 'run', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: join(dirname(fileURLToPath(import.meta.url)), '..') })
process.exit(r.status ?? 1)
