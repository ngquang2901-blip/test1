# Flow composer settings panel (live, 2026-11-09)

Read-only observation with `INSPECT=1 npm run live-probe -w apps/desktop` on a real Flow project page (image mode). Labels only; no account data.

Composer state (`state` op): `text`, `submitDisabled`, `chips[]`, `settings` (trigger button text, e.g. `🍌 Nano Banana 2.1 / crop_16_9 / x2`), `creditWarning`.

Settings panel = `flow-prompt-box-settings` (opened by clicking `flow-prompt-box button.settings-trigger-button`, closed by clicking it again). Its `button` elements, in DOM order, as `[index, role, text, aria-checked]` (the text starts with a Material icon name):

| group | buttons (role=radio) | observed checked |
|---|---|---|
| mode | `image Image`, `videocam Video` | Image |
| aspect | `crop_16_9 16:9`, `crop_landscape 4:3`, `crop_square 1:1`, `crop_portrait 3:4`, `crop_9_16 9:16` | 16:9 |
| model | one dropdown button `🍌 Nano Banana 2.1 arrow_drop_…` (no role) | Nano Banana 2.1 |
| quality | `Low`, `Medium`, `High` | High |
| count | `x1`, `x2`, `x3`, `x4` | x2 |

Notes for the driver:
- Find buttons by **label text**, never by index (Q-31: aspect/other options can jump when mode changes; read every option back after each change).
- After closing the panel `radios` returns `no panel` (the panel is not in the DOM when closed).
- Live-tested combo so far: Image / Nano Banana 2.1 / 16:9 / High / x2 (generates 2 images per send; parser aspect code 3 = 16:9).
- Idle page (no prompt): `submitDisabled: true`; the clear button (`button.clear-button`) only exists while the composer has text.
