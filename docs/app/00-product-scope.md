# 00 — Sản phẩm, phạm vi và yêu cầu

**Loại:** đặc tả sản phẩm đề xuất; chỉ các quyết định đánh dấu XÁC NHẬN ở [09](09-evidence-and-decisions.md) đến từ người dùng.

## 1. App là gì?

ToolFlow là bàn điều khiển cho một người tạo nội dung bằng tài khoản Flow/ChatGPT của họ. Người dùng chuẩn bị prompt và ảnh đầu vào, chọn nơi chạy, xem từng lượt đang ở đâu, rồi nhận file đúng tên. App không tự vận hành model và không hứa tạo nội dung miễn phí hoặc bỏ giới hạn của provider.

**Vấn đề cần giải quyết:** thao tác lặp trên trình duyệt, nhầm ảnh giữa nhiều prompt, không biết đã gửi hay chưa khi mất kết nối, tải thiếu file và không biết cách tiếp tục sau lỗi.

**Tiêu chí thành công:** từ một batch đi tới kết quả có nguồn gốc rõ, hoặc một lỗi có hành động khôi phục cụ thể; không báo hoàn tất giả và không tự gửi lại một lượt có thể đã tốn credit.

## 2. Bản đầu đề xuất

- Một người dùng cục bộ; không tài khoản ToolFlow, backend thương mại hay cổng license.
- Một batch được runner chủ động chạy tại một thời điểm. Trong batch, các lượt chạy song song tới một trần do runner giữ ([09](09-evidence-and-decisions.md) D-16). Có thể xếp nhiều batch Flow/GPT chờ. Lượt provider chưa rõ không tự biến mất: đường lưu hồ sơ chưa giải được và tiếp tục ở target khác có xác nhận tại chương 07, không hứa server đã dừng.
- Dùng một browser session được người dùng chọn; không sao chép cookie/credential để tự dựng session khác.
- Flow: mục tiêu ảnh từ prompt, ảnh có ref, video từ prompt và video với khung đầu. Khung cuối/ingredients phức tạp để giai đoạn sau.
- ChatGPT: ảnh từ prompt và ảnh có ref, **phase sau** (D-15), không thuộc lần phát hành đầu. Không video, không chatbot tổng quát/AI Agent.
- Năng lực trên là **mục tiêu sản phẩm**, chưa phải kết quả đã chạy. Không thể qualify một tổ hợp thì tắt rõ tổ hợp đó, không đổi ngầm mode/model để chạy tiếp.

Giới hạn cụ thể của ref/model/ratio được lấy từ capability do ToolFlow kiểm chứng, không lấy trần trong config trong nghiên cứu làm quyền của tài khoản.

## 3. Yêu cầu chức năng chuẩn

Bảng này là nguồn định nghĩa ID yêu cầu. [08](08-acceptance-and-delivery.md) nối mỗi ID với ca nghiệm thu; các chương khác giải thích hành vi, không tạo yêu cầu ngoài bảng.

| ID | Yêu cầu | Kết quả nhìn thấy của người dùng |
|---|---|---|
| TF-01 | Chọn và kiểm tra phiên/tab đích | Thấy đúng provider, tab, project/conversation và lý do nếu chưa sẵn sàng. |
| TF-02 | Nhập prompt trực tiếp hoặc TXT UTF-8 | Xem preview số prompt thực tế, lỗi dòng và nội dung trước khi lưu. |
| TF-03 | Chọn thông số theo capability | Chỉ chọn được mode/model/ratio/ref hợp lệ; không im lặng dùng giá trị khác. |
| TF-04 | Chuẩn bị và gán ảnh tham chiếu | Xem chính xác ref của từng prompt; không cắt bớt/xoay vòng ngầm. |
| TF-05 | Lưu batch với cấu hình bất biến | Đóng/mở UI vẫn thấy batch; sửa bản nháp không làm đổi lượt đã chạy. |
| TF-06 | Chạy hàng đợi có trần song song và có khoá sở hữu | Hai cửa sổ không cùng gửi một item hoặc thao tác hai tab ngoài dự kiến. |
| TF-07 | Theo dõi tiến độ bằng trạng thái thật | Phân biệt chờ gửi, có thể đã gửi, đang tạo, có kết quả, đã tải. |
| TF-08 | Tạm dừng và tiếp tục | Không gửi item mới trong lúc pause; lượt đã gửi vẫn được đối soát an toàn. |
| TF-09 | Dừng batch trung thực | Dừng gửi mới, giữ kết quả đã có; không tuyên bố đã huỷ phía provider. |
| TF-10 | Phục hồi sau đóng UI/runner crash | Đọc journal và đối soát trước khi cho chạy tiếp; không replay submit mơ hồ. |
| TF-11 | Hỗ trợ người dùng can thiệp | Có đường mở đúng tab cho login/captcha/consent, gửi thủ công khi auto tắt, và nút kiểm tra lại. |
| TF-12 | Driver Flow qua giao diện web | Chạy các tổ hợp đã qualify, xác nhận thông số/ref/project trước gửi. |
| TF-13 | Driver ChatGPT qua giao diện web | Tạo ảnh đúng conversation/turn, báo text-only hoặc không có quyền thay vì nhận nhầm. |
| TF-14 | Gắn kết quả đúng attempt | Kết quả không rõ chủ vào cần kiểm tra; không lấy ảnh cuối trang làm kết quả. |
| TF-15 | Tải kết quả và xác nhận hoàn tất | Thấy tên file thực tế, trạng thái từng output và lý do chưa lưu được. |
| TF-16 | Thử lại tải riêng với sinh nội dung | Mất mạng khi tải không gây generate thêm. |
| TF-17 | Xem lịch sử và chi tiết lượt chạy | Xem prompt, cấu hình, mốc thời gian, lỗi, kết quả và đường khôi phục. |
| TF-18 | Chẩn đoán và cập nhật selector có kiểm soát | Thấy version driver/config; cấu hình thiếu thì chặn và báo cách sửa. |
| TF-19 | Giữ dữ liệu nhạy cảm cục bộ và có xuất an toàn | Không thu credential; gói chẩn đoán có preview, mặc định không chứa prompt/ref. |
| TF-20 | Kết thúc batch đúng theo kết quả thực | Thành công, một phần, lỗi, đã dừng và cần kiểm tra là các kết quả khác nhau. |
| TF-21 | Cài đặt và quản lý dung lượng | Có khả năng tải thật, tên file, retention và dọn dữ liệu không phá batch sống. |
| TF-22 | Đánh dấu lượt thử lại sinh nội dung | Chỉ người dùng xác nhận mới tạo attempt mới sau lượt đã/maybe gửi; nêu khả năng tốn thêm credit. |

## 4. Quy tắc dữ liệu đầu vào

- MVP: textarea mỗi dòng không rỗng là một prompt; TXT cũng dùng cùng parser. CRLF/LF cho cùng kết quả. Bỏ dòng rỗng hoặc chỉ có whitespace nhưng giữ sourceLine; các ký tự/whitespace trong prompt không rỗng được giữ nguyên, không tự chuẩn hoá Unicode hay viết lại nội dung.
- TXT phải là UTF-8 hợp lệ; bỏ BOM chỉ ở đầu file. Lỗi decode báo rõ, không âm thầm thay ký tự rồi chạy. Giới hạn kích thước file/số item phải được chốt theo host trước phát hành và báo tại preview.
- Hiển thị preview trước khi tạo batch: prompt, mode, model, refs được gán, số lượt generate dự kiến. Không tự submit khi import.
- Prompt nhiều dòng trong cùng một item, CSV, JSON và templating biến để sau; UI không quảng cáo chúng là đã hỗ trợ.
- Mặc định một output mục tiêu mỗi item. Nếu provider trả nhiều ảnh cho một lượt, giữ toàn bộ ảnh có bằng chứng thuộc lượt đó; không giả định mỗi ảnh là một lần generate.
- Batch đã bắt đầu không được đổi settings/ref/provider/tab đích. Muốn đổi: nhân bản thành bản nháp mới. Có thể huỷ item chưa gửi.
- Không thay model hoặc bỏ ref để "cứu" batch mà không có hành động rõ từ người dùng.

## 5. Ngoài phạm vi

Bridge, Max Speed, tự gọi native RPC Flow; Grok/Gemini/Muse/Motion; xoá watermark; tự giải captcha/né kiểm tra truy cập; workflow DAG/canvas; MCP/Telegram; multi-account farm; cloud sync/team; thanh toán/license; prompt marketplace; upscale/edit/extend và tự xoá conversation/provider project.

Các mục này chỉ được đưa vào phiên bản sau khi có yêu cầu mới. Không sao chép pricing/quota/entitlement trong nghiên cứu thành yêu cầu ToolFlow.

## 6. Những việc cần chủ sản phẩm chọn

Đã chốt ([09](09-evidence-and-decisions.md) D-13 → D-17): desktop Electron + TypeScript kèm extension MV3 làm cầu nối; Windows + Linux; bản đầu gồm Flow ảnh, ảnh có ref và video; gửi tự động có đường thủ công dự phòng, chạy song song có trần; tài khoản test và ngân sách. Còn chọn: hình thức giao diện và ngôn ngữ, framework UI, thư viện SQLite, phiên bản Chrome tối thiểu.

**Nguồn tham khảo:** [rủi ro và bài học](../research/13-rui-ro-va-bai-hoc.md), [hàng đợi](../research/07-gen-batch-queue-tasks.md), [kiểm chứng runtime](../research/16-flow-gpt-runtime-findings.md). Những mô tả ToolFlow ở đây là thiết kế mới, không phải tính năng đã tồn tại.
