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
    parser.add_argument("--log", type=Path, required=True, help="Final XeLaTeX pass log; required to detect missing glyphs and compile errors")
    parser.add_argument("--font-profile", choices=("template", "portable"), default="template")
    parser.add_argument("--expected-pages", type=int)
    parser.add_argument("--allow-placeholder", action="append", default=[])
    args = parser.parse_args()

    pdf = args.pdf.resolve()
    if not pdf.is_file():
        parser.error(f"PDF not found: {pdf}")

    errors: list[str] = []
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
    font_names: list[str] = []
    for line in font_lines:
        row = re.fullmatch(r"(\S+)\s+.+?\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*", line)
        if not row:
            errors.append(f"unrecognized pdffonts row: {line}")
            continue
        font_names.append(row.group(1))
        if row.group(2) != "yes" or row.group(3) != "yes":
            errors.append(f"font is not embedded/subsetted: {line}")
    normalized_names = [re.sub(r"[^a-z0-9]", "", re.sub(r"^[A-Z]{6}\+", "", name).lower()) for name in font_names]
    required_fonts = {
        "template": {"Chinese body": ("songtisc", "simsun"), "Chinese heading": ("heitisc", "simhei"),
                     "Latin": ("timesnewroman",)},
        # Noto SC TTC faces share a CFF Name INDEX carrying the compact jp name.
        "portable": {"Chinese body": ("notoserifcjksc", "notoserifcjkjp"),
                     "Chinese heading": ("notosanscjksc", "notosanscjkjp"),
                     "Latin": ("texgyretermes",)},
    }
    for role, aliases in required_fonts[args.font_profile].items():
        if not any(alias in name for alias in aliases for name in normalized_names):
            errors.append(f"required {args.font_profile} {role} font unavailable in PDF (expected {', '.join(aliases)})")

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
            profiles = re.findall(r"^TR-FONT-PROFILE:\s*(\S+)\s*$", log_text, re.MULTILINE)
            if profiles and profiles != [args.font_profile]:
                errors.append(f"font profile mismatch: requested {args.font_profile}, log declares {profiles}")
            if args.font_profile == "portable" and not profiles:
                errors.append("portable font profile is not explicitly declared in the compile log")
            declared_fonts = dict(re.findall(r"^TR-FONT-(BODY|HEADING|LATIN|CJK-INDEX):\s*(.+?)\s*$", log_text, re.MULTILINE))
            if args.font_profile == "portable":
                expected = {"BODY": "NotoSerifCJKsc-Regular", "HEADING": "NotoSansCJKsc-Regular",
                            "LATIN": "TeXGyreTermes-Regular", "CJK-INDEX": "2"}
                for role, value in expected.items():
                    if declared_fonts.get(role) != value:
                        errors.append(f"portable font selection mismatch: {role} must be {value}, found {declared_fonts.get(role, 'undeclared')}")
            for role, value in declared_fonts.items():
                print(f"Declared font {role}: {value}")
            for line in log_text.splitlines():
                if re.search(r"^!|Overfull|Underfull|Missing character:|Fatal error|Emergency stop|LaTeX Warning:|(?:Package|Class) .* Warning:", line):
                    errors.append(f"compile log: {line.strip()}")

    print(f"PDF: {pdf}")
    print(f"Pages: {page_match.group(1) if page_match else 'unknown'}")
    print(f"Fonts checked: {len(font_lines)}")
    print(f"Font profile: {args.font_profile}")
    print("Actual PDF fonts: " + ", ".join(font_names))
    for error in errors:
        print(f"ERROR: {error}")
    if errors:
        return 1
    print("Validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
