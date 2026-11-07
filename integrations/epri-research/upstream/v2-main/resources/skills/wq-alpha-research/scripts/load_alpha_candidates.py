"""Load candidate alpha lists for submit_batch.py.

Candidate files are JSON arrays of objects with at least:
    expression, decay, truncation, neutralization

This helper keeps optional research branches out of the default submit script.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


REQUIRED_KEYS = {"expression", "decay", "truncation", "neutralization"}


def load_candidates(path: str | Path) -> list[dict[str, Any]]:
    candidate_path = Path(path)
    data = json.loads(candidate_path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"{candidate_path} must contain a JSON array")

    out: list[dict[str, Any]] = []
    for idx, item in enumerate(data, 1):
        if not isinstance(item, dict):
            raise ValueError(f"{candidate_path} item {idx} is not an object")
        missing = REQUIRED_KEYS - item.keys()
        if missing:
            raise ValueError(f"{candidate_path} item {idx} missing keys: {sorted(missing)}")
        out.append(
            {
                **item,
                "decay": int(item["decay"]),
                "truncation": float(item["truncation"]),
                "neutralization": str(item["neutralization"]).upper(),
            }
        )
    return out


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/load_alpha_candidates.py <candidate-json>")
    candidates = load_candidates(sys.argv[1])
    print(f"loaded {len(candidates)} candidates")
    for i, c in enumerate(candidates, 1):
        print(f"{i}. {c.get('name', 'unnamed')}: {c['expression']}")
