#!/usr/bin/env python3
"""Validate H1-to-first-H2 unheaded transition prose."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from report_text_utils import heading_bridge_metrics


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('--mode', choices=['short_50_100','technical_chapter_intro','not_applicable'], default='short_50_100')
    ap.add_argument('--min', dest='minimum', type=int, default=50)
    ap.add_argument('--max', dest='maximum', type=int, default=100)
    args = ap.parse_args()
    text=Path(args.file).read_text(encoding='utf-8')
    metrics=heading_bridge_metrics(text, mode=args.mode, short_min=args.minimum, short_max=args.maximum)
    print(json.dumps(metrics,ensure_ascii=False,indent=2))
    return 0 if metrics['bridge_gate_passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
