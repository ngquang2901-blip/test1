# 04 — Driver Google Flow

**Phạm vi:** điều khiển giao diện web trong tab/project đã chọn. Không cần Bridge, tài khoản dịch vụ bên thứ ba, private protocol hoặc tự POST native RPC. Mô tả dưới đây là mục tiêu thiết kế, chưa có lượt generate ToolFlow được chạy.

## 1. Capability mục tiêu

| Mode | Đầu vào | Đầu ra | Trạng thái |
|---|---|---|---|
| flow.text_to_image | Prompt | Ảnh thuộc lượt gửi | Mục tiêu MVP, cần qualification. |
| flow.reference_to_image | Prompt + ảnh ref | Ảnh | Chỉ bật khi upload/attachment/ownership đã qualify. |
| flow.text_to_video | Prompt | Video | Cần qualification riêng, không kế thừa từ ảnh. |
| flow.start_frame_to_video | Prompt + một ảnh gán role start | Video | Cần xác nhận đúng slot Start, không dựa vào thứ tự chip. |

Không cung cấp khung cuối, video ingredients, character/voice, upscale/edit/extend trong bản đầu. Tỉ lệ/model/duration/resolution chỉ xuất hiện khi UI và capability tương ứng đã được kiểm. Mỗi tổ hợp model + mode + ref có record riêng.

## 2. Preflight trước mỗi item

1. Kiểm session/tab/origin và project đúng Target snapshot; SPA navigation làm mất readiness cũ.
2. Kiểm không có challenge, login/consent mới, cảnh báo quota, menu/modal không rõ chủ hoặc người dùng đang sửa composer.
3. Kiểm version driver/config, mode/model/ratio/ref capability còn hợp lệ.
4. Kiểm ownership/epoch và batch chưa pause/stop ở mọi ranh giới có thể tạo side effect.
5. Có consent chưa được người dùng xử lý thì awaiting_user, không tự đồng ý điều khoản.

Thất bại rõ trước intent không được ghi "đã gửi". UI thiếu thông tin không tương đương provider hỗ trợ default mong muốn.

## 3. Prepare, upload và gán ref

- Chuyển mode/model/options qua UI và kiểm hậu điều kiện trên lựa chọn đang active. Không có control/không xác nhận được → SETTINGS_NOT_APPLIED, không bypass rồi chạy settings khác.
- Composer phải thuộc project đang chọn; làm sạch nội dung cũ chỉ khi runner được quyền sở hữu và baseline cho biết không phải chỉnh sửa ngoài app. Có thay đổi người dùng → TARGET_CHANGED/USER_INTERFERENCE.
- Upload theo assetId và binding project. Ghi upload intent, theo dõi tile/preview có identity; timeout sau khả năng upload → đối soát, không upload lần hai mù quáng.
- Không patch prototype picker toàn cục hoặc giả cờ trusted cho input/upload chỉ vì nghiên cứu thấy có làm. Ngoại lệ duy nhất là gọi listener của nút Gửi trên Flow theo [ADR-0002](adr/0002-flow-auto-submit-trusted-listener.md). Cơ chế input/upload được chọn khi chốt connector và phải qua test; nếu chưa có đường tin cậy thì hướng dẫn người dùng chọn file.
- Kiểm ref identity, số chip và role. Với start frame phải đọc được slot/label hoặc bằng chứng tương đương đã qualify. Không coi chip đầu = Start như một sự thật chưa được chứng minh.
- Đọc lại prompt và attachments ngay trước intent. Sai/lệch → dừng, không lược bỏ ref.

## 4. Gửi đúng một lần

Chụp baseline gồm project, danh tính tile hiện có, pending owners, prompt/settings/ref proof và thời điểm. Lưu attempt/intent bền vững trước khi tạo cơ hội submit.

- **Auto:** đường chính trên Flow theo [ADR-0002](adr/0002-flow-auto-submit-trusted-listener.md) (gọi listener với `isTrusted` giả, fail-closed, ràng buộc ở ADR). Chỉ bật khi cách thao tác đã qualify trên platform chọn. Một lần gửi; không bấm Enter dự phòng sau một click có thể đã tới provider.
- **Manual:** dự phòng theo [ADR-0001](adr/0001-manual-submit-khi-auto-chua-qualify.md). Arm theo dõi và lưu intent trước khi cho người dùng bấm Generate tại tab. "Đã bấm" của người dùng không là receipt; đọc UI để xác nhận.
- Tín hiệu editor bị xoá/nút disabled dùng hỗ trợ xác nhận, không thay ownership. Không có acceptance đáng tin trong deadline → SUBMIT_UNCERTAIN và needs_review.
- Một pending tile/operation xác định được gắn attempt ngay khi quan sát. Có output xuất hiện nhanh thì vẫn ghi cả acceptance và ownership evidence.

## 5. Theo dõi và gán kết quả

Chỉ đọc từ target/project được bind. Theo dõi identity từ pending đến complete; lưới ảo hoá cần reader nhận ra tile bị unmount, không coi mất DOM = thất bại.

Các bằng chứng ưu tiên: lineage đã xác nhận từ pending owner; identity bền của output trong đúng project; baseline + một ứng viên mới trong chế độ tuần tự không có tương tác ngoài app, nếu chiến lược này đã qualify. Có hai ứng viên hoặc không chứng minh được quan hệ → RESULT_OWNERSHIP_AMBIGUOUS.

Không quét rồi gắn "tile mới nhất". Không bind thumbnail của upload ref thành output sinh nội dung. Video cần playable media/source gắn đúng identity; poster không đủ chứng minh video sẵn sàng tải.

## 6. Lỗi và hành động

| Tình huống | Hành vi |
|---|---|
| Mất login/captcha trước gửi | awaiting_user, mở đúng tab; kiểm lại khi người dùng xong. |
| Mất login/captcha sau intent | Khoá gửi mới; đối soát attempt trước khi resume. |
| Provider báo quota | RATE_LIMIT; chặn admission; không đoán thời gian reset hoặc tự đổi account. |
| Provider báo policy block | CONTENT_BLOCKED; chốt lỗi nếu gắn đúng attempt; không viết lại prompt để né. |
| Settings/ref không khớp | Chặn trước submit; hiện đúng mục cần sửa. |
| Không biết đã gửi hay chưa | needs_review; không tự generate lại. |
| Output có rồi, URL hết hạn | Resolve lại identity qua UI, chỉ retry tải. |
| Project đổi hoặc tab đóng | Giữ journal/binding; yêu cầu reconnect/reconcile, không chọn tab thay thế. |

Bảng mã lỗi chung và retry ở [07](07-safety-and-recovery.md). Bảng map đủ 70 mã `PUBLIC_ERROR_*` của Flow sang mã ToolFlow, kèm parser response có fixture thật: [`packages/flow-protocol`](../../packages/flow-protocol/src/errors.mjs) (tóm tắt ở [ADR-0002](adr/0002-flow-auto-submit-trusted-listener.md)).

## 7. Điều kiện bật mode trong bản phát hành

Có test trên browser/OS/driver version được chọn: prompt tiếng Việt, ref đúng identity, video slot đúng, manual/auto path nếu quảng cáo, không trộn kết quả cũ, timeout sau submit không gửi lại, tải file gốc thật. Ghi giới hạn quan sát; không khẳng định mọi tài khoản/model dùng được.

### 7.1 Checklist qualification: các bẫy đã gặp ở spike 01

Mỗi dòng là một bẫy có thật trong [FINDINGS](../../spikes/01-flow-cdp/FINDINGS.md). Cột *Nguồn*: số lượt trong sổ, "bẫy N" là mục *Những bẫy phát hiện được*, "kết luận" là mục *Kết luận spike*; `—` là bẫy suy ra từ thiết kế, chưa gặp thật. Một mode chỉ được bật khi **mọi dòng áp dụng cho mode đó đạt** trên đúng tổ hợp browser/OS/extension/driver version sẽ phát hành. Biên bản ghi ngày, gói tài khoản, mạng đang dùng, số lượt và credit đã tiêu. Dòng chưa chạy thì ghi *chưa kiểm*, không ghi đạt.

**Tầng** theo [08 §3](08-acceptance-and-delivery.md): 1 = không provider (fixture/fake driver), 2 = browser fixture, 3 = host integration, 4 = live. **Tự động** ✅ là đã có test chạy được trong [`packages/flow-protocol`](../../packages/flow-protocol/); ⬜ là chưa có.

**Gửi**

| # | Bẫy | Nguồn | Cách kiểm | Đạt khi | Tầng | Tự động |
|---|---|---|---|---|---|---|
| Q-01 | Banner cookie/consent che nút Gửi. Gọi listener thì về cơ chế **không bị overlay chặn** (lượt 36: đúng vậy), nên auto có thể gửi phía sau một banner người dùng chưa quyết. | bẫy 1 | Để banner hiện, chạy một item. | Dừng trước intent với `CONSENT_REQUIRED`; 0 request generate. | 2, 4 | ⬜ banner thật · ✅ live lượt 36: lớp che toàn màn hình vẫn để gửi (`ogiZ0b` 200) ⇒ bẫy có thật; phép kiểm `elementFromPoint` ở tâm nút Gửi phải nằm trong `flow-prompt-box`, đúng cả 3 trạng thái (không che / che / mở cài đặt) |
| Q-02 | Lệnh "đọc trạng thái" bấm Gửi thật. | 29b | Composer có prompt; gọi mọi lệnh đọc (state, ping, net, list) nhiều lần. | Ledger của driver đếm 0 lần submit; chỉ `canClick()` mở được lệnh bấm. | 1, 4 | ✅ cổng `canClick` (`attempt.test`) · ⬜ ledger |
| Q-03 | Đổi mode xong, composer giữ text cũ nên prep gõ chồng. | 30 | Gõ prompt A, đổi Image ↔ Video, prep prompt B. | Composer được xoá; text đọc lại đúng nguyên văn B; sai thì `prep_failed`, không gửi. | 4 | ✅ live lượt 36: đổi Ảnh↔Video giữ text; không xoá thì ra "A…B", đọc lại `textMatches:false`; `clear-button` rồi gõ thì đúng |
| Q-04 | Tab nền: nút Gửi còn `disabled` vài giây, settings panel render chậm hơn 1 s. | `multitab.py`, `flow.py` | Prep và gửi ở tab không focus. | Chờ có giới hạn rồi gửi, hoặc `rejected_before_dispatch`; không fallback `click()`/Enter. | 4 | ⬜ |
| Q-05 | Script MAIN world nạp sau Angular (vừa cài/cập nhật extension mà chưa reload tab) nên không bắt được listener. | ADR-0002 Hệ quả | Cập nhật extension, không reload tab, chạy một item. | `listeners: 0, called: 0` → `CONFIG_INCOMPLETE`; app nhắc reload tab; 0 request. | 3, 4 | ✅ nhánh `called: 0` và `{noMainWorld}` (lượt 36 sửa: trước đó `{noMainWorld}` bị coi là đã bấm) · ⬜ live cài mới |
| Q-06 | CDP bị gắn cờ `UNUSUAL_ACTIVITY` cả khi người bấm; event tổng hợp bị bỏ qua. | 1–9, dòng `—` | Kiểm manifest và mọi đường gửi. | Không có quyền `debugger`; không có đường fallback nào ngoài listener. | 1 | ⬜ |

**Observer và bằng chứng gửi**

| # | Bẫy | Nguồn | Cách kiểm | Đạt khi | Tầng | Tự động |
|---|---|---|---|---|---|---|
| Q-07 | Observer network chết lặng lẽ sau khi reload extension. | 30–31 | Reload extension, không reload tab, rồi ping. | Intent bị từ chối `OBSERVER_DEAD` (`hook_*`/`old_observer`/`stale`). | 1, 4 | ✅ `heartbeat.test`, `attempt.test` · live lượt 36: **không tái hiện** (lần 2, sau lượt 32): reload extension không reload tab, observer id giữ nguyên, bắt đủ request/response |
| Q-08 | Tab reload giữa lúc bấm và lúc có receipt làm mất bộ đệm. | — | Bấm rồi reload tab trước khi response về (tốn 1 lượt). | `page_reloaded` → `SUBMIT_UNCERTAIN`; không gửi lại; đối soát grid. | 1, 4 | ✅ · ⬜ live |
| Q-09 | Lượt bị xếp `uncertain` (không thấy request) thật ra đã gửi và render. Heartbeat lúc trang rảnh không chứng minh observer sẽ thấy request kế. | 30 | Fake observer bỏ record `sent`; live: đối chiếu grid sau deadline. | Deadline → `SUBMIT_UNCERTAIN`, không gửi lại; receipt về muộn gỡ được; lỗi từ chối về muộn chỉ chốt lỗi. | 1, 4 | ✅ |
| Q-10 | Bộ đệm vòng của observer tràn khi nhiều tab/poll. | — | Đẩy hơn 200 record giữa hai ping. | `records_dropped` → `SUBMIT_UNCERTAIN`. | 1 | ✅ |

**Ghép kết quả**

| # | Bẫy | Nguồn | Cách kiểm | Đạt khi | Tầng | Tự động |
|---|---|---|---|---|---|---|
| Q-11 | Prompt trùng nhau trong cùng lô. | 16 | Fixture lượt 16; live 3 prompt giống hệt. | Mỗi request ghép đúng một receipt theo batch UUID + seed; receipt của request khác → `RESULT_OWNERSHIP_AMBIGUOUS`. | 1, 4 | ✅ |
| Q-12 | Tile pending không có media id; xong rồi `aria-label` đổi thành tiêu đề Flow tự đặt. | bẫy 2 | Theo dõi tile từ pending tới xong. | Không gán chủ theo label/tile; chỉ theo response, hoặc theo danh sách `Zzl0ze` (có prompt gốc, seed, batch UUID; lượt 35). | 4 | ⬜ |
| Q-13 | Grid của tab A không cập nhật job do tab B gửi (vẫn `pending`). | 22–23 | 2 tab cùng project, mỗi tab 1 video. | Trạng thái lấy từ poll; không đọc grid của tab khác. | 4 | ⬜ |
| Q-14 | Tile video không có media id trong DOM. | kết luận (Identity) | Tải video vừa xong. | Bind theo operation/media id trong response, hoặc theo `Zzl0ze` khi mất response (operation id = media id trong danh sách); tải từ thumbnail `asb` + `=mm,22,15`. | 4 | ⬜ |
| Q-15 | Trường sau seed là mã tỉ lệ; regex cứng làm mất seed. | 32–33 | Fixture từng tỉ lệ và xN. | Parse theo vị trí; lệch mẫu → `PROTOCOL_DRIFT`. Mới có fixture 1:1, 9:16; **16:9, 4:3, 3:4 chưa kiểm**. | 1 | ✅ một phần |
| Q-16 | Request đọc từ body thô; bước che token làm hỏng body. | 34 | Fixture body thô. | `f.req` đọc qua `URLSearchParams`, prompt tiếng Việt nguyên văn. | 1 | ✅ |

**Ref và upload**

| # | Bẫy | Nguồn | Cách kiểm | Đạt khi | Tầng | Tự động |
|---|---|---|---|---|---|---|
| Q-17 | Danh sách asset sắp xếp lại khi có kết quả mới nên chọn theo index là gắn nhầm. | 17B | Chọn ref trong lúc lượt khác vừa xong. | Chọn theo media id; chip lệch id → `SETTINGS_NOT_APPLIED`, không gửi. | 4 | ⬜ |
| Q-18 | Response upload chỉ lặp **tên file**, không lặp UUID nào. | 34 | Upload 2 ảnh giống hệt nhau. | Tên file duy nhất cho mỗi upload; media id ghép theo tên. | 1, 4 | ✅ parser · ⬜ live |
| Q-19 | Chip ref paste mất khi reload tab; ảnh vẫn nằm trong thư viện. | 34 | Paste ref, reload tab, chạy tiếp. | Kiểm lại chip trước intent; gắn lại từ thư viện theo tên file, không upload lần hai. | 4 | ✅ live lượt 36: reload mất chip; tìm theo tên file trong ô tìm kiếm thư viện, bấm mục → chip đúng media cũ, 0 `maseQ` mới |
| Q-20 | `paste` vừa upload vừa gắn chip; `drop` chỉ upload. Mỗi lần gọi là một upload thật. | kết luận (Upload) | Đếm upload theo `maseQ`. | Đúng 1 upload mỗi asset; journal chống upload trùng. | 4 | ⬜ |

**Lỗi, giới hạn và credit**

| # | Bẫy | Nguồn | Cách kiểm | Đạt khi | Tầng | Tự động |
|---|---|---|---|---|---|---|
| Q-21 | Throttle trả HTTP 200; chữ trên tile giống lỗi chung. | 25, 27, 28 | Fixture throttle. | Phân loại theo mã; chỉ 4 mã của 07 §3 được gửi lại, tối đa 5 lần. | 1 | ✅ |
| Q-22 | Hết credit bị chặn ở client; field credit trong response lệch khoảng 30. | 30–31 | Tài khoản hết credit, chạy model tốn credit và model 0 credit. | Thấy `button.prompt-warning-button` → `RATE_LIMIT`, không gửi; model 0 credit vẫn chạy; không tự cộng trừ credit. | 4 | ⬜ |
| Q-23 | Video lỗi `INTERNAL` trong poll, Flow hoàn credit trong khoảng 10 phút. | 21, 28 | Poll lỗi (fixture dựng lại; chưa có bản thô). | Chốt lỗi, không gửi lại. | 1 | ✅ dựng lại |
| Q-24 | Tile lỗi biến mất khi reload trang. | bẫy 3 | Có lỗi rồi reload tab. | Lỗi đã nằm trong journal từ lúc quan sát. | 3 | ⬜ |
| Q-25 | Enum `PUBLIC_ERROR_*` thay đổi theo bản frontend. | — | Thu lại bundle Flow hiện tại rồi chạy test bảng lỗi. | Test so enum đạt trên bundle **mới thu**, không chỉ bản đã lưu. | 1 | ✅ trên bản đã lưu |

**Host và môi trường**

| # | Bẫy | Nguồn | Cách kiểm | Đạt khi | Tầng | Tự động |
|---|---|---|---|---|---|---|
| Q-26 | Service worker MV3 chết khi mất kết nối desktop và không tự nối lại. | bẫy 4 | Tắt app desktop rồi bật lại khi đang có lô. | Extension tự nối lại (alarms/`tabs.onUpdated`); không phát lại lệnh cũ; runner đối soát trước admission. | 3 | ⬜ |
| Q-27 | Extension khác trong profile đổi tên file tải (TobyFlow → `<mediaId>.jpeg`, `videoplayback.mp4`). | 13–14, 32 | Tải khi có extension khác cài cùng profile. | `actualName` lấy từ `downloads.search`; kiểm magic bytes. | 3 | ⬜ |
| Q-28 | Nhiều tab cùng một project. | bẫy 5 | 2 tab cùng project. | Target bind theo tabId; lệnh không lọt sang tab khác. | 3 | ⬜ |
| Q-29 | Kết quả phụ thuộc mạng/IP (lượt 1 không VPN thì fail). | 1, bẫy 5 | Ghi mạng dùng khi qualify. | Biên bản có mạng; không xoay IP/VPN để né giới hạn. | 4 | — |
| Q-30 | Danh sách model và option đổi theo thời gian. | 15–17 | Quét menu model và settings lúc chạy. | Chỉ bật option nhìn thấy và đọc lại được; không hard-code model. | 4 | ✅ live lượt 36: ảnh có Nano Banana Pro / 2 Lite / 2.1; video có Omni 1.2 Flash, Omni 1.1 Flash, Veo 3.1 Lite/Fast/Quality, 360p/720p, 4–10 giây (khác lúc spike) |
| Q-31 | Đổi mode Video → Ảnh thì tỉ lệ khung tự nhảy (1:1 thành 16:9). | 36 | Chọn 1:1, đổi sang Video rồi về Ảnh, đọc settings. | Sau mỗi lần đổi mode đọc lại mọi option trước intent; lệch thì chọn lại hoặc `prep_failed`. | 4 | ⬜ (thấy live lượt 36) |
| Q-32 | Paste ảnh: upload `maseQ` 200 nhưng **không gắn chip** (lượt 34 thì có). | 36 | Paste ref, đọc chip. | Sau paste kiểm chip theo media id từ receipt upload; thiếu thì gắn từ thư viện theo tên file (Q-19), không upload lại. | 4 | ⬜ (thấy live lượt 36) |
| Q-33 | Thư viện trong menu Thêm chỉ hiện 15 mục gần nhất; nút `detail-add-to-prompt-btn` đã bỏ, bấm mục là gắn luôn. | 36 | Mở menu Thêm, tìm tên file. | Tìm bằng `input.search-input`; selector nằm trong profile có version (D-06), lệch thì `PROTOCOL_DRIFT`. | 4 | ⬜ (thấy live lượt 36) |
| Q-34 | Cập nhật extension mà không reload tab: script MAIN world **bản cũ** vẫn chạy. | 36 | Reload extension, ping. | Ping trả version script; khác version extension thì nhắc reload tab, chặn intent. | 3, 4 | ⬜ (cần thêm version vào ping) |

**Nguồn:** [Flow DOM](../research/04-google-flow-dom-v1.md), [config/runtime](../research/16-flow-gpt-runtime-findings.md). Nghiên cứu cho thấy các control/selector tồn tại ở snapshot, chưa chứng minh driver ToolFlow hoạt động. [Native RPC](../research/17-flow-native-public-frontend.md) chỉ lưu làm tham khảo ngoài scope.
