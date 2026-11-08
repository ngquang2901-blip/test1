// Manual pairing check (Task 9 Step 5, no Flow needed): real-mode app + real Google Chrome loading the installed extension.
// Run: npm run build -w apps/desktop, then (Linux) xvfb-run -a node apps/desktop/scripts/pair-check.mjs; Windows: set CHROME_PATH to chrome.exe.
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const desktop = join(dirname(fileURLToPath(import.meta.url)), '..'); // apps/desktop
const require = createRequire(join(desktop, 'package.json'));
const { _electron, chromium } = require('@playwright/test');

const scratch = process.env.TMPDIR || tmpdir();
const userData = mkdtempSync(join(scratch, 'tf-ud-'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function app() {
  const env = { ...process.env, TOOLFLOW_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TOOLFLOW_FAKE_DRIVER;
  const a = await _electron.launch({ args: ['--no-sandbox', '.'], cwd: desktop, env });
  const p = await a.firstWindow();
  await p.getByRole('heading', { name: 'ToolFlow' }).waitFor({ timeout: 20000 });
  return { a, p };
}
async function waitText(p, re, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await p.locator('body').innerText().catch(() => '');
    if (re.test(s)) return Date.now() - t0;
    await p.reload().catch(() => {}); // the session block is read on load
    await p.getByRole('heading', { name: 'ToolFlow' }).waitFor({ timeout: 10000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
  }
  return -1;
}

let { a, p } = await app();
const pair1 = JSON.parse(readFileSync(join(userData, 'extension', 'pair.json'), 'utf8'));
log('app up; pair.json has port', !!pair1.port, 'token len', pair1.token?.length, 'S1:', (await p.locator('body').innerText()).match(/Extension: .*/)?.[0]);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: false,
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--no-first-run'] });
const cdp = await browser.newBrowserCDPSession();
const { id } = await cdp.send('Extensions.loadUnpacked', { path: join(userData, 'extension') });
log('extension loaded, id', id);

const t1 = await waitText(p, /Extension: Đã kết nối/, 60000);
log('first pairing:', t1 >= 0 ? `connected after ${Math.round(t1 / 1000)} s` : 'NOT connected in 60 s');

await a.close();
log('app closed');
({ a, p } = await app());
const pair2 = JSON.parse(readFileSync(join(userData, 'extension', 'pair.json'), 'utf8'));
log('app restarted; port changed:', pair1.port !== pair2.port, 'token kept:', pair1.token === pair2.token);
const t2 = await waitText(p, /Extension: Đã kết nối/, 90000);
log('reconnect after restart:', t2 >= 0 ? `connected after ${Math.round(t2 / 1000)} s` : 'NOT connected in 90 s');

await a.close(); await browser.close();
log('done; extension dir exists', existsSync(join(userData, 'extension')));
