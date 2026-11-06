# 07 — An toàn, lỗi và tiếp tục công việc

## 1. Bất biến bắt buộc

1. Không có thể submit nếu chưa ghi intent bền. Nếu storage lỗi, không gửi.
2. Một intent có thể đã tới provider thì không tự replay, kể cả timeout, restart, pause/resume hoặc lease hết hạn.
3. Không xác minh được ownership thì không nhận output là thành công.
4. Generation, upload và download có journal/đối soát riêng. Retry tải không sinh nội dung.
5. Mỗi tác động kiểm target + ownerEpoch + stop/admission; lệnh cũ sau reconnect không được áp dụng.
6. Đóng UI không làm mất chân lý hàng đợi. Suspend/crash bắt buộc recovery trước admission.
7. Người dùng xử lý login/captcha/consent; app không giả quyền, né challenge hoặc đổi tài khoản ngầm.
8. Không phụ thuộc backend bên thứ ba/Bridge để chạy MVP. Config thiếu thì chặn thao tác có rủi ro.

## 2. Danh mục lỗi chuẩn

Mỗi lỗi ghi code, phase, attemptId, dispatchCertainty, userAction, safeEvidence. UI hiển thị câu dễ hiểu và CTA, không dump raw exception.

| Code | Nghĩa | Hành động cho người dùng / runner |
|---|---|---|
| SESSION_NOT_READY | Chưa có phiên/tab phù hợp | Chọn/cấp quyền đúng tab; kiểm lại. |
| AUTH_REQUIRED | Provider cần đăng nhập | Mở tab để người dùng tự đăng nhập, sau đó reconcile nếu đã có intent. |
| HUMAN_REQUIRED | Challenge hoặc thao tác thủ công | Hướng dẫn tại tab; không auto-resubmit khi hết challenge. |
| CONSENT_REQUIRED | Provider cần người dùng chấp thuận | Người dùng tự đọc/quyết định; từ chối thì dừng an toàn. |
| TARGET_CHANGED | Tab/project/conversation/session đổi | Pause; phục hồi binding hoặc đối soát, không chọn target khác ngầm. |
| USER_INTERFERENCE | Composer/media đang bị sửa ngoài runner | Pause; không ghi đè nội dung ngoài app. |
| CAPABILITY_UNAVAILABLE | Tổ hợp chưa hỗ trợ/không có quyền | Chỉnh draft mới; không đổi settings batch đã chạy. |
| CONFIG_INCOMPLETE | Thiếu/sai config cần cho thao tác | Hiện version/mục thiếu; cập nhật tại safe boundary. |
| SETTINGS_NOT_APPLIED | Không xác nhận được settings mong muốn | Chặn trước gửi; không bỏ qua lỗi rồi generate. |
| UPLOAD_NOT_VERIFIED | Không biết file đã attach/upload đủ | Đối soát asset binding; không upload lại sau khả năng dispatch. |
| SUBMIT_UNCERTAIN | Không biết provider đã nhận chưa | needs_review, chỉ đọc/đối soát; lượt mới cần xác nhận riêng. |
| RESULT_OWNERSHIP_AMBIGUOUS | Kết quả không xác định được chủ | needs_review; không gắn ảnh mới nhất. |
| RATE_LIMIT | Có dấu hiệu quota/rate limit cụ thể | Pause admission; hiển thị thông tin provider quan sát được, không đoán reset. |
| CONTENT_BLOCKED | Provider từ chối nội dung đúng attempt | Chốt lỗi; không tự sửa prompt né filter. |
| NO_IMAGE_OUTPUT | Đúng lượt đã trả nhưng không có ảnh | Giữ evidence; lượt mới là hành động generate có xác nhận. |
| PROVIDER_ERROR_UNKNOWN | Lỗi chung không đủ phân loại | Quyết định theo dispatchStage, không coi là lỗi mạng chắc chắn. |
| DOWNLOAD_FAILED | Transfer đã thất bại rõ | Sửa quyền/mạng/dung lượng rồi retry cùng output. |
| DOWNLOAD_UNCERTAIN | Transfer có thể còn sống/đã xong | Tra handle/lịch sử; không tự tạo transfer trùng. |
| STORAGE_UNAVAILABLE | Không ghi journal/blob an toàn | Chặn gửi; hướng dẫn dung lượng/quyền; giữ state còn đọc được. |
| OWNER_CONFLICT | Runner khác/attempt chưa rõ giữ target | Chỉ takeover để recover sau xác minh; không xoá lock để chạy. |

## 3. Retry và timeout

Timeout là giới hạn quan sát, **không chứng minh thao tác chưa xảy ra**. Bộ timing của ToolFlow sẽ được chọn và qualify theo provider/mode/nền tảng; không tự kế thừa 300s hoặc nhịp polling trong nghiên cứu thành cam kết.

- Trước intent: thao tác đọc/chuẩn bị idempotent có thể thử lại hữu hạn theo profile được test; mỗi vòng kiểm pause/stop/epoch và không tích luỹ ref/menu.
- Sau upload intent: đối soát trước, không upload lại chỉ vì preview tới muộn.
- Sau submit intent: chỉ observe/reconcile. Provider báo lỗi rõ không tạo quyền auto-generate lần nữa; người dùng chọn lượt mới.
- **Ngoại lệ hẹp (XÁC NHẬN 06/11/2026, Flow):** nếu **chính response của request generate** trả một trong bốn mã `PUBLIC_ERROR_USER_REQUESTS_THROTTLED`, `PUBLIC_ERROR_HIGH_TRAFFIC`, `PUBLIC_ERROR_MODEL_OVERLOADED`, `PUBLIC_ERROR_CONCURRENT_LIMIT_REACHED`, tức Flow xác nhận đã từ chối (không có media id, không tạo gì, không trừ credit), runner được tự gửi lại đúng lượt đó. Backoff 30 s, nhân đôi tới tối đa 5 phút, **tối đa 5 lần**; hết lượt thì RATE_LIMIT + pause admission để người dùng quyết. Các mã này nếu xuất hiện trong poll (generation đã tồn tại) thì **không** thuộc ngoại lệ. Danh sách và test ở [`packages/flow-protocol/src/errors.mjs`](../../packages/flow-protocol/src/errors.mjs).
- Với download failed rõ: cho retry hữu hạn theo thao tác user hoặc policy đã test. Nếu transfer không rõ thì không tự retry.
- Không backoff vô hạn, không refresh/reload tab tự động sau khả năng dispatch. Pacing nhằm điều tiết hàng đợi và giới hạn, không hứa né anti-bot.

## 4. Xử lý needs_review

Ba đường, không có nút "bỏ qua an toàn" giả:

1. **Đối soát đọc:** tìm receipt, turn/tile lineage, output hoặc transfer thuộc attempt. Tìm được → ghi evidence rồi chuyển trạng thái thật.
2. **Người dùng kiểm tra:** mở đúng tab hoặc file đã tải; nếu gán output thủ công, kiểm identity/media và ghi nguồn user-confirmed. Không tự gọi đó là xác minh trực tiếp từ provider.
3. **Chưa giải được:** mặc định tiếp tục giữ blocker. Người dùng có thể chọn **Lưu hồ sơ chưa rõ** theo quy trình bên dưới; không reset attempt cũ thành not_started và không đánh dấu failed/completed giả.

**Lưu hồ sơ chưa rõ — đường tiếp tục có kiểm soát (đề xuất thiết kế):**

- User xác nhận hai điều riêng: provider có thể đã nhận/tốn credit và tiếp tục chạy; app chưa xác định được kết quả, không coi archive là huỷ/thất bại phía provider.
- Runner ghi stopRequested, huỷ item chắc chắn chưa gửi, dừng cấp permit và xác nhận connector/command cũ đã quiescent hoặc bị đóng/fenced. Chưa chứng minh được điều này thì không nhả slot.
- Ghi `recoveryDisposition=archived_unresolved` và archiveDecision (người dùng, thời gian, cảnh báo đã xác nhận). Status vẫn needs_review; giữ journal, identity và blocker target cũ xuyên restart. Không tự giải phóng target cũ.
- Có thể nhả slot điều phối toàn cục để người dùng tự chọn project/conversation **khác** trong cùng phiên được cấp quyền, tạo nháp mới từ phần chưa gửi và chủ động bấm chạy. Không retarget batch cũ và không gọi đó là retry an toàn. Nếu muốn sinh lại prompt đã có thể gửi, vẫn cần xác nhận sinh mới theo TF-22 và liên kết nguồn trong lịch sử.
- Phản hồi/output muộn chỉ là evidence của batch cũ; không nhận thành kết quả mới. Chưa chứng minh được target khác thực sự tách lineage thì không chạy. Mọi điều kiện này phải được qualify trước khi bật hành động archive.

Nếu không chứng minh được attempt cũ đã kết thúc, MVP vẫn không chạy lượt mới trên **target cũ**. Quy trình archive không hứa exactly-once ở provider và không bảo đảm không tốn credit cho lượt đã rời quyền kiểm soát. Không xoá journal/lock bằng nút Reset để lách trạng thái.

## 5. Pause, stop và quyền sở hữu

Pause ngừng admission nhưng có thể tiếp tục observer/download đã yêu cầu. Stop đánh dấu stopRequested và huỷ item chắc chắn chưa gửi, theo dõi phần đã gửi tới outcome. ACK đóng dispatch fence, không thu hồi permit đã giao connector: UI phải nêu lượt có thể đang gửi, không tuyên bố đã huỷ chúng. Không tuyên bố huỷ công việc trên server provider nếu chưa có cơ chế đã qualify.

Giải phóng target chỉ khi không còn attempt/transfer đang sống hoặc chưa rõ. Lease hết hạn không làm side effect cũ biến mất. Khi cài lại/uninstall/sửa data path trong lúc job sống: chặn hoặc export/settle trước theo tính năng host đã chọn, không dọn journal ngầm.

## 6. Dữ liệu và bề mặt truy cập

- Không yêu cầu mật khẩu, cookie, API token của provider trong form ToolFlow; login tại provider.
- Quyền origin hẹp, cần đến đâu xin đến đó. Không truy cập tab/site khác để dò dữ liệu.
- Không lưu raw headers, signed URL query, heap/profile dump hoặc auth object. Prompt/ref có thể nhạy cảm, chỉ giữ cục bộ theo retention.
- Diagnostic export mặc định loại prompt/ref/URL query/định danh account/project. Người dùng preview và chủ động chọn thêm nội dung; secrets vẫn luôn bị che.
- Log lỗi theo code/phase/IDs nội bộ; raw exception có thể chứa prompt/token nên không xuất trực tiếp.
- Nếu sau này có telemetry/cloud/MCP, đó là scope mới cần trust boundary và quyền riêng; không bật mặc định trong bản đầu.

## 7. Khi kiểm thử với tài khoản thật

Dùng tài khoản/project dành cho test do người dùng chọn; xác định số lượt và ngân sách trước. Ghi intent/ledger trước mỗi hành động generation. Không tự mua gói, thay entitlement hoặc thực hiện generation để chứng minh tài liệu.

Nghiên cứu tĩnh không kết luận việc tự động hoá được provider cho phép. Trước phân phối cần kiểm chính sách hiện hành; tài liệu này không thay đánh giá đó. Hiện không có test provider/live generation nào của ToolFlow đã đạt.

**Tham khảo:** [rủi ro](../research/13-rui-ro-va-bai-hoc.md), [contract GPT và lỗi classifier](../research/15-chatgpt-config-contract.md), [giới hạn bằng chứng](../research/16-flow-gpt-runtime-findings.md).
