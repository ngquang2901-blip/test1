# ToolFlow — bộ tài liệu app

**Phiên bản:** thiết kế đề xuất v0.1 · **Ngày:** 05/11/2026 · **Trạng thái:** tài liệu đã soạn, app chưa triển khai.

ToolFlow giúp nhập một lô prompt, chạy qua **Google Flow hoặc ChatGPT**, theo dõi đúng kết quả của từng prompt và tải file về có thể khôi phục khi lỗi. Đây là tài liệu mô tả **app mình sẽ thiết kế**, không phải danh mục chức năng của nguồn nghiên cứu.

## Đọc theo mục đích

| Muốn làm gì | Đọc |
|---|---|
| Hiểu app làm gì và không làm gì | [00 — Sản phẩm, phạm vi, yêu cầu](00-product-scope.md) |
| Thiết kế giao diện và tương tác | [01 — Màn hình và luồng](01-screens-and-flows.md) |
| Thiết kế dữ liệu và hàng đợi | [02 — Domain và trạng thái](02-domain-and-state.md) |
| Chia module, chọn nền tảng, viết driver | [03 — Kiến trúc và contract](03-architecture-and-contracts.md), [04 — Flow](04-flow-driver.md), [05 — ChatGPT](05-chatgpt-driver.md) |
| Xử lý ảnh đầu vào, kết quả, file tải | [06 — Media và tải xuống](06-assets-and-downloads.md) |
| Thiết kế pause/stop/retry/recovery | [07 — An toàn và phục hồi](07-safety-and-recovery.md) |
| Viết test và chia giai đoạn phát triển | [08 — Nghiệm thu và bàn giao](08-acceptance-and-delivery.md) |
| Biết điều gì đã chốt, điều gì chỉ là đề xuất | [09 — Nguồn và quyết định](09-evidence-and-decisions.md) |
| Hiểu lý do của các quyết định kiến trúc lớn | [ADR-0001 — Manual submit](adr/0001-manual-submit-khi-auto-chua-qualify.md), [ADR-0002 — Auto-submit Flow](adr/0002-flow-auto-submit-trusted-listener.md) |

## Phạm vi hiện tại

**Đã được người dùng xác định:** chỉ Flow + ChatGPT; tạm bỏ việc tìm Bridge/mua gói dịch vụ để lấy Bridge; chuyển nghiên cứu thành tài liệu sản phẩm. Các mục khác là **đề xuất thiết kế**, chưa phải phê duyệt tất cả tính năng hoặc kiến trúc.

Bản đầu đề xuất: một người vận hành, một phiên trình duyệt được chọn, chạy tuần tự; Flow tạo ảnh/video, ChatGPT tạo ảnh. Có prompt batch, ảnh tham chiếu theo capability, hàng đợi bền, tải kết quả và khôi phục. Chỉ các tổ hợp đã qua qualification mới được bật khi phát hành.

**Ngoài bản đầu:** Bridge/Max Speed/native RPC, provider khác, workflow canvas, MCP/Telegram, đa tài khoản song song, cloud sync, thanh toán/license, sửa/xoá watermark. Chúng không được lén đưa vào dependency của MVP.

## Cách dùng tài liệu

1. Dùng 00–01 để thiết kế UX; đây là cấu trúc chức năng, không áp đặt phong cách hình ảnh.
2. Khi đi vào kỹ thuật, đọc 02–07. Giữ bất biến an toàn dù chọn extension hay desktop.
3. Dùng 08 làm danh sách nghiệm thu; mọi ca chạy provider hiện **CHƯA CHẠY**.
4. Trước khi viết app, chốt các quyết định còn mở ở 09. Không xem việc có tài liệu là quyền tự đăng nhập, generate, mua gói, push hoặc phát hành.

**Thứ tự ưu tiên:** quyết định mới của người dùng → quyết định đã ghi ở 09 → đặc tả app này → nghiên cứu tham khảo. Nội dung nghiên cứu cũ không được tự mở rộng phạm vi app.

## Bản nghiên cứu được giữ nguyên vai trò

[Tài liệu nghiên cứu triển khai nội bộ](../research/README.md) cung cấp bài học kỹ thuật và nguồn đối chiếu, không cung cấp bộ code/config để copy vào sản phẩm. Không cần đọc toàn bộ nghiên cứu để thiết kế app. Snapshot cấu hình cho biết một thời điểm, không bảo đảm UI/provider hiện tại còn tương thích.

## Kiểm chứng tài liệu

```sh
python3 docs/app/verify-docs.py
```

Script chỉ kiểm cấu trúc, liên kết, ID yêu cầu, coverage và một số bất biến văn bản. [Kết quả kiểm](evidence/verification.json) **không phải** bằng chứng app chạy được. App, browser integration và generation đều chưa được triển khai/kiểm thử.

[Rà soát và các điểm đã sửa](evidence/PARENT-DISPOSITION.md) ghi rõ review độc lập bị lỗi API; bản này đã qua tự rà soát của phiên chính, không được mô tả là có reviewer độc lập chấp thuận.
