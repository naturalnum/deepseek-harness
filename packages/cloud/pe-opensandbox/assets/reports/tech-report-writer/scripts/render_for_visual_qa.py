#!/usr/bin/env python3
"""Render a DOCX to PDF and page PNGs for visual QA."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZipFile


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


def _catalog_visual_qa(docx: Path, pdf: Path) -> dict:
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
    missing_markers = re.findall(
        r"未找到[^\n。；;]{0,30}目录项|No table of (?:contents|figures|tables) entries found",
        visible,
        flags=re.IGNORECASE,
    )
    normalized_visible = _normalize_catalog_text(visible)
    tc_entries = _tc_entries(docx)
    missing_entries: dict[str, list[str]] = {"figures": [], "tables": []}
    for identifier, key in (("F", "figures"), ("T", "tables")):
        for entry in tc_entries[identifier]:
            # A populated catalog repeats each caption once in front matter and
            # once at its actual body location. Count normalized occurrences so
            # Word-added spacing around numbers does not produce false negatives.
            if normalized_visible.count(_normalize_catalog_text(entry)) < 2:
                missing_entries[key].append(entry)
    ok = not missing_markers and not missing_entries["figures"] and not missing_entries["tables"]
    return {
        "checked": True,
        "ok": ok,
        "not_found_markers": missing_markers,
        "missing_figure_catalog_entries": missing_entries["figures"],
        "missing_table_catalog_entries": missing_entries["tables"],
        "figure_tc_entries": len(tc_entries["F"]),
        "table_tc_entries": len(tc_entries["T"]),
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

    with tempfile.TemporaryDirectory(prefix="tech-report-lo-") as profile:
        cmd = [
            libreoffice, "--headless", f"-env:UserInstallation=file://{profile}",
            "--convert-to", "pdf", "--outdir", str(output_dir), str(docx),
        ]
        proc = run(cmd)

    pdf = output_dir / f"{docx.stem}.pdf"
    if not pdf.is_file() or pdf.stat().st_size == 0:
        return {
            "success": False,
            "error": "PDF conversion did not produce a non-empty file",
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "docx_path": str(docx),
        }

    catalog_qa = _catalog_visual_qa(docx, pdf)

    pdftoppm = shutil.which("pdftoppm")
    if not pdftoppm:
        return {
            "success": True,
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
        "success": bool(pngs),
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
