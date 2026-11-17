#!/usr/bin/env python3
"""Validate that a generated chapter reaches the confirmed minimum length."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from report_text_utils import chapter_length_metrics, fixed_range_length_metrics


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate chapter length against a planned target")
    ap.add_argument("chapter", type=Path, help="Generated Markdown/text chapter")
    ap.add_argument("--target-words", required=True, type=int)
    ap.add_argument("--minimum-ratio", type=float, default=0.8)
    ap.add_argument("--fixed-min-words", type=int)
    ap.add_argument("--fixed-max-words", type=int)
    ap.add_argument("--json-output", type=Path)
    args = ap.parse_args()
    if args.target_words <= 0:
        ap.error("--target-words must be positive")
    if not (0 < args.minimum_ratio <= 1):
        ap.error("--minimum-ratio must be in (0, 1]")

    metrics = chapter_length_metrics(
        args.chapter.read_text(encoding="utf-8"),
        args.target_words,
        args.minimum_ratio,
    )
    rendered = json.dumps(metrics, ensure_ascii=False, indent=2)
    print(rendered)
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(rendered + "\n", encoding="utf-8")
    if not metrics["length_gate_passed"]:
        print(
            f"ERROR: 章节有效字数{metrics['actual_words']}，低于最低要求"
            f"{metrics['minimum_required_words']}（计划{metrics['planned_target_words']}的"
            f"{metrics['minimum_ratio']:.0%}）。",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
