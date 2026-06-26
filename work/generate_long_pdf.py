from pathlib import Path
import textwrap

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "sample-rental-contract.txt"
OUTPUT = ROOT / "work" / "long_contract_40_pages.pdf"
FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf"


def main() -> None:
    source_text = SOURCE.read_text(encoding="utf-8")
    lines = []
    for paragraph in source_text.splitlines():
        if not paragraph.strip():
            lines.append("")
            continue
        lines.extend(textwrap.wrap(paragraph, width=92) or [""])

    doc = canvas.Canvas(str(OUTPUT), pagesize=A4)
    width, height = A4
    line_height = 13

    cursor = 0
    for page in range(1, 3):
        doc.setFont("Helvetica", 10)
        y = height - 46
        doc.drawString(44, y, f"ContractGuard AI PDF extraction test - Trang {page}/2")
        y -= 24
        for _ in range(52):
            text = lines[cursor % len(lines)]
            doc.drawString(44, y, text[:120])
            y -= line_height
            cursor += 1
        doc.showPage()

    doc.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
