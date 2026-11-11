# P2 progress

Branch `p2-live`. Plan: `docs/superpowers/plans/2026-11-09-p2-live-image.md`.

## Task 4 — first live image batches (2026-11-09, Linux, Chrome Profile 1, product runner via `npm run live-batch -w apps/desktop`)

Prints states/ids only (no URLs, bodies, tokens). Image combo: Image / Nano Banana 2.1 / 16:9 / High / x2 (2 images per send).

| Run | Prompts | Result | Time | Journal (per item) |
|---|---|---|---|---|
| AUTO (app clicks Gửi via the trusted listener) | 3 | 3 × `ready/outcome_known`, batch `completed`, self-check ok, no uncertain, no UNEXPECTED_GENERATE | 24 s | intent, prepare, clicked, sent, receipt |
| MANUAL (app arms + focuses tab; a physical mouse click on Gửi) | 2 | 2 × `ready/outcome_known`, batch `completed` | 29 s | intent, prepare, sent, receipt (no `clicked`, by design) |

Observed: sends are issued back-to-back (cap 12 images in flight), responses arrive ~20 s later; the double-send guard (`ping.gen` vs accounted sends) never tripped across 5 sends, including manual sends from the page. The Flow project gallery showed the new 2-image pairs for every prompt.

Cost: 10 images (5 sends × 2) in the user's Flow project.

## Lessons
- A locked desktop session makes `xdotool` clicks silently miss (the Chrome extension stays on old code). Take a screenshot first; if the lock screen shows, ask the user to unlock — never type the password.
- After the extension files change: copy files, reload the extension at `chrome://extensions`, then F5 the Flow tab; verify with `SC=1` (live-probe) that `ping` contains the new fields.
- `better-sqlite3` must be `--external` when bundling scripts with rolldown.

## Still open for P2 (tasks 5–8)
Ref images (upload + attach, AC-04/25), output ownership binding (AC-14), downloads (AC-15/16/26/28), gate on Linux + Windows, AC-01 multi-tab selection, AC-10/11/18/22 UI proofs.

## Task 5a — reference images, live findings (2026-11-09)
- Upload: op `file` how=`drop` uploads to the library only (reliable). `paste` is not used (chip not guaranteed, Q-32).
- Attach: library popover (`flow-add-menu-popover-content`), search by the unique upload name, click the item, then the popover button `Add to prompt`. For a FRESH upload the library lists the item at once but the Add button does nothing for ~10–15 s, so the click must be repeated while no chip exists; the chip itself shows up before its image src (media uuid) is readable. Both fixed in `apps/extension/ref-logic.js` with tests (never re-click once any chip exists, so a slow chip cannot be added twice).
- Result: asset binding reached `bound` and `prepare` passed (chip set == bound media ids) on the real tab.
- **Generate with a reference was REJECTED by Flow**: grpc 7 `PUBLIC_ERROR_UNUSUAL_ACTIVITY`; tile text "We noticed some unusual activity. Note that browser extensions that modify the page may cause issues … You have not been charged". The 5 earlier sends without refs (auto + manual) had been accepted. Per our safety rule (`HUMAN_REQUIRED` / stop_profile) live generation is STOPPED until the owner decides; no retries were made after the rejection. Hypotheses (unverified): the synthetic drop/click events used for upload/attach, or 3 auto sends within seconds earlier, or normal reCAPTCHA scoring noise.
- Side effect: ~7 small apple PNG uploads (`tf-*.png`) and 2 failed tiles in the user's Flow project; no credit charged.

## Task 7 — downloads, live check (2026-11-09; no generation, no credit)
`npm run live-dl -w apps/desktop` downloads existing outputs through the PRODUCT pipeline (`requestDownload`: intent row → extension `fetchMedia` → `chrome.downloads` → desktop magic-byte check → move without overwrite).
- Tile images are served as `https://flow.google.com/asb/<key>=s1600-rw` (same-site, cookie-authenticated); the extension allowlist now accepts only that path on flow.google.com (the app's own API paths stay refused). The URL never leaves the extension; the failure result carries the host name only.
- Result: 2 outputs → `completed`, ~0.8 s each, ~166 KB, file type **WEBP** (not PNG), temp folder emptied. `locate` reports natural size 1376×768 = the receipt size.
- AC-15/AC-16 partly proven live (real file, magic bytes, name planned once, temp file moved). Still to prove: JPEG/PNG variants, a lost-ACK on real Chrome, Windows path rules on a Windows host (planName is unit-tested for them).

## Known limits carried over
From the P2 final review, deliberately not fixed in P2 (carried to P3):
- **Guard baseline is taken after `prepare`** (runner.ts dispatch): on the first dispatch per page, and after every fence, a generate the page makes during the long prepare is absorbed into `genBase`. P3: ping before prepare and compare once more after.
- **Page-side attach worst case (~79 s) exceeds the server budget (50 s)** (page-ops.js `attach` / ref-logic.js vs server.ts): after the timeout the page may still add a chip while the next prepare clears it. The final chip-set check catches it; P3: shrink `maxRounds` or raise the budget.
- **`tick()` backlog**: a run is queued every 200 ms even while one is in progress; with prepares of 10–150 s the backlog grows (each run also triggers `scan`). P3: coalesce by returning the pending promise.

## P2 acceptance evidence (Linux gate + live, honest status)

Gate on Linux at `fb9b8ce`: unit 290, flow-protocol 53, extension 61, typecheck clean, e2e (fake driver) 19, pairing with real Chrome OK. Windows gate: **PENDING** (owner runs `node apps/desktop/scripts/gate.mjs`).

| AC | Status | Evidence |
|---|---|---|
| AC-01 pick the right Flow tab | PARTIAL | tabs/grants tests, e2e, live `focus`; no live wrong-project tab |
| AC-03 settings before send | PASS (image) | combo gate tests + live settings round trip x2→x1→x2; since 2026-11-11 the model is picked too and three models are qualified per value (see "Workflow canvas, round 3") |
| AC-04 ref pool mapping | PARTIAL | mapping + pick-refs + e2e; `start` mode untested, video refs refused |
| AC-10 crash / recover / archive | PASS (offline) | recover + archive tests |
| AC-11 manual mode right tab | PASS | tests + live manual 2/2 |
| AC-12 end-to-end image batch | PASS (image) | live auto 3/3, manual 2/2 (no refs); with ONE reference: manual 1/1 and auto 1/1 (see re-test below) |
| AC-14 output ownership | PARTIAL | correlate tests + real receipts; no live interleaving |
| AC-15 downloads | PARTIAL | tests + 2 live WEBP downloads 1376×768; no live JPEG/PNG, no video |
| AC-16 retry never re-generates | PASS | call-spy test + e2e |
| AC-18 broken config | PASS | config/profile tests |
| AC-22 confirmations / rerun | PARTIAL | confirm + cost tests, e2e |
| AC-25 upload fault tolerance | PASS (offline faults + live happy path) | fault injection tests; live upload → bind → generate accepted, 1 upload per run |
| AC-26 lost download ACK | PASS (fixtures) | downloads tests + e2e |
| AC-28 naming / host paths | PARTIAL | Linux naming tests; Windows host not run |
| AC-34 live image + ref | PASS (image, 1 ref) | live auto 1/1 and manual 1/1 with a reference chip; multi-ref / start-frame untested |

Final review: `.superpowers/sdd/2026-11-09-p2-live-image/final-review.md` (0 Critical, 4 Important fixed in `fb9b8ce`).

## Re-test of the generate WITH a reference (2026-11-09, ~2 h after the rejection)
Same product runner, same Chrome profile, current extension (after the final-review fixes), no code change in between except the review fixes.
- **MANUAL**, 1 prompt + 1 ref: upload → bound → chip verified → human click on Gửi → `sent` → `receipt` in 43 s, batch `completed`; 2 new tiles in the project.
- **AUTO**, 1 prompt + 1 ref: upload → bound → trusted click → `sent` → `receipt` in 39 s, batch `completed`; journal intent/prepare/clicked/sent/receipt.
- The earlier `UNUSUAL_ACTIVITY` (grpc 7) did not repeat. Not reproduced, cause unknown. Most likely candidates: a stale extension build in the tab at that moment (several reloads that hour), or Flow's risk scoring right after ~15 sends in a few minutes. Treat as an intermittent Flow-side rejection: the product already stops (HUMAN_REQUIRED, no auto-retry) and shows the hint.
- Cost: 4 images (2 sends × 2) + 2 small reference uploads. Total P2 live spend ≈ 14 images.
- Live generation is no longer paused; keep batches small and spaced.

## Windows gate (2026-11-10)

`main` at `c9a33f6` (UI redesign + Windows symlink tests): owner reports `gate.mjs` 6/6 PASS on Windows (Node v22.23.4, normal PowerShell); `test/downloads.test.ts` 48/48 seen in pasted output.

## Live run through the real app UI (2026-11-10, Profile 2 `ng***`, owner-approved)

Real Electron app (no fake driver), Playwright on the app window, the user's Chrome tab on a Flow project. Run 1: `SETTINGS_MISMATCH` on both items, nothing sent: this account shows Flow in Vietnamese (`Hình ảnh`, `Thấp/Trung bình/Cao`) and the settings logic only knew English labels. Fixed with a label alias map (`apps/extension/settings-logic.js`, test from the live panel). Run 2: self-check ok, auto, 2 prompts → 2 × `Có kết quả` in 30 s, Tải tất cả → 4 JPEG 1376×768 (294–346 KB) in `~/Downloads/ToolFlow`, Kết quả shows the 4 thumbnails read from disk. 4 image credits.
Also found and fixed: S1 did not refresh when the extension connected (only on window focus); it now re-reads the session every 3 s until paired with a granted tab. Hooks on the Flow home page read `false`; on a project page they are `true` (earlier hypothesis about TobyFlow/Translate not needed).

## Reference images live, pairing token, thumbnails (2026-11-10, Profile 2 `ng***`)

- Ref run 1: `REF_NO_ADD`, nothing sent: the library confirm button reads `Thêm vào câu lệnh` on a Vietnamese account. Fixed (`TFRef.isAddLabel`, test). Ref run 2, ONE manual send (one human-style click): `ready/outcome_known` in 60 s, binding `bound`, Flow made 2 images of the reference motorbike in night rain. Then one AUTO send with the same ref: `ready` in 47 s, journal intent/prepare/clicked/sent/receipt. No `UNUSUAL_ACTIVITY` this time. 4 image credits.
- Pairing token moved out of the WebSocket URL into a subprotocol (`toolflow.v1` + `tf.<token>`); a right token in the URL is now refused. Real Chrome reconnected in 15 s with the new extension.
- S4 thumbnails: main shrinks the saved image to 640 px JPEG (`nativeImage`), about 100 KB each instead of the full ~400 KB file; formats Electron cannot decode fall back to the full file.
- Two `tf-…` uploads were left in the Flow project library (one from the failed ref run).

## New features (2026-11-10, before P4)

- **Ghép prompt từ mẫu** (`renderer/src/template.ts`, `TemplateBuilder.tsx`): `{biến}` + one value list per variable; every combination (max 2000) or line by line; fills the prompt list. Unit + e2e.
- **Mẫu lô** (`preset` table, IPC list/save/deletePreset): kind, mode, refs (ids, mode, perItem), template. Saved by name (same name updates); shown in Tạo lô and as cards in Bắt đầu nhanh; a ref whose file record is gone is skipped with a notice. Never stores paths for the renderer.
- **Several tabs / accounts**: one WebSocket per Chrome profile (extension sends `tfi.<8hex>` from `chrome.storage.local`; tab ids become `<inst>:<tab>`; `tabs`/`downloads` asked of every profile). Grants up to the speed cap (Mặc định 1, Nhanh 4). A new list is split line i → project i mod n into one batch per project (`settings.split`, user line numbers kept); each tab only takes batches of the project it shows (`runner.projectOf`). Auto on/off covers every granted account. Download reconcile by id prefers the file with our prefix when two profiles share an id.
- Live, no credits: Profile 1 (`nt***`, English Flow) and Profile 2 (`ng***`, Vietnamese Flow) connected at once, both tabs granted, self-check ok. A live split batch is not run yet (no credits).
- Fixed on the way: Tạo lô lost the typed text when leaving the screen within 400 ms; S1 test now expects "no tab ⇒ no batch".

## P4: installers (2026-11-11)

`ToolFlow-0.4.0-Setup.exe` (127 MB), `ToolFlow-0.4.0-x86_64.AppImage` (134 MB), `ToolFlow-0.4.0-amd64.deb` (107 MB), built on Linux (docs/packaging.md). New first-run panel in S1 (steps + extension folder path + Chép đường dẫn / Mở thư mục). Packaged checks: fresh userData shows setup and creates db + extension; with the live userData the packaged app paired with real Chrome in 3 s and showed 4 saved thumbnails; deb control/desktop entry ok; AppImage runs; Windows exe under wine creates db and extension. Open: run the NSIS installer on a real Windows machine. User guide: docs/huong-dan-cai-dat.md.

## Auto-update + dark mode (2026-11-11)

Dark/light/system theme (all colours are tokens). Auto-update via electron-updater: unit (fake updater), e2e (bar, refusal while an attempt waits for Gửi, Để sau, up-to-date, no source), and a real AppImage update 0.5.0 → 0.5.1 from a local server (docs/packaging.md). Update host not chosen yet: `publish.url` placeholder.

## Workflow canvas (2026-11-11)

New screen **Workflow** (TobyFlow-style node canvas, `@xyflow/react`): nodes Text, Ảnh tham chiếu, Tạo ảnh Flow, Tự tải về, Ghi chú; wires text/image → generate, generate → generate (result as reference image), generate → download. `src/main/workflow.ts` validates the graph and compiles it onto the existing batch path: every Tạo ảnh node is one normal batch (same enqueue as Tạo lô, visible in Hàng đợi), run upstream first. A dependent node gets the first saved result of every upstream prompt as refs (max 8) and is skipped, sending nothing, when any upstream prompt has no saved result. Saved workflows: table `workflow`. A running workflow blocks the update restart.

Checked: unit 8 (graph validation, plan, run/skip/fail/stop with fakes, save/list/delete), e2e 2 with the fake Flow (two-node chain with a result ref, saved files, save/reopen, canvas kept across screens; node without a prompt), a real mouse drag between handles, screenshots light/dark. NOT checked: a run against real Flow (no account with credit); the only new step on that path is "downloaded result → registered as a ref asset → uploaded as ref", the rest is the batch path already run live.

Left out on purpose (nothing behind them in ToolFlow yet): video nodes (P3), ChatGPT/Gemini prompt nodes (P5), Grok/Muse, merge video, per-node model/ratio, `@slug` text references, port suggestions, undo/redo, templates gallery. Shortcuts noted in code: nodes run one after another; a run lives in memory (after an app restart its batches continue, later nodes do not start).

## Workflow canvas, round 2 (2026-11-11)

Added to the Workflow screen, from the owner's checklist:
- **File export / import**: `Xuất file` writes `<name>.toolflow.json` (`{toolflow:1, name, nodes, edges, vars}`), `Nhập file` loads one onto the canvas through the same validator as the renderer's graph (`WF_FILE_INVALID` otherwise; nothing is saved or run). Image nodes keep asset ids only, so on another machine they show "Không còn file này" until picked again.
- **Undo / redo**: `Hoàn tác` / `Làm lại` and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (text boxes keep their own undo). One snapshot (nodes, wires, variables) each time the canvas settles, 100 steps, per visit to the screen.
- **Reusable variables**: a variable table in the side panel; `{tên}` in any Text node. Filled in by the renderer before a run with the existing `template.ts` rules (`fillLines`: several values = one prompt per value, every combination); main stores `vars` with the graph. A variable without a value blocks the run and is named on the node.
- **Side panel** (`Cấu hình`): nothing selected = variables; a selected node = its settings. For a Tạo ảnh node it shows main's own dry-run plan (`runWorkflow({dryRun:true})`): the exact prompts, refs, whether results are saved, branch condition.
- **Điều kiện node**: one Tạo ảnh node in, two outputs. "Đủ ảnh" = every prompt of that node has a saved result (they become refs); "Thiếu ảnh" = it ran but a result is missing (failed, filtered): for a fallback prompt, no refs. The side not taken is `bypassed` ("Không chạy"), which is not a failure.

Checked: unit 12 in `test/workflow.test.ts` + `fillLines` in `test/template.test.ts`, e2e 4 Workflow specs with the fake Flow (chain with result ref; missing prompt; variables + side-panel plan + undo/redo + export/import + bad file; Điều kiện with a lost image), two mutations caught, screenshots light/dark. Still NOT run against real Flow (no credit).

Not done: **chat / message node** (needs the ChatGPT automation, P5: nothing to run behind it yet); per-node model / ratio / count (every combo must be qualified on real Flow first); zoom buttons and minimap; dragging a node type from a palette.

## 0.5.2 released (2026-11-11)

Workflow polish: zoom +/- buttons and a minimap, a node type can be dragged from the toolbar onto the canvas (click still adds), undo history survives a visit to another screen. Owner's decision: the chat node is not built now (it needs either ChatGPT web automation, against OpenAI's terms, or the paid API). Released `v0.5.2` on `ngquang2901-blip/test1` as draft → verified 6 assets → public; the packaged app was smoke-tested (Workflow run, variables) and the published 0.5.1 AppImage updated itself to 0.5.2. Gate 6/6: unit 321, e2e 33.

## Workflow canvas, round 3: node settings, more conditions, removing a wire (2026-11-11)

Three additions to the Workflow screen (owner: "làm 1 2 3"):

1. **Removing a wire is discoverable.** A clicked wire turns blue and thicker; the side panel names it (`Text → Tạo ảnh Flow`) with a `Xoá dây này` button; Delete / Backspace still work; the default side panel says how. Undo brings it back.
2. **Per-node settings.** A Tạo ảnh node can carry its own combo (model / aspect / thinking level / count), chosen in the side panel and shown on the node. Stored in the graph (`node.combo`), in saved workflows and in `.toolflow.json`; absent = the app default. `enqueueBatch` takes an optional `combo` and refuses anything not qualified (`COMBO_NOT_QUALIFIED`, nothing created); the runner's gate is unchanged (exact match against the qualified list). The Tạo lô screen still uses the default combo.
3. **Điều kiện asks one of three questions** (`node.cond`, absent = the old behaviour): every prompt has a saved result (`all`); at least one has (`any`, the results that exist become the refs); Flow blocked a prompt for its content (`filtered`, attempt error `CONTENT_BLOCKED`; neither side hands images on). The yes / no side not taken is `bypassed`.

### What "qualified" means now (AC-03)

`profiles/flow.json` gained `choices`: per model, the aspects, thinking levels and counts that may be combined. The qualified list is `combos` plus every cross product of a `choices` entry (100 image combos). A value is listed only after it went through a real send on that model with the product runner, and before every send the settings panel must read back exactly the wanted combo (model included), else `SETTINGS_MISMATCH` and nothing is sent. So: every *value* was sent live per model; not every one of the 100 *combinations* was.

To make this possible the extension's `settings` op now picks the model from Flow's model menu (a Material menu in an overlay; exactly one item with the wanted label is clicked, otherwise the menu is closed and the op reports a mismatch). Models without a thinking level (Pro, 2 Lite) send `quality: null`, which the page must confirm by showing no such radios.

Live sends, account `ng***` (Profile 2, Vietnamese UI), `MODE=auto COMBO=… npm run live-batch`, one prompt each, 45 s apart. All 14 completed; request facts come from the product parser, sizes from the result tile.

| Model (code in the request) | Aspect → code | Thinking level | Count | Outputs | Size |
|---|---|---|---|---|---|
| Nano Banana 2.1 (`BELUGA`) | 9:16 → 2 | Medium | 1 | 1 | not read (tile still loading) |
| | 1:1 → 1 | Low | 3 | 3 | 1024×1024 |
| | 4:3 → 5 | High | 4 | 4 | 1200×896 |
| | 3:4 → 4 | Medium | 1 | 1 | 896×1200 |
| Nano Banana Pro (`GEM_PIX_2`) | 16:9 → 3 | none | 1 | 1 | 1376×768 |
| | 4:3 → 5 | none | 2 | 2 | 1200×896 |
| | 1:1 → 1 | none | 3 | 3 | 1024×1024 |
| | 3:4 → 4 | none | 4 | 4 | 896×1200 |
| | 9:16 → 2 | none | 1 | 1 | 768×1376 |
| Nano Banana 2 Lite (`HARBOR_SEAL`) | 16:9 → 3 | none | 1 | 1 | 1376×768 |
| | 4:3 → 5 | none | 2 | 2 | 1200×896 |
| | 1:1 → 1 | none | 3 | 3 | 1024×1024 |
| | 3:4 → 4 | none | 4 | 4 | 896×1200 |
| | 9:16 → 2 | none | 1 | 1 | 768×1376 |

(2.1 at 16:9 / High / x2 is the default combo, sent live many times before.) The settings panel showed "0 tín dụng" as the cost for all three models on this account. Settings-only checks (no send) of all three models also passed on account `nt***` (Profile 1, English UI); an unknown model name and a thinking level on a model without one were both reported as mismatches with the menu and the panel closed.

### Live run through the real app (same day, `ng***`, auto)

Workflow built in the UI: Text → Tạo ảnh (Nano Banana Pro · 1:1 · x1) → Điều kiện (default) → [Đủ ảnh] Tạo ảnh (Nano Banana 2 Lite · 9:16 · x2, its own Text) → Tự tải về; [Thiếu ảnh] a fallback node. Result in 54 s: first node 1 image 1024×1024; second node ran with **1 reference** (the first node's saved file, uploaded by the app) and gave 2 images 768×1376 showing the same plate and lemon; the fallback showed "Không chạy"; 3 files in `Downloads/ToolFlow`. This is the first real-Flow run of the Workflow screen and of "a saved result becomes the next node's reference".

### Checked / not checked

Gate 6/6 (unit 333, flow-protocol 53, extension 66, typecheck, e2e 36, pairing). New: profile choices, enqueue combo, workflow parse / plan / run for combo and the three conditions (13 mutations of `workflow.ts` caught), ext-driver `quality: null`, extension model picker on a fake DOM (3 mutations caught), fake-driver `blocked` step, 3 e2e (wire removal; node settings to the batch + export/import; "bị Flow lọc" branch, which also caught a broken `codes` query). One older test changed on purpose: `comboQualified` used to refuse the default model at x4 or 1:1; those are qualified now.

Not checked on real Flow: the "bị Flow lọc" condition (no prompt was sent to provoke the filter; the fake's `blocked` reply is the throttle capture with a content reason, not a real capture) and the "có ít nhất một ảnh" condition; sends on account `nt***`; any of this on Windows.

## Capture fixtures pseudonymized before 0.5.3 (2026-11-11)

Found while preparing 0.5.3: the packaged app bundles five capture fixtures (statically imported by `fake-driver.ts`), and those captures still held the Flow project id of the account they were made on, the ids of its media / workflows / batches, and the prompts and titles of that project (280 listing entries, 209 distinct prompts of 5–6 Nov). No credentials: tokens, signatures and content URLs had been redacted at capture time. Releases 0.5.1 and 0.5.2 (public) contain them; the earlier pre-publication scan looked for e-mails, keys and paths only. Owner's decision: scrub first, then release 0.5.3; the two older releases stay until he says otherwise.

Done: `packages/flow-protocol/scripts/scrub-fixtures.mjs` replaced, in all 11 fixtures, 789 ids, 687 texts and 10 upload file names with pseudonyms (same original ⇒ same pseudonym everywhere, so every relation between records holds). Checked by comparing old and new leaf by leaf: 25 327 leaves, 3 530 strings changed, each one exactly its mapped value, nothing else different. Test literals that quoted fixture values were updated; a new test (`fixtures-clean.test.mjs`) fails when a fixture holds anything the script would still replace (two put-back mutations caught). A scan of `packages/` and `apps/` for every original value finds none. Not touched: research notes and evidence under `spikes/` and `docs/tobyflow/` (they still name the project id; they are not part of any build) and the repo's git history (local only).

