# Spike 01 — Lái Flow qua chrome.debugger (THROWAWAY)

Mục đích duy nhất: chứng minh/bác bỏ cách A (extension mỏng + chrome.debugger, desktop giữ logic) trên Flow thật trước khi viết thiết kế. Không phải mã sản phẩm, không có test.

- `extension/`: MV3 relay — tabs, attach/detach, CDP passthrough, downloads, buffer event.
- `server.mjs`: relay `127.0.0.1:17777`; `POST /cmd {op,args}` cần header `X-Token` (đọc ở `.token`).

Chạy: `npm i ws && node server.mjs`, rồi Load unpacked `extension/` trong `chrome://extensions` của Profile 1.
Kết quả ghi ở `FINDINGS.md`.
