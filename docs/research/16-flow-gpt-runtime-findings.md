# 16. Kiểm chứng runtime: Flow và ChatGPT

**Ngày:** 05/11/2026. **Phạm vi mới theo yêu cầu:** chỉ Google Flow và ChatGPT; không tiếp tục Grok, Gemini, Muse, Motion hoặc công cụ watermark.

## Kết luận trước

**Không cần mua gói để đọc selector Flow và các config hành vi ChatGPT đang được cấp cho tài khoản Free.** Chúng đã được quan sát trong bộ nhớ của extension nguyên bản sau khi khởi động bình thường. Báo cáo trước đã suy quá xa từ việc chúng vắng trong dump storage.

| Câu hỏi | Kết quả lần này | Bằng chứng |
|---|---|---|
| Selector của Flow hiện tại có lấy được không? | **Có:** profile `v2`, 82 key, host `https://flow.google.com`, config version 273. Legacy: 64 key, host `https://labs.google`. | [flow-dom-config.json](evidence/flow-dom-config.json) |
| Các config điều khiển Flow web có lấy được không? | **Có:** 28 nhóm, gồm error patterns, giới hạn ref, driver, correlation, transport và native media identity. Không đồng nghĩa với giao thức Max Speed. | [flow-api-public-config.json](evidence/flow-api-public-config.json) |
| Error pattern/timing của ChatGPT có lấy được không? | **Có:** 11 nhóm config, server cấp bằng private-configs cho gói Free. | [chatgpt-private-config.json](evidence/chatgpt-private-config.json) |
| Selector ChatGPT? | **Có:** lưu riêng bản runtime để đối chiếu dữ liệu cũ. | [chatgpt-dom-config.json](evidence/chatgpt-dom-config.json) |
| Giao thức RPC của Max Speed có lấy được không? | **Chưa lấy được config riêng do Tool cấp:** `flowApi=false`, không có 6 nhóm `flow_api_v2_*`, không được cấp `bridge_download_url`. **Nguồn độc lập mới:** [chương 17](17-flow-native-public-frontend.md) lần được 24 native RPC ID từ frontend Google công khai; chưa chứng minh Bridge dùng đúng các ID/layout đó. | [runtime-config-receipt.json](evidence/runtime-config-receipt.json), [native contract](evidence/flow-native-public-contract.json) |
| Có tìm được mã Bridge không? | **Chưa:** không cài trong Default/Profile 1; không thấy gói trong Downloads. Endpoint update CRX trả 404. URL placeholder trong bundle web cũng 404. | §4 dưới đây |

Nhãn bằng chứng của bảng này là **[QS-runtime]** cho dữ liệu trong bộ nhớ và HTTP status; **không** phải bằng chứng đã generate thành công.

## 1. Cách quan sát và giới hạn

1. Dùng extension ToolFlow **1.3.138** nguyên bản đã cài, không vá code, không bật cờ quyền, không giả chữ ký.
2. Tạo profile tạm chỉ gồm `Local State`, Preferences, Extensions, Local Extension Settings và IndexedDB. **Không copy Cookies, Login Data, History** của trình duyệt. IndexedDB cần thiết để giữ đúng danh tính thiết bị đã được đăng ký.
3. Mở `sidebar.html` qua CDP trong Chrome headless; chờ 40 giây để bootstrap hoàn tất.
4. Chỉ đọc các trường cấu hình của `window.ProviderConfigManager`: `_cache.data.flow/chatgpt`, `_apiConfigsCache.data.flow.configs`, `_privateConfigs.chatgpt`, và tên những key `flow_api_v2_*`/`bridge_download_url` nếu được cấp. Không đọc/xuất token, secret hoặc private key.
5. Giữ response metadata gồm **pathname + status**, không giữ headers hay query string.
6. Kiểm thử hàm che thông tin: credential keys bị che, error pattern và timeout được giữ nguyên. Syntax check của probe qua `node --check` đạt.
7. Đã kết thúc Chrome tạm và xoá profile tạm. Source profile không bị sửa bởi script nghiên cứu.

**Side effect phải nói rõ:** bootstrap extension tự gửi các request quản lý phiên bình thường, bao gồm `extension-devices/claim`, settings sync và usage heartbeat. Đây không phải phiên "chỉ đọc trên server" tuyệt đối. Không gửi lệnh generation hay chủ động reserve execution, không nâng cấp gói, không mở trang provider.

**Hai lần quan sát:** lần đầu xác nhận config riêng của ChatGPT và selector Flow tồn tại; lần sau bổ sung `_apiConfigsCache` của Flow. Artifact hiện tại là lần sau. Không có thay đổi quyền giữa hai lần.

### HTTP quan sát được
- `/api/v1/auth/me`: 200.
- `/api/v1/extension-config/access`: 200.
- `/api/v1/extension-config/providers/dom-selectors`: 200.
- `/api/v1/extension-config/providers/api-configs`: 200.
- `/api/v1/extension-config/providers/private-configs`: 200.
- Gói thực: `free`; `chatgpt_enabled` dùng được; `flow_api_enabled` không dùng được.

Status 200 của private-configs **không** nghĩa là mọi config được cấp: phải đối chiếu `granted` và những trường thực nhận. Các nhóm Max Speed không có trong payload được cấp.

## 2. Đã biết thêm gì về Flow web

### 2.1 Tên cũ `slate_editor` nhưng editor mới là ProseMirror

Config profile hiện tại:

```json
{
  "slate_editor": {
    "selectors": ["flow-prompt-box .ProseMirror[contenteditable=\"true\"]"],
    "editor_kind": "prosemirror",
    "priority": "P0"
  },
  "submit_button": {
    "selectors": ["flow-prompt-box button[type=\"submit\"]"],
    "disabled_attributes": ["disabled", "aria-disabled"],
    "priority": "P0"
  }
}
```

**Bài học:** không suy framework/editor hiện tại từ tên file `slate-bridge.js` hoặc key `slate_editor`. Tên được giữ vì tương thích, còn config đã chuyển sang UI Angular với ProseMirror.

### 2.2 Định danh tile và media

- Tile gốc: `flow-grid-tile-container`.
- Thuộc tính định danh: `data-media-id`; tìm ở descendant khi container không giữ trực tiếp.
- Ảnh: `flow-image-tile img[data-media-id]`, fallback `flow-grid-tile-container img[data-media-id]`.
- Video: `flow-video-tile video[src]`; cấu hình riêng nói identity chỉ ổn định trong session.
- Pending: `flow-pending-tile`, đọc `.loading-percentage`.
- Lỗi: `flow-error-tile`.

Các selector cho chọn model, ratio, quantity, frame/ingredient, upload consent, character/voice, context menu, download, page settings và project đều có trong JSON. Đây là cấu hình quan sát được; chưa test từng selector trên trang Flow thật.

### 2.3 Đường `batchexecute` đã có giá trị thật

```json
{"version":1,"paths":["/_/AiSandboxAngularFrontend/data/batchexecute"]}
```

Đường này là **transport observer** của Flow web. Nó cho observer biết URL nào cần đọc; **không** cho biết RPC ID submit ảnh/video hay cấu trúc chính xác để tự gửi lệnh Max Speed.

`native_project_media_identity` có schema thật:
- `collection_path: [2]`
- `uuid_path: [0]`
- `project_path: [1]`
- `generation_path: [2]`
- `details_path: [5]`
- Phân loại ảnh: positive integer pair ở `[6,2]`.
- Phân loại video: có các rule riêng ở `[7,1,0]`, `[7,1,1]` hoặc các trường sâu hơn.
- Các đường URL ASB của ảnh/video nằm trong `asb_url_paths` (xem JSON).

Những path trên có nghĩa **tương đối với node phản hồi do bộ parser chọn**; không được áp mù lên raw HTTP body. Phải đọc cùng observer/parser trong [14](14-flow-bridge-protocol-contract.md).

### 2.4 Correlation không chỉ bật quan sát

Config thực:
- `observation_only: false`.
- Allowed/parallel surfaces: `gen`, `task`, `workflow`.
- Ảnh và video đều có `parallel_max_quantity: 16`.
- `max_active_operations: 16`.
- Observer ACK: 10 giây; receipt timeout: 90 giây; attempt TTL: 900 giây; request binding: 300 giây.

**Đây là trần cho cơ chế correlation**, không phải lời hứa mọi tài khoản có thể generate 16 output song song. Entitlement, queue và provider vẫn có giới hạn khác.

## 3. Đã biết thêm gì về ChatGPT

Server thực cấp 11 nhóm sau cho Free:

| Nhóm | Dữ liệu quan sát được |
|---|---|
| `ratios` | story→9:16, portrait→3:4, square→1:1, landscape→4:3, widescreen→16:9 |
| `error_patterns` | Regex text cho rate limit, content blocked, generation failed; giá trị đầy đủ trong JSON |
| `max_ref_images` | `image:10` |
| `supports` | ratio/ref_image/auto_download/humanized/image_mode=true; quantity/video=false |
| `urls` | base/create_url `https://chatgpt.com`, tab query `*://chatgpt.com/*` |
| `ui_text_patterns` | Xoá chat: `delete\|xóa`; tạo ảnh: `create image\|create an image\|tạo hình ảnh\|tạo ảnh`; alt ảnh được tạo |
| `chatgpt_model_labels` | Instant/Tức thì; Medium/Trung bình/Vừa; High/Cao; Pro; Extra High/Chuyên sâu |
| `ai_agent_prefix` | Prefix điều khiển AI Agent; đã thu được, không cần dùng để giải thích thao tác ảnh cơ bản |
| `chatgpt_model_slider_values` | Instant=0, Medium=1, High=2 |
| `timeouts` | ảnh=300.000 ms, text=90.000 ms |
| `reference_upload_timings` | preview=60.000 ms, completion=120.000 ms, settle=1.000 ms, polling=300 ms |

Lưu ý:
- Đây là nhãn **ToolFlow dùng để điều khiển UI**, không phải ID model API OpenAI.
- `max_ref_images=10` là giới hạn trong config ToolFlow, không phải xác nhận hạn mức tài khoản ChatGPT.
- `generation_monitor` và `media_allowed_hosts` không có trong 11 nhóm được cấp cho ChatGPT ở lần quan sát này; không được tự gán chúng sang ChatGPT chỉ vì provider khác có key tương tự.
- Pattern lỗi là heuristic so chữ. Một cụm như `please retry` quá rộng có thể cần đánh giá false-positive; có pattern không chứng minh classifier luôn đúng.

Xem phân tích từng consumer và hợp đồng config ở [15](15-chatgpt-config-contract.md).

## 4. Tìm Bridge: đã đi đến đâu

### 4.1 Phân phối chính thức nằm sau config được cấp

Trong extension:
- `BridgeClient` hard-code ID `heieobedadlfdkppgagnhfakcdapbfka`.
- `settings-page.js` lấy `bridge_download_url` bằng `ProviderConfigManager.getApiConfigValueSync("flow", ...)`.
- `ProviderConfigManager` kiểm `_privateGranted.includes("bridge_download_url")` cùng TTL và phiên đăng nhập.
- Tài khoản Free lần này **không được cấp key đó**.

Trong bundle JavaScript công khai của website, có UI admin để cấu hình `bridge_download_url`. Placeholder là `https://labs.tool.vn/downloads/toolbridge-latest.zip`; đoạn mô tả xác định đây là bản sideload. Chỉ đọc asset công khai; không truy cập admin hay thay config server.

**Kết quả thử đúng placeholder đó:** HTTP 404. Placeholder không phải bằng chứng URL phân phối thật.

### 4.2 Các nguồn khác đã kiểm
- Extension directories của `Default` và `Profile 1`: không có Bridge ID.
- Tìm tên gói Bridge trong Downloads: không thấy.
- Google public CRX update endpoint cho Bridge ID: HTTP 404 `error-unknownApplication`.
- Lịch sử download đã persist trên đĩa: không thấy tên file chứa bridge. Read-only SQLite thường bị khoá; immutable snapshot không bao phủ record mới còn trong WAL, nên không kết luận tuyệt đối về lịch sử gần nhất.
- Search công khai theo tên/ID không cho nguồn Bridge đáng tin cậy. Không tải các gói trùng tên không liên quan.

### 4.3 Tìm lại kênh phân phối chính thức (05/11/2026)

Đã kiểm trang chủ, `/guide`, `/toolflow`, mô tả hai video hướng dẫn được website nhúng, video giới thiệu của developer và trang Telegram `@ToolAI` được footer website liên kết. **Không tìm thấy link ZIP Bridge tải được trên các bề mặt công khai này.** Kiểm lại placeholder ZIP và Chrome CRX updater cho đúng Bridge ID vẫn đều trả HTTP 404.

- [Website chính thức](https://labs.tool.vn/), [Hướng dẫn](https://labs.tool.vn/guide).
- [Telegram chính thức được footer dẫn tới](https://t.me/ToolAI): là trang liên hệ, không thấy file Bridge công khai; chưa gửi tin nhắn.
- Repo GitHub `hongkongsa/toolflow` xuất hiện trong search nhưng chưa có bằng chứng thuộc developer. Không xem nó là nguồn phân phối chính thức và không tải gói thay thế từ mirror.
- [Receipt tìm kiếm và HTTP](evidence/bridge-official-distribution-search.json).

Kết luận giới hạn: **chưa lấy được gói chính thức**, không phải khẳng định Bridge không tồn tại. Nguồn phân phối đã thấy trong code là `bridge_download_url` được backend cấp theo quyền tài khoản.

### 4.4 Điều cần để hoàn tất phần còn lại

Chọn một trong các nguồn hợp lệ:
1. Gói ZIP/thư mục **ToolBridge do người dùng đã tải chính thức**; chỉ cần file, không cần token/cookie.
2. Tài khoản hiện tại thực sự có quyền Max Speed và extension cấp link/config qua luồng bình thường. Chưa mua hay đề nghị tự mua gói trong nghiên cứu này.
3. Nếu không có Bridge, quan sát một lượt Flow do người dùng chủ động chạy trong phiên của họ là **nguồn bằng chứng khác**; có thể làm rõ native request, nhưng không chứng minh thuật toán nội bộ của Bridge. Generation tốn credit cần ngân sách rõ trước khi chạy.

**Không** dùng cách patch entitlement, giả lease, mượn credential người khác hoặc đoán URL riêng tư để lấy phần bị khoá.

## 5. Hệ quả cho ToolFlow

- **Đường web của Flow và ChatGPT:** đã có config thật và bản đồ consumer đủ để thiết kế driver tập trung hai provider, không cần kéo Grok/Gemini/Muse/Motion vào.
- **Native API của Flow:** [chương 17](17-flow-native-public-frontend.md) đã xác định 24 RPC ID theo hành động và một phần field-number từ frontend Google công khai, không cần gói Tool trả phí cho việc đọc nguồn này.
- **Max Speed của Tool:** hợp đồng gọi Bridge đã biết ở [14](14-flow-bridge-protocol-contract.md), nhưng mã Bridge và private config thực tế vẫn chưa có. Native RPC của Google là bằng chứng độc lập, không phải xác nhận tương thích Bridge. Nested message, auth/captcha và response thật chưa được kiểm chứng; không biến schema một phần thành client đã chạy được.
- Không cần thương mại/licensing để viết driver riêng của mình; nhưng không thể kết luận driver đã dùng được chỉ từ việc đọc config. Cần test trên UI thật với tài khoản và số lượt generate được duyệt.

## 6. Nguồn và artefact

- [Receipt runtime](evidence/runtime-config-receipt.json): thời điểm, entitlement, grants liên quan và HTTP metadata.
- [Flow DOM](evidence/flow-dom-config.json), [Flow web config](evidence/flow-api-public-config.json).
- [ChatGPT DOM](evidence/chatgpt-dom-config.json), [ChatGPT private config](evidence/chatgpt-private-config.json).
- Source extension: `src/core/ProviderConfigManager.js`, `settings-page.js`, `src/core/BridgeClient.js`, `flow-v2-correlation-observer.js`.
- Website asset: `https://labs.tool.vn/build/assets/app-Df8g310R.js`; public admin-form placeholder ở offset ký tự khoảng 2.812.120 của bản tải trong lượt này. Asset hash thay đổi theo deploy; xem manifest bằng chứng để định danh bản cụ thể.

**Chưa kiểm:** code Bridge, wire payload Max Speed, selector trên trang Flow/ChatGPT thật và generation end-to-end. **Rủi ro:** config thay đổi theo server; khởi động extension có tự claim phiên/đồng bộ settings/ghi telemetry dù không generate.
