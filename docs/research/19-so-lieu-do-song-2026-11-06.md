# 19. Số liệu đo sống — TobyFlow 1.3.142 trên Google Flow (06/11/2026)

Chương này chỉ ghi **số đo được**; diễn giải xem [chương 18](18-flow-live-1-3-142.md). Môi trường: Chrome Profile 2, gói Toby **Free**, Flow **Web Mode**, điều khiển bằng XTEST trên màn hình `:10`. Giờ ghi theo **+07**. Số liệu lấy từ timeline HAR đã lọc, phản hồi API và `ffprobe`/`sha256sum` của file tải về.

Nguồn: [lượt video đầu](../tobyflow/evidence/live-2026-11-06-video-frames/LEDGER.md) · [quét F1–F11](../tobyflow/evidence/live-2026-11-06-features/LEDGER.md) · timeline `f*.timeline.json` / `toby-*.timeline.json` trong cùng thư mục.

## 1. Tổng chi tiêu

| Chỉ số | Giá trị |
|---|---|
| Lượt bấm Chạy tính quota Toby (`execution/request`) | 11, gồm lượt video đầu và 1 lượt bấm nhầm |
| Lần gửi lệnh tạo lên Flow | 14: 8× `ogiZ0b`, 1× `YhhmEf`, 2× `eb1hJf`, 1× `nprQif`, 2× `MZZa6b` |
| Lần tạo ra media | 13; 1 lần bị lọc (`AUDIO_GENERATION_FILTERED`) |
| File tải về | 12; video chain thứ nhất có trên Flow nhưng không được tải |
| Credit Flow | 1028 → 978 (−50) |
| Quota Toby `remaining` (module, 20/ngày) | 18 → 9 |
| Quota Toby `remaining_global` (100) | 98 → 88 |

## 2. Từng lượt

| # | Tính năng | Model / key | Bấm Chạy | RPC tạo (giờ gửi) | Xong | Chạy → xong | Credit Flow sau |
|---|---|---|---|---|---|---|---|
| 0 | Video khung đầu | Veo 3.1 Lite / `veo_3_1_i2v_lite` | 00:34:31 | `maseQ` 00:34:32 → `eb1hJf` 00:34:46 | 00:35:25 | ≈54 s (tạo 39 s) | 1028 |
| F1 | Ảnh từ text | Nano Banana 2 Lite / `HARBOR_SEAL` | 00:53:31 | `ogiZ0b` 00:53:35 | 00:53:45 | 14 s (item 11,3 s) | 1028 |
| F2 | Ảnh + 1 ảnh tham chiếu | `HARBOR_SEAL` | 00:57:14 | `maseQ` 00:57:15 → `ogiZ0b` 00:57:28.6 | 00:57:39 | 25 s (+5 s tải) | 1028 |
| F3 | Video từ text (Ingredients, 0 ref) | `veo_3_1_t2v_lite` | 01:00:56 | `YhhmEf` 01:01:00 | 01:01:45 | 49 s (tạo 44 s) | 1018 |
| F4 | Video START+END | `veo_3_1_interpolation_lite` | 01:04:45 | `maseQ` 01:04:46 → `maseQ` 01:05:00 → `nprQif` 01:05:13 | 01:05:58 | 73 s (tạo 44 s) | 1008 |
| F5 | Video Ingredients, 2 ref | Veo 3.1 Fast / `veo_3_1_r2v_fast_portrait` | 01:07:31 | `MZZa6b` 01:07:35 (bị lọc) → `MZZa6b` 01:08:12.6 (tự retry) | 01:08:48 | 77 s | 988 |
| F6 | Multi-Prompt 3 ảnh | `HARBOR_SEAL` | 01:10:50 | `ogiZ0b` 01:10:53.0 / 01:11:04.3 / 01:11:19.4 | 01:11:29 | 39 s | 988 |
| F7 | Chain 2 video từ khung cuối | `veo_3_1_i2v_lite` | 01:14:17 | `maseQ` 01:14:19 → `eb1hJf` 01:14:33 | video 1: 01:15:17; **treo**, dừng tay sau >6 phút | — | 978 |
| x | Ảnh (bấm nhầm) | `HARBOR_SEAL` | 01:21:57 | `ogiZ0b` 01:22:01 | 01:22:10 | 13 s | 978 |
| F8 | Manual submit (ảnh) | `HARBOR_SEAL` | 01:23:28 | `ogiZ0b` 01:23:55.6, do người bấm Enter | 01:24:05 | 10 s sau Enter | 978 |
| F9 | Workflow Text→Flow→Download | Nano Banana 2.1 | 01:29:15 | `ogiZ0b` 01:29:25 | 01:29:56 | 41 s | không đo |

## 3. Chi phí credit Flow theo chế độ

| Chế độ | Credit / lượt | Cách đo |
|---|---|---|
| Ảnh Nano Banana 2 Lite (có hoặc không ref) | 0 | Số dư không đổi qua F1, F2, F6, x |
| Video Veo 3.1 Lite (text, khung đầu, START+END) | 10 | 1028→1018 (F3), →1008 (F4), 988→978 (F7) |
| Video Veo 3.1 Fast + ref | 20 | 1008→988 (F5). Lần bị lọc được hoàn credit: `nzlxg` vẫn 1008 trước lần retry |
| Lượt video đầu | ≈10 (suy ra) | Số dư sau lượt = 1028; số dư trước lượt không thu |

Số dư nằm ở trường `[1]` của phản hồi các RPC tạo video và `jwpduf`. RPC `nzlxg` cũng trả số dư.

## 4. Nhịp và trạng thái

| Đo | Giá trị |
|---|---|
| Chu kỳ poll video `jwpduf` | 5,0 s (F3: 9 lần trong 40 s) |
| Thời gian Flow tạo 1 video Veo Lite 8 s | 39–44 s (n=5) |
| Thời gian Flow trả 1 ảnh Nano Banana | ≈10–11 s; trả đồng bộ, không poll |
| Mã trạng thái video | `6` vừa gửi → `2` đang tạo → `3` xong; `4` = lỗi (kèm `…GENERATION_FILTERED`) |
| Retry tự động sau lỗi lọc (F5) | gửi lại sau ≈0,2 s xử lý + 2,3 s presubmit |
| Khoảng cách giữa các bước upload/submit có nghỉ | 12,8–14,3 s (F4, F7); khoảng nghỉ cài đặt "Chống ban" 5–15 s |
| Khoảng cách giữa các prompt Multi-Prompt (F6) | 11,3 s và 15,1 s giữa các lần gửi; vẫn tuần tự dù đã chọn "Song song" |
| `click_ack` → request Flow ra | ≈0,5 s (F1) |
| Toby `execution_token` hết hạn sau | 300 s (1 prompt) · 645 s (3 prompt) · 930 s (chain 2 prompt) · 4080 s (workflow) |

## 5. Quota Toby (giá trị server trả ở `execution/request`)

| Lượt | action | prompt_count | remaining | remaining_global |
|---|---|---|---|---|
| F1 | generate | 1 | 18 | 98 |
| F2 | generate | 1 | 17 | 97 |
| F3 | generate | 1 | 16 | 96 |
| F4 | generate | 1 | 15 | 95 |
| F5 | generate | 1 | 14 | 94 |
| F6 | generate | 3 | 13 | 91 |
| F7 | generate | 2 | 12 | 89 |
| x | generate | 1 | 12 | 90 |
| F8 | generate | 1 | 11 | 89 |
| F9 | workflow_run | 1 | 9 | 88 |

Ghi chú:
- `remaining` giảm 1 mỗi lượt, kể cả multi-prompt.
- `remaining_global` giảm theo số prompt (F6 −3, F7 −2).
- Sau khi dừng tay F7, lượt x có `remaining` không đổi và `global` tăng 1. Có thể F7 được hoàn lượt, nhưng chưa kiểm.
- F8→F9 `remaining` giảm 2 dù chỉ có 1 lượt Chạy. Chưa giải thích được.
- `execution/complete` của mọi lượt hoàn tất trả `refund_count: 0`.

## 6. File tải về

| File | Byte | sha256 (16 ký tự đầu) | Định dạng |
|---|---|---|---|
| `001_The_red_paper_boat_drifts_slowly_to_the_…mp4` (lượt 0) | 1 256 130 | `7a44282c7850ac3f` | h264 720×1280, 7,93 s |
| `001_A_small_yellow_rubber_duck_…jpg` (F1) | 87 957 | `0ac13215c1599679` | JPEG 768×1376 |
| `001_Turn_the_reference_into_a_cheerful_sun_…jpg` (F2) | 66 664 | `ebedb7ac606a0fe2` | JPEG 768×1376 |
| `001_A_paper_kite_floats_slowly_…mp4` (F3) | 1 721 774 | `3bb7e523dadbe904` | h264 720×1280, 7,93 s |
| `001_The_red_paper_boat_drifts_across_blue_wa…mp4` (F4) | 1 117 443 | `644e94d60e4aacec` | h264 720×1280, 7,93 s |
| `001_A_red_paper_boat_and_a_green_tree_icon_…mp4` (F5) | 1 088 362 | `972e4c13ece033fa` | h264 720×1280, 7,93 s |
| `001_A_single_red_apple_…jpg` (F6) | 31 611 | `e86fb2658c1f3c61` | JPEG 768×1376 |
| `002_A_blue_bicycle_…jpg` (F6) | 152 804 | `0679766be9044292` | JPEG 768×1376 |
| `003_A_small_green_cactus_…jpg` (F6) | 56 826 | `03cb40278d2ef7be` | JPEG 768×1376 |
| `001_A_tiny_orange_fox_…jpg` (x) | 191 659 | `3bdf2d77440e838d` | JPEG 768×1376 |
| `001_A_small_purple_umbrella_…jpg` (F8) | 148 637 | `e7de9e728a453cd3` | JPEG 768×1376 |
| `Workflow_moi_-_6_11_2026/Auto Download_A small blue teapot….jpeg` (F9) | 145 724 | `4031940314e506c3` | JPEG 768×1376 |

- Thư mục: `~/Downloads/tobyflow_output/tobyflow-01/`; riêng F9 lưu ở thư mục theo tên workflow.
- Ảnh 9:16 tải về ở 768×1376; video 720p là 720×1280, kèm AAC.
- Kích thước video mà Flow báo trong `jwpduf`/`as29s` khớp đúng từng byte với file tải (đo ở lượt 0).
- Ảnh upload PNG 720×1280 được Flow lưu thành JPEG; tên upload dạng `toby_<uuid>.png`.

## 7. Phạm vi và giới hạn của số đo

- n=1 cho mỗi chế độ (video Lite có n=5). Thời gian phụ thuộc tải của Flow lúc đo.
- Chưa đo: Veo Quality, Omni Flash, Nano Banana Pro/2.1 (credit), độ phân giải 1080p/4K, quantity >1.
- F7 không có số kết thúc. F10 (Studio) bị khoá 403 nên không có số.
- Các cuộc gọi Toby thu qua DevTools side panel; service worker không mở được.
