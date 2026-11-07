# 09 — Nguồn, quyết định và phần chưa biết

## 1. Nguồn chân lý
Phân biệt bốn nhãn:

- **XÁC NHẬN:** người dùng đã nói hoặc quyết định trong cuộc trao đổi.
- **ĐỀ XUẤT:** lựa chọn được người soạn đưa ra để tạo một thiết kế nhất quán; chưa phải user approval.
- **CẦN CHỌN:** quyết định có thể đổi UX, stack, scope hoặc chi phí; không tự biến thành mặc định đã chốt.
- **CHƯA KIỂM:** cần triển khai/qualification/bằng chứng thực tế; tài liệu không lấp bằng dữ liệu giả.

## 2. Nhật ký quyết định

| ID | Nhãn | Nội dung | Hệ quả |
|---|---|---|---|
| D-01 | XÁC NHẬN | Chỉ phát triển cho Flow và ChatGPT. | Provider khác là tài liệu tham khảo, không phải chức năng app. |
| D-02 | XÁC NHẬN | Tạm bỏ việc tìm/tải Bridge, để lấy Bridge. | Bridge/Max Speed không là dependency/blocker của thiết kế MVP; native RPC cũng tạm để nghiên cứu. |
| D-03 | XÁC NHẬN | Chuyển nghiên cứu thành tài liệu app để người dùng thiết kế. | Chỉ có deliverable tài liệu; chưa được phép triển khai/publish/generate. Từ 05/11/2026 người dùng cho chạy spike và generate thử (D-17); app vẫn chưa được duyệt triển khai. |
| D-04 | XÁC NHẬN | (06/11/2026) Một người, một batch được cấp lượt gửi tại một thời điểm, queue cục bộ bền. **Bổ sung:** batch còn lượt uncertain phải nhả runner cho batch khác trên **project khác**; journal ghi intent **trước** khi bấm; khởi động lại thì mọi intent chưa có receipt là uncertain, không gửi lại. | Project của batch cũ vẫn bị chặn, các lượt đã gửi vẫn được theo dõi. Trong batch chạy song song theo D-18. Chưa multi-account. |
| D-05 | XÁC NHẬN | (06/11/2026) Flow ảnh/video và GPT ảnh; ref theo capability đã qualify. Thứ tự phát hành theo D-15. | Không hứa mọi model/account; không quảng cáo mode chưa kiểm hoặc video trên GPT. |
| D-06 | XÁC NHẬN | (06/11/2026) Config/driver ToolFlow độc lập với nguồn nghiên cứu; không backend thương mại bản đầu. **Bổ sung:** selector và RPC gom vào một **profile có version**; mở app thì chạy self-check, lệch thì `PROTOCOL_DRIFT` và dừng. | Không copy license, pricing, secret hoặc private config làm dependency. Cập nhật profile là phát hành bản mới của app, không tải từ server. |
| D-07 | XÁC NHẬN → **thay bởi D-13** | (06/11/2026) Desktop-first UX. Runtime đã chốt ở D-13. | — |
| D-08 | XÁC NHẬN | (06/11/2026) Gửi thủ công là đường dự phòng (D-16) khi auto tắt hoặc chưa qualify. [ADR-0001](adr/0001-manual-submit-khi-auto-chua-qualify.md) | Flow: auto theo D-12 khi người dùng đã bật (D-19). ChatGPT: manual cho tới khi có auto được qualify. |
| D-09 | XÁC NHẬN | (06/11/2026) Một conversation GPT mới cho mỗi batch. **Bổ sung:** tối đa 15 lượt mỗi conversation, quá thì mở conversation mới; ghép kết quả theo **message id**. | Không trộn việc người dùng trong chat khác; kiểm isolation/turn ownership. |
| D-10 | XÁC NHẬN | (06/11/2026) Chưa nhận workflow canvas, MCP/Telegram, cloud, watermark, license. | Chỉ mở scope lại khi có yêu cầu mới. |
| D-11 | XÁC NHẬN | (06/11/2026) Cho người dùng lưu hồ sơ chưa rõ, giữ chặn project cũ và chỉ chủ động tiếp tục ở project khác. **Bổ sung:** gỡ chặn bằng job đối soát lại sau 10 phút, hoặc người dùng tự xác nhận "đã gửi"/"chưa gửi"; lượt uncertain **tính là đã tiêu credit**; không tự chạy lại lượt uncertain ở project mới trừ khi người dùng chọn. | Có đường tiếp tục mà không giả success/reset; xác nhận của người dùng ghi nguồn user-confirmed. |
| D-12 | XÁC NHẬN | (06/11/2026) Người dùng chấp nhận rủi ro ToS/khoá tài khoản để **auto-submit trên Flow bằng cách gọi listener click của Flow với event `isTrusted:true` giả** (kỹ thuật như TobyFlow, [04 §4.3](../research/04-google-flow-dom-v1.md)). Không giải/giả reCAPTCHA: token vẫn do Flow tự tạo. Không humanize để né chấm điểm. [ADR-0002](adr/0002-flow-auto-submit-trusted-listener.md) | Thay D-08 cho Flow: auto là đường chính, manual là dự phòng. Driver phải fail-closed khi listener không tìm thấy; tất cả quy tắc intent/không gửi trùng (07) vẫn giữ. Bằng chứng spike: [spikes/01-flow-cdp/FINDINGS.md](../../spikes/01-flow-cdp/FINDINGS.md). |
| D-13 | XÁC NHẬN | (05/11/2026) "Một app: desktop (UI, runner, SQLite, file) + extension làm cầu nối vào Chrome", chọn cách A "Extension mỏng, desktop giữ logic". Desktop là Electron + TypeScript theo mô tả cách A. | Desktop giữ runner, journal, driver và selector config; extension MV3 chỉ nhận lệnh nhỏ qua WebSocket `127.0.0.1` có token. Spike 01 bỏ `chrome.debugger` (bị `UNUSUAL_ACTIVITY`), extension thao tác bằng content script và gửi theo [ADR-0002](adr/0002-flow-auto-submit-trusted-listener.md). Framework UI và thư viện SQLite cụ thể chưa chọn. |
| D-14 | XÁC NHẬN | (05/11/2026) Bản đầu chạy trên **Windows + Linux**. | Naming, file host, packaging và qualification phải chạy trên cả hai. |
| D-15 | XÁC NHẬN | (05/11/2026) Lần phát hành đầu bắt buộc có: Flow ảnh từ prompt, Flow ảnh có ref, Flow video (từ prompt / khung đầu). | ChatGPT ảnh sang phase sau (P4); docs 05 giữ làm đặc tả cho phase đó. |
| D-16 | XÁC NHẬN | (05–06/11/2026) Gửi: "Cả hai: tự động, có đường thủ công dự phòng"; Flow auto theo D-12. Nhịp chạy: "B nhưng đặt giới hạn số lượt chạy cùng lúc". | Gửi xong lượt này thì chuẩn bị ngay lượt sau, nhiều lượt chạy song song, có trần. Con số mặc định của trần vẫn là ĐỀ XUẤT ở [ADR-0002](adr/0002-flow-auto-submit-trusted-listener.md). |
| D-17 | XÁC NHẬN | (05/11/2026) Kiểm thử dùng Chrome profile và project do người dùng chỉ định, "được phép tiêu thoải mái credit cho kiểm thử k cần xin". Từ lượt 10 đổi sang Profile 2 theo yêu cầu người dùng. | Không dùng tài khoản chính cho auto; ghi mọi lượt vào sổ spike/qualification. |
| D-18 | XÁC NHẬN | (06/11/2026, sửa cùng ngày) Trần song song mặc định của Flow: **1 tab, 8 video / 12 ảnh** đang chạy. Mức 4 tab / 20 video / 30 ảnh là tuỳ chọn **"Nhanh"**. | Chi tiết ở [ADR-0002](adr/0002-flow-auto-submit-trusted-listener.md). Throttle → giảm một nửa rồi tăng dần. |
| D-19 | XÁC NHẬN | (06/11/2026, sửa cùng ngày) Auto mặc định **TẮT**; người dùng tự bật sau khi đọc cảnh báo. | Chưa bật thì Flow chạy bằng gửi thủ công (D-08). Bật lưu theo từng tài khoản, ghi thời điểm người dùng xác nhận cảnh báo. |
| D-20 | XÁC NHẬN | (08/11/2026) Mỗi lô chỉ một loại: ảnh hoặc video. | Muốn cả hai thì tạo 2 lô, chạy lần lượt (D-04). |
| D-21 | XÁC NHẬN | (08/11/2026) Đối soát 10 phút không quyết được lượt không rõ thì lô đứng chờ người dùng bấm "Đã gửi"/"Chưa gửi"; app không tự tạo project Flow mới. | Lô khác đã xếp ở project khác vẫn chạy (D-04). |
| D-22 | XÁC NHẬN | (08/11/2026) Người dùng duyệt [design doc](../superpowers/specs/2026-11-08-toolflow-design.md): các lựa chọn [em] trong đó (React + Vite, better-sqlite3, electron-builder NSIS/AppImage, Chrome ≥ 156, extension load unpacked, single-instance, tải qua `chrome.downloads`) thành mặc định; thứ tự phase P0–P5 mới. | Đóng phần còn chọn của O-01, O-02; O-04 còn bố cục/màu sắc. |

D-02 xác nhận việc gác Bridge; quyết định mở rộng việc gác sang tự gọi native RPC trong bản đầu là định hướng thiết kế ở bộ docs này, không khẳng định người dùng đã bác vĩnh viễn native API.

## 3. Quyết định còn mở, không cản soạn UX nhưng phải chốt trước phần liên quan

| ID | Cần chọn | Chặn việc gì |
|---|---|---|
| O-01 | ~~Extension hay desktop + cơ chế browser connector~~ **Đã chốt: D-13, D-22.** | Installer và lifecycle. Không tự chọn stack ngoài D-13. |
| O-02 | ~~OS phát hành~~ **Đã chốt: D-14 (Windows + Linux), Chrome ≥ 156 (D-22).** | Tests/packaging. |
| O-03 | ~~Mode bắt buộc ở lần phát hành đầu~~ **Đã chốt: D-15.** | — |
| O-04 | Bố cục, màu sắc giao diện. Ngôn ngữ tiếng Việt (D-22); mức tự động đã chốt ở D-16. | Mockup chi tiết và acceptance UX. Chưa có layout/brand được duyệt. |
| O-05 | ~~Tài khoản test và ngân sách~~ **Đã chốt: D-17.** Còn chọn: tài khoản nào dùng cho qualification bản phát hành (gói có thể khác trần). | Live qualification. Không tự mua gói. |
| O-06 | Retention, quyền đọc file và nơi lưu đầu ra mong muốn | Tính năng quản lý file và diagnostic export. |
| O-07 | Repo GitHub cụ thể và quyền tạo/push/merge. Đã có Git repo local; chưa có remote. Người dùng chọn **chưa push, giữ local** (06/11/2026). | Mọi phase làm trên branch local; push/PR chỉ khi người dùng đổi quyết định. |

## 4. Bảng truy vết nghiên cứu → app

| Nghiên cứu | Mang vào app | Không kế thừa |
|---|---|---|
| [01 — Kiến trúc](../research/01-kien-truc-va-messaging.md) | UI tách runner/driver; message có scope | Hàng trăm handler, globals, host permissions quá rộng. |
| [04 — Flow DOM](../research/04-google-flow-dom-v1.md) | Preflight/settings/ref, baseline tile, ownership, download | Fallback click/Enter mơ hồ, settings bypass, giả Start/End theo vị trí chip. |
| [07 — Batch/queue](../research/07-gen-batch-queue-tasks.md) | Batch bền, output/download tách, mapping có preview | Hai thuật toán sequential khác nhau, output giả đủ quantity, quota của nguồn nghiên cứu. |
| [11 — Lưu trữ](../research/11-du-lieu-va-luu-tru.md) | Blob references, schema/migration, journal | Copy storage dump/identifiers/credential hay DB layout nguyên vẹn. |
| [12 — UI](../research/12-giao-dien.md) | Tách chuẩn bị, hàng đợi, chi tiết và phục hồi | Tất cả tab/marketplace/premium UI; screenshot không thành mockup ToolFlow. |
| [13 — Rủi ro](../research/13-rui-ro-va-bai-hoc.md) | Không gửi trùng, fail closed, kiểm sau thao tác | Hứa miễn phí/được ToS cho phép hoặc coi keepalive bất tử. |
| [15 — GPT contract](../research/15-chatgpt-config-contract.md) | Capability, attachment gating, turn ownership, lỗi text-only | Model/ref limits/private prefix của nguồn nghiên cứu thành quyền OpenAI. |
| [16 — Runtime](../research/16-flow-gpt-runtime-findings.md) | Tách dữ liệu được giao khỏi feature access và live acceptance | Coi config đã thu = driver đã chạy thành công. |
| [14 — Bridge](../research/14-flow-bridge-protocol-contract.md), [17 — Native](../research/17-flow-native-public-frontend.md) | Chỉ giữ nguồn nghiên cứu cho tương lai | Không thiết kế dependency hoặc client RPC trong bản đầu. |

Các bug/nhận định ở nghiên cứu chỉ dùng làm tình huống kiểm tra khi có căn cứ; không coi mọi kết luận tĩnh của báo cáo cũ là runtime truth. Những mục đã được chương 15–17 sửa phải đọc theo bản cập nhật.

## 5. Những gì chưa biết

- Chưa có app code, renderer, driver ToolFlow hoặc database thật.
- Chưa kiểm selector trên ChatGPT thật bằng driver của mình. Flow: auto/manual submit, upload ref và tải đã đạt ở spike 01 ([ADR-0002](adr/0002-flow-auto-submit-trusted-listener.md)), nhưng chưa có driver sản phẩm.
- Chưa có mode nào được qualify; chưa biết các giới hạn quyền/model/ref của tài khoản phát hành/test.
- Chưa có kết quả generation/download end-to-end, đóng gói hay test đa OS.
- Chưa lấy code Bridge; không tiếp tục tìm trong tác vụ này. Native schema/auth/live acceptance chưa hoàn chỉnh.
- Chưa thẩm định quyền tái sử dụng/phân phối code/config bên thứ ba hoặc chính sách provider hiện hành. Thiết kế độc lập không mặc nhiên giải quyết các vấn đề đó.

## 6. Ranh giới bàn giao hiện tại

Deliverable là **bộ tài liệu app đề xuất có truy vết, có tiêu chí nghiệm thu**, đủ để người dùng thiết kế và chốt các quyết định mở. Không phải một app dùng được hoặc một plan đã được cấp quyền thi hành.

Tác vụ đã ghi rõ Bridge tạm gác trong mục lục nghiên cứu; giữ nguyên evidence và các chương lịch sử, không xoá bằng chứng để làm bộ docs trông hoàn chỉnh hơn. Bản nghiên cứu `_work/storage/` và hình ảnh vẫn cần privacy review riêng trước bất kỳ lần đưa lên remote nào.

[Xử lý các điểm rà soát trước bàn giao](evidence/PARENT-DISPOSITION.md) là nhật ký kiểm tài liệu; không có reviewer độc lập chấp thuận do API lỗi và không có app test/live generation được chạy.
