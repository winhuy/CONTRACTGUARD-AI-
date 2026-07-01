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

## Khung điểm ổn định

Trước đây nếu bật AI, cùng một hợp đồng có thể ra điểm khác nhau vì LLM có thể diễn giải, tách/gộp finding hoặc tự chấm `readiness.score` khác nhau giữa các lần gọi. Bản hiện tại chỉ dùng AI/rule engine để phát hiện finding; điểm cuối được tính lại bằng rubric cố định `CG-RUBRIC-2026-06-30-v1`.

Nguyên tắc chấm điểm:

- Điểm nền là `96/100`, điểm tối thiểu là `18/100`.
- Mỗi hạng mục hợp đồng chỉ lấy rủi ro nặng nhất để trừ điểm, tránh việc AI tách một lỗi thành nhiều thẻ làm tụt điểm.
- `RED`, `YELLOW`, `GREEN` có mức tác động cố định; các nhóm quan trọng như đặt cọc, chấm dứt, phạt vi phạm, chủ thể và đối tượng có trọng số cao hơn.
- Điểm từ LLM không được dùng trực tiếp; UI hiển thị bảng “Khung điểm ổn định” để giải thích các nhóm bị trừ điểm.

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

...
