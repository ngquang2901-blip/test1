# ADR-0002 — Auto-submit Flow bằng cách gọi listener với `isTrusted` giả (D-12)

- **Trạng thái:** XÁC NHẬN (người dùng, 06/11/2026). Spike đạt; app chưa triển khai.
- **Thay thế:** [ADR-0001](0001-manual-submit-khi-auto-chua-qualify.md) cho Google Flow. ChatGPT không thuộc ADR này.
- **Nhật ký:** [09 — D-12](../09-evidence-and-decisions.md)

## Bối cảnh

Manual submit ([ADR-0001](0001-manual-submit-khi-auto-chua-qualify.md)) chạy được nhưng mỗi lượt cần một người bấm. Với lô prompt lớn, cách này mất mục đích của tool. Spike 01 đã loại CDP (bị reCAPTCHA gắn cờ) và event tổng hợp (bị Flow bỏ qua).

TobyFlow tự động hoá Flow bằng cách gọi thẳng hàm xử lý click mà Angular gắn vào nút Gửi, với event báo `isTrusted:true` ([04 §4.3](../../research/04-google-flow-dom-v1.md)). Người dùng **chấp nhận rủi ro ToS và rủi ro bị khoá tài khoản** để dùng cách này cho Flow.

## Quyết định

Với Flow, auto-submit là đường chính và manual là dự phòng. Cơ chế:

1. Một script ở **MAIN world, `document_start`** ghi lại các listener `click` mà trang gắn lên `<button>`.
2. Khi runner đã ghi intent, script gọi đúng listener của `flow-prompt-box button[type=submit]` với `Proxy(MouseEvent)` báo `isTrusted:true`.
3. **Không chạm reCAPTCHA**: token vẫn do Flow tự lấy. Không humanize hay giả hành vi để né chấm điểm.
4. Không dùng `chrome.debugger` trên tab Flow.

### Ràng buộc bắt buộc (không có thì không được bật auto)

| Ràng buộc | Lý do (bằng chứng) |
|---|---|
| Fail-closed: không tìm thấy nút, nút `disabled`, hoặc listener ≠ 1 thì không gọi gì, báo `CONFIG_INCOMPLETE`. Không fallback sang `click()`/Enter. | Probe khi editor rỗng trả `called:0`. |
| Ghi intent bền vững trước khi gọi listener; mỗi intent một lần gọi. | Quy tắc gửi đúng một lần ở [07](../07-safety-and-recovery.md). |
| Lệnh đọc trạng thái và lệnh bấm là hai API tách biệt. Chỉ intent đã ghi mới gọi được lệnh bấm. | Lượt 29b: một lệnh "xem trạng thái" đã bấm Gửi thật. |
| Ngay trước khi bấm, kiểm: prompt khớp nguyên văn, nút bật, không có `button.prompt-warning-button`, chip ref đúng **media id** mong muốn, observer network còn sống. Heartbeat ([`heartbeat.mjs`](../../../packages/flow-protocol/src/heartbeat.mjs)): hook XHR/fetch còn là của mình, ping mới hơn 5 s; ping sau khi bấm phải cùng `id` observer (trang không reload) và `dropped` không tăng, nếu không thì `SUBMIT_UNCERTAIN`. Máy trạng thái của attempt: [`attempt.mjs`](../../../packages/flow-protocol/src/attempt.mjs). | Lượt 17B gắn nhầm ref do danh sách asset đổi thứ tự; lượt 30 có prompt bị gõ chồng; lượt 32 đạt cả 5 điều kiện. |
| Receipt lấy từ network: request generate `sent`, rồi response lặp lại seed/UUID batch cuối. Không gán chủ kết quả theo nhãn tile hay grid của tab khác. | Lượt 16: ghép đúng kể cả khi prompt trùng. Tile video không có media id; tab khác không cập nhật pending. |
| Parse response theo vị trí có kiểm tra; sai mẫu thì báo `PROTOCOL_DRIFT` và dừng. Parser và fixture: [`packages/flow-protocol`](../../../packages/flow-protocol/src/parse.mjs). | Lượt 32: regex cứng làm mất seed (field sau seed là mã tỉ lệ: 1 = 1:1, 2 = 9:16, xác nhận ở lượt 33). |
| Bấm rồi mà không thấy request (`SUBMIT_UNCERTAIN`) thì **không tự gửi lại**; đối soát grid/server trước. | Lượt 30: một lượt "uncertain" thực ra đã render. |
| Upload ref: đặt **tên file duy nhất** cho mỗi upload (ví dụ theo assetId). Media id lấy từ response upload, so với tên file. | Lượt 34: response `maseQ` không lặp UUID nào của request, chỉ lặp tên file. |
| Phân loại lỗi theo mã trong response, không theo chữ trên tile. | `USER_REQUESTS_THROTTLED` hiện chữ "Flow đang có lượng truy cập cao". |

### Phân loại lỗi và hành động

Nguồn chân lý là [`packages/flow-protocol/src/errors.mjs`](../../../packages/flow-protocol/src/errors.mjs). File này map **đủ 70 mã `PUBLIC_ERROR_*`** trong enum frontend Flow vào danh mục ở [07 §2](../07-safety-and-recovery.md). Test so bảng với enum trong [mã nguồn đã thu](../../research/evidence/native-sources/manifest.json), nên Flow thêm hoặc đổi mã là test báo ngay. Tóm tắt:

| Tín hiệu | Mã ToolFlow | Hành động |
|---|---|---|
| Response generate trả `USER_REQUESTS_THROTTLED`, `HIGH_TRAFFIC`, `MODEL_OVERLOADED`, `CONCURRENT_LIMIT_REACHED` (HTTP 200, gRPC 8) | RATE_LIMIT | giảm một nửa số lượt đang chạy; tự gửi lại đúng lượt đó theo ngoại lệ [07 §3](../07-safety-and-recovery.md): backoff 30 s → 5 phút, tối đa 5 lần |
| Quota (`USER_QUOTA_REACHED`, `PER_MODEL_DAILY_QUOTA_*`, `VERTEX_QUOTA_*`…) | RATE_LIMIT | pause admission, không đoán thời gian reset |
| Bộ lọc nội dung, ref bị chặn (`SEXUAL`, `MINOR*`, `*_UPLOAD`, `*_INPUT_IMAGE`…) | CONTENT_BLOCKED | chốt lỗi lượt đó, hàng đợi tiếp tục |
| `UNUSUAL_ACTIVITY`, `UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC`, `USER_BANNED` | HUMAN_REQUIRED | **dừng toàn bộ auto** trên profile, chuyển manual, báo người dùng |
| `GENERATION_ALREADY_IN_PROGRESS` | SUBMIT_UNCERTAIN | pause, đối soát |
| Poll status `[4,[13,"INTERNAL"]]` | PROVIDER_ERROR_UNKNOWN | chốt lỗi lượt đó (Flow hoàn credit); **không** tự gửi lại vì generation đã tồn tại |
| `button.prompt-warning-button` "không đủ tín dụng" | RATE_LIMIT | chưa gửi gì; pause các mode tốn credit |
| Mã lạ, listener ≠ 1, observer chết, `ProtocolDrift` | PROVIDER_ERROR_UNKNOWN / CONFIG_INCOMPLETE | tắt auto, cần qualification lại |

### Mặc định song song (ĐỀ XUẤT, theo số đo của 1 tài khoản Pro)

- Mỗi tab gửi lần lượt: chờ receipt rồi mới gửi lượt kế tiếp. Riêng video, Flow client tự xếp hàng khoảng 6 giây mỗi lượt.
- Mặc định 1 tab; video tối đa 8 đang render, ảnh tối đa 12 đang chạy và tối đa 1 ảnh/s. Người dùng mới được mở thêm tab.
- Trần đã đo: video khoảng 25–28 đang render; ảnh dồn khoảng 35–45 ảnh thì bị throttle. Đây là số đo, không phải giới hạn được Google công bố.

## Phương án đã cân nhắc

| Phương án | Kết quả |
|---|---|
| Manual submit ([ADR-0001](0001-manual-submit-khi-auto-chua-qualify.md)) | Giữ làm dự phòng; không đạt mục tiêu chạy lô. |
| CDP `Input.dispatchMouseEvent` | Bị `UNUSUAL_ACTIVITY` (lượt 1, 4–6); phiên từng gắn debugger vẫn bị chặn dù người bấm (lượt 8–9). |
| `element.click()` / Enter / PointerEvent tổng hợp | Flow bỏ qua, không có request. |
| Gọi native RPC trực tiếp | Ngoài phạm vi bản đầu ([09](../09-evidence-and-decisions.md), D-02); phải tự lo token reCAPTCHA, dễ bị coi là né kiểm tra. |

## Hệ quả

- **Rủi ro được chấp nhận:** vi phạm ToS, tài khoản có thể bị khoá. App phải nói rõ điều này khi người dùng bật auto, và tách profile test khỏi profile chính.
- **Phụ thuộc vào cấu trúc nội bộ của Flow:** cách Angular gắn listener, selector, mã RPC, định dạng response. Flow cập nhật là có thể hỏng. Cần bộ qualification chạy lại được và các tín hiệu tắt auto ở bảng trên.
- Extension khác cài trong cùng profile có thể can thiệp. TobyFlow đổi tên file tải về, nên app phải đọc `actualName` từ `downloads.search`.
- Script MAIN world phải nạp trước Angular: sau khi cài hoặc cập nhật extension phải reload tab Flow.
- Mọi quy tắc intent, chống gửi trùng và phục hồi ở [02](../02-domain-and-state.md)/[07](../07-safety-and-recovery.md) vẫn áp dụng như với manual.

## Bằng chứng

[spikes/01-flow-cdp/FINDINGS.md](../../../spikes/01-flow-cdp/FINDINGS.md), lượt 13–32 trên Chrome Profile 2:

- Auto hoàn toàn với ảnh, video text, video Start frame và video Thành phần có ref; tải được JPEG/MP4.
- 199 request generate tự động trong 1 ngày; 0 lần `UNUSUAL_ACTIVITY`.
- 7 request bị throttle trong 3 đợt (gửi lại đều được); 3 video `INTERNAL` đã được hoàn credit.
- Cơ chế spike nằm ở [`extension/main-world.js`](../../../spikes/01-flow-cdp/extension/main-world.js). Đây là code dùng một lần, không phải code sản phẩm.

## Xem lại khi

- Xuất hiện `UNUSUAL_ACTIVITY`, cảnh báo tài khoản, hoặc tài khoản bị khoá.
- Số listener trên nút Gửi ≠ 1, hoặc request/response không còn khớp mẫu đã qualify.
- Có tài khoản gói khác cần chạy (trần có thể khác).
- Google công bố API chính thức hoặc đổi điều khoản về tự động hoá.
