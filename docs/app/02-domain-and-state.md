# 02 — Dữ liệu, hàng đợi và máy trạng thái

**Hợp đồng thiết kế đề xuất, không phải schema đã triển khai.** Mọi tên dưới đây là vocabulary chuẩn cho các chương còn lại.

## 1. Thực thể

| Thực thể | Trường tối thiểu | Bất biến |
|---|---|---|
| BrowserSession | sessionId, connectionKind, grantedOrigins, state | Không chứa cookie/password/token; ID phiên không phải credential. |
| Target | sessionId, tabId, provider, projectId hoặc conversationId, bindingRevision | Kiểm lại trước tác động; thay đổi binding không tự retarget batch đã chạy. |
| CapabilitySnapshot | provider, driverVersion, configVersion, qualifiedModes, visibleOptions, checkedAt, targetRevision | Phân biệt được nhìn thấy với đã qualify; hết hiệu lực khi target/config thay đổi. |
| Batch | batchId, name, provider, target, settingsSnapshot, status, stopRequested, recoveryDisposition, archiveDecision, createdAt | Settings/ref mapping đóng băng trước item đầu tiên; archived_unresolved không đồng nghĩa hoàn tất. |
| Item | itemId, batchId, sourceLine, order, prompt, mode, refs, state, currentAttemptId | Một prompt = một item; nhiều lần generate phải là nhiều attempt. |
| Attempt | attemptId, itemId, ordinal, targetSnapshot, baseline, dispatchStage, receipt, ownerEpoch, error | Không sửa attempt cũ thành lượt mới; lưu intent trước khả năng submit. |
| ReferenceAsset | assetId, kind, name, MIME, byteSize, contentHash, blobRef | Blob do người dùng nhập; ref mapping giữ role và thứ tự. |
| ProviderAssetBinding | assetId, provider, targetIdentity, remoteIdentity, verification | Không dùng remote ID của project/account khác. |
| Output | outputId, attemptId, providerIdentity, mediaType, ownershipEvidence, observedAt | Chỉ tạo output khi đủ bằng chứng; không dựng output giả để đủ số. |
| Download | downloadId, outputId, state, plannedName, actualName, transferHandle, error | Tách biệt generation; hoàn tất cần bằng chứng nền tảng. |
| JournalEvent | eventId, entityId, entityRevision, attemptId, ownerEpoch, type, time, safePayload | Ghi giao dịch; sự kiện cũ không ghi đè state mới. |
| RunnerOwnership | targetKey, ownerId, leaseExpiry, epoch, blockedByAttemptId | Lease hết hạn không xoá nguy cơ của attempt chưa rõ. |

Mốc thời gian lưu UTC; khi hiển thị/đặt tên dùng timezone đã lưu trong batch. Có schemaVersion và migration. Prompt, ref, lịch sử là dữ liệu cá nhân dù không phải credential.

Khi nhân bản sang target khác, batch/item/attempt có ID mới; lưu sourceBatchId/sourceItemId/sourceAttemptId nếu có. Đây là lượt người dùng chủ động tạo mới, không sửa identity hoặc outcome của attempt gốc. Liên kết nguồn cần hiển thị trong lịch sử để giải thích nguy cơ gửi nội dung lần nữa.

## 2. Item.state

| State | Nghĩa | Hành động chính |
|---|---|---|
| queued | Chưa chuẩn bị/chưa có thể gửi | Chạy, huỷ hoặc giữ chờ. |
| preparing | Kiểm target/settings/ref và chụp baseline | Fail trước submit hoặc tiếp tục. |
| awaiting_user | Chờ login/captcha/manual submit | Kiểm tra lại; nhánh tiếp theo phụ thuộc dispatchStage. |
| submitting | Intent đã ghi; có thể sắp/đã tác động gửi | Xác nhận receipt hoặc chuyển needs_review. |
| generating | Đã có bằng chứng được chấp nhận | Theo dõi output/lỗi; không gửi lại. |
| ready | Có output thuộc attempt | Tải và xem kết quả; chưa đồng nghĩa file đã lưu. |
| failed | Lỗi xác định, không còn outcome chưa rõ | Xem lỗi; lượt mới cần quy tắc retry. |
| needs_review | Không biết đã gửi/chủ output chưa rõ | Đối soát hoặc quyết định có xác nhận. |
| cancelled | Chắc chắn chưa gửi và đã huỷ | Không tự chạy lại. |

Chuyển chính: queued → preparing → submitting → generating → ready. Chờ người có thể xuất hiện trước/sau intent. Lỗi chuẩn bị xác định → failed; sự không chắc chắn từ intent trở đi → needs_review. Không có cạnh tự động needs_review → submitting.

Một output có thể xuất hiện ngay sau submit trước khi từng quan sát generating: ghi acceptance và ownership evidence trong cùng giao dịch rồi ready. Không bắt UI giả vờ đã nhìn thấy spinner.

## 3. Attempt.dispatchStage

| Stage | Ý nghĩa và giới hạn |
|---|---|
| not_started | Chưa ghi intent, không thực hiện hành động submit. |
| intent_recorded | Đã ghi ý định; từ đây crash có thể che việc đã click. Không tự replay. |
| accepted | Có receipt hoặc bằng chứng chấp nhận đã qualify, gắn đúng target/attempt. |
| rejected_before_dispatch | Có bằng chứng thao tác chưa thể tới provider; được phép retry chuẩn bị trong cùng attempt. |
| outcome_known | Đã có output đúng chủ hoặc lỗi provider xác định cho attempt. |
| uncertain | Không đủ bằng chứng để kết luận; cần đối soát. |

Ghi intent bền vững trước click/manual-submit opportunity. Nếu crash giữa ghi intent và click, chấp nhận false-positive cần kiểm tra để tránh gửi trùng. Nút disabled/editor rỗng chỉ là tín hiệu hỗ trợ; không tự chứng minh có ảnh đúng chủ.

**Retry:** chuẩn bị an toàn có thể thử trong cùng attempt trước intent; một lượt generate mới sau intent/accepted/uncertain phải tạo attempt mới sau xác nhận của người dùng. Giữ đủ lịch sử và cảnh báo khả năng tốn thêm credit.

## 4. Download.state

not_requested → queued → transferring → completed | failed | needs_review.

- auto-download tắt: not_requested là trạng thái hợp lệ, không kéo batch thành thất bại.
- failed có thể queued lại khi chắc transfer cũ không còn sống; không đụng Item/Attempt sinh nội dung.
- needs_review khi đã giao cho hệ thống tải nhưng mất handle/ACK. Tra transferHandle/lịch sử tải trước khi tạo transfer khác.
- completed cần nền tảng báo lưu xong, tên thực tế và bằng chứng kiểm file phù hợp khả năng host. File HTML/error page không thành ảnh/video chỉ vì có đuôi đúng.

## 5. Batch.status và tổng kết

draft → queued → running ⇄ paused. Trong quá trình có thể needs_review; trạng thái kết thúc gồm completed, partial_failed, failed, stopped. `stopRequested` tách riêng để diễn tả đang ngừng trong khi đối soát việc đã gửi.

**Thứ tự suy trạng thái** (chạy lại sau mọi thay đổi):

1. Có attempt/transfer chưa rõ hoặc ownership tranh chấp → needs_review, kể cả khi stopRequested.
2. Có công việc đã gửi còn hoạt động → running hoặc paused theo cờ admission; nếu stopRequested hiển thị Đang dừng, tiếp tục đối soát.
3. Không còn bất định/hoạt động và stopRequested → stopped; giữ mọi output và lỗi.
4. Chưa kết thúc item hoặc download bắt buộc → queued/running/paused tương ứng; không completed sớm.
5. Mọi item ready và mọi download được yêu cầu completed → completed.
6. Có kết quả thành công nhưng còn item failed/cancelled hoặc download failed → partial_failed.
7. Không có item tạo output thành công và mọi item đã chốt lỗi → failed.

Download auto tắt không là download bắt buộc. Mặc định một output mục tiêu/item; nếu có nhiều output đã xác minh thì tất cả được đưa vào kế hoạch tải. Với batch stopped, UI vẫn hiển thị số kết quả/tải thành công thay vì xoá tiến độ.

`recoveryDisposition=archived_unresolved` là nhãn quản trị độc lập, không sửa outcome: batch/item chưa rõ vẫn needs_review và target tombstone vẫn giữ blockedByAttemptId. Chỉ khi người dùng xác nhận và connector cũ đã ngừng mọi tác động, runner mới nhả slot toàn cục để họ chủ động chạy batch trên **target khác**. Journal giữ archiveDecision và cảnh báo provider có thể còn chạy. Không tự resume batch này; xem đầy đủ điều kiện ở chương 07.

## 6. Journal, lease và recovery

- Enqueue batch, settings snapshot và item trong một transaction. Không có batch "đã thêm" nhưng thiếu item sau crash.
- Runner claim khoá toàn cục MVP và khoá target; nhận epoch mới. Mọi lệnh ghi kèm epoch và entityRevision; stale response chỉ là evidence phụ, không được mutate trạng thái đang sở hữu bởi owner khác.
- Ghi intent trước side effect, receipt/output binding sau quan sát. Transaction hoàn thành phải có ý nghĩa durability được storage/nền tảng chứng minh; không coi một Promise resolve hoặc đổi tên file đơn thuần là mọi kiểu mất điện đều an toàn.
- Sau crash, runtime mới chặn admission, đọc intent/receipt/transfers và đối soát. Lease cũ hết hạn cho phép takeover để đọc/recover, không cho phép replay hoặc mở batch mới trên target còn bị attempt bất định chặn.
- recoveryDisposition không được dùng làm tắt lease tự động. Sau archive, target tombstone vẫn tồn tại qua restart; phản hồi cũ không được gán sang batch mới. Chỉ đối soát có bằng chứng mới được xoá blocker của target cũ.
- Manual close UI không xoá ownership. Không giữ job state độc quyền trong component UI hay bộ nhớ của một cửa sổ.
- Cấu hình/target snapshot của attempt giữ nguyên khi selector được cập nhật; không hot-swap driver giữa một hành động đã bắt đầu. Recovery có thể dùng reader mới đã validate để đọc, không biến nó thành quyền submit.

## 7. Xoá và retention

Cấm xoá batch/attempt/refs đang được item sống tham chiếu, including needs_review. Sau khi kết thúc và không còn lock, dọn thumbnail/blob theo policy; giữ metadata tối thiểu để giải thích outcome theo thời hạn người dùng chọn. Xoá dữ liệu local không mặc định xoá file đã tải hay nội dung trên provider.

**Tham khảo:** [queue](../research/07-gen-batch-queue-tasks.md), [ownership Flow](../research/04-google-flow-dom-v1.md). ToolFlow không sao chép nguyên 14 trạng thái hoặc output giả trong nghiên cứu.
