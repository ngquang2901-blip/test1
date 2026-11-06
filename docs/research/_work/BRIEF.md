# Brief chung cho các nhánh phân tích ToolFlow

## Đối tượng
- Extension ToolFlow v1.3.138 (MV3), **chỉ đọc**: `/home/nthieuu/.config/google-chrome/Profile 1/Extensions/iicjfgdnngmpfocfanpiammedafmomin/1.3.138_0/`
  - Code được bundle bằng esbuild dạng IIFE, **không obfuscate**: tên class và hàm còn nguyên, log viết bằng tiếng Việt.
  - Gần như mỗi file chỉ có một dòng rất dài. Đọc bằng Python (`re.finditer` rồi cắt một cửa sổ ±N ký tự quanh vị trí khớp). KHÔNG dùng `grep -o '.{0,N}...'` vì sẽ chạy rất chậm.
- Dữ liệu `chrome.storage.local` thật của tài khoản Free, đã che các trường nhạy cảm: `/home/nthieuu/code/ToolFlow/docs/research/_work/storage/*.json`. Ví dụ: `tool_provider_configs.json` chứa selector từng provider, `tool_provider_models.json`, `af_execution_config.json`, `af_system_settings.json`, `af_entitlements.json`, `tool_provider_api_configs.json`, `af_settings.json`, `tool_i18n_vi.json`.
- Báo cáo tổng quan đã có (đọc trước để không lặp lại): `/home/nthieuu/code/ToolFlow/docs/research/toolflow-teardown.md`
- Backend: `https://labs.tool.vn/api/v1`. Extension Bridge `heieobedadlfdkppgagnhfakcdapbfka` **không có trên máy**.

## Quy tắc
- KHÔNG chạy extension, KHÔNG gọi API của Tool, Google, OpenAI hay xAI, KHÔNG generate. Chỉ phân tích tĩnh trên file và JSON trong storage.
- KHÔNG in hay ghi token, secret, email hay IP vào tài liệu.
- Chỉ ghi vào đúng file tài liệu được giao. Có thể dùng scratch dir để làm việc tạm.
- Có thể chạy REA cho nhánh của mình (tuỳ chọn, cần khoảng 2–5 phút):
  `npx -y rea-agents@6.8.0 analyze-javascript-application <thư mục ext> --source-path <file> ... --format json --detail summary --evidence_output <scratch>/x.json`
  Không chạy REA trên cả cây vì file trên 500 KB sẽ timeout.

## Định dạng tài liệu (tiếng Việt, Markdown GFM)
1. `# <số>. <Tên mảng>`, tiếp theo là 3–5 dòng tóm tắt mảng này làm gì.
2. **Bản đồ file**: bảng gồm `file | kích thước | vai trò`.
3. **Luồng hoạt động**: ít nhất một sơ đồ mermaid (sequence hoặc flowchart), cho từng luồng chính, từng bước.
4. **Từng chức năng**: với mỗi chức năng hoặc class quan trọng, ghi rõ nó làm gì, input/output, state lưu ở đâu (key storage, IndexedDB), message/action trao đổi, cấu hình server chi phối (key config), các nhánh lỗi, retry hoặc recovery.
5. Bảng các **message/action**, **storage key**, **config key** liên quan tới mảng.
6. **Trích dẫn nguồn**: `file › Class.method` (thêm `@offset` ký tự khi cần). Trích code ngắn (≤ 300 ký tự) khi nó làm rõ cơ chế.
7. Gắn nhãn độ tin cậy: **[QS]** quan sát trực tiếp trong code hoặc data · **[SL]** suy luận · **[?]** chưa rõ.
8. Kết thúc bằng mục **Điểm đáng học / Điểm yếu** và **Câu hỏi mở**.
Độ dài: viết đủ sâu, thường khoảng 400–900 dòng. Ưu tiên độ chính xác hơn độ dài.
