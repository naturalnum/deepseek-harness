#!/usr/bin/env python3
"""Validate the single chapter-end simulation-data notice."""
from __future__ import annotations
import argparse, json
from pathlib import Path
from report_text_utils import simulation_chapter_end_notice_metrics

def main() -> int:
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("markdown", type=Path)
    ap.add_argument("--required", action="store_true", help="Fail unless exactly one notice is at chapter end")
    ap.add_argument("--json", action="store_true", dest="as_json")
    args=ap.parse_args()
    m=simulation_chapter_end_notice_metrics(args.markdown.read_text(encoding="utf-8"))
    if args.as_json:
        print(json.dumps(m, ensure_ascii=False, indent=2))
    else:
        print(("PASS" if (m.get("notice_gate_passed") or not args.required) else "FAIL") + f": count={m.get('notice_count')}, at_end={m.get('notice_at_chapter_end')}")
    return 0 if (m.get("notice_gate_passed") or not args.required) else 1

if __name__ == "__main__":
    raise SystemExit(main())
