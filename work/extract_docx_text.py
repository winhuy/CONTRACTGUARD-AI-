from pathlib import Path
from xml.etree import ElementTree as ET
import re
import zipfile


DOCS = [
    "/Users/huynhquochuy/Downloads/Báo cáo Đề án Kinh doanh_ ContractGuard AI (Vòng 2).docx",
    "/Users/huynhquochuy/Downloads/Báo cáo tiềm năng thương mại ContractGuard AI (1).docx",
    "/Users/huynhquochuy/Downloads/Đề án chi tiết_ ContractGuard AI (Vòng 2) (1).docx",
    "/Users/huynhquochuy/Downloads/Hop_dong_thue_nha_o_hoan_chinh_test_app.docx",
    "/Users/huynhquochuy/Downloads/Mô tả dự án ContractGuard AI.docx",
    "/Users/huynhquochuy/Downloads/Phu_luc_II._Hop_dong_thue_nha_o_1505152407.docx",
    "/Users/huynhquochuy/Downloads/System Prompt & Hướng Dẫn Nghiệp Vụ - ContractGuard AI V2.docx",
    "/Users/huynhquochuy/Downloads/TheNextX_Vong2_HuongDan.docx",
]

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def text_from_node(node):
    chunks = []
    for child in node.iter():
        if child.tag == f"{{{NS['w']}}}t" and child.text:
            chunks.append(child.text)
        elif child.tag == f"{{{NS['w']}}}tab":
            chunks.append("\t")
        elif child.tag in {f"{{{NS['w']}}}br", f"{{{NS['w']}}}cr"}:
            chunks.append("\n")
    return "".join(chunks)


def extract_docx(path):
    with zipfile.ZipFile(path) as docx:
        xml = docx.read("word/document.xml")

    root = ET.fromstring(xml)
    body = root.find("w:body", NS)
    parts = []
    if body is None:
        return ""

    for child in body:
        if child.tag == f"{{{NS['w']}}}p":
            text = text_from_node(child).strip()
            if text:
                parts.append(text)
        elif child.tag == f"{{{NS['w']}}}tbl":
            rows = []
            for row in child.findall(".//w:tr", NS):
                cells = []
                for cell in row.findall("./w:tc", NS):
                    cell_text = re.sub(r"\s+", " ", text_from_node(cell)).strip()
                    cells.append(cell_text)
                if any(cells):
                    rows.append(" | ".join(cells))
            if rows:
                parts.append("\n".join(rows))

    return "\n\n".join(parts)


def safe_name(path):
    stem = Path(path).stem
    return re.sub(r"[^0-9A-Za-zÀ-ỹ._-]+", "_", stem).strip("_")


def main():
    out_dir = Path("work/extracted_docs")
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for item in DOCS:
        source = Path(item)
        text = extract_docx(source)
        out_path = out_dir / f"{safe_name(item)}.txt"
        out_path.write_text(text, encoding="utf-8")
        manifest.append(f"{out_path}\t{source}\t{text.count(chr(10)) + 1} lines")
    (out_dir / "manifest.tsv").write_text("\n".join(manifest), encoding="utf-8")


if __name__ == "__main__":
    main()
