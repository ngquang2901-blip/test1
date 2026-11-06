# TobyFlow 1.3.142 trên Google Flow: kết quả test sống (2026-11-06)

Môi trường: Chrome của Sư Huynh (Profile 2, :10), điều khiển bằng XTEST. Free plan. Flow "Web Mode" (không Max Speed). DevTools: tab Flow (Network, Keep log) + cửa sổ DevTools của sidebar (thấy luôn cuộc gọi `background.js` → labs.toby.vn). Raw HAR chỉ ở `~/Downloads`; ở đây chỉ có `*.timeline.json` (đã scrub email/token) và `*.rea-summary.json`.
Cửa sổ DevTools nổi lên bằng `alt+Tab`; bấm tab Flow thì cửa sổ chính che chúng.

Quy ước: `Flow` = flow.google.com batchexecute (`/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=…`); `Toby` = labs.toby.vn/api/v1.

---

## Tổng hợp UI (F11 một phần, 0 generation)

- Header: icon trợ giúp, tài liệu (popup "Update TobyFlow v1.3.142"), coin (Giới thiệu & Affiliate), globe, gear (menu: Cài đặt, Chế độ tối, Cập nhật Extension, Nâng cấp gói, Giới thiệu, Hướng dẫn, Hỗ trợ, **Đăng xuất** – không bấm), chuông (Thông báo: trống).
- 4 tab: Gen / Workflow / Studio (NEW) / Tasks; 4 icon: Prompts (Templates + My Prompt), Photos (Album / Flow Images / Tìm kiếm), Tools (Motion Studio 👑, Xóa watermark, Cắt video, Angles, Effects, AI Agent (MCP), Telegram), Lịch sử (Lịch sử/Hàng đợi, tìm kiếm, Yêu thích).
- **Studio**: khóa trên Free ("Tính năng bị khóa… Motion Studio", nút Nâng cấp). Toby `GET /tools/motion-studio/projects` trả 403. Không chạy được → F10 = locked.
- **Workflow**: tab Templates (≈ 20+ template có YouTube link: Subway Fashion Workflow, 24 Car Trend…), Workflows (rỗng), Được chia sẻ. Gọi `/workflows`, `/workflow-templates` (198 KB), `/workflows/shared-with-me`.
- **Tasks**: rỗng ("Thêm task đầu tiên"), nút "+ Thêm".
- **Templates** (icon Prompts): lưới thẻ từ `GET /templates` + `/templates/categories`, ảnh thumbnail từ `labs.toby.vn/storage/media`; lọc theo loại/độ khó, "Sử dụng template".
- **Album**: "Chưa có album nào", `+ Tạo album`; tab Flow Images; Tìm kiếm.
- **Lịch sử**: `GET /history` (1 mục từ lần chạy video trước).
- **Settings** (cửa sổ popup "Cài đặt", có email tài khoản → không lưu ảnh): tab Cài đặt/MCP(👑)/Thiết bị/Bộ nhớ/Giới thiệu; sub-tab Chung / Nền tảng AI / Nâng cao.
  - Chung: Tài khoản (Cloud, Free; Nâng cấp/Đăng xuất – không bấm); Upload lên Flow: tự tắt tiếng khi upload (BẬT); Tự động tải về: tự tải sau khi tạo xong (BẬT), tự mở lưới kết quả bằng Flow API (BẬT); thư mục `tobyflow_output`, thư mục Motion `motion_studio`, mẫu tên file `[Index]_[Prompt]_[Project]_[Date]`, độ phân giải ảnh 1K, video 720p; cảnh báo Chrome "Hỏi nơi lưu từng tệp"; giao diện (Theme tối, tiếng Việt); thông báo hoàn thành + âm thanh.
  - Nền tảng AI: provider mặc định Flow; Web Mode (kết nối 1/1) vs Max Speed (Premium); Flow No Watermark (3 công tắc, khóa Premium); mặc định Flow: loại Image, tỉ lệ 9:16, model ảnh Nano Banana 2.1, model video Omni 1.1 Flash, thời lượng 6 s; Giọng đọc Flow (quét Voices); ChatGPT/Gemini mặc định.
  - Nâng cao: Timeout thực thi 1000 ms; lưu blob ảnh album 7 ngày; **Pipeline Queue BẬT** (chạy đa tác vụ cùng lúc); **Chống ban: nghỉ random 5–15 s**; Humanized mode TẮT; tốc độ gõ 0.5x–2.0x; **Chế độ Manual Submit (Flow)** (công tắc toàn cục, TẮT).
- Poll nền Toby: `events/poll` (GET, ~20 s), `mcp/executor-heartbeat` + `telegram/executor-heartbeat` (POST ~30 s), `sse/ticket` (403 trên Free), `notifications/unread-count`, `usage/heartbeat`, `extension-config/access`.

---

## F1: Flow image, text→image (Nano Banana 2 Lite, 9:16, qty 1, 1K)

- Gen = 1 (ledger #1). Prompt: "A small yellow rubber duck on a wooden desk, soft window light, flat illustration."
- Model dropdown ảnh có đúng 3 mục: Nano Banana 2.1 (mặc định), Nano Banana Pro, Nano Banana 2 Lite. Xóa ref trước (nút thùng rác).
- Modal "Xác nhận chạy": Mỗi prompt/Multi-Prompt, dòng "Flow · Ảnh · Sẵn sàng", Tỷ lệ, Số lượng, Tải xuống (1K), **Chế độ Flow submit**: Tự động submit / Tự submit (Manual); nút Hủy/Chạy. Không hiện model, không hiện credit.
- **Toby (labs.toby.vn)**, đúng thứ tự: `POST /execution/request` {action:"generate", prompt_count, metadata{owner:"prompts", label:"Auto Gen", provider:"flow", media_type:"image", has_ref:false, ref_count:0}} → `{allowed:true, execution_token, expires_in:300, remaining:18, remaining_module:18, remaining_global:98}` (trước đó đã dùng 2/20 hôm nay); … `POST /execution/complete` {token, status:"success"} → `{refund_count:0}` ngay khi Flow trả kết quả; `POST /usage/events` (batch 20 sự kiện, xem dưới); `POST /history` (201) gửi prompt, model "Nano Banana 2 Lite", ratio, result_file_ids = media id Flow, tên file tải "tobyflow_output/tobyflow-01/001_…". Gọi kèm `GET /entitlements`, `/auth/me`, `/config/versions`, `/extension-config/system-config/execution`.
- **Vòng đời (usage/events `flow_api_lifecycle`, mode=web, page_driver=flow_v2)**: `job_admitted` → presubmit `observer_preflight` → `text_insert` (+1.7 s) → `editor_verified` → `snapshot` → `reference_final_verify` → `correlation_armed` → `arm` → `journal` → `verify_passed` → `click_ack` (+0.55 s) → `correlation_request_seen` (Flow request ra) → (+10.1 s) `pending_owners_observed`/`correlation_response_seen` → `download_transition` → `item_terminal` COMPLETED, duration 11301 ms, retry_count 0. Tức là Web Mode = **điều khiển DOM của composer Flow** (chèn text, bấm nút Generate) + quan sát network (MAIN-world interceptor `media-interceptor.js`) để ghép request↔prompt, không gọi RPC tự chế.
- **Flow RPC**: `HTrJv` (danh sách model/config) → `as29s` ×2 (resolve media) → **`ogiZ0b`** = tạo ảnh: args `[null,[[null,null,null, 239192284, 2, "HARBOR_SEAL", null, [clientCtx{…,projectId, recaptcha token [REDACTED len=2617]}], [[[prompt]]], …]], 1, clientCtx, [sessionId]]`. 239192284 là **seed ngẫu nhiên** (F2 là 1779283575), model được chọn bằng tên mã `"HARBOR_SEAL"` (= Nano Banana 2 Lite); recaptcha Enterprise mới được lấy trước đó (`recaptcha/enterprise/reload` → `clr`). Response **đồng bộ** (~1 s): trả luôn media id `f2c4202a-…` (không có `jwpduf` polling như video). Sau đó `ngNC2` (project tools/PINHOLE), `as29s` (resolve → flow-content.google/image/<id>, 768×1376 thực tế, 87957 B), `WuwhI` (log MEDIA_GENERATION client-event, TOOL_NAME=PINHOLE, MEDIA_GENERATION_TYPE=image).
- Phát hiện hoàn tất: ~10 s sau khi gửi; Toby đọc kết quả từ response/tile Flow (`correlation_response_seen`), không poll riêng.
- Download: sau `download_transition` TobyFlow tải ảnh qua chrome.downloads từ flow-content; Chrome hiện prompt **"flow.google.com wants to: Download multiple files"** (Allow/Block) → tải bị chặn tới khi bấm Allow (+25 s). File: `~/Downloads/tobyflow_output/tobyflow-01/001_A_small_yellow_rubber_duck_on_a_wooden_d_2026-11-05.jpg` (87957 B, khớp size Flow; Toby ghi tên .png trong history nhưng file thực là .jpg).
- Bất ngờ: mô tả quota: `remaining_global:98` cạnh `remaining:18` (hạn mức 20/ngày theo module + toàn cục 100). `/sse/ticket` 403 và `/projects?per_page=1` 403 trên Free.
- Evidence: `f1-image.timeline.json`, `f1-image.rea-summary.json`, `toby-f11f1.timeline.json` (toàn bộ cuộc gọi Toby từ đầu phiên tới F1).

---

## F2: Flow image + 1 ảnh tham chiếu (Nano Banana 2 Lite, 9:16, qty 1)

- Gen = 2 (ledger #2). Ref: `~/Downloads/toolflow-ingredient-1.png` (720×1280, đĩa vàng trên nền navy). Prompt: "Turn the reference into a cheerful sun icon on a night sky, flat illustration."
- Picker "Chọn / Tải ảnh lên": 3 tab Album / Ảnh trên Flow / Upload (tối đa 10 ảnh); Upload → "Chọn từ máy tính" mở GTK file dialog (ctrl+L, đường dẫn, Enter) → Xác nhận. Thumbnail hiện nhãn "Chờ upload" (upload chỉ diễn ra lúc chạy).
- **Toby**: `execution/request` {has_ref:true, ref_count:1} → remaining 17 (global 97) → `execution/complete` success → `usage/events` → `history` (201, có ref_file_ids = media id đã upload + ref_thumbnails, result_file_ids). Quota được trừ **ngay lúc request**, không phải lúc xong.
- **Flow RPC (đúng thứ tự)**: ngay khi bấm Chạy, TobyFlow gọi `UpteDb` (danh sách project) + `as29s` (kiểm tra media cũ) → **`maseQ`** upload ảnh (args: clientCtx{recaptcha}, base64 [REDACTED len=9336], "image/png", tên đổi thành `toby_<uuid>.png`) → trả media id `d9ce2371-…` (720×1280, 26053 B; Flow chuyển PNG→JPEG) → `WuwhI` event `FLOW_UPLOAD` (FLOW_UPLOAD_TYPE=IMAGE, SOURCE=…) → **`ogiZ0b`** với `args[1][0][2] = [["d9ce2371-…",null,null,null,1]]` (ref list) + seed + "HARBOR_SEAL" + prompt → response đồng bộ (~1 s) trả media id kết quả `5c5f3c21-…` → `ngNC2` + `as29s` (resolve) → `WuwhI FLOW_CONTEXT_MENU` (Flow tự gửi khi UI mở menu ảnh). Không có `jwpduf` cho ảnh.
- Mốc thời gian (UTC): click 17:57:14 → upload xong 14.9 s → `ogiZ0b` 17:57:28.5 → kết quả 17:57:39 (`execution/complete`) → download 17:57:44. Tổng ≈ 30 s (upload + ~4 s thiết lập composer + 11 s sinh ảnh).
- Composer: thấy TobyFlow mở popup "Thêm vào câu lệnh" của Flow (asset picker, list "Hình ảnh") để đính kèm ảnh → đó là cách TobyFlow cấp file cho Flow (qua file picker/asset chọn của Flow, tên upload `toby_<uuid>.png`), sau đó popup đóng, prompt được chèn, bấm Generate.
- Tải: `001_Turn_the_reference_into_a_cheerful_sun_i_2026-11-05.jpg` (66664 B). Lần này Chrome KHÔNG hỏi lại quyền download (đã Allow ở F1).
- Evidence: `f2-image-ref.timeline.json`, `f2-image-ref.rea-summary.json`, `toby-f2.timeline.json`.

---

## F3: Flow video text→video (Veo 3.1 - Lite, 9:16, qty 1, 720p)

- Gen = 1 (ledger #3b). Lần bấm Chạy đầu (chế độ **Frames** không có frame) **không tạo gì**: TobyFlow kiểm tra phía client, ô START viền đỏ, Network Flow trống, `remaining` của Toby không giảm. → trong UI Gen **không có chế độ "text-only" riêng**: loại input chỉ có *Ingredients* / *Frames*; text→video = *Ingredients* với 0 ref. Lần 2 (Ingredients, 0 ref) chạy được.
- Veo 3.1 Lite + Ingredients không ref → rpc **`YhhmEf`** (text→video): args `[[[[null,null,[[[prompt]]]],"veo_3_1_t2v_lite",1,null,[null,null,null,null,<uuid>,<uuid>]]], clientCtx{projectId, recaptcha [REDACTED len=2617]}, [<uuid>,2]]`. Response ngay (~5.9 s) trả `[null,1018,[[mediaGroupId,…,["Paper kite floats across sky",…]]]]` — 1018 là số credit còn lại của Flow, kèm media id `5a2522f2-…`.
- Theo dõi: `jwpduf` args `[null,null,[[mediaId]]]` **mỗi 5 s** (9 lần, 18:01:04 → 18:01:44; status 6/2 đang chạy → 3 xong), `ngNC2` + `as29s` (url video + byte size), rồi GET `flow-content.google/video/<id>` → `videoplayback` (302 → googlevideo, 206).
- Toby: `execution/request` (has_ref:false, media_type:video, remaining 16/96) → `usage/events` (gen_start, job_admitted, presubmit… `click_ack`, `correlation_request_seen` @+1.0 s, `correlation_response_seen` @+6.9 s, `correlation_poll_seen`, `correlation_result_seen` @+48.5 s, `item_terminal` COMPLETED duration 46614 ms, `job_terminal` duration 54568 ms (gồm tải)) → `execution/complete` success → `history` (201: model "Veo 3.1 - Lite", result_file_ids = mediaId, result_thumbnails.video_url).
- Composer Flow (quan sát): banner Flow "Đang tạo nội dung · Giữ cửa sổ Flow mở…"; tile mới hiện shimmer rồi video; tracker nổi của Toby (Auto Gen, chip WEB, thanh % và nút tải/xoá/thử lại).
- File: `001_A_paper_kite_floats_slowly_across_a_pale_2026-11-05.mp4`: 720×1280 h264 + aac, 7.92 s, 1,721,774 B, sha256 3bb7e523dadbe904…
- Evidence: `f3-video-text.timeline.json`, `.rea-summary.json`, `toby-f3-video-text.timeline.json`.

---

## F4: Flow video Frames START + END (Veo 3.1 - Lite, 9:16, qty 1, 720p)

- Gen = 1 (ledger #4). START = `toolflow-start-frame.png` (thuyền giấy đỏ), END = `toolflow-end-frame.png` (đĩa xanh lá trên nền vàng).
- UI Toby: mode Frames hiện 2 slot START/END (START viền đỏ khi trống = bắt buộc). Bấm "Add" trong slot mở picker (chỉ chọn **1 ảnh/lần** cho slot); ảnh cũng nằm trong danh sách "Ảnh tham chiếu" với nút Gán Start / Gán theo cặp / Chuỗi A→B / Xóa; ảnh có thể kéo-thả sắp xếp. Xóa ref: rê chuột lên thumbnail → nút ✕ đỏ (nút "Xóa" chỉ xóa gán START/END).
- Toby: `execution/request` {has_ref:true, ref_count:2}; lifecycle y như F3 (`correlation_*`, `item_terminal`).
- **Flow RPC**: `HTrJv` (model config) → `maseQ` upload START (png→`toby_<uuid>.png`, 13408 b64) → trả media `ecd1ccd8-…` → `ngNC2`/`as29s` → (+14 s) `maseQ` upload END → `e7aaac2c-…` → (+13 s) **`nprQif`** args `[[[[null,null,[[[prompt]]]],"veo_3_1_interpolation_lite",1,null,[null,"<startId>",null,null,null,[null,null,1,1]],[null,"<endId>",null,null,null,[null,null,1,1]],[null,null,null,null,<uuid>,<uuid>]]], clientCtx{recaptcha}, [<uuid>,2]]` → response `[null,1008,[[groupId,…,["Red paper boat turns plant",…]]]` rồi `jwpduf` mỗi 5 s (9 lần) → `as29s` → video `105ec071-…`.
- Model key: **`veo_3_1_interpolation_lite`** (START_END). Số 1018→**1008**: mỗi video Lite frames trừ ~10 credit Flow (số trả ở `[null, <credits>, …]`).
- Bất ngờ: upload START và END **tuần tự, cách nhau 13–14 s**, rồi 13 s nữa mới submit → trùng với "Chống ban: nghỉ random 5–15 s" trong Settings (delay giữa các bước upload, không phải do Flow chậm). Tổng ~80 s từ Chạy đến xong (sinh video thật ~45 s).
- File: `001_The_red_paper_boat_drifts_across_blue_wa_2026-11-05.mp4` 720×1280 h264+aac 7.92 s, 1,117,443 B, sha256 644e94d60e4aacec….
- Evidence: `f4-video-frames.timeline.json`, `.rea-summary.json`, `toby-f4-video-frames.timeline.json`.

---

## F5: Flow video Ingredients (Veo 3.1 - Fast, 9:16, qty 1, 720p, 2 refs)

- Gen = 1 trên Toby, nhưng **2 lần submit lên Flow** (ledger #5 → tính 2 vào cap, tổng 6/14).
- Model dropdown video: Omni 1.1 Flash, Veo 3.1 - Lite, Veo 3.1 - Fast, Veo 3.1 - Quality, Veo 3.1 - Lite [Lower Priority]. Chọn Fast (Lite bị cấu hình Toby từ chối ingredient refs; không thử Omni/Lower Priority).
- Ingredients không có slot START/END; danh sách ref (đánh số 1, 2) + chọn Nhân vật / Giọng ngẫu nhiên / Phong cách. Ảnh đã upload ở F4 nên **không upload lại** (as29s kiểm tra id cũ `ecd1ccd8…`, `e7aaac2c…` rồi dùng luôn).
- **Flow RPC `MZZa6b`**: args `[[[[null,null,[[[prompt]]]],[[null,"<ref1>"],[null,"<ref2>"]],"veo_3_1_r2v_fast_portrait",1,null,[null,null,null,null,<uuid>,<uuid>]]], clientCtx{recaptcha}, [<uuid>,2]]` → `[null, 988, …]` (credit 1008→988: **Fast + refs = 20 credit**, gấp đôi Lite frames). XML prompt Flow ghi lại: `<root><context/><instruction><prompt>…</prompt></instruction></root>`.
- **Job 1 thất bại**: `jwpduf` poll 5 s ×6, kết quả status 4 với chuỗi lỗi kết thúc `…GENERATION_FILTERED` (bộ lọc nội dung của Flow, prompt vô hại → có thể do ref trừu tượng), credit hoàn lại (`nzlxg` = RPC số dư: `[1008,1,2,2,null,1008,[expiry]]` → sau retry `[988,…]`). Tile Flow hiện "Không thành công" + nút thử lại/xoá.
- **TobyFlow tự retry không hỏi**: ~0.2 s sau khi thấy fail (18:08:10.28) chạy lại toàn bộ `presubmit` (observer_preflight → reference_attach_attempt → text_insert → … → click_ack) rồi `MZZa6b` thứ 2 (18:08:12.6) → `jwpduf` ×N → status 3 (xong) 18:08:46. Chỉ **1** `execution/request` (remaining 14) và 1 `execution/complete` success: retry nội bộ không tốn thêm quota Toby (nhưng tốn 1 lần submit Flow; lifecycle ghi `retry_count`).
- `reference_attach_attempt` xuất hiện trong presubmit khi có ref: TobyFlow gắn ref bằng DOM của composer Flow (picker "Thêm vào câu lệnh") trước khi chèn text.
- File: `001_A_red_paper_boat_and_a_green_tree_icon_t_2026-11-05.mp4` 1,088,362 B (đã `ffprobe` ở lệnh trên).
- Evidence: `f5-video-ingredients.timeline.json`, `.rea-summary.json`, `toby-f5-video-ingredients.timeline.json`.

---

## F6: Multi-Prompt, 3 ảnh trong 1 batch (Nano Banana 2 Lite, 9:16, qty 1 mỗi prompt)

- Gen = 3 (ledger #6, tổng 9/14). Bật công tắc **Multi-Prompt** → ô prompt hiện cảnh báo "Mỗi prompt cách nhau bằng 1 dòng trống", bộ đếm `3 / 5` (tối đa **5 prompt** trên Free), header "3 prompt → 3 kết quả"; hiện thêm "Dùng kết quả prompt trước làm ảnh tham chiếu" (chain ảnh→ảnh, TẮT) + nút chế độ chạy **Song song** (mặc định). Modal xác nhận có thêm dòng **Chế độ chạy: Song song**.
- Toby: **1** `execution/request` {action:"generate", **prompt_count:3**} (expires_in 645 s thay vì 300 s) → `remaining` 14→13: quota Free tính theo **lượt chạy**, không theo số prompt. 1 `execution/complete` ở cuối, 1 `history` (201) với prompt = 3 prompt nối bằng "\n\n".
- **Flow**: 3 `ogiZ0b` riêng, mỗi cái 1 prompt, seed riêng (1543349143 / 1847653519 / 1935208017) — **tuần tự dù chọn "Song song"**: #0 submit 18:10:53.0 → xong 18:11:03.3 (10985 ms) → #1 submit 18:11:04.3 (+1 s) → xong 18:11:14.6 → #2 submit 18:11:19.4 (+4.8 s nghỉ) → xong 18:11:29.9. Tổng job 48.4 s. TobyFlow đợi `correlation_response_seen` của prompt trước rồi mới chèn prompt kế tiếp vào composer (cùng một composer Flow, nên không thể song song thật trong Web Mode; "Song song" = song song giữa các task/pipeline queue, không phải giữa prompt).
- **Ghép kết quả↔prompt**: `correlation_armed(prompt_index=i)` trước khi bấm → `correlation_request_seen` (interceptor thấy `ogiZ0b` ra) → `correlation_response_seen` (response chứa media id + prompt gốc ở `data[0][0][6][0][7]`) → `item_terminal`. Tên file theo thứ tự `001_…`, `002_…`, `003_…`.
- Files: `001_A_single_red_apple_…jpg` 31611 B, `002_A_blue_bicycle_…jpg` 152804 B, `003_A_small_green_cactus_…jpg` 56826 B.
- Evidence: `f6-multiprompt.timeline.json`, `.rea-summary.json`, `toby-f6-multiprompt.timeline.json`.

---

## F7: Chain 2 video prompts "Tiếp tục từ khung hình cuối của video trước" (Veo 3.1 - Lite, Frames) — **KHÔNG HOÀN TẤT (treo)**

- Gen thực tế = **1** (video 1 do Flow tạo; video 2 chưa bao giờ được gửi). Ledger #7; tổng 7/14.
- UI: bật Multi-Prompt + Frames → mỗi prompt có cặp slot START/END riêng (thẻ "1 / 2"). Công tắc "Tiếp tục từ khung hình cuối của video trước" nằm dưới danh sách ref (cả Ingredients lẫn Frames). Bật chain → nút chế độ chạy tự đổi **Song song → Tuần tự**, modal xác nhận hiện "Chế độ chạy: Tuần tự". UI có lỗi bố cục nhỏ: danh sách "Ảnh tham chiếu" bị hiển thị 2 lần sau khi bật.
- Đã gán START = `toolflow-start-frame.png` cho prompt 1; prompt 2 để trống (kỳ vọng nhận khung cuối của video 1).
- Toby: `execution/request` {prompt_count:2, has_ref:true, ref_count:1} → `expires_in: 930` s (300 + 315/prompt?), remaining 12 (global 89). Không có `execution/complete`/`history` (job không kết thúc).
- Flow: `maseQ` (upload START, 13408 b64) → `eb1hJf` (model `veo_3_1_i2v_lite`, START media `bc52c218-…`) → `jwpduf` mỗi 5 s ×9 → status 3 lúc **18:15:17** (46 s; credit 988→978) → `ngNC2` + `as29s` (video `31895334-…`). Toby ghi `correlation_result_seen` 18:15:18.5 rồi **im lặng**: không `item_terminal`, không `download_transition`, không có RPC/upload nào của khung cuối trong 5+ phút; chỉ còn heartbeat/poll nền. Tracker: #1 "Xong 00:46" nhưng quay vòng, tổng 0/2, banner Flow "Đang tạo nội dung · Giữ cửa sổ Flow mở…" vẫn bật.
- Quá 6 phút → em dừng bằng nút Stop của tracker (kết quả: "Đã dừng · 0 thành công · 1 lỗi", #2 "Bị chặn · Chưa gửi"). Video 1 tồn tại trên Flow (tile "Red p…") nhưng KHÔNG được tải về.
- **Chưa quan sát được** cách khung cuối của video 1 trở thành START của video 2 (trích khung, upload `maseQ`), vì treo trước bước đó. Nguyên nhân treo chưa xác định (nghi bước trích khung cuối/đọc video blob trong tab Flow; không có lỗi nào lộ ra ở network). Không thử lại theo luật cap.
- Evidence: `f7-chain.timeline.json`, `f7-chain.rea-summary.json`, `toby-f7-chain.timeline.json`.

---

## F8: Manual submit (Nano Banana 2 Lite, ảnh, 9:16, qty 1)

- Gen = 1 (ledger #10, Flow Enter) + **1 gen ngoài kế hoạch** (#8a): lúc đi tìm công tắc Manual trong modal, em bấm nhầm đúng vị trí nút Chạy (bố cục modal 1-prompt khác modal multi-prompt) → chạy Auto-submit 1 ảnh "A tiny orange fox…" (Nano Banana 2 Lite, xong ~15 s, tải về 001_A_tiny_orange_fox_….jpg). Đã ghi vào ledger là lỗi của em. Tổng 9/14.
- Modal: nhóm **CHẾ ĐỘ FLOW SUBMIT** có 2 nút: *Tự động submit* (mặc định; "TobyFlow tự động submit sau khi điền prompt + ref") và *Tự submit (Manual)* (tooltip: "TobyFlow tự động nhập prompt, bạn tự Enter/Click Submit cho từng prompt (Dùng khi Flow cảnh báo lỗi)"). Cùng chức năng với công tắc toàn cục "Manual Submit (Flow)" trong Settings → Nâng cao.
- Quan sát trên Flow: sau Chạy, TobyFlow **gõ prompt vào composer Flow** (dòng "A small purple umbrella leaning on a wooden door…" hiện trong ô "Bạn muốn tạo những gì?") và hiện toast xanh ở dưới "Nhấn Enter / bấm Gửi để gen" + nút "Bỏ qua"; tracker nổi có chip **Manual**, item "Chờ submit" + "Bỏ qua". Không có request Flow nào trong ~25 s chờ.
- Toby: `execution/request` **ngay lúc bấm Chạy** (18:23:28.6, remaining 12→11) — quota bị trừ dù chưa submit (nếu bấm "Bỏ qua" thì chưa biết có hoàn không; không thử). Lifecycle: `job_admitted` → `text_insert` → `editor_verified` → `snapshot` → `reference_final_verify` → `correlation_armed` → (dừng, **không có `click_ack`**) → khi em nhấn Enter: `correlation_request_seen` (18:23:55.6) → `correlation_response_seen` (18:24:05.5) → `outputs_completed` → `item_terminal` COMPLETED (duration 37036 ms tính cả thời gian chờ em) → download → `job_terminal`; `execution/complete` + `history`.
- Flow: ngay trước khi gửi có `nzlxg` (số dư credit) → `ogiZ0b` (Flow tự gửi, không phải TobyFlow) → `WuwhI` → `ngNC2` → `as29s`. TobyFlow bắt request bằng interceptor `correlation_armed` nên Manual vẫn ghép được kết quả, vẫn tải tự động: `001_A_small_purple_umbrella_leaning_on_a_woo_2026-11-05.jpg` (148,637 B).
- Evidence: `f8-manual.timeline.json`, `.rea-summary.json`, `toby-f8-manual.timeline.json` (+ `x-accidental-image.*` cho lần chạy nhầm).

---

## F9: Workflow Builder (Text → Flow Image Generate → Auto Download)

- Gen = 1 (ledger #11; tổng 10/14). Ảnh kết quả: `~/Downloads/tobyflow_output/Workflow_moi_-_6_11_2026/Auto Download_A small blue teapot on a kitchen shelf, flat illustration.jpeg` (145,724 B) — workflow dùng **thư mục theo tên workflow và tên file "<node>_<prompt>"**, khác tên mẫu `[Index]_[Prompt]…` của Gen. Ảnh chụp đồ thị: `f9-workflow-graph.png`.
- UI: Workflow → tab *Workflows* → "+ Thêm" mở **cửa sổ riêng "Workflow Editor - Toby Flow"** (canvas dạng React-Flow; thanh công cụ trái: thêm node, chọn, tay kéo, note, upload ảnh, **Run (nút xanh)**, undo/redo, auto-layout, tìm, fit, cài đặt; góc phải: số dư "0 B", chip Max Speed (khóa), Reset, Lưu). Bấm "+" → ô tìm node với danh mục: **Image/Video** (upload/gán ảnh-video ref), **Prompt** (ChatGPT/Gemini: enhance, phân tích ảnh, viết kịch bản…), **Flow – Image/Video Generate**, GPT Image 2, Grok – Images/Videos Generate, (merge video: "Download and merge connected videos in reference order"), Muse, Gemini, **Auto Download**, **Text** (nguồn text tĩnh, tham chiếu qua `@slug`), **Note**. Mỗi node có cổng gợi ý: bấm cổng "Prompt text" của node Flow → gợi ý Prompt/Text; bấm cổng "Kết quả" → gợi ý node kế tiếp (Auto Download…). Node Flow có thanh dưới: số lượng (1x), Ảnh/Video, model (Nano Banana 2.1/Pro/Lite), tỉ lệ; (dropdown model bị cắt ở đáy cửa sổ nên không chọn được Lite → dùng mặc định 2.1).
- Node types (server): `text`, `generate`, `download` (+ `image_video`, `prompt`, `note`…). Lưu = `POST /workflows/bulk-save` với `wf_id: wf_<ms>_<hex>`, `settings_json {delay_between_nodes:5, max_retries:2, timeout:180, stop_on_error:false, parallel_execution:true}`, nodes[] (`node_id`, `node_type`, `pos_x/y`, `prompt`, `model`, `ratio`, `quantity`, `ref_file_ids`, `frame_1/2_source`, `auto_download`, `download_resolution`, `slug`…), `platform:"flow"`, `project_id`. Workflow nằm **trên server Toby** (id 22183 của user), không phải local.
- Chạy: nút "Chạy tất cả" trong danh sách → hộp thoại "Chạy tuần tự 1 workflows? Chỉ chạy project hiện tại" → Xác nhận → modal **"Trạng thái AI Provider"** (Flow: Sẵn sàng; chọn Auto/Manual submit — nó đang giữ Manual từ F8, em đã chuyển về Auto; việc này ghi `PUT /settings manualSubmitMode:false`, đúng bằng giá trị ban đầu) → Chạy.
- Toby (thứ tự): `PUT /settings` → `POST /execution/request` **{action:"workflow_run", prompt_count:1, metadata{owner:"workflow", workflow_id, node_count:3, max_retries:2}}** (expires_in 4080 s, remaining 9) → `POST /workflows/bulk-save` (status idle) → **`POST /workflows/{id}/execute`** (server trả **kế hoạch thực thi**: steps[0 text, 1 generate dep text, 2 download dep generate], `level_count 3`, `cycle_detected false`, `expires_at +30 min`, execution_id) → `PUT /workflows/{id}` status running → `POST /executions/start` {total_nodes:3, executor_context:"sidebar"} → `GET /workflows/{id}/nodes` (poll) → khi xong `bulk-save` progress 3/3, `PUT status completed`, `POST /execution/complete`, `history` (201, model "Nano Banana 2.1"). usage/events: `workflow_start` … `workflow_complete {success:true}`.
- Cách ánh xạ lên Flow: **node `generate` chạy đúng đường Gen Web Mode** (`job_admitted` → `text_insert` → … `correlation_armed surface:"workflow"` → `click_ack` → `ogiZ0b` (1 request) → `correlation_response_seen` → `item_terminal` 22809 ms). Node `text` chỉ cung cấp prompt (không gọi mạng), node `download` lưu file vào thư mục workflow. Executor chạy **trong sidebar** (không cần gọi Flow RPC riêng); server Toby chỉ lập kế hoạch/lưu trạng thái.
- Bất ngờ: toàn bộ workflow thực tế chỉ là 1 `ogiZ0b`; thời gian ~40 s từ Xác nhận đến xong (gồm 8 s chờ modal provider và delay 5 s giữa node).
- Evidence: `f9-workflow.timeline.json`, `f9-workflow.rea-summary.json`, `toby-f9-workflow.timeline.json`, `f9-workflow-graph.png`.

---

## F10: Studio / Motion Studio / Angles / Effects — **KHÓA trên Free, không chạy**

- Tab Studio: hiện "Tính năng bị khóa — Gói hiện tại của bạn không bao gồm tính năng Motion Studio" (nút *Để sau* / *Nâng cấp* – không bấm). Server cũng chặn: `GET /tools/motion-studio/projects` → **403** ở mọi lần mở.
- Icon Tools liệt kê 7 thẻ: **Motion Studio** (👑 khóa), **Xóa watermark** (Gemini · Flow; kéo thả ảnh/video, nút "Xóa watermark"; chưa chạy), **Cắt video** (video ≤300 MB, mỗi đoạn 1–60 s, mặc định 10 s; xử lý local, nút "Cắt và tắt tiếng"/"Tải tất cả"; chưa chạy), **Angles** ("Tạo ảnh đa góc nhìn"), **Effects** ("Áp dụng hiệu ứng ảnh"), **AI Agent** (MCP – khóa Premium), **Telegram** (liên kết bot). Em **không thử chạy** Angles/Effects/Xóa watermark vì mỗi cái cần ảnh đầu vào + 1 generation; ledger không có lượt nào cho F10. Panel Angles/Effects không mở được ổn định bằng XTEST (lần bấm lặp lại rơi vào panel "Xóa watermark"/"Cắt video"); ghi là **chưa kiểm chứng**.
- Evidence: `toby-f10f11.timeline.json` (các 403).

## F11: Tính năng 0-generation

| Tính năng | Quan sát | Gọi Toby? |
|---|---|---|
| **Tasks** | Tab rỗng → "+ Thêm" mở form "Thêm Task Mới" (tên, prompt + Multi-Prompt, provider/model/ratio/qty, ref, tự tải, 1K). Đã tạo "F11 test task" (Nano Banana 2.1 9:16 x1) → toast "Task đã tạo"; danh sách có nút Song song / Chạy tất cả / công tắc bật-tắt / menu ⋮. **Không chạy**. Task vẫn còn trong tài khoản (xóa tay nếu cần). | `POST /tasks` (201, `task_id: task_<ms>_<hex>`), `GET /tasks`, `GET /tasks/{id}` |
| **Add-to-queue (+)** | Nút "+" cạnh Tạo → toast "Đã lưu batch vào hàng chờ"; panel Lịch sử/Hàng đợi (Flow/Muse/ChatGPT/Gemini): batch "Chờ 0/1" với ▶ + ⋮ (Chạy tiếp theo / Thêm kết quả vào ảnh tham chiếu / Sửa batch / Xoá / Chạy lại batch). Đã xóa batch thử (hộp thoại "Xoá batch gồm 1 prompt?"). Hiển thị toàn bộ lượt chạy hôm nay: F7 "Đã dừng 0/2" (#1 "Đã huỷ", #2 "Bị chặn"). | **Không** — hàng đợi nằm local (không có request Toby) |
| **Templates** (Prompts) | Lưới thẻ + danh mục, thumbnail từ `labs.toby.vn/storage/media`. | `GET /templates`, `/templates/categories`, `/prompts` |
| **Workflow templates** | ~20 thẻ video-workflow (có YouTube, số lượt dùng, số node, rating); "Xem trước" / "Sử dụng template". Không dùng. | `GET /workflow-templates` (≈198 KB), `/workflow-templates/categories` |
| **Style picker** | "Phong cách" trong Gen; không mở sâu. | `GET /addon-prompts`, `/pa-content-formats` |
| **Album / Library** | "Chưa có album nào", "+ Tạo album", tab Ảnh trên Flow / Upload (xem F2). | không |
| **Import .txt** | Có nút "Import .txt" trong khung prompt — em **không thử** (cần file picker). | — |
| **History** | Danh sách lượt chạy, tìm kiếm, yêu thích. | `GET /history`, `POST /history` (sau mỗi lần chạy) |
| **Settings** | Xem đầy đủ ở mục "Tổng hợp UI". Lưu cài đặt = `PUT /settings` {settings_json: inputTimeout 1000, randomDelayMin 5, randomDelayMax 15, queueEnabled, manualSubmitMode, autoDownload, flowApiAutoOpenTrackerGrid, downloadFolder, fileNameTemplate, downloadResolution 1k, videoDownloadResolution 720p, theme, language…}. | `GET/PUT /settings` |
| **Floating tracker** (trên trang Flow) | Hộp nổi "TobyFlow": chip Auto/Manual, đếm "N đã gửi · đang gen · chờ Flow · xong · lỗi", tiến độ %, danh sách prompt với nút tải/xóa/thử lại/dừng; ghi trạng thái "Bị chặn · Chưa gửi" khi chain dừng. Hiển thị banner Flow "Đang tạo nội dung" trong lúc chạy. | không |
| **Prompt Assistant** | Mở modal "Prompt Assistant": chọn nguồn **ChatGPT hoặc Gemini** (chạy qua **tab web ChatGPT/Gemini của chính user**, báo "ChatGPT chưa mở tab · Mở tab"), ô ý tưởng/kịch bản/SRT, thư viện style (Storytelling, Animation, Lifestyle, Education, Relax, Fitness; vài style 👑), Loại (Ảnh/Video), Số lượng (auto), ảnh ref ≤5, "Nâng cao", nút "Tạo prompt". **Không chạy**: ChatGPT chưa đăng nhập (đúng ràng buộc) nên nút bị mờ. Không có bộ đếm credit Toby nào hiển thị. | `GET /pa-content-formats`, `/extension-config/system-config/ai-tools` (chỉ lấy cấu hình) |
| **Notifications / Announcement / Affiliate / Devices** | Chuông: trống; popup "Update TobyFlow v1.3.142"; Affiliate/creator-profile. Thiết bị: `POST /extension-devices/claim` (device_limit null). | `GET /notifications*`, `/announcement`, `/affiliate/creator-profile` |

## Cách TobyFlow điều khiển Flow (tổng hợp)

1. **DOM-driving, không phải native RPC, ở Web Mode.** Với ảnh/video và workflow, TobyFlow (content script trong tab Flow) *gõ prompt vào composer Flow, gắn ref bằng picker "Thêm vào câu lệnh", rồi bấm nút Generate của Flow* (`text_insert` → `editor_verified` → `snapshot` → `reference_final_verify` → `click_ack`). Các RPC Flow (`ogiZ0b`, `YhhmEf`, `eb1hJf`, `nprQif`, `MZZa6b`, `maseQ`, `jwpduf`, `as29s`…) đều do **chính frontend Flow** gửi, kèm token reCAPTCHA Enterprise mới của Flow; TobyFlow chỉ quan sát chúng bằng interceptor MAIN-world (`media-interceptor.js` là Initiator) để ghép request↔prompt (`correlation_armed → request_seen → response_seen → poll_seen → result_seen`). (Max Speed/V2 — khóa Premium — mới là đường RPC trực tiếp; không thử.)
2. **Đính kèm file**: ảnh PNG từ máy → TobyFlow đưa vào input file của Flow (`maseQ`, `FLOW_UPLOAD_SOURCE=FILE_PICKER`, đổi tên `toby_<uuid>.png`, Flow chuyển sang JPEG). Ảnh đã upload ở lần trước được tái dùng (as29s kiểm tra id), không upload lại (F5).
3. **Phát hiện hoàn tất**: ảnh = response đồng bộ của `ogiZ0b` (~10 s); video = `jwpduf` poll 5 s do Flow tự làm, TobyFlow đọc qua interceptor (`correlation_poll_seen` → `correlation_result_seen`, status 3). Lỗi `GENERATION_FILTERED` (status 4) → **tự retry** lên đến `max_retries` (2) mà không tính thêm quota Toby (F5).
4. **Tải về**: `chrome.downloads` từ `flow-content.google/image|video/<id>` (video qua redirect `googlevideo`), tên theo mẫu `[Index]_[Prompt]_[Project]_[Date]`, thư mục `tobyflow_output/<tên thư mục>`; lần đầu Chrome hỏi quyền "Download multiple files" (F1). Workflow dùng thư mục theo tên workflow.
5. **Tuần tự thật**: dù chọn "Song song", Web Mode chạy từng prompt một (cùng 1 composer), nghỉ ngẫu nhiên 5–15 s (F6, F4). Chain = tuần tự bắt buộc (F7, treo).
6. **Báo cho labs.toby.vn**: *trước* khi chạy `POST /execution/request` (cổng quota: `remaining`, `remaining_module`, `remaining_global`, `execution_token` 300–4080 s) → *xong* `POST /execution/complete` (+`refund_count`) → `POST /usage/events` (telemetry vòng đời, kèm prompt_count/has_ref, **không** gửi prompt/ảnh) → `POST /history` (gửi **prompt đầy đủ, model, ratio, id media Flow, thumbnail URL đã ký của Flow**). Nền: `events/poll` (~30 s), `mcp|telegram/executor-heartbeat` (~45 s), `usage/heartbeat`, `usage/sync-daily`, `extension-config/*` (selector DOM, api-configs, provider-models), `entitlements`. SSE realtime bị 403 `SSE_REQUIRES_PAID` trên Free. Workflow còn dùng server làm kế hoạch (`/workflows/{id}/execute`) và lưu đồ thị. Quota Free: 20 lượt chạy/ngày theo module (đã dùng 2 trước phiên; mỗi lần "Chạy" = 1 lượt, kể cả multi-prompt; workflow = 1 lượt).

## Việc chưa làm / hạn chế

- **Không capture được DevTools của service worker** (chỉ có DevTools của sidebar.html; `background.js` fetch hiện trong đó nên Toby calls vẫn đầy đủ, nhưng không thấy gọi từ các context khác). Không đổi Developer mode.
- F7 (chain) treo sau video 1 → chưa thấy cách trích khung cuối. F10 không chạy (khóa/ không mở được panel Angles/Effects). Import .txt, Style picker, Templates "Sử dụng template", Album tạo mới, Xóa watermark/Cắt video: chỉ xem, không chạy.
- Dropdown model trong node Workflow bị cắt đáy cửa sổ, không chọn được Lite.
