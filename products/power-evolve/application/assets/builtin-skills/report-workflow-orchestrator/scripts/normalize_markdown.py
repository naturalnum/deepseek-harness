#!/usr/bin/env python3
"""Normalize a completed Markdown report without invoking a language model."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from report_text_utils import normalize_markdown_file, normalize_markdown_text


def main() -> int:
    ap = argparse.ArgumentParser(description="Normalize final report Markdown deterministically")
    ap.add_argument("input", type=Path)
    target = ap.add_mutually_exclusive_group()
    target.add_argument("--output", type=Path)
    target.add_argument("--in-place", action="store_true")
    ap.add_argument("--dash-style", choices=["hyphen", "em-dash"], default="hyphen")
    ap.add_argument("--keep-digit-cjk-spaces", action="store_true")
    ap.add_argument("--check", action="store_true", help="Do not write; return 1 when normalization is needed")
    args = ap.parse_args()

    original = args.input.read_text(encoding="utf-8")
    normalized, stats = normalize_markdown_text(
        original,
        dash_style=args.dash_style,
        remove_digit_cjk_spaces=not args.keep_digit_cjk_spaces,
    )
    if args.check:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return 1 if stats["changed"] else 0

    output = args.input if args.in_place or args.output is None else args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(normalized, encoding="utf-8")
    stats.update({"input": str(args.input), "output": str(output)})
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
