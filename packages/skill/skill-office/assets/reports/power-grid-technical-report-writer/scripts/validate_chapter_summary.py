#!/usr/bin/env python3
"""Validate a technical chapter's 本章小结 against the canonical 500–600字 rule."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
from report_text_utils import chapter_summary_metrics


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("markdown", type=Path)
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args()
    if not args.markdown.is_file():
        ap.error(f"Markdown file not found: {args.markdown}")
    metrics = chapter_summary_metrics(args.markdown.read_text(encoding="utf-8"))
    if args.as_json:
        print(json.dumps(metrics, ensure_ascii=False, indent=2))
    else:
        if not metrics.get("detected"):
            print("SKIP: 未检测到‘本章小结’二级标题。")
            return 0
        print(
            f"{'PASS' if metrics.get('summary_gate_passed') else 'FAIL'}: "
            f"total={metrics.get('actual_words')}, opening={metrics.get('opening_words')}, "
            f"middle={metrics.get('middle_words')}, ending={metrics.get('ending_words')}, "
            f"paragraphs={metrics.get('paragraph_count')}"
        )
    return 0 if metrics.get("summary_gate_passed", True) else 1

if __name__ == "__main__":
    raise SystemExit(main())
