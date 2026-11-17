#!/usr/bin/env python3
"""Render every PDF page to PNG using Poppler's pdftoppm."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--prefix", default="page")
    args = parser.parse_args()

    pdf = args.pdf.resolve()
    if not pdf.is_file():
        parser.error(f"PDF not found: {pdf}")
    if shutil.which("pdftoppm") is None:
        print("pdftoppm is required for visual PDF QA", file=sys.stderr)
        return 2
    if args.dpi <= 0:
        parser.error("--dpi must be positive")

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    prefix = output_dir / args.prefix
    command = ["pdftoppm", "-png", "-r", str(args.dpi), str(pdf), str(prefix)]
    result = subprocess.run(command, text=True)
    if result.returncode:
        return result.returncode
    pages = sorted(output_dir.glob(f"{args.prefix}-*.png"))
    print(f"Rendered {len(pages)} pages to {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
