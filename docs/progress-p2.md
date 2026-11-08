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
| AC-03 settings before send | PASS (image) | combo gate tests + live settings round trip x2→x1→x2 |
| AC-04 ref pool mapping | PARTIAL | mapping + pick-refs + e2e; `start` mode untested, video refs refused |
| AC-10 crash / recover / archive | PASS (offline) | recover + archive tests |
| AC-11 manual mode right tab | PASS | tests + live manual 2/2 |
| AC-12 end-to-end image batch | PARTIAL | live auto 3/3, manual 2/2 (no refs); the generate WITH a reference was rejected by Flow (UNUSUAL_ACTIVITY), live generation paused |
| AC-14 output ownership | PARTIAL | correlate tests + real receipts; no live interleaving |
| AC-15 downloads | PARTIAL | tests + 2 live WEBP downloads 1376×768; no live JPEG/PNG, no video |
| AC-16 retry never re-generates | PASS | call-spy test + e2e |
| AC-18 broken config | PASS | config/profile tests |
| AC-22 confirmations / rerun | PARTIAL | confirm + cost tests, e2e |
| AC-25 upload fault tolerance | PARTIAL | fault injection + live ref bind (upload/attach OK) but generate with ref not accepted by Flow |
| AC-26 lost download ACK | PASS (fixtures) | downloads tests + e2e |
| AC-28 naming / host paths | PARTIAL | Linux naming tests; Windows host not run |
| AC-34 live image + ref | PARTIAL | live auto/manual without refs; ref variant fake-page only |

Final review: `.superpowers/sdd/2026-11-09-p2-live-image/final-review.md` (0 Critical, 4 Important fixed in `fb9b8ce`).
