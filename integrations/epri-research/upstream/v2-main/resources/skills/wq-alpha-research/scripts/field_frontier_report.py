"""Local field frontier report for WQ alpha research.

This script compares the bundled USA TOP3000 delay-1 field metadata with the
local alpha database. It helps choose research lanes before writing candidate
expressions, without calling the BRAIN API.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
FIELDS_PATH = SKILL_DIR / "references" / "wq_usa_top3000_delay1_data_fields.json"
ALPHA_DB_PATH = SKILL_DIR / "alpha_db.json"

IDENT_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")

GROUP_NAMES = {
    "market",
    "sector",
    "industry",
    "subindustry",
    "country",
    "exchange",
}

NON_SIGNAL_ID_RE = re.compile(
    r"(cusip|isin|sedol|ticker|bbgid|figi|permno|gvkey|company_name|security_name|currency|exchange|country|date)$",
    re.I,
)


def load_fields() -> list[dict[str, Any]]:
    return json.loads(FIELDS_PATH.read_text(encoding="utf-8"))


def load_alpha_db() -> dict[str, Any]:
    if not ALPHA_DB_PATH.exists():
        return {"alphas": {}}
    return json.loads(ALPHA_DB_PATH.read_text(encoding="utf-8"))


def field_category(field: dict[str, Any]) -> str:
    return (field.get("category") or {}).get("id") or "unknown"


def field_dataset(field: dict[str, Any]) -> str:
    return (field.get("dataset") or {}).get("id") or "unknown"


def field_coverage(field: dict[str, Any]) -> float:
    try:
        return float(field.get("coverage") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def is_signal_like(field: dict[str, Any]) -> bool:
    field_id = field["id"]
    description = field.get("description") or ""
    if NON_SIGNAL_ID_RE.search(field_id):
        return False
    if re.search(r"\b(identifier|security name|company name|ticker|isin|cusip|sedol)\b", description, re.I):
        return False
    return True


def extract_used_fields(alpha_db: dict[str, Any], field_ids: set[str]) -> tuple[Counter[str], Counter[str]]:
    all_used: Counter[str] = Counter()
    active_used: Counter[str] = Counter()
    for alpha in alpha_db.get("alphas", {}).values():
        expr = alpha.get("expression") or ""
        tokens = set(IDENT_RE.findall(expr))
        used = {token for token in tokens & field_ids if token.lower() not in GROUP_NAMES}
        all_used.update(used)
        if alpha.get("status") == "ACTIVE":
            active_used.update(used)
    return all_used, active_used


def summarize_categories(fields: list[dict[str, Any]], all_used: Counter[str], active_used: Counter[str]) -> list[dict[str, Any]]:
    by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for field in fields:
        by_category[field_category(field)].append(field)

    rows = []
    for category, cat_fields in sorted(by_category.items(), key=lambda item: (-len(item[1]), item[0])):
        total = len(cat_fields)
        used_unique = sum(1 for field in cat_fields if field["id"] in all_used)
        active_unique = sum(1 for field in cat_fields if field["id"] in active_used)
        active_mentions = sum(active_used[field["id"]] for field in cat_fields)
        rows.append(
            {
                "category": category,
                "total_fields": total,
                "used_unique": used_unique,
                "active_unique": active_unique,
                "active_mentions": active_mentions,
                "active_unique_rate": active_unique / total if total else 0.0,
            }
        )
    return rows


def dataset_rows(fields: list[dict[str, Any]], all_used: Counter[str], active_used: Counter[str]) -> list[dict[str, Any]]:
    by_dataset: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for field in fields:
        by_dataset[field_dataset(field)].append(field)

    rows = []
    for dataset, dset_fields in by_dataset.items():
        signal_fields = [field for field in dset_fields if is_signal_like(field)]
        if not signal_fields:
            continue
        high_cov_low_crowd = [
            field
            for field in signal_fields
            if field_coverage(field) >= 0.75 and (field.get("alphaCount") or 0) <= 50
        ]
        unused_high_cov_low_crowd = [
            field for field in high_cov_low_crowd if field["id"] not in all_used
        ]
        active_unique = sum(1 for field in signal_fields if field["id"] in active_used)
        rows.append(
            {
                "dataset": dataset,
                "category": field_category(signal_fields[0]),
                "total_signal_fields": len(signal_fields),
                "active_unique": active_unique,
                "high_cov_low_crowd": len(high_cov_low_crowd),
                "unused_high_cov_low_crowd": len(unused_high_cov_low_crowd),
                "frontier_score": len(unused_high_cov_low_crowd) + max(0, len(high_cov_low_crowd) - active_unique),
            }
        )
    rows.sort(key=lambda row: (row["frontier_score"], row["unused_high_cov_low_crowd"]), reverse=True)
    return rows


def frontier_fields(
    fields: list[dict[str, Any]],
    all_used: Counter[str],
    active_used: Counter[str],
    category: str | None,
    field_type: str | None,
    limit: int,
) -> list[dict[str, Any]]:
    out = []
    for field in fields:
        if category and field_category(field) != category:
            continue
        if field_type and str(field.get("type", "")).upper() != field_type.upper():
            continue
        if not is_signal_like(field):
            continue
        coverage = field_coverage(field)
        alpha_count = field.get("alphaCount") or 0
        user_count = field.get("userCount") or 0
        if coverage < 0.70 or alpha_count > 100:
            continue
        if field["id"] in active_used:
            continue
        novelty = 1.0 if field["id"] not in all_used else 0.4
        score = coverage * 100 + novelty * 25 - min(alpha_count, 100) * 0.35 - min(user_count, 100) * 0.15
        out.append(
            {
                "id": field["id"],
                "category": field_category(field),
                "dataset": field_dataset(field),
                "type": field.get("type"),
                "coverage": coverage,
                "alphaCount": alpha_count,
                "userCount": user_count,
                "used_before": field["id"] in all_used,
                "score": round(score, 2),
                "description": (field.get("description") or "")[:120],
            }
        )
    out.sort(key=lambda row: row["score"], reverse=True)
    return out[:limit]


def print_table(rows: list[dict[str, Any]], columns: list[str]) -> None:
    if not rows:
        print("(none)")
        return
    widths = {col: len(col) for col in columns}
    for row in rows:
        for col in columns:
            widths[col] = max(widths[col], len(str(row.get(col, ""))))
    header = "  ".join(col.ljust(widths[col]) for col in columns)
    print(header)
    print("  ".join("-" * widths[col] for col in columns))
    for row in rows:
        print("  ".join(str(row.get(col, "")).ljust(widths[col]) for col in columns))


def print_text(report: dict[str, Any]) -> None:
    snapshot = report["snapshot"]
    print("Alpha Snapshot")
    print(f"  tracked={snapshot['tracked_alphas']} active={snapshot['active_alphas']}")
    print(f"  fields={snapshot['total_fields']} used_unique={snapshot['used_unique']} active_used_unique={snapshot['active_used_unique']}")
    print()

    print("Category Utilization")
    cat_rows = [
        {
            **row,
            "active_unique_rate": f"{row['active_unique_rate']:.1%}",
        }
        for row in report["categories"]
    ]
    print_table(cat_rows, ["category", "total_fields", "used_unique", "active_unique", "active_unique_rate", "active_mentions"])
    print()

    print("Dataset Frontiers")
    print_table(
        report["dataset_frontiers"][:12],
        ["dataset", "category", "total_signal_fields", "active_unique", "high_cov_low_crowd", "unused_high_cov_low_crowd", "frontier_score"],
    )
    print()

    print("High-Coverage Low-Crowd Field Ideas")
    field_rows = [
        {
            key: row[key]
            for key in ["id", "category", "dataset", "type", "coverage", "alphaCount", "userCount", "used_before"]
        }
        for row in report["frontier_fields"]
    ]
    print_table(field_rows, ["id", "category", "dataset", "type", "coverage", "alphaCount", "userCount", "used_before"])
    print()

    print("Research Hints")
    print("  - Treat unused VECTOR fields as syntax frontiers first; wrap with vec_* and probe before building composites.")
    print("  - A cold field is not automatically a good parent. Prefer high coverage, interpretable economics, and matrix fields for first probes.")
    print("  - If a dataset has many cold fields but no active usage, start with simple probes and stop quickly after repeated LOW_SHARPE or LSUS failures.")


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    fields = load_fields()
    field_ids = {field["id"] for field in fields}
    alpha_db = load_alpha_db()
    all_used, active_used = extract_used_fields(alpha_db, field_ids)
    tracked = len(alpha_db.get("alphas", {}))
    active = sum(1 for alpha in alpha_db.get("alphas", {}).values() if alpha.get("status") == "ACTIVE")

    return {
        "snapshot": {
            "tracked_alphas": tracked,
            "active_alphas": active,
            "total_fields": len(fields),
            "used_unique": len(all_used),
            "active_used_unique": len(active_used),
        },
        "categories": summarize_categories(fields, all_used, active_used),
        "dataset_frontiers": dataset_rows(fields, all_used, active_used),
        "frontier_fields": frontier_fields(fields, all_used, active_used, args.category, args.type, args.limit),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize underused WQ data-field frontiers from local metadata.")
    parser.add_argument("--category", help="Optional category filter, e.g. analyst, news, option")
    parser.add_argument("--type", help="Optional field type filter, e.g. MATRIX or VECTOR")
    parser.add_argument("--limit", type=int, default=30, help="Number of field ideas to print")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    args = parser.parse_args()

    report = build_report(args)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print_text(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
