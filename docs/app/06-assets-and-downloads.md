# 06 — Ảnh đầu vào, output và tải xuống

## 1. Import và quản lý ref

Ref được copy vào vùng dữ liệu do ToolFlow quản lý, hoặc giữ file handle được người dùng cấp quyền nếu nền tảng hỗ trợ bền. Kiểm tồn tại/khả năng đọc trước mỗi batch. Blob local có content hash và metadata; hash chỉ giúp dedupe, không là bằng chứng đã upload tới provider.

Validate loại file thực, MIME, dung lượng, ảnh giải mã được; file trống/hỏng bị báo tại preview. Chỉ nhận định dạng/dung lượng trong capability đã qualify. Không tự nén, crop, xoay hay xoá watermark; nếu sau này có chuyển đổi phải preview và giữ bản gốc.

Deduplicate trong cùng pool theo asset identity; provider binding tách theo provider/project/conversation/session phù hợp. Remote upload id của session/project khác không được tái dùng chỉ vì tên file giống nhau.

## 2. Quy tắc gán ref duy nhất

| Chế độ | Mapping |
|---|---|
| Không dùng | Mọi item không có refs. |
| Tất cả | Mọi item nhận cùng danh sách đã chọn, giữ thứ tự. |
| Theo thứ tự | Chia pool thành nhóm liên tiếp theo số ref/item; không xoay vòng, không tự lặp file. |
| Video khung đầu | Một ref có role start cho từng item video; không dùng mode ingredients. |

Nếu pool không đủ/vượt capability, preview báo lỗi ở item tương ứng và chặn chạy. Người dùng phải sửa mapping hoặc chủ động chọn không dùng ref cho item đó. Không âm thầm cho prompt sau chạy thiếu ảnh; một parser/mapping chung dùng cho nháp, batch và chạy lại.

Role ref, thứ tự và mapping được đóng băng vào batch. Gán theo @mention, tự trích frame video và keyframe cuối ngoài MVP.

## 3. Upload và khả năng khôi phục

Upload chỉ bắt đầu khi user chạy batch, không khi vừa chọn file. Ghi upload intent và baseline trước cơ hội gửi file. Sau timeout/disconnect, tìm binding/tile/attachment của đúng asset trước; không tăng remote uploads bằng cách retry mù.

Khi người dùng phải chọn file thủ công, UI nêu rõ file nào/target nào và kiểm lại ảnh thực được attach. User xác nhận đã chọn không thay thế kiểm identity/pending. Không tự đồng ý consent upload.

## 4. Output ownership và nguồn tải

Output lưu mediaType, providerIdentity, attemptId, evidence và locator tạm. URL/filename/thumbnail không đủ làm identity. Không lưu output cho ảnh chỉ là ref, avatar hoặc kết quả cũ.

Resolve lại URL qua đúng output trên UI khi hết hạn; thao tác resolve không được generate/upscale/edit. Nếu menu tải có lựa chọn làm phát sinh xử lý/tốn credit thì ngoài MVP, không tự click dưới tên "tải gốc".

## 5. Kế hoạch tên file

Mẫu đề xuất: `{batch}/{index}_{prompt}_{outputId}.{ext}`. Các token chỉ là template ToolFlow, không lấy quy ước trong nghiên cứu làm API.

- Chốt plannedName, index, timezone/timestamp và output identity trước transfer; retry không tạo tên random mới.
- Prompt rút gọn để đặt tên là tuỳ chọn riêng tư; cho tắt prompt token. Không ghi tên đầy đủ nếu user chọn chế độ hạn chế metadata.
- Một nguồn timezone cho cả ngày/giờ; không trộn ngày UTC với giờ local.
- Chuẩn hoá Unicode, loại control/ký tự cấm, xử lý tên reserved của host, dấu chấm cuối và giới hạn đường dẫn theo host. Extension/MIME lấy từ nội dung hợp lệ, không cố đặt mọi ảnh thành PNG.
- Root là thư mục được cấp quyền hoặc đường dẫn con trong Downloads theo host. Cấm absolute path/traversal do template/prompt, kể cả đường dẫn đã encode và symlink dẫn ra ngoài vùng được cấp trên desktop.
- Nếu hệ thống uniquify tên, lưu actualName riêng. Không ghi đè file có sẵn. Khả năng mở file/thư mục hiển thị theo host; không hứa absolute path trong extension nếu browser không cấp.

## 6. Download pipeline

1. Tìm output đã owned và kiểm binding còn đúng.
2. Tạo Download + plannedName; kiểm quyền/root còn hợp lệ.
3. Ghi transfer intent trước yêu cầu tải; lưu transferHandle khi nhận được.
4. Theo dõi hệ thống tải; nhận file hoàn tất, tên thực, kích thước/MIME hoặc bằng chứng tương đương host cho phép.
5. Chỉ `completed` sau xác nhận. Transfer bắt đầu/URL trả 200 không đủ: HTML lỗi, redirect login, file 0 byte bị loại; kiểm magic bytes khi host đọc file được.
6. ACK mất sau khi đã bắt đầu → needs_review; đối soát handle/hệ thống trước khi mở transfer mới.
7. Tải thất bại rõ có thể retry cùng output. Không đi ngược sang prepare/submit.

Tải chạy song song với việc sinh nội dung (D-16); cả ảnh và video tải qua `chrome.downloads` của extension vào thư mục tạm, desktop kiểm rồi chuyển sang thư mục đích ([design doc](../superpowers/specs/2026-11-08-toolflow-design.md) §8). Không dùng context menu tải của Flow. File transfer bất định chặn admission trên target cho tới đối soát.

## 7. Khi auto-download tắt

Item có output owned được ready; Download.not_requested không là lỗi. Batch có thể completed dù chưa có file local, nhưng UI phải ghi **Đã tạo — chưa yêu cầu tải**, không "đã lưu". Bấm Tải sau tạo Download cho output hiện có, không tạo attempt generate.

## 8. Hết dung lượng, quyền và retention

- Storage quota/file permission lỗi trước gửi → chặn admission nếu không thể giữ journal/ref. Không bắt đầu một lượt nếu không thể ghi intent bền.
- Lỗi dung lượng khi tải: giữ output identity và báo có thể tải lại sau khi giải phóng dung lượng.
- Dọn dữ liệu có preview và kiểm ref count; batch queued/running/paused/needs_review bảo vệ blobs cần dùng. Không xóa để "giải phóng" lock của attempt chưa rõ.
- Giữ hay xoá file local là lựa chọn khác với xoá metadata. Không có xoá nội dung provider trong MVP.

**Tham khảo:** [upload/download Flow](../research/04-google-flow-dom-v1.md), [queue và mapping](../research/07-gen-batch-queue-tasks.md). Lỗi mapping xoay vòng khác nhau và tên ngày/giờ trộn timezone trở thành ca nghiệm thu, không được kế thừa.
