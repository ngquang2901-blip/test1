# P1 progress

## Task 9 Step 5: PENDING — needs Sư Huynh on a real Chrome
Not run (no Chrome profile / display for the implementing user). Steps:
1. Start the app (it runs `readOrCreateToken` → server → `installExtension`, writing `<userData>/extension/pair.json`).
2. In the Chrome profile logged in to Flow: open `chrome://extensions` → enable Developer mode → Load unpacked → `<userData>/extension`.
3. Open https://flow.google.com in a tab.
Check:
- [ ] App shows "Đã kết nối"; extension id equals `EXT_ID` (ext-id.ts).
- [ ] Quit and restart the app: extension reconnects within 30 s.
- [ ] `pair.json` is re-read after the port changes (unpacked extension serves files from disk).
- [ ] A generate goes over XHR (not fetch) and `sent`/`response` events arrive.
- [ ] Main-world `arm` / `trusted` click path works end to end.

## P1 gate — Linux (2026-11-08, HEAD 4c61fd5)

**Tóm tắt (VI):**
- Trên Linux, cả 5 bộ kiểm tra đều chạy qua, không lỗi nào.
- Trong 19 mục nghiệm thu của P1, 15 mục có test thật (dùng driver giả, bản thật làm ở P2); 4 mục (AC-01, 06, 07, 18) chưa có test đủ ý nên ghi là CHƯA CÓ TEST.
- Còn 2 việc chờ: nối extension trên Chrome thật (cần Sư Huynh) và chạy lại bộ test trên Windows.

### (a) Command results
| Command | Result |
|---|---|
| `npm test -w apps/desktop` | 9 files, 128 tests passed |
| `node --test` in packages/flow-protocol | 53 pass, 0 fail |
| `node --test` in apps/extension | 10 pass, 0 fail |
| `cd apps/desktop && xvfb-run -a npm run e2e` | 7 passed |
| `python3 docs/app/verify-docs.py` | PASS (10 chapters, 22 requirements, 36 acceptance cases; documents only) |

### (b) AC table (all runner/driver evidence is fake driver, live in P2). Paths relative to repo; desktop = apps/desktop.
| AC | Text (short) | Status | Evidence |
|---|---|---|---|
| AC-01 | Only the permitted, correct tab binds among wrong provider/project tabs; missing login/project gives a CTA | NOT COVERED | Needs connector integration + live. Only `connector.test.ts` token/origin rejection and `runner.test.ts` "target changed blocks click" exist; no tab-selection/binding test. |
| AC-02 | TXT UTF-8/BOM, CRLF/LF, blank lines, Vietnamese, bad content: textarea/TXT same mapping, keep sourceLine, no implicit enqueue/submit | PASS | desktop/test/batch.test.ts: "CRLF and LF give the same items", "BOM stripped only at start", "invalid utf-8 is an error, not replaced", "parsePrompts keeps NFD and NFC as-is", "enqueue stores sourceLines and validates length", "prompts are not trimmed; string BOM stripped"; ipc.test.ts "dryRun previews without creating…". No UI-level TXT file import test (parser takes bytes and string). |
| AC-05 | Enqueue crash in transaction / draft edited after run: no partial batch; old settings/refs unchanged | PASS | desktop/test/batch.test.ts "enqueue is atomic and idempotent" (fault injected at 2nd item insert → 0 rows; retry idempotent; settings snapshot stored), "enqueue storage contract". No process-restart step. |
| AC-06 | Second app launch only focuses old window; only newest connection gets commands, old epoch rejected; takeover recovers without resend | NOT COVERED | Covered parts: connector.test.ts "newest connection wins: old closed, epoch up, pending of old rejects, late old reply ignored"; uncertain.test.ts "stale epoch response ignored…". Not covered: single-instance (`requestSingleInstanceLock` in src/main/index.ts has no test); lease/lock takeover. |
| AC-07 | Driver goes waiting → ready → download error; UI does not equate ready with saved; no fake 100% success | NOT COVERED | State progression is tested (runner.test.ts "video waits for receipt per tab"; e2e "textarea batch runs to ready") but no test for ready-vs-saved or download failure (no download path in P1). |
| AC-08 | Pause at queued/preparing/accepted and at permit hand-off: no new permit after fence; handed-over permit may have sent, not fake cancelled; resume checks stage | PASS | desktop/test/runner.test.ts "pause fences new clicks but follows sent ones"; "SUBMIT_LISTENER_MISSING pauses once; resume clicks the next…"; uncertain.test.ts "I1: a user pause survives the uncertain attempt being resolved"; "R25: a stale pause admission does not pause on a later throttled response after stop". Exact hand-off-instant ordering not separately tested. |
| AC-09 | Stop before click / after accepted / while uncertain: unsent cancelled, sent not fake cancelled, uncertain keeps blocker | PASS | runner.test.ts "stop cancels unsent only", "stop while the click is pending ends uncertain and blocks the project", "a sent already received when stop is ticked is processed before skip: never cancelled"; flow-protocol/test/attempt.test.mjs "stop: cancels only what surely was not sent". |
| AC-10 | Crash before/after intent, after click before ACK, after output before write: no auto-resubmit; archive needs confirmation, keeps blocker over restart | PASS | uncertain.test.ts "crash after intent commit, before click: recover makes it uncertain, no click…", "restart reschedules overdue reconcile, and rebuilds a lost target_block", "archive releases runner immediately but keeps block", "rerun needs confirmation and links the old attempt"; runner.test.ts "connector drop during click is uncertain"; attempt.test.mjs "D-04 restart: intent without receipt → uncertain…", "crash between intent and a journaled click…". "Crash after output before write" has no dedicated test. |
| AC-11 | Login/captcha/consent or auto off → manual fallback: opens right tab, re-check is not a submit, user ACK is no fake receipt | PASS | runner.test.ts "auto off means no click", "manual intent arms the tab…(awaiting_user → sent → ready)", "skip disarms the tab…", "manual skip with no send from the page is still cancelled"; attempt.test.mjs "manual: intent waits for the user…", "manual skip after reload is uncertain". Login/captcha pages themselves are live-only. |
| AC-17 | Batch with many attempts/errors reopens after restart with correct trace, history not rewritten | PASS | desktop/e2e/smoke.spec.ts "history survives restart" (prompt, config, SUBMIT_UNCERTAIN error, journal timestamps after relaunch). |
| AC-18 | Missing key / wrong schema / mid-job config update: block the operation, keep attempt version, update only at safe boundary | NOT COVERED | profile.test.ts "each drift reason…", "version mismatch / missing ⇒ RELOAD_TAB" cover the validation/block half only; no test for keeping attempt config version or safe-boundary update. |
| AC-20 | Aggregate batch status for success/mixed/auto-download off/stopped/unresolved; unresolved never completed/stopped early | PASS | runner.test.ts "batch status follows 02 §5" (table-driven, 8 outcomes); e2e "uncertain shows confirm buttons" (batch held while first item unresolved). Auto-download-off row not present. |
| AC-22 | Regenerating accepted/uncertain/failed: no auto-retry, cost confirmation, history/blocker kept, archived old target not rerunnable, new target is a draft | PASS | uncertain.test.ts "rerun needs confirmation and links the old attempt" (TARGET_BLOCKED until confirmed, ALREADY_RERUN, source_attempt_id link), "C1: a send deadline fences the tab, so the late sent/response of A never bind to B". Draft-for-other-target path not tested. |
| AC-23 | SPA/project/tab changes during await: re-check target revision before effect, no silent retarget | PASS | runner.test.ts "target changed blocks click" (TARGET_CHANGED → paused, 0 clicks), "disconnected fences attempts awaiting a response on that tab"; uncertain.test.ts "a click that throws without a disconnect still fences the tab". Real SPA race is live (P2). |
| AC-29 | Storage rejects intent commit / crash at durability boundary: no submit without durable intent; recovery never assumes "not sent" | PASS | journal.test.ts "intent write failure blocks click", "wal and full sync"; runner.test.ts "intent write failure blocks click" (0 clicks, STORAGE_UNAVAILABLE, paused); uncertain.test.ts "crash after intent commit, before click…"; attempt.test.mjs "dead observer before intent: refuse…". |
| AC-30 | Stale-epoch callback after takeover/stop does not overwrite new owner state or release blocker | PASS | uncertain.test.ts "stale epoch response ignored; the next click carries the new epoch", "R38: a restarted runner seeds epochs from the clock…"; connector.test.ts "newest connection wins… late old reply ignored"; runner.test.ts "a duplicate delivery of a settled response changes nothing". |
| AC-32 | With research-source domains/backend blocked: app boots, saves draft, runs driver without their license/config | PASS | desktop/e2e/smoke.spec.ts "no outbound network" (every request is file:/devtools:/ws://127.0.0.1) and "real mode survives a connector failure…". Asserts zero non-local traffic, not a named-domain block. |
| AC-35 | Image then video batch: in-flight ≤ cap (default 1 tab 8 video/12 image; fast 4 tabs 20/30), per-tab wait receipt, throttle lowers cap, pause blocks new but follows sent | PASS | runner.test.ts "image batch respects cap 12 and sends next after sent", "video waits for receipt per tab", "fast mode uses 4 tabs and caps 20/30", "throttle halves cap and resends same attempt after backoff", "pause fences new clicks but follows sent ones". Fake driver only; live in-flight count is P2. |
| AC-36 | Batch A uncertain + batch B other project; kill & reopen: intents → uncertain, 0 resends, B runs, A's project blocked; unblock after 10-min reconcile or user confirm; credit stays spent | PASS | uncertain.test.ts "uncertain releases runner to a batch on another project", "reconcile after 10 minutes: found resumes batch", "not found waits for user; confirm not_sent unblocks and never re-clicks that attempt", "crash after intent commit…", "restart: a batch paused only by an uncertain attempt auto-resumes once reconcile settles it". |

### (c) Gate rows still open
- Extension connects/reconnects on Windows and Linux → **PENDING** (Task 9 Step 5, needs Sư Huynh).
- Windows run of the suites → **PENDING** (Task 12 Step 2, needs a Windows machine).
