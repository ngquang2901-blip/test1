# Cài ToolFlow (dành cho người dùng)

## Windows
1. Chép `ToolFlow-0.4.1-Setup.exe` sang máy rồi bấm đúp.
2. Windows có thể báo "Windows protected your PC" vì file chưa được ký số: bấm **More info** → **Run anyway**.
3. Chọn nơi cài (để mặc định cũng được) → **Install**. App cài cho riêng tài khoản Windows đang dùng, không cần quyền Administrator. Có sẵn biểu tượng trên Desktop và trong Start menu.

## Linux
- **AppImage** (máy nào cũng chạy, không cần cài): `chmod +x ToolFlow-0.4.1-x86_64.AppImage` rồi bấm đúp hoặc chạy `./ToolFlow-0.4.1-x86_64.AppImage`. Nếu máy báo thiếu FUSE: `./ToolFlow-0.4.1-x86_64.AppImage --appimage-extract-and-run`.
- **Debian/Ubuntu**: `sudo apt install ./ToolFlow-0.4.1-amd64.deb`, rồi mở ToolFlow trong menu ứng dụng.

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
Cài đè bản mới lên bản cũ; dữ liệu được giữ nguyên. Sau khi cập nhật, vào `chrome://extensions` và bấm nút tải lại (mũi tên vòng) ở thẻ **ToolFlow Connector**.
