from __future__ import annotations

import argparse
import json
from pathlib import Path

import pdfplumber
from docx import Document


def extract_pdf(path: Path) -> dict:
    pages = []
    with pdfplumber.open(path) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            pages.append(
                {
                    "page": page_number,
                    "text": page.extract_text(x_tolerance=2, y_tolerance=3) or "",
                }
            )
    return {"path": str(path), "type": "pdf", "pages": pages}


def extract_docx(path: Path) -> dict:
    document = Document(path)
    paragraphs = [
        {
            "index": index,
            "style": paragraph.style.name if paragraph.style else None,
            "text": paragraph.text,
        }
        for index, paragraph in enumerate(document.paragraphs)
        if paragraph.text.strip()
    ]
    tables = []
    for table_index, table in enumerate(document.tables):
        rows = []
        for row_index, row in enumerate(table.rows):
            rows.append(
                {
                    "index": row_index,
                    "cells": [cell.text for cell in row.cells],
                }
            )
        tables.append({"index": table_index, "rows": rows})
    return {
        "path": str(path),
        "type": "docx",
        "paragraphs": paragraphs,
        "tables": tables,
    }


def extract(path: Path) -> dict:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return extract_pdf(path)
    if suffix == ".docx":
        return extract_docx(path)
    raise ValueError(f"Unsupported input type: {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract reviewable text from task and report files.")
    parser.add_argument("--taskbook", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    payload = {
        "taskbook": extract(args.taskbook),
        "report": extract(args.report),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(args.output.resolve())


if __name__ == "__main__":
    main()

