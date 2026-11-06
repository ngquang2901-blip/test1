# Tài liệu nghiên cứu triển khai nội bộ

Tài liệu nghiên cứu triển khai nội bộ của ToolFlow: phân tích một extension Chrome tham chiếu (v1.3.138) và backend của nó (05/11/2026).

**Tài liệu thiết kế app mới:** đọc [ToolFlow — bộ tài liệu app](../app/README.md). Bộ dưới đây là **nghiên cứu tham khảo**, không phải scope hay đặc tả triển khai của ToolFlow.

**Phạm vi phát triển hiện tại: Flow + ChatGPT.** Đọc [16 — kiểm chứng runtime mới](16-flow-gpt-runtime-findings.md) trước: đã thu được selector Flow và config riêng ChatGPT trên gói Free; nhận định cũ “phải trả phí mới thấy” không còn đúng với các phần này. Các chương về provider khác giữ làm tài liệu lịch sử, không nằm trong lượt đào sâu tiếp theo.

**Bridge/Max Speed: tạm gác theo quyết định của người dùng.** Không tiếp tục tìm file, mua gói hoặc biến Bridge thành dependency của MVP. Native RPC ở chương 17 giữ làm nghiên cứu ngoài luồng triển khai bản đầu.

Bản đồ tổng thể vẫn bắt đầu từ **00**. Với hướng Flow DOM + ChatGPT, đọc **16 → 04 → 15 → 07**, rồi tra kiến trúc/lưu trữ khi cần. Chương **05, 14, 17** không phải blocker để thiết kế app.

| # | Tài liệu | Nội dung |
|---|---|---|
| 00 | [Tổng quan](00-tong-quan.md) | Extension tham chiếu là gì, các khối chức năng, kiến trúc, 5 điều cốt lõi, giá, các chỗ sửa so với bản đầu, phương pháp |
| 01 | [Kiến trúc & messaging](01-kien-truc-va-messaging.md) | Manifest, execution context, khoảng 250 message action của service worker, alarm, `executeScript`, vòng đời |
| 02 | [Xác thực, thiết bị, license](02-xac-thuc-thiet-bi-license.md) | Login/OAuth, enrollment, HMAC và ECDSA device proof, lease, 78 entitlement, execution token, mã lỗi, telemetry |
| 03 | [Backend API & realtime](03-backend-api-va-realtime.md) | Khoảng 196 endpoint, Mercure/SSE/poll, 26 event, đồng bộ, config versioning, stack, bảng giá |
| 04 | [Google Flow: DOM (v1)](04-google-flow-dom-v1.md) | Gõ prompt, submit lách `isTrusted`, ref/frames, tile state, captcha, recovery, tải file |
| 05 | [Google Flow: Max Speed (API v2)](05-google-flow-api-v2-max-speed.md) | Bridge, health/upload/submit/poll/resolve/upscale, chống gửi trùng 12 lớp |
| 06 | [ChatGPT, Grok, Gemini, Muse](06-chatgpt-grok-gemini-muse.md) | Adapter/Session/content script, selector thật, Cloudflare, worker song song |
| 07 | [Gen, hàng đợi, Tasks](07-gen-batch-queue-tasks.md) | Từ N prompt tới N file, 14 trạng thái item, ref/mention, quota, thư viện nội dung |
| 08 | [Workflow builder & executor](08-workflow-builder-executor.md) | 13 node, schema, kế hoạch chạy từ server, mention `@slug`, template/share |
| 09 | [Motion Studio, Angles, Effects](09-motion-studio-angles-effects-video.md) | Pipeline motion transfer, worker video, mediabunny, journal/recovery |
| 10 | [MCP, Telegram, I2P, watermark, Settings](10-mcp-telegram-i2p-watermark-settings.md) | 27 lệnh MCP, Telegram, Image→Prompt, thuật toán xoá watermark, 75 tuỳ chọn, thanh toán |
| 11 | [Dữ liệu & lưu trữ](11-du-lieu-va-luu-tru.md) | Khoảng 107 key `chrome.storage`, 7 IndexedDB, `af_settings`, `af_execution_config` |
| 12 | [Giao diện](12-giao-dien.md) | Ảnh chụp và bản đồ từng tab, editor, settings, website |
| 13 | [Rủi ro & bài học](13-rui-ro-va-bai-hoc.md) | Rủi ro người dùng, nợ kỹ thuật, bài học và khuyến nghị cho ToolFlow |
| 14 | [Hợp đồng Flow ⇄ Bridge](14-flow-bridge-protocol-contract.md) | Params/response, receipt, required-only schema; phân biệt giá trị thật với phần Max Speed chưa được cấp |
| 15 | [Hợp đồng config ChatGPT](15-chatgpt-config-contract.md) | 44 selector, 11 nhóm config runtime, consumer, fallback và hợp đồng tối thiểu cho ToolFlow |
| 16 | [Kiểm chứng runtime Flow + GPT](16-flow-gpt-runtime-findings.md) | Dữ liệu thật lấy được trên Free, cách thu, sửa kết luận cũ và ranh giới Bridge còn thiếu |
| 17 | [Frontend Google Flow công khai](17-flow-native-public-frontend.md) | Điều tra native transport/RPC từ mã Google; tách bằng chứng nguồn khỏi hành vi chưa chạy |
| 18 | [Kiểm chứng sống 1.3.142 trên Flow](18-flow-live-1-3-142.md) | Extension điều khiển Flow thế nào (DOM + MAIN world + interceptor), bản đồ RPC thật theo từng chế độ, quota/credit, diff 1.3.138→1.3.142 |
| 19 | [Số liệu đo sống 06/11](19-so-lieu-do-song-2026-11-06.md) | Chỉ số đo: thời gian từng lượt, RPC, credit Flow theo chế độ, quota Toby, nhịp poll, file tải về |

**Phụ lục**
- [img/](../app/img/): 17 ảnh UI
- [rea-summary.json](rea-summary.json): tóm tắt Evidence REA
- [_work/storage/](_work/storage/): dump `chrome.storage.local` đã che secret
- [_work/BRIEF.md](_work/BRIEF.md): quy ước phân tích

Nhãn: **[QS]** quan sát trực tiếp · **[SL]** suy luận · **[?]** chưa rõ. Mọi phân tích đều tĩnh hoặc dùng bản sao profile; không generate, không gọi API của provider.
