import { test, expect, _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { openDb } from '../src/main/db'
import { enqueueBatch } from '../src/main/batch'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import electronPath from 'electron'

const desktop = resolve(__dirname, '..')
const apps: ElectronApplication[] = []

async function launch(userData: string, script = '', extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, TOOLFLOW_FAKE_DRIVER: '1', TOOLFLOW_E2E: '1', TOOLFLOW_CLOCK_X: '30', TOOLFLOW_AUTOSAVE: '0', TOOLFLOW_USER_DATA: userData, TOOLFLOW_FAKE_SCRIPT: script, ...extra } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ args: ['--no-sandbox', '.'], cwd: desktop, env })
  apps.push(app)
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'ToolFlow' })).toBeVisible({ timeout: 20_000 })
  if (!extra.TOOLFLOW_FAKE_LICENSE) await page.getByRole('button', { name: 'Kết nối', exact: true }).click() // the specs below start where the app opened before Tổng quan existed
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
// Workflow canvas: a block comes from the picker (the + of the tool column); a wire is a drag from an output port to an input port
async function addNode(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Thêm khối', exact: true }).click()
  await page.getByRole('option', { name, exact: true }).click()
}
async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const hit = (l: Locator) => l.evaluate((e) => { const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; return document.elementFromPoint(x, y) === e ? { x, y } : null })
  let was = ''
  await expect.poll(async () => { // a new block refits the canvas a moment later: wait until the view holds still and both ports are on screen and on top
    const now = await page.locator('.react-flow__viewport').evaluate((e) => (e as HTMLElement).style.transform), still = now === was
    was = now
    return still && !!(await hit(from)) && !!(await hit(to))
  }, { intervals: [150] }).toBe(true)
  const a = (await from.boundingBox())!, b = (await to.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
  await page.mouse.up()
}
const items = (page: Page) => page.locator('[data-testid=item]')

test('the built-in test Flow never saves into the user\'s Downloads: without a download root its files stay in the test\'s own data folder', async () => {
  const ud = tmp()
  const { page } = await launch(ud)
  await create(page, ['một con mèo'])
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await page.getByRole('button', { name: 'Tải tất cả kết quả' }).click()
  await expect(page.locator('[data-testid=output]').filter({ hasText: 'Đã lưu' })).toHaveCount(1)
  expect((readdirSync(join(ud, 'downloads'), { recursive: true }) as string[]).map(String).filter((f) => f.endsWith('.png'))).toHaveLength(1)
})

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
  await expect(page.locator('[data-testid=output]').first()).toContainText('Chưa tải')
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

test('archive needs a second, inline confirmation: cancel keeps the batch, confirm archives', async () => {
  const { page } = await launch(tmp(), 'no-request,image-ok,image-ok')
  await create(page, ['a', 'b', 'c'])
  const first = items(page).first()
  await expect(first).toContainText('Không rõ')
  page.on('dialog', () => { throw new Error('window.confirm/alert must not be used') })
  await first.getByRole('button', { name: 'Lưu hồ sơ chưa rõ' }).click()
  await expect(first).toContainText('Chắc chắn lưu hồ sơ?')
  await first.getByRole('button', { name: 'Huỷ' }).click()
  await expect(first).not.toContainText('Chắc chắn lưu hồ sơ?')
  await expect(page.getByRole('heading', { level: 3 })).not.toContainText('đã lưu hồ sơ')
  await first.getByRole('button', { name: 'Lưu hồ sơ chưa rõ' }).click()
  await page.keyboard.press('Enter') // autofocus lands on the confirm button
  await expect(page.getByRole('heading', { level: 3 })).toContainText('đã lưu hồ sơ')
})

test('rerun shows the cost warning first; cancel sends nothing, confirm adds a second attempt', async () => {
  const { page } = await launch(tmp(), 'no-request,image-ok,image-ok,image-ok')
  await create(page, ['a', 'b', 'c'])
  const first = items(page).first()
  await expect(first).toContainText('Không rõ')
  await expect(first.getByRole('button', { name: /Chạy lại/ })).toHaveCount(0) // uncertain: not rerunnable yet
  await first.getByRole('button', { name: 'Chưa gửi' }).click()
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(2)
  await first.getByRole('button', { name: 'Chạy lại (tốn credit)' }).click()
  await expect(first).toContainText('tốn thêm credit')
  await expect(first.getByRole('button', { name: 'Huỷ' })).toBeFocused() // the costly step never autofocuses its confirm button
  await page.keyboard.press('Enter') // an immediate Enter must not confirm the cost
  await expect(first).not.toContainText('tốn thêm credit')
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(2)
  await first.getByRole('button', { name: 'Chạy lại (tốn credit)' }).click()
  await first.getByRole('button', { name: 'Huỷ' }).click()
  await page.getByRole('button', { name: 'Chi tiết' }).first().click()
  await expect(page.locator('[data-testid=detail]')).not.toContainText('Lượt 2')
  await first.getByRole('button', { name: 'Chạy lại (tốn credit)' }).click()
  await first.getByRole('button', { name: 'Có, chạy lại' }).click()
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(3)
  await expect(page.locator('[data-testid=detail]')).toContainText('Lượt 2')
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

test('S1 lists the Flow tab; an ungranted tab runs nothing until "Dùng tab này" (AC-01, AC-27)', async () => {
  const { page } = await launch(tmp(), '', { TOOLFLOW_FAKE_GRANT: '0' })
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await expect(page.locator('[data-testid=flow-tab]')).toHaveCount(1)
  await create(page, ['một con mèo'])
  await expect(page.getByRole('alert')).toContainText('Chưa có tab Flow nào được cấp quyền') // no tab granted: no batch, nothing sent (same as real mode)
  await page.getByRole('button', { name: 'Hàng đợi' }).click()
  await expect(items(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await tabTo(page, 'Dùng tab này') // keyboard reachable
  await page.keyboard.press('Enter')
  await expect(page.getByText('Đang dùng', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(1)
})

// ---- reference images (Task 5b): the e2e names its files in a JSON list because Playwright cannot drive the native dialog ----
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
function pngs(names: string[]): { list: string; dir: string } {
  const dir = tmp()
  const paths = names.map((n, i) => { const f = join(dir, n); writeFileSync(f, Buffer.concat([PNG1, Buffer.from(`-${i}`)])); return f })
  const list = join(dir, 'pick.json')
  writeFileSync(list, JSON.stringify(paths))
  return { list, dir }
}
const ledger = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __toolflowFake: { uploads: string[]; refs: string[][]; clicks: number; prepares: number; arms: number; fetches: number } }).__toolflowFake)
const row = (page: Page, i: number) => page.locator('[data-testid=preview] tbody tr').nth(i)

test('sequential refs: preview shows names, the batch runs, two uploads and one ref per item', async () => {
  const { list } = pngs(['a.png', 'b.png'])
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_PICK_REFS: list })
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByLabel('Danh sách prompt').fill('một con mèo\nmột con chó')
  await page.getByRole('button', { name: 'Chọn ảnh…' }).click()
  await expect(page.getByTestId('pool').locator('li')).toHaveCount(2)
  await expect(page.getByTestId('pool')).toContainText('a.png')
  await expect(page.locator('body')).not.toContainText(list) // names only, never paths
  await page.getByLabel('Mỗi prompt một nhóm ảnh theo thứ tự').check()
  await expect(row(page, 0)).toContainText('a.png')
  await expect(row(page, 1)).toContainText('b.png')
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(2)
  const l = await ledger(app)
  expect(l.uploads).toHaveLength(2)
  expect(l.refs.map((r) => r.length)).toEqual([1, 1])
  expect(new Set(l.refs.flat()).size).toBe(2)
})

test('3 prompts and 2 refs sequential: the error is shown and Tạo lô và chạy is disabled; Không dùng frees it', async () => {
  const { list } = pngs(['a.png', 'b.png'])
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_PICK_REFS: list })
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByLabel('Danh sách prompt').fill('một\nhai\nba')
  await page.getByRole('button', { name: 'Chọn ảnh…' }).click()
  await page.getByLabel('Mỗi prompt một nhóm ảnh theo thứ tự').check()
  await expect(page.getByTestId('map-errors')).toContainText('Thiếu ảnh cho prompt nào')
  await expect(page.getByTestId('map-errors')).toContainText('#3')
  await expect(row(page, 2)).toContainText('Thiếu ảnh')
  await expect(row(page, 2)).not.toContainText('a.png') // no rotation back to the first image
  await expect(page.getByRole('button', { name: 'Tạo lô và chạy' })).toBeDisabled()
  await page.getByLabel('Dùng chung tất cả ảnh cho mọi prompt').check()
  await expect(page.getByTestId('map-errors')).toContainText('Quá nhiều ảnh')
  await expect(page.getByRole('button', { name: 'Tạo lô và chạy' })).toBeDisabled()
  await page.getByLabel('Không dùng').check()
  await expect(page.getByTestId('map-errors')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Tạo lô và chạy' })).toBeEnabled()
  expect((await ledger(app)).uploads).toHaveLength(0) // nothing uploads before a batch runs
})

test('refs are reachable and operable by keyboard alone (AC-27)', async () => {
  const { list } = pngs(['a.png', 'b.png'])
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_PICK_REFS: list })
  await tabTo(page, 'Tạo lô')
  await page.keyboard.press('Enter')
  await tabTo(page, 'Danh sách prompt')
  await page.keyboard.type('một\nhai')
  await tabTo(page, 'Chọn ảnh…')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pool').locator('li')).toHaveCount(2)
  await tabTo(page, 'Không dùng')
  await page.keyboard.press('ArrowDown') // radio group: arrows pick the next mode
  await expect(page.getByLabel('Mỗi prompt một nhóm ảnh theo thứ tự')).toBeChecked()
  await tabTo(page, 'Số ảnh tham chiếu mỗi prompt')
  await tabTo(page, 'Bỏ ảnh b.png')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pool').locator('li')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Chọn ảnh…' })).toBeFocused() // focus is not lost with the removed button
  await expect(page.getByTestId('map-errors')).toContainText('Thiếu ảnh cho prompt nào')
  await expect(page.getByRole('button', { name: 'Tạo lô và chạy' })).toBeDisabled()
  await page.keyboard.press('Enter') // pick again: b.png is back
  await expect(page.getByTestId('pool').locator('li')).toHaveCount(2)
  await tabTo(page, 'Tạo lô và chạy')
  await page.keyboard.press('Enter')
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(2)
  expect((await ledger(app)).refs.map((r) => r.length)).toEqual([1, 1])
})

test('Mẫu lô: save kind, mode, refs and template; apply it in Tạo lô and from Hàng đợi; delete it', async () => {
  const { list } = pngs(['a.png', 'b.png'])
  const { page } = await launch(tmp(), '', { TOOLFLOW_PICK_REFS: list })
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByLabel('Thủ công (bạn bấm Gửi trong Flow)').check()
  await page.getByRole('button', { name: 'Chọn ảnh…' }).click()
  await expect(page.getByTestId('pool').locator('li')).toHaveCount(2)
  await page.getByLabel('Mỗi prompt một nhóm ảnh theo thứ tự').check()
  await page.getByText('Ghép prompt từ mẫu').click()
  await page.getByLabel(/Mẫu prompt/).fill('{món} ở chợ')
  await page.getByRole('button', { name: 'Lưu làm mẫu…' }).click()
  await page.getByLabel('Tên mẫu').fill('Chợ quê')
  await page.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Chợ quê', exact: true })).toBeVisible()
  // change everything, then the preset brings it back
  await page.getByLabel('Tự động', { exact: true }).check()
  await page.getByLabel('Không dùng').check()
  await page.getByRole('button', { name: 'Bỏ ảnh a.png' }).click()
  await page.getByLabel(/Mẫu prompt/).fill('')
  await page.getByRole('button', { name: 'Chợ quê', exact: true }).click()
  await expect(page.getByLabel('Thủ công (bạn bấm Gửi trong Flow)')).toBeChecked()
  await expect(page.getByLabel('Mỗi prompt một nhóm ảnh theo thứ tự')).toBeChecked()
  await expect(page.getByTestId('pool').locator('li')).toHaveCount(2)
  await expect(page.getByLabel(/Mẫu prompt/)).toHaveValue('{món} ở chợ')
  // from Hàng đợi: the saved card opens Tạo lô with it
  await page.getByLabel('Tự động', { exact: true }).check()
  await page.getByRole('button', { name: 'Hàng đợi' }).click()
  await page.getByRole('button', { name: /Chợ quê/ }).click()
  await expect(page.getByLabel('Thủ công (bạn bấm Gửi trong Flow)')).toBeChecked()
  await page.getByRole('button', { name: 'Xoá mẫu Chợ quê' }).click()
  await expect(page.getByRole('button', { name: 'Chợ quê', exact: true })).toHaveCount(0)
})

test('Tạo lô: the chosen model / aspect / count go into the batch; options follow the model; kept across screens and in a Mẫu lô', async () => {
  const { page } = await launch(tmp())
  const PRO = { kind: 'image', mode: 'Image', model: 'Nano Banana Pro', aspect: '9:16', count: 3 }
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  const set = page.getByTestId('batch-settings'), label = page.getByTestId('combo')
  await expect(label).toContainText('Nano Banana 2.1 · 16:9 · Cao · x2') // the app default
  await set.getByLabel('Mô hình').selectOption('Nano Banana Pro')
  await expect(set.getByLabel('Mức suy nghĩ (Thinking level)')).toHaveCount(0) // this model has no such option, so none is offered or sent
  await set.getByLabel('Tỉ lệ khung hình').selectOption('9:16')
  await set.getByLabel('Số ảnh mỗi prompt').selectOption('3')
  await expect(label).toContainText('Nano Banana Pro · 9:16 · x3')
  await page.getByRole('button', { name: 'Lưu làm mẫu…' }).click()
  await page.getByLabel('Tên mẫu').fill('Dọc Pro')
  await page.getByRole('button', { name: 'Lưu', exact: true }).click()
  await set.getByLabel('Mô hình').selectOption('Nano Banana 2 Lite')
  await expect(label).toContainText('Nano Banana 2 Lite · 9:16 · x3')
  await page.getByRole('button', { name: 'Dọc Pro', exact: true }).click() // the saved setup brings the settings back
  await expect(label).toContainText('Nano Banana Pro · 9:16 · x3')
  await page.getByRole('button', { name: 'Hàng đợi' }).click() // and they survive a visit to another screen
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await expect(label).toContainText('Nano Banana Pro · 9:16 · x3')
  await page.getByLabel('Danh sách prompt').fill('một quả cam')
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(1, { timeout: 60_000 })
  const combos = await page.evaluate(() => window.api.listBatches().then((r: { batches: { settings: { combo: object } }[] }) => r.batches.map((b) => b.settings.combo)))
  expect(combos).toEqual([PRO]) // what the runner hands to the page for this batch
})

test('several tabs (speed Nhanh): grant two projects, a new list is split into two parts that both finish; the cap and Thôi dùng work', async () => {
  const ud = tmp()
  writeFileSync(join(ud, 'draft.json'), JSON.stringify({ text: '', kind: 'image', mode: 'auto', speed: 'fast' }))
  const { page } = await launch(ud, '', { TOOLFLOW_FAKE_TABS: '2' })
  await expect(page.getByTestId('flow-tab')).toHaveCount(2)
  await expect(page.getByText('Đang dùng 1/4 tab')).toBeVisible()
  await page.getByRole('button', { name: 'Dùng tab này' }).click()
  await expect(page.getByText('Đang dùng 2/4 tab')).toBeVisible()
  await create(page, ['một', 'hai', 'ba', 'bốn', 'năm'])
  await expect(page.getByRole('heading', { level: 3 }).filter({ hasText: /phần [12]\/2/ })).toHaveCount(2)
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(5, { timeout: 30_000 })
  await expect(page.locator('.batch').filter({ hasText: 'phần 1/2' }).locator('td.n')).toHaveText(['1', '3', '5']) // the user's line numbers
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await page.getByRole('button', { name: 'Thôi dùng' }).first().click()
  await expect(page.getByText('Đang dùng 1/4 tab')).toBeVisible()
})

test('speed Mặc định: one tab only; the second offers the way to Nhanh instead of a button', async () => {
  const { page } = await launch(tmp(), '', { TOOLFLOW_FAKE_TABS: '2' })
  await expect(page.getByTestId('flow-tab')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Dùng tab này' })).toHaveCount(0)
  await expect(page.getByText('Tốc độ Mặc định chỉ dùng 1 tab')).toBeVisible()
})

test('Giao diện: the top-bar button switches dark/light, Cài đặt offers Sáng / Tối / Theo hệ thống, the choice survives a restart', async () => {
  const ud = tmp()
  const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  let { app, page } = await launch(ud)
  await page.emulateMedia({ colorScheme: 'light' })
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('system')
  expect(await bg(page)).toBe('rgb(251, 248, 245)')
  await page.emulateMedia({ colorScheme: 'dark' }) // system follows the OS
  expect(await bg(page)).toBe('rgb(20, 20, 20)')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByRole('button', { name: 'Chuyển sang giao diện tối' }).click()
  expect(await bg(page)).toBe('rgb(20, 20, 20)')
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  await expect(page.getByLabel('Tối', { exact: true })).toBeChecked()
  await page.getByLabel('Sáng', { exact: true }).check()
  expect(await bg(page)).toBe('rgb(251, 248, 245)')
  await page.getByLabel('Tối', { exact: true }).check()
  await app.close()
  ;({ app, page } = await launch(ud))
  await page.emulateMedia({ colorScheme: 'light' })
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  expect(await bg(page)).toBe('rgb(20, 20, 20)')
  await expect(page.getByRole('button', { name: 'Chuyển sang giao diện sáng' })).toBeVisible()
})

test('auto-update: a new version downloads by itself; the bar offers a restart; refused while an attempt waits for Gửi; Để sau hides it', async () => {
  const installs = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __toolflowUpdater: { installs: unknown[] } }).__toolflowUpdater.installs.length)
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_FAKE_UPDATE: '9.9.9' })
  const bar = page.locator('.update-bar')
  await expect(bar).toContainText('Bản mới 9.9.9 đã tải xong', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  await expect(page.getByTestId('update-state')).toHaveText('Bản 9.9.9 đã tải xong')
  // an attempt waiting for the user's Gửi in Flow is in flight: no restart
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByLabel('Thủ công (bạn bấm Gửi trong Flow)').check()
  await page.getByLabel('Danh sách prompt').fill('một con mèo')
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await expect(items(page).filter({ hasText: /Chờ bạn|bấm Gửi/ })).toHaveCount(1, { timeout: 10_000 })
  await bar.getByRole('button', { name: 'Khởi động lại để cập nhật' }).click()
  await expect(bar.getByRole('alert')).toContainText('Đang có lượt đang gửi')
  expect(await installs(app)).toBe(0)
  await page.getByRole('button', { name: 'Dừng', exact: true }).click() // the user stops the batch: nothing in flight any more
  await expect(items(page).filter({ hasText: /Chờ bạn|bấm Gửi/ })).toHaveCount(0, { timeout: 10_000 })
  await bar.getByRole('button', { name: 'Khởi động lại để cập nhật' }).click()
  await expect(bar.getByRole('alert')).toContainText('tự mở lại sau khoảng 1 phút') // read before the window goes
  await expect.poll(() => installs(app)).toBe(1)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]) // gone at once, before the installer runs
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show()) // (the fake installer does not quit the app)
  await bar.getByRole('button', { name: 'Để sau' }).click()
  await expect(bar).toHaveCount(0)
})

test('after an update, a Chrome still running the older extension: S1 asks for a reload, the top bar says so, self-check fails', async () => {
  const { page } = await launch(tmp(), '', { TOOLFLOW_FAKE_EXT_VERSION: '0.4.1' })
  await expect(page.getByTestId('reload-ext')).toContainText('bấm nút tải lại (mũi tên vòng) ở thẻ ToolFlow Connector', { timeout: 10_000 })
  await expect(page.getByLabel('Trạng thái phiên')).toContainText('Extension cần tải lại')
  await expect(page.getByText('Self-check: lỗi CONFIG_INCOMPLETE — RELOAD_TAB')).toBeVisible()
})

test('auto-update: no new version reads as up to date; without an update source the app says so', async () => {
  let { app, page } = await launch(tmp(), '', { TOOLFLOW_FAKE_UPDATE: 'none' })
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  await expect(page.getByTestId('update-state')).toHaveText('Bạn đang dùng bản mới nhất', { timeout: 10_000 })
  await app.close()
  ;({ app, page } = await launch(tmp()))
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  await expect(page.getByTestId('update-state')).toContainText('Chưa có nơi đặt bản cập nhật')
  await expect(page.getByRole('button', { name: 'Kiểm tra bản mới' })).toBeDisabled()
})

// ---- workflow canvas ----
test('Workflow: Text → Tạo ảnh → Tạo ảnh (result as ref) → Tự tải về runs as two batches; saved, reopened, kept across screens', async () => {
  const root = tmp()
  const { page } = await launch(tmp(), '', { TOOLFLOW_DOWNLOAD_ROOT: root })
  const node = (t: string) => page.getByTestId(`wf-${t}`)
  const wire = (from: ReturnType<typeof node>, to: ReturnType<typeof node>) => drag(page, from.locator('.react-flow__handle.source'), to.locator('.react-flow__handle.target'))
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('button', { name: /Tạo chuỗi mẫu/ }).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await node('text').getByLabel('Prompt của node Text').fill('nhân vật A')
  await addNode(page, 'Tạo ảnh Flow')
  await addNode(page, 'Text')
  await node('text').nth(1).getByLabel('Prompt của node Text').fill('cảnh 1')
  await wire(node('generate').nth(0), node('generate').nth(1)) // the first node's result is the second node's reference image
  await wire(node('text').nth(1), node('generate').nth(1))
  await wire(node('generate').nth(1), node('download'))
  await expect(page.locator('.react-flow__edge')).toHaveCount(5)
  await wire(node('text').nth(0), node('download')) // a wire that means nothing is refused
  await expect(page.locator('.react-flow__edge')).toHaveCount(5)

  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Workflow đã chạy xong', { timeout: 60_000 })
  await expect(node('generate').nth(0)).toContainText('Xong 1/1')
  await expect(node('generate').nth(1)).toContainText('Xong 1/1')
  await expect(node('generate').nth(0).locator('img')).toBeVisible() // the saved result, shown in the node
  const batches = await page.evaluate(() => window.api.listBatches().then((r: { batches: { status: string; items: { prompt: string; refs: string[] }[] }[] }) => r.batches.map((b) => [b.status, b.items.map((i) => [i.prompt, i.refs.length])])))
  expect(batches).toEqual([['completed', [['cảnh 1', 1]]], ['completed', [['nhân vật A', 0]]]]) // newest first
  expect(readdirSync(root, { recursive: true }).filter((f) => /\.(png|jpe?g|webp)$/.test(String(f))).length).toBeGreaterThanOrEqual(2)

  await page.getByLabel('Tên workflow').fill('Nhân vật rồi cảnh')
  await page.getByRole('button', { name: 'Lưu', exact: true }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Đã lưu')
  await page.getByRole('button', { name: 'Hàng đợi' }).click()
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(5) // the canvas survived the visit
  await expect(node('generate').nth(1)).toContainText('Xong 1/1')
  await page.getByRole('button', { name: 'Mới', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await page.getByLabel('Workflow đã lưu').selectOption({ label: 'Nhân vật rồi cảnh' })
  await expect(page.locator('.react-flow__node')).toHaveCount(5)
  await expect(page.locator('.react-flow__edge')).toHaveCount(5)
  await expect(node('text').nth(1).getByLabel('Prompt của node Text')).toHaveValue('cảnh 1')
})

test('Workflow: a node without a prompt is named on the canvas and nothing is sent', async () => {
  const { page } = await launch(tmp())
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await addNode(page, 'Tạo ảnh Flow')
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-generate').getByRole('alert')).toContainText('Node này chưa có prompt')
  expect(await page.evaluate(() => window.api.listBatches().then((r: { batches: unknown[] }) => r.batches.length))).toBe(0)
  await page.getByTestId('wf-generate').getByRole('button', { name: 'Xoá node Tạo ảnh Flow' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
})

test('Workflow: variables fill the prompts and the side panel shows what will be sent; undo / redo; export and import a file', async () => {
  const file = join(tmp(), 'wf.toolflow.json')
  const { page } = await launch(tmp(), '', { TOOLFLOW_WF_FILE: file })
  const node = (t: string) => page.getByTestId(`wf-${t}`)
  const boxes = page.locator('.react-flow__node'), status = page.getByTestId('wf-status')
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('button', { name: /Tạo chuỗi mẫu/ }).click()
  await node('text').getByLabel('Prompt của node Text').fill('{con vật} đi dạo\n{con vật} ngủ trưa\nmột cái cây')
  // nothing selected: the side panel is the variable table, and it offers the variable the text uses
  await page.getByRole('button', { name: '{con vật}' }).click()
  await page.getByLabel('Giá trị của con vật').fill('mèo\nchó')
  await node('generate').locator('header b').click() // select the node: its panel shows the real plan
  await expect(page.getByTestId('wf-preview')).toContainText('Sẽ gửi 5 prompt')
  await expect(page.getByTestId('wf-preview').locator('li')).toHaveText(['mèo đi dạo', 'chó đi dạo', 'mèo ngủ trưa', 'chó ngủ trưa', 'một cái cây'])
  await expect(page.getByTestId('wf-preview')).toContainText('Kết quả sẽ được tải về máy')

  // undo / redo: an added node, then a deleted node with its text and wires
  await page.getByRole('button', { name: 'Thêm ghi chú' }).click()
  await expect(boxes).toHaveCount(4)
  await page.getByRole('button', { name: 'Hoàn tác' }).click()
  await expect(boxes).toHaveCount(3)
  await page.getByRole('button', { name: 'Làm lại' }).click()
  await expect(boxes).toHaveCount(4)
  await node('text').getByRole('button', { name: 'Xoá node Text' }).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await page.getByRole('button', { name: 'Căn giữa' }).click() // focus on a button, not a text box
  await page.keyboard.press('Control+z')
  await expect(node('text').getByLabel('Prompt của node Text')).toHaveValue(/con vật/)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Làm lại' })).toBeEnabled()

  // a file out, the canvas cleared, the same file back in
  await page.getByLabel('Tên workflow').fill('Con vật')
  await page.getByRole('button', { name: 'Xuất file' }).click()
  await expect(status).toHaveText('Đã xuất file')
  const out = JSON.parse(readFileSync(file, 'utf8'))
  expect([out.toolflow, out.name, out.nodes.length, out.edges.length, out.vars]).toEqual([1, 'Con vật', 4, 2, { 'con vật': 'mèo\nchó' }])
  await page.getByRole('button', { name: 'Mới', exact: true }).click()
  await expect(boxes).toHaveCount(0)
  await page.getByRole('button', { name: 'Nhập file' }).click()
  await expect(boxes).toHaveCount(4)
  await expect(page.getByLabel('Tên workflow')).toHaveValue('Con vật')
  await expect(page.getByLabel('Giá trị của con vật')).toHaveValue('mèo\nchó')

  // the run sends the filled prompts; a variable without a value blocks it and is named on the Text node
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(status).toHaveText('Workflow đã chạy xong', { timeout: 60_000 })
  const prompts = await page.evaluate(() => window.api.listBatches().then((r: { batches: { items: { prompt: string }[] }[] }) => r.batches.flatMap((b) => b.items.map((i) => i.prompt))))
  expect(prompts).toEqual(['mèo đi dạo', 'chó đi dạo', 'mèo ngủ trưa', 'chó ngủ trưa', 'một cái cây'])
  await node('text').getByLabel('Prompt của node Text').fill('{chưa có} bay')
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(node('text').getByRole('alert')).toContainText('Biến {chưa có} chưa có giá trị')
  expect(await page.evaluate(() => window.api.listBatches().then((r: { batches: unknown[] }) => r.batches.length))).toBe(1)
  writeFileSync(file, '{"nodes":"x"}')
  await page.getByRole('button', { name: 'Nhập file' }).click()
  await expect(status).toHaveText('File này không phải workflow của ToolFlow hoặc đã hỏng')
  await expect(boxes).toHaveCount(4) // a bad file changes nothing
})

test('Workflow: Điều kiện — the first node lost its image, so the "Thiếu ảnh" side runs and the "Đủ ảnh" side does not', async () => {
  const { page } = await launch(tmp(), '', { TOOLFLOW_DOWNLOAD_ROOT: tmp(), TOOLFLOW_FAKE_DOWNLOADS: 'download-html' }) // the first saved file is not an image
  const node = (t: string) => page.getByTestId(`wf-${t}`)
  const wire = (from: ReturnType<typeof node>, to: ReturnType<typeof node>, port = '') => drag(page, from.locator(`.react-flow__handle.source${port && `[data-handleid="${port}"]`}`), to.locator('.react-flow__handle.target'))
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('button', { name: /Tạo chuỗi mẫu/ }).click()
  await node('text').getByLabel('Prompt của node Text').fill('nhân vật')
  for (const b of ['Điều kiện', 'Tạo ảnh Flow', 'Tạo ảnh Flow', 'Text', 'Text']) await addNode(page, b)
  await node('text').nth(1).getByLabel('Prompt của node Text').fill('cảnh có nhân vật')
  await node('text').nth(2).getByLabel('Prompt của node Text').fill('cảnh dự phòng')
  await wire(node('generate').nth(0), node('branch'))
  await wire(node('branch'), node('generate').nth(1), 'ok')
  await wire(node('branch'), node('generate').nth(2), 'fail')
  await wire(node('text').nth(1), node('generate').nth(1))
  await wire(node('text').nth(2), node('generate').nth(2))
  await expect(page.locator('.react-flow__edge')).toHaveCount(7)
  await wire(node('generate').nth(1), node('branch')) // a Điều kiện looks at one node only
  await expect(page.locator('.react-flow__edge')).toHaveCount(7)
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Workflow đã chạy xong', { timeout: 60_000 })
  await expect(node('generate').nth(1)).toContainText('Không chạy')
  await expect(node('generate').nth(2)).toContainText('Xong 1/1')
  const sent = await page.evaluate(() => window.api.listBatches().then((r: { batches: { items: { prompt: string; refs: string[] }[] }[] }) => r.batches.flatMap((b) => b.items.map((i) => [i.prompt, i.refs.length]))))
  expect(sent).toEqual([['cảnh dự phòng', 0], ['nhân vật', 0]])
})

test('Workflow: zoom buttons; the block picker opens from +, the N key and a right click, filters as typed; a block dragged from it lands where it is dropped; undo history survives another screen', async () => {
  const { page } = await launch(tmp())
  const boxes = page.locator('.react-flow__node')
  const scale = () => page.locator('.react-flow__viewport').evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).a)
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('button', { name: /Tạo chuỗi mẫu/ }).click()
  await expect(boxes).toHaveCount(3)
  await page.waitForTimeout(400) // an edit becomes its own undo step once the canvas stayed still for 300 ms (measured: the steps below took 0.34 s, a race)
  await expect(page.locator('.react-flow__minimap')).toHaveCount(0) // TobyFlow has none
  const picker = page.getByRole('dialog', { name: 'Thêm khối' })
  await page.getByRole('button', { name: 'Căn giữa' }).click() // focus on a button: N is a shortcut only outside text boxes
  await page.keyboard.press('n')
  await expect(picker.getByRole('option')).toHaveCount(11)
  await expect(picker.getByLabel('Tìm khối')).toBeFocused()
  await page.keyboard.type('ghép')
  await expect(picker.getByRole('option')).toHaveText([/Ghép video/])
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  const pane = page.locator('.react-flow__pane'), box = (await pane.boundingBox())!
  await page.mouse.click(box.x + box.width - 20, box.y + 30, { button: 'right' })
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Căn giữa' }).click()
  await expect.poll(scale).toBeLessThanOrEqual(1)
  const z0 = await scale()
  await page.getByRole('button', { name: 'Thu nhỏ', exact: true }).click()
  await expect.poll(scale).toBeLessThan(z0)
  const z1 = await scale()
  await page.getByRole('button', { name: 'Phóng to', exact: true }).click()
  await expect.poll(scale).toBeGreaterThan(z1)
  // drag "Ghi chú" from the picker onto the canvas: one more node, at the drop point (not in the default left column)
  await page.getByRole('button', { name: 'Thêm khối', exact: true }).click()
  await picker.getByRole('option', { name: 'Ghi chú', exact: true }).dragTo(pane, { targetPosition: { x: box.width - 60, y: box.height - 90 } })
  await expect(boxes).toHaveCount(4)
  await expect(picker).toHaveCount(0)
  const note = (await page.getByTestId('wf-note').boundingBox())!
  expect(Math.abs(note.x - (box.x + box.width - 60))).toBeLessThan(30)
  expect(Math.abs(note.y - (box.y + box.height - 90))).toBeLessThan(30)
  await expect(page.getByRole('button', { name: 'Hoàn tác' })).toBeEnabled()
  await page.getByRole('button', { name: 'Hàng đợi' }).click()
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await expect(boxes).toHaveCount(4)
  await page.getByRole('button', { name: 'Hoàn tác' }).click() // the step made before leaving is still there
  await expect(boxes).toHaveCount(3)
})

test('Workflow: a clicked wire is named in the side panel and removed there or with the Delete key; undo brings it back', async () => {
  const { page } = await launch(tmp())
  const edges = page.locator('.react-flow__edge')
  const clickWire = async (k: number): Promise<void> => { // the middle of the drawn line, in screen pixels
    const at = await page.locator('.react-flow__edge-path').nth(k).evaluate((el) => { const p = el as SVGPathElement, pt = p.getPointAtLength(p.getTotalLength() / 2), m = p.getScreenCTM()!; return { x: pt.x * m.a + m.e, y: pt.y * m.d + m.f } })
    await page.mouse.click(at.x, at.y)
  }
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('button', { name: /Tạo chuỗi mẫu/ }).click()
  await expect(edges).toHaveCount(2)
  await expect(page.getByTestId('wf-wire-hint')).toContainText('bấm vào dây') // how to do it is on screen before anything is selected
  await page.waitForTimeout(400) // the canvas records an undo step once an edit has settled for 300 ms; a person is never faster than that, this script is
  await clickWire(0)
  await expect(page.getByTestId('wf-wire')).toHaveText('Text → Tạo ảnh Flow')
  await page.getByRole('button', { name: 'Xoá dây này' }).click()
  await expect(edges).toHaveCount(1)
  await expect(page.locator('.react-flow__node')).toHaveCount(3) // only the wire went
  await page.getByRole('button', { name: 'Hoàn tác' }).click()
  await expect(edges).toHaveCount(2)
  await clickWire(1)
  await expect(page.getByTestId('wf-wire')).toHaveText('Tạo ảnh Flow → Tự tải về')
  await page.keyboard.press('Delete')
  await expect(edges).toHaveCount(1)
  await expect(page.getByTestId('wf-wire')).toHaveCount(0)
})

test('Workflow: a Tạo ảnh node carries its own model / aspect / count into its batch; options follow the model; exported, imported, and back to the default', async () => {
  const file = join(tmp(), 'wf.toolflow.json')
  const { page } = await launch(tmp(), '', { TOOLFLOW_WF_FILE: file })
  const node = (t: string) => page.getByTestId(`wf-${t}`), panel = page.getByTestId('wf-settings'), label = node('generate').getByTestId('wf-combo')
  const PRO = { kind: 'image', mode: 'Image', model: 'Nano Banana Pro', aspect: '9:16', count: 3 }
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('button', { name: /Tạo chuỗi mẫu/ }).click()
  await node('text').getByLabel('Prompt của node Text').fill('một quả cam\nmột quả táo')
  await expect(label).toHaveText('Nano Banana 2.1 · 16:9 · Cao · x2') // the app default, readable on the node itself
  await node('generate').locator('header b').click()
  await expect(panel).toContainText('Đang dùng cài đặt mặc định của app')
  await expect(panel.getByLabel('Mức suy nghĩ (Thinking level)')).toHaveValue('High')
  await panel.getByLabel('Mô hình').selectOption('Nano Banana Pro')
  await expect(panel.getByLabel('Mức suy nghĩ (Thinking level)')).toHaveCount(0) // this model has no such option, so none is offered or sent
  await panel.getByLabel('Tỉ lệ khung hình').selectOption('9:16')
  await panel.getByLabel('Số ảnh mỗi prompt').selectOption('3')
  await expect(label).toHaveText('Nano Banana Pro · 9:16 · x3')
  await expect(panel).toContainText('Node này dùng cài đặt riêng')
  await expect(page.getByTestId('wf-preview')).toContainText('Mỗi prompt tạo 3 ảnh, tổng cộng 6 ảnh')

  await page.getByRole('button', { name: 'Xuất file' }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Đã xuất file')
  expect((JSON.parse(readFileSync(file, 'utf8')).nodes as { type: string; combo?: object }[]).find((n) => n.type === 'generate')!.combo).toEqual(PRO)

  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Workflow đã chạy xong', { timeout: 60_000 })
  const combos = await page.evaluate(() => window.api.listBatches().then((r: { batches: { settings: { combo: object } }[] }) => r.batches.map((b) => b.settings.combo)))
  expect(combos).toEqual([PRO]) // what the runner hands to the page for this node's batch

  await panel.getByRole('button', { name: 'Về mặc định' }).click()
  await expect(label).toHaveText('Nano Banana 2.1 · 16:9 · Cao · x2')
  await panel.getByLabel('Mô hình').selectOption('Nano Banana Pro') // from the default: the other values stay where this model has them
  await expect(label).toHaveText('Nano Banana Pro · 16:9 · x2')
  await page.getByRole('button', { name: 'Nhập file' }).click() // the exported file brings the node's settings back
  await expect(label).toHaveText('Nano Banana Pro · 9:16 · x3')
})

test('Workflow: Điều kiện "Có prompt bị Flow lọc" — Flow refuses the first node\'s prompt, so that side runs its rewritten prompt and the other side does not', async () => {
  const { page } = await launch(tmp(), 'blocked', { TOOLFLOW_DOWNLOAD_ROOT: tmp() }) // the first send comes back refused for its content
  const node = (t: string) => page.getByTestId(`wf-${t}`)
  const wire = (from: ReturnType<typeof node>, to: ReturnType<typeof node>, port = '') => drag(page, from.locator(`.react-flow__handle.source${port && `[data-handleid="${port}"]`}`), to.locator('.react-flow__handle.target'))
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('button', { name: /Tạo chuỗi mẫu/ }).click()
  await node('text').getByLabel('Prompt của node Text').fill('nhân vật')
  for (const b of ['Điều kiện', 'Tạo ảnh Flow', 'Tạo ảnh Flow', 'Text', 'Text']) await addNode(page, b)
  await node('text').nth(1).getByLabel('Prompt của node Text').fill('nhân vật, viết lại nhẹ hơn')
  await node('text').nth(2).getByLabel('Prompt của node Text').fill('cảnh tiếp theo')
  await wire(node('generate').nth(0), node('branch'))
  await wire(node('branch'), node('generate').nth(1), 'ok')
  await wire(node('branch'), node('generate').nth(2), 'fail')
  await wire(node('text').nth(1), node('generate').nth(1))
  await wire(node('text').nth(2), node('generate').nth(2))
  await expect(node('branch')).toContainText('Đủ ảnh đã lưu') // the default question
  await node('branch').locator('header b').click()
  await page.getByLabel('Xét node Tạo ảnh phía trước theo điều kiện').selectOption('filtered')
  await expect(node('branch')).toContainText('Có prompt bị Flow lọc')
  await expect(node('branch')).toContainText('Không bị lọc')
  await expect(page.getByTestId('wf-cond-help')).toContainText('Cả hai nhánh không mang ảnh sang node sau')
  await node('generate').nth(1).locator('header b').click()
  await expect(page.getByTestId('wf-preview')).toContainText('Chỉ chạy khi node phía trước có prompt bị Flow lọc')
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Workflow chạy xong, có node lỗi (xem dòng đỏ)', { timeout: 60_000 }) // the refused node is still a failed node
  await expect(node('generate').nth(0)).toContainText('Lỗi')
  await expect(node('generate').nth(1)).toContainText('Xong 1/1')
  await expect(node('generate').nth(2)).toContainText('Không chạy')
  const sent = await page.evaluate(() => window.api.listBatches().then((r: { batches: { items: { prompt: string; refs: string[]; attempts: { error: { code: string } | null }[] }[] }[] }) => r.batches.flatMap((b) => b.items.map((i) => [i.prompt, i.refs.length, i.attempts.at(-1)!.error?.code ?? null]))))
  expect(sent).toEqual([['nhân vật, viết lại nhẹ hơn', 0, null], ['nhân vật', 0, 'CONTENT_BLOCKED']])
})

// ---- downloads (AC-07, AC-15, AC-16, AC-26) ----
// '/'-separated like the names the app shows: readdir gives '\\' on Windows
test('video from a start frame: one image per prompt in Tạo lô, each video is sent with its own frame', async () => {
  const { list } = pngs(['a.png', 'b.png'])
  const { app, page } = await launch(tmp(), 'video-ok,video-ok', { TOOLFLOW_PICK_REFS: list })
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'Video', exact: true }).check()
  await page.getByLabel('Danh sách prompt').fill('một con mèo\nmột con chó')
  await expect(page.getByRole('group', { name: 'Khung hình đầu' })).toBeVisible()
  await expect(page.getByLabel('Số ảnh tham chiếu mỗi prompt')).toHaveCount(0) // a video takes exactly one
  await page.getByRole('button', { name: 'Chọn ảnh…' }).click()
  await page.getByLabel('Mỗi prompt một ảnh theo thứ tự').check()
  await expect(row(page, 0)).toContainText('a.png')
  await expect(row(page, 1)).toContainText('b.png')
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(2)
  const l = await ledger(app)
  expect([l.uploads.length, l.refs.map((r) => r.length), new Set(l.refs.flat()).size]).toEqual([2, [1, 1], 2])
})

test('video from a start and an end frame: the box in Tạo lô gives each prompt two images in order, the first opens the video and the second ends it', async () => {
  const { list } = pngs(['a.png', 'b.png', 'c.png', 'd.png'])
  const { app, page } = await launch(tmp(), 'video-ok,video-ok', { TOOLFLOW_PICK_REFS: list })
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'Video', exact: true }).check()
  await page.getByLabel('Danh sách prompt').fill('một con mèo\nmột con chó')
  await page.getByRole('button', { name: 'Chọn ảnh…' }).click()
  await page.getByLabel('Có khung hình cuối (ảnh thứ hai của mỗi prompt)').check()
  await page.getByLabel('Mỗi prompt hai ảnh theo thứ tự').check()
  await expect(row(page, 0)).toContainText('a.png'); await expect(row(page, 0)).toContainText('b.png')
  await expect(row(page, 1)).toContainText('c.png'); await expect(row(page, 1)).toContainText('d.png')
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(2)
  expect((await ledger(app)).refs.map((r) => r.length)).toEqual([2, 2])
})

const pngFiles = (root: string): string[] => (existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]) : []).map((f) => f.replace(/\\/g, '/')).filter((f) => f.endsWith('.png')).sort()
const outputs = (page: Page) => page.locator('[data-testid=output]')

test('Tải tất cả: 3 files on disk with PNG magic, S4 shows Đã lưu only after each completes', async () => {
  const root = join(tmp(), 'dl')
  const { page } = await launch(tmp(), '', { TOOLFLOW_DOWNLOAD_ROOT: root })
  await create(page, ['một con mèo', 'một con chó', 'một con cá'])
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(3)
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await expect(outputs(page)).toHaveCount(3)
  await expect(outputs(page).filter({ hasText: 'Chưa tải' })).toHaveCount(3)
  await expect(page.locator('body')).not.toContainText('Đã lưu') // AC-07: generated is not saved
  await expect(page.locator('body')).not.toContainText('100%')
  await page.getByRole('button', { name: 'Tải tất cả kết quả' }).click()
  await expect(outputs(page).filter({ hasText: 'Đã lưu' })).toHaveCount(3)
  const files = pngFiles(root)
  expect(files).toHaveLength(3)
  for (const f of files) expect(readFileSync(join(root, f)).subarray(0, 4).toString('hex')).toBe('89504e47')
  expect(files.every((f) => /^\d{4}-\d\d-\d\d_[0-9a-f]{8}\/00[123]_.+_[0-9a-f]{8}\.png$/.test(f))).toBe(true)
  await expect(page.locator('body')).not.toContainText('Lỗi tải')
  await expect(outputs(page).locator('img[src^="data:image/png;base64,"]')).toHaveCount(3) // the thumbnail is the saved file, read back from disk
})

test('video batch: chosen in Tạo lô, runs to ready on Flow\'s polls, Tải tất cả saves MP4 files and Kết quả shows them as saved videos', async () => {
  const root = join(tmp(), 'dl')
  const { page } = await launch(tmp(), 'video-ok,video-ok', { TOOLFLOW_DOWNLOAD_ROOT: root })
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'Video', exact: true }).check()
  await expect(page.getByTestId('combo')).toContainText('Video · Veo 3.1 - Lite')
  await create(page, ['một con mèo', 'một con chó'])
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(2)
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await page.getByRole('button', { name: 'Tải tất cả kết quả' }).click()
  await expect(outputs(page).filter({ hasText: 'Đã lưu' })).toHaveCount(2)
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.mp4'))
  expect(files).toHaveLength(2)
  for (const f of files) expect(readFileSync(join(root, f)).subarray(4, 8).toString()).toBe('ftyp')
  await expect(outputs(page).filter({ hasText: 'Video đã lưu' })).toHaveCount(2) // the file is read only when asked for
  await expect(page.locator('video')).toHaveCount(0)
  await outputs(page).first().getByRole('button', { name: 'Xem video' }).click()
  await expect(outputs(page).first().locator('video[controls][src^="data:video/mp4;base64,"]')).toBeVisible() // the saved file itself, played inside the app
  await expect(page.locator('body')).not.toContainText('Không thấy tệp trên máy')
})

test('Bắt đầu nhanh opens Tạo lô with the preset; search narrows the queue and the results', async () => {
  const { page } = await launch(tmp())
  await page.getByRole('button', { name: 'Hàng đợi' }).click()
  await page.getByRole('button', { name: /Ảnh, tôi tự bấm Gửi/ }).click()
  await expect(page.getByLabel('Thủ công (bạn bấm Gửi trong Flow)')).toBeChecked()
  await page.getByLabel('Tự động').check()
  await create(page, ['một con mèo', 'một con chó'])
  await expect(items(page)).toHaveCount(2)
  await page.getByLabel('Tìm prompt hoặc lô').fill('CHÓ')
  await expect(items(page)).toHaveCount(1)
  await expect(items(page)).toContainText('một con chó')
  await page.getByLabel('Tìm prompt hoặc lô').fill('không có')
  await expect(items(page)).toHaveCount(0)
  await expect(page.locator('body')).toContainText('Không có prompt hay lô nào khớp')
})

test('Ghép prompt từ mẫu: variables fill the prompt list, every combination or line by line, errors shown', async () => {
  const { page } = await launch(tmp())
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByText('Ghép prompt từ mẫu').click()
  await page.getByLabel(/Mẫu prompt/).fill('{món ăn} ở {nơi}, ảnh đời thường')
  await page.getByLabel('Giá trị cho món ăn').fill('phở\nbún chả')
  await expect(page.getByRole('status').filter({ hasText: 'Biến {nơi} chưa có giá trị nào.' })).toBeVisible()
  await page.getByLabel('Giá trị cho nơi').fill('Hà Nội\nHuế\nSài Gòn')
  await page.getByRole('button', { name: 'Tạo 6 prompt' }).click()
  await expect(page.locator('[data-testid=preview] tbody tr')).toHaveCount(6)
  await expect(page.locator('[data-testid=preview] tbody tr').nth(1)).toContainText('phở ở Huế, ảnh đời thường')
  await page.getByLabel('Ghép theo dòng').check()
  await expect(page.getByRole('status').filter({ hasText: 'Ghép theo dòng cần mọi danh sách dài bằng nhau' })).toBeVisible()
  await page.getByLabel('Giá trị cho nơi').fill('Hà Nội\nHuế')
  await page.getByRole('button', { name: 'Thay danh sách bằng 2 prompt' }).click()
  await expect(page.locator('[data-testid=preview] tbody tr')).toHaveCount(2)
  await expect(page.getByLabel('Danh sách prompt')).toHaveValue('phở ở Hà Nội, ảnh đời thường\nbún chả ở Huế, ảnh đời thường')
})

test('Flow results save themselves as they get ready, and a save that failed is tried again by itself; with the box in Cài đặt unticked they wait for Tải', async () => {
  const root = join(tmp(), 'dl')
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_DOWNLOAD_ROOT: root, TOOLFLOW_FAKE_DOWNLOADS: 'download-html', TOOLFLOW_AUTOSAVE: '1' })
  await create(page, ['một con mèo'])
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await expect(outputs(page).first()).toContainText('Đã lưu', { timeout: 30_000 }) // nobody pressed Tải or Thử lại
  expect(pngFiles(root)).toHaveLength(1)
  expect((await ledger(app)).fetches).toBe(2) // the first transfer was bad, the app's own second one was good
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  const box = page.getByLabel('Tự lưu kết quả của lô Flow về máy khi tạo xong')
  await box.click() // the box shows the saved setting, which arrives a moment after the click: wait for it instead of uncheck()'s instant check
  await expect(box).not.toBeChecked()
  await create(page, ['một con chó'])
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(1)
  await page.waitForTimeout(5000)
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await expect(outputs(page).filter({ hasText: 'Chưa tải' })).toHaveCount(1)
  expect(pngFiles(root)).toHaveLength(1)
})

test('a bad download is Lỗi tải with no completed file; Thử lại completes it under the same name without generating again', async () => {
  const root = join(tmp(), 'dl')
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_DOWNLOAD_ROOT: root, TOOLFLOW_FAKE_DOWNLOADS: 'download-html' })
  await create(page, ['một con mèo'])
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(1)
  const before = await ledger(app)
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await page.getByRole('button', { name: 'Tải tất cả kết quả' }).click()
  await expect(outputs(page).first()).toContainText('Lỗi tải')
  await expect(page.locator('body')).not.toContainText('Đã lưu')
  expect(pngFiles(root)).toEqual([])
  const retry = page.getByRole('button', { name: 'Thử lại' })
  await expect(retry).toBeVisible()
  await retry.click()
  await expect(outputs(page).first()).toContainText('Đã lưu')
  const files = pngFiles(root)
  expect(files).toHaveLength(1)
  await expect(outputs(page).first()).toContainText(files[0]) // the name shown is the planned name, relative
  const after = await ledger(app)
  expect([after.clicks, after.prepares, after.arms]).toEqual([before.clicks, before.prepares, before.arms]) // AC-16: no new generate
  expect(after.fetches).toBe(2)
})

test('ACK lost: the app finds the file the first transfer made instead of downloading again (AC-26)', async () => {
  const root = join(tmp(), 'dl')
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_DOWNLOAD_ROOT: root, TOOLFLOW_FAKE_DOWNLOADS: 'download-ack-lost' })
  await create(page, ['một con mèo'])
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await page.getByRole('button', { name: 'Tải tất cả kết quả' }).click()
  await expect(outputs(page).first()).toContainText('Đã lưu')
  expect(pngFiles(root)).toHaveLength(1)
  expect((await ledger(app)).fetches).toBe(1)
})

test('a long history: Kết quả shows the newest 120 results, Xem thêm the next ones; a preview is made only for cards near the view', async () => {
  const ud = tmp(), root = tmp()
  const db = openDb(join(ud, 'toolflow.db')) // a history written before the app starts: 50 finished batches of 2 prompts, 2 saved images each
  for (let b = 0; b < 50; b++) {
    const { batchId } = enqueueBatch(db, { commandId: `h${b}`, kind: 'image', provider: 'flow', projectId: 'p', settings: { provider: 'flow' }, prompts: [`ảnh ${b} a`, `ảnh ${b} b`], refs: [[], []], mode: 'auto' })
    for (const { a } of db.prepare('select attempt_id a from item where batch_id=?').all(batchId) as { a: string }[]) {
      const outputs = [{ mediaId: `${a}-1` }, { mediaId: `${a}-2` }]
      db.prepare('update attempt set state_json=? where id=?').run(JSON.stringify({ item: 'ready', stage: 'outcome_known', prompt: 'x', clicked: true, baseline: null, outputs }), a)
      for (const o of outputs) {
        mkdirSync(join(root, 'x'), { recursive: true }); writeFileSync(join(root, 'x', `${o.mediaId}.png`), PNG1)
        db.prepare("insert into download(id, attempt_id, media_id, planned_name, state, actual_name, bytes, created_at, updated_at) values(?,?,?,?,'completed',?,?,1,1)").run(`d-${o.mediaId}`, a, o.mediaId, 'n', `x/${o.mediaId}.png`, PNG1.length)
      }
    }
  }
  db.close()
  const { page } = await launch(ud, '', { TOOLFLOW_DOWNLOAD_ROOT: root })
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await expect(page.getByText('200/200')).toBeVisible()
  await expect(page.getByTestId('output')).toHaveCount(120)
  await expect(page.locator('.gallery img').first()).toBeVisible()
  await page.waitForTimeout(1500)
  const made = await page.locator('.gallery img').count()
  expect(made).toBeGreaterThan(0)
  expect(made).toBeLessThan(80) // not all 120: the ones far below wait until they are scrolled to
  await page.getByRole('button', { name: 'Xem thêm (còn 80)' }).click()
  await expect(page.getByTestId('output')).toHaveCount(200)
  await expect(page.getByRole('button', { name: /Xem thêm/ })).toHaveCount(0)
  await page.getByTestId('output').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('output').last().locator('img')).toBeVisible()
  await page.getByLabel('Tìm prompt hoặc lô').fill('ảnh 3 a') // a search looks through every result, not only the shown ones
  await expect(page.getByTestId('output')).toHaveCount(2)
})

test('m5: a failed download shows an inline alert, never window.alert', async () => {
  const dir = tmp()
  const first = await launch(dir)
  await create(first.page, ['một con mèo'])
  await expect(items(first.page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(1)
  await first.app.close()
  const { page } = await launch(dir, '', { TOOLFLOW_FAKE_GRANT: '0', TOOLFLOW_FAKE_TABS: '0' }) // no Flow tab (the remembered one is not open): downloadBatch rejects with NO_PROJECT_TAB
  const dialogs: string[] = []
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss() })
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await page.getByRole('button', { name: 'Tải tất cả kết quả' }).click()
  await expect(page.getByRole('alert')).toContainText('NO_PROJECT_TAB')
  expect(dialogs).toEqual([])
})

test('I4b: a batch paused on REF_UPLOAD_UNCERTAIN offers an inline two-step reset with Huỷ focused; no dialog', async () => {
  const { list } = pngs(['a.png'])
  const { page } = await launch(tmp(), '', { TOOLFLOW_PICK_REFS: list, TOOLFLOW_FAKE_PREPARE: 'REF_UPLOAD_UNCERTAIN' })
  const dialogs: string[] = []
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss() })
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByLabel('Danh sách prompt').fill('một con mèo\nmột con chó')
  await page.getByRole('button', { name: 'Chọn ảnh…' }).click()
  await expect(page.getByTestId('pool').locator('li')).toHaveCount(1)
  await page.getByLabel('Dùng chung tất cả ảnh cho mọi prompt').check()
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await expect(page.getByTestId('pause-reason')).toBeVisible()
  const ask = 'Xoá trạng thái tải lên cũ và cho phép tải lại ảnh này? Chỉ làm khi đã kiểm tra thư viện Flow không có ảnh này.'
  await page.getByRole('button', { name: 'Cho phép tải lại ảnh tham chiếu 1' }).click()
  await expect(page.getByRole('group', { name: ask })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Huỷ' })).toBeFocused()
  await page.keyboard.press('Enter') // a stray Enter cancels
  await expect(page.getByRole('group', { name: ask })).toHaveCount(0)
  await page.getByRole('button', { name: 'Cho phép tải lại ảnh tham chiếu 1' }).click()
  await page.getByRole('button', { name: 'Có, cho phép tải lại' }).click()
  await expect(page.getByRole('group', { name: ask })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(dialogs).toEqual([])
})

test('Workflow: a node switched to Video starts from the image the node before it made, and its MP4 is saved', async () => {
  const root = join(tmp(), 'dl')
  const { app, page } = await launch(tmp(), 'image-ok,video-ok', { TOOLFLOW_DOWNLOAD_ROOT: root })
  const node = (t: string) => page.getByTestId(`wf-${t}`), panel = page.getByTestId('wf-settings')
  const wire = (from: ReturnType<typeof node>, to: ReturnType<typeof node>) => drag(page, from.locator('.react-flow__handle.source'), to.locator('.react-flow__handle.target'))
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('button', { name: /Tạo chuỗi mẫu/ }).click()
  await node('text').getByLabel('Prompt của node Text').fill('nhân vật A')
  await addNode(page, 'Tạo ảnh Flow')
  await addNode(page, 'Text')
  await node('text').nth(1).getByLabel('Prompt của node Text').fill('nhân vật quay đầu lại')
  await wire(node('generate').nth(0), node('generate').nth(1))
  await wire(node('text').nth(1), node('generate').nth(1))
  await wire(node('generate').nth(1), node('download'))
  await node('generate').nth(1).locator('header b').click()
  await panel.getByLabel('Loại kết quả').selectOption('video')
  await expect(node('generate').nth(1).getByTestId('wf-combo')).toHaveText('Video · Veo 3.1 - Lite · 16:9 · x1')
  await expect(page.getByTestId('wf-preview')).toContainText('Mỗi prompt tạo 1 video, tổng cộng 1 video')
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Workflow đã chạy xong', { timeout: 60_000 })
  await expect(node('generate').nth(1)).toContainText('Video đã lưu')
  const files = (readdirSync(root, { recursive: true }) as string[]).map(String)
  expect([files.filter((f) => f.endsWith('.mp4')).length, files.filter((f) => f.endsWith('.png')).length]).toEqual([1, 1])
  expect((await ledger(app)).refs.map((r) => r.length)).toEqual([1]) // only the video was sent with an image: its start frame
})

test('MCP: off until turned on in Cài đặt; then an agent with the key creates a batch, follows it and saves the files; off closes the door', async () => {
  const ud = tmp(), root = join(tmp(), 'dl')
  const { page } = await launch(ud, '', { TOOLFLOW_DOWNLOAD_ROOT: root, TOOLFLOW_MCP_PORT: '0' })
  expect(existsSync(join(ud, 'mcp.json'))).toBe(false)
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  const box = page.getByLabel('Cho trợ lý AI trên máy này điều khiển ToolFlow')
  await expect(box).not.toBeChecked()
  await box.check()
  const url = await page.getByTestId('mcp-url').innerText()
  const { token } = JSON.parse(readFileSync(join(ud, 'mcp.json'), 'utf8')) as { token: string }
  await expect(page.locator('body')).not.toContainText(token) // the key stays in the file
  let n = 0
  const ask = async (method: string, params?: object, key = token) => {
    const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, ...(params ? { params } : {}) }) })
    return { status: r.status, body: r.status === 200 ? ((await r.json()) as { result: { content?: { text: string }[]; tools?: { name: string }[]; isError?: boolean } }).result : null }
  }
  const tool = async (name: string, args: object = {}) => JSON.parse((await ask('tools/call', { name, arguments: args })).body!.content![0].text)
  expect((await ask('tools/list', undefined, 'wrong')).status).toBe(401)
  expect((await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })).status).toBe(200)
  expect((await ask('tools/list')).body!.tools!.map((t) => t.name)).toEqual(['toolflow_status', 'toolflow_create_batch', 'toolflow_list_batches', 'toolflow_download'])
  expect(await tool('toolflow_status')).toMatchObject({ connected: true, tabsInUse: 1, selfCheckOk: true })
  const { batchIds } = await tool('toolflow_create_batch', { prompts: ['một con mèo', 'một con chó'] }) as { batchIds: string[] }
  expect(batchIds).toHaveLength(1)
  await expect.poll(async () => (await tool('toolflow_list_batches', { batchId: batchIds[0] })).batches[0].status, { timeout: 30_000 }).toBe('completed')
  const done = await tool('toolflow_download', { batchId: batchIds[0] }) as { batches: { items: { prompt: string; state: string; files: string[] }[] }[] }
  expect(done.batches[0].items.map((i) => [i.prompt, i.state, i.files.length])).toEqual([['một con mèo', 'ready', 1], ['một con chó', 'ready', 1]])
  for (const f of done.batches[0].items.flatMap((i) => i.files)) expect([f.startsWith(root), readFileSync(f).subarray(0, 4).toString('hex')]).toEqual([true, '89504e47'])
  // the same tool sends to a chat site: the app's own door takes the Gemini choices and refuses a wrong mix
  expect(await tool('toolflow_status')).toMatchObject({ chatgptTabs: 1, geminiTabs: 1 })
  const g = await tool('toolflow_create_batch', { prompts: ['một con cá'], site: 'gemini', aspect: '9:16', model: 'Pro' }) as { batchIds: string[] }
  await expect.poll(async () => (await tool('toolflow_list_batches', { batchId: g.batchIds[0] })).batches[0].items[0].files.length, { timeout: 30_000 }).toBe(1) // saved by the app itself
  expect((await ask('tools/call', { name: 'toolflow_create_batch', arguments: { prompts: ['x'], site: 'chatgpt', aspect: '9:16' } })).body!.isError).toBe(true)
  expect((await ask('tools/call', { name: 'toolflow_create_batch', arguments: { prompts: ['x'], site: 'gemini', kind: 'video' } })).body!.isError).toBe(true)
  await page.getByRole('button', { name: 'Hàng đợi' }).click()
  await expect(items(page).filter({ hasText: 'một con mèo' })).toHaveCount(1) // the user sees the agent's batch like any other
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  await box.uncheck()
  await expect(page.getByTestId('mcp-url')).toHaveCount(0)
  await expect(ask('ping')).rejects.toThrow()
})

test('MCP: a busy port says so in plain words and the switch stays off', async () => {
  const { createServer } = await import('node:net')
  const taken = createServer().listen(0, '127.0.0.1')
  await new Promise((r) => taken.once('listening', r))
  try {
    const { page } = await launch(tmp(), '', { TOOLFLOW_MCP_PORT: String((taken.address() as { port: number }).port) })
    await page.getByRole('button', { name: 'Cài đặt' }).click()
    await page.getByLabel('Cho trợ lý AI trên máy này điều khiển ToolFlow').click()
    await expect(page.getByRole('alert')).toContainText('đang bị chương trình khác dùng')
    await expect(page.getByLabel('Cho trợ lý AI trên máy này điều khiển ToolFlow')).not.toBeChecked()
    await expect(page.getByTestId('mcp-url')).toHaveCount(0)
  } finally { taken.close() }
})

test('Workflow: a ready-made workflow opens wired and named, and runs as it is (image, then a video from it)', async () => {
  const root = join(tmp(), 'dl')
  const { page } = await launch(tmp(), 'image-ok,video-ok', { TOOLFLOW_DOWNLOAD_ROOT: root })
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await expect(page.getByLabel('Mẫu có sẵn').locator('option')).toHaveCount(8) // the placeholder + 7 templates
  await page.getByLabel('Mẫu có sẵn').selectOption('Tạo ảnh rồi làm video từ ảnh đó')
  await expect(page.getByLabel('Tên workflow')).toHaveValue('Tạo ảnh rồi làm video từ ảnh đó')
  await expect(page.locator('.react-flow__node')).toHaveCount(6)
  await expect(page.locator('.react-flow__edge')).toHaveCount(4)
  await expect(page.getByTestId('wf-generate').nth(1).getByTestId('wf-combo')).toContainText('Video · Veo 3.1 - Lite')
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Workflow đã chạy xong', { timeout: 60_000 })
  expect((readdirSync(root, { recursive: true }) as string[]).map(String).filter((f) => f.endsWith('.mp4'))).toHaveLength(1)
})

test('Workflow: Nối cảnh video — Text → Tạo video → Khung cuối → Tạo video → Ghép video runs both scenes, joins the clips and offers the folder; a wire let go on empty canvas opens the picker and the new block is wired', async () => {
  const root = join(tmp(), 'dl')
  const { page } = await launch(tmp(), 'video-ok,video-ok,video-ok,video-ok', { TOOLFLOW_DOWNLOAD_ROOT: root }) // two scenes of two prompts each
  const node = (t: string) => page.getByTestId(`wf-${t}`), left = async (l: Locator) => (await l.boundingBox())!.x
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByLabel('Mẫu có sẵn').selectOption('Nối cảnh video')
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  await expect(page.locator('.react-flow__edge')).toHaveCount(6)
  await expect(node('merge').locator('.wf-order')).toHaveText('3') // the run order from the plan: scene 1, scene 2, then the join
  await page.getByRole('button', { name: 'Tự sắp xếp' }).click()
  await expect.poll(async () => [await left(node('text').nth(0)) < await left(node('generate').nth(0)), await left(node('generate').nth(0)) < await left(node('frame')), await left(node('frame')) < await left(node('generate').nth(1)), await left(node('generate').nth(1)) < await left(node('merge'))]).toEqual([true, true, true, true])
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByRole('button', { name: 'Dừng workflow' })).toBeVisible()
  await expect(page.getByTestId('wf-status')).toHaveText('Workflow đã chạy xong', { timeout: 60_000 })
  await expect(node('merge')).toContainText('Xong')
  await expect(node('merge')).toContainText(/ghep-video-[0-9a-f]{8}\.mp4/)
  await expect(node('merge').getByRole('button', { name: 'Mở thư mục' })).toBeVisible() // not clicked: it would open Explorer
  const mp4 = (readdirSync(root, { recursive: true }) as string[]).map(String).filter((f) => f.endsWith('.mp4'))
  expect([mp4.length, mp4.filter((f) => basename(f).startsWith('ghep-video-')).length]).toEqual([5, 1]) // four clips and the joined video
  await node('merge').locator('header b').click()
  await page.getByRole('tab', { name: 'Kết quả' }).click()
  await expect(page.locator('aside[aria-label="Cấu hình"]')).toContainText('ghep-video-')

  // a wire from a Text's output let go on empty canvas: the picker offers only what a prompt can go to, and wires the new block
  await page.getByRole('button', { name: 'Mới', exact: true }).click()
  await addNode(page, 'Text')
  const out = (await node('text').locator('.react-flow__handle.source').boundingBox())!
  await page.mouse.move(out.x + out.width / 2, out.y + out.height / 2)
  await page.mouse.down()
  await page.mouse.move(out.x + 40, out.y + 230, { steps: 10 })
  await page.mouse.up()
  const picker = page.getByRole('dialog', { name: 'Thêm khối' })
  await expect(picker).toContainText('Gợi ý cho cổng')
  await expect(picker.getByRole('option')).toHaveText([/^Tạo ảnh Flow/, /^Tạo video Flow/])
  await picker.getByRole('option', { name: 'Tạo video Flow', exact: true }).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect(node('generate').locator('header b')).toHaveText('Tạo video Flow')
})

test('Tạo lô: Nạp file CSV fills the prompt list from a column, or from the template box with the columns as {variables}; an empty cell is named, not dropped', async () => {
  const { page } = await launch(tmp())
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  const input = page.locator('label.filebtn', { hasText: 'Nạp file CSV' }).locator('input')
  const list = page.getByLabel('Danh sách prompt')
  await input.setInputFiles({ name: 'con vật.csv', mimeType: 'text/csv', buffer: Buffer.from('\uFEFFTên;Nơi\r\n"mèo, cam";sân\r\n\r\nchó;"nhà ""gỗ"""\r\n') }) // Excel in Vietnamese: ';', BOM, CRLF
  await expect(list).toHaveValue('mèo, cam\nchó') // the first column at once
  await expect(page.locator('[data-testid=preview] tbody tr')).toHaveCount(2)
  await page.getByLabel('Lấy prompt từ cột').selectOption({ label: 'Cột “Nơi”' })
  await expect(list).toHaveValue('sân\nnhà "gỗ"')
  await page.getByLabel('Lấy prompt từ cột').selectOption({ label: 'Ghép nhiều cột bằng mẫu ở trên' })
  await expect(page.getByTestId('csv-cols')).toContainText('{Tên} {Nơi}')
  await page.getByLabel(/Mẫu prompt/).fill('{Tên} nằm ở {Nơi}, ảnh đời thường')
  await page.getByRole('button', { name: 'Thay danh sách bằng 2 prompt' }).click()
  await expect(list).toHaveValue('mèo, cam nằm ở sân, ảnh đời thường\nchó nằm ở nhà "gỗ", ảnh đời thường')
  await page.getByLabel(/Mẫu prompt/).fill('{Màu}')
  await expect(page.getByRole('alert')).toContainText('Cột “Màu”: File CSV không có cột này')
  await input.setInputFiles({ name: 'thiếu.csv', mimeType: 'text/csv', buffer: Buffer.from('Tên,Nơi\nmèo,sân\n,nhà\n') })
  await expect(page.getByTestId('csv-error')).toContainText('Dòng 3, cột “Tên”: Ô này đang trống')
  await expect(list).toHaveValue('mèo, cam nằm ở sân, ảnh đời thường\nchó nằm ở nhà "gỗ", ảnh đời thường') // the list is left as it was
  await page.getByRole('button', { name: 'Bỏ file CSV' }).click()
  await expect(page.getByTestId('csv-error')).toHaveCount(0)
})

test('Workflow: Text → Tạo ảnh → Vòng lặp (3) → Tự tải về runs three batches in order, each round sent with the image the round before saved; only then saved', async () => {
  const ud = tmp(), root = join(tmp(), 'dl')
  const { app, page } = await launch(ud, '', { TOOLFLOW_DOWNLOAD_ROOT: root })
  const node = (t: string) => page.getByTestId(`wf-${t}`)
  const wire = (from: ReturnType<typeof node>, to: ReturnType<typeof node>) => drag(page, from.locator('.react-flow__handle.source'), to.locator('.react-flow__handle.target'))
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  for (const k of ['Text', 'Tạo ảnh Flow', 'Vòng lặp', 'Tự tải về']) await addNode(page, k)
  await node('text').getByLabel('Prompt của node Text').fill('chân dung ông lão')
  await wire(node('text'), node('generate'))
  await wire(node('generate'), node('loop'))
  await wire(node('loop'), node('download'))
  await expect(page.locator('.react-flow__edge')).toHaveCount(3)
  await node('loop').locator('header b').click()
  await page.getByLabel('Số vòng').fill('3')
  await expect(node('loop')).toContainText('tổng cộng 3 vòng')
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Workflow đã chạy xong', { timeout: 60_000 })
  await expect(node('loop')).toContainText('Xong · vòng 3/3 1/1')
  type B = { id: string; status: string; items: { prompt: string; refs: string[]; attempts: { downloads: Record<string, { state: string; actualName: string | null }> }[] }[] }
  const batches = (await page.evaluate(() => window.api.listBatches().then((r: { batches: unknown[] }) => r.batches))) as B[]
  expect(batches.map((b) => [b.status, b.items.map((i) => [i.prompt, i.refs.length])])).toEqual([1, 2, 3].map(() => ['completed', [['chân dung ông lão', expect.any(Number)]]]))
  const [r3, r2, r1] = batches // newest first
  expect([r1.items[0].refs, r2.items[0].refs.length, r3.items[0].refs.length]).toEqual([[], 1, 1])
  expect((await ledger(app)).refs).toEqual([r2.items[0].refs, r3.items[0].refs]) // rounds 2 and 3 were sent with one image each, not the same one
  expect(r2.items[0].refs[0]).not.toBe(r3.items[0].refs[0])
  const saved = (b: B) => b.items.flatMap((i) => i.attempts.flatMap((a) => Object.values(a.downloads))).filter((d) => d.state === 'completed').map((d) => basename(d.actualName!))
  await app.close()
  const db = openDb(join(ud, 'toolflow.db'))
  const path = (id: string) => basename((db.prepare('select path from asset where id=?').get(id) as { path: string }).path)
  expect([saved(r1).includes(path(r2.items[0].refs[0])), saved(r2).includes(path(r3.items[0].refs[0]))]).toEqual([true, true]) // round n's reference is a file round n-1 saved
  db.close()
})

test('Workflow: a Bảng CSV node drives a Tạo ảnh node, one prompt per row from its {Cột} template; a row with an empty used cell is named on the node', async () => {
  const { page } = await launch(tmp())
  const node = (t: string) => page.getByTestId(`wf-${t}`)
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await addNode(page, 'Bảng CSV')
  await addNode(page, 'Tạo ảnh Flow')
  await drag(page, node('csv').locator('.react-flow__handle.source'), node('generate').locator('.react-flow__handle.target'))
  await node('csv').locator('label.filebtn input').setInputFiles({ name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from('Tên,Nơi\nmèo,sân\n\nchó,nhà\n') })
  await expect(node('csv').getByLabel('Mẫu prompt của node Bảng CSV')).toHaveValue('{Tên}') // the first column until a template is written
  await expect(node('csv').getByTestId('wf-csv-info')).toHaveText('2 prompt · cột: {Tên} {Nơi}')
  await node('csv').getByLabel('Mẫu prompt của node Bảng CSV').fill('{Tên} ở {Nơi}')
  await node('generate').locator('header b').click()
  await expect(page.getByTestId('wf-preview')).toContainText('Sẽ gửi 2 prompt')
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Workflow đã chạy xong', { timeout: 60_000 })
  expect(await page.evaluate(() => window.api.listBatches().then((r: { batches: { items: { prompt: string }[] }[] }) => r.batches.map((b) => b.items.map((i) => i.prompt))))).toEqual([['mèo ở sân', 'chó ở nhà']])
  await node('csv').locator('label.filebtn input').setInputFiles({ name: 'b.csv', mimeType: 'text/csv', buffer: Buffer.from('Tên,Nơi\nmèo,\n') })
  await expect(node('csv').getByRole('alert')).toContainText('Dòng 2, cột “Nơi”: Ô này đang trống')
})

test('Workflow: + Tạo video Flow adds a node already set to video, titled so; a Vòng lặp after it is refused with its own reason', async () => {
  const { page } = await launch(tmp())
  const node = (t: string) => page.getByTestId(`wf-${t}`)
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await addNode(page, 'Text')
  await addNode(page, 'Tạo video Flow')
  await addNode(page, 'Vòng lặp')
  await expect(node('generate').locator('header b')).toHaveText('Tạo video Flow')
  await expect(node('generate').getByTestId('wf-combo')).toHaveText('Video · Veo 3.1 - Lite · 16:9 · x1')
  await node('text').getByLabel('Prompt của node Text').fill('ngọn nến cháy')
  await drag(page, node('text').locator('.react-flow__handle.source'), node('generate').locator('.react-flow__handle.target'))
  await drag(page, node('generate').locator('.react-flow__handle.source'), node('loop').locator('.react-flow__handle.target'))
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(node('loop').getByRole('alert')).toContainText('Vòng lặp chỉ dùng được sau node tạo ảnh')
  expect(await page.evaluate(() => window.api.listBatches().then((r: { batches: unknown[] }) => r.batches.length))).toBe(0)
})

type FakeGpt = { __toolflowFakeGpt: { ledger: { sends: string[]; newChats: number; opens: string[] } } }
test('ChatGPT batch: chosen in Tạo lô, sent one prompt after another, each image saved by itself; a tab moved to another chat pauses the batch and Tiếp tục reopens its conversation', async () => {
  const root = join(tmp(), 'dl')
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_DOWNLOAD_ROOT: root, TOOLFLOW_FAKE_GPT: 'leave' }) // after the first image the "user" moves the ChatGPT tab to another chat
  const ledger = () => app.evaluate(() => (globalThis as unknown as FakeGpt).__toolflowFakeGpt.ledger)
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await expect(page.getByTestId('gpt-tabs')).toContainText('Đã thấy 1 tab chatgpt.com')
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'ChatGPT (tạo ảnh)' }).check()
  await expect(page.getByTestId('combo')).toHaveText('Sẽ gửi: ChatGPT · Create image · tự động')
  await expect(page.getByTestId('gpt-note')).toContainText('cuộc trò chuyện mới')
  await expect(page.getByRole('radio', { name: 'Video', exact: true })).toHaveCount(0) // ChatGPT: images only, no Flow settings
  await expect(page.getByTestId('batch-settings')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Chọn ảnh…' })).toHaveCount(1) // reference images: yes
  await create(page, ['một con mèo', 'một con chó', 'một con chim'])
  await expect(page.getByRole('heading', { name: /ChatGPT · Ảnh/ })).toBeVisible()
  await expect(page.getByTestId('pause-reason')).toContainText('Tab ChatGPT đã chuyển sang cuộc trò chuyện khác')
  expect((await ledger()).sends).toEqual(['một con mèo']) // nothing was typed into the other chat
  await page.getByRole('button', { name: 'Tiếp tục' }).click()
  await expect(page.getByTestId('pause-reason')).toHaveCount(0)
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await expect(outputs(page).filter({ hasText: 'Đã lưu' })).toHaveCount(3, { timeout: 30_000 }) // saved without anyone pressing Tải
  await expect(outputs(page).filter({ hasText: 'ChatGPT · Ảnh' })).toHaveCount(3)
  const led = await ledger()
  expect(led.sends).toEqual(['một con mèo', 'một con chó', 'một con chim']) // each prompt once, in order
  expect(led.newChats).toBe(1)
  expect(led.opens).toHaveLength(1) // the batch's own conversation was opened again
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.png'))
  expect(files).toHaveLength(3)
  for (const f of files) expect(readFileSync(join(root, f)).subarray(1, 4).toString()).toBe('PNG')
})

test('ChatGPT batch without a ChatGPT tab: it pauses and says what to open; a Flow batch next to it still runs', async () => {
  const { page } = await launch(tmp(), '', { TOOLFLOW_FAKE_GPT_TABS: '0' })
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await expect(page.getByTestId('gpt-tabs')).toContainText('Chưa thấy tab chatgpt.com')
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'ChatGPT (tạo ảnh)' }).check()
  await create(page, ['một con mèo'])
  await expect(page.getByTestId('pause-reason')).toContainText('Chưa thấy tab ChatGPT nào')
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'Google Flow' }).check()
  await create(page, ['một con chó'])
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(1)
})

test('Gemini batch: chosen in Tạo lô, runs in the Gemini tab next to a ChatGPT batch; each image is saved by itself and shown under its own site', async () => {
  const root = join(tmp(), 'dl')
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_DOWNLOAD_ROOT: root })
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await expect(page.getByTestId('gem-tabs')).toContainText('Đã thấy 1 tab gemini.google.com')
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'Gemini (tạo ảnh)' }).check()
  await expect(page.getByTestId('combo')).toHaveText('Sẽ gửi: Gemini · Tạo hình ảnh · tự động')
  await expect(page.getByTestId('gpt-note')).toContainText('gemini.google.com')
  await expect(page.getByTestId('batch-settings')).toHaveCount(0)
  await create(page, ['một con mèo', 'một con chó'])
  await expect(page.getByRole('heading', { name: /Gemini · Ảnh/ })).toBeVisible()
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'ChatGPT (tạo ảnh)' }).check()
  await create(page, ['một con chim'])
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await expect(outputs(page).filter({ hasText: 'Gemini · Ảnh' }).filter({ hasText: 'Đã lưu' })).toHaveCount(2, { timeout: 30_000 })
  await expect(outputs(page).filter({ hasText: 'ChatGPT · Ảnh' }).filter({ hasText: 'Đã lưu' })).toHaveCount(1, { timeout: 30_000 })
  const sends = await app.evaluate(() => { const g = globalThis as unknown as Record<string, { ledger: { sends: string[] } }>; return { gem: g.__toolflowFakeGem.ledger.sends, gpt: g.__toolflowFakeGpt.ledger.sends } })
  expect(sends).toEqual({ gem: ['một con mèo', 'một con chó'], gpt: ['một con chim'] }) // each site got its own prompts, once
  expect((readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.png'))).toHaveLength(3)
})

test('Gemini batch without a Gemini tab: it pauses and names gemini.google.com', async () => {
  const { page } = await launch(tmp(), '', { TOOLFLOW_FAKE_GEM_TABS: '0' })
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'Gemini (tạo ảnh)' }).check()
  await create(page, ['một con mèo'])
  await expect(page.getByTestId('pause-reason')).toContainText('Chưa thấy tab Gemini nào. Mở gemini.google.com')
})

test('Gemini batch with an aspect ratio and reference images: both chosen in Tạo lô, each prompt sent with its own image and the ratio; a ChatGPT batch takes the images too', async () => {
  const { list } = pngs(['a.png', 'b.png'])
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_PICK_REFS: list })
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'Gemini (tạo ảnh)' }).check()
  await page.getByTestId('gem-aspect').selectOption('9:16')
  await page.getByTestId('gem-model').selectOption('Pro')
  await expect(page.getByTestId('combo')).toHaveText('Sẽ gửi: Gemini · Tạo hình ảnh · Pro · 9:16 · tự động')
  await page.getByLabel('Danh sách prompt').fill('một con mèo\nmột con chó')
  await page.getByRole('button', { name: 'Chọn ảnh…' }).click()
  await expect(page.getByTestId('pool').locator('li')).toHaveCount(2)
  await page.getByLabel('Mỗi prompt một nhóm ảnh theo thứ tự').check()
  await expect(row(page, 0)).toContainText('a.png')
  await expect(row(page, 1)).toContainText('b.png')
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await expect(outputs(page).filter({ hasText: 'Gemini · Ảnh' }).filter({ hasText: 'Đã lưu' })).toHaveCount(2, { timeout: 30_000 })
  const l = await app.evaluate(() => (globalThis as unknown as { __toolflowFakeGem: { ledger: { aspects: (string | null)[]; models: (string | null)[]; refs: string[][]; attached: { bytes: number; clear: boolean }[] } } }).__toolflowFakeGem.ledger)
  expect(l.aspects).toEqual(['9:16', '9:16'])
  expect(l.models).toEqual(['Pro', 'Pro'])
  expect(l.refs).toEqual([['ref-1.png'], ['ref-1.png']]) // one image each, the second prompt's own
  expect(l.attached.map((x) => x.clear)).toEqual([true, true])
  expect(l.attached.every((x) => x.bytes > 0)).toBe(true)
  // ChatGPT: the same images, no ratio menu
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'ChatGPT (tạo ảnh)' }).check()
  await expect(page.getByTestId('gem-aspect')).toHaveCount(0)
  await page.getByLabel('Danh sách prompt').fill('một con chim')
  await page.getByLabel('Dùng chung tất cả ảnh cho mọi prompt').check()
  await page.getByLabel('Số ảnh tham chiếu mỗi prompt').fill('2')
  await expect(row(page, 0)).toContainText('a.png, b.png')
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await expect(outputs(page).filter({ hasText: 'ChatGPT · Ảnh' }).filter({ hasText: 'Đã lưu' })).toHaveCount(1, { timeout: 30_000 })
  expect(await app.evaluate(() => (globalThis as unknown as { __toolflowFakeGpt: { ledger: { refs: string[][] } } }).__toolflowFakeGpt.ledger.refs)).toEqual([['ref-1.png', 'ref-2.png']])
})

test('Workflow: a Tạo ảnh node sent to Gemini (with a ratio) feeds one sent to ChatGPT; each site gets its prompt once, the second with the first one\'s image', async () => {
  const root = join(tmp(), 'dl')
  const { app, page } = await launch(tmp(), '', { TOOLFLOW_DOWNLOAD_ROOT: root })
  const node = (t: string) => page.getByTestId(`wf-${t}`), site = page.getByTestId('wf-site')
  const wire = (from: ReturnType<typeof node>, to: ReturnType<typeof node>) => drag(page, from.locator('.react-flow__handle.source'), to.locator('.react-flow__handle.target'))
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('button', { name: /Tạo chuỗi mẫu/ }).click()
  await node('text').getByLabel('Prompt của node Text').fill('nhân vật A')
  await addNode(page, 'Tạo ảnh Flow')
  await addNode(page, 'Text')
  await node('text').nth(1).getByLabel('Prompt của node Text').fill('nhân vật A đứng trên cầu')
  await wire(node('generate').nth(0), node('generate').nth(1))
  await wire(node('text').nth(1), node('generate').nth(1))
  await wire(node('generate').nth(1), node('download'))
  await node('generate').nth(0).locator('header b').click()
  await site.getByLabel('Nền tảng').selectOption('gemini')
  await site.getByLabel('Tỉ lệ khung hình').selectOption('9:16')
  await site.getByLabel('Mô hình').selectOption('Flash')
  await expect(node('generate').nth(0).getByTestId('wf-combo')).toHaveText('Gemini · Tạo hình ảnh · Flash · 9:16')
  await expect(page.getByTestId('wf-settings')).toHaveCount(0) // no Flow settings on a site node
  await expect(page.getByTestId('wf-preview')).toContainText('Mỗi prompt tạo 1 ảnh, tổng cộng 1 ảnh')
  await page.keyboard.press('Escape') // closes the form floating under the node, which may cover the next one
  await expect(page.getByTestId('wf-preview')).toHaveCount(0)
  await node('generate').nth(1).locator('header b').click()
  await site.getByLabel('Nền tảng').selectOption('chatgpt')
  await expect(node('generate').nth(1).getByTestId('wf-combo')).toHaveText('ChatGPT · Create image')
  await expect(node('generate').nth(1).locator('header b')).toHaveText('Tạo ảnh ChatGPT') // the node says where it sends
  await expect(node('generate').nth(0).locator('header b')).toHaveText('Tạo ảnh Gemini')
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-status')).toHaveText('Workflow đã chạy xong', { timeout: 60_000 })
  const l = await app.evaluate(() => { const g = globalThis as unknown as Record<string, { ledger: { sends: string[]; refs: string[][]; aspects: (string | null)[]; models: (string | null)[] } }>; return { gem: g.__toolflowFakeGem.ledger, gpt: g.__toolflowFakeGpt.ledger, flow: (g.__toolflowFake as unknown as { clicks: number }).clicks } })
  expect([l.gem.sends, l.gem.aspects, l.gem.models, l.gem.refs]).toEqual([['nhân vật A'], ['9:16'], ['Flash'], [[]]])
  expect([l.gpt.sends, l.gpt.refs]).toEqual([['nhân vật A đứng trên cầu'], [['ref-1.png']]])
  expect(l.flow).toBe(0) // nothing went to Flow
  expect((readdirSync(root, { recursive: true }) as string[]).filter((f) => String(f).endsWith('.png'))).toHaveLength(2)
})

test('Kết quả: filters by save state, site, kind and tag combine with the search; select all / none; tags added and removed; Xoá asks first and sends the saved file to the Recycle Bin; Xuất file copies the files with a CSV', async () => {
  const ud = tmp(), root = join(tmp(), 'dl'), exp = join(tmp(), 'xuat')
  const { page } = await launch(ud, '', { TOOLFLOW_DOWNLOAD_ROOT: root, TOOLFLOW_EXPORT_DIR: exp })
  await create(page, ['một con mèo', 'một con chó', 'một con cá'])
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(3)
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'ChatGPT (tạo ảnh)' }).check()
  await create(page, ['một con chim'])
  await page.getByRole('button', { name: 'Kết quả', exact: true }).click()
  await expect(outputs(page).filter({ hasText: 'ChatGPT · Ảnh' }).filter({ hasText: 'Đã lưu' })).toHaveCount(1, { timeout: 30_000 }) // a chat site saves by itself
  await expect(outputs(page)).toHaveCount(4)
  const save = page.getByLabel('Lọc theo trạng thái lưu'), site = page.getByLabel('Lọc theo nền tảng'), kind = page.getByLabel('Lọc theo loại'), tag = page.getByLabel('Lọc theo thẻ')
  await save.selectOption('unsaved')
  await expect(outputs(page)).toHaveCount(3)
  await expect(page.getByText('0/3', { exact: true })).toBeVisible() // the count line follows the filter
  await save.selectOption('saved')
  await expect(outputs(page)).toHaveCount(1)
  await save.selectOption('')
  await site.selectOption('flow')
  await expect(outputs(page)).toHaveCount(3)
  await page.getByLabel('Tìm prompt hoặc lô').fill('mèo')
  await expect(outputs(page)).toHaveCount(1)
  await page.getByLabel('Tìm prompt hoặc lô').fill('')
  await kind.selectOption('video')
  await expect(page.getByText('Không có kết quả nào khớp bộ lọc đang chọn.')).toBeVisible()
  await kind.selectOption('')
  await page.getByRole('button', { name: 'Tải tất cả kết quả' }).click()
  await expect(outputs(page).filter({ hasText: 'Đã lưu' })).toHaveCount(3)
  // select all = every card the filter shows; tag them
  await page.getByRole('button', { name: 'Chọn tất cả' }).click()
  await expect(page.getByTestId('picked')).toHaveText('Đã chọn 3')
  await page.getByLabel('Tên thẻ').fill('  bìa sách ')
  await page.getByRole('button', { name: 'Gắn thẻ' }).click()
  await expect(outputs(page).filter({ has: page.getByTestId('tags').filter({ hasText: 'bìa sách' }) })).toHaveCount(3)
  await page.getByRole('button', { name: 'Bỏ chọn' }).click()
  await expect(page.getByTestId('picked')).toHaveText('Đã chọn 0')
  await site.selectOption('')
  await tag.selectOption('bìa sách')
  await expect(outputs(page)).toHaveCount(3)
  await outputs(page).filter({ hasText: 'một con cá' }).getByLabel('Chọn kết quả này').check()
  await page.getByLabel('Tên thẻ').fill('bìa sách')
  await page.getByRole('button', { name: 'Gỡ thẻ' }).click()
  await expect(outputs(page)).toHaveCount(2)
  await tag.selectOption('')
  await expect(outputs(page)).toHaveCount(4)
  await expect(page.getByTestId('picked')).toHaveText('Đã chọn 1') // the fish stays picked across filters
  await page.getByRole('button', { name: 'Bỏ chọn' }).click()
  // Xoá: asked first; Huỷ keeps everything
  await outputs(page).filter({ hasText: 'một con mèo' }).getByLabel('Chọn kết quả này').check()
  await page.getByRole('button', { name: 'Xoá 1 kết quả' }).click()
  await page.getByRole('button', { name: 'Huỷ' }).click()
  await expect(outputs(page)).toHaveCount(4)
  expect(pngFiles(root)).toHaveLength(4)
  await page.getByRole('button', { name: 'Xoá 1 kết quả' }).click()
  await page.getByRole('button', { name: 'Có, xoá' }).click()
  await expect(page.locator('section[aria-label="Kết quả"]').getByRole('status')).toHaveText('Đã xoá 1 kết quả khỏi màn này: 1 tệp đã vào Thùng rác.')
  await expect(outputs(page)).toHaveCount(3)
  await expect(outputs(page).filter({ hasText: 'một con mèo' })).toHaveCount(0)
  expect(pngFiles(root)).toHaveLength(3)
  expect(readdirSync(join(ud, 'fake-trash')).filter((f) => f.endsWith('.png'))).toHaveLength(1) // the test build's Recycle Bin
  await expect(page.getByRole('button', { name: 'Tải tất cả kết quả' })).toBeDisabled() // nothing left to save: the deleted one is not offered again
  // Xuất file with nothing picked: everything the filter shows
  await site.selectOption('flow')
  await page.getByRole('button', { name: 'Xuất file' }).click()
  await expect(page.locator('section[aria-label="Kết quả"]').getByRole('status')).toHaveText('Đã xuất 2 tệp và toolflow-export.csv.')
  const files = readdirSync(exp).sort()
  expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(2)
  const csv = readFileSync(join(exp, 'toolflow-export.csv'))
  expect(csv.subarray(0, 3).toString('hex')).toBe('efbbbf')
  expect(csv.toString('utf8')).toContain('"một con chó","Flow","Ảnh"')
  expect(csv.toString('utf8')).toContain('"bìa sách"')
  expect(csv.toString('utf8')).not.toContain('một con mèo')
})

test('Sao lưu / khôi phục in Cài đặt: the backup is one valid SQLite file with the settings; a wrong file is refused inline; refused while a prompt is being sent; a good one is staged, the app restarts and comes back with the old data and settings', async () => {
  const ud = tmp(), bak = join(tmp(), 'sao-luu.db'), good = join(tmp(), 'good.db')
  let { app, page } = await launch(ud, '', { TOOLFLOW_BACKUP_FILE: bak })
  await create(page, ['một con mèo'])
  await expect(items(page).filter({ hasText: 'Có kết quả' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  const fast = page.getByLabel('Nhanh', { exact: true })
  await fast.click()
  await expect(fast).toBeChecked()
  const box = page.getByRole('group', { name: 'Sao lưu', exact: true })
  await box.getByRole('button', { name: 'Sao lưu dữ liệu' }).click()
  await expect(box.getByRole('status')).toHaveText('Đã sao lưu vào tệp sao-luu.db')
  const b = new Database(bak, { readonly: true })
  expect(b.prepare('select count(*) n from batch').get()).toEqual({ n: 1 })
  expect(JSON.parse((b.prepare("select value v from toolflow_backup where key='draft'").get() as { v: string }).v)).toMatchObject({ speed: 'fast' })
  b.close()
  copyFileSync(bak, good)
  writeFileSync(bak, 'không phải sqlite'.repeat(50))
  await box.getByRole('button', { name: 'Khôi phục từ bản sao lưu' }).click()
  await expect(box.getByRole('alert')).toContainText('không phải bản sao lưu ToolFlow')
  expect(existsSync(join(ud, 'restore.db'))).toBe(false)
  copyFileSync(good, bak)
  // a prompt waiting for the user's Gửi is in flight: no restore
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByLabel('Thủ công (bạn bấm Gửi trong Flow)').check()
  await page.getByLabel('Danh sách prompt').fill('một con chó')
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await expect(items(page).filter({ hasText: /Chờ bạn|bấm Gửi/ })).toHaveCount(1, { timeout: 10_000 })
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  await box.getByRole('button', { name: 'Khôi phục từ bản sao lưu' }).click()
  await expect(box.getByRole('alert')).toContainText('Đang có lượt đang gửi')
  expect(existsSync(join(ud, 'restore.db'))).toBe(false)
  await page.getByRole('button', { name: 'Hàng đợi' }).click()
  await page.getByRole('button', { name: 'Dừng', exact: true }).click()
  await expect(items(page).filter({ hasText: /Chờ bạn|bấm Gửi/ })).toHaveCount(0, { timeout: 10_000 })
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  const normal = page.getByLabel('Mặc định', { exact: true })
  await normal.click()
  await expect(normal).toBeChecked()
  await box.getByRole('button', { name: 'Khôi phục từ bản sao lưu' }).click()
  await expect(box.getByRole('status')).toContainText('App đang tự đóng và mở lại')
  expect(existsSync(join(ud, 'restore.db'))).toBe(true)
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __toolflowRestarts?: number }).__toolflowRestarts)).toBe(1) // the test build only counts the relaunch
  await app.close()
  ;({ app, page } = await launch(ud))
  await page.getByRole('button', { name: 'Hàng đợi' }).click()
  await expect(items(page).filter({ hasText: 'một con mèo' })).toHaveCount(1)
  await expect(items(page).filter({ hasText: 'một con chó' })).toHaveCount(0) // made after the backup
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  await expect(page.getByLabel('Nhanh', { exact: true })).toBeChecked() // the settings came back too
  const left = readdirSync(ud)
  expect(left).not.toContain('restore.db')
  expect(left.filter((f) => f.startsWith('toolflow.db.before-restore-') && !/-(wal|shm)$/.test(f))).toHaveLength(1) // the data before the restore is kept
})

test('Kết nối: the chosen tab is remembered by account + project; after a restart it is chosen again by itself (Tự chọn lại) and an unfinished batch goes on; Quên các tab đã nhớ stops that', async () => {
  const ud = tmp()
  let { app, page } = await launch(ud, '', { TOOLFLOW_FAKE_GRANT: '0' })
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await page.getByRole('button', { name: 'Dùng tab này' }).click()
  await expect(page.getByText('Đang dùng', { exact: true })).toBeVisible()
  await expect(page.getByText('Tự chọn lại', { exact: true })).toHaveCount(0) // the user's own click
  await expect(page.getByRole('button', { name: 'Quên các tab đã nhớ' })).toBeVisible()
  await create(page, ['một con mèo'])
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(1)
  await app.close()
  const db = openDb(join(ud, 'toolflow.db')) // the app was closed with a batch still running: two prompts not sent yet
  const done = db.prepare('select target_project p, settings_json s from batch').get() as { p: string; s: string }
  const { batchId } = enqueueBatch(db, { commandId: 'left', kind: 'image', projectId: done.p, settings: JSON.parse(done.s), prompts: ['dở một', 'dở hai'], refs: [[], []], mode: 'auto' })
  db.prepare("update batch set status='running' where id=?").run(batchId)
  db.close()
  ;({ app, page } = await launch(ud, '', { TOOLFLOW_FAKE_GRANT: '0' })) // Chrome and the app restarted: nobody clicks anything
  await page.getByRole('button', { name: 'Hàng đợi' }).click()
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(3, { timeout: 20_000 })
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await expect(page.getByText('Đang dùng', { exact: true })).toBeVisible()
  await expect(page.getByText('Tự chọn lại', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Quên các tab đã nhớ' }).click()
  await expect(page.getByRole('button', { name: 'Quên các tab đã nhớ' })).toHaveCount(0)
  await app.close()
  ;({ app, page } = await launch(ud, '', { TOOLFLOW_FAKE_GRANT: '0' }))
  await page.waitForTimeout(6000) // longer than one round of the main-process loop
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await expect(page.getByRole('button', { name: 'Dùng tab này' })).toBeVisible()
  await expect(page.getByText('Đang dùng', { exact: true })).toHaveCount(0)
})

test('Kết nối: the setup panel ticks what is done and opens Chrome on the extensions page or Flow (the app starts Chrome, not the page); without Chrome it says so inline', async () => {
  let { app, page } = await launch(tmp(), '', { TOOLFLOW_FAKE_CONNECTED: '0' })
  await page.getByRole('button', { name: 'Kết nối' }).click()
  const step = (name: string) => page.getByRole('list', { name: 'Các bước kết nối' }).locator('li').filter({ hasText: name })
  await expect(step('Chrome tìm thấy')).toHaveAttribute('data-done', 'true')
  await expect(step('Extension đã nối')).toHaveAttribute('data-done', 'false')
  await expect(step('Có tab Flow')).toHaveAttribute('data-done', 'true')
  await expect(step('Đã mở dự án')).toHaveAttribute('data-done', 'true')
  await expect(step('Đã chọn tab')).toHaveAttribute('data-done', 'true')
  await page.getByRole('button', { name: 'Mở trang tiện ích trong Chrome' }).click()
  await page.getByRole('button', { name: 'Mở Google Flow' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __toolflowChrome: string[] }).__toolflowChrome)).toEqual(['chrome://extensions', 'https://labs.google/fx/tools/flow'])
  await expect(page.getByRole('alert')).toHaveCount(0)
  await app.close()
  ;({ app, page } = await launch(tmp(), '', { TOOLFLOW_FAKE_CONNECTED: '0', TOOLFLOW_FAKE_CHROME: '0' }))
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await expect(step('Chrome tìm thấy')).toHaveAttribute('data-done', 'false')
  await page.getByRole('button', { name: 'Mở Google Flow' }).click()
  await expect(page.getByRole('alert')).toContainText('Không tìm thấy Google Chrome')
  expect(await app.evaluate(() => (globalThis as unknown as { __toolflowChrome: string[] }).__toolflowChrome)).toEqual([])
})

// ---- notices, Hẹn giờ chạy, tray, credit ----
const TG_TOKEN = '123456789:AAFakeFakeFakeFakeFakeFakeFakeFake_x'
/** A local stand-in for api.telegram.org (the app reaches it through TOOLFLOW_TELEGRAM_API): one /start waiting, every sendMessage recorded. */
async function fakeTelegram(): Promise<{ url: string; sent: string[]; close(): void }> {
  const sent: string[] = []
  const s = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop()
      if (method === 'sendMessage') sent.push(JSON.parse(raw).text)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [{ update_id: 1, message: { message_id: 1, chat: { id: 77, type: 'private' }, text: '/start' } }] : true }))
    })
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, sent, close: () => s.close() }
}
const bell = (page: Page) => page.getByRole('button', { name: /^Thông báo/ })
const notices = (page: Page) => page.getByTestId('notice')

test('notices: a finished batch rings the bell and the Telegram bot gets a content-free message (never the prompt); the token never comes back to the screen', async () => {
  const tg = await fakeTelegram()
  try {
    const { page } = await launch(tmp(), '', { TOOLFLOW_TELEGRAM_API: tg.url })
    await expect(bell(page)).toHaveAccessibleName('Thông báo')
    await page.getByRole('button', { name: 'Cài đặt' }).click()
    await expect(page.getByTestId('tg-state')).toHaveText('Telegram: chưa có mã bot')
    await page.getByLabel('Mã bot Telegram').fill('không phải mã')
    await page.getByRole('button', { name: 'Lưu mã' }).click()
    await expect(page.getByRole('alert')).toContainText('Mã bot không đúng')
    await page.getByLabel('Mã bot Telegram').fill(TG_TOKEN)
    await page.getByRole('button', { name: 'Lưu mã' }).click()
    await expect(page.getByTestId('tg-state')).toHaveText('Telegram: đã có mã bot, chưa kết nối')
    await expect(page.getByLabel('Mã bot Telegram')).toHaveValue('')
    await page.getByRole('button', { name: 'Kết nối Telegram' }).click()
    await expect(page.getByTestId('tg-state')).toHaveText('Telegram: đã kết nối')
    await page.getByRole('button', { name: 'Gửi tin thử' }).click()
    await expect.poll(() => tg.sent.length).toBe(1)
    const secret = 'con mèo bí mật 4711'
    await create(page, [secret])
    await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(1)
    await expect(bell(page)).toHaveAccessibleName('Thông báo (1 chưa đọc)')
    await expect.poll(() => tg.sent.length).toBe(2)
    expect(tg.sent[1]).toMatch(/^Lô [0-9a-f]{8} đã xong\nFlow · Ảnh · 1\/1 có kết quả · 0 lỗi$/)
    for (const m of tg.sent) expect(m).not.toContain(secret)
    await bell(page).click()
    await expect(notices(page)).toHaveCount(1)
    await expect(notices(page).first()).toContainText('đã xong')
    await page.getByRole('button', { name: 'Đánh dấu đã đọc' }).click()
    await expect(bell(page)).toHaveAccessibleName('Thông báo')
    expect(await page.content()).not.toContain(TG_TOKEN.split(':')[1])
    expect(JSON.stringify(await page.evaluate(() => (window as unknown as { api: { getTelegram(): Promise<unknown> } }).api.getTelegram()))).toBe('{"configured":true,"linked":true}')
  } finally { tg.close() }
})

const pad = (n: number): string => String(n).padStart(2, '0')
test('Hẹn giờ chạy: the queue shows the time with Huỷ hẹn giờ, then the batch starts by itself at that time and the bell says so', async () => {
  const { app, page } = await launch(tmp())
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByLabel('Danh sách prompt').fill('một con mèo hẹn giờ')
  await expect(page.locator('[data-testid=preview] tbody tr')).toHaveCount(1)
  await page.getByLabel('Hẹn giờ chạy').check()
  await expect(page.getByRole('button', { name: 'Tạo lô và hẹn giờ' })).toBeDisabled() // no time picked yet
  const now = await app.evaluate(() => (globalThis as unknown as { __toolflowClock: { now(): number } }).__toolflowClock.now())
  const at = new Date(Math.ceil(now / 60_000) * 60_000 + 6 * 60_000) // whole minutes (the field has none smaller); the test clock runs 30x: 12-14 s from now
  await page.getByLabel('Giờ chạy', { exact: true }).fill(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`)
  await page.getByRole('button', { name: 'Tạo lô và hẹn giờ' }).click()
  await expect(page.getByTestId('schedule')).toContainText(`Hẹn chạy lúc ${pad(at.getHours())}:${pad(at.getMinutes())}`)
  await expect(page.getByRole('button', { name: 'Huỷ hẹn giờ' })).toBeVisible()
  await expect(items(page)).toHaveCount(1)
  await expect(items(page).first()).toContainText('Đang chờ')
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(1, { timeout: 40_000 })
  await expect(page.getByTestId('schedule')).toHaveCount(0)
  await bell(page).click()
  await expect(notices(page).filter({ hasText: 'đã bắt đầu theo hẹn giờ' })).toHaveCount(1)
  await expect(notices(page).filter({ hasText: 'đã bắt đầu theo hẹn giờ' })).toContainText(`hẹn lúc ${pad(at.getHours())}:${pad(at.getMinutes())}`)
})

test('tray: closing the window hides it and the app keeps running (a second launch shows it again); Tự mở cùng Windows is recorded, never written to the registry in a test; app.close() still quits', async () => {
  const dir = tmp()
  const { app, page } = await launch(dir)
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  await expect(page.getByLabel('Đóng cửa sổ thì thu xuống khay (lịch vẫn chạy)')).toBeChecked()
  const login = page.getByLabel('Tự mở cùng Windows')
  await expect(login).not.toBeChecked()
  await login.click()
  await expect(login).toBeChecked()
  expect(await app.evaluate(() => (globalThis as unknown as { __toolflowLoginItem?: unknown[] }).__toolflowLoginItem)).toEqual([{ openAtLogin: true, args: ['--hidden'] }])
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false])
  expect(app.process().exitCode).toBeNull()
  const env = { ...process.env, TOOLFLOW_FAKE_DRIVER: '1', TOOLFLOW_E2E: '1', TOOLFLOW_USER_DATA: dir } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const b = spawn(electronPath as unknown as string, ['--no-sandbox', '.'], { cwd: desktop, env, stdio: 'ignore' })
  expect(await new Promise((r) => { b.on('exit', r); setTimeout(() => { b.kill(); r('timeout') }, 20_000) })).not.toBe('timeout')
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([true])
  const proc = app.process()
  await app.close()
  expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true)
})

test('credit: Flow\'s balance shows in Kết nối with its time; falling under the threshold raises one notice, not one per answer', async () => {
  const { page } = await launch(tmp(), 'video-ok,video-ok')
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  const th = page.getByLabel('Cảnh báo khi credit dưới')
  await expect(th).toHaveValue('50')
  await th.fill('1000') // the fake Flow reports 958 with each video receipt, then 948 in its poll
  await expect.poll(() => page.evaluate(() => (window as unknown as { api: { listBatches(): Promise<{ session: { draft: { creditWarn: number } } }> } }).api.listBatches().then((r) => r.session.draft.creditWarn))).toBe(1000)
  await page.getByRole('button', { name: 'Tạo lô', exact: true }).click()
  await page.getByRole('radio', { name: 'Video', exact: true }).check()
  await create(page, ['video một', 'video hai'])
  await expect(items(page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(2)
  await page.getByRole('button', { name: 'Kết nối' }).click()
  await expect(page.getByTestId('credits')).toHaveText(/^Credit Flow còn: 9[45]8, đọc lúc \d\d:\d\d$/)
  await bell(page).click()
  await expect(notices(page).filter({ hasText: 'Credit Flow sắp hết' })).toHaveCount(1)
  await expect(notices(page).filter({ hasText: 'Credit Flow sắp hết' })).toContainText('dưới mức cảnh báo 1000')
})

test('Google sign-in: nothing of the app opens before an active plan; a new account waits with the buy text, sign-out locks again', async () => {
  const { page } = await launch(tmp(), '', { TOOLFLOW_FAKE_LICENSE: 'signed_out', TOOLFLOW_FAKE_LICENSE_AFTER: 'pending' })
  await expect(page.getByRole('button', { name: 'Tạo lô', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.api.listBatches().then(() => 'open', (e: Error) => e.message))).toContain('LICENSE_REQUIRED') // main refuses too, not only the screen
  await page.getByRole('button', { name: 'Đăng nhập bằng Google' }).click()
  await expect(page.getByText('đã đăng ký nhưng chưa có gói')).toBeVisible()
  await expect(page.getByLabel('Cách mua gói')).toContainText('Liên hệ để mua gói')
  await page.getByRole('button', { name: 'Đăng xuất' }).click()
  await expect(page.getByRole('button', { name: 'Đăng nhập bằng Google' })).toBeVisible()

  const b = await launch(tmp(), '', { TOOLFLOW_FAKE_LICENSE: 'signed_out' }) // this account has bought a plan
  await b.page.getByRole('button', { name: 'Đăng nhập bằng Google' }).click()
  await b.page.getByRole('button', { name: 'Cài đặt', exact: true }).click()
  await expect(b.page.getByRole('group', { name: 'Tài khoản' })).toContainText('fake@example.invalid')
  await b.page.getByRole('button', { name: 'Đăng xuất' }).click()
  await expect(b.page.getByRole('button', { name: 'Đăng nhập bằng Google' })).toBeVisible()
  await expect(b.page.getByRole('button', { name: 'Cài đặt', exact: true })).toHaveCount(0)
})

test('the app opens on Tổng quan, whose numbers follow the batches', async () => {
  const { page } = await launch(tmp(), 'image-ok,blocked,image-ok', { TOOLFLOW_FAKE_LICENSE: 'active' }) // FAKE_LICENSE: launch() leaves the first screen as it opened
  const ov = page.getByRole('region', { name: 'Tổng quan' })
  await expect(page.getByRole('button', { name: 'Tổng quan', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(ov.getByText('Chưa có lô nào.')).toBeVisible()
  await ov.getByRole('button', { name: 'Tạo lô đầu tiên' }).click()
  await expect(async () => { // the form loads its saved draft right after it opens; fill again if that wiped the text
    await page.getByLabel('Danh sách prompt').fill('một\nhai\nba')
    await expect(page.getByText('3 prompt')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Tạo lô và chạy' }).click()
  await expect(page.getByRole('heading', { name: /Xong một phần/ })).toBeVisible({ timeout: 20_000 }) // 'blocked': Flow refuses row 2, rows 1 and 3 get results
  await page.getByRole('button', { name: 'Tổng quan', exact: true }).click()
  await expect(ov.getByRole('row')).toHaveCount(2) // header + the batch
  await expect(ov.getByText('Tỉ lệ thành công')).toHaveCount(0)
  await expect(ov.getByText('Cần bạn xem').locator('..').getByText('1', { exact: true })).toBeVisible()
  await expect(ov.getByRole('listitem')).toHaveCount(1)
  await page.getByRole('button', { name: 'Lô mới' }).first().click()
  await expect(page.getByLabel('Danh sách prompt')).toBeVisible()
})
