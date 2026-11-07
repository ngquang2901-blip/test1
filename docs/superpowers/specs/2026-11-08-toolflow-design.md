# ToolFlow — Design doc bản đầu (Flow ảnh, ảnh có ref, video)

**Ngày:** 08/11/2026 · **Trạng thái:** ĐANG CHỜ DUYỆT. Chưa có code sản phẩm.
**Đọc kèm:** bộ đặc tả [docs/app](../../app/README.md) (chương 00–09, ADR-0001/0002). Tài liệu này không chép lại các chương đó: nó chốt **cách xây**, chỉ ra chương nào là chuẩn cho phần nào, và liệt kê những gì còn để ngỏ.

Quy ước nhãn: **[SH]** = Sư Huynh đã quyết (ghi ở [09](../../app/09-evidence-and-decisions.md)); **[em]** = em tự chọn, Sư Huynh sửa được; **[builder]** = người viết code tự quyết.

---

## 1. Ý định

Sư Huynh tạo nhiều ảnh/video bằng Google Flow. Làm tay thì phải gõ từng prompt, gắn ảnh mẫu, bấm Gửi, chờ, tải về, đặt tên. Dễ nhầm ảnh mẫu giữa các prompt, khó biết lượt nào đã gửi khi mạng chập chờn, dễ tải thiếu.

ToolFlow nhận **một lô prompt** (kèm ảnh mẫu nếu có), tự chạy trên tab Flow mà Sư Huynh đã đăng nhập, theo dõi từng lượt và tải file về đúng tên. Gặp chuyện không chắc thì dừng lại hỏi, **không bao giờ tự gửi lại một lượt có thể đã tốn credit**.

**Thành công là:** chạy một lô 50 ảnh hoặc 20 video, bỏ máy đó, quay lại thấy mỗi prompt có file đúng của nó, hoặc một lý do cụ thể kèm nút để xử lý tiếp.

## 2. Mục tiêu, không làm, và thất bại dù chạy được

**Bản đầu phải có [SH, D-15]:** Flow ảnh từ prompt, ảnh có ref, video từ prompt, video có khung đầu. Chạy trên Windows và Linux [SH, D-14].

**Không làm ở bản đầu [SH, D-10, D-15]:** ChatGPT (để phase sau, đặc tả sẵn ở [05](../../app/05-chatgpt-driver.md)); khung cuối / video Thành phần nhiều ref; workflow kéo thả; MCP/Telegram; cloud; nhiều tài khoản cùng lúc; xoá watermark; license/thu phí; gọi thẳng RPC của Flow (Bridge/native).

**Thất bại dù về kỹ thuật vẫn chạy (anti-goals):**
- Gửi trùng một lượt, hoặc tự gửi lại lượt "không rõ" → tốn credit ngầm.
- Gắn nhầm kết quả hoặc ảnh mẫu sang prompt khác.
- Báo "xong" khi file chưa thật sự nằm trên đĩa, hoặc file là trang lỗi HTML.
- Tự đổi model/tỉ lệ/bỏ ref để "cứu" lô mà không hỏi.
- Tài khoản bị gắn cờ vì app làm điều Sư Huynh chưa bật (auto mặc định tắt, [SH, D-19]).

## 3. Ràng buộc

- **Cách gửi tự động [SH, D-12]:** gọi thẳng hàm xử lý click của nút Gửi với sự kiện giả `isTrusted:true` ([ADR-0002](../../app/adr/0002-flow-auto-submit-trusted-listener.md)). Không đụng reCAPTCHA, không giả hành vi người, không dùng `chrome.debugger` trên tab Flow (đã bị `UNUSUAL_ACTIVITY`).
- **Không gửi trùng:** ghi ý định vào sổ (journal) **trước** khi bấm; mỗi ý định bấm đúng một lần; khởi động lại thì mọi ý định chưa có receipt là "không rõ" [SH, D-04]. Quy tắc đầy đủ ở [07](../../app/07-safety-and-recovery.md).
- **Không backend:** mọi thứ chạy trên máy Sư Huynh; không tải cấu hình từ server [SH, D-06].
- **Dữ liệu nhạy cảm:** không đọc/lưu cookie, mật khẩu; kênh nối app ↔ extension chỉ ở `127.0.0.1` có token.
- **Credit:** không tự cộng trừ số dư (số trong response không đáng tin, FINDINGS lượt 30). Chỉ dựa vào nút cảnh báo hết credit của Flow.
- **Flow đổi liên tục:** model, menu, selector đã đổi ngay trong 3 ngày spike (Q-30, Q-33). Mọi thứ phụ thuộc trang Flow phải nằm trong một **profile có version** và tự kiểm khi mở app [SH, D-06].

## 4. Các cách đã cân nhắc

| Cách | Mô tả | Kết quả |
|---|---|---|
| **A — Desktop giữ logic, extension mỏng** | App Electron giữ giao diện, hàng đợi, sổ ghi, tải file; extension Chrome chỉ làm "tay chân" trên tab Flow | **Đã chọn [SH, D-13].** Spike 01 chạy đúng mô hình này 36 lượt. |
| B — Chỉ extension | Mọi thứ trong extension | Bỏ: service worker của Chrome bị tắt bất chợt, không giữ được hàng đợi dài; khó ghi file ra thư mục tuỳ ý. |
| C — Desktop điều khiển Chrome qua CDP/Playwright | Không cần extension | Bỏ: chính đường này bị Flow chặn `UNUSUAL_ACTIVITY` (lượt 1, 4–9). |
| D — Gọi thẳng RPC của Flow | Không cần trang | Ngoài phạm vi [SH, D-02]; phải tự lo token reCAPTCHA. |

## 5. Kiến trúc

### 5.1 Các khối chạy

```text
┌──────────── App desktop (Electron) ─────────────┐        ┌──── Chrome (profile đã đăng nhập) ────┐
│ Renderer: giao diện (S1–S5)                      │        │ Extension MV3                          │
│   ↕ IPC (chỉ lệnh đã định nghĩa)                 │        │  service worker: nhận lệnh, gọi tab    │
│ Main process:                                    │  WS    │  content script (isolated): đọc DOM,   │
│   Runner (hàng đợi, trần song song, đối soát)    │◄──────►│    gõ prompt, chọn option, gắn ref     │
│   Journal SQLite                                 │127.0.0.1│  script MAIN world: ghi listener nút   │
│   Flow driver (dùng packages/flow-protocol)      │ +token │    Gửi, bấm theo intent, theo dõi      │
│   Downloader (ghi file, kiểm magic bytes)        │        │    network, ping (heartbeat)           │
│   WS server cho extension                        │        └────────────────────────────────────────┘
└──────────────────────────────────────────────────┘
```

- **Driver nằm ở desktop**, không ở extension. Extension chỉ có một danh sách lệnh nhỏ cố định (như spike: `state`, `prep`, `radios`, `click`, `fill`, `hit`, `trusted`, `net`, `ping`, `file`, `reloadTab`, `open`…), không có lệnh "chạy JS tuỳ ý". Lệnh đọc và lệnh bấm Gửi là hai lệnh tách biệt (bẫy lượt 29b).
- **Một tiến trình app duy nhất** [em]: dùng khoá single-instance của Electron. Lý do: bỏ được cả lớp bài toán "hai cửa sổ cùng chạy" (TF-06) ở mức máy; vẫn giữ `epoch` cho kết nối extension (extension nối lại thì lệnh cũ bị từ chối). AC-06 vì thế đổi nghĩa: mở app lần hai chỉ đưa cửa sổ cũ lên; hai kết nối extension cùng lúc thì chỉ kết nối mới nhất được nhận lệnh, lệnh mang epoch cũ bị từ chối.
- **Cấu trúc repo** [em]:
  - `packages/flow-protocol/` — đã có: parser RPC, bảng 70 mã lỗi, máy trạng thái attempt, heartbeat, đọc danh sách project + đối soát. Giữ là JS ESM có test; app TypeScript dùng trực tiếp (`allowJs`/khai báo `.d.ts`) [em].
  - `apps/desktop/` — Electron main + renderer.
  - `apps/extension/` — extension MV3 sản phẩm, viết lại từ `spikes/01-flow-cdp/extension` (spike là code dùng một lần, không copy nguyên).
  - `spikes/` giữ nguyên làm bằng chứng.

### 5.2 Ghép đôi app ↔ extension [em]

- App đóng gói sẵn thư mục extension. Lần đầu, app **copy** thư mục đó sang thư mục dữ liệu của app (vì AppImage chỉ đọc và đổi đường dẫn mỗi lần chạy, Program Files cần quyền admin), ghi `pair.json` (cổng + token ngẫu nhiên) vào bản copy, rồi hướng dẫn Sư Huynh mở `chrome://extensions` → bật chế độ nhà phát triển → "Tải tiện ích đã giải nén" (load unpacked) đúng thư mục ấy. Extension đọc `pair.json` bằng `chrome.runtime.getURL`.
- Manifest có trường `key` cố định nên **id extension cố định**; WS server chỉ nhận kết nối có `Origin: chrome-extension://<id đó>` và đúng token.
- Lý do chọn load unpacked: Chrome Web Store sẽ không duyệt extension kiểu này; cài ngoài store bằng file `.crx` bị Chrome trên Windows chặn.
- Cập nhật app → app chép đè bản extension trong thư mục dữ liệu (giữ `pair.json`) → app nhắc "bấm Tải lại tiện ích, rồi tải lại tab Flow". Ping trả **version script MAIN world**; lệch version extension thì chặn gửi (Q-05, Q-34).

### 5.3 Profile có version và self-check [SH, D-06]

Một file dữ liệu (JSON, không phải code) cho mỗi provider: selector theo thao tác, RPC id, đường dẫn các trường trong payload mà parser cần, tên option model nhìn thấy, số version. `packages/flow-protocol` đọc đường dẫn từ đây hoặc giữ hằng số kèm version trùng khớp [builder].

Self-check chạy khi mở app và mỗi lần gắn tab: các selector chính có mặt, nút Gửi có đúng 1 listener, heartbeat sống, observer đã bắt được `Zzl0ze` của lần nạp trang (chứng minh observer thấy request, bù chỗ yếu "heartbeat không chứng minh nhìn thấy request"). Lệch ⇒ `PROTOCOL_DRIFT`, tắt auto, chỉ cho chạy kiểu gửi tay nếu các selector chuẩn bị còn đúng.

## 6. Một lượt chạy (luồng chính)

1. **Chuẩn bị:** xoá composer (`button.clear-button`), chọn mode → model → tỉ lệ → số lượng, **đọc lại mọi option sau mỗi lần đổi mode** (Q-31: tỉ lệ tự nhảy). Gắn ref: upload với **tên file duy nhất** theo `assetId`, lấy media id từ receipt `maseQ`; nếu chip không hiện (Q-32) thì gắn từ thư viện bằng ô tìm kiếm (Q-19, Q-33), không upload lại. Gõ prompt, đọc lại phải khớp **nguyên văn**.
2. **Kiểm trước khi bấm:** nút bật; không có nút cảnh báo credit; chip ref đúng media id; nút Gửi không bị che (`elementFromPoint` ở tâm nút nằm trong `flow-prompt-box`, Q-01); heartbeat sống (≤ 5 s).
3. **Ghi intent** vào journal (commit xong mới đi tiếp).
4. **Bấm** (auto) — hoặc nếu auto tắt: mở tab, báo Sư Huynh bấm Gửi; observer vẫn bắt request như thường.
5. **Receipt:** thấy request generate rời trang (`sent`) → response lặp lại batch UUID + seed → gắn media id. Video: theo dõi poll `jwpduf` tới xong/lỗi.
   - Mỗi tab bấm tuần tự, nên request `sent` đầu tiên sau một lần bấm thuộc về lần bấm đó; chưa thấy `sent` thì không bấm tiếp ở tab đó.
6. **Tải:** desktop tải file (§8), kiểm nội dung, ghi tên thật.

Máy trạng thái của từng attempt đã có code + test: [`attempt.mjs`](../../../packages/flow-protocol/src/attempt.mjs). Runner chỉ được bấm qua `canClick()`.

### 6.1 Khi có chuyện

| Chuyện | Hành động | Chuẩn |
|---|---|---|
| Bị throttle (4 mã trong response generate) | Giảm một nửa số đang chạy; gửi lại đúng lượt đó, chờ 30/60/120/240/300 s, tối đa 5 lần; hết thì pause | [07 §3](../../app/07-safety-and-recovery.md), `errors.mjs` |
| Hết quota / hết credit | Pause cả lô, không đoán lúc reset | ADR-0002 |
| Nội dung bị chặn | Chốt lỗi lượt đó, lô chạy tiếp | ADR-0002 |
| `UNUSUAL_ACTIVITY`, `USER_BANNED` | Tắt auto cả profile, báo Sư Huynh | ADR-0002 |
| Bấm rồi mà không thấy request, mất heartbeat sau khi bấm, app crash | Lượt thành **không rõ**; chặn project đó; **không gửi lại** | D-04, D-11 |
| Lỗi trong lúc render (`INTERNAL`, timeout video) | Chốt lỗi lượt đó (Flow tự hoàn credit); không tự gửi lại | 07 §3 |
| Mã lạ, sai mẫu response | `PROTOCOL_DRIFT`, tắt auto | D-06 |

### 6.2 Lượt "không rõ" và đối soát 10 phút [SH, D-11]

- Lô còn lượt không rõ thì **nhả runner** cho lô khác ở **project khác**; project cũ bị chặn [SH, D-04].
- Hẹn giờ 10 phút lưu trong journal (cột `reconcileAt`), nên app tắt mở vẫn chạy tiếp; quá giờ khi mở app thì chạy ngay.
- Cách đọc [em]: mở **một tab đọc riêng** tới đúng project (không reload tab đang làm việc, đúng contract "đối soát không đụng composer" ở [03 §4](../../app/03-architecture-and-contracts.md)), bắt `Zzl0ze` lúc trang nạp, đóng tab. Khớp bằng [`reconcile()`](../../../packages/flow-protocol/src/project.mjs): biết batch UUID thì khớp thẳng; không biết thì prompt nguyên văn + cùng loại + tạo trong [bấm − 5 s, bấm + 120 s] + chưa thuộc lượt nào.
- Kết quả: **tìm thấy** → gắn kết quả, gỡ chặn. **Mơ hồ / không thấy** → giữ chặn, hiện hai nút "Đã gửi" / "Chưa gửi" cho Sư Huynh. "Không thấy" không có nghĩa là chưa gửi (lượt 35).
- Lượt không rõ **luôn tính đã tiêu credit**. Chỉ khi Sư Huynh chọn mới tạo lượt mới, có liên kết tới lượt cũ. Sau khi project đã gỡ chặn, lượt mới được chạy ngay trên project đó; trong lúc còn chặn thì chỉ được chạy ở project khác. [em]
- Gỡ chặn xong (tìm thấy, hoặc Sư Huynh bấm "Đã gửi"/"Chưa gửi") thì **phần còn lại của lô tự chạy tiếp**, không cần bấm Tiếp tục. [em]
- Nút "Lưu hồ sơ chưa rõ" (D-11) chỉ gắn nhãn `archived_unresolved` cho lô và nhả runner ngay, không chờ 10 phút; điều kiện là tab của lô đó không còn lệnh nào đang chạy (hàng lệnh của tab rỗng, epoch đã tăng). Project vẫn bị chặn tới khi gỡ chặn. [em]

### 6.3 Gửi tay (khi auto tắt — mặc định với mọi cài đặt mới)

- Runner làm đủ bước 1–3 (chuẩn bị, kiểm, ghi intent), đưa tab Flow lên trước và báo "Bấm Gửi trong Flow". Không có hạn chờ: lượt nằm ở `awaiting_user` tới khi thấy request.
- Thấy request `sent` → đi tiếp như auto. `attempt.mjs` cần thêm sự kiện "người dùng đã bấm" (do observer thấy request) thay cho `clicked`. [builder: tên sự kiện]
- Sư Huynh bấm "Bỏ qua lượt này": nếu observer sống suốt từ lúc ghi intent (cùng `id`, `dropped` không tăng) và không có request nào → chốt **chưa gửi**, không chặn project. Observer có lúc chết hoặc mất bản ghi → lượt thành không rõ như §6.2.
- Lô chạy kiểu gửi tay vẫn chuẩn bị sẵn lượt kế tiếp ngay khi thấy request lượt trước.

## 7. Dữ liệu và journal

- SQLite một file trong thư mục dữ liệu app, bật WAL (ghi an toàn khi mất điện giữa chừng ở mức SQLite bảo đảm) [em]. Bảng theo thực thể ở [02 §1](../../app/02-domain-and-state.md): `batch`, `item`, `attempt`, `reference_asset`, `provider_asset_binding`, `output`, `download`, `journal_event`, `target_block`, `account_setting` (công tắc auto + thời điểm xác nhận cảnh báo, theo từng tài khoản Google).
- Mọi thay đổi trạng thái đi qua **một hàm duy nhất** áp `attempt.mjs` rồi ghi trong một transaction, kèm `journal_event`. Giao diện chỉ đọc và gửi lệnh (bảng command ở [03 §3](../../app/03-architecture-and-contracts.md)).
- Ảnh mẫu được copy vào thư mục dữ liệu app (có hash), không giữ đường dẫn gốc [em].
- Prompt, ảnh, lịch sử là dữ liệu cá nhân: không gửi đi đâu; gói chẩn đoán mặc định bỏ prompt/ref ([07 §6](../../app/07-safety-and-recovery.md)).

## 8. Tải file [em]

- **Một đường tải cho cả ảnh và video: `chrome.downloads` qua extension** (spike đã chạy cả hai). Lý do: MP4 video lấy từ `flow.google.com/asb/…` + `=mm,22,15` **cần cookie trình duyệt** (FINDINGS, Kết luận → Tải), nên desktop không tự tải được.
- Extension tải vào thư mục tạm `Downloads/ToolFlow-tmp/` (Chrome chỉ cho ghi trong Downloads). Desktop đọc tên thật bằng `downloads.search` (TobyFlow có thể đổi tên), kiểm magic bytes, rồi **chuyển** file sang thư mục Sư Huynh chọn với tên đã chốt.
- **Không lưu URL có chữ ký** (07 §6). Lúc tải mới lấy URL: ảnh từ tile `img[data-media-id=<mediaId>]` hoặc receipt còn trong bộ nhớ; video theo §8.1.
- 8.1 **CHƯA KIỂM — việc đầu tiên của P3:** nối operation id của video với URL tải. Tile video không có media id; poll không có URL. Hướng thử: danh sách `Zzl0ze` có URL `…/asb/<token>` cho từng media video (gen[5][5], [7][0][8]); kiểm token đó có trùng `asb` trên tile không. Không trùng thì dừng P3 và báo lại.
- Tên file: `{lô}/{stt}_{prompt rút gọn}_{outputId}.{ext}` ([06 §5](../../app/06-assets-and-downloads.md)); chốt tên trước khi tải; không ghi đè; lọc ký tự cấm của cả Windows và Linux.
- Tải chạy song song với việc sinh nội dung. Dòng "xử lý từng item tới khi tải xong rồi mới sang item kế" ở 06 §6 đã lỗi thời từ D-16 — sửa khi duyệt doc này.

## 9. Song song [SH, D-16, D-18]

- Mặc định 1 tab, tối đa 8 video đang render / 12 ảnh đang chạy. Tuỳ chọn "Nhanh": 4 tab, 20 / 30.
- Mỗi tab gửi lần lượt. **Ảnh:** thấy request lượt trước rời trang (`sent`) là gửi lượt sau, không chờ response (response ảnh chính là kết quả, 12–20 s; spike lượt 16, 18 làm vậy và chạy 8 ảnh song song). **Video:** chờ response (receipt) rồi mới gửi lượt sau, vì Flow client tự xếp hàng ~6 s/lượt. Throttle → giảm một nửa, gửi trót lọt thì tăng dần lại. [em, theo spike; dòng "chờ receipt" ở ADR-0002 sửa lại cho khớp]
- Một lô được cấp lượt gửi tại một thời điểm; các lô khác chờ [SH, D-04].
- Tab phụ cho chế độ "Nhanh": app mở thêm tab cùng project qua extension (`open`) [em].

## 10. Giao diện

Màn hình và luồng theo [01](../../app/01-screens-and-flows.md): S1 Phiên trình duyệt, S2 Tạo lô, S3 Hàng đợi + chi tiết lô, S4 Kết quả, S5 Cài đặt; luồng U1, U3–U6.

- Ngôn ngữ giao diện: **tiếng Việt** bản đầu [em].
- Công tắc auto nằm ở S5 theo từng tài khoản, mặc định tắt; bật phải đọc hộp cảnh báo rủi ro ToS/khoá tài khoản [SH, D-19].
- Nhận ra tài khoản [em, CHƯA KIỂM — việc của P1]: đọc email trên nút tài khoản Google của trang (thanh OneGoogle, `aria-label` có email). Đọc không được thì coi là tài khoản lạ: auto tắt. Email đổi giữa lô → dừng lô (01 §2).
- Lượt không rõ hiện ở S3 với: lý do, giờ đối soát kế tiếp, nút "Đã gửi" / "Chưa gửi" / "Chạy lại ở project khác (có thể tốn credit)".
- Bố cục, màu sắc chưa có mockup được duyệt (O-04). Builder dựng giao diện chức năng trước; mockup làm riêng khi Sư Huynh muốn.

## 11. Công nghệ [em, Sư Huynh sửa được]

| Mục | Chọn | Lý do |
|---|---|---|
| Desktop | Electron + TypeScript | [SH, D-13] |
| Giao diện | React + Vite | Phổ biến nhất, nhiều người sửa được |
| SQLite | `better-sqlite3` | Ổn định, đồng bộ, chạy tốt với Electron; cần build lại theo Electron (tự động bằng electron-builder) |
| Đóng gói | electron-builder: NSIS (Windows), AppImage (Linux) | Một công cụ cho cả hai OS |
| Test | `node --test` (như flow-protocol), Playwright cho giao diện Electron | Dùng cái đã có |
| Chrome tối thiểu | Bản đang dùng để qualify (156) trở lên | Chỉ hứa bản đã kiểm |

## 12. Kiểm thử và cổng qualification

- 4 tầng ở [08 §3](../../app/08-acceptance-and-delivery.md). Ca nghiệm thu AC-01 → AC-36. Driver có **sổ đếm số lần bấm** (call ledger) để chứng minh không gửi trùng end-to-end.
- Fake driver dùng **fixture thật** trong `packages/flow-protocol/test/fixtures`; không đưa dữ liệu giả vào báo cáo như kết quả thật.
- Mỗi mode chỉ được bật khi qua checklist [04 §7.1](../../app/04-flow-driver.md) (Q-01 → Q-34) trên live, ghi bằng chứng.

## 13. Các phase đề xuất

Đổi so với [08 §4](../../app/08-acceptance-and-delivery.md): đóng gói lên trước ChatGPT, vì bản phát hành đầu không có ChatGPT [SH, D-15].

| Phase | Nội dung | Qua khi |
|---|---|---|
| P0 — Thiết kế | Doc này được duyệt; sửa các chỗ lệch trong docs/app | Sư Huynh duyệt |
| P1 — Nền móng | Electron shell, SQLite + journal, runner (trần song song, đối soát, restart, gửi tay), extension sản phẩm + ghép đôi, self-check, nhận tài khoản, fake driver | AC-01, 02, 05–11, 17, 18, 20, 22, 23, 29, 30, 32, 35, 36 đạt với fake driver; extension nối/nối lại được trên cả Windows và Linux |
| P2 — Flow ảnh + ảnh có ref + tải | Driver ảnh thật, upload/gắn ref, tải file | AC-03, 04, 12 (ảnh), 14–16, 25, 26, 28, 34 live; mục Q liên quan đạt |
| P3 — Flow video | Nối video ↔ URL tải (§8.1), chụp fixture thật cho RPC khung đầu `eb1hJf`/`nprQif` (parser đang từ chối vì chưa có), video từ prompt, khung đầu, poll, tải MP4 | AC-12 (video) live; Q-08, 13, 14, 17, 22. **Cần credit video**: Profile 2 đang hết |
| P4 — Đóng gói bản đầu | Installer Win/Linux, hướng dẫn cài extension, retention, gói chẩn đoán, chăm chút lỗi | AC-19, 21, 24, 27, 33 + **mọi AC không thuộc ChatGPT** đã đạt + chạy thử trọn vẹn trên cả 2 OS |
| P5 — ChatGPT ảnh | Theo [05](../../app/05-chatgpt-driver.md), D-09 | Phase sau, cần duyệt riêng |

Git: repo local [SH, O-07]; mỗi phase một nhánh, commit theo từng task; push/PR khi Sư Huynh đổi quyết định.

## 14. Để builder tự quyết

Tên file/thư mục code; cách tổ chức component React; cấu trúc bảng SQLite chi tiết và migration; định dạng file profile; cách viết IPC; thư viện UI nhỏ (nút, bảng); log nội bộ; cách mô phỏng Flow trong fake driver — miễn giữ các bất biến ở 02/07 và ADR-0002.

## 15. Còn mở

Reviewer độc lập đã đọc (08/11/2026). Câu đã có đáp án hoặc em tự quyết được ghi thẳng vào §5.1, §5.2, §6, §6.2, §6.3, §8, §9, §10, §13. Hai câu chỉ Sư Huynh trả lời được, đã trả lời 08/11/2026:

- **Mỗi lô chỉ một loại** (ảnh hoặc video) [SH]. Muốn cả hai thì tạo 2 lô, chạy lần lượt (D-04). AC-35 hiểu là: một lô ảnh và một lô video chạy nối nhau, mỗi lô giữ trần riêng.
- **Đối soát không quyết được thì lô đứng chờ** tới khi Sư Huynh bấm "Đã gửi"/"Chưa gửi" [SH]. App không tự tạo project Flow mới. Lô khác đã xếp hàng ở project khác vẫn được chạy (D-04).

Khi doc này được duyệt, sửa cho khớp trong docs/app: 06 §6 (bỏ dòng "xử lý từng item tới khi tải xong"), ADR-0002 (ảnh không chờ receipt), 08 AC-06 và AC-35 (nghĩa mới ở trên), 08 §4 (thứ tự phase mới), 09 (ghi hai quyết định trên thành D-20, D-21).
