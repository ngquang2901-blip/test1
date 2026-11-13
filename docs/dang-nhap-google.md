# Đăng nhập Google và gói dùng

Từ bản này, ToolFlow chỉ mở khi người dùng **đăng nhập bằng Google** và tài khoản có **gói đang còn hạn**.
- Lần đầu đăng nhập cũng là đăng ký: tài khoản được tạo ở trạng thái **chờ**, app hiện chữ "Mua gói".
- Quản trị viên bật gói cho từng người trong trang Firebase. Người dùng bấm **Kiểm tra lại** là dùng được.
- App kiểm tra gói khi mở, 10 phút một lần, và mỗi khi bấm "Kiểm tra lại". Mất mạng thì app khoá cho tới khi có mạng lại.

Tài khoản được lưu trên Firebase của Google. Gói miễn phí của Firebase là đủ cho vài nghìn người dùng.

## A. Tạo Firebase (làm một lần, khoảng 10 phút)

1. Mở <https://console.firebase.google.com> và bấm **Create a project**.
   - Đặt tên `toolflow-accounts`, tích ô chấp nhận điều khoản Firebase, rồi bấm Continue.
   - Tắt Google Analytics, bấm **Create project**.
2. Bật đăng nhập Google:
   - Vào **Build → Authentication → Get started → Sign-in method → Google**.
   - Bật **Enable**, chọn email hỗ trợ, bấm **Save**.
3. Tạo cơ sở dữ liệu:
   - Vào **Build → Firestore Database → Create database**.
   - Chọn vị trí `asia-southeast1 (Singapore)`, chọn **production mode**, bấm **Create**.
   - Mở tab **Rules**, xoá hết nội dung cũ, dán toàn bộ tệp [`firebase/firestore.rules`](../firebase/firestore.rules), rồi bấm **Publish**.
4. Viết hướng dẫn mua gói (người chưa có gói sẽ thấy dòng chữ này):
   - Ở tab **Data**, bấm **Start collection** và đặt Collection ID là `config`.
   - Đặt Document ID là `app`.
   - Thêm một trường: tên `buyInfo`, kiểu `string`. Giá trị là cách mua gói, ví dụ giá, số tài khoản, Zalo. Bấm **Save**.
5. Tạo mã đăng nhập cho app desktop:
   - Mở <https://console.cloud.google.com/auth/clients>, ở trên cùng chọn đúng dự án `toolflow-accounts`.
   - Bấm **Create client**, chọn Application type **Desktop app**, đặt tên `ToolFlow`, bấm **Create**.
   - Bấm **Download JSON** để lưu tệp vào thư mục Downloads.
6. Cho mọi người đăng nhập được:
   - Mở <https://console.cloud.google.com/auth/audience>, chọn User type **External**, rồi bấm **Publish app**.
   - App chỉ xin tên và email nên Google không bắt duyệt.
   - Nếu bỏ qua bước này, chỉ những email có trong danh sách "Test users" mới đăng nhập được.
7. Gửi cho người làm app 3 thứ:
   - **Project ID** và **Web API Key**: xem ở Firebase → bánh răng → **Project settings → General**. Hai mã này không phải bí mật, vì chúng nằm sẵn trong mọi bản app.
   - Tệp JSON vừa tải ở bước 5.

   Người làm app dán chúng vào `apps/desktop/src/main/license-config.ts`, rồi đóng gói và phát hành.

## B. Hằng ngày: duyệt, gia hạn, khoá

Vào Firebase → **Firestore Database → Data → users**. Mỗi người dùng là một dòng, mã dòng là mã người dùng, và trường `email` cho biết đó là ai.

| Việc | Cách làm |
|---|---|
| Bật gói cho người vừa mua | Sửa `status` thành `active`. Thêm trường `until` kiểu **timestamp**, đặt ngày hết hạn. Không có `until` nghĩa là dùng mãi. |
| Ghi tên gói (tuỳ chọn) | Thêm trường `plan` kiểu **string**, ví dụ `Gói tháng`. Người dùng thấy tên gói trong Cài đặt → Tài khoản. |
| Gia hạn | Sửa `until` sang ngày mới. |
| Khoá một người | Sửa `status` thành `blocked`. |

Sau khi sửa, người dùng chỉ cần bấm **Kiểm tra lại**, hoặc chờ tối đa 10 phút để app tự nhận.

## C. Ghi chú kỹ thuật

- Trang đăng nhập Google mở trong trình duyệt mặc định của máy, vì Google không cho đăng nhập trong cửa sổ nhúng. Sau khi đăng nhập, Google trả kết quả về một cổng tạm `127.0.0.1` (OAuth cho app cài trên máy, có PKCE).
- App chỉ giữ refresh token của Firebase, mã hoá bằng khoá của Windows, trong tệp `license.bin` ở thư mục dữ liệu của app. Token không nằm trong DB, log hay bản sao lưu.
- Quyền ghi được giới hạn bằng `firestore.rules`. Người dùng chỉ đọc được dòng của chính mình và chỉ tạo được dòng đó ở trạng thái `pending`, nên không tự bật gói cho mình được.
- Giới hạn: phần kiểm tra gói chạy trên máy người dùng, nên một người rành kỹ thuật có thể sửa app để bỏ qua. Muốn chặn chắc hơn thì phải đưa phần việc chính lên máy chủ.
