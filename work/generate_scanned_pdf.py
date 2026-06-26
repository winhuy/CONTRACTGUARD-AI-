from pathlib import Path
import textwrap

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "work" / "scanned_contract_test.pdf"
FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf"

TEXT = """
HỢP ĐỒNG THUÊ NHÀ Ở

Bên thuê đặt cọc 17.000.000 đồng, tương đương 02 tháng tiền thuê.
Giá thuê nhà ở là 8.500.000 đồng/tháng.
Trường hợp chậm thanh toán quá 05 ngày, Bên thuê phải trả lãi chậm thanh toán.
Bên vi phạm phải chịu phạt vi phạm bằng 01 tháng tiền thuê nhà.
Các bên lựa chọn Tòa án nhân dân có thẩm quyền tại thành phố Huế để giải quyết tranh chấp.
"""


def make_page(path: Path, page_number: int) -> None:
    image = Image.new("RGB", (1654, 2339), "white")
    draw = ImageDraw.Draw(image)
    title_font = ImageFont.truetype(FONT_PATH, 54)
    body_font = ImageFont.truetype(FONT_PATH, 40)
    y = 160
    draw.text((140, y), f"Trang scan OCR {page_number}", fill="black", font=title_font)
    y += 110
    for paragraph in TEXT.strip().splitlines():
        if not paragraph.strip():
            y += 36
            continue
        for line in textwrap.wrap(paragraph, width=58):
            draw.text((140, y), line, fill="black", font=body_font)
            y += 58
    image.save(path)


def main() -> None:
    page_paths = []
    for page_number in range(1, 3):
        path = ROOT / "work" / f"scanned_contract_page_{page_number}.png"
        make_page(path, page_number)
        page_paths.append(path)

    pdf = canvas.Canvas(str(OUTPUT), pagesize=A4)
    width, height = A4
    for path in page_paths:
        pdf.drawImage(str(path), 0, 0, width=width, height=height)
        pdf.showPage()
    pdf.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
