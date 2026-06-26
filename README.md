# ContractGuard AI Demo

Prototype local cho luồng rà soát hợp đồng của ContractGuard AI.

## Chạy dự án

```bash
npm run dev
```

Mở `http://localhost:4173`.

## OCR cho PDF scan

Trên macOS, cài Tesseract và bộ ngôn ngữ:

```bash
brew install tesseract tesseract-lang
```

Backend sẽ tự tìm `/opt/homebrew/bin/tesseract` hoặc `/usr/local/bin/tesseract`. Nếu cần chỉ định thủ công:

```bash
CONTRACTGUARD_TESSERACT=/opt/homebrew/bin/tesseract npm run dev
```

## Tính năng trong bản MVP

- Upload DOCX/TXT/PDF tối đa 80MB hoặc dùng hợp đồng mẫu.
- PDF dài 30-40 trang được trích xuất bằng `pdfplumber`/`pypdf`; PDF scan ảnh fallback sang Tesseract OCR `vie+eng`.
- Ẩn thông tin nhạy cảm như CCCD, số điện thoại, số tài khoản và mã số thuế.
- Quét deterministic rule engine theo checklist 40 hạng mục.
- Hiển thị split-view: văn bản hợp đồng có highlight và thẻ hành động Đỏ/Vàng/Xanh.
- Phân tích sâu: readiness, exposure tài chính, timeline nghĩa vụ, điều khoản còn thiếu và ưu tiên sửa.
- Chuyển động UI mượt hơn khi quét, hover, filter và nhảy tới đoạn highlight.
- Xuất báo cáo bằng chức năng in của trình duyệt.

Lưu ý: đây là demo hỗ trợ rà soát rủi ro, chưa thay thế tư vấn pháp lý chuyên nghiệp.

## Cấu hình Git & Đẩy dự án lên GitHub/GitLab

Dự án đã được cấu hình sẵn tệp `.gitignore` để loại bỏ các tệp nhạy cảm (như `.env` chứa API Key), các thư mục tạm và tệp build.

Để đẩy dự án lên kho chứa từ xa (remote repository):

1. **Khởi tạo và commit các tệp hiện tại:**
   ```bash
   git add .
   git commit -m "Initial commit: Setup project for Git"
   ```

2. **Liên kết với repo từ xa (Ví dụ trên GitHub):**
   - Tạo một repository mới trên GitHub (không tạo README hay .gitignore mới).
   - Chạy lệnh sau để đổi tên nhánh mặc định thành `main` và thêm URL repo của bạn:
     ```bash
     git branch -M main
     git remote add origin <URL_REPOSITORY_CỦA_BẠN>
     ```

3. **Đẩy mã nguồn lên:**
   ```bash
   git push -u origin main
   ```

*Lưu ý: Tệp `.env` đã được bỏ qua không đưa lên Git để bảo mật API Key của bạn. Người dùng khác tải dự án về cần sao chép tệp `.env.example` thành tệp `.env` mới và điền `GEMINI_API_KEY` của họ.*

