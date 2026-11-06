# 13. Rủi ro, điểm yếu và bài học để tự build (ToolFlow)

> **Cập nhật runtime 05/11/2026:** [chương 16](16-flow-gpt-runtime-findings.md) đã thu được **82 selector Flow hiện tại**, config transport/correlation và **11 nhóm private config ChatGPT** trên gói Free. Các câu bên dưới nói chúng chưa quan sát được là giới hạn của lượt phân tích trước, không còn là blocker hiện tại. Phần giao thức **Max Speed + mã Bridge** vẫn chưa thu được. Lượt đào sâu mới chỉ tập trung Flow và ChatGPT.

Phần này tổng hợp mục "Điểm đáng học / Điểm yếu" của các tài liệu 01–12, rồi chuyển thành khuyến nghị cho dự án `ToolFlow`. Những gì là khuyến nghị thiết kế thì được ghi rõ là khuyến nghị, không phải quan sát.

## 13.1 Rủi ro cho người dùng ToolFlow

| Rủi ro | Căn cứ | Mức |
|---|---|---|
| **Vi phạm ToS và mất tài khoản Google/OpenAI/xAI** | Lách `isTrusted` bằng Proxy event, gọi RPC nội bộ Flow qua Bridge, tự chọn năm sinh khi Grok hỏi xác minh tuổi, gửi hàng loạt. Tài khoản bị khoá là **của user** | Cao |
| **Xoá watermark** | Đảo alpha logo Gemini/Flow (alpha map từ server); có rủi ro pháp lý và chính sách nội dung AI | Cao |
| **Server điều khiển hành vi trên trang AI** | Extension có `<all_urls>`, `scripting`, content script MAIN world. Selector, pattern và giao thức đều tải từ server. Nếu server hoặc bản update bị chiếm quyền, nó có thể làm bất cứ điều gì trong phiên ChatGPT/Google của user | Trung bình–cao |
| **Bí mật lưu ở dạng thô** | Secret HMAC (`tool_client_enrollment`) nằm plaintext trong `chrome.storage.local`. Token MCP được dán plaintext vào cấu hình agent | Trung bình |
| **Telemetry** | heartbeat phiên, usage events, fingerprint khi chưa đăng nhập; server lưu `registration_ip`/`last_login_ip` | Thấp–trung bình |
| **Phụ thuộc server** | Không có config hoặc lease thì không chạy. Free chỉ có polling 30 s | Vận hành |
| **Mất kết quả hoặc credit** | Kết quả mơ hồ cuối cùng bị "settle_local_unverified_no_resubmit"; upscale không khôi phục receipt; auto-download dồn về cuối job | Thấp |

## 13.2 Nợ kỹ thuật quan sát được (để biết họ đau ở đâu)
- File khổng lồ một class: `WorkflowEditor` 1,25 MB, `WorkflowExecutor` 597 KB, `content.js` 620 KB, `GenTab` 463 KB. Phụ thuộc nhiều `window.*` global.
- Mã chết hoặc nói dối: phím Alt+G/Alt+S không hoạt động, `ping` quảng bá `singleNodeSessions` không có handler, `BridgeClient.stream`, `BatchQueue`, `QueuePanel`, `DownloadExecutor`, nhánh BroadcastChannel của leader election.
- Bug: `onSuspend` gọi `executions/{id}/complete` không ký (execution có thể bị treo); `BackendSync` tự tắt vĩnh viễn sau lỗi đầu và có fallback ghép đường dẫn `/api/v1/api/v1`; thông báo Task dùng `t.name` thay vì `task_name`; hai thuật toán gán ref "tuần tự" khác nhau giữa Gen và Task.
- Config server gợi ý hành vi mà đường chính không làm: `backoff_*` chỉ dùng ở đường direct; `priority` của selector không được đọc.
- "v2" bị dùng cho ba khái niệm khác nhau.

## 13.3 Bài học đáng mang về ToolFlow

**Kiến trúc**
1. **Một cửa HTTP trong service worker:** ký, retry, breaker, đo lệch đồng hồ, xử lý 429. UI và content script không giữ bí mật và không tự gọi API. ([01](01-kien-truc-va-messaging.md), [03](03-backend-api-va-realtime.md))
2. **Driver theo provider, selector là dữ liệu:** registry có version, nhiều fallback theo thứ tự, mỗi thao tác đều **kiểm chứng sau khi làm** (text đã vào editor chưa, chip đủ chưa, nút gửi đã disabled chưa). Có `reportFailure` để biết selector nào hỏng. ([04](04-google-flow-dom-v1.md), [06](06-chatgpt-grok-gemini-muse.md))
3. **Điều phối tách khỏi thực thi:** sidebar giữ máy trạng thái, content script chỉ làm thao tác nhỏ, mọi lệnh mang `_flowTarget` (tab, project, driver) để không chạy nhầm tab.
4. **Lấy kết quả theo baseline:** chụp trạng thái trước khi gửi (số tile, turn, fingerprint) và gán quyền sở hữu kết quả nhiều lớp. Không lấy "ảnh mới nhất" một cách mù quáng.

**Độ bền**

5. **Bất biến "đã có thể gửi thì không gửi lại":** stage `pre_dispatch → receipt → ambiguous → accepted/terminal` gắn vào mọi kết quả, retry chỉ đọc `stage`. Mơ hồ thì chuyển `needs_review` thay vì retry. ([05](05-google-flow-api-v2-max-speed.md), [09](09-motion-studio-angles-effects-video.md))
6. **Lease + epoch + journal/outbox trong IndexedDB** cho mọi hàng đợi, để chịu được việc MV3 kill service worker. Có backpressure khi ghi blob lớn.
7. **Nhịp chống bị chặn:** random delay theo từng prompt, nghỉ dài sau mỗi batch, chunk-reload có drain, retry đẩy về cuối hàng; gặp captcha thì pause/resume chờ người, không tự giải.
8. **Fail-closed khi thiếu config:** dừng và báo mã lỗi rõ thay vì đoán.

**Sản phẩm**

9. **Workflow DAG** có port typing (`text/image/video/frame/any`), output ghi vào node nên resume rẻ, mention `@slug` và node "trong suốt" (delay/note).
10. **Agent điều khiển qua MCP:** runner_id theo profile, heartbeat khai báo capability, kết quả qua outbox idempotent. Lệnh phá huỷ cần `confirm` + `expected_revision`.
11. **Dùng tab đã đăng nhập làm "LLM miễn phí"** cho transcript và image→prompt, bọc đầu ra bằng marker và validate chặt.

## 13.4 Khuyến nghị cho ToolFlow (đề xuất, chưa phải quyết định)
- **Nên bỏ hoặc hạn chế:** xoá watermark; lách `isTrusted` khi đã có đường hợp lệ (API chính thức hoặc user tự bấm ở `manualSubmitMode`); tự trả lời xác minh tuổi; licensing/DRM nếu chỉ dùng nội bộ.
- **Nên đơn giản hoá:** selector để ở file JSON trong repo có version, tải được từ URL tự host; không cần protected config hay ECDSA nếu không bán.
- **Nên làm khác:** đặt điều phối ở **offscreen document hoặc service worker có keepalive** thay vì side panel, để đóng panel không làm dừng job. Tách executor thành module nhỏ có test. Tính topo ở client, có server thì chỉ để đồng bộ.
- **MVP gợi ý theo thứ tự:**
  1. Driver Flow DOM + hàng đợi bền (IndexedDB, stage, `needs_review`).
  2. Auto-download theo template tên file.
  3. Driver ChatGPT.
  4. Workflow DAG tối thiểu (Image → Prompt → Provider → Download).
  5. MCP local (stdio) để Claude điều khiển.

Mỗi bước nên kèm test e2e trên profile Chrome thử, không dùng tài khoản chính.

## 13.5 Câu hỏi mở xuyên suốt
- Mã của extension Bridge và giao thức RPC thật của Flow (`protocol.rpc.*`, wire schema): cần cài Bridge, có tài khoản trả phí và quan sát runtime.
- Selector Flow, `error_patterns` và config watermark: chỉ có trong RAM sau khi có lease.
- Server lập `level_index`/`parallel_allowed` cho workflow theo tiêu chí nào; hạn mức MCP thật; `/enroll` chống lạm dụng ra sao.
- Danh sách câu hỏi mở chi tiết nằm cuối mỗi tài liệu 01–12.
