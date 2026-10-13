#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from report_text_utils import abstract_quality_metrics


def _content_from(value: Any) -> Any:
    if isinstance(value, dict):
        if isinstance(value.get("artifact"), dict):
            return value["artifact"].get("content")
        if "content" in value and isinstance(value.get("content"), dict):
            return value["content"]
    return value


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate bilingual abstract length, paragraph structure and ordering markers.")
    ap.add_argument("input", help="JSON file containing abstract content, an artifact, or a generator response")
    ap.add_argument("--json-out", help="Optional path for metrics JSON")
    args = ap.parse_args()

    value = json.loads(Path(args.input).read_text(encoding="utf-8"))
    metrics = abstract_quality_metrics(_content_from(value))
    rendered = json.dumps(metrics, ensure_ascii=False, indent=2)
    print(rendered)
    if args.json_out:
        Path(args.json_out).write_text(rendered + "\n", encoding="utf-8")
    return 0 if metrics["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
