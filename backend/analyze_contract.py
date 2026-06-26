#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


WORD_NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def load_env() -> None:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        try:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    os.environ[key.strip()] = val.strip().strip('"').strip("'")
        except Exception as e:
            print(f"Lỗi khi đọc tệp .env: {e}", file=sys.stderr)


load_env()

MIN_EXTRACTED_TEXT_CHARS = 80
OCR_DPI = 200
OCR_PAGE_TIMEOUT_SECONDS = 35
BUNDLED_BIN_DIR = (
    Path.home()
    / ".cache"
    / "codex-runtimes"
    / "codex-primary-runtime"
    / "dependencies"
    / "bin"
)

CHECKLIST = [
    "Chủ thể hợp đồng",
    "Tư cách pháp lý chủ thể",
    "Người ký hợp đồng",
    "Giấy ủy quyền",
    "Ngành nghề kinh doanh",
    "Đối tượng hợp đồng",
    "Tính hợp pháp đối tượng",
    "Số lượng / Khối lượng",
    "Chất lượng / Tiêu chuẩn",
    "Thời hạn thực hiện",
    "Địa điểm thực hiện",
    "Giá trị hợp đồng",
    "Điều kiện thanh toán",
    "Thời hạn thanh toán",
    "Hồ sơ thanh toán",
    "Chậm thanh toán",
    "Quyền & nghĩa vụ",
    "Nghĩa vụ phối hợp",
    "Nghiệm thu / bàn giao",
    "Mặc định nghiệm thu",
    "Phạt vi phạm",
    "Giới hạn mức phạt thương mại",
    "Bồi thường thiệt hại",
    "Thiệt hại được bồi thường",
    "Giới hạn trách nhiệm",
    "Đặt cọc và hoàn cọc",
    "Đơn phương chấm dứt",
    "Gia hạn hợp đồng",
    "Bất khả kháng",
    "Bảo mật dữ liệu cá nhân",
    "Tài sản kèm theo",
    "Sửa chữa / bảo trì",
    "Quyền kiểm tra tài sản",
    "Chuyển nhượng / cho thuê lại",
    "Thuế, phí, lệ phí",
    "Thông báo vi phạm",
    "Cơ quan giải quyết tranh chấp",
    "Hiệu lực và phụ lục",
    "Mâu thuẫn nội bộ điều khoản",
    "Ngôn ngữ dễ hiểu cho người ký",
]


def compact(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def fold_vietnamese(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    stripped = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    return stripped.replace("đ", "d").replace("Đ", "D").lower()


def text_from_docx_node(node: ET.Element) -> str:
    chunks: list[str] = []
    for child in node.iter():
        if child.tag == f"{{{WORD_NS['w']}}}t" and child.text:
            chunks.append(child.text)
        elif child.tag == f"{{{WORD_NS['w']}}}tab":
            chunks.append("\t")
        elif child.tag in {f"{{{WORD_NS['w']}}}br", f"{{{WORD_NS['w']}}}cr"}:
            chunks.append("\n")
    return "".join(chunks)


def extract_docx(path: Path) -> str:
    with zipfile.ZipFile(path) as docx:
        xml = docx.read("word/document.xml")

    root = ET.fromstring(xml)
    body = root.find("w:body", WORD_NS)
    if body is None:
        return ""

    parts: list[str] = []
    for child in body:
        if child.tag == f"{{{WORD_NS['w']}}}p":
            text = text_from_docx_node(child).strip()
            if text:
                parts.append(text)
        elif child.tag == f"{{{WORD_NS['w']}}}tbl":
            rows: list[str] = []
            for row in child.findall(".//w:tr", WORD_NS):
                cells = []
                for cell in row.findall("./w:tc", WORD_NS):
                    cell_text = compact(text_from_docx_node(cell))
                    cells.append(cell_text)
                if any(cells):
                    rows.append(" | ".join(cells))
            if rows:
                parts.append("\n".join(rows))
    return "\n\n".join(parts)


def extract_pdf_with_pdftotext(path: Path) -> str:
    executable = find_binary("pdftotext", "CONTRACTGUARD_PDFTOTEXT")
    if not executable:
        return ""

    with tempfile.NamedTemporaryFile(suffix=".txt") as tmp:
        subprocess.run(
            [executable, "-layout", str(path), tmp.name],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return Path(tmp.name).read_text(encoding="utf-8", errors="replace")


def find_binary(name: str, env_var: str = "", candidates: list[str] | None = None) -> str:
    paths: list[str] = []
    if env_var:
        configured = os.environ.get(env_var, "").strip()
        if configured:
            paths.append(configured)

    paths.append(str(BUNDLED_BIN_DIR / name))
    paths.extend(candidates or [])
    found = shutil.which(name)
    if found:
        paths.append(found)

    for value in paths:
        if value and Path(value).exists():
            return value
    return ""


def normalize_pdf_page_text(page_text: str) -> str:
    chunks: list[str] = []
    current: list[str] = []

    def flush() -> None:
        if current:
            chunks.append(compact(" ".join(current)))
            current.clear()

    for raw_line in page_text.splitlines():
        line = compact(raw_line)
        if not line:
            flush()
            continue

        starts_new_clause = bool(
            re.match(
                r"^(?:Điều\s+\d+\.|\d+\.\s|[a-zđ]\)\s|[IVX]+\.\s|-\s|"
                r"CỘNG HÒA|Độc lập|HỢP ĐỒNG|Số\s+\d|BÊN\s|BÊN THUÊ|BÊN CHO THUÊ)",
                line,
                re.IGNORECASE,
            )
        )
        current_length = len(" ".join(current))
        if current and (starts_new_clause or current_length > 520):
            flush()
        current.append(line)

    flush()
    return "\n\n".join(chunks)


def extract_pdf_with_pdfplumber(path: Path) -> str:
    import pdfplumber

    parts: list[str] = []
    with pdfplumber.open(path) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            page_text = page.extract_text(x_tolerance=1, y_tolerance=3) or ""
            normalized = normalize_pdf_page_text(page_text)
            if compact(normalized):
                parts.append(f"[Trang {index}]\n\n{normalized}")
    return "\n\n".join(parts)


def extract_pdf_with_pypdf(path: Path) -> str:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:
            return ""

    parts: list[str] = []
    for index, page in enumerate(reader.pages, start=1):
        page_text = page.extract_text() or ""
        normalized = normalize_pdf_page_text(page_text)
        if compact(normalized):
            parts.append(f"[Trang {index}]\n\n{normalized}")
    return "\n\n".join(parts)


def ocr_languages(tesseract: str) -> str:
    try:
        result = subprocess.run(
            [tesseract, "--list-langs"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
        )
    except Exception:
        return "eng"

    langs = {line.strip() for line in result.stdout.splitlines() if line.strip() and not line.startswith("List of")}
    if {"vie", "eng"}.issubset(langs):
        return "vie+eng"
    if "vie" in langs:
        return "vie"
    if "eng" in langs:
        return "eng"
    return next(iter(langs), "eng")


def rendered_page_number(path: Path) -> int:
    match = re.search(r"-(\d+)\.png$", path.name)
    return int(match.group(1)) if match else 0


def extract_pdf_with_ocr(path: Path) -> str:
    pdftoppm = find_binary("pdftoppm", "CONTRACTGUARD_PDFTOPPM")
    tesseract = find_binary(
        "tesseract",
        "CONTRACTGUARD_TESSERACT",
        ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"],
    )
    if not pdftoppm or not tesseract:
        missing = []
        if not pdftoppm:
            missing.append("pdftoppm")
        if not tesseract:
            missing.append("tesseract")
        raise RuntimeError(f"Thiếu OCR dependency: {', '.join(missing)}")

    languages = ocr_languages(tesseract)
    with tempfile.TemporaryDirectory(prefix="contractguard-ocr-") as temp_dir:
        prefix = Path(temp_dir) / "page"
        subprocess.run(
            [
                pdftoppm,
                "-r",
                str(OCR_DPI),
                "-png",
                "-gray",
                str(path),
                str(prefix),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )

        parts: list[str] = []
        images = sorted(Path(temp_dir).glob("page-*.png"), key=rendered_page_number)
        for fallback_index, image in enumerate(images, start=1):
            page_number = rendered_page_number(image) or fallback_index
            result = subprocess.run(
                [tesseract, str(image), "stdout", "-l", languages, "--psm", "6"],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=OCR_PAGE_TIMEOUT_SECONDS,
            )
            normalized = normalize_pdf_page_text(result.stdout)
            if compact(normalized):
                parts.append(f"[Trang {page_number} - OCR]\n\n{normalized}")
        return "\n\n".join(parts)


def extract_pdf_with_gemini(path: Path) -> str:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return ""

    import google.generativeai as genai

    genai.configure(api_key=api_key)

    print(f"Đang gửi {path.name} tới Gemini API để xử lý OCR...", file=sys.stderr)
    try:
        model = genai.GenerativeModel("gemini-2.5-flash")
        prompt = (
            "Bạn là một chuyên gia số hóa tài liệu. Hãy trích xuất toàn bộ văn bản từ tài liệu PDF này "
            "một cách chính xác, giữ nguyên cấu trúc các điều khoản (Điều 1, Điều 2...), tiêu đề và nội dung. "
            "Nếu có bảng biểu trong tài liệu, hãy chuyển đổi chúng thành dạng bảng Markdown chuẩn (bao gồm tiêu đề cột và dòng) để giữ nguyên cấu trúc thông tin. "
            "Không thêm bất kỳ lời bình luận hay giải thích nào."
        )
        response = model.generate_content([
            {
                "mime_type": "application/pdf",
                "data": path.read_bytes()
            },
            prompt
        ])
        return response.text
    except Exception as e:
        raise RuntimeError(f"Gửi inline PDF tới Gemini API thất bại: {e}")


def is_garbage_cid_text(text: str) -> bool:
    return text.count("(cid:") > 3


def is_gibberish_text(text: str) -> bool:
    # Fold accents and make lowercase
    folded = fold_vietnamese(text).lower()
    
    # Common signature tokens that almost always appear in valid contracts
    tokens = {
        "hop", "dong", "ben", "dieu", "thue", "nha", "ngay", "luat", "quyen", "nghia", "vu",
        "contract", "agreement", "party", "parties", "lease", "rent", "payment", "shall", "clause", "document"
    }
    
    found_tokens = 0
    for token in tokens:
        pattern = r"\b" + re.escape(token) + r"\b"
        if re.search(pattern, folded):
            found_tokens += 1
            if found_tokens >= 3:
                return False
                
    return True


def extract_pdf(path: Path) -> str:
    errors: list[str] = []
    extractors = [
        ("pdftotext", extract_pdf_with_pdftotext),
        ("pdfplumber", extract_pdf_with_pdfplumber),
        ("pypdf", extract_pdf_with_pypdf),
        ("gemini-ocr", extract_pdf_with_gemini),
        ("tesseract-ocr", extract_pdf_with_ocr),
    ]

    for name, extractor in extractors:
        try:
            text = extractor(path)
        except Exception as error:
            errors.append(f"{name}: {error}")
            continue

        if len(compact(text)) >= MIN_EXTRACTED_TEXT_CHARS:
            if is_garbage_cid_text(text):
                errors.append(f"{name}: Văn bản trích xuất chứa lỗi mã hóa font (cid)")
                continue
            if is_gibberish_text(text):
                errors.append(f"{name}: Văn bản trích xuất chứa lỗi ánh xạ ký tự (gibberish)")
                continue
            return text

    details = "; ".join(errors[-2:]) if errors else "không tìm thấy lớp chữ trong PDF"
    msg = (
        "Không trích xuất được chữ từ PDF. File có thể là PDF scan ảnh, bị khóa, "
        "hoặc chữ quá mờ. Hãy dùng PDF có text layer, DOCX, hoặc dán nội dung hợp đồng. "
        f"Chi tiết kỹ thuật: {details}"
    )
    if not os.environ.get("GEMINI_API_KEY"):
        msg += "\n\nGợi ý: Bạn có thể cấu hình GEMINI_API_KEY trong tệp .env ở thư mục gốc để kích hoạt tính năng Gemini OCR trích xuất tự động cực kỳ chính xác từ PDF scan."
    raise ValueError(msg)


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".docx":
        return extract_docx(path)
    if suffix == ".pdf":
        return extract_pdf(path)
    return path.read_text(encoding="utf-8", errors="replace")


def redact_pii(text: str) -> tuple[str, dict[str, int]]:
    counts = {"cccd": 0, "phone": 0, "bankAccount": 0, "taxCode": 0}

    def replace_labelled(label_pattern: str, replacement: str, key: str, value: str) -> str:
        pattern = re.compile(label_pattern, re.IGNORECASE | re.MULTILINE)

        def repl(match: re.Match[str]) -> str:
            counts[key] += 1
            return f"{match.group(1)}{replacement}"

        return pattern.sub(repl, value)

    redacted = text
    redacted = replace_labelled(
        r"((?:Thẻ căn cước công dân|căn cước công dân|CCCD|hộ chiếu)[^:\n]*:\s*)([0-9][0-9 ]{8,18}[0-9])",
        "[CCCD đã ẩn]",
        "cccd",
        redacted,
    )
    redacted = replace_labelled(
        r"((?:Điện thoại liên hệ|Điện thoại|SĐT|số điện thoại)[^:\n]*:\s*)([+0-9][+0-9 .-]{6,16}[0-9])",
        "[SĐT đã ẩn]",
        "phone",
        redacted,
    )
    redacted = replace_labelled(
        r"((?:Số tài khoản)[^:\n]*:\s*)([0-9][0-9 ]{6,22}[0-9])",
        "[STK đã ẩn]",
        "bankAccount",
        redacted,
    )
    redacted = replace_labelled(
        r"((?:Mã số thuế)[^:\n]*:\s*)([0-9][0-9 -]{6,16}[0-9])",
        "[MST đã ẩn]",
        "taxCode",
        redacted,
    )

    # Catch remaining long identity-like digit runs after labelled fields.
    def generic_identity(match: re.Match[str]) -> str:
        counts["cccd"] += 1
        return "[dãy số nhạy cảm đã ẩn]"

    redacted = re.sub(r"(?<!\d)\d{12}(?!\d)", generic_identity, redacted)
    return redacted, counts


def paragraphs(text: str) -> list[str]:
    return [compact(part) for part in re.split(r"\n\s*\n", text) if compact(part)]


def first_para(parts: list[str], *needles: str) -> str:
    folded_needles = [fold_vietnamese(needle) for needle in needles]
    for part in parts:
        folded = fold_vietnamese(part)
        if all(needle in folded for needle in folded_needles):
            return part
    return ""


def first_para_any(parts: list[str], groups: list[list[str]]) -> str:
    for group in groups:
        found = first_para(parts, *group)
        if found:
            return found
    return ""


def percent_per_day(value: str) -> float | None:
    match = re.search(r"(\d+(?:[,.]\d+)?)\s*%\s*/\s*ngày", value, re.IGNORECASE)
    if not match:
        return None
    return float(match.group(1).replace(",", "."))


def penalty_percent(value: str) -> float | None:
    match = re.search(r"phat[^.\n]{0,80}?(\d+(?:[,.]\d+)?)\s*%", fold_vietnamese(value), re.IGNORECASE)
    if not match:
        return None
    return float(match.group(1).replace(",", "."))


def money_values(value: str) -> list[int]:
    amounts: list[int] = []
    for match in re.finditer(r"(?<!\d)(\d{1,3}(?:[.,]\d{3})+|\d{6,})(?:\s*đồng)?", value, re.IGNORECASE):
        raw = match.group(1).replace(".", "").replace(",", "")
        try:
            amounts.append(int(raw))
        except ValueError:
            continue
    return amounts


def format_vnd(value: int | None) -> str:
    if not value:
        return "Chưa xác định"
    return f"{value:,}".replace(",", ".") + " đ"


def first_money_near(text: str, *needles: str) -> int | None:
    for part in paragraphs(text):
        folded = fold_vietnamese(part)
        if all(fold_vietnamese(needle) in folded for needle in needles):
            values = money_values(part)
            if values:
                return values[0]
    return None


def extract_timeline(text: str) -> list[dict[str, str]]:
    timeline: list[dict[str, str]] = []
    payment = re.search(r"chậm nhất vào ngày\s+(\d{1,2})", text, re.IGNORECASE)
    if payment:
        timeline.append(
            {
                "label": "Hạn trả tiền thuê",
                "value": f"Ngày {payment.group(1).zfill(2)} hằng tháng",
                "risk": "Cần giữ chứng từ thanh toán đúng hạn.",
            }
        )

    late = re.search(r"chậm thanh toán quá\s+(\d{1,2})\s+ngày", text, re.IGNORECASE)
    if late:
        timeline.append(
            {
                "label": "Mốc phát sinh lãi chậm trả",
                "value": f"Sau {late.group(1)} ngày chậm thanh toán",
                "risk": "Nên ghi rõ ngày bắt đầu tính lãi.",
            }
        )

    termination = re.search(r"chậm thanh toán quá\s+(\d{1,2})\s+ngày[^.]{0,120}chấm dứt", text, re.IGNORECASE)
    if termination:
        timeline.append(
            {
                "label": "Mốc có thể bị chấm dứt",
                "value": f"Sau {termination.group(1)} ngày chậm thanh toán",
                "risk": "Cần thống nhất lại với Điều 10 để tránh mâu thuẫn.",
            }
        )

    handover = re.search(r"Thời điểm giao nhận nhà ở:\s*([^.\n]+)", text, re.IGNORECASE)
    if handover:
        timeline.append(
            {
                "label": "Giao nhận tài sản",
                "value": compact(handover.group(1)),
                "risk": "Nên ký biên bản bàn giao kèm ảnh hiện trạng.",
            }
        )

    term = re.search(r"kể từ ngày\s+([^.\n]+?)\s+đến hết ngày\s+([^.\n]+)", text, re.IGNORECASE)
    if term:
        timeline.append(
            {
                "label": "Thời hạn thuê",
                "value": f"{compact(term.group(1))} - {compact(term.group(2))}",
                "risk": "Theo dõi mốc gia hạn trước khi hết hạn.",
            }
        )

    return timeline[:5]


def missing_clause_checks(text: str) -> list[dict[str, str]]:
    folded_text = fold_vietnamese(text)
    checks = [
        (
            "Hạn hoàn cọc",
            ["hoàn trả", "đặt cọc", "trong vòng"],
            "Ghi rõ số ngày hoàn cọc sau khi trả nhà để dễ đòi tiền.",
        ),
        (
            "Công thức khấu trừ cọc",
            ["khấu trừ", "đặt cọc"],
            "Liệt kê khoản được trừ và yêu cầu chứng từ/hóa đơn.",
        ),
        (
            "Giới hạn trách nhiệm",
            ["giới hạn trách nhiệm"],
            "Đặt trần trách nhiệm để tránh bồi thường vượt khả năng dự liệu.",
        ),
        (
            "Khung giờ kiểm tra nhà",
            ["kiểm tra hiện trạng", "khung giờ"],
            "Bổ sung khung giờ và trường hợp khẩn cấp để bảo vệ quyền riêng tư.",
        ),
        (
            "Thời gian thương lượng tranh chấp",
            ["thương lượng", "07", "tranh chấp"],
            "Thêm giai đoạn thương lượng/hòa giải trước khi khởi kiện.",
        ),
    ]

    missing = []
    for title, needles, advice in checks:
        if not all(fold_vietnamese(needle) in folded_text for needle in needles):
            missing.append({"title": title, "advice": advice})
    return missing[:5]


def readiness_label(score: int, counts: dict[str, int]) -> str:
    if counts["RED"]:
        return "Cần sửa trước khi ký"
    if score < 75 or counts["YELLOW"] >= 3:
        return "Có thể đàm phán thêm"
    return "Có thể xem xét ký"


def build_deep_analysis(text: str, findings: list[dict[str, Any]], counts: dict[str, int], score: int) -> dict[str, Any]:
    monthly_rent = first_money_near(text, "giá thuê")
    deposit = first_money_near(text, "đặt cọc")
    folded_text = fold_vietnamese(text)
    possible_penalty = monthly_rent if ("01 thang tien thue" in folded_text or "1 thang tien thue" in folded_text) else None
    exposure_values = [value for value in [deposit, possible_penalty] if value]
    estimated_exposure = sum(exposure_values) if exposure_values else None

    priority_findings = sorted(
        findings,
        key=lambda item: (
            {"RED": 0, "YELLOW": 1, "GREEN": 2}.get(item["muc_do_rui_ro"], 3),
            item.get("stt", 99),
        ),
    )
    priority_actions = [
        {
            "title": item["muc_ra_soat"],
            "severity": item["muc_do_rui_ro"],
            "why": item["giai_thich_binh_dan"],
            "action": item["goi_y_dam_phan"],
        }
        for item in priority_findings
        if item["muc_do_rui_ro"] in {"RED", "YELLOW"}
    ][:4]

    return {
        "readiness": {
            "label": readiness_label(score, counts),
            "score": score,
            "reason": "Ưu tiên xử lý thẻ Đỏ, sau đó khóa các điểm Vàng liên quan đến tiền cọc, chấm dứt và quyền kiểm tra.",
        },
        "financialExposure": {
            "monthlyRent": monthly_rent,
            "deposit": deposit,
            "possiblePenalty": possible_penalty,
            "estimatedExposure": estimated_exposure,
            "display": {
                "monthlyRent": format_vnd(monthly_rent),
                "deposit": format_vnd(deposit),
                "possiblePenalty": format_vnd(possible_penalty),
                "estimatedExposure": format_vnd(estimated_exposure),
            },
        },
        "timeline": extract_timeline(text),
        "missingClauses": missing_clause_checks(text),
        "priorityActions": priority_actions,
        "coverage": {
            "checked": len(CHECKLIST),
            "flagged": len(findings),
            "highImpact": counts["RED"] + counts["YELLOW"],
        },
    }


def build_finding(
    findings: list[dict[str, Any]],
    *,
    stt: int,
    muc_ra_soat: str,
    severity: str,
    quote: str,
    explanation: str,
    suggestion: str,
    law_basis: str,
    risk_reason: str,
    confidence: float,
    affected_party: str = "Người ký hợp đồng",
    next_step: str = "",
    financial_exposure: str = "",
) -> None:
    priority = {"RED": "P1", "YELLOW": "P2", "GREEN": "P3"}.get(severity, "P3")
    findings.append(
        {
            "id": f"finding-{len(findings) + 1}",
            "stt": stt,
            "muc_ra_soat": muc_ra_soat,
            "muc_do_rui_ro": severity,
            "van_ban_goc_highlight": quote,
            "giai_thich_binh_dan": explanation,
            "goi_y_dam_phan": suggestion,
            "co_so_phap_ly": law_basis,
            "ly_do_ra_soat": risk_reason,
            "confidence": confidence,
            "impact": {
                "priority": priority,
                "affectedParty": affected_party,
                "financialExposure": financial_exposure or "Không định lượng trực tiếp",
                "nextStep": next_step or suggestion,
            },
        }
    )


def analyze_contract(text: str, filename: str, contract_type: str) -> dict[str, Any]:
    redacted_text, pii_counts = redact_pii(text)
    parts = paragraphs(text)
    redacted_parts = paragraphs(redacted_text)
    findings: list[dict[str, Any]] = []

    subject_quote = first_para_any(
        redacted_parts,
        [["bên cho thuê"], ["bên thuê"], ["hai bên chúng tôi gồm"]],
    )
    if subject_quote:
        build_finding(
            findings,
            stt=1,
            muc_ra_soat="Chủ thể hợp đồng",
            severity="GREEN",
            quote=subject_quote,
            explanation="Hợp đồng đã nêu rõ hai bên tham gia, giúp xác định người có quyền và nghĩa vụ chính.",
            suggestion="Khi ký bản cuối, đối chiếu lại họ tên, CCCD và chữ ký với giấy tờ gốc của từng bên.",
            law_basis="Điều 117 Bộ luật Dân sự 2015",
            risk_reason="Sai hoặc thiếu chủ thể có thể làm hợp đồng khó thực thi.",
            confidence=0.86,
        )

    property_quote = first_para_any(
        redacted_parts,
        [["vị trí, địa điểm nhà ở"], ["diện tích của nhà ở"], ["trang thiết bị kèm theo"]],
    )
    if property_quote:
        build_finding(
            findings,
            stt=6,
            muc_ra_soat="Đối tượng hợp đồng",
            severity="GREEN",
            quote=property_quote,
            explanation="Tài sản thuê được mô tả tương đối rõ, gồm vị trí, diện tích hoặc trang thiết bị.",
            suggestion="Nên kèm ảnh hiện trạng và biên bản bàn giao để tránh tranh cãi khi trả nhà.",
            law_basis="Điều 398 Bộ luật Dân sự 2015",
            risk_reason="Mô tả mơ hồ dễ dẫn tới tranh chấp về tài sản thực tế được thuê.",
            confidence=0.82,
        )

    price_quote = first_para_any(
        redacted_parts,
        [["giá thuê nhà ở là"], ["thời hạn thực hiện thanh toán"], ["phương thức thanh toán"]],
    )
    if price_quote:
        build_finding(
            findings,
            stt=12,
            muc_ra_soat="Giá trị và thanh toán",
            severity="GREEN",
            quote=price_quote,
            explanation="Giá thuê, phương thức hoặc mốc thanh toán đã được thể hiện, giúp người thuê dự trù dòng tiền.",
            suggestion="Giữ lại chứng từ chuyển khoản hoặc giấy nhận tiền mặt có chữ ký hai bên.",
            law_basis="Điều 278, Điều 440 Bộ luật Dân sự 2015",
            risk_reason="Thiếu thời hạn thanh toán làm mất căn cứ xác định vi phạm chậm trả.",
            confidence=0.84,
        )

    deposit_original = first_para(parts, "đặt cọc")
    deposit_quote = redact_pii(deposit_original)[0] if deposit_original else ""
    if deposit_original:
        has_deadline = re.search(r"(trong vòng|chậm nhất|không quá)\s+\d+\s+ngày", deposit_original, re.IGNORECASE)
        if not has_deadline:
            build_finding(
                findings,
                stt=26,
                muc_ra_soat="Đặt cọc và hoàn cọc",
                severity="YELLOW",
                quote=deposit_quote,
                explanation="Điều khoản có nói tiền cọc được hoàn trả, nhưng chưa khóa rõ hạn hoàn tiền và cách tính khoản bị trừ. Đây là điểm dễ biến thành tranh cãi khi trả nhà.",
                suggestion="Bổ sung: 'Bên cho thuê hoàn trả tiền đặt cọc trong vòng 03 ngày làm việc kể từ ngày nhận lại nhà, sau khi hai bên ký biên bản đối chiếu công nợ và hiện trạng tài sản.'",
                law_basis="Điều 328 Bộ luật Dân sự 2015",
                risk_reason="Không có deadline hoàn cọc khiến người thuê khó đòi lại tiền đúng hạn.",
                confidence=0.9,
                affected_party="Bên thuê",
                next_step="Khóa hạn hoàn cọc và danh sách khoản được trừ trước khi đặt bút ký.",
                financial_exposure="Tiền đặt cọc và các khoản bị khấu trừ khi trả nhà",
            )

    late_interest_original = first_para_any(parts, [["lãi chậm thanh toán"], ["chậm thanh toán", "%/ngày"]])
    late_interest_quote = redact_pii(late_interest_original)[0] if late_interest_original else ""
    if late_interest_original:
        daily_rate = percent_per_day(late_interest_original)
        if daily_rate is not None and daily_rate > 0.055:
            build_finding(
                findings,
                stt=16,
                muc_ra_soat="Chậm thanh toán",
                severity="RED",
                quote=late_interest_quote,
                explanation="Lãi chậm trả theo ngày đang quá cao nếu quy đổi theo năm, có nguy cơ vượt ngưỡng lãi suất mà pháp luật dân sự cho phép.",
                suggestion="Đề nghị giới hạn lãi chậm trả không vượt quá mức tối đa theo Điều 468 Bộ luật Dân sự 2015.",
                law_basis="Điều 357, Điều 468 Bộ luật Dân sự 2015",
                risk_reason="Lãi chậm trả vượt trần có thể không được công nhận và gây áp lực tài chính bất hợp lý.",
                confidence=0.88,
                affected_party="Bên thuê",
                next_step="Yêu cầu ghi trần lãi chậm trả và công thức tính rõ ràng.",
                financial_exposure="Lãi chậm trả cộng dồn theo ngày",
            )
        else:
            build_finding(
                findings,
                stt=16,
                muc_ra_soat="Chậm thanh toán",
                severity="GREEN",
                quote=late_interest_quote,
                explanation="Có quy định rõ lãi chậm thanh toán, giúp hai bên biết trước hậu quả nếu trả tiền muộn.",
                suggestion="Nên ghi thêm công thức tính lãi và ngày bắt đầu tính để tránh hiểu khác nhau.",
                law_basis="Điều 357, Điều 468 Bộ luật Dân sự 2015",
                risk_reason="Cơ chế chậm trả càng rõ thì càng giảm tranh chấp sau này.",
                confidence=0.79,
            )

    penalty_original = (
        first_para(parts, "bồi thường toàn bộ thiệt hại")
        or first_para(parts, "phạt vi phạm bằng")
        or first_para(parts, "phạt vi phạm")
    )
    penalty_quote = redact_pii(penalty_original)[0] if penalty_original else ""
    if penalty_original:
        folded_penalty = fold_vietnamese(penalty_original)
        fixed_month_penalty = "01 thang tien thue" in folded_penalty or "1 thang tien thue" in folded_penalty
        percent = penalty_percent(penalty_original)
        if fixed_month_penalty or (percent is not None and percent > 8):
            build_finding(
                findings,
                stt=21,
                muc_ra_soat="Phạt vi phạm và bồi thường",
                severity="RED",
                quote=penalty_quote,
                explanation="Điều khoản gộp phạt vi phạm với bồi thường toàn bộ thiệt hại nhưng chưa nêu cách chứng minh thiệt hại, giới hạn trách nhiệm hoặc từng hành vi bị phạt. Người ký có thể phải chịu khoản tiền lớn hơn dự kiến.",
                suggestion="Tách rõ: hành vi nào bị phạt, mức phạt tối đa bao nhiêu, bồi thường chỉ áp dụng với thiệt hại thực tế, hợp lý và có chứng từ.",
                law_basis="Điều 418, Điều 419 Bộ luật Dân sự 2015; Điều 300-302 Luật Thương mại 2005 nếu là giao dịch thương mại",
                risk_reason="Gộp phạt và bồi thường không rõ điều kiện dễ tạo áp lực tài chính bất lợi.",
                confidence=0.91,
                affected_party="Bên vi phạm, thường bất lợi cho bên thuê",
                next_step="Tách phạt và bồi thường thành hai câu, kèm điều kiện chứng minh thiệt hại.",
                financial_exposure="Có thể bằng 01 tháng tiền thuê cộng thiệt hại thực tế",
            )

    terminate_quote = first_para(redacted_parts, "bên thuê chậm thanh toán tiền thuê")
    folded_text = fold_vietnamese(text)
    has_fifteen_day_rule = "qua 15 ngay" in folded_text or "qua muoi lam ngay" in folded_text
    if terminate_quote and has_fifteen_day_rule and "15" not in terminate_quote:
        build_finding(
            findings,
            stt=27,
            muc_ra_soat="Đơn phương chấm dứt",
            severity="YELLOW",
            quote=terminate_quote,
            explanation="Hợp đồng có nơi nói chậm thanh toán quá 15 ngày mới được chấm dứt, nhưng điều khoản chấm dứt lại chỉ ghi 'chậm thanh toán' mà không nhắc ngưỡng ngày. Cách viết này có thể bị hiểu theo hướng bất lợi cho bên thuê.",
            suggestion="Sửa thành: 'Bên thuê chậm thanh toán quá 15 ngày kể từ hạn thanh toán và không khắc phục trong 03 ngày sau khi nhận thông báo bằng văn bản.'",
            law_basis="Điều 428 Bộ luật Dân sự 2015; nguyên tắc thiện chí, trung thực tại Điều 3 Bộ luật Dân sự 2015",
            risk_reason="Mâu thuẫn nội bộ khiến một bên có thể chấm dứt hợp đồng sớm hơn ý định ban đầu.",
            confidence=0.87,
            affected_party="Bên thuê",
            next_step="Đồng bộ mốc 15 ngày và thêm thời hạn khắc phục sau thông báo.",
            financial_exposure="Nguy cơ mất nơi ở, mất cọc hoặc phát sinh phạt",
        )

    inspection_original = first_para(parts, "kiểm tra hiện trạng")
    inspection_quote = redact_pii(inspection_original)[0] if inspection_original else ""
    if inspection_original and "khan cap" in fold_vietnamese(inspection_original):
        build_finding(
            findings,
            stt=33,
            muc_ra_soat="Quyền kiểm tra tài sản",
            severity="YELLOW",
            quote=inspection_quote,
            explanation="Bên cho thuê được kiểm tra định kỳ và có ngoại lệ 'trường hợp khẩn cấp', nhưng hợp đồng chưa định nghĩa khẩn cấp là gì. Điều này có thể ảnh hưởng quyền riêng tư của người thuê.",
            suggestion="Bổ sung khung giờ kiểm tra, cách báo trước và định nghĩa khẩn cấp như cháy nổ, rò rỉ nước, sự cố điện hoặc nguy cơ gây thiệt hại ngay lập tức.",
            law_basis="Điều 3 Bộ luật Dân sự 2015; nguyên tắc tôn trọng thỏa thuận và quyền nhân thân",
            risk_reason="Quyền kiểm tra quá mở dễ bị lạm dụng trong quá trình thuê.",
            confidence=0.8,
            affected_party="Bên thuê",
            next_step="Bổ sung khung giờ, cách báo trước và định nghĩa trường hợp khẩn cấp.",
            financial_exposure="Không trực tiếp, nhưng ảnh hưởng quyền sử dụng ổn định",
        )

    handover_quote = first_para_any(
        redacted_parts,
        [["biên bản bàn giao"], ["danh mục trang thiết bị"], ["hồ sơ kèm theo"]],
    )
    if handover_quote:
        build_finding(
            findings,
            stt=19,
            muc_ra_soat="Bàn giao và hồ sơ kèm theo",
            severity="GREEN",
            quote=handover_quote,
            explanation="Hợp đồng có nhắc biên bản bàn giao và danh mục tài sản, đây là bằng chứng quan trọng khi nhận hoặc trả nhà.",
            suggestion="Nên ghi rõ tình trạng từng thiết bị, ảnh chụp kèm ngày giờ và chữ ký hai bên.",
            law_basis="Điều 398 Bộ luật Dân sự 2015",
            risk_reason="Không có biên bản bàn giao sẽ khó chứng minh hư hỏng có sẵn hay phát sinh do bên thuê.",
            confidence=0.78,
        )

    dispute_quote = first_para(redacted_parts, "giải quyết tranh chấp")
    if dispute_quote:
        build_finding(
            findings,
            stt=37,
            muc_ra_soat="Giải quyết tranh chấp",
            severity="GREEN",
            quote=dispute_quote,
            explanation="Hợp đồng đã nêu cơ quan giải quyết tranh chấp, giúp hai bên biết nơi xử lý nếu thương lượng không thành.",
            suggestion="Có thể bổ sung bước thương lượng/hòa giải trong 07-15 ngày trước khi khởi kiện để tiết kiệm chi phí.",
            law_basis="Bộ luật Tố tụng Dân sự 2015",
            risk_reason="Thiếu cơ chế tranh chấp làm kéo dài thời gian xử lý khi phát sinh mâu thuẫn.",
            confidence=0.75,
        )

    notice_quote = first_para(redacted_parts, "mọi thông báo vi phạm")
    if notice_quote:
        build_finding(
            findings,
            stt=36,
            muc_ra_soat="Thông báo vi phạm",
            severity="GREEN",
            quote=notice_quote,
            explanation="Hợp đồng đã yêu cầu thông báo vi phạm có thể xác nhận gửi và nhận. Đây là lớp bằng chứng tốt nếu hai bên tranh chấp.",
            suggestion="Nên bổ sung địa chỉ email/số điện thoại chính thức được dùng để gửi thông báo.",
            law_basis="Điều 3, Điều 119 Bộ luật Dân sự 2015",
            risk_reason="Không có kênh thông báo rõ khiến một bên dễ phủ nhận đã nhận cảnh báo.",
            confidence=0.82,
        )

    amendment_quote = first_para(redacted_parts, "thay đổi nội dung", "lập bằng văn bản")
    if amendment_quote:
        build_finding(
            findings,
            stt=38,
            muc_ra_soat="Hiệu lực và sửa đổi hợp đồng",
            severity="GREEN",
            quote=amendment_quote,
            explanation="Hợp đồng yêu cầu mọi thay đổi phải lập bằng văn bản và có chữ ký hai bên, giúp tránh sửa miệng hoặc hiểu nhầm sau này.",
            suggestion="Khi gia hạn hoặc thay đổi giá thuê, lập phụ lục riêng thay vì chỉ nhắn tin.",
            law_basis="Điều 119, Điều 403 Bộ luật Dân sự 2015",
            risk_reason="Thay đổi không có văn bản dễ làm mất bằng chứng khi tranh chấp.",
            confidence=0.82,
        )

    extension_quote = first_para(redacted_parts, "gia hạn hợp đồng")
    if extension_quote:
        build_finding(
            findings,
            stt=28,
            muc_ra_soat="Gia hạn hợp đồng",
            severity="GREEN",
            quote=extension_quote,
            explanation="Hợp đồng có mốc đề nghị gia hạn trước khi hết hạn, giúp người thuê chủ động kế hoạch ở tiếp hoặc chuyển đi.",
            suggestion="Nên ghi rõ bên cho thuê phải phản hồi đề nghị gia hạn trong bao nhiêu ngày.",
            law_basis="Điều 3 Bộ luật Dân sự 2015",
            risk_reason="Không có quy trình gia hạn rõ có thể khiến người thuê bị động sát ngày hết hạn.",
            confidence=0.76,
        )

    maintenance_quote = first_para_any(
        redacted_parts,
        [["bảo trì, sửa chữa"], ["sửa chữa nhà ở", "không phải do lỗi"]],
    )
    if maintenance_quote:
        build_finding(
            findings,
            stt=32,
            muc_ra_soat="Sửa chữa và bảo trì",
            severity="GREEN",
            quote=maintenance_quote,
            explanation="Hợp đồng có phân định trách nhiệm sửa chữa khi hư hỏng không do lỗi của bên thuê.",
            suggestion="Nên thêm thời hạn phản hồi/sửa chữa với lỗi điện, nước, khóa cửa hoặc sự cố an toàn.",
            law_basis="Điều 477 Bộ luật Dân sự 2015; Luật Kinh doanh bất động sản 2023",
            risk_reason="Không có thời hạn sửa chữa làm người thuê phải chịu bất tiện kéo dài.",
            confidence=0.78,
        )

    if sum(pii_counts.values()) > 0:
        build_finding(
            findings,
            stt=30,
            muc_ra_soat="Bảo mật dữ liệu cá nhân",
            severity="YELLOW",
            quote="",
            explanation=f"Hệ thống phát hiện và đã ẩn {sum(pii_counts.values())} dữ liệu nhạy cảm như CCCD, số điện thoại, tài khoản hoặc mã số thuế trước khi hiển thị báo cáo.",
            suggestion="Khi dùng bản production, bật cơ chế xóa file sau phân tích và chỉ lưu báo cáo đã ẩn danh.",
            law_basis="Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân",
            risk_reason="Hợp đồng thường chứa nhiều thông tin định danh, cần xử lý theo nguyên tắc privacy by design.",
            confidence=0.93,
            affected_party="Cả hai bên",
            next_step="Chỉ lưu báo cáo đã ẩn danh và xóa file nguồn sau khi phân tích.",
            financial_exposure="Rủi ro lộ thông tin định danh, tài khoản, số điện thoại",
        )

    if not findings:
        build_finding(
            findings,
            stt=40,
            muc_ra_soat="Ngôn ngữ dễ hiểu cho người ký",
            severity="YELLOW",
            quote="",
            explanation="Chưa phát hiện đủ cấu trúc điều khoản để chấm rủi ro sâu. Có thể file scan mờ, hợp đồng quá ngắn hoặc định dạng chưa được hỗ trợ.",
            suggestion="Tải bản DOCX/PDF rõ chữ hoặc dán trực tiếp nội dung hợp đồng để hệ thống phân tích đầy đủ hơn.",
            law_basis="Khuyến nghị vận hành sản phẩm",
            risk_reason="Dữ liệu đầu vào không đủ rõ làm giảm độ tin cậy của phân tích.",
            confidence=0.6,
        )

    counts = {
        "RED": sum(1 for item in findings if item["muc_do_rui_ro"] == "RED"),
        "YELLOW": sum(1 for item in findings if item["muc_do_rui_ro"] == "YELLOW"),
        "GREEN": sum(1 for item in findings if item["muc_do_rui_ro"] == "GREEN"),
    }
    score = max(18, min(96, 92 - counts["RED"] * 18 - counts["YELLOW"] * 7 + counts["GREEN"] * 2))
    overall = "HIGH" if counts["RED"] >= 2 or score < 55 else "MEDIUM" if counts["RED"] or counts["YELLOW"] >= 2 else "LOW"
    deep_analysis = build_deep_analysis(text, findings, counts, score)

    return {
        "fileName": filename,
        "contractType": contract_type or infer_contract_type(text),
        "analyzedAt": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "overallRisk": overall,
            "riskScore": score,
            "counts": counts,
            "scannedCategories": len(CHECKLIST),
            "piiItemsRedacted": sum(pii_counts.values()),
            "piiBreakdown": pii_counts,
        },
        "text": redacted_text,
        "findings": findings,
        "deepAnalysis": deep_analysis,
        "checklist": CHECKLIST,
        "disclaimer": "Báo cáo này là phân tích hỗ trợ bằng AI/rule engine, không thay thế tư vấn của luật sư.",
    }


def infer_contract_type(text: str) -> str:
    lowered = text.lower()
    if "thuê nhà" in lowered or "bên cho thuê" in lowered:
        return "Hợp đồng thuê nhà"
    if "bảo hiểm" in lowered:
        return "Hợp đồng bảo hiểm"
    if "vay" in lowered or "lãi suất" in lowered:
        return "Hợp đồng vay / tài chính"
    return "Hợp đồng dân sự"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--filename", default="")
    parser.add_argument("--contract-type", default="")
    args = parser.parse_args()

    source = Path(args.input)
    try:
        text = extract_text(source)
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)

    if len(compact(text)) < MIN_EXTRACTED_TEXT_CHARS:
        print(
            "Không đọc được đủ nội dung hợp đồng từ file. Hãy kiểm tra file có chữ rõ, "
            "không bị scan ảnh hoặc thử dán trực tiếp nội dung.",
            file=sys.stderr,
        )
        raise SystemExit(2)

    result = analyze_contract(text, args.filename or source.name, args.contract_type)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
