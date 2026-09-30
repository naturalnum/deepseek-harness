#!/usr/bin/env python3
"""Render a DOCX to PDF and page PNGs for visual QA."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path
from zipfile import ZipFile

from catalog_cache import paginate, _load, _ranges, _text


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, check=True, text=True, capture_output=True)


def _normalize_catalog_text(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def _tc_entries(docx: Path) -> dict[str, list[str]]:
    entries = {"F": [], "T": []}
    try:
        with ZipFile(docx) as archive:
            xml = archive.read("word/document.xml").decode("utf-8", errors="ignore")
    except Exception:
        return entries
    # The XML serializer normally keeps literal quotes inside w:instrText.
    for match in re.finditer(r'TC\s+"([^"]+)"\s+\\f\s+([FT])\s+\\l\s+"1"', xml):
        entries[match.group(2)].append(match.group(1))
    return entries


def _catalog_visual_qa(docx: Path, pdf: Path, layout: dict | None = None) -> dict:
    layout = layout or paginate(docx)
    pdftotext = shutil.which("pdftotext")
    if not pdftotext:
        return {"checked": False, "ok": None, "reason": "pdftotext not found"}
    proc = subprocess.run(
        [pdftotext, "-layout", str(pdf), "-"],
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        return {"checked": False, "ok": None, "reason": proc.stderr.strip()}
    visible = proc.stdout
    physical_pages = visible.split("\f")
    catalog_locations = [value["physical"] for key, value in layout["pages"].items() if key.startswith("PECatalog")]
    start = min(catalog_locations) if catalog_locations else 0
    end = max(catalog_locations) if catalog_locations else 0
    catalog_visible = "\n".join(physical_pages[start - 1:end]) if start else ""
    missing_markers = re.findall(
        r"未找到[^\n。；;]{0,30}目录项|No table of (?:contents|figures|tables) entries found",
        visible,
        flags=re.IGNORECASE,
    )
    normalized_visible = _normalize_catalog_text(catalog_visible)
    tc_entries = _tc_entries(docx)
    missing_entries: dict[str, list[str]] = {"figures": [], "tables": []}
    for identifier, key in (("F", "figures"), ("T", "tables")):
        for entry in tc_entries[identifier]:
            if _normalize_catalog_text(entry) not in normalized_visible:
                missing_entries[key].append(entry)
    _, root = _load(docx)
    caches = {key: [_text(p).strip() for p in nodes if _text(p).strip()]
              for key, (_, nodes) in _ranges(root).items()}
    missing_main = []
    incorrect_pages = []
    missing_title = not any(re.fullmatch(r"\s*目\s*录\s*", line) for line in catalog_visible.splitlines())
    for key, entries in layout["entries"].items():
        for entry in entries:
            expected = layout["pages"][entry["bookmark"]]["label"]
            pair = _normalize_catalog_text(entry["title"] + expected)
            if not any(_normalize_catalog_text(row) == pair for row in caches[key]):
                incorrect_pages.append({"title": entry["title"], "expected_page": expected})
            actual_locations = [page for index, page in enumerate(physical_pages, 1)
                                if not (start <= index <= end)
                                and _normalize_catalog_text(entry["title"]) in _normalize_catalog_text(page)]
            if not any(re.search(r"(?:^|\n)\s*" + re.escape(expected) + r"\s*$", page) for page in actual_locations):
                incorrect_pages.append({"title": entry["title"], "expected_page": expected,
                                        "reason": "target PDF page/footer not found"})
            # PDF must visibly contain the title followed by its actual page;
            # punctuation leaders are ignored, but unrelated body text is excluded.
            searchable = re.sub(r"[.·…．]{2,}", "", normalized_visible)
            if pair not in searchable and key == "C":
                missing_main.append(entry["title"])
    ok = bool(caches["C"]) and not missing_title and not missing_markers and not missing_main and not incorrect_pages and not missing_entries["figures"] and not missing_entries["tables"]
    return {
        "checked": True,
        "ok": ok,
        "not_found_markers": missing_markers,
        "missing_figure_catalog_entries": missing_entries["figures"],
        "missing_table_catalog_entries": missing_entries["tables"],
        "figure_tc_entries": len(tc_entries["F"]),
        "table_tc_entries": len(tc_entries["T"]),
        "main_entries": len(layout["entries"]["C"]),
        "main_cached_entries": len(caches["C"]),
        "missing_contents_title": missing_title,
        "missing_main_catalog_entries": missing_main,
        "incorrect_catalog_pages": incorrect_pages,
        "catalog_physical_pages": [start, end],
    }


def render(docx: Path, output_dir: Path) -> dict:
    docx = docx.resolve()
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    if not docx.is_file():
        raise FileNotFoundError(docx)
    libreoffice = shutil.which("libreoffice") or shutil.which("soffice")
    if not libreoffice:
        return {"success": False, "error": "libreoffice/soffice not found", "docx_path": str(docx)}

    pdf = output_dir / f"{docx.stem}.pdf"
    # Rendering is a read-only validation operation: blank/stale source caches
    # must fail instead of being repaired invisibly by the QA path.
    if pdf.exists():
        pdf.unlink()
    layout = paginate(docx, pdf)
    if not pdf.is_file() or pdf.stat().st_size == 0:
        return {
            "success": False,
            "error": "PDF conversion did not produce a non-empty file",
            "docx_path": str(docx),
        }

    catalog_qa = _catalog_visual_qa(docx, pdf, layout)

    pdftoppm = shutil.which("pdftoppm")
    if not pdftoppm:
        return {
            "success": False,
            "docx_path": str(docx),
            "pdf_path": str(pdf),
            "png_paths": [],
            "page_count": 0,
            "catalog_qa": catalog_qa,
            "warning": "pdftoppm not found; PDF created but page PNGs were not rendered",
        }

    prefix = output_dir / "page"
    run([pdftoppm, "-png", "-r", "150", str(pdf), str(prefix)])
    pngs = sorted(output_dir.glob("page-*.png"))
    return {
        "success": bool(pngs) and catalog_qa.get("ok") is True,
        "docx_path": str(docx),
        "pdf_path": str(pdf),
        "png_paths": [str(x) for x in pngs],
        "page_count": len(pngs),
        "render_dir": str(output_dir),
        "catalog_qa": catalog_qa,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("docx", type=Path)
    ap.add_argument("output_dir", type=Path)
    ap.add_argument("--json-out", type=Path)
    args = ap.parse_args()
    try:
        result = render(args.docx, args.output_dir)
    except Exception as exc:
        result = {"success": False, "error": str(exc), "docx_path": str(args.docx)}
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
