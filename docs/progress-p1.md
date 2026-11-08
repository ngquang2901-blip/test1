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
