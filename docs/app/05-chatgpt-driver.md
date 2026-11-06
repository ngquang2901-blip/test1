# 05 — Driver ChatGPT

**Phạm vi:** tạo ảnh trong giao diện ChatGPT, với phiên người dùng tự đăng nhập. Không dùng entitlement của dịch vụ bên thứ ba, private backend, OpenAI API key hoặc model API để giả lập quyền UI. Tất cả luồng ToolFlow còn cần qualification.

## 1. Capability mục tiêu

- chatgpt.text_to_image: prompt → ảnh.
- chatgpt.reference_to_image: prompt + ref → ảnh, chỉ bật sau khi upload và attachment gating đạt.
- Không video, text assistant tổng quát, prompt enhancer hay tự dọn/xoá conversation trong MVP.
- Ratio chỉ cho các mức thực sự có thể chọn/xác nhận. Nếu cần truyền ratio bằng prompt thay vì control, đó là chiến lược riêng phải nêu rõ trong preview, không mô tả như setting cứng được model đảm bảo.
- Nhãn model từ nghiên cứu là nhãn do nghiên cứu ghi lại, không phải ID API hoặc danh sách quyền tài khoản hiện tại. Không cố chọn Pro/effort không nhìn thấy.

## 2. Conversation isolation

Chiến lược đề xuất: **một conversation mới cho mỗi batch**, các item thành các lượt tuần tự trong conversation đó. Lưu conversation identity và baseline từng turn.

- Không xoá hay tái sử dụng conversation đang chứa việc khác mà không có user action.
- Nếu UI chưa tạo conversation identity cho tới lượt đầu, giữ tab binding + new-chat baseline; sau acceptance bind identity được quan sát, không tự coi navigation do app tạo là account change.
- Các lượt sau kiểm đúng conversation; người dùng chuyển chat/sửa composer → pause, không đẩy prompt vào chat mới.
- Khi bắt đầu mỗi item, kiểm không còn ref của lượt trước, completion/turn cũ rõ ràng và không có generation ngoài runner.
- Conversation tồn tại không tự chứng minh cùng account; tín hiệu đổi account/session hoặc không xác minh được binding sau reconnect → awaiting_user/needs_review theo dispatch stage.

## 3. Chuẩn bị prompt và ref

1. Kiểm composer, image mode, submit control và error/challenge detectors đủ theo config ToolFlow.
2. Chọn mode ảnh bằng UI, đọc hậu điều kiện. Không có image mode/quyền → CAPABILITY_UNAVAILABLE; không chuyển sang văn bản và gọi đó là thành công.
3. Nếu chọn model/ratio, xác nhận áp dụng hoặc báo SETTINGS_NOT_APPLIED.
4. Upload ref sau khi user chạy batch. Kiểm số attachment, identity/preview và trạng thái upload xong; thumbnail có mặt nhưng còn pending chưa được gửi.
5. Thiếu selector/timing cho ref → CONFIG_INCOMPLETE; không best-effort submit với file thiếu.
6. Đọc lại prompt và ref cuối cùng; baseline gồm user/assistant turn IDs có sẵn, ảnh cũ và trạng thái composer.

Mẫu config riêng của ToolFlow cần tối thiểu các thao tác composer, image mode, submit, attachment pending, turn ownership, generation progress/error và generated media. Không bắt buộc đủ 44 key trong nghiên cứu; không chép các key không có consumer.

## 4. Submit và quan sát

Lưu intent rồi mới gửi, một submit opportunity như [03](03-architecture-and-contracts.md). Manual submit là đường rõ ràng khi auto-input chưa qualify. Không tự gửi thêm prompt "hãy tạo lại" khi ảnh chưa tới.

Bind user turn với prompt/attachments và assistant turn phản hồi nó; theo dõi ảnh mới trong đúng lineage. Loại ảnh ref, avatar, ảnh trong history và ảnh có sẵn trước baseline. Khi nhiều turn/ảnh không phân biệt được chủ → RESULT_OWNERSHIP_AMBIGUOUS.

Text phản hồi hoàn tất nhưng không có ảnh → NO_IMAGE_OUTPUT nếu bằng chứng đủ cho đúng turn; không mark completed. Có spinner hết nhưng không thấy media cũng không tự suy ra đã có ảnh.

Mỗi output thực có identity và evidence riêng. Nếu provider trả nhiều ảnh trong một lượt, giữ tất cả ảnh được xác minh; không tạo output giả và không tự gửi đủ một "quantity" mà ChatGPT UI không hỗ trợ.

## 5. Lỗi và detector

| Quan sát | Kết luận/khôi phục |
|---|---|
| Login UI/challenge hiển thị | awaiting_user; người dùng tự xử lý tại tab. |
| Alert quota/rate limit cụ thể | RATE_LIMIT, pause admission; không đổi account hoặc tự upgrade. |
| Ref còn pending/lỗi upload | Không submit; UPLOAD_NOT_VERIFIED hoặc upload cần đối soát. |
| Ref bị chặn nội dung | CONTENT_BLOCKED cho bước upload; không tự bỏ file rồi chạy. |
| Text-only đúng assistant turn | NO_IMAGE_OUTPUT, giữ text evidence đã che; lượt mới là hành động generate riêng. |
| "Something went wrong" chung chung | PROVIDER_ERROR_UNKNOWN; không kết luận network rồi auto-resubmit. |
| Không nhận acceptance/kết quả rõ | SUBMIT_UNCERTAIN/RESULT_OWNERSHIP_AMBIGUOUS; đọc lại, không gửi lại. |

Mẫu text hỗ trợ tiếng Việt/Anh phải có test dương/âm; dùng trong vùng alert/turn liên quan, không match toàn trang có lịch sử người dùng. Câu "please retry" trong prompt không được thành lỗi provider. Tránh phụ thuộc thứ tự pattern mơ hồ như nghiên cứu đã chỉ ra.

## 6. Download và quyền

Resolve media từ đúng assistant turn; ảnh CDN/URL có thời hạn không là credential được xuất log. Nếu cần browser session để tải, dùng kênh đã được cấp quyền; không trích cookie/header auth ra file. Tên và trạng thái tải theo [06](06-assets-and-downloads.md).

Không ghi rằng tài khoản miễn phí luôn tạo được ảnh, có model nào hay bao nhiêu ref. Cấu hình quan sát được trong nghiên cứu không xác định quyền OpenAI hiện tại. Capability phải kiểm tại session thực và failure phải có đường tiếp tục.

## 7. Qualification riêng

Cần kiểm ảnh không ref; có ref và upload chậm; quota/login/challenge; text-only; nhiều ảnh trong một turn; chuyển conversation giữa lúc chờ; URL hết hạn; đóng UI/restart. Chưa có ca nào được đánh dấu đạt cho ToolFlow.

**Nguồn:** [contract ChatGPT](../research/15-chatgpt-config-contract.md), [runtime](../research/16-flow-gpt-runtime-findings.md). Lấy nguyên tắc từ consumer và lỗi đã thấy; không dùng số ref/model/timeouts trong nghiên cứu làm cam kết sản phẩm.
