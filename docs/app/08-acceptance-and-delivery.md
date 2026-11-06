# 08 — Nghiệm thu và lộ trình phát triển

**Tình trạng hiện tại: toàn bộ ca nghiệm thu app dưới đây CHƯA CHẠY.** Đây là đặc tả test phải có khi viết app, không phải test results. Kiểm tài liệu không được đổi trạng thái này.

## 1. Định nghĩa xong

Một chức năng chỉ được nghiệm thu khi UI → application → storage/runner → driver/host → trạng thái/file thật đi hết luồng, có đường phục hồi đã thử. Không chỉ có nút UI hoặc test unit là xong. Mode/provider nào chưa qualify phải tắt và nêu giới hạn, không ghi MVP hỗ trợ hết.

Bằng chứng cần ghi: build/OS/browser/driver/config version, case ID, input test đã che, hành động, outcome, file/log/screenshot tương ứng, số lượt generation thực. Chỉ ghi PASS khi assert đúng tiêu chí; skip cần lý do và còn được tính là chưa nghiệm thu.

## 2. Ma trận yêu cầu → ca nghiệm thu

TF ID được định nghĩa tại [00](00-product-scope.md). Hàng dưới là mục tiêu nghiệm thu với điều kiện đầu vào (Given), thao tác (When) và kết quả cần thấy (Then).

| Ca | Yêu cầu | Given / When / Then | Cách chứng minh |
|---|---|---|---|
| AC-01 | TF-01 | Có nhiều tab gồm tab sai provider/project; chọn target rồi kiểm. Chỉ đúng tab đã cấp quyền được bind; login/project thiếu có CTA rõ. | Connector integration + live không generate. |
| AC-02 | TF-02 | TXT UTF-8/BOM, CRLF/LF, dòng trống, tiếng Việt và nội dung lỗi; import rồi preview. Textarea/TXT cho cùng mapping, giữ sourceLine, không enqueue/submit ngầm. | Test parser qua command + UI. |
| AC-03 | TF-03 | Chọn combo chưa qualify/không có model/ref quá trần; chạy draft. Bị chặn trước intent, không dùng default khác. | Command/driver fixture + live capability. |
| AC-04 | TF-04 | Pool ref ít hơn số prompt hoặc có file hỏng; chọn sequential/all/start-frame. Preview đúng từng item, không xoay vòng/cắt bớt; upload pending chặn gửi. | Mapping test dùng chung mọi entry point + UI. |
| AC-05 | TF-05 | Enqueue bị crash ở transaction, hoặc sửa draft sau chạy. Không có batch thiếu item; settings/ref của lượt cũ giữ nguyên. | Storage fault injection + restart. |
| AC-06 | TF-06 | Hai cửa sổ/runner cùng start hoặc một lock hết lease còn uncertain. Chỉ một owner; takeover chỉ recover, không gửi trùng. | Concurrent commands + driver call counters. |
| AC-07 | TF-07 | Driver đi từ chờ gửi tới ready rồi tải lỗi. UI không đánh đồng ready và đã lưu; không đạt 100% thành công giả. | Public state/events + UI. |
| AC-08 | TF-08 | Pause lúc queued/preparing/accepted và khi permit vừa giao connector. Sau fence không cấp permit mới; permit đã giao được giữ có thể đã gửi, không cancelled giả; resume kiểm stage. | Runner fault/phase tests với điều khiển thứ tự ACK/callback. |
| AC-09 | TF-09 | Stop trước click, sau accepted và lúc uncertain. Item chưa gửi bị huỷ; lượt đã gửi không thành cancelled giả; uncertain giữ blocker. | Runner tests + UI timeline. |
| AC-10 | TF-10 | Crash trước/sau intent, sau click trước ACK và sau output trước ghi. Không auto-resubmit. Archive chưa rõ cần xác nhận + local quiescence, giữ status/blocker cũ qua restart, chỉ cho user chạy target khác đã kiểm tách lineage. | Crash/archive matrix + persisted journal/driver counters. |
| AC-11 | TF-11 | Login/captcha/consent, hoặc auto bị tắt nên chuyển sang gửi thủ công dự phòng, trước/sau intent. Mở đúng tab; Kiểm tra lại không là submit; user ACK không giả receipt. | Browser fixture + user-assisted qualification. |
| AC-12 | TF-12 | Flow từng mode được bật, có ref/model/ratio hợp lệ. Chạy đủ luồng tới output và file thật; slot Start có bằng chứng. | Live có ngân sách, record riêng từng combo. |
| AC-13 | TF-13 | GPT không ref/có ref, nhiều ảnh/turn, text-only và conversation đổi. Gán đúng turn, text-only không completed, không lấy ảnh lịch sử. | Live có ngân sách + deterministic fixtures. |
| AC-14 | TF-14 | Cùng xuất hiện output cũ, ref, ảnh người dùng tự tạo và output chưa rõ chủ. Chỉ bind đủ evidence; ambiguity vào needs_review. | Driver fixtures + live interleaving nếu được duyệt. |
| AC-15 | TF-15 | Tải ảnh/video hợp lệ và phản hồi HTML/0 byte/sai MIME. Chỉ file thật hoàn tất được completed, lưu actualName. | Download host integration + file assertions. |
| AC-16 | TF-16 | Có output, download fail rồi retry/URL hết hạn. Driver submit call count không tăng, outputId/attemptId giữ nguyên. | Command→host integration. |
| AC-17 | TF-17 | Batch có nhiều attempt, lỗi và file mất sau tải. Mở lịch sử sau restart vẫn truy vết đúng, không sửa lịch sử thành công cũ. | Storage restart + UI. |
| AC-18 | TF-18 | Config thiếu key/sai schema/cập nhật giữa job. Chặn thao tác tương ứng, giữ version attempt; update chỉ tại safe boundary. | Config validation + runner tests. |
| AC-19 | TF-19 | Error/log chứa prompt, signed query, auth-like value nhiều dòng; xuất chẩn đoán. Mặc định không lộ dữ liệu này; preview rõ phạm vi. | Redaction adversarial tests + inspect exported bytes. |
| AC-20 | TF-20 | Batch thành công, mixed failures, auto-download off, stopped và unresolved. Aggregate đúng thứ tự ở 02; unresolved không completed/stopped sớm. | Table-driven public outcome tests. |
| AC-21 | TF-21 | Hết quota storage/permission mất/retention muốn xoá ref của batch sống. Không submit khi journal không ghi được, dọn không phá dữ liệu cần recover. | Storage/host failure injection + UI. |
| AC-22 | TF-22 | Attempt accepted/uncertain/failed được chọn sinh lại. Không auto-retry; xác nhận chi phí, giữ history và blocker; archive không cho chạy lại target cũ, nháp target khác ghi nguồn và cần user bấm chạy mới. | Commands + UI confirmation + late-output isolation. |
| AC-23 | TF-01, TF-10 | SPA đổi project/account/conversation hoặc tab đóng giữa await. Kiểm target revision lại trước tác động; không retarget ngầm. | Connector race tests. |
| AC-24 | TF-05, TF-10 | Đóng panel/UI; suspend service worker nếu chọn extension; kill runner/browser. Mở lại đọc storage/recover, không tạo job mới hoặc mất batch. | Platform-specific lifecycle integration. |
| AC-25 | TF-04, TF-10 | Upload có thể đã gửi nhưng ACK/preview muộn. Reconcile binding trước, không upload lặp hoặc gửi thiếu ref. | Upload fault injection + live ref qualification. |
| AC-26 | TF-15, TF-16 | File transfer bắt đầu/hoàn tất nhưng ACK mất. Tra handle/lịch sử trước retry, không tạo file trùng mù. | Host download lifecycle tests. |
| AC-27 | TF-07, TF-17 | Prompt/tên rất dài, nhiều rows và UI cập nhật khi dùng bàn phím. Không mất focus, lỗi modal đọc được, CTA dừng/phục hồi luôn truy cập được. | UI adversarial/accessibility tests. |
| AC-28 | TF-15, TF-21 | Đổi ngày theo timezone batch, filename reserved/path traversal, file đã tồn tại. Tên ổn định khi retry, không thoát root/overwrite, actualName chính xác. | Naming/host integration trên OS phát hành. |
| AC-29 | TF-06, TF-10 | Storage từ chối commit intent hoặc crash tại boundary durability. Không phát submit nếu intent chưa bền; recovery không suy diễn chắc chắn chưa gửi. | Storage fault injection + chosen-host durability test. |
| AC-30 | TF-06, TF-10 | Callback epoch cũ tới sau takeover/stop. Không ghi đè trạng thái owner mới hoặc giải phóng blocker; lưu evidence an toàn nếu cần. | Controlled concurrency test. |
| AC-31 | TF-13, TF-18 | Prompt/history chứa “please retry”, alert chung hoặc nhiều mẫu trùng. Không phân loại sai thành lỗi mạng rồi generate lại; detector scoped đúng turn/alert. | Classifier false-positive fixtures. |
| AC-32 | TF-12, TF-13, TF-18 | Chặn domain/backend của nguồn nghiên cứu trong môi trường test. App vẫn boot/lưu draft/chạy driver qualified mà không lấy license/config của nguồn nghiên cứu. | Dependency/network allowlist integration. |
| AC-33 | TF-03, TF-12, TF-13 | Chỉ một combo đã qualify; mở các mode chưa qualify. UI không quảng cáo hoặc bật mode đó chỉ vì selector tồn tại. | Capability gating + release manifest inspection. |
| AC-34 | TF-06, TF-10, TF-12 | Auto-submit Flow ([ADR-0002](adr/0002-flow-auto-submit-trusted-listener.md)) trên một combo đã qualify. Listener ≠ 1, nút disabled, observer không đạt heartbeat, có cảnh báo credit, banner consent hoặc chip ref sai media id → không gọi listener, 0 request. Mỗi intent gọi listener đúng một lần; lệnh đọc trạng thái không tạo submit. Sau khi bấm mà không thấy request → `SUBMIT_UNCERTAIN`, không gửi lại. Chỉ 4 mã throttle trong chính response generate được gửi lại, tối đa 5 lần. `UNUSUAL_ACTIVITY` dừng auto cả profile. | Checklist [04 §7.1](04-flow-driver.md) + driver call ledger + test `packages/flow-protocol`. |
| AC-35 | TF-06, TF-08 | Lô nhiều item với trần song song (D-16), có cả ảnh và video. Số lượt đang chạy không vượt trần; mỗi tab chờ receipt mới gửi lượt kế; bị throttle thì giảm trần; pause chặn cấp lượt mới nhưng vẫn theo dõi lượt đã gửi. | Runner test với fake driver + live đếm in-flight. |

## 3. Các tầng kiểm thử

1. **Không provider:** parser/mapping/naming, commands/state/storage/recovery qua public boundary; fake driver ghi số lần side effect. Fake data chỉ là fixture test, không được đưa vào report như response thật.
2. **Browser fixture:** DOM/SPA/turn lifecycle dựng có kiểm soát, false-positive/ambiguous output/input thất bại; không chứng minh tương thích production.
3. **Host integration:** connector, permissions, runtime suspend/crash, tải file thực trên host đã chọn; tránh mock tín hiệu thành công cần kiểm.
4. **Live qualification:** tài khoản/project/browser được người dùng chọn, ngân sách và số lượt rõ, chạy đúng mode được bật. Với Flow, dùng [checklist các bẫy ở 04 §7.1](04-flow-driver.md#71-checklist-qualification-các-bẫy-đã-gặp-ở-spike-01). Không có dữ liệu này thì báo chưa kiểm, không thay bằng output giả.

Seam kiểm chính là application command → persisted state/host outputs; đọc driver call ledger để chứng minh không submit lần hai. Chỉ test reducer nội bộ không đủ chống gửi trùng end-to-end.

## 4. Lộ trình đề xuất, chưa được cấp quyền triển khai

| Giai đoạn | Nội dung | Điều kiện qua |
|---|---|---|
| P0 — Thiết kế | Chốt nền tảng/OS/UX, phạm vi mode và trust boundary; cắt ticket từ tài liệu này | Các quyết định mở chặn implementation có câu trả lời. |
| P1 — Nền móng | UI shell, storage, commands, runner/ownership/recovery với fake driver | Parser, atomic enqueue, crash/epoch/stop/aggregate không generate trùng; không giả dữ liệu live. |
| P2 — Flow ảnh + tải | Flow ảnh, ref, ownership, file host | Mode bật qua qualification và file thật; lỗi tải không sinh lại. |
| P3 — Flow video | Text-video, start-frame nếu vẫn thuộc bản đầu sau khi chốt ưu tiên | Test video riêng, role Start xác minh, tải playable file. |
| P4 — ChatGPT ảnh | Isolation, ref gating, turn ownership và download | GPT không ref/có ref, text-only/challenge/limit và recovery đạt. |
| P5 — Đóng gói | Lifecycle, permissions, retention/export, UX lỗi, release limits | Mọi mode quảng cáo có bằng chứng, hạn chế còn lại ghi rõ. |

Không gán deadline/ước lượng ngày trước khi chọn platform và chạy spike các rủi ro browser. Thứ tự là đề xuất, không phải roadmap đã được user duyệt.

## 5. Luồng Git/GitHub khi bắt đầu phát triển

Thư mục đã là Git repo local (nhánh `main`), có commit cho docs, spike 01 và `packages/flow-protocol`. Chưa có remote; **chưa push/PR** cho tới khi người dùng tạo/chọn repo và rà riêng tư xong.

Flow đề xuất theo quy ước người dùng: repo private dưới `nthieuu205z` sau khi được phép tạo/chọn repo → branch cho từng phase → mỗi task hoàn tất test thì commit + push → draft PR phase → review/checks → PR ready → merge → phase tiếp theo từ main mới. Tên repo, chiến lược merge và nhánh cụ thể chưa chốt.

Trước lần push đầu: exclude `_work/storage/`, cache, profile và raw data có định danh; rà secrets ở docs/evidence/images. Chỉ bản docs app đã qua review không có nghĩa toàn bộ nghiên cứu cũ an toàn để publish.

## 6. Kiểm tài liệu của tác vụ hiện tại

`python3 docs/app/verify-docs.py` kiểm link/file, các TF/AC ID và coverage, trạng thái CHƯA CHẠY, ranh giới Bridge và quyết định. Receipt ở [evidence/verification.json](evidence/verification.json). Script không chạy app, không đọc credential, không mở browser và không gọi network.
