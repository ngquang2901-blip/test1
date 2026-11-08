import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const desktop = resolve(__dirname, '..')
const apps: ElectronApplication[] = []

async function launch(userData: string, script = '', extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, TOOLFLOW_FAKE_DRIVER: '1', TOOLFLOW_E2E: '1', TOOLFLOW_CLOCK_X: '30', TOOLFLOW_USER_DATA: userData, TOOLFLOW_FAKE_SCRIPT: script, ...extra } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ args: ['--no-sandbox', '.'], cwd: desktop, env })
  apps.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'ToolFlow' })).toBeVisible({ timeout: 20_000 })
  return { app, page }
}
test.afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {}))) })

const tmp = () => mkdtempSync(join(tmpdir(), 'tf-e2e-'))
async function create(page: Page, lines: string[]): Promise<void> {
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByLabel('Danh sách prompt').fill(lines.join('\n'))
  await expect(page.locator('[data-testid=preview] tbody tr')).toHaveCount(lines.length)
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
}
async function tabTo(page: Page, name: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    if (await page.evaluate((n) => ((document.activeElement as HTMLInputElement | null)?.labels?.[0]?.textContent ?? document.activeElement?.textContent ?? '').trim() === n || document.activeElement?.getAttribute('aria-label') === n, name)) return
  }
  throw new Error(`cannot Tab to ${name}`)
}
const items = (page: Page) => page.locator('[data-testid=item]')

test('textarea batch runs to ready', async () => {
  const { page } = await launch(tmp())
  await expect(page.getByText('Self-check: đạt')).toBeVisible() // S1
  await create(page, ['một con mèo', 'một con chó', 'một con cá'])
  await expect(items(page)).toHaveCount(3)
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(3)
  // AC-07: ready is not saved; no download path exists in P1, so nothing may claim it
  await expect(page.locator('body')).not.toContainText('Đã lưu')
  await expect(page.getByRole('heading', { name: /Hoàn tất|100%/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Kết quả' }).click() // S4
  await expect(page.locator('[data-testid=output]').first()).toBeVisible()
  await expect(page.locator('[data-testid=output]').first()).toContainText('chưa tải')
  await expect(page.locator('body')).not.toContainText('Đã lưu')
})

test('second launch exits on its own and only raises the old window', async () => {
  const dir = tmp()
  const { app } = await launch(dir)
  const env = { ...process.env, TOOLFLOW_FAKE_DRIVER: '1', TOOLFLOW_E2E: '1', TOOLFLOW_USER_DATA: dir } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const b = spawn(electronPath as unknown as string, ['--no-sandbox', '.'], { cwd: desktop, env, stdio: 'ignore' })
  const code = await new Promise((r) => { b.on('exit', r); setTimeout(() => { b.kill(); r('timeout') }, 20_000) })
  expect(code).not.toBe('timeout')
  const a = await app.evaluate(({ BrowserWindow }) => ({ n: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0]?.isVisible(), second: (globalThis as unknown as { __secondInstance?: number }).__secondInstance }))
  expect(a).toEqual({ n: 1, visible: true, second: 1 })
  expect(app.process().exitCode).toBeNull() // A still running
})

test('uncertain shows confirm buttons', async () => {
  const { page } = await launch(tmp(), 'no-request,image-ok,image-ok')
  await create(page, ['a', 'b', 'c'])
  const first = items(page).first()
  await expect(first).toContainText('Không rõ')
  for (const n of ['Đã gửi', 'Chưa gửi', 'Lưu hồ sơ chưa rõ']) await expect(first.getByRole('button', { name: n })).toBeVisible()
  await expect(first).toContainText('Đối soát lúc')
  await expect(items(page).filter({ hasText: 'Đang chờ' })).toHaveCount(2)
  await page.waitForTimeout(1500) // the batch stays held (D-21): nothing may finish while the first item is unresolved
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(0)
  await first.getByRole('button', { name: 'Chưa gửi' }).click()
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(2)
  await page.getByRole('button', { name: 'Chi tiết' }).first().click()
  await expect(page.locator('[data-testid=detail]')).toContainText('(not_sent)') // the word the user gave, not the other one
  await expect(page.locator('[data-testid=detail]')).not.toContainText('(sent)')
})

test('auto needs warning ack', async () => {
  const { page } = await launch(tmp(), '', { TOOLFLOW_FAKE_AUTO: '0' })
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  await expect(page.getByText('Auto: tắt')).toBeVisible()
  const enable = page.getByRole('button', { name: 'Bật auto' })
  await expect(enable).toBeDisabled()
  // defence in depth: main refuses without the ack even if the UI is bypassed
  const err = await page.evaluate(() => (window as unknown as { api: { enableAuto(a: unknown): Promise<void> } }).api.enableAuto({}).then(() => 'ok', (e: Error) => e.message))
  expect(err).toContain('ACK_REQUIRED')
  await expect(page.getByText('Auto: tắt')).toBeVisible()
  await page.getByLabel('Tôi hiểu rủi ro').check()
  await enable.click()
  await expect(page.getByText('Auto: bật')).toBeVisible()
})

test('history survives restart', async () => {
  const dir = tmp()
  let { app, page } = await launch(dir, 'no-request,image-ok')
  await create(page, ['prompt giữ nguyên', 'dòng hai'])
  await items(page).first().getByRole('button', { name: 'Chưa gửi' }).click()
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(1)
  await app.close()
  ;({ app, page } = await launch(dir))
  await page.getByRole('button', { name: 'Hàng đợi' }).click()
  await page.getByRole('button', { name: 'Chi tiết' }).first().click()
  const d = page.locator('[data-testid=detail]')
  await expect(d).toContainText('prompt giữ nguyên')
  await expect(d).toContainText('Ảnh') // configuration
  await expect(d).toContainText('SUBMIT_UNCERTAIN') // attempt error
  await expect(d).toContainText(/cấu hình \d{4}\.\d{2}\.\d{2}-\d/) // AC-18: config version kept per attempt
  await expect(d.locator('[data-testid=journal] li').first()).toContainText(/\d{1,2}:\d{2}/) // timestamps
})

test('no outbound network', async () => {
  const { app, page } = await launch(tmp())
  await create(page, ['x'])
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(1)
  for (const t of ['Kết nối', 'Tạo lô', 'Hàng đợi', 'Kết quả', 'Cài đặt']) await page.getByRole('button', { name: t, exact: true }).click()
  const urls = await app.evaluate(() => (globalThis as unknown as { __toolflowRequests: string[] }).__toolflowRequests)
  expect(urls.length).toBeGreaterThan(0)
  expect(urls.filter((u) => !/^(file:|devtools:|ws:\/\/127\.0\.0\.1)/.test(u))).toEqual([])
})

test('keyboard only', async () => {
  const { page } = await launch(tmp(), 'no-request,image-ok,image-ok')
  await tabTo(page, 'Tạo lô')
  await page.keyboard.press('Enter')
  await tabTo(page, 'Danh sách prompt')
  await page.keyboard.type('một\nhai\nba')
  await tabTo(page, 'Tạo lô và chạy')
  await page.keyboard.press('Enter')
  await expect(items(page).first()).toContainText('Không rõ')
  // AC-27: Dừng is reachable by keyboard while the batch is active, from any screen
  await tabTo(page, 'Dừng')
  await page.keyboard.press('Enter')
  await tabTo(page, 'Chưa gửi') // the uncertain item still needs the user's word
  await page.keyboard.press('Enter')
  await expect(items(page).filter({ hasText: 'Đã huỷ' })).toHaveCount(2)
  await expect(page.getByRole('heading', { name: /Đã dừng/ })).toBeVisible()
})

test('real mode survives a connector failure: window opens, S1 shows the error code only', async () => {
  const missing = join(tmp(), 'no-such-extension')
  const { page } = await launch(tmp(), '', { TOOLFLOW_FAKE_DRIVER: '0', TOOLFLOW_EXT_DIR: missing })
  await expect(page.getByRole('alert')).toContainText('ENOENT')
  await expect(page.getByText('Chưa kết nối')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(missing)
})
