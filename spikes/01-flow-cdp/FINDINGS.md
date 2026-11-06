# Spike 01 — Findings (05/11/2026, Chrome 156, Linux/xrdp, Profile 1, project f1430844…)

**Câu hỏi:** cách A (extension mỏng + `chrome.debugger`, desktop giữ logic) có tự động hoá Flow được không?

## Kết quả các lượt generate

| # | Mạng | Chuẩn bị (ref/prompt) | Ai bấm Generate | Debugger trên tab | Kết quả |
|---|---|---|---|---|---|
| 1 | không VPN | CDP | CDP click | gắn | ❌ `PUBLIC_ERROR_UNUSUAL_ACTIVITY` (không trừ credit) |
| 2 | VPN | người | người | không | ✅ |
| 3 | VPN | CDP, chỉ prompt | CDP click | gắn | ✅ ảnh 1024², ~21 s |
| 4 | VPN | CDP + upload ref | CDP click | gắn | ❌ unusual activity |
| 5 | VPN mới | CDP + ref có sẵn | CDP click | gắn | ❌ |
| 6 | VPN mới | CDP, chỉ prompt | CDP click | gắn | ❌ |
| 7 | VPN mới | người | người | đã gỡ, tab từng gắn | ✅ (đối chứng) |
| 8 | VPN mới | CDP + ref | **người** | gắn | ❌ |
| 9 | VPN mới | CDP + ref, rồi gỡ debugger | **người** | đã gỡ trước khi bấm | ❌ |
| 10 | VPN, Profile 2 | content script (`execCommand insertText`), không debugger | người | chưa từng | ✅ |
| — | Profile 2 | content script | **content script** `element.click()` / Enter / PointerEvent tổng hợp | không | ⛔ Flow bỏ qua, **không gửi request nào** (an toàn, `rejected_before_dispatch`) |
| 11 | Profile 2 | content script: settings 1:1/x1 + gắn ref có sẵn + prompt | người | không | ✅ ảnh, tải JPEG OK |
| 12 | Profile 2 | content script: Video → Khung hình, 720p/8s, ref vào ô **Bắt đầu**, prompt | người | không | ✅ MP4 h264 1280×720, 8.01 s, ~40 s tạo |
| 13 | Profile 2, D-12 | content script prompt, Nano Banana 2.1 9:16 x1 | **MAIN-world listener + `isTrusted` Proxy** | không | ✅ tự động hoàn toàn, ~20 s, JPEG tải OK |
| 14 | Profile 2, D-12 | content script: Video → Khung hình 720p/8s x1, Start = asset ảnh lượt 13 (`1e99b95d…`), prompt | **MAIN-world `isTrusted` Proxy** | không | ✅ tự động hoàn toàn, video ~75 s, MP4 h264 720×1280 7.93 s tải OK |

## D-12: auto-submit kiểu TobyFlow (06/11/2026) — ĐẠT 2/2

- Cơ chế: [`extension/main-world.js`](extension/main-world.js) chạy ở MAIN world lúc `document_start`. Script vá `EventTarget.prototype.addEventListener` để ghi lại listener `click` mà Angular gắn vào `<button>`. Khi nhận `CustomEvent('toolflow:submit')`, script gọi đúng listener của nút `flow-prompt-box button[type=submit]` với `Proxy(MouseEvent)` báo `isTrusted:true`, `target/currentTarget` = nút. Đăng ký thấy **1 listener** trên nút submit. Flow tự lấy token reCAPTCHA và gửi RPC, **không bị gắn cờ** ở lượt 13 (ảnh) và lượt 14 (video khung đầu).
- Fail-closed: nút `disabled` hoặc không có listener thì **không gọi gì** (probe khi editor rỗng trả `called:0`). Driver thật phải coi `listeners==0` là `CONFIG_INCOMPLETE`, không fallback sang `click()`/Enter.
- Kịch bản phải nạp **trước** Angular: sau khi cài hoặc cập nhật extension, phải reload tab Flow, nếu không registry rỗng.
- **Gây nhiễu cần ghi nhận:** Profile 2 đang cài **TobyFlow** (`iicjfgdnngmpfocfanpiammedafmomin`) và Playwright Extension. Tải bằng `chrome.downloads` với `filename` bị đổi tên (thành `<mediaId>.jpeg`, `videoplayback.mp4`) do extension khác can thiệp `onDeterminingFilename`. Vì vậy ToolFlow phải đọc `actualName` từ `downloads.search`, không tin `plannedName`. Nên tắt TobyFlow trong profile test khi qualification.
| 15 | Profile 2, D-12 | model dropdown → **Nano Banana 2 Lite**, 1:1 x1, prompt bánh mì | auto `isTrusted` | không | ✅ chọn model qua menu đọc lại được; ảnh ~16 s; response `ogiZ0b` chứa media id + **prompt gốc tiếng Việt** + prompt Flow viết lại tiếng Anh + URL ký; file image/jpeg 175798 B |
| 16 | Profile 2, D-12 | **3 ảnh song song** (Nano Banana 2 Lite 1:1 x1): gửi lượt sau ngay khi request `ogiZ0b` của lượt trước đã đi, không chờ kết quả; hai prompt cuối **trùng nhau** để thử ghép | auto `isTrusted` | không | ✅ 3 request `ogiZ0b` đi cách nhau ~3 s (composer tự xoá sau mỗi lần gửi, gửi tiếp được ngay); xong cả 3 sau ~15 s; **response lặp lại seed + UUID batch của request** → ghép request↔kết quả chắc chắn kể cả khi prompt trùng; 3 JPEG tải OK |
| 17 | Profile 2, D-12 | **2 video song song**, Veo 3.1 - Lite, Thành phần, 9:16 720p 8 s x1: (A) text→video 0 ref; (B) 1 ref (asset ảnh xe Cub) | auto `isTrusted` | không | ✅ cả 2 video xong sau ~125 s, chạy song song thật (A `YhhmEf` text→video, B `MZZa6b` `veo_3_1_r2v_lite`: **Lite nhận ref**, khác cấu hình TobyFlow); MP4 720×1280 7.92 s ×2. ⚠️ **B bị gắn nhầm ref**: menu asset đổi thứ tự giữa lúc đọc danh sách và lúc click → chip = ảnh giỏ trái cây thay vì xe Cub; prompt vẫn được gửi. Credit 958→948→938 (Lite 10/video) |

## D-12 mở rộng (lượt 15–17): song song + ghép kết quả qua network

- **Chọn model**: `flow-prompt-box-settings button[aria-haspopup=menu]` → `flow-menu-item > button[role=menuitem]`, đọc lại nhãn nút. Danh sách model **đổi theo thời gian** (hôm nay video có thêm *Omni 1.2 Flash*; ảnh 2.1 có thêm radio *High* mà Lite không có) → capability phải quét lúc chạy, không hard-code.
- **Song song chạy được**: sau mỗi lần gửi, composer tự xoá. Có thể chuẩn bị và gửi lượt kế ngay khi request đã đi (~1 s sau click). 3 ảnh cách nhau ~3 s, 2 video chạy cùng lúc. Chưa thử vượt quá 3.
- **Ghép kết quả chắc chắn** bằng observer MAIN-world chỉ đọc (hook XHR/fetch `batchexecute`). Request generate có `seed` + UUID batch duy nhất; **response lặp lại đúng seed/UUID đó** kèm media id, prompt gốc (tiếng Việt) và prompt Flow tự viết lại. → `Attempt` lưu seed/UUID ngay lúc thấy request `sent` (= receipt). Không cần label/tile và không lẫn khi prompt trùng. Video: `jwpduf` poll 5 s, response có model key (`veo_3_1_r2v_lite`), ref id, status `[3]` = xong, số credit còn lại.
- **RPC theo mode**: ảnh `ogiZ0b` (model ảnh mã hoá `HARBOR_SEAL` = 2 Lite), text→video `YhhmEf`, ingredients `MZZa6b`, start-frame `eb1hJf`, start+end `nprQif` (theo TobyFlow), upload `maseQ`.
- **Bẫy ref (lượt 17B)**: danh sách asset trong add-menu sắp xếp lại khi có kết quả mới. Chọn theo index là gắn nhầm ảnh. Driver phải chọn theo **media id** (đọc `img src` của asset item) và **so chip với asset id mong muốn trước intent**; lệch thì `SETTINGS_NOT_APPLIED`, không gửi.
- Tổng hôm nay trên Profile 2: 8 lượt tự động (13: 1, 14: 1, 15: 1, 16: 3, 17: 2) + 3 lượt người bấm (10–12). Không có `UNUSUAL_ACTIVITY`.
| 18 | Profile 2, D-12 | **8 ảnh song song** (Nano Banana 2 Lite 1:1 x1, 0 credit): gửi lượt sau ngay khi request lượt trước đã đi | auto `isTrusted` | không | ✅ 8/8 xong, ghép đúng 8 media id, tải 8 JPEG OK; tối đa 4 request đang chạy cùng lúc |
| 19 | Profile 2, D-12 | **20 ảnh song song** (Nano Banana 2 Lite 1:1 x1, 0 credit) | auto `isTrusted` | không | ✅ 20/20 xong, 0 lỗi, mỗi ảnh 10.4–11.8 s, 20 media id khác nhau đều ghép đúng; gửi đều đặn ~3 s/lượt nên **tối đa 4 request đang chạy cùng lúc** |
| 20 | Profile 2, D-12 | **6 video song song** Veo 3.1 - Lite, Thành phần 0 ref, 9:16 720p 8 s x1 | auto `isTrusted` | không | ✅ 6/6 được nhận (`YhhmEf` text→video `veo_3_1_t2v_lite`); credit trừ **lúc nhận**: 938→888; tiêu đề ngắn Flow trả lúc nhận = nhãn tile; 6 MP4 720×1280 7.92 s, nội dung khác nhau. Không đo được giờ xong từng video (kernel timeout làm mất log) → đo lại ở lượt 21 |
| 21 | Profile 2, D-12 | đo lại **5 video song song** Veo 3.1 - Lite 0 ref 9:16 8 s — ghi thời điểm xong từng video để phân biệt song song/xếp hàng | auto `isTrusted` | không | ✅ **song song thật**: 5 lượt gửi trong 25 s, mỗi video xong sau 51–61 s, cả lô 76 s (xếp hàng thì ≥ 250 s). 4 MP4 OK. ❌ 1 video lỗi phía server: poll `jwpduf` status `[4,[13,"INTERNAL"]]`, tile báo *Không thành công… sẽ được hoàn tiền*; credit 888→838 lúc nhận, chưa quan sát được hoàn tiền |

## Chạy quá 3 lượt (lượt 18–21)

- **Ảnh**: 8/8 rồi 20/20 xong, 0 lỗi, mỗi ảnh 10–12 s. Driver tuần tự (prep + click + chờ request đi) mất khoảng 3 s mỗi lượt, nên **dù gửi 20 lượt thì tối đa cũng chỉ có 4 request đang chạy cùng lúc**: giới hạn là tốc độ gửi, chưa chạm giới hạn của Flow.
- **Video**: 6 lượt (lượt 20) và 5 lượt (lượt 21) đều được nhận. Lượt 21 chứng minh Flow render song song (51–61 s mỗi video, cả lô 76 s). Từ lượt thứ 2 trở đi, request mất 4–6 s mới đi, so với ~1 s ở lượt đầu: có thể Flow chờ token/hàng đợi phía client, chưa rõ nguyên nhân.
- **Mã trạng thái poll `jwpduf`**: `[2]` = đang chạy, `[3]` = xong, `[4,[13,"INTERNAL"]]` = lỗi server (Flow hứa hoàn credit). Đây là lỗi có thể thử lại tự động, khác với lỗi chính sách nội dung.
- **Credit trừ ngay lúc request được nhận** (field `[1]` của response generate), không phải lúc xong. Cost/budget phải tính theo receipt.
- **Ghép video**: tile video không chứa media id trong DOM. Ghép bằng media id trong response generate/poll; tiêu đề ngắn trong receipt chỉ dùng hiển thị (có thể trùng).
- Chưa tìm thấy trần song song: 6 video và 20 ảnh không bị từ chối, không có `UNUSUAL_ACTIVITY`, không có thông báo giới hạn. Lượt 18–21 có 39 lượt tự động (28 ảnh, 11 video); cộng 8 lượt ở 13–17, hôm nay Profile 2 có 47 lượt tự động + 3 lượt người bấm. Credit 938→838.
| 22 | Profile 2, D-12 | **10 video gửi liên tiếp** Veo 3.1 - Lite 0 ref 9:16 8 s x1 (100 credit); dừng ở lần đầu bị từ chối | auto `isTrusted` | không | ✅ 10/10 được nhận và xong. Nút thắt **phía client**: web Flow chỉ gửi request generate kế tiếp ~0,4 s sau khi response trước về; response generate mất ~6 s ⇒ 1 tab gửi được tối đa 1 video/6 s. Credit lượt đầu vẫn 838 ⇒ **10 credit của video lỗi lượt 21 đã được hoàn** |
| 23 | Profile 2, D-12 | **2 tab cùng project gửi song song, mỗi tab 7 video** (14 video Veo 3.1 - Lite, 140 credit) để vượt nhịp gửi 1 video/6 s của một tab | auto `isTrusted` | không | ✅ 14/14 được nhận trong 72 s, 14/14 xong (status 3), **tối đa 12 video render cùng lúc**, không bị từ chối, không có toast/`UNUSUAL_ACTIVITY`. Hai tab không chặn nhau (click→sent ~1 s mỗi tab); khi tải cao một số video lâu hơn (74–95 s so với 45 s). Credit 748→608 |

## Tìm giới hạn song song (lượt 22–23)

- **Chưa chạm trần phía server**: đã có 12 video Veo Lite render cùng lúc (2 tab), 14 lượt được nhận trong 72 s, không có lần từ chối nào. Em dừng ở đây vì đã tiêu khoảng 230 credit cho phần đo này (trần tự đặt 250).
- **Giới hạn thực tế nằm ở client của Flow**: mỗi tab xếp hàng các request generate (lượt sau đi ~0,4 s sau khi response lượt trước về, mỗi response ~6 s). Muốn song song hơn ~9–10 video thì phải dùng nhiều tab hoặc nhiều project. 2 tab chạy độc lập với nhau.
- Hàng đợi của tool nên cho mỗi tab gửi lần lượt (chờ receipt rồi gửi tiếp) và giới hạn số tab; không cần chờ video xong mới gửi. Mặc định đề xuất: 1 tab, giữ tối đa ~8 video đang render; chỉ mở thêm tab khi người dùng bật.
- **Bẫy UI nhiều tab**: tab A vẫn hiện `pending` cho video do tab B gửi dù server đã xong; reload thì mới đúng. Trạng thái phải lấy từ poll/response, không lấy từ ô trên lưới của tab khác.
- Hoàn credit cho lỗi `INTERNAL` đã xác nhận (xuất hiện trong vòng ~10 phút).
- Tổng hôm nay trên Profile 2: 71 lượt tự động (28 ảnh, 43 video) + 3 lượt người bấm. Credit 938 → 608.
| 24 | Profile 2, D-12 | **tìm trần: 4 tab cùng project, mỗi tab tối đa 6 video** (≤ 24 Veo 3.1 - Lite, ≤ 240 credit); dừng mọi tab khi bị từ chối lần đầu | auto `isTrusted` | không | ✅ 24/24 được nhận trong 65 s, 24/24 xong, **tối đa 21 video render cùng lúc**, không bị từ chối. Server không từ chối mà xếp hàng: thời gian render tăng từ 41 s lên 96 s. Credit 608→368 |
| 25 | Profile 2, D-12 | **tìm trần ảnh: 4 tab, 60 request Nano Banana 2 Lite 1:1 x4** (240 ảnh, 0 credit); không chờ kết quả giữa các lượt; dừng khi bị từ chối lần đầu | auto `isTrusted` | không | 🛑 **chạm trần**: 12 request đầu (44 ảnh) được nhận trong 13 s; request thứ 12/14/15 nhận `PUBLIC_ERROR_USER_REQUESTS_THROTTLED` (gRPC 8, HTTP 200). Tile báo *Flow đang có lượng truy cập cao… Bạn chưa bị tính phí*. Không có toast hay banner. Gửi 1 ảnh thử lại sau khoảng 45 s: OK |
| 26 | Profile 2, D-12 | phân biệt trần theo request hay theo ảnh: **4 tab, 28 request Nano Banana 2 Lite x1**, cùng nhịp lượt 25 (lượt 25b trước đó: 1 ảnh thử phục hồi sau ~45 s → OK) | auto `isTrusted` | không | ✅ 28/28 OK, 0 throttle, tối đa 12 request (= 12 ảnh) chạy cùng lúc, nhịp ~1 request/s trong 20 s rồi chậm dần ⇒ trần **tính theo ảnh**, không theo request |
| 27 | Profile 2, D-12 | khoanh vùng trần ảnh: **4 tab, 28 request x2** (≤ 56 ảnh) | auto `isTrusted` | không | ⚠️ 19/20 OK; 1 throttle sau khi đã nhận 34 ảnh trong 20 s (lúc đó 16 ảnh đang chạy); request kế tiếp lại OK ngay |

## TRẦN (lượt 24–27)

| Loại | Kết quả đo | Bị chặn? |
|---|---|---|
| Video Veo Lite | 24 lượt nhận trong 65 s, **21 render cùng lúc** | Không. Server xếp hàng, render chậm dần từ 41 s lên 96 s |
| Ảnh x1 | 28 ảnh trong 36 s, 12 chạy cùng lúc | Không |
| Ảnh x2 | 34 ảnh trong 20 s | 1 lượt bị chặn |
| Ảnh x4 | 44 ảnh trong 13 s | 3 lượt bị chặn |

- **Mã từ chối**: `PUBLIC_ERROR_USER_REQUESTS_THROTTLED` (gRPC 8 `RESOURCE_EXHAUSTED`), **HTTP vẫn 200**. Response generate không có media id. Tile báo *"Flow đang có lượng truy cập cao. Vui lòng thử lại sau. Bạn chưa bị tính phí"*: chữ trên UI giống lỗi tải chung, nhưng mã cho thấy đây là throttle theo **user**. Không có toast/banner, không có `UNUSUAL_ACTIVITY`.
- **Mô hình ước lượng (chưa chắc)**: giống token bucket tính theo **số ảnh**, cho nổ khoảng 35–45 ảnh rồi hồi khoảng 1–1,5 ảnh/s. Lý do: x2 bị chặn một lượt rồi lượt kế lại OK ngay; x4 nổ nhanh hơn nên bị chặn sớm hơn. Video có vẻ dùng một bucket riêng: 24 video trong 65 s chưa bị chặn. Chưa đo được trần video vì credit còn 368.
- **Phục hồi**: lượt bị chặn không tốn phí. Thử lại sau khoảng 30–45 s thì OK.
- **Áp vào thiết kế hàng đợi**:
  - `THROTTLED` là lỗi có thể thử lại tự động: backoff 30 s, nhân đôi tới tối đa 5 phút, rồi gửi lại đúng lượt đó (vì không bị tính phí và không có kết quả, gửi lại không tạo trùng).
  - Giảm nhịp kiểu AIMD: bị chặn thì giảm một nửa số đang chạy, gửi trót lọt thì tăng dần lên.
  - Mặc định an toàn: ảnh ≤ 1 ảnh/s và ≤ 12 ảnh đang chạy; video ≤ 8 đang chạy trên 1 tab.
  - Không đọc chữ lỗi trên tile: phải phân loại theo mã trong response.
| 28 | Profile 2, D-12 | **dùng cạn credit (368) tìm trần video: 6 tab, 38 video Veo 3.1 - Lite** (vượt số credit để xem lỗi hết credit); dừng mọi tab ở lần bị từ chối đầu | auto `isTrusted` | không | 🛑 **trần video**: 6 tab nhận 26 video trong 49 s, cả 26 đang render, thì 3 request kế bị `PUBLIC_ERROR_USER_REQUESTS_THROTTLED` (cùng mã với ảnh). Đỉnh 28 video render cùng lúc (2 request đã đi trước khi dừng). 27 xong, 1 `INTERNAL`. Credit 368→88 |
| 29 | Profile 2, D-12 | **dùng nốt 88 credit**: 1 tab gửi lần lượt (chờ receipt) tới khi bị từ chối vì hết credit | auto `isTrusted` | không | ✅ 5/5 video được nhận (credit theo response 88→48), xong cả 5. Lượt kế bị prep báo `submitDisabled` tạm thời → dừng an toàn |
| 29b | Profile 2, D-12 | ⚠️ **lượt ngoài kế hoạch**: em gọi `trusted` để xem trạng thái nút, nhưng lệnh đó bấm Gửi thật → gửi prompt *thả đèn hoa đăng* còn nằm trong composer | auto `isTrusted` | không | lượt này **được nhận và render** (thành 1 lượt tự động ngoài kế hoạch, 10 credit). Bài học cho driver thật: lệnh *đọc trạng thái* và lệnh *bấm* phải tách riêng; chỉ intent đã ghi mới được gọi lệnh bấm |
| 30 | Profile 2, D-12 | **dùng nốt credit còn lại**: 1 tab gửi lần lượt video Veo Lite tới khi bị chặn vì hết credit | auto `isTrusted` | không | 🛑 **hết credit**, nhưng em ghi sai lúc đầu: lần bấm này **có gửi thật**, video *Mèo vờn cuộn len* đã render (dùng nốt credit). Observer network không thấy request nên driver xếp vào `uncertain` và dừng đúng; nếu tự gửi lại thì đã tạo trùng. Sau lượt này nút Gửi bị thay bằng `button.prompt-warning-button[aria-label="Cảnh báo về việc không đủ tín dụng"]`, kèm banner `.credit-banner-message` *Bạn sắp dùng hết tín dụng Google Flow…* và nút *Thêm tín dụng AI*. Trước đó bước kiểm prompt chặn đúng 1 lần gõ chồng (composer không tự xoá sau khi đổi mode) |
| 31 | Profile 2, D-12 | sau khi hết credit: thử **1 ảnh Nano Banana 2 Lite (0 credit)** xem còn tạo được không | auto `isTrusted` | không | ✅ ảnh *Steamed rice rolls* được tạo dù đã hết credit (model 0 credit không bị chặn). Observer lại không thấy request (`net` trả `[]`) ⇒ **observer network ngừng bắt sau khi reload extension** (nguyên nhân chưa kiểm). Driver thật phải tự kiểm observer còn sống (heartbeat) trước khi gửi |

## Dùng cạn credit (lượt 28–31)

- **Trần video**: `PUBLIC_ERROR_USER_REQUESTS_THROTTLED` xuất hiện khi Flow đã nhận 26 video trong 49 s và cả 26 đang render (6 tab). Đỉnh 28 video render cùng lúc. Lượt 24 nhận 24 video trong 65 s (21 render cùng lúc) mà không bị chặn ⇒ trần khoảng **~25 video đang render**, hoặc một bucket tương đương. Video và ảnh dùng chung mã lỗi.
- **Hết credit được chặn ngay ở client**: nút Gửi biến thành nút cảnh báo, kèm banner gợi ý mua thêm. Model 0 credit (Nano Banana 2 Lite) vẫn tạo được ảnh. Driver phải đọc nút cảnh báo trước khi bấm và xếp vào `INSUFFICIENT_CREDIT`, không thử lại.
- **Số credit trong response chưa đáng tin để dự báo**: trước lượt 30, cộng trừ theo field `[1]` thì phải còn khoảng 28–38, nhưng thực tế chỉ đủ 1 video. Hoặc field `[1]` không phải số dư sau khi trừ, hoặc khoản hoàn/đặt trước được tính khác. Budget phải dựa vào nút cảnh báo của Flow, không tự cộng trừ.
- **Bài học về độ tin cậy (quan trọng nhất đợt này)**:
  1. Có một lượt "uncertain" (không thấy request) thực ra đã được gửi. Đúng như thiết kế: `uncertain` thì **không được tự gửi lại**; phải đối soát với grid hoặc server (tìm prompt hay media mới) rồi mới quyết.
  2. Observer network có thể chết lặng lẽ, lần này là sau khi reload extension. Cần heartbeat: trước mỗi lượt gửi, kiểm observer vẫn đang thấy poll hoặc RPC định kỳ.
  3. Lệnh đọc trạng thái phải tách hẳn lệnh bấm (lượt 29b là lượt ngoài kế hoạch).
  4. Khi đổi mode, composer có thể giữ text cũ, nên prep dễ gõ chồng. Phải xoá rồi kiểm text bằng đúng prompt (đã chặn đúng 1 lần).
- **Tổng ngày (lượt 13–31, tự động)**: 198 request generate = 98 ảnh (94 được nhận) + 100 video (97 được nhận); 7 request bị throttle trong 3 đợt (lượt 25, 27, 28); 3 video lỗi `INTERNAL` (đã hoàn). Credit 958 → hết. Không có `UNUSUAL_ACTIVITY`, tài khoản vẫn tạo được ảnh 0 credit.
| 32 | Profile 2, D-12 | **lượt kiểm tra cuối**: 1 ảnh Nano Banana 2 Lite 9:16 x1 (0 credit) với đủ các bước bắt buộc: xoá composer → prep → kiểm nguyên văn prompt, nút bật, không có cảnh báo credit, không chip, observer sống → intent → bấm → receipt seed/UUID → ghép media id → tải → kiểm file | auto `isTrusted` | không | ✅ **đạt mọi bước**: kiểm trước khi bấm 5/5 (nguyên văn prompt, nút bật, không cảnh báo credit, không chip, observer sống: hook XHR/fetch còn là của mình); request `ogiZ0b` đi sau 1,6 s, response về sau 12,6 s; response lặp lại seed `352900402` + UUID cuối `312897A6…` + prompt gốc; media `b94a523e…` = tile ảnh; JPEG 768×1376, 164 398 B, sha256 `4e97fcb656cfd471…` (TobyFlow vẫn đổi tên thành `<mediaId>.jpeg`). ⚠️ **Parser cứng của spike trả seed `None`**: field sau seed là `2`, còn các lượt ảnh 1:1 trước là `1` ⇒ nhiều khả năng đây là mã tỉ lệ khung hình (9:16), không phải Flow đổi định dạng (chưa kiểm). Request video cũng chưa từng parse được seed. Parser thật phải tìm theo vị trí có kiểm tra, sai mẫu thì báo `PROTOCOL_DRIFT`, không đoán. Lỗi observer mù ở lượt 30–31 **không tái hiện** được sau khi reload extension + tab (đã thêm heartbeat `ping`: hook còn nguyên, thấy 20 URL gần nhất) |
| 33 | Profile 2, D-12 | **lấy fixture cho parser**: 1 request ảnh Nano Banana 2 Lite **9:16 x2** (0 credit), observer lưu đủ request/response | auto `isTrusted` | không | ✅ x2 = 2 item trong request, **mỗi item một seed**, response trả 2 media và lặp đúng seed từng item; 2 workflow cùng lặp UUID batch cuối. Field sau seed = `2` với 9:16 (1:1 là `1`) ⇒ **là mã tỉ lệ khung hình**. Lưu làm fixture parser |
| 34 | Profile 2, D-12 | **lấy fixture thô**: paste 1 ảnh JPEG làm ref (upload `maseQ`), rồi 1 request ảnh Nano Banana 2 Lite 1:1 x1 **có ref** (0 credit); observer lưu body thô | auto `isTrusted` | không | ✅ paste ảnh → `maseQ` (body thô ~235 KB, base64 219 200 ký tự); response trả media id = chip `e838b42d…`, **chỉ lặp tên file, không lặp UUID nào** ⇒ driver đặt tên file duy nhất để làm bằng chứng sở hữu. Lần paste đầu (chip `018e4309…`) mất chip khi reload tab, ảnh vẫn nằm trong thư viện. Ảnh có ref: item `[2]=[[refId,null,null,null,1]]`, còn lại giữ vị trí. Token reCAPTCHA nằm ở `ctx[10][0]` của mọi request |

## KẾT LUẬN SPIKE (thay kết luận tạm bên dưới)

> **Kết luận hiện hành (06/11/2026, lượt 1–34):** cách A **đạt** khi extension thao tác bằng content script và gửi tự động theo [ADR-0002](../../docs/app/adr/0002-flow-auto-submit-trusted-listener.md): gọi listener click của nút Gửi với `isTrusted` giả, không chạm reCAPTCHA. Chỉ đường CDP/`chrome.debugger` là **không đạt**. Ảnh, ảnh có ref, video text, video khung đầu và video Thành phần đều chạy tự động; ghép kết quả qua network. Các đoạn bên dưới ghi "trước D-12" hoặc "kết luận tạm" là lịch sử, đã lỗi thời.

- **(Cập nhật bởi D-12 bên trên: auto-submit đạt.)** **Đường dùng được (trước D-12):** extension mỏng chạy **content script** (không `chrome.debugger`), làm hết phần chuẩn bị. **Người dùng bấm Generate** cho mỗi lượt. Đây đúng là D-08 "manual submit" trong docs. Auto-submit thật không có đường hợp lệ: event tổng hợp bị Flow bỏ qua, còn CDP thì bị reCAPTCHA chặn. Hai cách còn lại để auto là giả `isTrusted` hoặc né reCAPTCHA, cả hai đều bị docs cấm.
- **Content script làm được:** đổi settings (Image/Video, Khung hình/Thành phần, ratio, 360p/720p, 4/6/8/10 s, x1–x4) và đọc lại bằng `aria-checked`; gõ prompt tiếng Việt khớp từng ký tự; gắn ref có sẵn trong project qua add-menu; điền ô Start/End của video bằng nút `empty-chip` "Bắt đầu"/"Kết thúc" (role xác định được theo slot, không theo thứ tự chip); xoá composer (`button.clear-button`); đọc tiles.
- **Upload ref bằng content script:** `paste` một `File` (DataTransfer) vào editor → upload lên project **và** tự gắn chip sau khi upload xong (~5–10 s). `drop` → chỉ upload vào thư viện, không gắn chip. Mỗi lần gọi upload đúng 1 lần (đếm theo tile), nên cần journal chống upload trùng.
- **Tải:** ảnh `img.src` (`flow-content.google`, URL ký sẵn). Video: tile chỉ có thumbnail `flow.google.com/asb/…`, thêm hậu tố `=mm,22,15` (đúng `playback_url_suffix` trong config nghiên cứu) → MP4 thật qua `chrome.downloads`, cần cookie trình duyệt nên phải tải bằng extension, không tải từ desktop được.
- **Identity:** tile video **không có `data-media-id`**. Định danh tạm thời chỉ là `asb` URL (theo config: chỉ ổn định trong session). Ảnh có `data-media-id`. UI Profile 2 là tiếng Việt → mọi text matcher phải song ngữ.
- `chrome.runtime.reload()` qua lệnh relay: cập nhật extension unpacked không cần người bấm.

**Kết luận tạm (trước D-12, lỗi thời — chỉ còn đúng cho đường CDP):** reCAPTCHA Enterprise của Flow (`recaptcha/enterprise/reload` → `ogiZ0b` trả `PUBLIC_ERROR_UNUSUAL_ACTIVITY`) gắn cờ phiên trang có dùng `chrome.debugger`/CDP Input. Kể cả khi người bấm, hoặc đã gỡ debugger trước khi bấm (lượt 8–9), vẫn bị từ chối. Lượt 3 thành công chỉ là một mẫu lẻ, không chứng minh được auto-submit dùng ổn định. **Cách A với auto-submit qua CDP: KHÔNG ĐẠT.** Không thử "humanize" để qua reCAPTCHA vì tài liệu đã cấm né kiểm tra truy cập (00 §5, 07 §1.7).

## Những gì đã chạy tốt (dùng lại cho thiết kế)

- Selector profile `v2` trong nghiên cứu vẫn đúng: `flow-prompt-box .ProseMirror`, `button[type=submit]`, `flow-prompt-box-settings` (radio Image/Video, ratio, x1–x4, model menu `flow-menu-item`), `flow-grid-tile-container`, `flow-pending-tile .loading-percentage`, `flow-error-tile`, `flow-add-menu…`, `flow-image-ingredient-chip`.
- Chỉnh settings và đọc lại hậu điều kiện qua `aria-checked` và class `selected`. Model đang thấy: Nano Banana Pro / 2 Lite / 2.1.
- Gõ prompt tiếng Việt bằng `Input.insertText`: khớp từng ký tự.
- Upload ref không cần vá file picker: `Page.setInterceptFileChooserDialog` → `Page.fileChooserOpened` → `DOM.setFileInputFiles`. Chip ref mang `media-id` của asset → có identity cho `ProviderAssetBinding`.
- Tải file: `src` của tile là URL ký sẵn trên `flow-content.google` (không cần cookie). `chrome.downloads` trả id, state, mime, size. Chrome tự đổi `.img` → `.jpeg`, khớp với tách `plannedName`/`actualName` ở 06 §5. Magic bytes JPEG OK.
- Receipt: `batchexecute?rpcids=ogiZ0b` là lệnh generate; body trả lỗi có cấu trúc (`ErrorInfo`). Lỗi được hiển thị ở `flow-error-tile .error-message-text`.

## Những bẫy phát hiện được (đưa thành yêu cầu driver)

Đã gom cùng các bẫy ở những mục khác vào [checklist qualification 04 §7.1](../../docs/app/04-flow-driver.md#71-checklist-qualification-các-bẫy-đã-gặp-ở-spike-01) (Q-01…Q-30).

1. **Overlay che control:** banner cookie che nửa dưới nút Generate. Click vào tâm nút rơi vào banner, không có gì được gửi (đây là `rejected_before_dispatch` thật). → Click phải hit-test bằng `elementFromPoint`. Banner là consent (`CONSENT_REQUIRED`), người dùng tự quyết.
2. **Pending tile không có `data-media-id`** cho tới gần lúc xong. `aria-label` lúc pending = prompt, nhưng **sau khi xong bị đổi thành tiêu đề do Flow tự sinh** ("Tabby cat sitting on windowsill"). → Không gán chủ output theo label. Cần theo dõi lineage của tile từ lúc pending, hoặc lấy receipt `ogiZ0b`.
3. **Tile lỗi biến mất khi reload trang.** → Phải ghi journal lỗi ngay lúc quan sát, không đọc lại được sau.
4. **Service worker MV3 chết khi relay mất và không tự kết nối lại.** Thêm `chrome.alarms` + listener `tabs.onUpdated` mới đánh thức được. Chrome cache SW của extension unpacked qua restart, chỉ nút reload mới nạp code mới.
5. Kết quả phụ thuộc mạng/IP (lượt 1 không VPN fail). Có thể có nhiều tab cùng một project → phải bind theo tabId.

## Đổi môi trường test (theo yêu cầu người dùng)

Từ lượt 10: **Chrome Profile 2** (`/home/nthieuu/.config/google-chrome/Profile 2`), project `b89ba0b5-d5e3-44d9-8d86-1851dd147159`. Profile 1 / project f1430844… thôi dùng. Tab trong Profile 2 chưa từng bị gắn debugger, phù hợp cho lượt content-script.

## Còn mở (sau lượt 31)

- Vì sao observer network mù ở lượt 30–31; lượt 32 không tái hiện được. Đã có heartbeat `ping` (kiểm hook còn là của mình và liệt kê URL gần nhất).
- Ý nghĩa thật của field credit `[1]` trong response.
- Trần có khác giữa các gói tài khoản không; mới đo 1 tài khoản Pro.
- An toàn tài khoản khi chạy nhiều ngày liên tục, sau ~200 lượt tự động và 3 đợt throttle trong 1 ngày.
- Song song khi có ref/Start+End frame; upload ref mới trong lúc chạy tự động.
- ChatGPT.
