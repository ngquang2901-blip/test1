# ToolFlow

Tài liệu thiết kế ứng dụng tự động hoá **Google Flow + ChatGPT** bằng phiên trình duyệt của người dùng.

**Bắt đầu tại [bộ tài liệu app](docs/app/README.md).** Đây là bản thiết kế đề xuất để Sư Huynh thiết kế sản phẩm; chưa có mã ứng dụng và chưa phê duyệt triển khai.

- [Sản phẩm và phạm vi](docs/app/00-product-scope.md).
- [Màn hình và luồng người dùng](docs/app/01-screens-and-flows.md).
- [Nghiệm thu và lộ trình](docs/app/08-acceptance-and-delivery.md).
- [Quyết định đã có / đề xuất / còn mở](docs/app/09-evidence-and-decisions.md).
- [Tài liệu nghiên cứu triển khai nội bộ](docs/research/README.md): tài liệu tham khảo, không phải đặc tả sản phẩm.

Bridge, Max Speed và native RPC Flow đang **tạm gác**, không là điều kiện của bản đầu. Không có phụ thuộc bắt buộc vào tài khoản, backend hay kho cấu hình của bên thứ ba.

Kiểm tính nhất quán của tài liệu, không gọi provider:

```sh
python3 docs/app/verify-docs.py
```
