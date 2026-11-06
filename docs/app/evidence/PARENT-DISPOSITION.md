# Rà soát trước bàn giao tài liệu ToolFlow

**Phạm vi:** tài liệu thiết kế, không phải review code app. Rà soát do phiên chính thực hiện; không có kết luận review độc lập thành công.

## Tình trạng review độc lập

Đã gọi một reviewer read-only qua `deleg_58ac2977`, task `sa-0-6da6f6ba`. Tool trả `status=interrupted`, lỗi API trước khi có findings. Không xem thông báo task kết thúc là ACCEPT và không tự gán nhận xét cho reviewer.

Không chuyển model/provider ngầm. Phiên chính đọc lại các contract và xử lý các điểm dưới đây. Một lượt review độc lập thực sự vẫn chưa hoàn tất; đây là giới hạn kiểm chứng, không phải blocker để bàn giao bản thiết kế đề xuất cho người dùng.

## Parent disposition

Các vị trí bên dưới mô tả đoạn trước sửa; liên kết trỏ tới bản đã cập nhật.

| # | Mức | Tình huống cụ thể | Xử lý và bằng chứng tài liệu |
|---|---|---|---|
| 1 | Important | Chương 07 cũ chỉ cho giữ blocker nếu intent không thể đối soát, còn chương 02 giữ slot toàn cục; có thể khoá mọi công việc vô hạn mà người dùng không có đường tiếp tục. | Đã thêm đề xuất lưu hồ sơ chưa rõ, quiesce/fence connector cũ, giữ status/tombstone target cũ; chỉ user tự chọn target khác được kiểm tách lineage rồi chạy mới. Không reset/success giả. Đồng bộ [01](../01-screens-and-flows.md), [02](../02-domain-and-state.md), [03](../03-architecture-and-contracts.md), [07](../07-safety-and-recovery.md), [09](../09-evidence-and-decisions.md); AC-10/AC-22 định nghĩa test, CHƯA CHẠY. |
| 2 | Important | ACK pause có thể tới sau khi submit permit đã giao connector nhưng trước click thực; lời hứa “không submit sau pause boundary” có thể dẫn implementer gán cancelled giả. | Đã định nghĩa dispatch fence, ACK có danh sách intent đã cấp; không cấp permit mới nhưng vẫn đối soát phần đã giao. Cập nhật [03](../03-architecture-and-contracts.md), [07](../07-safety-and-recovery.md), AC-08 ở [08](../08-acceptance-and-delivery.md). Đây là contract, chưa là race test đã qua. |
| 3 | Minor | AC-02 đòi test UTF-8/BOM nhưng spec input chưa nói xử lý BOM, decode lỗi và whitespace ra sao. | Đã chốt bỏ BOM chỉ ở đầu file, decode lỗi không thay ký tự ngầm, giữ sourceLine và nội dung prompt không rỗng ở [00](../00-product-scope.md). Giới hạn batch/file theo host còn phải chọn trước phát hành. |
| 4 | Minor | `release` ghi dọn local locks trong khi chương 07 cấm nhả target bất định; implementer có thể xoá nhầm persistent blocker. | Đã tách dọn observer/tài nguyên owner khỏi target tombstone ở [03](../03-architecture-and-contracts.md); state sau archive và restart được ghi ở [02](../02-domain-and-state.md). |

## Kiểm có thể thực thi hiện tại

- [Verification receipt](verification.json): số chương, link, ID và coverage được script kiểm; không chứng minh ngữ nghĩa hoặc provider compatibility.
- [Validator self-check](validator-self-check.json): fixture thật sao từ tài liệu, thử phá missing chapter/link/requirement/case/Bridge scope rồi khôi phục. Đây là test của trình kiểm tài liệu, không phải app test.
- Hai script nguồn nghiên cứu Flow native/Bridge đã được chạy lại trong phiên chính; mã app chưa có. Các script nguồn chỉ kiểm evidence đã lưu, không gọi generation.
- Secret-pattern scan riêng phần docs app không có hit tại lượt kiểm; không tuyên bố toàn bộ storage dump/ảnh nghiên cứu đã privacy-reviewed.

## Kết luận

**Có thể bàn giao làm bản thiết kế đề xuất.** Chưa có quyền triển khai app. Platform/OS/phạm vi mode và các đề xuất ở chương 09 còn để chủ sản phẩm chọn.

**Chưa kiểm:** review độc lập do API lỗi, app code, browser integration, live generation/download, compatibility/ToS hiện hành và privacy toàn bộ nghiên cứu cũ. Bảo đảm không tự gửi lại là yêu cầu thiết kế; chưa có app để chứng minh đã đáp ứng.
