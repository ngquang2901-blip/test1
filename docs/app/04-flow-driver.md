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

**Nguồn:** [Flow DOM](../research/04-google-flow-dom-v1.md), [config/runtime](../research/16-flow-gpt-runtime-findings.md). Nghiên cứu cho thấy các control/selector tồn tại ở snapshot, chưa chứng minh driver ToolFlow hoạt động. [Native RPC](../research/17-flow-native-public-frontend.md) chỉ lưu làm tham khảo ngoài scope.
