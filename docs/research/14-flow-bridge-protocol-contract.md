# 14. Flow Bridge protocol contract (phía ToolFlow) — Max Speed

Tài liệu này là **hợp đồng giao thức ToolFlow ⇄ ToolBridge** rút từ code ToolFlow 1.3.138 và dữ liệu runtime public (Free) do parent thu. Bổ sung cho `05-google-flow-api-v2-max-speed.md`. Dữ liệu máy đọc: `evidence/flow-bridge-contract.json`; kiểm chứng: `python3 evidence/verify-flow-bridge-contract.py` (kiểm sha256 file nguồn + mọi `file+symbol+offset+anchor`; kết quả lần chạy: 154 evidence, 0 lỗi, 0 tham chiếu thiếu).

**Quy ước nhãn**
- **actual** — giá trị/hành vi thấy trực tiếp trong code hoặc runtime public.
- **required-only** — client bắt buộc/kiểm tra, nhưng *giá trị thật không có* (config riêng tư).
- **unknown** — không quan sát được.
- Các khoá như `protocol.rpc.image_submit` là **tên khoá tượng trưng**. Chúng **không phải RPC ID** của Google; mọi giá trị đều `null / unknown_private_config`.

Không làm: network, auth, generate, install, đổi entitlement, commit. Offset = chỉ số ký tự 0-based trong file đã decode UTF-8 (file nguồn là một dòng minify).

---

## 1. Kết luận ngắn

| Hỏi | Trả lời | Nhãn |
|---|---|---|
| Bridge ID, kênh | `chrome.runtime.sendMessage("heieobedadlfdkppgagnhfakcdapbfka", {method, params}, cb)`; ID hard-code ở `BridgeClient` (`BC-id`) và `background.js` (`BG-id`) | actual |
| Đường `batchexecute` thật | `flow_v2_observer_transport.paths = ["/_/AiSandboxAngularFrontend/data/batchexecute"]` (public config, version 1) | actual |
| Host của đường đó | **Không** nằm trong config (chỉ path, bị validate theo regex path). Host là origin trang Flow | actual (thiếu host) |
| Danh tính media (UUID↔project↔ASB) | `native_project_media_identity` v1: rows ở `body[2]`, uuid `row[0]`, project `row[1]`, generation `row[2]`, details `row[5]` | actual |
| RPC ID thật (`protocol.rpc.*`) | Không có. `flowPrivateKeys=[]`, `entitled.flowApi=false` | unknown |
| `schema.wire`, `models`, `state_mapping`, `runtime`, `error_mapping` | Không có (chỉ có ràng buộc client — §5) | required-only |
| `bridge_download_url` | Không có; placeholder website 404; Web Store crx 404 | unknown |

Mâu thuẫn với bản trước: doc 05 §8 ghi `flow_v2_observer_transport`, `native_project_media_identity`, `flow_v2_web_correlation` là "không quan sát được/chưa có giá trị". Nay đã có giá trị thật từ public config (§4), nên các dòng đó **không còn unknown**. Cái vẫn unknown là nhóm **private** `flow_api_v2_*`.

---

## 2. Envelope và quy tắc chung (actual)

- Yêu cầu: `{method: string, params: object}`; phản hồi: object JSON `{ok:boolean, error?:string, …}`. Rỗng → `EMPTY_RESPONSE` (`BC-send`).
- `BridgeClient.request` (chỉ `flow_v2_*`) tự chèn:
  - `commandId = "v2-client-<Date.now()>-<Math.random().toString(36).slice(2)>"` (`BC-cmdid`)
  - `commandExpiresAt = Date.now() + timeoutMs` nếu timeout > 0 (`BC-expires`)
  - Lệnh phụ gọi `_sendRaw` (receipt, cancel) **không** có `commandId` mới; receipt dùng `targetCommandId`.
- Phân loại lỗi do client tổng hợp (`BC-uncertain`, `BC-undelivered`, `BC-runtime-err`):
  - `BRIDGE_NOT_INSTALLED` (lastError “receiving end does not exist / could not establish connection”): lệnh ghi → `pre_dispatch`, `dispatchStarted:false` (chắc chắn chưa gửi).
  - `BRIDGE_CHANNEL_CLOSED`, `BRIDGE_REQUEST_TIMEOUT`, `EMPTY_RESPONSE`: lệnh ghi → `stage:"ambiguous"`, `dispatchStarted:true`, `ambiguous:true`. `poll/resolve` → `accepted_poll`.
  - `ABORTED`: gửi `flow_v2_cancel_command`, trả ngay `noRetry/noReplay/cancelled`.
- 8 lệnh ghi: `upload_ref, upload_video, submit_image, submit_image_batch, submit_video, submit_video_edit, upscale_image, upscale_video`.

### 2.1 Timeout (`BC-timeout`, `BC-timeout-phases`)
`cfg = runtime.request_timeout_ms` hợp lệ khi nguyên 1000–120000, sai → 10000; `mutation = runtime.mutation_timeout_ms ?? cfg` (cùng khoảng).

| Lệnh | Timeout |
|---|---|
| `ping`, `get_status`, `set_flow_api_maintenance` | 5000 |
| `refresh_token` / `flow_validate_session`, `open_flow_login*` | 20000 / 60000 |
| `flow_v2_health` | `poll_interval_ms+5000` nếu 250–60000, sai → 10000 |
| `flow_v2_reconnect` | `session_refresh_timeout_ms+10000` nếu 3000–60000, sai → 10000 |
| `poll_operations`, `resolve_media` | `cfg+20000` |
| submit/upload/upscale_image (3 pha) | `cfg*3+30000+max(0,mutation-cfg)` |
| `upscale_video`, `submit_video` có `refMediaIds` (4 pha) | `cfg*4+30000+max(0,mutation-cfg)` |
| `get_*_receipt` | `min(cfg+5000, 30000)` tính, nhưng gọi `_sendRaw` với timeout cố định 10000 |

---

## 3. Params gửi Bridge theo từng method (actual)

Bộ cấu hình chung (ký hiệu **CFG**): `protocol, models, schema, stateMapping(=config.state_mapping), runtime, protocolRevision (=Number(protocol.schema_version)), protocolFingerprint (=FNV-1a của protocol,models,schema,state_mapping,runtime)` + tuỳ chọn `flowTabId` (nguyên ≥0, từ `item.flowApiTabId`).

| Method | Params (ngoài `commandId/commandExpiresAt`) | Phản hồi ToolFlow đọc | Evidence |
|---|---|---|---|
| `ping` | `{}` | `ok, version, capabilities[], flowV2MaxReferences, native` | `BC-ping` |
| `get_status` | `{}` | `tokenReady, tokenAgeMs, flowTabOpen, tokenBootstrapActive, version` | `BC-status` |
| `set_flow_api_maintenance` | `{enabled}` | `ok` | `BC-maint` |
| `flow_clear_cookies_reload` | `{tabId, projectId, userInitiated:true}` | `ok, cacheCleared===true, reloaded===true` | `BC-cookies` |
| `flow_v2_health` | CFG + `surface, mediaType, projectId|null, flowTabId?` | `ok, ready, session, projectId, flowTabId, error, diagnostic{sessionProof∈{page_session_missing,same_domain_header_missing}, wizPresent, atPresent, buildPresent, fSidPresent, nativeRequestObserved, sameDomainHeaderObserved}, grpcCode, grpcReason, providerErrorCodes` | `V2-health`, `V2-health-resp`, `V2-health-diag` |
| `flow_v2_reconnect` | `projectId, userInitiated, flowTabId?, recoveryAuthorized, forcePageReload, preservePage, recoveryReason, allowFocus(=userInitiated)` + CFG | `ready, flowTabId, recoveryStarted, pagePreserved, reloadIssued` | `SC-reconnect` |
| `flow_v2_cancel_command` | `{commandId, commandExpiresAt}` | không đọc | `BC-cancel` |
| `flow_v2_upload_ref` / `_upload_video` | `projectId, base64, fileName, mimeType, protocol, models, schema, stateMapping, runtime, protocolRevision, protocolFingerprint` | `ok, stage("receipt"), mediaId(UUID|AB-…), error(/^[A-Z][A-Z0-9_]{1,100}$/ hoặc project_mismatch), ambiguous, dispatchStarted` | `V2-upload`, `V2-upload-resp` |
| `flow_v2_submit_image` (`_image_batch` nếu cap + quantity>1) / `_submit_video` (`_video_edit` nếu có video ref) | `generationTransport, protocol, schema, models, runtime, stateMapping, protocolRevision, protocolFingerprint, flowTabId?, input{itemId, attemptId, projectId, prompt, model, ratio, duration, resolution, isFrames, quantity, refMediaIds[], refVideoMediaIds[]}` | `ok, outputs[{operationId, mediaId?, state, url?}], projectId, stage, ambiguous, error, providerErrorCodes, grpcCode, grpcReason, diagnostic` | `V2-submit`, `V2-submit-input`, `V2-submit-validate` |
| `flow_v2_poll_operations` | CFG + `operationIds[], acceptedOperationIds[](=operationIds), projectId|null, flowTabId?` | `ok, outputs[{operationId, state, rawState, unknownState, mediaId, url, durableUrl, model, error, grpcCode, grpcReason, providerErrorCodes, failureDetail, compact, generationId, projectId}]` | `V2-poll`, `CP-poll` |
| `flow_v2_resolve_media` | CFG + `mediaId, projectId, mediaType, operationId?, resolvePurpose?("download"), flowTabId?` | `ok, output{mediaId, projectId, url, posterUrl, durableUrl}, decoderRevision, diagnostic.lineageCheck, downloadRuntime{…}` | `V2-resolve-uuid`, `V2-resolve-out`, `BC-trace` |
| `flow_v2_upscale_image` | CFG + `mediaId, projectId, operationId, resolution("2k"|"4k")` | **không đọc chi tiết**, trả nguyên (unknown) | `V2-upscale-img` |
| `flow_v2_upscale_video` | `protocol, models, schema, stateMapping, runtime, projectId, protocolRevision, protocolFingerprint, mediaId, resolution` | `ok, mediaId (^UUID_upsampled$), stage, ambiguous, dispatchStarted, providerErrorCodes, grpcCode, grpcReason`; rồi poll `operationIds=[UUID_upsampled]` + resolve | `V2-upscale-vid`, `V2-upscale-regex` |
| `flow_v2_get_upload_receipt` | `projectId, targetCommandId, runtime, commandExpiresAt(+30000)` | `ok, stage==="receipt", mediaId`; chờ khi `UPLOAD_RECEIPT_PENDING`/lỗi kênh | `BC-upload-receipt` |
| `flow_v2_get_generation_receipt` | `projectId, targetCommandId, flowTabId, runtime, commandExpiresAt(+30000)` | `ok, stage==="receipt", outputs.length>0`; chờ khi `GENERATION_RECEIPT_PENDING`/lỗi kênh | `BC-gen-receipt` |

Ghi chú xác thực đầu ra (actual, `V2-submit-validate`): số `outputs` phải bằng số mong đợi (`quantity` nếu batch native, ngược lại 1); `operationId` là UUID, không trùng giữa các lệnh; `mediaId` nếu có phải UUID. Resolve: `output.mediaId`/`projectId` phải đúng request, nếu không `V2_RESOLVE_IDENTITY_MISMATCH` (`V2-resolve-out`).

Receipt khôi phục: tối đa 4 lần, cách 500 ms, **chỉ khi `result.ambiguous===true`**; upscale **không có** receipt.

---

## 4. Dữ liệu runtime public (Free) — transport & media identity thật

Nguồn: `evidence/flow-api-public-config.json` (sha256 trong JSON), thu bởi parent qua `Runtime.evaluate` trên `ProviderConfigManager` sau khi mở sidebar nguyên bản, Free, không vá entitlement, không generate. Task này **không** thu lại.

### 4.1 Đường batchexecute
`flow_v2_observer_transport = {version:1, paths:["/_/AiSandboxAngularFrontend/data/batchexecute"]}`.
- Observer (`flow-v2-correlation-observer.js`) chỉ chấp nhận ≤8 path, mỗi path ≤256 ký tự, khớp `^/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+$`, không chứa segment `u/<n>` (`OBS-transport`, `OBS-path-re`).
- **Config chỉ có path, không có host.** Host đúng của request là origin của trang Flow đang mở; chưa có bằng chứng nào trong dữ liệu này để ghi host đầy đủ ngoài việc đây là request cùng origin của trang.
- Request: `f.req` (FormData / URLSearchParams / bytes / string) là JSON; `envelope[0]` là mảng hàng, `row[0]`=rpcId, `row[1]`=payload (chuỗi JSON) (`OBS-freq`).
- Response: frame `["wrb.fr", rpcId, "<payload JSON>", …]`; `frame[1]` khớp `^[A-Za-z0-9_-]{1,64}$`; payload ở `[2]`, lỗi cũng đọc `[5]` (`OBS-wrb`, `OBS-match-resp`).
- ⚠ Observer **đọc** rpcId từ traffic thật nhưng **không** có danh sách rpcId trong config. Vì vậy `protocol.rpc.*` vẫn unknown.
- Quan hệ với Bridge: *suy luận* — path này là đường mà trang Flow tự dùng; không có bằng chứng Bridge gọi cùng path. Không dùng để suy ra `protocol.rpc.*`.

### 4.2 `native_project_media_identity` (v1, enabled)
Cách áp dụng (`OBS-rows`, `OBS-row-check`): với mỗi frame `wrb.fr`, `body=JSON.parse(frame[2])`; `rows = body[2]`. Một row hợp lệ khi:
- `row[0]` là UUID (media), `row[1]` (hạ chữ thường) = project id của URL trang, `row[2]` là UUID (generation), `row[5]` là mảng (details).

Phân loại loại media (`media_types`, đúng 2 loại):
- **video** nếu `row[7][1][0]` và `row[7][1][1]` đều số nguyên dương, **hoặc** `row[5][6][1][0][0]` là string và `row[5][8][0]` là số nguyên.
- **image** nếu `row[6][2]` là cặp số nguyên dương (`positive_integer_pair`).
- URL ASB (`AB-…`) lấy từ: video `row[5][5]`, `row[5][10]`, `row[7][4][2]`; image `row[5][5]`, `row[5][10]`, `row[6][0][13]`, `row[6][1][3]`.

Kết quả: bảng alias UUID ↔ ASB ↔ project (cap 4096), dùng bởi `FlowUuidGateway` nhánh web. Schema bị validate chặt (`OBS-schema-valid`): đúng 8 khoá, path ≤8 phần tử mỗi phần 0–128, rules ≤8.

Giới hạn: đây là hình dạng **response native của trang**. Đầu ra `flow_v2_*` của Bridge là `operationId/mediaId` UUID đã chuẩn hoá, không theo các path này.

### 4.3 Khác (public, actual)
- `image_url_pattern.known_routes = ["/fx/api/trpc/media.getMediaUrlRedirect"]` — tRPC phát media theo UUID (`name=UUID`). Khác với batchexecute.
- `flow_v2_web_correlation`: `schema_version 1, observation_only:false`, surfaces/media gen,task,workflow / image,video, `parallel_max_quantity {image:16, video:16}`, `max_active_operations 16`, `observer_ack_timeout_ms 10000`, `receipt_timeout_ms 90000`, `attempt_ttl_ms 900000`, `request_bind_timeout_ms 300000`. Phục vụ chế độ **web DOM song song**, không phải đường Bridge.
- `flow_v2_driver {enabled:true, messages{vi,en,ja,th}}` — công tắc tạm dừng driver DOM `flow_v2` (không phải driver API v2).
- `api_runtime_limits` public: `request_timeout_ms 30000, operation_deadline_ms 900000, poll_interval_ms 5000, pacing_ms 350, retry_max_attempts 3, retry_base_delay_ms 1000, retry_max_delay_ms 10000, upload_concurrency 1–3`. **Không được coi là** `flow_api_v2_runtime` riêng tư; chưa tìm consumer của khối này trong lượt này.
- `ratios` public (image 16:9,4:3,1:1,3:4,9:16; video 16:9,9:16), `download_resolutions`, `max_ref_images {image:10, video_ingredients:5}`, `execution_policy`, `chain_config`, `error_patterns` ... đều là public; **không** phải `schema.aspect_ratios` riêng tư.
- DOM config: `config_version 273`, 64 selector top-level; profile `legacy` có 64 selector và profile `v2` có 82 selector. Số đếm đã được phiên nghiên cứu chính kiểm lại trực tiếp trên artifact runtime.

Receipt runtime: `plan:"free"`, `entitled{chatgpt:true, flowApi:false}`, `privateLoaded:true`, `flowPrivateKeys:[]`. `flowPrivateKeys` trong probe chỉ là **các key Flow được chọn lọc** (`flow_api_v2_*` và `bridge_download_url`), không phải toàn bộ `privateConfigs.flow`. Endpoint private-configs trả 200 nhưng không cấp các key Max Speed/link Bridge đó.

---

## 5. Config riêng tư `flow_api_v2_*`: schema và khoá bắt buộc (required-only; **mọi giá trị unknown**)

Lắp ráp (`PCM-v2cfg`, `PCM-v2key`): `getFlowApiV2ConfigSync` ghép 6 khoá `flow_api_v2_{protocol,models,schema,state_mapping,runtime,error_mapping}`; thiếu một khoá → `null` → `V2_PRIVATE_CONFIG_MISSING`. Khoá `flow_api_v2_*` chỉ đọc được khi cấu hình private còn mới (TTL 1 giờ), token khớp và khoá nằm trong `meta.granted`.

### 5.1 `protocol.rpc` (khoá tượng trưng)
| Khoá | Dùng khi | Giá trị |
|---|---|---|
| `image_submit`, `media_resolve` | health ảnh (bắt buộc kiểu string) | unknown |
| `video_submit`, `video_text_submit`, `video_first_frame_submit`, `video_first_last_submit`, `video_poll`, `media_resolve` | health video | unknown |
| `upload_ref` | upload ảnh API | unknown |
| `video_edit_submit` | video có video-ref | unknown |
| `image_upscale` (+ `schema.wire.image_upscale_level_2k/4k` nguyên) | upscale ảnh | unknown |
| `video_upscale` + `catalog_get` | upscale video | unknown |
Khác: `protocol.schema_version` phải `=== 1` (cũng bằng `flow_api_v2_config_revision`); `protocol.transport.video_upload` (string) cho upload video.

### 5.2 `schema.wire`
Client chỉ đọc **2 khoá**: `image_upscale_level_2k`, `image_upscale_level_4k` (số nguyên). Mọi trường wire khác (vị trí prompt, enum ratio, model key…) nằm trong object opaque chuyển cho Bridge — **ToolFlow không đọc**, nên không suy ra được. `schema.aspect_ratios.{image,video}`: object khoá theo ratio.

### 5.3 `models`
Khoá theo model value hoặc entry có `ui_values[]` chứa tên. Các trường client dùng: `default`, `ui_values`, `max_prompt_chars` (nguyên dương), `ingredients_layout`/`first_frame_layout` (null hoặc `"canonical_v1"`), `by_ratio.<ratio>`, `generation_resolutions[]`, `text_2_video`/`frame_2_video`/`start_end_frame_2_video`/`reference_frame_2_video` (string hoặc map theo duration→resolution), `video_edit_video`, `video_edit_variants.{resolution|default}{max_ref_images 0–6, image_refs_idx 8, row_length 9|13}`, `video_edit_resolutions[]`, `video_edit_frames{start≥0,end>start,end≤100000}`.

### 5.4 `state_mapping`
Client chỉ kiểm `verified === true`. Phần còn lại opaque (cùng vào fingerprint). Bridge gắn `rawState/unknownState`. Từ vựng trạng thái client hiểu ở đầu ra poll: hoàn tất `completed|complete|done|succeeded|success|resolved`; thất bại `failed|error|cancelled|canceled|rejected`; khác = đang chạy (`CP-terminal`).

### 5.5 `runtime`
Thiếu/không hợp lệ → `V2_RUNTIME_CONFIG_INVALID:<key>`. Bắt buộc: `max_concurrent≥1`, `submit_pacing_ms≥50`, `request_timeout_ms≥1000` (Bridge: 1000–120000), `poll_interval_ms≥1`, `image_timeout_ms≥1`, `video_timeout_ms≥1`, `max_retry_attempts≥0`, `base_backoff_ms≥0`, `max_backoff_ms≥0`, `session_refresh_max_attempts≥0`. Tuỳ chọn: `mutation_timeout_ms`, `session_refresh_timeout_ms` (3000–60000), `schema_drift_threshold/min_samples/window_ms`. Giá trị: unknown.

### 5.6 `error_mapping`
Object `{tiền tố mã lỗi: errorType}`; khớp không phân biệt hoa thường theo tiền tố, khoá dài nhất thắng, ứng viên: `providerErrorCodes[]`, `error.code`, `grpcReason` (`V2-errmap`). Giá trị: unknown. Mã client tự nhận diện: `PUBLIC_ERROR_*`, `grpcReason /^[A-Z][A-Z0-9_]{2,119}$/`.

JSON Schema dạng required-only nằm ở `flow_config_schema_required_only` trong evidence (tất cả `x-value: unknown_private_config`).

---

## 6. Yêu cầu sức khoẻ (health) — thứ tự và capability (actual)

1. entitlement `flow_api_enabled` (featureGate) — Free: `V2_ENTITLEMENT_MISSING`
2. 8 khoá `flow_api_*` của SystemConfig (xem JSON `system_settings`): `driver, v2_enabled, v2_canary_percent, v2_surfaces, v2_media_types, auto_primary, auto_fallback, v2_config_revision` (≤1)
3. `fetchFlowApiV2Configs()` đủ 6 phần → `V2_PRIVATE_CONFIG_MISSING`
4. `schema_version===revision===1` → `V2_PROTOCOL_REVISION_MISMATCH`
5. `state_mapping.verified===true` → `V2_STATE_MAPPING_UNVERIFIED`
6. `protocol.rpc` các khoá bắt buộc là string → `V2_RPC_CONFIG_INVALID`
7. `flow_api_v2_generation_transport ∈ {xhr, fetch_request}`
8. `ping` installed + đủ capability; thiếu → ping lại một lần → `V2_BRIDGE_VERSION_UNSUPPORTED`
9. `flow_v2_health` trả `ok && ready`

Capability bắt buộc: `flow_v2_health`, `flow_v2_submit_image|video`, `flow_v2_poll_operations`, `flow_v2_resolve_media`, `flow_v2_cancel_command`, + `flow_v2_fetch_request_generation` nếu transport `fetch_request`. Có điều kiện: `submit_image_batch, submit_video_edit, video_edit_mixed_refs, first_frame_canonical, ingredients_canonical, upload_ref, upload_video, upscale_image, upscale_video, reconnect, preserve_page_reconnect, unusual_reload, flow_clear_cookies_reload, flow_clear_cache_reload` (+ bridge ≥1.3.33 cho cookie recovery).

---

## 7. Receipt & chống gửi trùng (actual)

- Khoá idempotency phía client: `commandId`. Receipt Bridge truy theo `targetCommandId` (§3). Thời hạn lưu receipt ở Bridge: unknown.
- Giai đoạn (`stage`): `pre_dispatch`, `preflight`, `receipt`, `ambiguous`, `accepted_poll`, `terminal` (`ERR-normalize`).
- Checkpoint bền: `chrome.storage.local["tool_flow_api_checkpoints_v2_schema1"]` với `{driver, protocolRevision, protocolFingerprint, itemId, jobId, projectId, flowTabId?, attemptId, operationId, mediaId, mediaType, surface, state, submittedAt, dispatchedAt, operationDeadlineAt, lastPolledAt}` (`CP-key`, `CP-save`).
- Mơ hồ không bao giờ submit lại; upscale mơ hồ không có receipt.

---

## 8. `FlowUuidGateway` — nhánh đã đọc để lấp khoảng trống

| Nhánh | Hành vi | Bridge? |
|---|---|---|
| `_traceOperation` | bọc chẩn đoán (id, đếm, `start/finish/error`), không wire | không |
| `_target` | so tab/project/origin/driverKey/routePrefix với `expectedFlowTarget`; sai → `FLOW_EXECUTION_TARGET_CHANGED` / `PROJECT_MISMATCH` | không |
| `_apiStatus` | chỉ khi mode api/auto + `apiModeEnabled`; gọi `SessionCoordinator.check`; trả `{...health, maxConcurrent=runtime.max_concurrent, readContext{protocolRevision, protocolFingerprint}}` khi driver v2 | gián tiếp |
| `_resolve` nhánh API | song song `min(4,max_concurrent)`, lô 256; gọi `_resolveMediaPrimitive` với `{media_uuid, mediaId, projectId, mediaType, apiDriver, uuidLookup:true, identityOnly:true, flowTabId, …readContext}`; yêu cầu `value.projectId` = project, nếu không rơi sang web | `flow_v2_resolve_media` |
| `_webPrimitive` | `sendToContentScript("flowUuidGatewayRead", {identities, ownerRecords, expectedFlowTarget, operationId, mediaType})` | không |
| `listMedia` | `sendToContentScript("scanFlowImages", {deep:false, expectedFlowTarget})`, `complete:false` luôn | không |
| `lookupCatalog` | bọc `resolve(mode:"web")` → `{supported: driverKey==="flow_v2", known, unknown, complete:false, aliases, revision, snapshotSource}` | không |
| `checkReferenceProject` | chỉ API; `valid` / `other_project` (khi `error==="LINEAGE_MISMATCH"` và `diagnostic.lineageCheck==="resolved projectId"`) / `unresolved` | `flow_v2_resolve_media` |
| `resolveMedia` | pin v1 → đọc v1; còn lại `resolve([mediaId])` → `{url, posterUrl, mediaId, projectId, revoke:false, metadata, effectiveMode}` | gián tiếp |
| `_controlledRefresh` | cặp `flowUuidControlledBegin/Finish` qua SW trước khi reload tab | không |

---

## 9. Bridge distribution leads

**Đã chứng minh trong code**
- Giá trị lấy từ private config slug `flow`, khoá `bridge_download_url`, nằm trong `_GATED_API_CONFIG_KEYS` và phải có trong `meta.granted`; chỉ trả khi token khớp và còn TTL 1 giờ (`PCM-bdu`, `PCM-gated`, `PCM-granted`).
- Nguồn tải: `GET extension-config/providers/private-configs` có chữ ký (đường dẫn thấy ở `PCC-paths`, `PCC-fetch`; runtime receipt ghi các request này trả 200 trên Free nhưng `flowPrivateKeys=[]`).
- UI: `settings-page.js` → `_safeExternalHttpUrl` (chỉ http/https), hiển thị nút “Download ToolBridge”; trống → “Admin has not configured ToolBridge — contact support” (`SET-url`, `SET-safe`, `SET-install`, `SET-nourl`). Hướng dẫn: unzip → `chrome://extensions` → Developer mode → Load unpacked → Reconnect.
- `SystemConfig._publicSettings` xoá `bridge_download_url` khỏi settings công khai (`SYS-strip`).
- `externally_connectable` của ToolFlow chỉ `*://labs.tool.vn/*` (ai được nhắn ToolFlow, không phải Bridge).

**Từ parent (không tái kiểm trong task này)**
- Website public có chuỗi placeholder `https://labs.tool.vn/downloads/toolbridge-latest.zip`; parent GET → **404**.
- crx update Web Store của Bridge ID → **404**.
- ⇒ Placeholder **không** được khẳng định là URL thật; Bridge không có trên Web Store (xác nhận bằng 404, không bằng bất kỳ thông tin nào khác).

**Loại trừ**
- `video_flow_bridge` là chính sách byte của Muse, không phải gói Bridge.
- Nhãn i18n `autoCapcut.downloadBridge` chỉ có ở i18n từ server, không thấy code tham chiếu.

**Bước hợp pháp tiếp theo**: tài khoản đủ entitlement tự đọc `isPrivateConfigGranted("bridge_download_url")` qua log chẩn đoán của settings; hoặc xin hỗ trợ Tool. Không vượt giấy phép, không đoán path.

---

## 10. Còn unknown (không fabricate)

1. Giá trị `protocol.rpc.*`, `protocol.transport.video_upload` (RPC ID thật).
2. Nội dung `models`, `schema` (ngoài 2 số upscale), `state_mapping`, `runtime`, `error_mapping`.
3. Nội bộ Bridge: dựng request, thời hạn/độ bền receipt, dedupe theo `commandId`.
4. Dạng phản hồi `flow_v2_upscale_image`; các trường ngoài `ok/stage/mediaId` của upload.
5. `bridge_download_url` và host gói Bridge.
6. Việc `video_timeout_ms ≤ 7200000` có bị client ép hay không (doc 05 nói có; lượt này không định vị được).
7. `BridgeClient.stream()` (không có caller).
8. Host đầy đủ của batchexecute (config chỉ có path).

---

## 11. Evidence index (rút gọn; đầy đủ trong JSON)

Mỗi mục: `id | file | symbol | offset`. Kiểm bằng `verify-flow-bridge-contract.py`.

| id | file | symbol | offset |
|---|---|---|---|
| `BC-id` | `src/core/BridgeClient.js` | BRIDGE_ID const | 294 |
| `BC-send` | `src/core/BridgeClient.js` | BridgeClient._sendRaw | 6183 |
| `BC-timeout` | `src/core/BridgeClient.js` | BridgeClient._requestTimeout | 2042 |
| `BC-timeout-phases` | `src/core/BridgeClient.js` | BridgeClient._requestTimeout phases | 3661 |
| `BC-request` | `src/core/BridgeClient.js` | BridgeClient.request | 6754 |
| `BC-cmdid` | `src/core/BridgeClient.js` | BridgeClient.request commandId | 7025 |
| `BC-expires` | `src/core/BridgeClient.js` | BridgeClient.request commandExpiresAt | 7261 |
| `BC-cancel` | `src/core/BridgeClient.js` | BridgeClient.request cancel | 7939 |
| `BC-upload-receipt` | `src/core/BridgeClient.js` | BridgeClient.request upload receipt | 8599 |
| `BC-gen-receipt` | `src/core/BridgeClient.js` | BridgeClient.request generation receipt | 9368 |
| `BC-uncertain` | `src/core/BridgeClient.js` | BridgeClient._uncertainResult | 863 |
| `BC-undelivered` | `src/core/BridgeClient.js` | BridgeClient._undeliveredResult | 1449 |
| `BC-runtime-err` | `src/core/BridgeClient.js` | BridgeClient._runtimeErrorCode | 516 |
| `BC-ping` | `src/core/BridgeClient.js` | BridgeClient.ping | 11885 |
| `BC-status` | `src/core/BridgeClient.js` | BridgeClient.getStatus | 13648 |
| `BC-maint` | `src/core/BridgeClient.js` | BridgeClient.setFlowApiMaintenance | 11457 |
| `BC-cookies` | `src/core/BridgeClient.js` | BridgeClient.clearFlowCookiesAndReload | 11161 |
| `BC-cookie-cap` | `src/core/BridgeClient.js` | BridgeClient.supportsFlowCookieRecovery | 10445 |
| `BC-trace` | `src/core/BridgeClient.js` | BridgeClient._sendRaw trace fields | 4479 |
| `BC-stream` | `src/core/BridgeClient.js` | BridgeClient.stream (no caller) | 14558 |
| `BC-auth` | `src/core/BridgeClient.js` | BridgeClient.request auth errors | 10050 |
| `V2-upload` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.uploadReference | 4234 |
| `V2-upload-resp` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.uploadReference response | 4937 |
| `V2-submit` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._submitInSlot submit | 49829 |
| `V2-submit-input` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._submitInSlot input tail | 50540 |
| `V2-submit-validate` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._submitInSlot output validation | 51622 |
| `V2-poll` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._drainAccepted | 74298 |
| `V2-resolve-uuid` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.resolveMedia uuidLookup | 64444 |
| `V2-resolve-out` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.resolveMedia identity check | 65434 |
| `V2-resolve-out2` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._resolveOutput | 84277 |
| `V2-resolve-ref` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._readReferenceProjectPrimitive | 13140 |
| `V2-upscale-img` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.upscaleImage | 68277 |
| `V2-upscale-vid` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.upscaleVideo | 69423 |
| `V2-upscale-vid-poll` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.upscaleVideo poll | 70608 |
| `V2-upscale-regex` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.upscaleVideo receipt regex | 69715 |
| `V2-health` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._checkReadyUnshared health | 30632 |
| `V2-health-resp` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver health response | 31947 |
| `V2-health-diag` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver health diagnostic | 31326 |
| `V2-ready-order` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._checkReadyUnshared start | 27705 |
| `V2-ready-rev` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver revision check | 27840 |
| `V2-ready-sm` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver state_mapping.verified | 27978 |
| `V2-ready-rpc` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver required rpc keys | 28091 |
| `V2-ready-transport` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver transport | 28448 |
| `V2-ready-caps` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver required caps | 28724 |
| `V2-required-caps` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.requiredCapabilities | 11016 |
| `V2-ping-uncertain` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver ping force | 29692 |
| `V2-bridge-unsupported` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver bridge capability gate | 30199 |
| `V2-input` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.checkInputSupported | 19652 |
| `V2-runtimeInteger` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._runtimeInteger | 10545 |
| `V2-opdeadline` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._operationDeadline | 35793 |
| `V2-pace` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver submit pacing | 39539 |
| `V2-maxconc` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver ref validation concurrency | 14711 |
| `V2-retry-keys` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver retry keys | 73020 |
| `V2-session-refresh` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver session_refresh_max_attempts | 73234 |
| `V2-downloadready` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver.checkDownloadReady | 63005 |
| `V2-upscale-img-cfg` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver upscale wire | 63393 |
| `V2-upscale-vid-cfg` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver video upscale rpc | 63162 |
| `V2-videoedit` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver video edit gate | 22793 |
| `V2-videoedit-variant` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver video_edit_variants | 23245 |
| `V2-videoedit-frames` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver video_edit_frames | 24160 |
| `V2-layout` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver ingredients_layout | 20907 |
| `V2-layout2` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver first_frame_layout | 21080 |
| `V2-modelcfg` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._modelConfig | 11241 |
| `V2-capmodel` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._capabilityModel | 11843 |
| `V2-bytratio` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver by_ratio | 25874 |
| `V2-t2v` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver text_2_video | 26248 |
| `V2-ratio-img` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver aspect_ratios.image | 24808 |
| `V2-ratio-vid` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver aspect_ratios.video | 23839 |
| `V2-promptmax` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver max_prompt_chars | 20640 |
| `V2-genres` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver generation_resolutions | 26044 |
| `V2-errmap` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._classifyProviderError | 82496 |
| `V2-resperr` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._responseError | 83049 |
| `V2-fp-use` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver fingerprint use | 4553 |
| `V2-pinned-mismatch` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver pinned config check | 62963 |
| `V2-tabpin` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._flowTabPin | 608 |
| `V2-uuid` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._uuid | 10733 |
| `V2-refid` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver._referenceId | 10874 |
| `V2-poll-resp` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver poll error path | 74811 |
| `V2-poll-out-fields` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver durableUrl consumer | 60401 |
| `V2-failed-out` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver failureDetails consumer | 61686 |
| `V2-chkgate` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver entitlement gate | 19737 |
| `V2-max-refs` | `src/core/flow-api/FlowApiV2Driver.js` | FlowApiV2Driver ping.flowV2MaxReferences | 18228 |
| `SC-reconnect` | `src/core/flow-api/FlowApiSessionCoordinator.js` | FlowApiSessionCoordinator.reconnect | 29111 |
| `SC-normalized` | `src/core/flow-api/FlowApiSessionCoordinator.js` | FlowApiSessionCoordinator._normalized | 1732 |
| `SC-actions` | `src/core/flow-api/FlowApiSessionCoordinator.js` | FlowApiSessionCoordinator action map | 13972 |
| `SC-preserve` | `src/core/flow-api/FlowApiSessionCoordinator.js` | FlowApiSessionCoordinator preserve capability | 27709 |
| `SC-unusual` | `src/core/flow-api/FlowApiSessionCoordinator.js` | FlowApiSessionCoordinator unusual capability | 27774 |
| `CP-poll` | `src/core/flow-api/FlowApiV2CheckpointStore.js` | FlowApiV2CheckpointStore.recoverCheckpoints | 15595 |
| `CP-resolve` | `src/core/flow-api/FlowApiV2CheckpointStore.js` | FlowApiV2CheckpointStore._resolve | 20373 |
| `CP-terminal` | `src/core/flow-api/FlowApiV2CheckpointStore.js` | FlowApiV2CheckpointStore._terminalKind | 21079 |
| `CP-fp` | `src/core/flow-api/FlowApiV2CheckpointStore.js` | FlowApiV2CheckpointStore.fingerprint | 1660 |
| `CP-key` | `src/core/flow-api/FlowApiV2CheckpointStore.js` | FlowApiV2CheckpointStore storage key | 21540 |
| `CP-save` | `src/core/flow-api/FlowApiV2CheckpointStore.js` | FlowApiV2CheckpointStore.save | 3872 |
| `FAC-prepare` | `src/core/flow-api/FlowApiFacade.js` | FlowApiFacade.prepare | 803 |
| `FAC-gate` | `src/core/flow-api/FlowApiFacade.js` | FlowApiFacade._runtimeGate | 181 |
| `RES-circuit` | `src/core/flow-api/FlowApiDriverResolver.js` | FlowApiDriverResolver.tripV2 | 1122 |
| `RES-snapshot` | `src/core/flow-api/FlowApiDriverResolver.js` | FlowApiDriverResolver._systemSnapshot | 3651 |
| `ERR-normalize` | `src/core/flow-api/FlowApiDriverError.js` | FlowApiDriverError.normalize | 1807 |
| `ERR-failed` | `src/core/flow-api/FlowApiDriverError.js` | FlowApiDriverError.fromFailedOutputs | 9478 |
| `PCM-v2cfg` | `src/core/ProviderConfigManager.js` | ProviderConfigManager.getFlowApiV2ConfigSync | 20648 |
| `PCM-fetchv2` | `src/core/ProviderConfigManager.js` | ProviderConfigManager.fetchFlowApiV2Configs | 20939 |
| `PCM-getval` | `src/core/ProviderConfigManager.js` | ProviderConfigManager.getApiConfigValueSync | 15906 |
| `PCM-v2key` | `src/core/ProviderConfigManager.js` | ProviderConfigManager._isFlowApiV2Key | 17629 |
| `PCM-gated` | `src/core/ProviderConfigManager.js` | ProviderConfigManager._GATED_API_CONFIG_KEYS | 29542 |
| `PCM-fetchpriv` | `src/core/ProviderConfigManager.js` | ProviderConfigManager.fetchPrivateConfigs | 17829 |
| `PCM-store` | `src/core/ProviderConfigManager.js` | ProviderConfigManager private store shape | 18354 |
| `PCM-granted` | `src/core/ProviderConfigManager.js` | ProviderConfigManager granted | 18488 |
| `PCM-bdu` | `src/core/ProviderConfigManager.js` | ProviderConfigManager bridge_download_url branch | 16192 |
| `PCM-ttl` | `src/core/ProviderConfigManager.js` | ProviderConfigManager TTL | 30342 |
| `PCC-paths` | `src/core/ProtectedConfigClient.js` | ProtectedConfigClient.paths | 104 |
| `PCC-fetch` | `src/core/ProtectedConfigClient.js` | ProtectedConfigClient.fetchConfig URL template | 21822 |
| `SYS-strip` | `src/core/SystemConfig.js` | SystemConfig._publicSettings | 7990 |
| `SYS-restore` | `src/core/SystemConfig.js` | SystemConfig.restoreFromStorage | 7713 |
| `SET-url` | `settings-page.js` | settings-page bridge card url | 78258 |
| `SET-safe` | `settings-page.js` | settings-page._safeExternalHttpUrl | 1947 |
| `SET-install` | `settings-page.js` | settings-page install card | 93938 |
| `SET-steps` | `settings-page.js` | settings-page install steps | 94551 |
| `SET-nourl` | `settings-page.js` | settings-page no-url note | 86219 |
| `SET-diag` | `settings-page.js` | settings-page download diagnostic | 90852 |
| `BG-id` | `background.js` | background _FLOW_BRIDGE_ID | 442794 |
| `BG-keys` | `background.js` | background _FLOW_DOWNLOAD_PRIVATE_KEYS | 442851 |
| `BG-once` | `background.js` | background._flowDownloadBridgeRequestOnce | 445358 |
| `BG-req` | `background.js` | background._flowDownloadBridgeRequest | 444532 |
| `BG-maint` | `background.js` | background._syncFlowApiMaintenanceSetting | 443422 |
| `BG-preflight` | `background.js` | background._flowApiDownloadPreflight | 445769 |
| `MAN-ext` | `manifest.json` | manifest externally_connectable | 3937 |
| `MAN-update` | `manifest.json` | manifest update_url | 5575 |
| `GW-resolve-api` | `src/core/FlowUuidGateway.js` | FlowUuidGateway._resolve api branch | 67437 |
| `GW-apiread-args` | `src/core/FlowUuidGateway.js` | FlowUuidGateway._resolve apiRead args | 69062 |
| `GW-apistatus` | `src/core/FlowUuidGateway.js` | FlowUuidGateway._apiStatus | 59642 |
| `GW-apistatus-ret` | `src/core/FlowUuidGateway.js` | FlowUuidGateway._apiStatus return | 61211 |
| `GW-target` | `src/core/FlowUuidGateway.js` | FlowUuidGateway._target | 58615 |
| `GW-web` | `src/core/FlowUuidGateway.js` | FlowUuidGateway._webPrimitive | 61743 |
| `GW-list` | `src/core/FlowUuidGateway.js` | FlowUuidGateway.listMedia | 64102 |
| `GW-lookup` | `src/core/FlowUuidGateway.js` | FlowUuidGateway.lookupCatalog | 65240 |
| `GW-lookup-ret` | `src/core/FlowUuidGateway.js` | FlowUuidGateway.lookupCatalog return | 65575 |
| `GW-trace` | `src/core/FlowUuidGateway.js` | FlowUuidGateway._traceOperation | 2636 |
| `GW-checkref` | `src/core/FlowUuidGateway.js` | FlowUuidGateway.checkReferenceProject | 77259 |
| `GW-checkref-ret` | `src/core/FlowUuidGateway.js` | FlowUuidGateway.checkReferenceProject other_project | 78457 |
| `GW-resolvemedia` | `src/core/FlowUuidGateway.js` | FlowUuidGateway.resolveMedia | 78792 |
| `GW-resolvemedia-ret` | `src/core/FlowUuidGateway.js` | FlowUuidGateway.resolveMedia return | 79834 |
| `GW-controlled` | `src/core/FlowUuidGateway.js` | FlowUuidGateway._controlledRefresh | 81917 |
| `GW-conc` | `src/core/FlowUuidGateway.js` | FlowUuidGateway api concurrency | 67644 |
| `GW-chunk` | `src/core/FlowUuidGateway.js` | FlowUuidGateway chunk 256 | 68134 |
| `OBS-transport` | `flow-v2-correlation-observer.js` | observer onTransportConfig validation | 1919 |
| `OBS-path-re` | `flow-v2-correlation-observer.js` | observer transport path regex | 2254 |
| `OBS-freq` | `flow-v2-correlation-observer.js` | observer parseCalls f.req | 19508 |
| `OBS-wrb` | `flow-v2-correlation-observer.js` | observer walkFrame wrb.fr | 35871 |
| `OBS-rows` | `flow-v2-correlation-observer.js` | observer collection_path use | 36067 |
| `OBS-row-check` | `flow-v2-correlation-observer.js` | observer row identity check | 36281 |
| `OBS-schema-valid` | `flow-v2-correlation-observer.js` | observer validateMediaSchema | 23192 |
| `OBS-match-resp` | `flow-v2-correlation-observer.js` | observer matchingRpcResponse | 41938 |
| `REL-publish` | `src/core/FlowObserverConfigRelay.js` | FlowObserverConfigRelay.publish | 200 |
| `AD-trpc` | `src/core/providers/FlowApiAdapter.js` | FlowApiAdapter getMediaUrlRedirect | 40207 |
