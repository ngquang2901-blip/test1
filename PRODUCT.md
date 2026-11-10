# ToolFlow — product truth

> Inferred from the repository and conversation; the owner said "làm đi" (proceed) instead of answering the interview. Lines marked *(inferred)* are hypotheses to confirm.

## What it is
Desktop app (Electron, Windows + Linux) that runs batches of prompts through Google Flow in the user's own Chrome: it fills the composer, clicks Send (auto) or waits for the human click (manual), follows every send to its result, and downloads the files. A thin Chrome extension is the only bridge to the page.

## Mechanism that makes it different
Every send is journaled before the click and reconciled after, so nothing is ever sent twice and nothing is silently lost: uncertain sends stop the batch and ask the human. Safety and honest status are the product, speed second.

## Primary user *(inferred)*
The owner (Vietnamese, addressed as "Sư Huynh"), a content maker producing realistic, everyday-style AI images and videos; vibe-codes, knows a little code. Runs batches of tens to a few hundred prompts at his desk, with the app window beside a dark Google Flow tab, checking in now and then rather than watching continuously.

## Jobs, in order of frequency
1. Paste prompts (and pick reference images), check the preview, start a batch.
2. Glance at progress: which items are done, waiting for a human, uncertain, failed.
3. Resolve a stop: confirm sent / not sent, allow a re-upload, rerun at a cost.
4. Download results and find the files.
5. Rarely: connect the Chrome tab, toggle auto, speed.

## Durable constraints
- All UI copy in Vietnamese; plain words, no jargon; every error says what to do next.
- Never claim "Đã lưu" / 100% before files are on disk; costly actions take a second, deliberate step with focus on Huỷ.
- Keyboard-reachable everywhere (AC-27); no window.alert/confirm.
- No network fonts or CDNs (CSP `default-src 'self'`); no secrets/URLs in the UI.
- e2e tests locate controls by their Vietnamese labels: renaming a label means updating tests.

## Platform
web (Electron renderer, desktop window ~1000×720 and up). No mobile.

## Stack
React 19 + plain CSS (no UI library). Delegated: keep it dependency-free.
