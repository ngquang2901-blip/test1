# 03 — Kiến trúc và contract

**Mục tiêu:** tách quyết định sản phẩm khỏi nền tảng. Chưa chọn Electron, framework UI, database hay cơ chế điều khiển browser. Đây là ranh giới module đề xuất, không phải cấu trúc code đã tồn tại.

## 1. Các khối

```text
UI → Application commands → Durable queue / Runner → ProviderDriver
                              ↕                 ↕        ↕
                       Storage + Journal   Media service Browser connector
                              ↕                 ↕        ↕
                         Diagnostics       Download host  Tab provider
```

- **UI:** nhập liệu, hiển thị state và yêu cầu hành động. Không giữ chân lý của job; không tự click provider.
- **Application:** validate command, revision, scope, quyền người dùng; chặn thay đổi batch sống.
- **Runner:** admission, tuần tự, ownership/epoch, intent trước tác động, recovery và aggregate outcome.
- **Storage/Journal:** giao dịch batch/attempt/output, blob references và migration; duy nhất một đường cập nhật state.
- **BrowserConnector:** tìm/bind target, kiểm origin/session/navigation, phát hiện disconnect. Không thu password/cookie.
- **ProviderDriver:** thao tác nhỏ, có xác nhận hậu điều kiện. Không tự tạo vòng retry generate.
- **Media/Download:** quản lý ref, output identity, đặt tên và xác nhận transfer độc lập generation.
- **Diagnostics:** mã lỗi, evidence tối thiểu, gói xuất có preview; không telemetry mặc định.

## 2. Hai cách đóng gói, chưa quyết định

| Cách | Lợi thế cho sản phẩm này | Ràng buộc cần chứng minh |
|---|---|---|
| Browser extension | Dùng tab đã đăng nhập, không cần browser attach từ app khác; có thể tận dụng API tải của browser | Quyền host hẹp, runtime có thể bị suspend; không giữ runner trong panel; thư mục tải bị browser giới hạn. |
| Desktop app + connector | Không gian UI rộng, chủ động file local và tiến trình runner | Cần thiết kế kết nối browser/phiên đã đăng nhập, installer/permissions và bảo vệ kênh điều khiển; không tự lấy profile khác. |

Chưa chọn vì người dùng đang thiết kế app. Gợi ý lựa chọn theo UX: nếu chủ yếu chạy cạnh tab thì cân nhắc extension; nếu cần workspace/file local rộng thì cân nhắc desktop. Không dùng lựa chọn đóng gói để thay đổi các bất biến [02](02-domain-and-state.md).

Nếu chọn extension, qualification phải bao gồm service-worker suspension và browser restart; không coi offscreen/keepalive là bảo đảm sống vô hạn. Nếu chọn desktop, phải chứng minh connector ownership, mất kết nối và sandbox/IPC. Không cần dựng cả hai trong MVP.

## 3. Application commands

Mỗi command có commandId, entityId, expectedRevision, payload đã validate. Trả entityRevision mới hoặc mã lỗi an toàn; UI không tự đoán command đã thành công khi mất ACK.

| Command | Ý nghĩa |
|---|---|
| saveDraft / enqueueBatch | Parse/validate, lưu atomic; lặp commandId không thêm batch lần nữa. |
| startBatch / pauseBatch / resumeBatch | Chuyển admission; kiểm runtime, target, ownership và recovery blockers. |
| stopBatch | Ghi stopRequested, huỷ item chắc chắn chưa gửi; giữ đối soát sau gửi. |
| recheckSession / reconcileAttempt | Hành động đọc/kiểm an toàn; không phát sinh submit. |
| createNewAttempt | Cần xác nhận sinh mới, giữ attempt cũ; không giải phóng blocker chưa rõ chỉ vì người dùng bấm. |
| archiveUnresolvedBatch | Xác nhận rủi ro, stopRequested và quiesce connector cũ; giữ needs_review/journal/blocker target cũ, chỉ cho người dùng chủ động chọn target khác. |
| retryDownload | Chỉ transfer cho output hiện có và sau khi chắc transfer cũ không còn sống. |
| exportDiagnostics / purgeLocalData | Preview đối tượng/phạm vi; exclude dữ liệu đang sống; cần user action. |

Idempotency command local không bảo đảm provider idempotency. Browser click không có idempotency key đáng tin cậy thì phải bảo vệ bằng intent/reconcile.

## 4. ProviderDriver contract

Các tên là interface thiết kế. Input luôn kèm attemptId, target snapshot, epoch, driver/config version, cancellation/admission signal.

| Operation | Input/Output tối thiểu | Side effect và yêu cầu |
|---|---|---|
| inspectSession | Target → readiness, safe reason, identity snapshot | Đọc; login/challenge không là "ready". |
| discoverCapabilities | Target → visibleOptions + qualifiedModes | Đọc; nhìn thấy không đồng nghĩa được phép sử dụng. |
| prepare | Prompt, settings, refs → applied settings/ref proof | Có sửa composer/UI; không submit; không bỏ tuỳ chọn ngầm. |
| snapshotBaseline | Target → media/turn identities, time, revision | Đọc trước intent; baseline cần lưu bền. |
| submitOnce | Prepared proof + baseline + persisted intent → accepted/rejectedBeforeDispatch/uncertain + evidence | Tối đa một submit opportunity; không fallback click/Enter khi đã có thể gửi. |
| observeAttempt | Receipt/baseline/identity → pending/output/error/ambiguous | Đọc; cần ownership evidence, không gửi prompt. |
| reconcileAttempt | Journal/baseline → known outcome hoặc unresolved | Chỉ đọc; không reload/chỉnh composer như một phần "đối soát". |
| resolveOutput | Owned output identity → current download source | Không generate/upscale; URL chỉ là locator, không là identity. |
| release | Owner token → detach observers/local locks | Không huỷ hay xoá nội dung provider. |

`release` chỉ dọn observer/tài nguyên cục bộ của đúng owner; không xoá persistent target blocker. `archiveUnresolvedBatch` không gọi release như một cách chứng minh provider đã dừng: phải xác nhận mọi lệnh có thể tác động của connector cũ đã kết thúc hoặc connector đã đóng có fencing. Nếu host không chứng minh được local quiescence, archive vẫn chặn nhả slot.

**Pause/stop fence:** admission và cấp dispatch permit được tuần tự hoá với command pause/stop. Khi ACK pause/stop, không cấp permit mới; ACK kèm danh sách permit/intent đã giao connector. Hành động đã giao có thể vẫn tới provider sau ACK nên phải theo dõi như có thể đã gửi. Không đổi chúng thành cancelled chỉ dựa vào thời điểm ACK; driver phải kiểm epoch/target ngay tại boundary thao tác.

Reference upload là bước prepare riêng có journal/remote binding; nếu đã có thể upload, chỉ reconcile, không bấm lại theo timeout. Upload có thể gửi dữ liệu ra provider nhưng không có quyền tạo nội dung.

## 5. Kết quả và lỗi thống nhất

Driver result có kind, dispatchStage, evidence, safeError và observedTargetRevision. Không dùng boolean success để gộp "đã click", "đã nhận", "đã tạo" và "đã tải".

Mọi error có code, phase, dispatchCertainty, userAction và retryPolicy. Policy generate do runner quyết định từ journal; driver không được tự đánh dấu retryable=true rồi gửi lại. Danh mục lỗi chuẩn ở [07](07-safety-and-recovery.md).

Event gửi UI có eventId, entityRevision, attemptId. UI bỏ bản cũ theo revision và đọc lại trạng thái sau mất kết nối; event stream không là storage.

## 6. Cấu hình driver độc lập

- Selector/config do ToolFlow tự viết, version trong source; chỉ các giá trị đã kiểm trên trang được bật. Không gọi backend bên thứ ba để boot hay lấy entitlement.
- Registry ghi provider, origin allowlist, schemaVersion, version, selectors theo thao tác, tín hiệu xác nhận, timeout profile và qualification record.
- Validate syntax/schema, required operation keys, loại selector và version trước áp dụng. Config là dữ liệu, không JavaScript được eval từ remote.
- Cập nhật tại safe boundary; rollback về bản tương thích đã biết chỉ khi có record, không đoán selector để tiếp tục gửi.
- Dữ liệu nghiên cứu chỉ giúp xây test; không vendoring nguyên mã extension, license/signature hay kho private config của nguồn nghiên cứu.

## 7. Ranh giới tin cậy

Provider page, DOM, filename, prompt và message từ trang đều không đáng tin. Kiểm sender/origin/tab/frame, schema và attempt/epoch. DOM không có quyền ra lệnh submit/browse arbitrary URL/xuất dữ liệu. Bridge nội bộ nếu cần sau khi chọn platform phải có scope hẹp; không mở cổng điều khiển LAN mặc định.

**Nguồn:** [kiến trúc](../research/01-kien-truc-va-messaging.md), [rủi ro](../research/13-rui-ro-va-bai-hoc.md), [runtime](../research/16-flow-gpt-runtime-findings.md). Đặc tả này chủ ý bỏ licensing/backend bên thứ ba và không chốt cơ chế trusted-input chưa kiểm thử.
