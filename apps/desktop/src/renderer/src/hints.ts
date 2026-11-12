// One actionable Vietnamese line per failure/pause code; test/hints.test.ts scans the driver, runner and Flow error table so a new code cannot ship without one.
const UNUSUAL = 'Flow báo hoạt động bất thường. Dừng lại, mở Flow thủ công và đợi; app không tự thử lại'
export const HINTS: Record<string, string> = {
  // reference images
  REF_UPLOAD_UNCERTAIN: 'Ảnh tham chiếu có thể đã tải lên Flow nhưng chưa thấy trong thư viện. Kiểm tra thư viện Flow rồi bấm Tiếp tục (app sẽ KHÔNG tải lại)',
  REF_NO_CHIP: 'Ảnh tham chiếu chưa hiện trong ô nhập của Flow. Xoá ảnh thừa trong ô nhập, kiểm tra thư viện Flow rồi bấm Tiếp tục',
  REF_MISMATCH: 'Ảnh gắn vào Flow không đúng ảnh đã chọn. Xoá ảnh trong ô nhập của Flow rồi bấm Tiếp tục',
  REF_ASSET_MISSING: 'File ảnh tham chiếu đã bị đổi, xoá hoặc không đọc được. Chọn lại ảnh rồi tạo lô mới',
  REF_AMBIGUOUS: 'Thư viện Flow có nhiều ảnh trùng tên. Xoá bản trùng trong thư viện Flow rồi bấm Tiếp tục',
  REF_NOT_FOUND: 'Không thấy ảnh tham chiếu trong thư viện Flow. Kiểm tra thư viện Flow rồi bấm Tiếp tục',
  REF_NO_POPOVER: 'Không mở được bảng chọn ảnh của Flow. Đóng hộp thoại đang mở trong Flow rồi bấm Tiếp tục',
  REF_NO_ADD: 'Flow chưa cho thêm ảnh tham chiếu. Đợi ảnh tải xong trong Flow rồi bấm Tiếp tục',
  REF_ATTACH_ERROR: 'Không gắn được ảnh tham chiếu vào Flow. Tải lại tab Flow rồi bấm Tiếp tục',
  CHIP_MISMATCH: 'Ảnh trong ô nhập của Flow khác với lô này. Xoá ảnh trong ô nhập rồi bấm Tiếp tục',
  COMPOSER_NOT_CLEAR: 'Không xoá sạch được ô nhập của Flow. Xoá thủ công chữ và ảnh trong ô nhập rồi bấm Tiếp tục',
  // page state
  SETTINGS_MISMATCH: 'Flow không nhận đúng cài đặt của lô này (mô hình, tỉ lệ, số ảnh). Xem tài khoản Flow có mô hình đó không, hoặc tự đặt trong Flow rồi bấm Tiếp tục',
  PROMPT_MISMATCH: 'Prompt trong ô nhập của Flow không khớp. Xoá ô nhập, đừng gõ vào Flow khi app đang chạy, rồi bấm Tiếp tục',
  COMBO_NOT_QUALIFIED: 'Tổ hợp mô hình/cài đặt chưa được qualify nên app không chạy. Chọn chế độ đã qualify rồi tạo lại lô',
  UNEXPECTED_GENERATE: 'Flow vừa tạo thứ app không gửi. Xem Flow có đang tạo ảnh/video không, đợi xong rồi bấm Tiếp tục',
  NO_PROJECT_TAB: 'Chưa có tab dự án Flow được cấp quyền. Mở dự án Flow, vào màn Kết nối và bấm “Dùng tab này”',
  COVERED: 'Có hộp thoại che nút Gửi trong Flow. Đóng nó rồi bấm Tiếp tục',
  CREDIT_WARNING: 'Flow báo không đủ credit. Kiểm tra credit rồi bấm Tiếp tục',
  BUTTON_DISABLED: 'Nút Gửi của Flow đang bị khoá. Đợi hoặc kiểm tra ô nhập rồi bấm Tiếp tục',
  TARGET_CHANGED: 'Tab Flow đã chuyển sang dự án khác. Quay lại đúng dự án rồi bấm Tiếp tục',
  CONFIG_INCOMPLETE: 'Trang Flow khác bản app đã kiểm. Tải lại tab Flow và kiểm tra ở màn Kết nối',
  PROTOCOL_DRIFT: 'Flow đổi định dạng dữ liệu. Dừng chạy tự động và báo người bảo trì',
  // Flow answers
  HUMAN_REQUIRED: UNUSUAL,
  UNUSUAL_ACTIVITY: UNUSUAL,
  RATE_LIMIT: 'Flow đang giới hạn tốc độ hoặc hết hạn mức. Đợi một lúc rồi bấm Tiếp tục',
  CONTENT_BLOCKED: 'Flow chặn prompt hoặc ảnh này. Sửa prompt/ảnh rồi tạo lô mới',
  CAPABILITY_UNAVAILABLE: 'Flow không hỗ trợ yêu cầu này (mô hình, kích thước ảnh hoặc quyền). Kiểm tra cài đặt/ảnh rồi tạo lại',
  PROVIDER_ERROR_UNKNOWN: 'Flow báo lỗi không rõ. Mở Flow kiểm tra xem có kết quả không trước khi chạy lại',
  UPLOAD_NOT_VERIFIED: 'Chưa xác nhận được file đã tải lên Flow. Kiểm tra thư viện Flow trước khi chạy lại',
  SUBMIT_UNCERTAIN: 'Không rõ Flow đã nhận lượt này chưa. Mở Flow kiểm tra rồi chọn “Đã gửi” hoặc “Chưa gửi”',
  USER_INTERFERENCE: 'Prompt gửi đi khác prompt của lô (có thể do bạn gõ trong Flow). Kiểm tra Flow rồi xác nhận',
  RESULT_OWNERSHIP_AMBIGUOUS: 'Không chắc kết quả này của lượt nào. Mở Flow đối chiếu rồi xác nhận',
  // download
  DOWNLOAD_NOT_IMAGE: 'Flow trả về thứ không phải ảnh (trang lỗi hoặc file rỗng). Đã xoá file tạm, bấm Thử lại; kiểm tra tab Flow còn đăng nhập',
  DOWNLOAD_NOT_VIDEO: 'Flow trả về thứ không phải video (ảnh xem trước, trang lỗi hoặc file rỗng). Đã xoá file tạm, bấm Thử lại; nếu vẫn vậy thì tải lại tab Flow rồi Thử lại',
  DOWNLOAD_ACK_LOST: 'Chưa rõ lần tải trước đã chạy chưa. Kiểm tra thư mục Downloads/ToolFlow rồi bấm Thử lại (app sẽ tìm file cũ trước khi tải mới)',
  DOWNLOAD_TIMEOUT: 'Trình duyệt tải quá lâu. Xem mục Tải xuống của Chrome rồi bấm Thử lại',
  DOWNLOAD_RECONCILE_FAILED: 'Không hỏi được trình duyệt về lần tải này. Kiểm tra kết nối ở màn Kết nối rồi bấm Thử lại',
  DOWNLOAD_BAD_PATH: 'Trình duyệt báo file ở chỗ lạ nên app không đụng tới. Bấm Thử lại',
  DOWNLOAD_BAD_FILE: 'File tạm không phải file thường (lối tắt hoặc thư mục) nên app không đụng tới. Bấm Thử lại',
  DOWNLOAD_MOVE_FAILED: 'Không chuyển được file vào thư mục đích (đầy ổ đĩa hoặc thiếu quyền). Giải phóng chỗ rồi bấm Thử lại, không phải tải lại',
  DOWNLOAD_FILE_MISSING: 'File tạm đã biến mất trước khi kiểm tra. Bấm Thử lại',
  DOWNLOAD_INTERRUPTED: 'Lần tải bị ngắt giữa chừng. Bấm Thử lại',
  DOWNLOAD_REFUSED: 'Trình duyệt từ chối tải. Kiểm tra extension và quyền tải xuống rồi bấm Thử lại',
  DOWNLOAD_BAD_ID: 'Mã ảnh không hợp lệ nên extension từ chối. Báo người bảo trì',
  DOWNLOAD_NOT_FOUND: 'Không thấy ảnh này trên tab Flow đang mở. Mở đúng dự án của lô, đợi ảnh hiện rồi bấm Thử lại',
  DOWNLOAD_AMBIGUOUS: 'Tab Flow có nhiều ảnh trùng mã. Tải lại tab Flow rồi bấm Thử lại',
  DOWNLOAD_SRC_NOT_ALLOWED: 'Ảnh trên tab Flow nằm ở địa chỉ lạ nên extension không tải. Tải lại tab Flow rồi bấm Thử lại',
  DOWNLOAD_NO_CONTENT_SCRIPT: 'Tab Flow chưa nạp extension. Tải lại tab Flow (F5) rồi bấm Thử lại',
  PATH_ESCAPE: 'Thư mục đích trỏ ra ngoài vùng được phép nên app không lưu. Kiểm tra thư mục Downloads/ToolFlow',
  PATH_TOO_LONG: 'Đường dẫn thư mục đích quá dài. Chọn thư mục ngắn hơn',
  DOWNLOAD_NOT_CHATGPT_TAB: 'Tab dùng để tải không còn là ChatGPT. Mở lại chatgpt.com rồi bấm Thử lại',
  DOWNLOAD_FETCH_FAILED: 'Không đọc được ảnh trên trang ChatGPT. Tải lại tab ChatGPT (F5), đợi ảnh hiện rồi bấm Thử lại',
  DOWNLOAD_NOT_GEMINI_TAB: 'Tab dùng để tải không còn là Gemini. Mở lại gemini.google.com rồi bấm Thử lại',
  DOWNLOAD_NO_FULL_SIZE: 'Đã bấm nút tải ảnh cỡ đầy đủ của Gemini nhưng trang không lấy được file. Mở tab Gemini xem ảnh còn đó không, tải lại tab (F5) rồi bấm Thử lại',
  DOWNLOAD_BUSY: 'Nút tải ảnh của Gemini đang bận (đang tải ảnh này). Đợi một lúc rồi bấm Thử lại',
  // ChatGPT
  NO_CHATGPT_TAB: 'Chưa thấy tab ChatGPT nào. Mở chatgpt.com trong Chrome có extension ToolFlow, đăng nhập, rồi bấm Tiếp tục',
  GPT_CONVERSATION_CHANGED: 'Tab ChatGPT đã chuyển sang cuộc trò chuyện khác nên app không gõ vào đó. Bấm Tiếp tục: app mở lại cuộc trò chuyện của lô rồi gửi tiếp',
  GPT_PAGE_NOT_READY: 'Trang ChatGPT chưa hiện ô nhập. Kiểm tra tab ChatGPT đã đăng nhập và tải xong rồi bấm Tiếp tục',
  GPT_TAB_HIDDEN: 'Tab ChatGPT không hiện được trên màn hình (cửa sổ Chrome bị thu nhỏ, che kín hoặc ở màn hình ảo khác) nên ChatGPT không mở được menu. Đưa cửa sổ đó ra trước rồi bấm Tiếp tục',
  GPT_NO_IMAGE: 'ChatGPT trả lời mà không có ảnh (thường do hết lượt tạo ảnh hoặc prompt bị từ chối). Mở tab ChatGPT đọc câu trả lời; bấm Tiếp tục để gửi các prompt còn lại',
  GPT_NO_EDITOR: 'Không thấy ô nhập của ChatGPT. Tải lại tab ChatGPT (F5), kiểm tra đã đăng nhập rồi bấm Tiếp tục',
  GPT_NO_PLUS: 'Không thấy nút “+” trong ô nhập của ChatGPT. App mới chạy với ChatGPT giao diện tiếng Anh: đổi ngôn ngữ ChatGPT sang English rồi bấm Tiếp tục',
  GPT_MODE_NOT_FOUND: 'Không thấy mục “Create image” trong menu “+” của ChatGPT. Kiểm tra đã đăng nhập và ChatGPT đang ở giao diện tiếng Anh rồi bấm Tiếp tục',
  GPT_MODE_NOT_SET: 'ChatGPT chưa bật chế độ tạo ảnh. Tải lại tab ChatGPT (F5) rồi bấm Tiếp tục',
  GPT_OTHER_MODE: 'Ô nhập của ChatGPT đang bật một công cụ khác. Bỏ công cụ đó trong ô nhập rồi bấm Tiếp tục',
  GPT_COMPOSER_NOT_EMPTY: 'Ô nhập của ChatGPT đang có chữ nên app không ghi đè. Xoá chữ trong ô nhập rồi bấm Tiếp tục',
  GPT_PROMPT_MISMATCH: 'Chữ trong ô nhập của ChatGPT không khớp prompt của lô. Xoá ô nhập, đừng gõ vào ChatGPT khi app đang chạy, rồi bấm Tiếp tục',
  GPT_NO_SEND: 'Không thấy nút Gửi của ChatGPT. Xoá chữ trong ô nhập, tải lại tab ChatGPT (F5) rồi bấm Tiếp tục',
  GPT_SEND_DISABLED: 'Nút Gửi của ChatGPT đang bị khoá. Xoá chữ trong ô nhập, đợi ChatGPT trả lời xong rồi bấm Tiếp tục',
  // app
  CONNECTOR_LOST: 'Mất kết nối với extension. Mở lại tab Flow, kiểm tra ở màn Kết nối rồi bấm Tiếp tục',
  ILLEGAL_TRANSITION: 'Trạng thái lượt này không hợp lệ. Xem lịch sử lượt trong Chi tiết rồi báo người bảo trì',
  STORAGE_UNAVAILABLE: 'Không ghi được dữ liệu của app (đầy ổ đĩa hoặc thiếu quyền). Giải phóng chỗ rồi bấm Tiếp tục',
  INTERNAL_ERROR: 'Lỗi nội bộ của app. Xem nhật ký rồi báo người bảo trì',
  INTENT_REFUSED: 'Chưa ghi được ý định gửi nên app không bấm Gửi. Kiểm tra kết nối ở màn Kết nối rồi bấm Tiếp tục',
}
/** The line for a code; for a ChatGPT batch the site named in it is ChatGPT (the shared lines were written for Flow). */
export const hintOf = (code: string | undefined | null, provider?: string): string | undefined => {
  const h = code && Object.hasOwn(HINTS, code) ? HINTS[code] : undefined
  if (!h || !provider || provider === 'flow') return h
  if (provider === 'gemini') return (Object.hasOwn(GEMINI, code!) ? GEMINI[code!] : h).replace(/chatgpt\.com/g, 'gemini.google.com').replace(/ChatGPT|(?<![A-Za-z])Flow/g, 'Gemini')
  return h.replace(/(?<![A-Za-z])Flow/g, 'ChatGPT')
}
// Gemini is driven by icon names, not labels: the lines that give ChatGPT's English-UI advice read differently for it.
const GEMINI: Record<string, string> = {
  GPT_NO_PLUS: 'Không thấy nút “+” trong ô nhập của Gemini. Tải lại tab Gemini (F5), kiểm tra đã đăng nhập rồi bấm Tiếp tục',
  GPT_MODE_NOT_FOUND: 'Không thấy mục tạo hình ảnh trong menu “+” của Gemini. Kiểm tra tài khoản Gemini có tính năng tạo ảnh, tải lại tab (F5) rồi bấm Tiếp tục',
}
