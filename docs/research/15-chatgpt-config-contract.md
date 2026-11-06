# 15. Hợp đồng config ChatGPT (chỉ ChatGPT)

Máy đọc được: [`evidence/chatgpt-config-contract.json`](evidence/chatgpt-config-contract.json) (47 vị trí source, mỗi vị trí có `file`, `symbol`, `offset`, `anchor`; script kiểm bằng assert `source[offset:offset+len(anchor)] == anchor`).

**Nhãn**: **QS** quan sát trong code/snapshot · **QS-runtime** đọc từ bộ nhớ `ProviderConfigManager` sau khi sidebar boot thường (Free, `privateLoaded=true`, HTTP 200 cho `private-configs`, `dom-selectors`, `api-configs`) · **SL** suy luận · **?** chưa biết.
Offset = chỉ số ký tự 0-based trong file đã decode UTF-8. File gốc là minified nên số dòng vô nghĩa.
Phạm vi: `chat-content-chatgpt.js`, `ChatGPTAdapter/Session/Config`, `ProviderConfigManager`, `MessageBridge` (handler GPT), thêm `ConfigSnapshotAccess.js` và 2 handler trong `background.js` (`getProviderPrivateConfigs`, `chatgpt:checkLogin`) vì chúng là chỗ đọc thật. Nhánh phân tích này không tạo network/browser mới; dữ liệu runtime do phiên nghiên cứu chính thu bằng extension nguyên bản, theo [chương 16](16-flow-gpt-runtime-findings.md).

## 1. Ba lớp config

| Lớp | Nơi lưu | Đọc bởi | Ghi chú |
|---|---|---|---|
| L1 Selector | `tool_provider_configs.data.chatgpt.selectors` (44 khoá) | `_getDynamicSelector` (cache 30 s) | **Không có selector cứng**: mọi lời gọi truyền `defaultSelectors=null`; thiếu khoá = không tìm thấy gì. Runtime DOM config **trùng khớp** snapshot tĩnh (cùng 44 khoá, `config_version` 87). |
| L2 API config công khai | `tool_provider_api_configs.data.chatgpt.configs` | không ai | Rỗng `{}`. `ProviderConfigManager._providerApiConfigs` chuyển `chatgpt/grok/gemini` sang kho **private**. |
| L3 Private | `data.chatgpt.configs` của scope `private` | `ConfigSnapshotAccess.privateApi("chatgpt")`, `ProviderConfigManager.fetchPrivateConfigs` | 11 khoá top-level, **có giá trị thật (QS-runtime)** |

Cách field selector được đọc: `selectors[]` thử theo thứ tự mảng; `exclude_if_aria_contains`, `attribute`, `identity_attributes`, `role_attributes`, `text_fallback`, `text_match` có đọc; **`priority` không bao giờ được đọc**. `text_match` được đọc cho `challenge_overlay` nhưng snapshot không có khoá đó. Chỉ `composer, model_switcher_button, plus_button, submit_button, stop_button, ratio_button` bị lọc thêm "phải render/tương tác được".

## 2. Selector: 44 khoá, phân tầng

Tầng là **đề xuất thiết kế** cho hợp đồng tối thiểu, không phải quan sát. Quan sát duy nhất về "bắt buộc": upload ref fail-fast `UPLOAD_SELECTOR_CONFIG_MISSING` nếu thiếu `remove_ref_image_button` (hoặc `audio_attachment_remove_button`) hoặc `ref_upload_pending`; `chatgpt:checkLogin` trả `SELECTOR_CONFIG_UNAVAILABLE` nếu thiếu `composer`.

| Tầng | Khoá |
|---|---|
| T0 gửi + đọc kết quả | composer, submit_button, conversation_turn, assistant_turn, message_author, generated_image, generating_indicator, cdn_image, stop_button, generation_error_alert, response_text_content, completed_text_response |
| T1 chế độ ảnh + ratio | create_image_menu_item, mention_menu, menu_items, open_menu, plus_button, image_mode_pill, ratio_button, composer_mode_radio, mode_menu_item |
| T2 ảnh tham chiếu | file_input, remove_ref_image_button, ref_upload_pending, audio_attachment_remove_button, text_file_tile, pa_source_text_file |
| T3 chọn model | model_switcher_button, model_effort_slider, model_effort_slider_control |
| T4 chat mới + xoá | new_chat_button, chat_history_home_link, conversation_options_button, conversation_options_menu, delete_chat_menu_item, delete_confirm_button |
| T5 challenge/đăng nhập | cloudflare_iframe, challenge_overlay, login_button, auth_link |
| T6 chẩn đoán | image_generation_progress, image_action_buttons, paragen_container, thinking_indicator |

Điểm đáng chú ý (QS):
- `login_button` và `auth_link` **không** được `chat-content-chatgpt.js` đọc. Chỉ `background.js › chatgpt:checkLogin` đọc.
- `reportFailure` (báo selector hỏng) **không** được content script ChatGPT gọi (0 hit).
- Giá trị selector thật nằm trong JSON (`layers.L1_selectors.keys.<key>.value`).

## 3. Private config: giá trị thật (QS-runtime) và nơi đọc

| Khoá | Giá trị runtime (tóm tắt) | Người đọc | Bắt buộc / fallback |
|---|---|---|---|
| `error_patterns.rate_limit_error_text` | 15 mẫu (`rate limit`, `daily limit`, `please upgrade`, `Max 0 uploads at a time`…) | `detectError` | tuỳ chọn; rỗng ⇒ không bao giờ ra `RATE_LIMIT` |
| `error_patterns.content_blocked_text` | 21 mẫu (`content policy`, `safety system`, `may violate`, `please retry`…) | `detectError` | tuỳ chọn |
| `error_patterns.image_gen_failed_text` | 21 mẫu (`error generating image`, `không tạo`, `Something went wrong`…) | `detectError` | tuỳ chọn |
| `error_patterns.network_error_text` | 7 mẫu sau khi bỏ đoạn rỗng (`network error`, `failed to fetch`…) | `detectError` | tuỳ chọn |
| `error_patterns.text_only_pattern` | 21 mẫu từ chối/mô tả (`i'm sorry, but i`, `as an ai`…) | nhánh `TEXT_ONLY` (`matchesConfiguredTextOnly`) | tuỳ chọn |
| `error_patterns.cloudflare_challenge_text` | 3 mẫu (`making sure you're human`…) | **không ai đọc** (chỉ nạp và tính vào "đã sẵn sàng") | n/a |
| `error_patterns.not_logged_in_text` | `log in\|sign in\|sign up\|đăng nhập\|đăng ký` | `background.js` checkLogin (nút ≤ 30 ký tự) | tuỳ chọn; thiếu thì chỉ dùng `login_button`/`auth_link` |
| `ui_text_patterns.create_image_menu_text` | `create image\|create an image\|tạo hình ảnh\|tạo ảnh` | `_getCreateImagePatterns` | code có default tiếng Anh: `create image\|create an image` |
| `ui_text_patterns.generated_image_alt_text` | `generated image\|ảnh đã tạo\|ảnh được tạo` (tiền tố alt) | `isGeneratedImageAlt` | tuỳ chọn; selector `img[alt^="Generated image"]` vẫn chạy |
| `ui_text_patterns.delete_menu_text` | `delete\|xóa` | **không có reader** trong phạm vi | n/a |
| `chatgpt_model_labels` | Instant→`Instant\|Tức thì`; Medium→`Medium\|Trung bình\|Vừa`; High→`High\|Cao`; Pro→`Pro`; Extra High→`Extra High\|Chuyên sâu` | `selectChatGPTModelBestEffort` | best effort; fallback = chính giá trị model |
| `chatgpt_model_slider_values` | Instant 0, Medium 1, High 2 (Pro, Extra High không có) | cùng hàm | best effort; không có ⇒ khớp theo nhãn menu |
| `reference_upload_timings` | preview 60000, completion 120000, settle 1000, poll 300 ms | `injectRefImages`, cổng submit | **bắt buộc khi có ảnh ref**; thiếu/ngoài biên ⇒ `UPLOAD_TIMINGS_CONFIG_MISSING`. Giá trị thật qua validator (assert). |
| `ai_agent_prefix` | `en`, `vi` (chuỗi dài, JSON giữ nguyên) | `getEnhancePrefix` (đường văn bản) | tuỳ chọn; thiếu ⇒ `null` |
| `ratios`, `supports`, `max_ref_images`, `urls` | story 9:16, portrait 3:4, square 1:1, landscape 4:3, widescreen 16:9; supports `ratio,ref_image,auto_download,humanized,image_mode=true`, `quantity,video=false`; `image: 10`; chatgpt.com | `ChatGPTAdapter.capabilities` qua `ProviderConfigManager` | thiếu ⇒ supports `{}` (mọi cờ false), ref 0, ratios `[]`, URL rơi về `_BOOTSTRAP_URLS.chatgpt` |
| `timeouts` | `image_ms 300000`, `text_ms 90000` | **không có reader** trong phạm vi | timeout thật lấy từ `SystemConfig chatgpt_timeout_ms=300000` |

`ratio_ui_map` và `ratio_aria_labels` **vắng ở runtime**: `ProviderConfigManager` tự suy từ `ratios` (đã tính trong JSON). Content script bỏ qua chúng và dùng `RATIO_ARIA_MAP` cứng, khớp 5 mức của server.

Chi tiết quan trọng khi triển khai (đã assert bằng script):
- Parser: tách `|`, trim, lowercase, bỏ rỗng, khớp **chứa chuỗi con** trên `innerText` đã lowercase. Dấu nháy `’` (U+2019) trong vài mẫu chỉ khớp văn bản có đúng U+2019.
- Thứ tự `detectError`: rate_limit → content_blocked → image_gen_failed → network. `something went wrong` nằm ở cả `image_gen_failed` và `network` nên luôn ra `IMAGE_GEN_FAILED`.
- `error_patterns` và `ui_text_patterns` được trộn phẳng (`ui_text_patterns` thắng khi trùng khoá); runtime không có khoá trùng.
- Sẵn sàng khi ≥ 1 trong 6 nhóm lỗi không rỗng; chờ tối đa 10 s rồi chạy tiếp ở chế độ suy giảm (vẫn gửi được, chỉ mất mã lỗi chính xác). `generated_image_alt_text` không tính vào điều kiện này.
- Hằng số cứng trong code: cụm `reached your image creation limit` (→ `LIMIT_ALERT`, thông báo mặc định có "on the free plan"), `RATIO_ARIA_MAP`, câu hậu tố ratio, `fallbackPrefix` mặc định `Generate an image of: `, `POST_COMPLETE_GRACE_MS` 5000.
- Sửa doc 06: `cloudflare_challenge_text` không điều khiển `detectChatGPTChallenge` (nó dùng `challenge_overlay.text_match` + chữ "verifying"/"cloudflare" cứng).
- Đã tìm có giới hạn trong 5 file ChatGPT: `generation_monitor`, `media_allowed_hosts`, `media_mode_prompt_prefixes`, `watermark_removal`, `prompt_prefixes` có **0 hit** (hai khoá cuối chỉ ở danh sách khoá bị khoá chung của `ProviderConfigManager`). Đó là khoá của Gemini/Muse/Flow, không thuộc hợp đồng ChatGPT.

## 4. Vì sao phần nào cần trả phí, phần nào không

**Không cần gói trả phí (QS-runtime, tài khoản Free):**
- Toàn bộ 11 khoá private và 44 selector **đã được cấp cho tài khoản Free đang quan sát**: `privateLoaded=true`, `private-configs` 200, `dom-selectors` 200. `device-v1` scope không chứa trường plan, nhưng điều đó **không chứng minh server bỏ kiểm tra gói**: backend có thể lọc payload/granted theo entitlement ngoài scope. Bằng chứng ở đây chỉ xác nhận dữ liệu cụ thể được cấp cho tài khoản này.
- `entitled.chatgpt=true`; `chatgpt_enabled=1`, `chatgpt_ref_images=1`, `chatgpt_run_max=10`/ngày. Cả 5 model của ChatGPT: `is_premium=false`, `required_feature_key=null`.
- Chạy song song ChatGPT: `af_execution_config.parallel` là cấu hình chung, không thấy khoá entitlement nào cho worker song song.
- Ngay cả `ai_agent_prefix` cũng được giao cho Free dù `ai_agent_enabled=0`: **giao config ≠ quyền dùng tính năng**.

**Gắn với gói (hoặc cổng tính năng riêng):**
- Hạn mức lượt chạy trên 10/ngày (số này theo gói; server áp qua action `chatgpt_run`, chưa kiểm phía server).
- Đường văn bản/AI Agent (`submitText`): Free có `ai_agent_enabled=0`, `prompt_enhancer_enabled=0` **[SL]** vì chưa kiểm chỗ gọi cổng.
- MCP qua ChatGPT, Motion: Free `null`, runtime `motion-studio/projects` 403.
- SSE: `sse/subscribe-token` và `sse/ticket` 403 ở Free ⇒ dùng polling `events/poll`. Ảnh hưởng độ tươi của config, không ảnh hưởng việc có config.

**Phía OpenAI (không phải Tool):** cụm giới hạn tạo ảnh "free plan" là tài khoản ChatGPT của người dùng; việc chọn được `Pro`/`Extra High` phụ thuộc gói OpenAI **[SL]**. Code chỉ chọn model kiểu best-effort nên không chặn.

## 5. Hợp đồng tối thiểu đề xuất cho ToolFlow (thiết kế, không phải quan sát)

- **Bắt buộc**: selector T0 + `create_image_menu_item`, `image_mode_pill`, `new_chat_button`. Private: không bắt buộc.
- **Cứng cục bộ**: mẫu `create image`, `fallbackPrefix`, bảng ratio và `RATIO_ARIA_MAP`, timeout 300000/120000, cụm `image creation limit`.
- **Thêm khi có ảnh ref**: `file_input`, `remove_ref_image_button`, `ref_upload_pending` + `reference_upload_timings` (4 số, qua đúng biên của validator).
- **Thêm khi chọn model**: T3 + `chatgpt_model_labels` (+ `chatgpt_model_slider_values` cho Instant/Medium/High).
- **Thêm khi dọn chat**: T4.
- **Thêm để báo lỗi chính xác**: 4 nhóm lỗi + `text_only_pattern` + `generated_image_alt_text` + `not_logged_in_text`, và `cloudflare_iframe`, `challenge_overlay`, `generation_error_alert`, `login_button`, `auth_link`.
- **Bỏ qua**: `priority`, `cloudflare_challenge_text`, `delete_menu_text`, `timeouts`, `urls.base`, `ai_agent_prefix` (trừ khi làm đường văn bản).

## 6. Khoảng trống

- Runtime chỉ là **Free, một lần boot**; chưa so với gói trả phí.
- Không kiểm selector trên chatgpt.com thật; không có trace gửi/nhận.
- `delete_menu_text`, `timeouts`, `urls.base`: có giá trị nhưng 0 reader trong phạm vi; `background.js` chưa quét hết.
- Server có thật sự chặn `chatgpt_run_max` hay không: chưa quan sát.
- Mẫu lỗi chỉ phủ tiếng Anh/Việt.
