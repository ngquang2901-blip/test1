# 11. Mô hình dữ liệu và lưu trữ phía client

> **Cập nhật runtime 05/11/2026:** [chương 16](16-flow-gpt-runtime-findings.md) đã thu được **82 selector Flow hiện tại**, config transport/correlation và **11 nhóm private config ChatGPT** trên gói Free. Các câu bên dưới nói chúng chưa quan sát được là giới hạn của lượt phân tích trước, không còn là blocker hiện tại. Phần giao thức **Max Speed + mã Bridge** vẫn chưa thu được. Lượt đào sâu mới chỉ tập trung Flow và ChatGPT.

ToolFlow lưu trạng thái ở 4 tầng:

| Tầng | Lưu gì |
|---|---|
| `chrome.storage.local` | Cấu hình, cache config từ server, auth, trạng thái nhẹ (`unlimitedStorage`) |
| `chrome.storage.session` | Trạng thái tạm của phiên trình duyệt (tab Flow đích, cửa sổ đang mở) |
| **IndexedDB** (6 database) | Blob ảnh/video, hàng đợi batch, journal Motion, khoá thiết bị |
| **Server** (`ApiStorage`, chế độ `api`) | tasks, workflows/nodes/edges, prompts, history, settings. Đây là "Cloud" trong UI. |

Toàn bộ nội dung dưới đây đối chiếu với **dữ liệu thật** đọc từ LevelDB `Profile 1/Local Extension Settings/iicjfgdnngmpfocfanpiammedafmomin/` (tài khoản Free, 05/11/2026). Bản dump đã che token, secret và email nằm ở [_work/storage/](_work/storage/).

---

## 11.1 `chrome.storage.local`: bản đồ key

Cột **Live**: có trong storage lúc đọc, kèm kích thước tính bằng byte. Cột **Đọc/ghi bởi** chỉ liệt kê vài file tiêu biểu. [QS]

### Xác thực, thiết bị, quyền truy cập
| Key | Live | Nội dung | Đọc/ghi bởi |
|---|---|---|---|
| `af_auth` | 2787 | `{apiBaseUrl, savedAt, token, user{id,email,plan,plan_slug,role,referral_code,…}}` | AuthManager, FeatureGate, background |
| `tool_client_enrollment` | 225 | `{client_id, secret, expires_at, …}`: khoá HMAC dùng để ký request | RequestSigner, background |
| `tool_device_fp` / `af_fingerprint` | 38 | UUID fingerprint thiết bị, dùng cho telemetry khi chưa đăng nhập | background, UsageSync |
| `tool_config_access_scope` | 395 | Phạm vi lease `device-v1`: `{audience, auth_epoch, user_id, client_id, key_id, key_revision, product_id, token_hash, authorized_at, authorization_ttl_sec:300}` | ProtectedConfigClient |
| `tool_server_time_offset` | 4 | Độ lệch đồng hồ giữa client và server, dùng cho `X-Timestamp` | RequestSigner |
| `af_entitlements` | 12765 | `{plan{slug,name,expires_at}, entitlements{…}, user_id, lastFetch}` | FeatureGate |
| `af_active_session` | 116 | Phiên sử dụng (session_id, active_tab, mốc thời gian) | UsageSync |
| `af_local_usage`, `af_daily_stats` | 28 | Bộ đếm lượt dùng theo ngày ở local | FeatureGate, UsageSync |
| `toolflow_device_banned`, `toolflow_extension_not_authorized` | – | Cờ khoá thiết bị hoặc bản extension clone | app.js |

### Cache config do server cấp (protected, có TTL khoảng 1 giờ)
| Key | Live | Nội dung |
|---|---|---|
| `tool_provider_configs` | 71431 | **Selector DOM** của chatgpt, gemini, grok, muse: `{selectors{key:{priority,selectors[],attribute?,exclude_if_aria_contains?}}, profiles{legacy{host_patterns,selectors}}, config_version}`, bọc trong `{data, meta.access, scope, fetchedAt, expiresAt}` |
| `tool_provider_api_configs` | 2790 | Cấu hình hành vi theo provider. Muse có `automation_timings, error_patterns, max_ref_images, media_fetch, ratios, reference_upload_timings, result_wait, session_readiness, supports, timeouts, urls` |
| `tool_provider_models` | 8884 | 18 model: `{provider, media_type, name, value, is_default, is_premium, config{dom_aliases, duration_tier, max_ref_images, supports_frames, supports_ref_video, supports_voice, …}}` |
| `tool_provider_dom_selectors` | – | Key cũ, `StorageMigration` dọn đi |
| `af_execution_config` | 1345 | `flow_api.*`, `flow_recovery.*`, `parallel.*`, `queue.*`, `timing.*`, `workflow.*` (xem 11.4) |
| `_toolConfigsReady` | 18 | Mốc thời gian cho biết config đã nạp xong |
| `_provider_urls_cache` (session) | – | Cache URL provider |

### Config công khai và versioning
| Key | Live | Nội dung |
|---|---|---|
| `tool_config_versions` | 256 | `{providers{flow:273,chatgpt:87,grok:65,muse:41,gemini:34}, provider_models:111, system_settings:531, node_types:73, default_settings:68, i18n{vi:242,en:259,ja:220,th:220}, validation_rules:7, announcement}`. `ConfigVersionPoller` so sánh để biết cần tải lại gì. |
| `af_system_settings` | 2178 | Thời gian chờ, flag `flow_api_*`, `bridge_min_version:"1.3.38"`, `maintenance_mode`, `remove_watermark_enabled`, `show_upgrade_ui`, `sse_*`, `extension_url`, `facebook_contact_url` |
| `tool_providers` | 1155 | Danh sách 5 provider: `{slug, name, base_url, status, config_version, sort_order}` |
| `af_validation_rules` | 106 | Luật validate input (độ dài prompt…) |
| `tool_i18n_vi/en` | 308 KB / 275 KB | Toàn bộ chuỗi giao diện, tải từ server (`i18n/{lang}`) |
| `af_announcement_*` | – | Phiên bản thông báo đã xem |

### Cài đặt người dùng
| Key | Live | Nội dung |
|---|---|---|
| `af_settings` | 2162 | Khoảng 90 tuỳ chọn (11.3) |
| `af_settings_touched` | 1666 | Những key user đã tự sửa, để không bị `default_settings` của server ghi đè |
| `af_settings_owner` | 47 | Settings thuộc user nào, dùng để chặn rò settings khi đổi tài khoản |
| `af_settings_pending_resync` | – | Cờ cần đẩy settings lên server |
| `af_locale`, `af_locale_explicit` | 4 | Ngôn ngữ vi/en/ja/th |
| `af_location`, `af_preferred_currency` | 133 | Quốc gia và tiền tệ để hiển thị giá |
| `af_onboarding_done(_anon)` | 4 | Đã qua màn onboarding chưa |
| `af_active_sidebar_tab`, `tool_gentab_state` | – | Trạng thái UI sidebar và tab Gen |

### Dữ liệu nghiệp vụ (bản local, hoặc cache khi ở chế độ api)
| Key | Live | Nội dung |
|---|---|---|
| `af_projects` | 2481 | Map `projectUUID → {name, last_accessed, flowOrder}`. Đây là các project trên Google Flow mà extension đã thấy. |
| `af_tasks`, `af_workflows`, `af_nodes`, `af_edges` | 2 mỗi key | Bản local của Tasks/Workflow. Đang rỗng vì dữ liệu nằm trên server (chế độ Cloud). |
| `af_user_prompts`, `af_addon_prompts` | –, 256 KB | Prompt người dùng; addon-prompts gồm **style preset** do server cấp, 256 KB |
| `af_history`, `af_angles_results`, `af_effects_results` | – | Kết quả gần đây |
| `af_running_workflow`, `af_stopped_wfids`, `wf_id` | – | Workflow đang chạy hoặc đã dừng, để khôi phục khi service worker khởi động lại |
| `flow_web_recovery_v1`, `flow_web_recovery_meta_v1` | – | Checkpoint để khôi phục phiên Flow khi trang reload hoặc crash |
| `motion_batch_status` | – | Trạng thái chạy bulk của Motion |
| `tool_provider_characters_scraped`, `tool_provider_voices_*` | – | Character và voice **scrape từ Flow** để chọn bằng @mention |
| `i2p_pending_prompt`, `tf_ref`, `_pending*` | – | "Hộp thư" giữa các ngữ cảnh: I2P→Gen, web→extension (ref, template clone), editor↔sidebar |
| `tool_mcp_runner_id/owner` | 38 / 7 | ID của runner MCP trên thiết bị này |
| `sse_leader_<uid>`, `sse_leader_heartbeat_<uid>` | 29 / 18 | Bầu leader cho kết nối SSE giữa các trang |
| `af_sse_last_event_id` | – | ID event cuối, để resume SSE |
| `tool_flow_api_health_gen_{image,video}`, `tool_flow_upload_diagnostic`, `tool_flow_tracker_collapsed_jobs`, `af_flow_api_auto_open_tracker_grid` | – | Trạng thái chẩn đoán và giao diện tracker trên trang Flow |

### `chrome.storage.session`
`targetFlowTabId`, `targetFlowContext`, `flowReloadUiState`, `flowApiLastAuthError`, `_templatePreviewWindowId`, `_webSpacesWindowId`, `toolflow_motion_runner_host`, `toolflow_pending_login_overlay`, `_provider_urls_cache`, `dispatched`. [QS]

---

## 11.2 IndexedDB [QS]

| Database (ver) | Object store | keyPath / index | File | Dùng cho |
|---|---|---|---|---|
| `autoflow_pro` (v5) | `albums`, `album_images`, `image_blobs`, `pending_uploads`, `uploaded_cache`, `lightweight_pending`, `flow_ref_previews`, `workflow_paste_blobs` | `id`/`key`; index `album_id, created_at, name, updated_at, upload_status, workflow_id` | AlbumStore, ImageStore, PendingUploadStore | Album ảnh, blob ảnh ref, hàng đợi upload lên Flow, cache "đã upload" (tránh upload lại), ảnh dán vào workflow |
| `toolflow_gen_batches` (v3) | `batches`, `assets`, `leases` | `batchId`/`id`/`scope`; index `scope, scopeOrder, scopeStatus, scopeUpdatedAt` | GenBatchQueueStore | Hàng đợi batch Gen bền vững, có lease chống hai tab cùng chạy một batch |
| `toolflow_provider_web_batches` (v4) | nhiều store, `keyPath = name==="leases" ? "userId" : "id"` | – | ProviderWebQueueStore | Hàng đợi batch cho ChatGPT, Grok, Gemini, Muse |
| `toolflow_motion_artifacts` | `artifacts` | `key`; index `bulkJournal, flow, frame, project, source` | MotionArtifactStore | Đoạn video, frame và kết quả trung gian của Motion |
| `toolflow_motion_runs` | `runs`, `outbox` | `key`/`eventId`; index `scope, user` | MotionRunJournal | Journal chạy Motion và outbox gửi event lên server (at-least-once) |
| `toolflow_workflow_muse_videos` | `videos` | `key`; index `node, scope` | WorkflowMuseVideoStore | Video Muse sinh ra trong workflow |
| `toolflow_device_identity` (v1) | `keys` | `id` (`current`, `pending_rotation`, `pending_replacement`) | DeviceKeyStore | **Khoá ECDSA P-256 không export được**. Xem [02](02-xac-thuc-thiet-bi-license.md) |

`settings-page.js` (tab "Bộ nhớ") liệt kê, đo dung lượng và xoá các DB này. `blobMaxAgeDays: 7` là thời gian dọn blob. [QS]

---

## 11.3 `af_settings`: các tuỳ chọn người dùng [QS]

Giá trị dưới đây là giá trị thật của tài khoản đang dùng.

| Nhóm | Key → giá trị |
|---|---|
| Mặc định chung | `defaultProvider:"flow"`, `defaultGenType:"Image"`, `defaultGenMode:"auto"`, `defaultRatio/ImageRatio/VideoRatio:"9:16"`, `defaultImageModel:"Nano Banana 2.1"`, `defaultVideoModel:"Omni 1.1 Flash"`, `defaultVideoDuration:"6s"`, `defaultVideoInputType:"Ingredients"` |
| Flow API | `apiModeEnabled:false` (Max Speed), `flowApiAutoOpenTrackerGrid:true`, `autoMuteFlowVideoUpload:true` |
| Tải về | `autoDownload:true`, `downloadFolder:"toolflow_output"`, `downloadResolution:"1k"`, `fileNameTemplate:"[Index]_[Prompt]_[Project]_[Date]"`, `fileNameProject:""`, `motionDownloadFolder:"motion_studio"` |
| Watermark | `autoRemoveWatermark`, `autoRemoveWatermarkInput`, `autoRemoveWatermarkVideo`, đều `false` |
| Hàng đợi và "giống người" | `queueEnabled:true`, `randomDelayMin:5`, `randomDelayMax:15`, **`humanizedMode:false`, `humanizedSpeed:0.5`** (gõ chậm như người), `inputTimeout:1000`, `manualSubmitMode:false` (chỉ điền, để user tự bấm) |
| ChatGPT | `chatgptModel:"Instant"`, `chatgptDefaultRatio:"story"`, `chatgptDeleteAfterGen:true`, `chatgptAutoClose:false`, `chatgptFallbackPrefix:"Generate an image of:"` |
| Gemini | `geminiModel:"Flash"`, `geminiVideoRatio:"16:9"`, `geminiDeleteAfterGen:true`, `geminiAutoClose:false` |
| Grok | `grokDefaultMode:"image"`, `grokDefaultRatio:"story"`, `grokDefaultDuration:"6s"`, `grokDefaultResolution:"720p"`, `grokDefaultImageQuality:"speed"`, `grokAutoClose:false` |
| Muse | `museDefaultRatio:"9:16"`, `museDeleteAfterGen:false` |
| MCP | `mcpAutoDownload:true`, `mcpDownloadFolder:"toolflow_mcp"`, `mcpDownloadResolution:"1k"`, `mcpVideoDownloadResolution:"720p"` |
| Telegram | `telegramDefaultProvider:"flow"`, `telegramFlowModel`, `telegramFlowRatio`, `telegramFlowVideo*`, `telegramGrok*`, `telegramGemini*`, `telegramChatgptRatio`, `telegramAutoDownload:true`, `telegramDownloadFolder:"toolflow_bot"` |
| Thông báo | `notifyOnComplete:true`, `notifySound:true`, `notifyTelegram:false`, `notifyAffiliateCommission:true` |
| Khác | `language:"en"`, `blobMaxAgeDays:7` |

**[SL]** "Xoá chat sau khi gen" (`*DeleteAfterGen: true`) giúp lịch sử ChatGPT/Gemini của user không bị ngập hàng trăm cuộc chat tự động, đồng thời giảm dấu vết.

---

## 11.4 `af_execution_config`: các tham số vận hành do server áp [QS]

```json
{
 "flow_api": {"driver":"v2","auto_primary":"v2","auto_fallback":"v1","v2_enabled":true,
   "v2_generation_transport":"fetch_request","v2_media_types":["image","video"],
   "v2_surfaces":["gen", "...3"],"v2_upload_enabled":true,"v2_canary_percent":0,"v2_config_revision":1},
 "flow_recovery": {"auto_recovery_enabled":true,"captcha_recovery_mode":"pause_resume",
   "chunk_mode_enabled":true,"chunk_size":40,"consecutive_fail_threshold":2,
   "backoff_base_sec":30,"backoff_max_sec":300,"backoff_jitter_percent":20,
   "session_refresh_enabled":false,"session_refresh_interval_min":120},
 "parallel": {"provider_web_enabled":true,"provider_web_enabled_providers":["muse","…3"],
   "provider_web_max_concurrent_workers":2,"provider_web_*_startup_timeout_ms":60000,
   "provider_web_mcp_direct_enabled":true,"provider_web_motion_enabled":true,
   "provider_web_workflow_enabled":true,"flow_v2_web_enabled":true,"web_resubmit_enabled":true},
 "queue": {"batch_size":6,"max_monitor":6,"video_max_monitor":4,"rest_min_sec":5,"rest_max_sec":15},
 "timing": {"delay_between_prompts_sec":3},
 "workflow": {"delay_nodes_sec":3,"flow_api_enabled":true,"max_retries":1,"on_error":"continue","timeout_sec":180},
 "history": {"chain_options_supported":true,"stage_reason_supported":true}
}
```

Ý nghĩa vận hành: Flow nhận 6 prompt một đợt, theo dõi tối đa 6 ảnh hoặc 4 video cùng lúc, nghỉ ngẫu nhiên 5–15 s giữa các đợt và 3 s giữa các prompt. Nếu 2 lần lỗi liên tiếp thì backoff 30→300 s (jitter ±20%) và chia việc thành khối 40 prompt. Gặp captcha thì tạm dừng rồi tiếp tục. Chi tiết xem [04](04-google-flow-dom-v1.md), [05](05-google-flow-api-v2-max-speed.md), [07](07-gen-batch-queue-tasks.md).

---

## 11.5 Chế độ lưu trữ: Local và Cloud [QS]

- `StorageManager.mode` có hai giá trị: `local` (LocalStorage.js ghi vào `af_tasks/af_workflows/af_nodes/af_edges`) và `api` (ApiStorage.js gọi REST). Tài khoản đang ở **Cloud** (settings ghi "Free · Cloud"), nên các key local đều rỗng (`[]`, 2 byte).
- `StorageMigration` đẩy dữ liệu local lên server khi người dùng đăng nhập, và dọn các key cũ (`tool_provider_dom_selectors`, `af_user_prefs`…).
- Workflow được lưu theo kiểu chuẩn hoá: `workflows/{id}` + `/nodes` + `/edges`, có thêm `bulk-save` để ghi một lần. Media (blob) **không** lên server: chúng nằm ở IndexedDB và trên Google Flow. Landing page ghi: "Your images/videos are stored locally".

---

## 11.6 Vòng đời và xoá dữ liệu
- **Logout:** `ProtectedConfigClient.invalidate` xoá mọi cache config protected (`snapshotKeys`) và `_provider_urls_cache`, rồi phát `CONFIG_ACCESS_INVALIDATED`. `af_settings_owner` chặn settings của user cũ rò sang user mới. [QS]
- **Đổi hoặc thu hồi thiết bị:** `DeviceKeyStore.reconcile` báo `DEVICE_KEY_REVOKED` hoặc `KEY_MISMATCH`, buộc phải enroll lại. [QS]
- **Tab Bộ nhớ** (settings): hiển thị dung lượng từng DB và key, cho xoá theo nhóm. [QS]

## Điểm đáng học / Điểm yếu
- **Đáng học:**
  - Tách bạch rõ: config server (có TTL và scope), settings user (có `touched` để không bị server ghi đè), state chạy (IndexedDB có lease và journal).
  - Mỗi hàng đợi đều có **lease** và **outbox**, nên chịu được việc service worker MV3 bị kill bất cứ lúc nào.
- **Điểm yếu:**
  - `tool_client_enrollment.secret` (khoá HMAC) nằm dạng **plaintext** trong `chrome.storage.local`. Chỉ khoá ECDSA là không export được.
  - Ai đọc được profile thì ký được request trong thời hạn enrollment. Tuy vậy, lease cấp config còn đòi chữ ký ECDSA. **[SL]**

## Câu hỏi mở
- Danh sách đầy đủ các object store của `toolflow_provider_web_batches` (tên được tạo động qua biến `name`). [?]
- `default_settings` (v68) từ server ghi đè những key nào khi user chưa "touch". [?]
