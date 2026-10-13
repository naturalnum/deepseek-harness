#!/usr/bin/env python3
"""Compile a XeLaTeX report twice and optionally copy the PDF to a stable path."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("tex", type=Path, help="Main .tex file")
    parser.add_argument("--output-pdf", type=Path, help="Optional destination PDF")
    parser.add_argument("--engine", default="xelatex", help="XeLaTeX executable")
    parser.add_argument("--passes", type=int, default=2)
    args = parser.parse_args()

    tex = args.tex.resolve()
    if tex.suffix.lower() != ".tex" or not tex.is_file():
        parser.error(f"not a .tex file: {tex}")
    if args.passes < 1:
        parser.error("--passes must be at least 1")

    command = [args.engine, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", tex.name]
    for pass_number in range(1, args.passes + 1):
        print(f"XeLaTeX pass {pass_number}/{args.passes}: {' '.join(command)}")
        result = subprocess.run(command, cwd=tex.parent, text=True)
        if result.returncode:
            print(f"XeLaTeX failed on pass {pass_number}; inspect {tex.with_suffix('.log')}", file=sys.stderr)
            return result.returncode

    pdf = tex.with_suffix(".pdf")
    if not pdf.is_file():
        print(f"XeLaTeX completed but did not create {pdf}", file=sys.stderr)
        return 1

    if args.output_pdf:
        destination = args.output_pdf.resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(pdf, destination)
        print(f"PDF copied to {destination}")
    else:
        print(f"PDF created at {pdf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
