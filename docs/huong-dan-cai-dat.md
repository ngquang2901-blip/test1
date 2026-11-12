# Cài ToolFlow (dành cho người dùng)

Tải bản mới nhất: https://github.com/ngquang2901-blip/test1/releases/latest (mục **Assets**). Từ bản 0.5.1, app tự cập nhật; bản 0.5.0 trở về trước phải cài tay bản mới một lần.

## Windows
1. Tải `ToolFlow-0.10.0-Setup.exe` về máy rồi bấm đúp.
2. Windows có thể báo "Windows protected your PC" vì file chưa được ký số: bấm **More info** → **Run anyway**.
3. Chọn nơi cài (để mặc định cũng được) → **Install**. App cài cho riêng tài khoản Windows đang dùng, không cần quyền Administrator. Có sẵn biểu tượng trên Desktop và trong Start menu.

## Linux
- **AppImage** (máy nào cũng chạy, không cần cài): `chmod +x ToolFlow-0.10.0-x86_64.AppImage` rồi bấm đúp hoặc chạy `./ToolFlow-0.10.0-x86_64.AppImage`. Nếu máy báo thiếu FUSE: `./ToolFlow-0.10.0-x86_64.AppImage --appimage-extract-and-run`.
- **Debian/Ubuntu**: `sudo apt install ./ToolFlow-0.10.0-amd64.deb`, rồi mở ToolFlow trong menu ứng dụng.

## Lần đầu mở app: nối với Chrome (làm một lần cho mỗi hồ sơ Chrome)
Màn **Kết nối** hiện sẵn các bước, gồm đường dẫn thư mục extension và nút **Chép đường dẫn**:
1. Trong Chrome, gõ `chrome://extensions` vào thanh địa chỉ.
2. Bật **Developer mode**.
3. Bấm **Load unpacked**, rồi chọn thư mục mà app hiển thị.
4. Mở `flow.google.com`, vào một dự án. Trong vòng 30 giây app báo **Đã kết nối** → bấm **Dùng tab này**.

Muốn chạy nhiều tài khoản cùng lúc: làm lại các bước trên trong từng hồ sơ Chrome, rồi chọn tốc độ **Nhanh** trong Cài đặt.

## Tạo video (từ bản 0.6.0)
- Màn **Tạo lô**: chọn **Video**, mỗi dòng một prompt. Mô hình Veo 3.1 - Lite, tỉ lệ 16:9 hoặc 9:16, mỗi prompt một video (10 credit Flow mỗi video, khoảng 1 phút).
- Muốn video bắt đầu từ một ảnh: ở mục **Khung hình đầu** bấm **Chọn ảnh…**, rồi chọn dùng chung một ảnh hoặc mỗi prompt một ảnh theo thứ tự.
- Màn **Kết quả**: bấm **Tải tất cả kết quả** để lưu MP4, bấm **Xem video** để xem ngay trong app.
- Màn **Workflow**: bấm vào node Tạo ảnh Flow, đổi **Loại kết quả** sang Video; ảnh nối vào node đó là khung hình đầu.
- Màn **Workflow** có sẵn 5 mẫu trong ô **Mẫu có sẵn…** (từ bản 0.6.2): chọn một mẫu, sửa prompt trong các ô Text rồi bấm **Chạy workflow**.
- Mỗi prompt ảnh dùng được tối đa 10 ảnh tham chiếu (từ bản 0.6.2).

## Tạo ảnh bằng ChatGPT (từ bản 0.7.0)
1. Trong Chrome đã cài extension ToolFlow, mở https://chatgpt.com/ và đăng nhập. ChatGPT cần ở **giao diện tiếng Anh** (app tìm nút theo chữ tiếng Anh).
2. Sau khi cập nhật app: vào `chrome://extensions`, bấm mũi tên tải lại ở thẻ **ToolFlow Connector**, rồi F5 tab ChatGPT. Màn **Kết nối** của app sẽ ghi "Đã thấy 1 tab chatgpt.com".
3. Màn **Tạo lô** → **Nền tảng** chọn **ChatGPT (tạo ảnh)** → dán danh sách prompt → **Tạo lô và chạy**.
- Mỗi lô mở một cuộc trò chuyện mới trong tab ChatGPT, app tự bật "Create image", gửi lần lượt từng prompt và tự lưu ảnh vào `Downloads/ToolFlow` (không cần bấm Tải).
- Khi lô chạy, app đưa tab ChatGPT lên trước trong cửa sổ Chrome của nó. Đừng thu nhỏ cửa sổ Chrome đó và đừng gõ vào ChatGPT lúc lô đang chạy.
- Nếu bạn chuyển tab ChatGPT sang cuộc trò chuyện khác, lô tạm dừng; bấm **Tiếp tục** thì app mở lại đúng cuộc trò chuyện của lô.
- ChatGPT trả lời mà không có ảnh (hết lượt tạo ảnh, hoặc prompt bị từ chối): dòng đó báo lỗi, lô tạm dừng để bạn đọc câu trả lời trong ChatGPT.
- **Ảnh tham chiếu** (từ bản 0.10.0): bấm **Chọn ảnh…** rồi chọn cách chia như với Flow. App tự dán ảnh vào ô nhập của ChatGPT trước khi gửi. Tài khoản miễn phí bị ChatGPT giới hạn số ảnh tải lên mỗi ngày.
- Chưa có: chọn tỉ lệ khung hình (ghi thẳng trong prompt).

## Tạo ảnh bằng Gemini (từ bản 0.8.0)
1. Trong Chrome đã cài extension ToolFlow, mở https://gemini.google.com/app và đăng nhập. Gemini để ngôn ngữ nào cũng được.
2. Sau khi cập nhật app: vào `chrome://extensions`, bấm mũi tên tải lại ở thẻ **ToolFlow Connector**, rồi F5 tab Gemini. Màn **Kết nối** của app sẽ ghi "Đã thấy 1 tab gemini.google.com".
3. Màn **Tạo lô** → **Nền tảng** chọn **Gemini (tạo ảnh)** → dán danh sách prompt → **Tạo lô và chạy**.
- Mỗi lô mở một cuộc trò chuyện mới trong tab Gemini, app tự bật công cụ tạo hình ảnh, gửi lần lượt từng prompt và tự lưu ảnh **cỡ đầy đủ** vào `Downloads/ToolFlow` (không cần bấm Tải). Mỗi ảnh mất khoảng 25–40 giây.
- **Tỉ lệ khung hình** (từ bản 0.9.0): chọn 1:1, 9:16, 3:4, 4:3 hoặc 16:9 ngay trong màn Tạo lô; để **Theo Gemini** thì lô dùng cái đang chọn trong tab.
- **Mô hình** (từ bản 0.10.0): chọn Flash-Lite, Flash hoặc Pro trong màn Tạo lô; để **Theo Gemini** thì giữ cái đang chọn. Lưu ý: chọn ở đây thì tab Gemini của bạn cũng chuyển sang mô hình đó.
- **Ảnh tham chiếu** (từ bản 0.9.0): bấm **Chọn ảnh…** rồi chọn cách chia như với Flow (mỗi prompt một nhóm ảnh theo thứ tự, hoặc dùng chung tất cả ảnh), tối đa 10 ảnh mỗi prompt. App tự dán ảnh vào ô nhập của Gemini trước khi gửi.
- Gemini trả lời mà không có ảnh, hoặc để trống câu trả lời: dòng đó báo lỗi sau khoảng 20 giây và lô tạm dừng để bạn xem trong Gemini; bấm **Tiếp tục** để gửi các prompt còn lại.
- Khi lô chạy, app đưa tab Gemini lên trước. Đừng thu nhỏ cửa sổ Chrome đó, đừng gõ vào Gemini và đừng để sẵn chữ trong ô nhập của Gemini (app không gõ đè lên chữ có sẵn, lô sẽ tạm dừng).
- Lúc lấy ảnh cỡ đầy đủ, app bấm nút tải của Gemini; bản tải riêng của Gemini (tên `Gemini_Generated_Image_…`) nếu có sẽ bị app huỷ để không lưu trùng. Trong lúc lô chạy, đừng tự bấm tải ảnh trong Gemini.
- **Trong Workflow** (từ bản 0.10.0): bấm vào node **Tạo ảnh**, ở ô **Nền tảng** chọn Google Flow, ChatGPT hoặc Gemini. Node Gemini có thêm ô Mô hình và Tỉ lệ khung hình. Ảnh của node trước nối sang sẽ thành ảnh tham chiếu của node sau, kể cả khi hai node ở hai nền tảng khác nhau.

## Cho trợ lý AI điều khiển ToolFlow (MCP, từ bản 0.6.1)
MCP là cổng để một trợ lý AI chạy trên cùng máy (Claude Code, Hermes…) tạo lô, xem tiến độ và tải kết quả thay bạn. Mặc định tắt.
1. **Cài đặt → Trợ lý AI (MCP)**: tích **Cho trợ lý AI trên máy này điều khiển ToolFlow**. App hiện địa chỉ `http://127.0.0.1:47615/mcp`.
2. Bấm **Mở thư mục chứa mã khoá**, mở file `mcp.json`, chép dòng `token`.
3. Khai báo trong trợ lý. Ví dụ Claude Code: `claude mcp add --transport http toolflow http://127.0.0.1:47615/mcp --header "Authorization: Bearer <token>"`.
- Trợ lý có 4 lệnh: xem trạng thái, tạo lô (ảnh hoặc video, dùng cài đặt mặc định của app), xem các lô, tải kết quả về máy.
- Trợ lý gửi prompt sẽ tốn credit Flow như khi bạn tự chạy. Nó không bật được **Tự động gửi**: nếu bạn chưa bật, lô của nó chờ bạn bấm Gửi trong Flow.
- Ai đọc được file `mcp.json` cũng điều khiển được app: đừng gửi file đó cho người khác. Muốn khoá lại thì bỏ tích.

## Dữ liệu nằm ở đâu
- Ảnh và video tải về: thư mục `Downloads/ToolFlow`.
- Dữ liệu app (lô, mẫu, extension): Windows `%APPDATA%\ToolFlow`, Linux `~/.config/ToolFlow`. Gỡ app không xoá thư mục này.

## Cập nhật bản mới
- App tự kiểm tra bản mới khi mở và vài giờ một lần, tự tải về trong nền (thanh trên cùng hiện "Đang tải bản …"). Tải xong, một dải xanh hiện **Khởi động lại để cập nhật**: bấm là app tự cài rồi mở lại; bấm **Để sau** thì bản mới tự cài khi bạn tắt app. Đang có lượt chờ kết quả thì app không khởi động lại.
- Xem phiên bản, kiểm tra tay: **Cài đặt → Cập nhật → Kiểm tra bản mới**.
- Sau mỗi lần cập nhật, màn Kết nối có thể báo **Extension cần tải lại**: vào `chrome://extensions`, bấm nút tải lại (mũi tên vòng) ở thẻ **ToolFlow Connector**, rồi tải lại tab Flow (làm ở từng hồ sơ Chrome). Trong lúc báo, app không tự bấm Gửi.
- Cũng có thể cài đè bản mới lên bản cũ bằng file cài; dữ liệu được giữ nguyên.
- Bản cài bằng `.deb` hỏi mật khẩu quản trị khi cập nhật (Linux cần quyền này để cài gói).
