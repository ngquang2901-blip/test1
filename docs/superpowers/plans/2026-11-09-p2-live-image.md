# P2 — Flow ảnh thật (ảnh, ảnh có ref, tải file) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Chạy một lô ảnh thật trên Google Flow từ app: dò và cấp quyền tab, chuẩn bị composer, bấm (auto) hoặc chờ bấm tay (manual), nhận kết quả, gắn ref, tải file về thư mục đích.

**Architecture:** Giữ nguyên runner/máy trạng thái của P1; thay phần giả bằng `createExtDriver` thật (extension MV3 + WS loopback đã có). Mọi thao tác trên trang đi qua allowlist op của extension. Flow gửi generate bằng **`fetch`** (đã đo live 2026-11-09), observer đã phát `sent/response` từ fetch.

**Tech Stack:** Electron + TS + better-sqlite3 + vitest + Playwright (như P1); extension JS thuần; `chrome.downloads`.

**Spec:** `docs/superpowers/specs/2026-11-08-toolflow-design.md` §6, §8, §9, §13 (P2); `docs/app/04-flow-driver.md`, `06-assets-and-downloads.md`, `08` (AC); bằng chứng và việc phải mang sang P2: `docs/progress-p1.md` (mục "Live findings", "Must carry to P2").

## Global Constraints

- Không lưu URL có chữ ký, cookie, token reCAPTCHA, raw `f.req` vào DB/log/renderer. URL tải chỉ lấy lúc tải, giữ trong bộ nhớ.
- Không `chrome.debugger`, không giải/giả reCAPTCHA, không humanize, không xoay IP/tài khoản, không tự retry `GENERATION_FILTERED`, không tự retry lượt uncertain.
- Auto mặc định TẮT; chỉ bật khi self-check đạt (`editor`+`submit`, listener = 1, heartbeat, đã thấy `Zzl0ze`) và tài khoản đã xác nhận rủi ro (D-19).
- Một lô = một loại ảnh *hoặc* video (D-20). P2 chỉ làm ảnh.
- Ghi journal intent trước khi bấm (R10). Không lượt đã gửi thật nào được kết thúc `cancelled` (R40: `gen` phải đứng yên).
- Live test dùng profile Chrome "Profile 1" của user quangng qua `apps/desktop/scripts/live-probe.ts` / script mới; đặt số lượng ảnh = x1 nếu chọn được để tiết kiệm credit; sau khi extension đổi code: tải lại extension **rồi** F5 tab Flow (Chrome đọc content script lúc nạp extension).
- Git: nhánh `p2-live` từ `main`; mỗi task một commit; không push (O-07); gộp `main` bằng `--no-ff` khi gate P2 qua.

## Review Focus

- Tab Flow đổi project/đăng xuất giữa chừng → TARGET_CHANGED, không bấm (có test).
- Composer còn chữ cũ / prompt gõ đôi → `prepare` từ chối (prompt phải khớp nguyên văn) và xoá composer trước.
- Gửi rồi nhưng response không bao giờ về / trang reload giữa chừng → uncertain qua deadline, không treo vĩnh viễn, không gửi lại.
- Ref upload ACK muộn / chip không hiện → đối soát trước, không upload lặp.
- Tải về trả HTML / 0 byte / tên trùng / ký tự cấm Windows → không `completed`, không ghi đè.

## File Structure

- `apps/extension/{sw.js,ops.js,page-ops.js,main-world.js}` — thêm op `focus`, `download` thật, chuẩn bị composer; mọi op mới có test `node --test`.
- `apps/desktop/src/main/connector/ext-driver.ts` — driver thật (listTabs, prepare, checkBeforeClick, probe, readProject, focusTab).
- `apps/desktop/src/main/{tabs.ts,runner.ts,index.ts,ipc.ts}` + `src/renderer/src/screens/Session.tsx` — tab động, timeout, giao diện.
- `apps/desktop/src/main/{outputs.ts,downloads.ts}` — gắn output, đường tải.
- `apps/desktop/scripts/live-*.ts` — kịch bản live có ngân sách.
- `docs/progress-p2.md` — bằng chứng gate.

---

### Task 1: Dò tab, cấp quyền tab, focus (AC-01, AC-11)

**Files:** Modify `apps/extension/{ops.js,sw.js}`, `apps/desktop/src/main/{runner.ts,index.ts,ipc.ts}`, `src/main/connector/ext-driver.ts`, `src/renderer/src/screens/Session.tsx`; Create `src/main/tabs.ts`, `test/tabs.test.ts`.

**Interfaces:**
- Produces: extension op `focus` `{tabId}` → `true` (`tabs.update(active)` + `windows.update(focused)`); `ops.js` validate nó như op tab khác.
- `FlowDriver.listTabs(): Promise<FlowTab[]>`, `type FlowTab = { tabId: string; projectId: string | null; email: string | null; active: boolean }`; `projectId` lấy từ path `/project/<uuid>`; fake driver trả `t1`.
- `Runner.setTabs(ids: string[]): void` — đổi tập tab; tab bị bỏ mà còn attempt đang bay ⇒ fence tab đó (epoch +1), không bỏ rơi.
- `tabs.ts`: `tabStatus(t: FlowTab): 'ok' | 'no_project' | 'no_login'` (CTA tiếng Việt do UI map). Quyền: user bấm "Dùng tab này" trong S1; ipc `useTabs(ids: string[])`; chỉ tab đã cấp được đưa vào `setTabs`.

- [ ] Test: `tabStatus` 3 nhánh; `setTabs` fence tab bị bỏ có attempt `sent`; connector test: fake extension trả 3 tab (home, project A, project B) → chỉ tab được cấp mới nhận lệnh `trusted`; e2e (fake driver): S1 hiện danh sách + nút, chưa cấp thì lô không chạy.
- [ ] Implement; `focusTab` ext-driver gửi op `focus`; "mở đúng tab" khi cần gửi tay (manual) gọi `focusTab` trước `arm`.
- [ ] Live: `live-probe` in danh sách; kiểm focus đưa tab Flow lên trước.
- [ ] Commit `p2: tab discovery, grant and focus`.

### Task 2: Chuẩn bị composer và kiểm trước khi bấm (AC-03)

**Files:** Modify `apps/extension/page-ops.js`, `apps/desktop/profiles/flow.json`, `src/main/profile.ts`, `src/main/connector/ext-driver.ts`; Create `docs/app/evidence/flow-composer-dom.md`, `test/prepare.test.ts`.

**Interfaces:**
- `flow.json` thêm `"combos": [{ "kind": "image", "mode": "...", "model": "...", "aspect": "...", "count": 1 }]` (giá trị đọc từ live ở bước 1) — combo ngoài danh sách bị chặn **trước intent** với code `COMBO_NOT_QUALIFIED`.
- `prepare(tab, {prompt, kind, settings, refIds})`: xoá composer (`clear` selector) → đặt mode/model/aspect/count → đọc lại từng option (Q-31) → gõ prompt → đọc lại phải khớp nguyên văn; sai ⇒ `{ok:false, code}`.
- `checkBeforeClick(tab, projectId)`: nút bật, không có `creditWarning`, chip khớp `refIds`, nút không bị che (`hit`), `ping` sống, project tab = `projectId` (nếu không ⇒ `TARGET_CHANGED`).

- [ ] Step 1 (live, không tốn credit): dùng `radios` + `probe` ghi lại DOM panel cài đặt vào `docs/app/evidence/flow-composer-dom.md` (đã bỏ nội dung cá nhân); chốt combo đầu tiên.
- [ ] Test (vm/jsdom-free): prepare gõ đôi ⇒ từ chối; còn chữ cũ ⇒ xoá rồi gõ; combo lạ ⇒ chặn trước intent (test runner).
- [ ] Implement + live: `prepare` 3 lần liên tiếp trên composer, không bấm Gửi; chữ trong composer khớp mỗi lần.
- [ ] Commit `p2: composer prepare + pre-click checks`.

### Task 3: Độ bền khi chạy thật

**Files:** Modify `apps/desktop/src/main/{runner.ts,connector/server.ts}`, `apps/extension/main-world.js`, `src/renderer/src/screens/Queue.tsx`, `src/main/ipc.ts`.

**Interfaces:** `server.send(op, args, msgEpoch?, timeoutMs?)` với ngân sách theo op (`ping` 3 s, `prep` 20 s, `trusted/arm` 5 s, còn lại 30 s); `net` op **xả** buffer (đã drain) và heartbeat bỏ đếm `dropped` do xả định kỳ; runner đặt **deadline phản hồi** cho attempt `sent` (ảnh 120 s ⇒ `awaiting` → uncertain qua `deadline`); chạm trang reload (id đổi) ⇒ fence; trước click đầu tiên sau fence gọi `arm(tab, null)`; chế độ auto kiểm `gen` tăng đúng +1 sau click; UI: nút "Lưu hồ sơ chưa rõ" hỏi xác nhận; nút "Chạy lại" (`rerun`) có xác nhận chi phí.

- [ ] Test: mỗi mục một test (timeout từng op; response không về ⇒ uncertain, không resend; gen +2 ⇒ uncertain; archive cần `confirm: true` ở IPC; rerun hiện chi phí).
- [ ] Commit `p2: runtime deadlines, drain, disarm, confirmations`.

### Task 4: Lô ảnh thật đầu tiên (không ref, không tải)

**Files:** Create `apps/desktop/scripts/live-batch.ts`, `docs/progress-p2.md`.

- [ ] Script: bật real mode với tab đã cấp, `enqueueBatch` 3 prompt ảnh, chạy **manual** (Sư Huynh bấm) rồi **auto**; in bảng item → trạng thái, không in URL/body.
- [ ] Kết quả đạt: 3 item `ready` có `mediaId` thật, `gen`/`sent`/`response` khớp từng item, không `uncertain`. Ghi vào `progress-p2.md` (AC-34 phần ảnh).
- [ ] Commit `p2: first live image batch`.

### Task 5: Ref (upload + gắn chip) (AC-04, AC-25)

**Files:** Modify `apps/extension/page-ops.js`, `ext-driver.ts`, `src/main/batch.ts`, `test/refs.test.ts`.

**Interfaces:** `prepare` nhận `refIds` ⇒ với mỗi ref: upload tên file duy nhất theo `assetId` (op `file`), lấy `mediaId` từ receipt `maseQ` (`parseUploadReceipt`), chip không hiện ⇒ gắn từ thư viện bằng ô tìm kiếm, không upload lại; ghi **upload intent** trước khi gửi file; ACK muộn ⇒ tìm binding trước (không upload lặp).

- [ ] Test: fault-injection "upload gửi rồi mất ACK" ⇒ không upload lần hai; pool ít hơn prompt ⇒ preview đúng, không xoay vòng.
- [ ] Live: 1 lô 2 prompt với 1 ref sequential; chip đúng `mediaId`.
- [ ] Commit `p2: ref upload and attach`.

### Task 6: Gắn output đúng chủ (AC-14)

**Files:** Create `src/main/outputs.ts`, `test/outputs.test.ts`.

**Interfaces:** `bindOutputs(attempt, receipt, project: ParsedProject): Output[]` — chỉ bind khi `correlate().owned`; output cũ/ref/ảnh user tự tạo không bind; mơ hồ ⇒ `needs_review`. Lưu `mediaId`, `attemptId`, evidence; **không** lưu URL.

- [ ] Test với fixture `project-Zzl0ze.json` + receipt: output cũ không bị gắn; hai attempt cùng prompt ⇒ ambiguous.
- [ ] Commit `p2: output ownership binding`.

### Task 7: Tải file (AC-15, 16, 26, 28)

**Files:** Modify `apps/extension/{ops.js,sw.js}`; Create `src/main/downloads.ts`, `test/downloads.test.ts`.

**Interfaces:** `planName(batch, index, prompt, outputId, ext): string` (template `{lô}/{stt}_{prompt rút gọn}_{outputId}.{ext}`; chuẩn hoá Unicode, bỏ ký tự cấm Windows/Linux, chặn traversal, giới hạn độ dài); `download(output)` — ghi transfer intent trước, lấy URL lúc tải (img `data-media-id`), extension `chrome.downloads` vào `Downloads/ToolFlow-tmp/`, desktop kiểm magic bytes + kích thước > 0 rồi chuyển file, không ghi đè, lưu `actualName`; ACK mất ⇒ `downloads.search` trước khi tải lại; tải lỗi ⇒ retry cùng output, **số lần gọi generate không tăng** (assert bằng driver call counter).

- [ ] Test: HTML/0 byte ⇒ không `completed`; tên trùng ⇒ `actualName`; `..\\`, `CON.png`, dấu chấm cuối; retry không tạo tên mới; submit count không đổi.
- [ ] Live: tải 1 ảnh thật, kiểm magic bytes PNG/JPEG.
- [ ] Commit `p2: download pipeline`.

### Task 8: Cổng P2

- [ ] `node apps/desktop/scripts/gate.mjs` trên Linux và Windows (mọi suite PASS); live: lô 3 ảnh có 1 ref, auto + manual, tải đủ file.
- [ ] `docs/progress-p2.md`: bảng AC-01, 03, 04, 12 (ảnh), 14, 15, 16, 25, 26, 28, 34 → PASS/FAIL/NOT COVERED + bằng chứng; mục chưa live ghi rõ.
- [ ] Gộp `main` bằng `--no-ff`; không push.
