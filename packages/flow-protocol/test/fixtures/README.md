# Fixture `flow-protocol`

Bản ghi network **thật** do observer MAIN-world của spike 01 chụp trên Chrome Profile 2, project `b89ba0b5…`, ngày 06/11/2026. Sổ các lượt: [FINDINGS.md](../../../../spikes/01-flow-cdp/FINDINGS.md).

| File | Lượt | Nội dung |
|---|---|---|
| `image-1x1-burst3.json` | 16 | 3 request + 3 response ảnh `ogiZ0b` 1:1 x1; prompt 2 và 3 trùng nhau |
| `image-9x16-x2.json` | 33 | 1 request ảnh 9:16 x2 (2 item, 2 seed) + response 2 ảnh |
| `image-1x1-ref-raw.json` | 34 | ảnh 1:1 x1 có 1 ref; request ở **dạng thô trên dây** (`application/x-www-form-urlencoded`) |
| `upload-maseQ.json` | 34 | upload ref bằng paste: request + response; media id trả về chính là ref trong `image-1x1-ref-raw.json` |
| `video-t2v.json` | 17A | `YhhmEf` text→video Veo 3.1 Lite: request + receipt |
| `video-ingredients.json` | 17B | `MZZa6b` video Thành phần, 1 ref: request + receipt |
| `poll-running.json` | 17 | `jwpduf`: 1 video đang chạy (status 2) |
| `poll-succeeded-2.json` | 17 | `jwpduf`: 2 video đã xong (status 3) |
| `throttled-ogiZ0b.json` | 25 | ảnh bị `PUBLIC_ERROR_USER_REQUESTS_THROTTLED` |
| `throttled-YhhmEf.json` | 28 | video bị `PUBLIC_ERROR_USER_REQUESTS_THROTTLED` |
| `project-Zzl0ze.json` | 35 | `Zzl0ze` danh sách project lúc nạp trang (280 workflow, 280 media: prompt gốc, seed, batch UUID, thời điểm tạo); nguồn cho job đối soát D-11 |

**Đã chỉnh trước khi lưu:**
- Token `at=` (XSRF) thay bằng `<redacted>`. `Signature` trong URL ảnh ký sẵn thay bằng `<redacted>`.
- `project-Zzl0ze.json` (lượt 35, danh sách project): URL nội dung `lh3.googleusercontent.com/...` và `flow-content.google/...` thay bằng `<redacted>`, vì mở được media mà không cần đăng nhập.
- Token reCAPTCHA thay bằng `<long>`. Với body thô, chỉ thay phần token đứng ngay sau `%22` (giữ nguyên dấu nháy đã encode), nên body vẫn decode và parse được.
- Request `req` lưu ở dạng **đã decode** (`decodeURIComponent`); riêng `raw` giữ nguyên dạng trên dây. Upload: base64 ảnh (219 200 ký tự) đã bỏ, giữ cấu trúc.
- Response giữ nguyên văn, đủ cả envelope `)]}'` và frame `["e",…]` cuối.

**Chưa có bản ghi thô** cho:
- Poll thất bại `INTERNAL`: test dựng lại từ một poll thật cộng status tuple in ra ở lượt 21.
- `UNUSUAL_ACTIVITY`: muốn có thì phải để tài khoản bị gắn cờ.
- Các RPC Start/End frame `eb1hJf`/`nprQif`: cần credit video.

Parser hiện **từ chối** các RPC chưa có fixture (`ProtocolDrift`). Muốn thêm hỗ trợ thì chụp fixture thật trước.
