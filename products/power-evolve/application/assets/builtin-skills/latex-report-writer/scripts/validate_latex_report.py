#!/usr/bin/env python3
"""Run deterministic checks on a compiled technical-report PDF."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


def run(command: list[str]) -> str:
    result = subprocess.run(command, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{result.stdout}")
    return result.stdout


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--log", type=Path)
    parser.add_argument("--expected-pages", type=int)
    parser.add_argument("--allow-placeholder", action="append", default=[])
    args = parser.parse_args()

    pdf = args.pdf.resolve()
    if not pdf.is_file():
        parser.error(f"PDF not found: {pdf}")

    errors: list[str] = []
    warnings: list[str] = []
    try:
        info = run(["pdfinfo", str(pdf)])
        fonts = run(["pdffonts", str(pdf)])
        text = run(["pdftotext", "-layout", str(pdf), "-"])
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 2

    page_match = re.search(r"^Pages:\s+(\d+)", info, re.MULTILINE)
    size_match = re.search(r"^Page size:\s+([0-9.]+) x ([0-9.]+) pts", info, re.MULTILINE)
    if not page_match:
        errors.append("pdfinfo did not report a page count")
    elif args.expected_pages is not None and int(page_match.group(1)) != args.expected_pages:
        errors.append(f"expected {args.expected_pages} pages, found {page_match.group(1)}")
    if not size_match:
        errors.append("pdfinfo did not report page size")
    else:
        width, height = map(float, size_match.groups())
        if abs(width - 595.28) > 1.0 or abs(height - 841.89) > 1.0:
            errors.append(f"page size is {width:g} x {height:g} pt, not A4")

    font_lines = [line for line in fonts.splitlines() if line.strip() and not line.startswith("name ") and not line.startswith("-" )]
    if not font_lines:
        errors.append("pdffonts reported no fonts")
    for line in font_lines:
        columns = line.split()
        if len(columns) >= 8 and (columns[-5].lower() != "yes" or columns[-4].lower() != "yes"):
            errors.append(f"font is not embedded/subsetted: {line}")
    lower_fonts = fonts.lower()
    if not any(token in lower_fonts for token in ("songti", "simsun", "noto serif cjk", "fandol")):
        warnings.append("no obvious Chinese body font name found in pdffonts output")
    if not any(token in lower_fonts for token in ("heiti", "simhei", "noto sans", "fandol")):
        warnings.append("no obvious Chinese heading font name found in pdffonts output")
    if not any(token in lower_fonts for token in ("times", "tex gyre", "latin modern")):
        warnings.append("no obvious Latin font name found in pdffonts output")

    placeholder_patterns = [r"\{\{[^{}]+\}\}", "待填写", "【此处插入"]
    for pattern in placeholder_patterns:
        if pattern in args.allow_placeholder:
            continue
        if re.search(pattern, text):
            errors.append(f"unresolved placeholder detected: {pattern}")

    if args.log:
        log = args.log.resolve()
        if not log.is_file():
            errors.append(f"log not found: {log}")
        else:
            log_text = log.read_text(encoding="utf-8", errors="replace")
            for line in log_text.splitlines():
                if re.search(r"^!|Overfull|Underfull|LaTeX Warning:|Package .* Warning:", line):
                    errors.append(f"compile log: {line.strip()}")

    print(f"PDF: {pdf}")
    print(f"Pages: {page_match.group(1) if page_match else 'unknown'}")
    print(f"Fonts checked: {len(font_lines)}")
    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")
    if errors:
        return 1
    print("Validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
