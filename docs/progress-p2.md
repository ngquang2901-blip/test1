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
