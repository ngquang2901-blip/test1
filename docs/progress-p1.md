# P1 progress

## Task 9 Step 5: PARTIAL — pairing verified on Linux with real Google Chrome; Flow-side checks need Sư Huynh
Pairing part run 2026-11-08 on Linux (Google Chrome 156, temp profile, no Google login) with `apps/desktop/scripts/pair-check.mjs`: the extension is loaded via CDP `Extensions.loadUnpacked` (branded Chrome ignores `--load-extension`). Output: first pairing connected after 2 s; app restart → new port, same token, reconnected after 29 s; extension id `aicenhlifoinpclibjijbgempddjgmhe` = `EXT_ID`. Reconnect relies on the 30 s wake alarm, so it sits right at the 30 s limit. Manual steps for the Flow-side checks:
1. Start the app (it runs `readOrCreateToken` → server → `installExtension`, writing `<userData>/extension/pair.json`).
2. In the Chrome profile logged in to Flow: open `chrome://extensions` → enable Developer mode → Load unpacked → `<userData>/extension`.
3. Open https://flow.google.com in a tab.
Check:
- [x] App shows "Đã kết nối"; extension id equals `EXT_ID` (ext-id.ts). (Linux, pair-check.mjs)
- [x] Quit and restart the app: extension reconnects within 30 s. (Linux: 29 s — at the limit)
- [x] `pair.json` is re-read after the port changes (unpacked extension serves files from disk). (Linux)
- [x] Generate transport checked live 2026-11-08 (Chrome Profile 1, real Flow): **ogiZ0b goes over `fetch`, not XHR** (also Zzl0ze and nzlxg). The P1 hooks only fed events from XHR, so no `sent`/`response` would have reached the desktop; fixed in p2-live-probe (fetch path now emits events; vm tests). Confirmed live end to end (see Live findings).
- [ ] Main-world `arm` / `trusted` click path works end to end.

## P1 gate — Linux (2026-11-08, p1-foundation tip = the commit that contains this file; base 3611a88)

**Tóm tắt (VI):**
- Trên Linux, cả 5 bộ kiểm tra đều chạy qua, không lỗi nào.
- Trong 19 mục nghiệm thu của P1, 14 mục đạt (test thật, dùng driver giả, bản thật làm ở P2), 4 mục đạt MỘT PHẦN (AC-10, AC-11, AC-18, AC-22: còn thiếu giao diện hoặc e2e), và AC-01 hoãn sang P2 (chỉ kiểm được trên Chrome thật; Sư Huynh đã đồng ý 08/11/2026). AC-07 mới kiểm phần giao diện, phần tải lỗi làm ở P2.
- Còn 2 việc chờ: nối extension trên Chrome thật (cần Sư Huynh) và chạy lại bộ test trên Windows.

### (a) Command results
| Command | Result |
|---|---|
| `npm test -w apps/desktop` | 10 files, 136 tests passed |
| `node --test` in packages/flow-protocol | 53 pass, 0 fail |
| `node --test` in apps/extension | 11 pass, 0 fail |
| `cd apps/desktop && xvfb-run -a npm run e2e` | 8 passed |
| `python3 docs/app/verify-docs.py` | PASS (10 chapters, 22 requirements, 36 acceptance cases; documents only) |

### (b) AC table (all runner/driver evidence is fake driver, live in P2). Paths relative to repo; desktop = apps/desktop.
| AC | Text (short) | Status | Evidence |
|---|---|---|---|
| AC-01 | Only the permitted, correct tab binds among wrong provider/project tabs; missing login/project gives a CTA | DEFERRED to P2 (live-only by its test method; tab discovery is P2) — gate deviation, approved by Sư Huynh 2026-11-08 | Tab discovery/binding does not exist in P1 (`tabs = []` in real mode). Only `connector.test.ts` token/origin rejection and `runner.test.ts` "target changed blocks click" exist. |
| AC-02 | TXT UTF-8/BOM, CRLF/LF, blank lines, Vietnamese, bad content: textarea/TXT same mapping, keep sourceLine, no implicit enqueue/submit | PASS | desktop/test/batch.test.ts: "CRLF and LF give the same items", "BOM stripped only at start", "invalid utf-8 is an error, not replaced", "parsePrompts keeps NFD and NFC as-is", "enqueue stores sourceLines and validates length", "prompts are not trimmed; string BOM stripped"; ipc.test.ts "dryRun previews without creating…". No UI-level TXT file import test (parser takes bytes and string). |
| AC-05 | Enqueue crash in transaction / draft edited after run: no partial batch; old settings/refs unchanged | PASS | desktop/test/batch.test.ts "enqueue is atomic and idempotent" (fault injected at 2nd item insert → 0 rows; retry idempotent; settings snapshot stored), "enqueue storage contract". No process-restart step. |
| AC-06 | Second app launch only focuses old window; only newest connection gets commands, old epoch rejected; takeover recovers without resend | PASS (fake) | e2e "second launch exits on its own and only raises the old window" (B with same TOOLFLOW_USER_DATA exits by itself; A has 1 visible window and its `second-instance` handler ran once). Newest connection / old epoch: connector.test.ts "newest connection wins…", uncertain.test.ts "stale epoch response ignored…". Takeover = restart recovery: uncertain.test.ts "crash after intent commit…", "restart reschedules overdue reconcile…" (no resend). Real window focus under a window manager is not asserted (Xvfb has none). |
| AC-07 | Driver goes waiting → ready → download error; UI does not equate ready with saved; no fake 100% success | PASS for what P1 has; download-failure path → P2 | UI: ready shows "Có kết quả (chưa tải)", batch status `completed` shows "Có kết quả (chưa tải)" (not "Hoàn tất"), S4 lists outputs as "chưa tải". e2e "textarea batch runs to ready" asserts those and that no "Đã lưu" appears after a fully ready batch. Download error itself needs the download path → P2. |
| AC-08 | Pause at queued/preparing/accepted and at permit hand-off: no new permit after fence; handed-over permit may have sent, not fake cancelled; resume checks stage | PASS | desktop/test/runner.test.ts "pause fences new clicks but follows sent ones"; "SUBMIT_LISTENER_MISSING pauses once; resume clicks the next…"; uncertain.test.ts "I1: a user pause survives the uncertain attempt being resolved"; "R25: a stale pause admission does not pause on a later throttled response after stop". Exact hand-off-instant ordering not separately tested. |
| AC-09 | Stop before click / after accepted / while uncertain: unsent cancelled, sent not fake cancelled, uncertain keeps blocker | PASS | runner.test.ts "stop cancels unsent only", "stop while the click is pending ends uncertain and blocks the project", "a sent already received when stop is ticked is processed before skip: never cancelled"; flow-protocol/test/attempt.test.mjs "stop: cancels only what surely was not sent". |
| AC-10 | Crash before/after intent, after click before ACK, after output before write: no auto-resubmit; archive needs confirmation, keeps blocker over restart | PARTIAL — archive confirmation UI is missing (runner-level only) | uncertain.test.ts "crash after intent commit, before click: recover makes it uncertain, no click…", "restart reschedules overdue reconcile, and rebuilds a lost target_block", "archive releases runner immediately but keeps block", "rerun needs confirmation and links the old attempt"; runner.test.ts "connector drop during click is uncertain"; attempt.test.mjs "D-04 restart: intent without receipt → uncertain…", "crash between intent and a journaled click…". "Crash after output before write" has no dedicated test. |
| AC-11 | Login/captcha/consent or auto off → manual fallback: opens right tab, re-check is not a submit, user ACK is no fake receipt | PARTIAL — focusTab / opening the right tab is not built | runner.test.ts "auto off means no click", "manual intent arms the tab…(awaiting_user → sent → ready)", "skip disarms the tab…", "manual skip with no send from the page is still cancelled"; attempt.test.mjs "manual: intent waits for the user…", "manual skip after reload is uncertain". Login/captcha pages themselves are live-only. |
| AC-17 | Batch with many attempts/errors reopens after restart with correct trace, history not rewritten | PASS | desktop/e2e/smoke.spec.ts "history survives restart" (prompt, config, SUBMIT_UNCERTAIN error, journal timestamps after relaunch). |
| AC-18 | Missing key / wrong schema / mid-job config update: block the operation, keep attempt version, update only at safe boundary | PARTIAL — invalid-profile e2e still absent | profile.test.ts `validateProfile` (missing key, wrong type, empty, selfCheck not a selector, rpc, non-object) and "invalid profile ⇒ CONFIG_INCOMPLETE PROFILE_INVALID" (self-check fails, S1 shows it, auto disabled in index.ts); config.test.ts: intent journal payload stores `profileVersion` (version only), shown in detail view (e2e "history survives restart"). Safe boundary: profile is a static import, so it changes only at app restart, which is the boundary; no hot reload exists. Auto-blocking on an invalid profile is wired in index.ts, covered by selfCheck test but not by an e2e. Auto-block on drift is now covered: runner.test.ts "failed self-check gates auto: manual intent, armed, no click" and profile.test.ts "autoGate: invalid profile or opted-out account ⇒ no auto". |
| AC-20 | Aggregate batch status for success/mixed/auto-download off/stopped/unresolved; unresolved never completed/stopped early | PASS | runner.test.ts "batch status follows 02 §5" (table-driven, 8 outcomes); e2e "uncertain shows confirm buttons" (batch held while first item unresolved). Auto-download-off row not present. |
| AC-22 | Regenerating accepted/uncertain/failed: no auto-retry, cost confirmation, history/blocker kept, archived old target not rerunnable, new target is a draft | PARTIAL — rerun is not exposed in the UI (runner-level only) | uncertain.test.ts "rerun needs confirmation and links the old attempt" (TARGET_BLOCKED until confirmed, ALREADY_RERUN, source_attempt_id link), "C1: a send deadline fences the tab, so the late sent/response of A never bind to B". Draft-for-other-target path not tested. |
| AC-23 | SPA/project/tab changes during await: re-check target revision before effect, no silent retarget | PASS | runner.test.ts "target changed blocks click" (TARGET_CHANGED → paused, 0 clicks), "disconnected fences attempts awaiting a response on that tab"; uncertain.test.ts "a click that throws without a disconnect still fences the tab". Real SPA race is live (P2). |
| AC-29 | Storage rejects intent commit / crash at durability boundary: no submit without durable intent; recovery never assumes "not sent" | PASS | journal.test.ts "intent write failure blocks click", "wal and full sync"; runner.test.ts "intent write failure blocks click" (0 clicks, STORAGE_UNAVAILABLE, paused); uncertain.test.ts "crash after intent commit, before click…"; attempt.test.mjs "dead observer before intent: refuse…". |
| AC-30 | Stale-epoch callback after takeover/stop does not overwrite new owner state or release blocker | PASS | uncertain.test.ts "stale epoch response ignored; the next click carries the new epoch", "R38: a restarted runner seeds epochs from the clock…"; connector.test.ts "newest connection wins… late old reply ignored"; runner.test.ts "a duplicate delivery of a settled response changes nothing". |
| AC-32 | With research-source domains/backend blocked: app boots, saves draft, runs driver without their license/config | PASS | desktop/e2e/smoke.spec.ts "no outbound network" (every request is file:/devtools:/ws://127.0.0.1) and "real mode survives a connector failure…". Asserts zero non-local traffic, not a named-domain block. |
| AC-35 | Image then video batch: in-flight ≤ cap (default 1 tab 8 video/12 image; fast 4 tabs 20/30), per-tab wait receipt, throttle lowers cap, pause blocks new but follows sent | PASS | runner.test.ts "image batch respects cap 12 and sends next after sent", "video waits for receipt per tab", "fast mode uses 4 tabs and caps 20/30", "throttle halves cap and resends same attempt after backoff", "pause fences new clicks but follows sent ones". Fake driver only; live in-flight count is P2. |
| AC-36 | Batch A uncertain + batch B other project; kill & reopen: intents → uncertain, 0 resends, B runs, A's project blocked; unblock after 10-min reconcile or user confirm; credit stays spent | PASS | uncertain.test.ts "uncertain releases runner to a batch on another project", "reconcile after 10 minutes: found resumes batch", "not found waits for user; confirm not_sent unblocks and never re-clicks that attempt", "crash after intent commit…", "restart: a batch paused only by an uncertain attempt auto-resumes once reconcile settles it". |

### (c) Gate rows still open
- Extension connects/reconnects on Windows and Linux → Linux **PASS** (pair-check.mjs, real Chrome); Windows **PENDING** (run the same script with CHROME_PATH).
- Windows run of the suites → **PENDING** (Task 12 Step 2, needs a Windows machine).
- Merged to main 2026-11-08 by Sư Huynh's decision with the two rows above still PENDING; they are run after merge and recorded here.

### Must carry to P2
- Drain the net-record buffer, or stop counting `dropped` for skip continuity (manual mode becomes uncertain in long sessions).
- Deadline for sent-without-response and for `generating`; heartbeat after click; poll wiring.
- Disarm (arm null) before the first click after a fence.
- Prepare must clear and verify composer text; per-op timeouts instead of a flat 30 s.
- Double-send detection via gen +1 in auto.
- Live check: is generate XHR or fetch? (fetch generates now bump `gen` but are not forwarded as events.)
- Tab discovery + focusTab (AC-01 / AC-11).
- Rerun + archive-confirm UI (AC-10 / AC-22).
- Strip fake / `TOOLFLOW_EXT_DIR` env paths at P4.

## Live findings (2026-11-08, Chrome Profile 1, real Flow tab)
- Extension paired and hooks intact on a real Flow tab; account label read; tab listing works (`tabs` op).
- Flow URL is `https://flow.google.com/...` (matches the manifest).
- Transport: `ogiZ0b` (image generate), `Zzl0ze`, `nzlxg` all via `fetch`. XHR is not used for these. Generate took ~24 s from send to response.
- `gen` moved 0→1 at the manual generate, so the skip-continuity rule (R40) works with the fetch path.
- Selectors editor/submit were absent on the Flow home page (no project open) — expected; not yet checked inside a project.
- **End to end manual-mode path confirmed live (23:52 local):** `arm(epoch)` → user clicks Gửi in Flow → `sent` event (epoch = armed epoch, request body ~9.4 KB) arrives at the desktop ~0.1 s after the click; `response` (rpc ogiZ0b, same epoch, request echoed) arrives ~21 s later. Tool: `npm run live-probe -w apps/desktop` with `ARM=1 WATCH_MIN=6`.
- Lesson: Chrome reads content-script files when the extension is (re)loaded. After the extension code on disk changes, reload the extension **and then** F5 the Flow tab; a reload done before the files were copied injects the old code (this cost one wasted generate).
- Inside a project: `editor`, `submit`, `tile` present; `submit` hit-test not covered; selfCheck's required selectors (editor+submit) pass. `clear`, `chip`, `assetSearch`, `assetItem` absent at idle as expected; `creditWarning` absent = healthy.
- **Auto path confirmed live (00:00 local, 2026-11-09):** `prep` filled the composer (`textMatches`, submit enabled) → our `trusted` click returned `{found:true, disabled:false, listeners:1, called:1}` → `sent` (epoch = ours, ~9.2 KB) ~0.1 s later → `response` ~21 s later. ADR-0002 works on the real extension and a real account.
- **Product parser on live traffic (in memory, nothing persisted):** `parseGenerateRequest(readFReq(sent))` OK (rpc ogiZ0b, 2 items, prompt equals what `prep` typed, aspect code 3, seed ints); `parseRpcResponse` + `parseImageReceipt` OK (2 outputs); `correlate(request, receipt)` → owned=true, batchId matches. So the P1 runner contract matches today's Flow for image generation.
- Aspect code 3 is new (parser comment lists 1 = 1:1, 2 = 9:16): note the mapping when settings are implemented.
- Not yet verified live: video RPCs (needs video credit), refs/upload (`maseQ`), polling, downloads, `listeners` count drift over time, the 24h+ behaviour of the service worker.
