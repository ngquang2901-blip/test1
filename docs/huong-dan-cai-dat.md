# Cài ToolFlow (dành cho người dùng)

Tải bản mới nhất: https://github.com/ngquang2901-blip/test1/releases/latest (mục **Assets**). Từ bản 0.5.1, app tự cập nhật; bản 0.5.0 trở về trước phải cài tay bản mới một lần.

## Windows
1. Tải `ToolFlow-0.5.3-Setup.exe` về máy rồi bấm đúp.
2. Windows có thể báo "Windows protected your PC" vì file chưa được ký số: bấm **More info** → **Run anyway**.
3. Chọn nơi cài (để mặc định cũng được) → **Install**. App cài cho riêng tài khoản Windows đang dùng, không cần quyền Administrator. Có sẵn biểu tượng trên Desktop và trong Start menu.

## Linux
- **AppImage** (máy nào cũng chạy, không cần cài): `chmod +x ToolFlow-0.5.3-x86_64.AppImage` rồi bấm đúp hoặc chạy `./ToolFlow-0.5.3-x86_64.AppImage`. Nếu máy báo thiếu FUSE: `./ToolFlow-0.5.3-x86_64.AppImage --appimage-extract-and-run`.
- **Debian/Ubuntu**: `sudo apt install ./ToolFlow-0.5.3-amd64.deb`, rồi mở ToolFlow trong menu ứng dụng.

## Lần đầu mở app: nối với Chrome (làm một lần cho mỗi hồ sơ Chrome)
Màn **Kết nối** hiện sẵn các bước, gồm đường dẫn thư mục extension và nút **Chép đường dẫn**:
1. Trong Chrome, gõ `chrome://extensions` vào thanh địa chỉ.
2. Bật **Developer mode**.
3. Bấm **Load unpacked**, rồi chọn thư mục mà app hiển thị.
4. Mở `flow.google.com`, vào một dự án. Trong vòng 30 giây app báo **Đã kết nối** → bấm **Dùng tab này**.

Muốn chạy nhiều tài khoản cùng lúc: làm lại các bước trên trong từng hồ sơ Chrome, rồi chọn tốc độ **Nhanh** trong Cài đặt.

## Dữ liệu nằm ở đâu
- Ảnh tải về: thư mục `Downloads/ToolFlow`.
- Dữ liệu app (lô, mẫu, extension): Windows `%APPDATA%\ToolFlow`, Linux `~/.config/ToolFlow`. Gỡ app không xoá thư mục này.

## Cập nhật bản mới
- App tự kiểm tra bản mới khi mở và vài giờ một lần, tự tải về trong nền (thanh trên cùng hiện "Đang tải bản …"). Tải xong, một dải xanh hiện **Khởi động lại để cập nhật**: bấm là app tự cài rồi mở lại; bấm **Để sau** thì bản mới tự cài khi bạn tắt app. Đang có lượt chờ kết quả thì app không khởi động lại.
- Xem phiên bản, kiểm tra tay: **Cài đặt → Cập nhật → Kiểm tra bản mới**.
- Sau mỗi lần cập nhật, màn Kết nối có thể báo **Extension cần tải lại**: vào `chrome://extensions`, bấm nút tải lại (mũi tên vòng) ở thẻ **ToolFlow Connector**, rồi tải lại tab Flow (làm ở từng hồ sơ Chrome). Trong lúc báo, app không tự bấm Gửi.
- Cũng có thể cài đè bản mới lên bản cũ bằng file cài; dữ liệu được giữ nguyên.
- Bản cài bằng `.deb` hỏi mật khẩu quản trị khi cập nhật (Linux cần quyền này để cài gói).
