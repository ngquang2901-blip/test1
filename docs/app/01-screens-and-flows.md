# 01 — Màn hình và luồng người dùng

**Thiết kế chức năng đề xuất.** Desktop-first ở mức bố cục. Nền tảng đã chốt: app desktop kèm extension làm cầu nối ([09](09-evidence-and-decisions.md) D-13); phong cách hình ảnh chưa chốt. Không dùng screenshot trong nghiên cứu làm ảnh sản phẩm ToolFlow.

## 1. Điều hướng

Năm khu vực: **Tạo batch · Hàng đợi · Kết quả · Phiên trình duyệt · Cài đặt**. Chi tiết lượt chạy mở từ Hàng đợi/Kết quả, không tạo thêm một menu Lịch sử trùng dữ liệu. Màn chính mặc định là Hàng đợi khi có batch đang sống, Tạo batch khi chưa có dữ liệu.

Thanh trạng thái chung: provider/session đích, trạng thái runner, batch đang chạy, số việc cần người dùng xử lý. Mất kết nối chỉ vô hiệu hành động cần runner; vẫn xem được dữ liệu đã lưu.

## 2. S1 — Phiên trình duyệt

- Danh sách tab được cấp quyền và đủ điều kiện; ghi provider, tiêu đề, project/conversation rút gọn, tình trạng kết nối. Không tự coi tab đầu tiên là đích.
- Hành động: **Chọn tab**, **Mở trang provider**, **Kiểm tra lại**, **Mở đúng tab**. Mở URL không tự đăng nhập hoặc đồng ý điều khoản.
- Trạng thái: chưa chọn; cần cấp quyền; cần đăng nhập; cần mở project; đang kiểm tra; sẵn sàng; giao diện chưa hỗ trợ; phiên đã thay đổi.
- Browser extension có thể dùng tab hiện có; desktop chỉ liệt kê browser được kết nối qua cơ chế đã duyệt. Không hứa thấy mọi tab hệ thống trước khi chốt nền tảng.
- Khi đổi tab/project/account trong một batch đã chạy: giữ target cũ, pause/chặn tác động mới và yêu cầu đối soát. Không âm thầm nối batch sang tài khoản khác.

## 3. S2 — Tạo batch

Bố cục gợi ý:

```text
[Provider] [Tab/project/conversation đích] [Trạng thái]
[Ảnh / Video] [Model] [Tỉ lệ] [Tuỳ chọn hợp lệ]
[Nhập prompt..................................] [Nhập TXT]
[Ảnh tham chiếu] [Không dùng / Tất cả / Theo thứ tự]
[Preview: # | prompt | refs | mode | cảnh báo]
[Tự tải] [Thư mục logic] [Mẫu tên] [Tên mẫu thực tế]
[Lưu nháp] [Thêm vào hàng đợi] [Tạo batch và chạy]
```

- Chỉ bật control được capability xác nhận; ChatGPT không có nút Video. Model chỉ liệt kê lựa chọn thực sự nhìn thấy/đã qualify, không lấy nhãn nghiên cứu làm quyền hiện hành.
- Input TXT/ảnh chưa gây request tạo nội dung. Upload ref lên provider chỉ bắt đầu sau khi người dùng chạy batch.
- Gán ref: không dùng; tất cả; theo thứ tự không xoay vòng. Xem quy tắc [06](06-assets-and-downloads.md). Thiếu/vượt ref là lỗi preview, không cắt bớt.
- Mode video khung đầu yêu cầu một ref gán vai trò start. Không nhập khung cuối trong bản đầu.
- Ghi rõ số **lượt gửi tạo nội dung dự kiến**, không quy đổi sang tiền/credit khi không biết biểu phí thực.
- Nút chạy chỉ bật khi draft hợp lệ, target sẵn sàng, driver đủ capability và không bị batch/lock khác chiếm. Nếu target chưa sẵn sàng vẫn lưu được draft; enqueue phải có target định danh hợp lệ, kiểm lại khi chạy.

## 4. S3 — Hàng đợi và chi tiết batch

Danh sách batch: tên, provider, mục tiêu ảnh/video, số item, nhãn trạng thái, đã có kết quả, đã lưu file, việc cần xử lý. Bấm batch mở bảng item và panel chi tiết:

| Thành phần | Nội dung |
|---|---|
| Bảng item | Thứ tự, prompt ngắn, ref, trạng thái sinh, trạng thái tải, thời gian và lỗi |
| Chi tiết | Prompt đầy đủ, settings snapshot, target, các attempt, bằng chứng gán kết quả |
| Timeline | Chuẩn bị → ý định gửi → xác nhận/không rõ → tạo → nhận output → tải |
| Kết quả | Thumbnail/poster, provider identity, tên file thực tế, mở file/mở trên provider |
| Phục hồi | Lý do bị chặn và đúng các hành động an toàn có thể dùng |

**Nhãn UI** lấy từ trạng thái ở [02](02-domain-and-state.md), không suy từ spinner. Hiển thị riêng: `có kết quả / tổng item` và `đã lưu / tổng output cần tải`. Chưa biết số output cuối thì dùng đếm, không dựng phần trăm chính xác giả.

- **Tạm dừng:** chặn gửi item mới; tiếp tục đối soát lượt đã gửi. Không đổi nhãn thành Đã huỷ.
- **Tiếp tục:** kiểm tra target/lock và trạng thái chưa rõ trước khi mở lại admission.
- **Dừng batch:** xác nhận một lần; huỷ item chưa gửi, không hứa thu hồi lượt provider đang chạy. Lượt mơ hồ giữ nhãn Cần kiểm tra.
- **Thử lại tải:** chỉ thao tác output đã có, không tạo attempt generate.
- **Tạo lượt mới:** hiển thị cảnh báo có thể tốn thêm credit; không giấu trong nút Retry chung.

## 5. S4 — Kết quả

Lưới hoặc bảng dùng chung records với batch; lọc theo provider, ảnh/video, batch, đã tải/chưa tải. Mỗi thẻ có preview, prompt nguồn, attempt, thời gian, trạng thái tải và tên thực tế.

Không hiển thị "đã lưu" chỉ vì có URL/thumbnail. File mất khỏi đĩa sau khi tải thì giữ lịch sử từng thành công, thêm tình trạng file không còn truy cập được; không sửa lịch sử thành chưa từng tải.

Không có thao tác tự xoá project/chat/provider media. Xoá bản ghi cục bộ nêu rõ có giữ file đã tải hay không.

## 6. S5 — Cài đặt

- Tải xuống: tự tải, output root được nền tảng cho phép, mẫu tên và preview; hiện rõ giới hạn chọn thư mục của nền tảng.
- Driver: version/config version, kết quả kiểm tương thích, nhập cấu hình cục bộ có preview/validate. Không tải rồi thực thi code từ URL tuỳ ý.
- Dữ liệu: dung lượng metadata/ref/thumbnail, retention, xem trước đối tượng sắp dọn; không dọn batch còn sống.
- Chẩn đoán: xuất gói đã che thông tin, preview trước lưu; prompt/ref mặc định loại bỏ.
- Không có mục nâng cấp gói, license ToolFlow, Bridge hoặc No Watermark trong bản đầu.

## 7. Luồng chuẩn

### U1 — Chạy batch Flow

Chọn tab/project → kiểm tra khả năng ảnh/video → nhập prompt/ref → preview → lưu/enqueue → runner kiểm lại target → chạy từng item → xác nhận kết quả → tải → tổng kết trung thực. Quay lại S2 không reset batch đang chạy.

### U2 — Chạy batch ChatGPT

Chọn phiên GPT → nhập prompt ảnh/ref → preview → chạy → tạo conversation mới cho batch theo chiến lược driver → tuần tự từng turn → gán ảnh đúng turn → tải. Nếu không mở/định danh được conversation an toàn, dừng với hướng dẫn, không chuyển sang chat đang chứa việc khác.

### U3 — Login/captcha/consent và gửi thủ công dự phòng

Thông báo gồm lý do, provider, tab đích, item/attempt, thao tác được phép. **Mở đúng tab** → người dùng tự xử lý → **Kiểm tra lại**. Chỉ hết challenge chưa đủ để tự gửi lại; runner phải đọc dispatch stage.

Với Flow, gửi tự động là đường chính ([ADR-0002](adr/0002-flow-auto-submit-trusted-listener.md)) nhưng **mặc định tắt**: người dùng bật trong cài đặt tài khoản sau khi đọc cảnh báo rủi ro (D-19). Màn hình này hiện khi auto không chạy được: auto chưa bật hoặc bị tắt, có banner consent, listener/observer không đạt (fail-closed), hoặc `UNUSUAL_ACTIVITY` làm dừng auto cả profile. ChatGPT ở phase sau dùng manual theo [ADR-0001](adr/0001-manual-submit-khi-auto-chua-qualify.md) cho tới khi có auto được qualify.

Với manual submit: chuẩn bị và baseline trước, ghi intent, mới cho người dùng bấm trên provider. Một nút "Tôi đã bấm" chỉ kích hoạt đối soát, không được coi là provider xác nhận.

### U4 — Có thể đã gửi nhưng mất tín hiệu

Hiện **Cần kiểm tra — có thể đã gửi** cùng thời điểm/target/baseline. Cho **Đối soát lại**, **Mở provider**. Nếu tìm được output thì bind có bằng chứng; nếu không, giữ trạng thái chưa rõ. Tạo lượt mới cần xác nhận riêng; không có auto-resubmit.

Nếu không thể giải được: **Lưu hồ sơ chưa rõ** có xác nhận rủi ro ở chương 07. Batch cũ vẫn Cần kiểm tra, target cũ vẫn bị chặn; sau khi runner đã ngừng mọi tác động cũ, người dùng có thể nhân bản phần chưa gửi thành nháp, tự chọn project/conversation khác và bấm chạy. Không có nút Reset xoá dấu vết hoặc tự nối sang tab khác.

### U5 — Có kết quả nhưng tải lỗi

Giữ thumbnail/identity và nhãn Có kết quả. Nêu lỗi quyền, mạng, URL hết hạn hoặc tải không rõ. Cấp lại quyền/resolve lại URL → tải lại cùng output. Không quay lại gửi prompt.

### U6 — Đóng UI rồi mở lại

UI đọc trạng thái từ storage/runner, không khởi tạo job mới. Nếu runtime đã chết thì vào recovery trước. Đóng panel không đồng nghĩa dừng; đóng toàn browser/host có thể dừng runtime và sẽ được phục hồi từ journal, không hứa chạy ngầm vô hạn.

## 8. Trạng thái và khả năng tiếp cận

Mỗi màn có empty/loading/ready/error; lỗi có mã, mô tả và CTA, không chỉ toast thoáng qua. Cảnh báo màu đi kèm chữ/icon. Bảng cập nhật giữ focus và vùng chọn; nút có tên đọc được; thao tác bàn phím mở chi tiết và đóng modal được. Lỗi trong modal hiển thị ngay trong modal. Prompt dài, tên file dài và nhiều output không làm mất nút dừng/phục hồi.

**Tham khảo:** [UI trong nghiên cứu](../research/12-giao-dien.md), [batch](../research/07-gen-batch-queue-tasks.md). Bố cục và hành vi bên trên là thiết kế ToolFlow mới.
