# ADR-0001 — Manual submit khi auto-submit chưa qualify (D-08)

- **Trạng thái:** ĐỀ XUẤT · **thay thế một phần** bởi [ADR-0002](0002-flow-auto-submit-trusted-listener.md) cho Google Flow
- **Ngày:** 05/11/2026 (cập nhật trạng thái 06/11/2026)
- **Phạm vi còn hiệu lực:** ChatGPT; Flow khi ADR-0002 bị tắt hoặc không còn đạt điều kiện
- **Nhật ký:** [09 — D-08](../09-evidence-and-decisions.md)

## Bối cảnh

ToolFlow chạy prompt trên web của provider bằng phiên đăng nhập của chính người dùng. Bước gửi (Generate/Send) là chỗ provider kiểm tra người thật: reCAPTCHA Enterprise trên Flow, các lớp chống bot trên ChatGPT. Lúc soạn bộ docs v0.1 chưa có cách auto-submit nào được kiểm trên driver của mình.

Có hai sai lầm phải tránh: lách kiểm tra truy cập, và quảng cáo "tự động hoàn toàn" khi thật ra vẫn còn bước tay.

## Quyết định

Khi một tổ hợp provider/mode chưa có đường auto-submit đã qualify, app dùng **manual submit** làm đường chính thức:

1. App chuẩn bị mọi thứ: settings, prompt, ref. Sau đó đọc lại hậu điều kiện.
2. App chụp baseline và **ghi intent bền vững** trước khi mời người dùng bấm.
3. Người dùng tự bấm Generate/Send trên tab provider.
4. App đối soát bằng UI/network. Nút "Tôi đã bấm" chỉ kích hoạt đối soát, không được coi là receipt.

App không lách trusted event hoặc captcha, và không gọi một mode là "auto" khi còn bước tay.

## Phương án đã cân nhắc

| Phương án | Lý do không chọn |
|---|---|
| Auto qua `chrome.debugger`/CDP Input | Spike lượt 1–9: Flow trả `PUBLIC_ERROR_UNUSUAL_ACTIVITY`. Phiên từng gắn debugger vẫn bị gắn cờ dù người bấm (lượt 8–9). |
| Event tổng hợp từ content script (`click()`, Enter, PointerEvent) | Flow bỏ qua, không gửi request nào. An toàn nhưng không dùng được. |
| Humanize hoặc né chấm điểm reCAPTCHA | Lách kiểm tra truy cập; bị loại theo nguyên tắc thiết kế. |

## Hệ quả

- Có đường chạy hợp lệ ngay cả khi chưa có auto, nhưng throughput bị giới hạn bởi tốc độ bấm của người dùng.
- Cần trạng thái `awaiting_user` và đường "mở đúng tab" (U3 ở [01](../01-screens-and-flows.md), AC-11 ở [08](../08-acceptance-and-delivery.md)).
- Đối soát sau khi người dùng bấm phải chịu được việc họ không bấm, bấm hai lần, hoặc sửa prompt trước khi bấm.

## Vì sao bị thay một phần

Ngày 06/11/2026, người dùng xác nhận D-12 cho Flow: chấp nhận rủi ro tài khoản để dùng kỹ thuật gọi listener với `isTrusted` giả. Spike 01 cho thấy kỹ thuật này chạy được trên Flow ([ADR-0002](0002-flow-auto-submit-trusted-listener.md)). Từ đó, với Flow, manual chỉ còn là đường dự phòng. Với ChatGPT, ADR này vẫn giữ nguyên.

## Bằng chứng

[spikes/01-flow-cdp/FINDINGS.md](../../../spikes/01-flow-cdp/FINDINGS.md): lượt 1–12 (CDP bị chặn, event tổng hợp bị bỏ qua, người bấm sau khi content script chuẩn bị thì đạt).
