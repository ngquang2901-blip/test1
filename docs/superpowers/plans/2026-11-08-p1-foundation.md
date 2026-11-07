# P1 — Nền móng ToolFlow: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App desktop chạy được một lô prompt từ đầu tới cuối với **fake driver** (không đụng Flow thật): nhập lô, xếp hàng, chạy song song có trần, ghi journal, lượt "không rõ" + đối soát 10 phút, khôi phục sau crash, gửi tay, và extension thật nối được vào app.

**Architecture:** Monorepo npm workspaces. `apps/desktop` (Electron + React, scaffold electron-vite) giữ runner, journal SQLite, WS server; `apps/extension` (MV3) chỉ thực thi lệnh trong danh sách cố định; `packages/flow-protocol` (đã có) là máy trạng thái + parser dùng chung. Runner là vòng `tick()` thuần, nhận `clock` và `driver` từ ngoài, nên test chạy không cần timer thật hay Flow thật.

**Tech Stack:** Electron 45, electron-vite 6, React + TypeScript, better-sqlite3, vitest (chạy bằng Node của Electron), Playwright `_electron` cho smoke UI.

**Spec:** [design doc](../specs/2026-11-08-toolflow-design.md) (đã duyệt, D-22) + [docs/app](../../app/README.md). Plan dẫn chiếu, không chép lại.

## Global Constraints

- Không bao giờ tự gửi lại một attempt sau `intent_recorded`, trừ ngoại lệ throttle đã có trong `attempt.mjs` (`rejected` + `resubmitDelay`). Mọi bấm Gửi đi qua `canClick()`.
- Intent phải **commit xong** trong SQLite rồi mới được gọi `driver.click`.
- Trần song song: `default {tabs:1, video:8, image:12}`, `fast {tabs:4, video:20, image:30}` (D-18). Throttle → `floor(cur/2)` (tối thiểu 1); mỗi receipt OK → `+1` tới trần.
- Nhịp từng tab: ảnh gửi lượt kế khi lượt trước đã `sent`; video khi lượt trước đã có receipt.
- Mỗi lô một loại `image` | `video` (D-20). Một lô được cấp lượt gửi tại một thời điểm (D-04).
- Lượt không rõ: chặn project (`target_block`), `reconcileAt = t + 600_000` ms; cửa sổ khớp `[click − 5_000, click + 120_000]`; không tìm thấy → lô đứng chờ người dùng (D-21); luôn `creditSpent=true`.
- Auto mặc định tắt cho mọi tài khoản (D-19); email không đọc được ⇒ coi là tài khoản lạ ⇒ auto tắt.
- WS chỉ bind `127.0.0.1`; nhận kết nối khi đúng `Origin: chrome-extension://<EXT_ID>` **và** đúng token; kết nối mới nhất thắng, lệnh epoch cũ bị từ chối.
- Không lưu URL có chữ ký, cookie, token reCAPTCHA vào DB/log.
- Prompt giữ **nguyên văn** từng byte sau khi decode UTF-8 (không chuẩn hoá Unicode, không trim bên trong).
- Giao diện tiếng Việt. Chạy được trên Linux và Windows.
- Node dev ≥ 22 (npm 12 đòi). Test chạy bằng `ELECTRON_RUN_AS_NODE=1 electron` để better-sqlite3 dùng đúng ABI.
- Git: nhánh local `p1-foundation`, mỗi task một commit, **không push** (O-07). Cuối phase merge `--no-ff` vào `main`.

## Review Focus

1. Prompt tiếng Việt dạng NFD (dấu tách rời) và NFC lẫn trong cùng file → giữ nguyên dạng gốc, hai dòng khác dạng không bị coi là trùng. → Task 3, `parsePrompts keeps NFD and NFC as-is`.
2. App bị kill **giữa** lúc commit intent và lúc bấm → mở lại thấy lượt "không rõ", 0 lần bấm thêm. → Task 6, `crash after intent commit, before click`.
3. Ổ đĩa đầy / SQLite từ chối ghi intent → không bấm, lô pause với lỗi rõ. → Task 2 + Task 5, `intent write failure blocks click`.
4. Hai prompt giống hệt nhau trong cùng lô, cả hai rơi vào không rõ → đối soát ra `ambiguous` cho cả hai, không gán chéo. → Task 6, `duplicate prompts both uncertain`.
5. Extension mất kết nối đúng lúc đang bấm → lệnh trả lỗi kết nối được coi là **có thể đã bấm** (không rõ), không phải "chưa gửi". → Task 5, `connector drop during click is uncertain`.

---

## File Structure

```text
package.json                         workspaces: packages/*, apps/*
packages/flow-protocol/
  src/attempt.mjs                    + manual path (Task 7)
  src/index.d.ts                     types cho TS (Task 1)
apps/desktop/                        electron-vite react-ts
  electron.vite.config.ts
  vitest.config.ts
  src/main/index.ts                  lifecycle, single-instance, wiring
  src/main/db.ts                     openDb, migrations
  src/main/journal.ts                applyEvent: attempt.mjs + transaction + journal_event
  src/main/batch.ts                  parsePrompts, mapRefs, enqueueBatch
  src/main/driver.ts                 interface FlowDriver + types
  src/main/fake-driver.ts            fake driver + call ledger
  src/main/caps.ts                   CAPS, nextCap
  src/main/runner.ts                 createRunner
  src/main/reconcile.ts              lịch đối soát + gọi flow-protocol reconcile
  src/main/connector/server.ts       WS server, token, origin, epoch
  src/main/connector/pairing.ts      cài extension vào userData, pair.json
  src/main/connector/ext-driver.ts   FlowDriver nói chuyện qua WS (P1: chỉ các lệnh đọc + ping)
  src/main/profile.ts                đọc profiles/flow.json, selfCheck
  src/main/account.ts                công tắc auto theo email
  src/main/ipc.ts                    command handlers (03 §3)
  src/preload/index.ts               expose api tối thiểu
  src/renderer/src/screens/{Session,NewBatch,Queue,Results,Settings}.tsx
  profiles/flow.json
  test/*.test.ts
  e2e/smoke.spec.ts
apps/extension/
  manifest.json                      có "key" cố định
  sw.js                              nối WS, dispatch
  ops.js                             OPS allowlist (thuần, test được)
  page-ops.js                        thao tác DOM isolated world
  main-world.js                      listener registry, trusted submit, observer, ping(version, email)
  test/ops.test.mjs
```

---

### Task 1: Workspace + scaffold desktop

**Files:**
- Create: `package.json`, `apps/desktop/**` (electron-vite `react-ts` template), `apps/desktop/vitest.config.ts`, `packages/flow-protocol/src/index.d.ts`, `apps/desktop/test/smoke.test.ts`
- Modify: `packages/flow-protocol/package.json` (thêm `"types"` cho từng export), `.gitignore` (`out/`, `dist/`)

**Interfaces:**
- Produces: script `npm test -w apps/desktop` (= `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`); import `@toolflow/flow-protocol/attempt` từ TS có type `AttemptState`, `AttemptEvent`, `next`, `canClick`, `initial`.

- [ ] **Step 1:** `git switch -c p1-foundation`. Nếu `node --version` < 22, cài Node 22 LTS vào thư mục người dùng (không sudo).
- [ ] **Step 2:** Scaffold `npm create @quick-start/electron@latest apps/desktop -- --template react-ts`; thêm root `package.json` `{"private":true,"workspaces":["packages/*","apps/*"]}`; `npm i -w apps/desktop better-sqlite3 && npm i -D -w apps/desktop vitest @playwright/test`.
- [ ] **Step 3: Viết test** `test/smoke.test.ts`:
```ts
import { initial, next } from '@toolflow/flow-protocol/attempt';
import Database from 'better-sqlite3';
test('flow-protocol and sqlite load under electron node', () => {
  expect(next(initial('x'), { type: 'prepare', now: 0 }).item).toBe('preparing');
  expect(new Database(':memory:').prepare('select 1 as v').get()).toEqual({ v: 1 });
});
```
- [ ] **Step 4:** `npm test -w apps/desktop` → PASS. `npm run dev -w apps/desktop` mở cửa sổ; mở lần hai → không có cửa sổ thứ hai (`app.requestSingleInstanceLock()` trong `src/main/index.ts`, lần hai `focus()` cửa sổ cũ).
- [ ] **Step 5:** `cd packages/flow-protocol && node --test` vẫn 44/44. Commit `p1: workspace + electron-vite scaffold, single instance`.

### Task 2: SQLite + journal

**Files:** Create `src/main/db.ts`, `src/main/journal.ts`, `test/journal.test.ts`

**Interfaces:**
- Produces:
  - `openDb(file: string): Db` — bật `journal_mode=WAL`, `synchronous=FULL`, chạy migration theo `user_version`.
  - Bảng: `batch(id, kind, target_project, settings_json, status, stop_requested, archived, created_at, revision)`, `item(id, batch_id, ord, source_line, prompt, refs_json, attempt_id)`, `attempt(id, item_id, ordinal, state_json, tab_id, click_at, reconcile_at, revision)`, `journal_event(id, attempt_id, type, at, payload_json)`, `target_block(project_id, attempt_id, since)`, `account_setting(email, auto_enabled, ack_at)`, `command(id, result_json)`.
  - `applyEvent(db: Db, attemptId: string, ev: AttemptEvent, now: number): AttemptState` — đọc `state_json`, gọi `next`, ghi state + `journal_event` trong **một** `db.transaction`; `IllegalTransition` ⇒ rollback, ném lại.

- [ ] **Step 1: Test** `journal.test.ts`:
  - `applies event and journals it`: sau `prepare` → `state.item==='preparing'`, 1 dòng `journal_event` type `prepare`.
  - `illegal event leaves db unchanged`: `clicked` trên attempt `queued` ném `ILLEGAL_TRANSITION`; `state_json` và số dòng journal như cũ.
  - `wal and full sync`: `pragma journal_mode` = `wal`, `pragma synchronous` = `2`.
  - `intent write failure blocks click` (Review Focus 3): mở DB rồi `chmod` file chỉ đọc (hoặc `db.pragma('query_only=1')`) → `applyEvent(intent)` ném; state vẫn `preparing`.
- [ ] **Step 2:** Chạy → FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `p1: sqlite schema + transactional journal`.

### Task 3: Nhập lô, gán ref, enqueue

**Files:** Create `src/main/batch.ts`, `test/batch.test.ts`

**Interfaces:**
- Produces:
  - `parsePrompts(input: string | Uint8Array): { items: { sourceLine: number; prompt: string }[]; errors: { line: number; code: 'INVALID_UTF8' }[] }` — `Uint8Array` decode bằng `new TextDecoder('utf-8', { fatal: true })`, bỏ BOM đầu file; tách theo `\r\n|\n`; bỏ dòng chỉ có khoảng trắng; giữ nguyên dòng còn lại (không trim, không normalize).
  - `mapRefs(count: number, pool: string[], mode: 'none'|'all'|'sequential'|'start', perItem: number): { refs: string[][]; errors: { index: number; code: 'NOT_ENOUGH_REFS'|'TOO_MANY_REFS' }[] }` (06 §2; `start` = đúng 1 ref/item).
  - `enqueueBatch(db, cmd: { commandId: string; kind: 'image'|'video'; projectId: string; settings: object; prompts: string[]; refs: string[][]; mode: 'auto'|'manual' }): { batchId: string; revision: number }` — một transaction; `commandId` đã có ⇒ trả kết quả cũ.

- [ ] **Step 1: Test** `batch.test.ts`:
  - `CRLF and LF give the same items`: `'a\r\n\r\n  \nb'` và `'a\n\nb'` → prompts `['a','b']`, sourceLine `[1,4]` và `[1,3]`.
  - `BOM stripped only at start`: bytes `EF BB BF 61 0A EF BB BF 62` → `['a','\uFEFFb']`.
  - `invalid utf-8 is an error, not replaced`: bytes `61 0A FF` → `errors=[{line:2,code:'INVALID_UTF8'}]`, items rỗng (không chạy nửa file).
  - `parsePrompts keeps NFD and NFC as-is` (Review Focus 1): `'Phở\n' + 'Phở'.normalize('NFD')` → 2 item, `items[1].prompt === 'Phở'.normalize('NFD')`.
  - `sequential never wraps`: `mapRefs(3, ['r1','r2','r3','r4'], 'sequential', 2)` → item 2 lỗi `NOT_ENOUGH_REFS`, không có `r1` lặp lại.
  - `enqueue is atomic and idempotent`: ném lỗi giữa chừng (mock `insert item` lần 2) → 0 batch; gọi 2 lần cùng `commandId` → 1 batch.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `p1: prompt import, ref mapping, atomic enqueue`.

### Task 4: Driver interface + fake driver

**Files:** Create `src/main/driver.ts`, `src/main/fake-driver.ts`, `test/fake-driver.test.ts`

**Interfaces:**
- Produces (`driver.ts`):
```ts
export type Ping = { xhrSend: boolean; xhrOpen: boolean; fetch: boolean; id: string; seq: number; dropped: number; t: number; version: string; email: string | null };
export type ClickResult = { found: boolean; disabled: boolean | null; listeners: number; called: number } | { noMainWorld: true };
export type DriverEvent =
  | { tabId: string; type: 'sent'; request: unknown }
  | { tabId: string; type: 'response'; rpc: string; text: string }   // raw; runner parses with flow-protocol
  | { tabId: string; type: 'disconnected' };
export interface FlowDriver {
  ping(tabId: string): Promise<Ping>;
  prepare(tabId: string, p: { prompt: string; kind: 'image'|'video'; settings: object; refIds: string[] }): Promise<{ ok: true } | { ok: false; code: string }>;
  checkBeforeClick(tabId: string, projectId: string): Promise<{ ok: true } | { ok: false; code: 'COVERED'|'CREDIT_WARNING'|'BUTTON_DISABLED'|'CHIP_MISMATCH'|'TARGET_CHANGED' }>;  // TARGET_CHANGED: URL tab không còn là project của lô (AC-23)
  click(tabId: string, epoch: number): Promise<ClickResult>;   // throws ConnectorError on drop
  readProject(projectId: string): Promise<string>;              // raw Zzl0ze body from a separate read tab
  focusTab(tabId: string): Promise<void>;
  onEvent(cb: (e: DriverEvent) => void): () => void;
}
export class ConnectorError extends Error { code = 'CONNECTOR_LOST' }
```
- `createFakeDriver(script: FakeScript): FlowDriver & { ledger: { clicks: number; prepares: number; readProject: number }; emit(e: DriverEvent): void }` — `FakeScript` cho mỗi click: `'image-ok' | 'video-ok' | 'throttled' | 'no-request' | 'drop'`, phát `sent`/`response` lấy **từ fixture thật** `packages/flow-protocol/test/fixtures/*.json` (prompt thay bằng prompt của lượt, giữ nguyên cấu trúc).

- [ ] **Step 1: Test** `fake-driver.test.ts`: `image-ok` → `sent` rồi `response` mà `parseImageReceipt` đọc được và `correlate` = owned; `throttled` → `parseRpcResponse(...).error.reasons` có `PUBLIC_ERROR_USER_REQUESTS_THROTTLED`; `drop` → `click` ném `ConnectorError`; `ledger.clicks` đếm đúng.
- [ ] **Step 2–4.** **Step 5:** Commit `p1: FlowDriver contract + fixture-backed fake driver`.

### Task 5: Runner — chạy lô, trần song song, throttle, pause/stop

**Files:** Create `src/main/caps.ts`, `src/main/runner.ts`, `test/runner.test.ts`

**Interfaces:**
- Consumes: `applyEvent` (Task 2), `enqueueBatch` (Task 3), `FlowDriver` (Task 4), `parse*`/`correlate` từ flow-protocol.
- Produces:
  - `CAPS` và `nextCap(cur: number, signal: 'throttled'|'ok', max: number): number`.
  - `createRunner(o: { db: Db; driver: FlowDriver; clock: { now(): number }; tabs: string[]; speed: 'default'|'fast'; autoAllowed(email: string|null): boolean }): Runner`
  - `batchStatus(db, batchId): 'queued'|'running'|'paused'|'needs_review'|'completed'|'partial_failed'|'failed'|'stopped'` theo đúng thứ tự 7 bước ở [02 §5](../../app/02-domain-and-state.md).
  - `Runner = { tick(): Promise<void>; rerun(attemptId: string, confirmedCost: true): string /* attemptId mới, sourceAttemptId = cũ */; start(batchId: string): void; pause(batchId: string): void; resume(batchId: string): void; stop(batchId: string): void; confirm(attemptId: string, to: 'sent'|'not_sent'): void; archive(batchId: string): void; recover(): void; inFlight(): { image: number; video: number } }`
  - Mỗi `tick`: xử lý event driver đã nhận → cấp lượt theo trần + nhịp tab → mỗi lượt: `prepare` → `checkBeforeClick` → `ping` → `applyEvent(intent)` → (auto) `driver.click` → `applyEvent(clicked)`. Ghép `sent` với attempt đang chờ `sent` của **đúng tab** đó.

- [ ] **Step 1: Test** `runner.test.ts` (fake clock, gọi `tick()` thủ công):
  - `image batch respects cap 12 and sends next after sent`: lô 20 ảnh, default → không lúc nào `inFlight().image > 12`; lượt 2 được bấm ngay sau khi lượt 1 có `sent`, trước response.
  - `video waits for receipt per tab`: lô 3 video → lượt 2 chỉ bấm sau `response` lượt 1.
  - `fast mode uses 4 tabs and caps 20/30`.
  - `throttle halves cap and resends same attempt after backoff`: lượt bị `throttled` → cap 12→6; cùng `attemptId` được bấm lại khi `clock` ≥ +30_000, không sớm hơn; `ledger.clicks` = số lượt + 1.
  - `pause fences new clicks but follows sent ones`: pause sau lượt 1 `sent` → không click mới; response lượt 1 vẫn đưa nó về `ready`.
  - `stop cancels unsent only`: stop khi 2 lượt đang chờ response, 5 lượt queued → 5 `cancelled`, 2 về `ready`.
  - `intent write failure blocks click` (Review Focus 3): DB `query_only` trước intent → `ledger.clicks` không tăng, lô `paused`, lỗi `STORAGE_UNAVAILABLE`.
  - `connector drop during click is uncertain` (Review Focus 5): script `drop` → attempt `needs_review/uncertain`, project bị chặn.
  - `batch status follows 02 §5` (AC-20): bảng 7 dòng — có needs_review ⇒ `needs_review` dù stopRequested; tất cả ready ⇒ `completed`; ready + failed ⇒ `partial_failed`; không ready nào ⇒ `failed`; stop xong ⇒ `stopped`.
  - `target changed blocks click` (AC-23): `checkBeforeClick` trả `TARGET_CHANGED` → `ledger.clicks` không tăng, lô `paused`.
  - `auto off means no click`: `autoAllowed` trả false → attempt dừng ở `awaiting_user` (dùng Task 7), `ledger.clicks === 0`.
- [ ] **Step 2–4.** **Step 5:** Commit `p1: runner admission, caps, per-tab pacing, throttle, pause/stop`.

### Task 6: Lượt không rõ, đối soát, khôi phục sau crash

**Files:** Create `src/main/reconcile.ts`, `test/uncertain.test.ts`; Modify `src/main/runner.ts`

**Interfaces:**
- Consumes: `parseProject`, `reconcile` từ `@toolflow/flow-protocol/project`; `driver.readProject`.
- Produces: `runReconcile(db, driver, attemptId, now): Promise<'found'|'not_found'|'ambiguous'>` — `found` ⇒ `applyEvent(resolve, {to:'ready', evidence})` + xoá `target_block` + lô chạy tiếp; còn lại ⇒ giữ chặn, `reconcile_at = null`, lô đứng chờ (D-21). Runner gọi khi `now ≥ reconcile_at`, kể cả ngay sau `recover()`.

- [ ] **Step 1: Test** `uncertain.test.ts`:
  - `uncertain releases runner to a batch on another project` (AC-36): lô A (project P1) có lượt `no-request`, lô B (P2) đang chờ → B bắt đầu chạy; A không bấm thêm lượt nào; `target_block` P1 còn.
  - `reconcile after 10 minutes: found resumes batch` : fixture `project-Zzl0ze.json`, prompt + click time của lượt 31 → sau `clock+600_000` → `ready`, block gỡ, phần còn lại của A chạy tiếp; `state.creditSpent === true`.
  - `not found waits for user`: → lô A `needs_review`, không tick nào bấm thêm; `confirm(id,'not_sent')` → block gỡ, A chạy tiếp, attempt đó **không** được bấm lại.
  - `duplicate prompts both uncertain` (Review Focus 4): 2 lượt cùng prompt, cùng 1 media khớp trong cửa sổ → cả hai `ambiguous`, không gán.
  - `crash after intent commit, before click` (Review Focus 2): ghi intent, đóng DB, mở runner mới, `recover()` → attempt `needs_review` `why:'restart'`, `ledger.clicks === 0`; `reconcile_at` đã đặt.
  - `restart reschedules overdue reconcile`: `reconcile_at` đã qua lúc mở app → chạy ngay ở tick đầu.
  - `archive releases runner immediately but keeps block`: `archive(A)` khi tab không còn lệnh → B chạy ngay; P1 vẫn chặn; `batch.archived=1`.
  - `rerun needs confirmation and links the old attempt` (AC-22): `rerun(id)` khi project còn chặn ⇒ ném `TARGET_BLOCKED`; sau `confirm(id,'not_sent')` ⇒ attempt mới `queued`, `sourceAttemptId` = cũ, attempt cũ giữ nguyên `failed` + `userConfirmed`.
  - `stale epoch response ignored` (AC-30): event mang epoch cũ sau khi extension nối lại → không đổi state.
- [ ] **Step 2–4.** **Step 5:** Commit `p1: uncertain handling, 10-min reconcile, crash recovery, archive`.

### Task 7: Gửi tay trong máy trạng thái

**Files:** Modify `packages/flow-protocol/src/attempt.mjs`, `packages/flow-protocol/test/attempt.test.mjs`, `packages/flow-protocol/src/index.d.ts`

**Interfaces:**
- Produces: `intent` nhận thêm `manual: true` ⇒ `item: 'awaiting_user'`, `stage: 'intent_recorded'`; event mới `{ type: 'skip', ping, now }`: heartbeat so với baseline còn sống (cùng `id`, `dropped` không tăng) và chưa có request ⇒ `item: 'cancelled'`, `stage: 'outcome_known'`, `creditSpent: false`; heartbeat hỏng ⇒ `review(SUBMIT_UNCERTAIN)`. `sent` được phép khi `awaiting_user` (không cần `clicked`). `deadline` khi `awaiting_user` ⇒ không đổi (không có hạn chờ). `canClick` luôn false khi manual.

- [ ] **Step 1: Test** thêm vào `attempt.test.mjs`:
  - `manual: intent waits for the user, sent goes on as auto` (fixture ảnh thật → `ready`).
  - `manual skip with continuous observer is not sent`; `manual skip after reload is uncertain` (ping `id` khác).
  - `manual never times out`: `deadline` không đổi state; `canClick` false.
- [ ] **Step 2–4:** `node --test` trong `packages/flow-protocol` → tất cả PASS. Chạy lại mutation nhanh: bỏ kiểm `dropped` trong `skip` → ít nhất 1 test fail. **Step 5:** Commit `flow-protocol: manual submit path (awaiting_user, skip)`.

### Task 8: Extension sản phẩm

**Files:** Create `apps/extension/{manifest.json, sw.js, ops.js, page-ops.js, main-world.js, test/ops.test.mjs}`

**Interfaces:**
- Produces:
  - `manifest.json`: MV3, `"key"` cố định (sinh một lần bằng `openssl genrsa`, commit public key; ghi `EXT_ID` vào `apps/desktop/src/main/connector/ext-id.ts`), permissions `tabs, scripting, downloads, alarms`, host `https://flow.google.com/*`, content script `main-world.js` MAIN `document_start`. **Không** có `debugger`.
  - `ops.js`: `export const OPS = ['ping','state','prep','radios','click','fill','hit','trusted','net','file','open','reloadTab','download','downloads','account'];` và `export function validate(msg: {id:number, epoch:number, op:string, args:object}): string|null` (null = hợp lệ; op ngoài `OPS`, thiếu `id`/`epoch`, `args` không phải object ⇒ chuỗi lỗi).
  - `main-world.js`: như spike + `version` (đọc từ `<meta>` do content script gắn = `chrome.runtime.getManifest().version`) trong ping; `account` trả email từ `aria-label` nút tài khoản Google (null nếu không đọc được).
  - `sw.js`: đọc `pair.json` qua `fetch(chrome.runtime.getURL('pair.json'))`, nối `ws://127.0.0.1:<port>/?token=<token>`, tự nối lại (alarms 30 s), trả `{id, epoch, ok, result|error}`.

- [ ] **Step 1: Test** `ops.test.mjs` (`node --test`): `validate` từ chối `{op:'eval'}`, `{op:'trusted'}` thiếu `epoch`, `args:'x'`; chấp nhận `{id:1,epoch:2,op:'ping',args:{}}`; `OPS` không chứa `cdp`/`attach`/`debugger`.
- [ ] **Step 2–4.** **Step 5:** Commit `p1: product MV3 extension (fixed id, op allowlist, versioned ping, account)`.

### Task 9: WS server + ghép đôi

**Files:** Create `src/main/connector/{server.ts, pairing.ts, ext-id.ts, ext-driver.ts}`, `test/connector.test.ts`

**Interfaces:**
- Produces:
  - `installExtension(bundledDir: string, userDataDir: string, port: number): { dir: string; token: string }` — copy đè `bundledDir` → `<userData>/extension`, giữ `pair.json` cũ nếu có (token giữ nguyên), không thì sinh token 32 byte hex.
  - `startConnectorServer(o: { token: string; extensionId: string }): Promise<{ port: number; send(op: string, args: object): Promise<unknown>; epoch(): number; close(): Promise<void> }>` — bind `127.0.0.1:0`; từ chối (đóng 4401) nếu sai token hoặc `Origin` ≠ `chrome-extension://${extensionId}`; mỗi kết nối mới `epoch++`, đóng kết nối cũ; `send` khi không có kết nối ⇒ `ConnectorError`.
  - `createExtDriver(server): FlowDriver` — P1 chỉ cần `ping` và `onEvent('disconnected')` chạy thật; các op khác map sang lệnh tương ứng, test bằng live ở P2.

- [ ] **Step 1: Test** `connector.test.ts` (client `ws` giả lập extension):
  - `rejects wrong token` và `rejects wrong origin` (close code 4401).
  - `newest connection wins`: client 2 nối → client 1 bị đóng, `epoch()` tăng, reply mang epoch cũ bị bỏ (AC-06).
  - `server listens on loopback only`: `address().address === '127.0.0.1'`.
  - `install keeps token across updates`: gọi `installExtension` 2 lần → cùng token, file extension được ghi đè.
- [ ] **Step 2–4.** **Step 5 (thủ công, ghi kết quả vào `docs/progress-p1.md`):** chạy app, Chrome của user hiện tại → `chrome://extensions` → Developer mode → Load unpacked `<userData>/extension` → app hiện "Đã kết nối"; tắt bật app → extension tự nối lại ≤ 30 s. Commit `p1: loopback WS connector + pairing`.

### Task 10: Profile có version, self-check, công tắc auto

**Files:** Create `profiles/flow.json`, `src/main/profile.ts`, `src/main/account.ts`, `test/profile.test.ts`

**Interfaces:**
- Produces:
  - `profiles/flow.json`: `{ "version": "2026.11.08-1", "selectors": { "editor": "flow-prompt-box .ProseMirror[contenteditable=\"true\"]", "submit": "flow-prompt-box button[type=\"submit\"]", "clear": "button.clear-button", "chip": "flow-image-ingredient-chip img", "tile": "flow-grid-tile-container", "creditWarning": "button.prompt-warning-button", "assetSearch": "flow-add-menu-popover-content input.search-input", "assetItem": "flow-add-menu-popover-content .asset-item" }, "rpc": { "image": "ogiZ0b", "t2v": "YhhmEf", "poll": "jwpduf", "upload": "maseQ", "project": "Zzl0ze" } }`
  - `selfCheck(probe: { present: Record<string, boolean>; listeners: number; ping: Ping; sawProjectLoad: boolean; extVersion: string }): { ok: true } | { ok: false; code: 'PROTOCOL_DRIFT'|'CONFIG_INCOMPLETE'; reasons: string[] }` — thiếu selector, `listeners !== 1`, heartbeat hỏng, chưa thấy `Zzl0ze` ⇒ `PROTOCOL_DRIFT`; `ping.version !== extVersion` ⇒ `CONFIG_INCOMPLETE` reason `RELOAD_TAB`.
  - `autoAllowed(db, email: string|null): boolean`; `enableAuto(db, email: string, ackAt: number): void`; `disableAuto(db, email)`.

- [ ] **Step 1: Test** `profile.test.ts`: mỗi lý do drift sinh đúng reason; version lệch ⇒ `RELOAD_TAB`; `autoAllowed(db, null) === false`; tài khoản mới ⇒ false; sau `enableAuto` ⇒ true và `ack_at` lưu; email khác ⇒ false.
- [ ] **Step 2–4.** **Step 5:** Commit `p1: versioned flow profile, self-check, per-account auto switch`.

### Task 11: Giao diện + IPC

**Files:** Create `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/screens/*.tsx`, `e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: Runner (Task 5–6), `enqueueBatch`, `parsePrompts`, `mapRefs`, account/profile.
- Produces: IPC `invoke` channels `saveDraft, enqueueBatch, startBatch, pauseBatch, resumeBatch, stopBatch, confirmUncertain, archiveBatch, enableAuto, disableAuto, listBatches, getBatch`; event `state` `{ entity, id, revision }` — renderer bỏ bản revision cũ hơn, mất kết nối thì `getBatch` lại.
- Màn hình (chữ tiếng Việt): S1 trạng thái kết nối + tab + self-check; S2 textarea/TXT, chọn Ảnh **hoặc** Video, preview `# | prompt | refs | lỗi`; S3 hàng đợi với trạng thái thật từng item, lượt không rõ hiện lý do + giờ đối soát + nút "Đã gửi" / "Chưa gửi" / "Lưu hồ sơ chưa rõ"; S4 danh sách output; S5 tốc độ (Mặc định/Nhanh), công tắc auto theo email với hộp cảnh báo phải tick "Tôi hiểu rủi ro" mới bật.
- Chế độ test: biến môi trường `TOOLFLOW_FAKE_DRIVER=1` ⇒ `index.ts` dùng fake driver.

- [ ] **Step 1: Test** `e2e/smoke.spec.ts` (Playwright `_electron`, fake driver):
  - `textarea batch runs to ready`: nhập 3 dòng → preview 3 → "Tạo lô và chạy" → 3 item "Có kết quả".
  - `uncertain shows confirm buttons`: script `no-request` → item "Không rõ" + 2 nút; bấm "Chưa gửi" → lô chạy tiếp.
  - `auto needs warning ack`: bật auto khi chưa tick ⇒ vẫn tắt.
  - `history survives restart` (AC-17): chạy lô có 1 lượt lỗi, đóng app, mở lại → màn chi tiết vẫn hiện prompt, cấu hình, mốc thời gian, lỗi của từng attempt.
  - `no outbound network` (AC-32): ghi mọi request qua `session.defaultSession.webRequest.onBeforeRequest` trong cả phiên test → chỉ có `file:`/`devtools:`/`ws://127.0.0.1`.
  - `keyboard only`: chạy luồng đầu chỉ bằng Tab/Enter, nút Dừng luôn tới được (AC-27).
- [ ] **Step 2–4.** **Step 5:** Commit `p1: functional UI S1–S5 + IPC`.

### Task 12: Cổng phase P1

- [ ] **Step 1:** Linux: `npm test -w apps/desktop`, `node --test` ở `packages/flow-protocol` và `apps/extension`, `npx playwright test -w apps/desktop` → tất cả PASS; `python3 docs/app/verify-docs.py` PASS.
- [ ] **Step 2:** Windows: chạy cùng lệnh trên một máy Windows (cần Sư Huynh chỉ máy hoặc chạy hộ) + bước ghép đôi thủ công của Task 9.
- [ ] **Step 3:** Ghi bảng AC của gate P1 (design doc §13) → PASS/FAIL + bằng chứng vào `docs/progress-p1.md`. AC nào chỉ kiểm bằng fake driver ghi rõ "fake driver, live ở P2".
- [ ] **Step 4:** `git switch main && git merge --no-ff p1-foundation`. Không push.
