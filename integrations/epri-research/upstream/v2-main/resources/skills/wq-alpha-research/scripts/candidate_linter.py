"""Static preflight checks for WQ BRAIN alpha candidate JSON files.

The linter is intentionally conservative. It does not know BRAIN's full parser,
but it catches common local failure modes before spending simulation quota:
operator-count risk, unaggregated VECTOR fields, unknown identifiers, crowded
core components, cap-gated small-cap exposure, low coverage, and high field
crowding.
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from load_alpha_candidates import load_candidates


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
FIELDS_PATH = SKILL_DIR / "references" / "wq_usa_top3000_delay1_data_fields.json"

IDENT_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")
CALL_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\s*\(")

GROUP_NAMES = {
    "market",
    "sector",
    "industry",
    "subindustry",
    "country",
    "exchange",
}

CONSTANT_NAMES = {"nan", "true", "false", "inf"}

OPERATOR_NAMES = {
    "abs",
    "add",
    "and",
    "arc_cos",
    "arc_sin",
    "arc_tan",
    "bucket",
    "ceil",
    "clamp",
    "densify",
    "divide",
    "equal",
    "exp",
    "floor",
    "group_backfill",
    "group_count",
    "group_mean",
    "group_neutralize",
    "group_rank",
    "group_sum",
    "group_zscore",
    "if_else",
    "inverse",
    "is_nan",
    "less",
    "log",
    "max",
    "min",
    "multiply",
    "normalize",
    "not",
    "or",
    "power",
    "rank",
    "regression_beta",
    "regression_neut",
    "regression_proj",
    "reverse",
    "scale",
    "signed_power",
    "sqrt",
    "subtract",
    "trade_when",
    "ts_arg_max",
    "ts_arg_min",
    "ts_backfill",
    "ts_corr",
    "ts_count_nans",
    "ts_covariance",
    "ts_decay_exp_window",
    "ts_decay_linear",
    "ts_delta",
    "ts_ir",
    "ts_kurtosis",
    "ts_max",
    "ts_mean",
    "ts_median",
    "ts_min",
    "ts_product",
    "ts_quantile",
    "ts_rank",
    "ts_regression",
    "ts_scale",
    "ts_skewness",
    "ts_std_dev",
    "ts_step",
    "ts_sum",
    "ts_zscore",
    "vec_avg",
    "vec_choose",
    "vec_count",
    "vec_ir",
    "vec_kurtosis",
    "vec_max",
    "vec_min",
    "vec_norm",
    "vec_percentage",
    "vec_powersum",
    "vec_range",
    "vec_rank",
    "vec_skewness",
    "vec_stddev",
    "vec_sum",
    "winsorize",
    "zscore",
}

VECTOR_AGGREGATORS = {
    "vec_avg",
    "vec_sum",
    "vec_count",
    "vec_ir",
    "vec_kurtosis",
    "vec_max",
    "vec_min",
    "vec_norm",
    "vec_percentage",
    "vec_powersum",
    "vec_range",
    "vec_rank",
    "vec_skewness",
    "vec_stddev",
}

CROWDING_PATTERNS: list[tuple[str, re.Pattern[str], int, str]] = [
    (
        "direct_eps_or_eps_like_estimate",
        re.compile(r"\b(est_eps|[^A-Za-z0-9_]eps[a-z0-9_]*|epsa|custom_eps)\b", re.I),
        20,
        "EPS-like estimates are usually strong but highly crowded; keep as a small sleeve or use non-EPS analyst fields.",
    ),
    (
        "direct_profitability_quality",
        re.compile(r"operating_income\s*/\s*(equity|assets|sales)|operating_profit_before_depr_amort\s*/\s*enterprise_value", re.I),
        16,
        "Direct profitability/quality cores are crowded; use only if the parent mechanism is otherwise distinct.",
    ),
    (
        "open_close_reversal",
        re.compile(r"close\s*/\s*open\s*-\s*1|open\s*/\s*close|rank\s*\(\s*-\s*\(\s*close\s*/\s*open", re.I),
        10,
        "Open-close reversal is useful but occupied; avoid making it the main source of return.",
    ),
    (
        "buyback_or_payout",
        re.compile(r"buyback|dividend|payout|treasury_stock", re.I),
        10,
        "Buyback/payout sleeves often collide with quality/shareholder-yield capacity.",
    ),
    (
        "contract_or_deferred_revenue",
        re.compile(r"fnd6_drc|fnd6_drlt|deferred", re.I),
        10,
        "Deferred-revenue/contract residuals have shown LSUS fragility unless paired with a very strong parent.",
    ),
    (
        "relationship_or_competitor",
        re.compile(r"rel_ret_comp|rel_num_comp|competitor|pv13_.*comp|rp_.*product", re.I),
        12,
        "Relationship/product/competitor signals need a fresh parent or they become near-neighbor variants.",
    ),
    (
        "debt_credit_leverage",
        re.compile(r"debt|liabil|credit|interest", re.I),
        8,
        "Debt and credit fields are meaningful but have repeatedly needed extra robustness checks.",
    ),
]


@dataclass
class Finding:
    severity: str
    code: str
    message: str


@dataclass
class LintResult:
    idx: int
    name: str
    operator_count: int
    fields: list[str]
    categories: dict[str, int]
    datasets: dict[str, int]
    score: int
    decision: str
    findings: list[Finding] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "idx": self.idx,
            "name": self.name,
            "operator_count": self.operator_count,
            "field_count": len(self.fields),
            "fields": self.fields,
            "categories": self.categories,
            "datasets": self.datasets,
            "score": self.score,
            "decision": self.decision,
            "findings": [finding.__dict__ for finding in self.findings],
        }


def load_field_map() -> dict[str, dict[str, Any]]:
    fields = json.loads(FIELDS_PATH.read_text(encoding="utf-8"))
    return {field["id"]: field for field in fields}


def find_matching_paren(expr: str, open_idx: int) -> int | None:
    depth = 0
    for idx in range(open_idx, len(expr)):
        ch = expr[idx]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return idx
    return None


def vector_aggregator_spans(expr: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for op in VECTOR_AGGREGATORS:
        for match in re.finditer(rf"\b{re.escape(op)}\s*\(", expr):
            open_idx = expr.find("(", match.start())
            close_idx = find_matching_paren(expr, open_idx)
            if close_idx is not None:
                spans.append((match.start(), close_idx + 1))
    return spans


def inside_any_span(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(start <= pos < end for start, end in spans)


def approx_operator_count(expr: str) -> int:
    calls = len(CALL_RE.findall(expr))
    arithmetic = sum(expr.count(op) for op in ["+", "-", "*", "/", ">", "<"])
    comparisons = len(re.findall(r"==|!=|>=|<=", expr))
    return calls + arithmetic + comparisons


def expression_fields(expr: str, field_map: dict[str, dict[str, Any]]) -> list[str]:
    tokens = set(IDENT_RE.findall(expr))
    return sorted(token for token in tokens if token in field_map and token.lower() not in GROUP_NAMES)


def unknown_identifiers(expr: str, field_map: dict[str, dict[str, Any]]) -> list[str]:
    tokens = set(IDENT_RE.findall(expr))
    known = set(field_map) | OPERATOR_NAMES | GROUP_NAMES | CONSTANT_NAMES
    return sorted(token for token in tokens if token.lower() not in known and token not in known)


def lint_candidate(idx: int, candidate: dict[str, Any], field_map: dict[str, dict[str, Any]]) -> LintResult:
    expr = candidate["expression"]
    name = candidate.get("name") or f"candidate_{idx}"
    findings: list[Finding] = []
    fields = expression_fields(expr, field_map)
    operator_count = approx_operator_count(expr)

    if operator_count >= 64:
        findings.append(
            Finding("ERROR", "operator_limit", f"Approx operator count {operator_count} is at/over the 64-operator limit.")
        )
    elif operator_count >= 58:
        findings.append(
            Finding("WARN", "operator_frontier", f"Approx operator count {operator_count} is close to the limit; compress before live simulation.")
        )

    unknown = unknown_identifiers(expr, field_map)
    if unknown:
        sample = ", ".join(unknown[:8])
        findings.append(Finding("WARN", "unknown_identifier", f"Unknown identifiers detected: {sample}"))

    vec_spans = vector_aggregator_spans(expr)
    for field_id in fields:
        meta = field_map[field_id]
        if str(meta.get("type", "")).upper() == "VECTOR":
            positions = [match.start() for match in re.finditer(rf"\b{re.escape(field_id)}\b", expr)]
            if positions and not all(inside_any_span(pos, vec_spans) for pos in positions):
                findings.append(
                    Finding(
                        "ERROR",
                        "unaggregated_vector_field",
                        f"Vector field {field_id} appears outside vec_* aggregation.",
                    )
                )

    low_coverage = []
    high_crowd_fields = []
    for field_id in fields:
        meta = field_map[field_id]
        coverage = meta.get("coverage")
        alpha_count = meta.get("alphaCount") or 0
        try:
            coverage_float = float(coverage)
        except (TypeError, ValueError):
            coverage_float = 0.0
        if coverage_float and coverage_float < 0.50:
            low_coverage.append((field_id, coverage_float))
        if alpha_count >= 1000:
            high_crowd_fields.append((field_id, alpha_count))

    if low_coverage:
        sample = ", ".join(f"{fid}:{cov:.2f}" for fid, cov in low_coverage[:5])
        findings.append(Finding("WARN", "low_coverage_field", f"Low coverage fields need simple probes first: {sample}"))
    if high_crowd_fields:
        sample = ", ".join(f"{fid}:{count}" for fid, count in high_crowd_fields[:5])
        findings.append(Finding("WARN", "crowded_field", f"High alphaCount fields increase self-correlation risk: {sample}"))

    matched_tags = []
    crowd_penalty = 0
    for tag, pattern, penalty, message in CROWDING_PATTERNS:
        if pattern.search(expr):
            matched_tags.append(tag)
            crowd_penalty += penalty
            findings.append(Finding("INFO", tag, message))
    if len(matched_tags) >= 3:
        findings.append(
            Finding(
                "WARN",
                "crowded_component_stack",
                "Several occupied components appear together; require a distinct primary mechanism before simulation.",
            )
        )

    if re.search(r"rank\s*\(\s*cap\s*\)\s*[<>]", expr, re.I) or re.search(r"\bcap\s*[<>]", expr, re.I):
        findings.append(
            Finding(
                "WARN",
                "cap_gate_lsus_risk",
                "Cap gate or size exposure detected; discount local estimates for sub-universe robustness risk.",
            )
        )

    if "-" in expr and crowd_penalty >= 25 and re.search(r"-\s*0?\.\d+", expr):
        findings.append(
            Finding(
                "INFO",
                "residual_guardrail",
                "Residual subtraction from crowded components should be used only when the removed sleeve is not the return source.",
            )
        )

    categories: dict[str, int] = {}
    datasets: dict[str, int] = {}
    for field_id in fields:
        meta = field_map[field_id]
        category = (meta.get("category") or {}).get("id") or "unknown"
        dataset = (meta.get("dataset") or {}).get("id") or "unknown"
        categories[category] = categories.get(category, 0) + 1
        datasets[dataset] = datasets.get(dataset, 0) + 1

    score = 100
    for finding in findings:
        if finding.severity == "ERROR":
            score -= 40
        elif finding.severity == "WARN":
            score -= 12
        elif finding.severity == "INFO":
            score -= 3
    score -= min(30, crowd_penalty // 2)
    score = max(0, min(100, score))

    if any(f.severity == "ERROR" for f in findings):
        decision = "BLOCK"
    elif score < 60 or any(f.severity == "WARN" for f in findings):
        decision = "REVIEW"
    else:
        decision = "PASS"

    return LintResult(
        idx=idx,
        name=name,
        operator_count=operator_count,
        fields=fields,
        categories=dict(sorted(categories.items())),
        datasets=dict(sorted(datasets.items())),
        score=score,
        decision=decision,
        findings=findings,
    )


def print_text(results: list[LintResult]) -> None:
    for result in results:
        cats = ", ".join(f"{key}:{value}" for key, value in result.categories.items()) or "none"
        dsets = ", ".join(f"{key}:{value}" for key, value in result.datasets.items()) or "none"
        print(f"[{result.idx}] {result.name}")
        print(f"  decision={result.decision} score={result.score} approx_ops={result.operator_count} fields={len(result.fields)}")
        print(f"  categories: {cats}")
        print(f"  datasets: {dsets}")
        for finding in result.findings:
            print(f"  {finding.severity}: {finding.code}: {finding.message}")
        print()

    counts: dict[str, int] = {}
    for result in results:
        counts[result.decision] = counts.get(result.decision, 0) + 1
    summary = ", ".join(f"{key}={counts[key]}" for key in sorted(counts))
    print(f"Summary: {summary}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Lint WQ alpha candidate JSON before simulation.")
    parser.add_argument("candidate_file", help="JSON candidate file accepted by load_alpha_candidates.py")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    parser.add_argument("--fail-on-block", action="store_true", help="Exit non-zero when any candidate is BLOCK")
    args = parser.parse_args()

    field_map = load_field_map()
    candidates = load_candidates(args.candidate_file)
    results = [lint_candidate(idx, candidate, field_map) for idx, candidate in enumerate(candidates, 1)]

    if args.json:
        print(json.dumps([result.as_dict() for result in results], indent=2, ensure_ascii=False))
    else:
        print_text(results)

    if args.fail_on_block and any(result.decision == "BLOCK" for result in results):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
