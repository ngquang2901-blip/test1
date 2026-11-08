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
  SETTINGS_MISMATCH: 'Cài đặt trong Flow khác chế độ đã qualify. Đặt lại mô hình, tỉ lệ, số lượng trong Flow rồi bấm Tiếp tục',
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
  // app
  CONNECTOR_LOST: 'Mất kết nối với extension. Mở lại tab Flow, kiểm tra ở màn Kết nối rồi bấm Tiếp tục',
  ILLEGAL_TRANSITION: 'Trạng thái lượt này không hợp lệ. Xem lịch sử lượt trong Chi tiết rồi báo người bảo trì',
  STORAGE_UNAVAILABLE: 'Không ghi được dữ liệu của app (đầy ổ đĩa hoặc thiếu quyền). Giải phóng chỗ rồi bấm Tiếp tục',
  INTERNAL_ERROR: 'Lỗi nội bộ của app. Xem nhật ký rồi báo người bảo trì',
  INTENT_REFUSED: 'Chưa ghi được ý định gửi nên app không bấm Gửi. Kiểm tra kết nối ở màn Kết nối rồi bấm Tiếp tục',
}
export const hintOf = (code: string | undefined | null): string | undefined => (code && Object.hasOwn(HINTS, code) ? HINTS[code] : undefined)
