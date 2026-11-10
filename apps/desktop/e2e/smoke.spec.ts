import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  await tabTo(page, 'Số ảnh mỗi prompt')
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
  expect(await bg(page)).toBe('rgb(255, 255, 255)')
  await page.emulateMedia({ colorScheme: 'dark' }) // system follows the OS
  expect(await bg(page)).toBe('rgb(20, 20, 20)')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByRole('button', { name: 'Chuyển sang giao diện tối' }).click()
  expect(await bg(page)).toBe('rgb(20, 20, 20)')
  await page.getByRole('button', { name: 'Cài đặt' }).click()
  await expect(page.getByLabel('Tối', { exact: true })).toBeChecked()
  await page.getByLabel('Sáng', { exact: true }).check()
  expect(await bg(page)).toBe('rgb(255, 255, 255)')
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
  await expect.poll(() => installs(app)).toBe(1)
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
  const wire = async (from: ReturnType<typeof node>, to: ReturnType<typeof node>) => { await from.locator('.react-flow__handle.source').click(); await to.locator('.react-flow__handle.target').click() }
  await page.getByRole('button', { name: 'Workflow', exact: true }).click()
  await page.getByRole('button', { name: /Tạo chuỗi mẫu/ }).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await node('text').getByLabel('Prompt của node Text').fill('nhân vật A')
  await page.getByRole('button', { name: '+ Tạo ảnh Flow' }).click()
  await page.getByRole('button', { name: '+ Text' }).click()
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
  await page.getByRole('button', { name: '+ Tạo ảnh Flow' }).click()
  await page.getByRole('button', { name: 'Chạy workflow' }).click()
  await expect(page.getByTestId('wf-generate').getByRole('alert')).toContainText('Node này chưa có prompt')
  expect(await page.evaluate(() => window.api.listBatches().then((r: { batches: unknown[] }) => r.batches.length))).toBe(0)
  await page.getByTestId('wf-generate').getByRole('button', { name: 'Xoá node Tạo ảnh Flow' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
})

// ---- downloads (AC-07, AC-15, AC-16, AC-26) ----
// '/'-separated like the names the app shows: readdir gives '\\' on Windows
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

test('m5: a failed download shows an inline alert, never window.alert', async () => {
  const dir = tmp()
  const first = await launch(dir)
  await create(first.page, ['một con mèo'])
  await expect(items(first.page).filter({ hasText: 'Có kết quả (chưa tải)' })).toHaveCount(1)
  await first.app.close()
  const { page } = await launch(dir, '', { TOOLFLOW_FAKE_GRANT: '0' }) // no granted tab: downloadBatch rejects with NO_PROJECT_TAB
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
