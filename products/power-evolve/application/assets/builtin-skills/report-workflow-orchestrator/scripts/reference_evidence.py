"""Bind new reference plans to the generator's shared metadata/local-byte gate."""
from __future__ import annotations

from functools import lru_cache
import importlib.util
from pathlib import Path
from typing import Any

REFERENCE_EVIDENCE_CONTRACT = 2


@lru_cache(maxsize=1)
def _validator():
    path = Path(__file__).resolve().parents[2] / "power-grid-technical-report-writer" / "scripts" / "validate_references.py"
    spec = importlib.util.spec_from_file_location("report_reference_validator", path)
    if spec is None or spec.loader is None:
        raise ValueError("generator reference validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reference_quality_issues(artifact: Any, *, source_root: Path | None = None,
                             required_contract: int | None = None) -> list[str]:
    if not isinstance(artifact, dict) or artifact.get("artifact_type") != "reference_plan":
        return ["reference_plan requires a structured reference_plan artifact"]
    content = artifact.get("content")
    if not isinstance(content, dict):
        return ["reference_plan content must be an object"]
    declared = artifact.get("reference_evidence_contract")
    if ((required_contract is not None and (type(required_contract) is not int or required_contract != 2))
            or (declared is not None and (type(declared) is not int or declared != 2))):
        return ["unsupported reference_evidence_contract"]
    validator = _validator()
    outside_content = {key: value for key, value in artifact.items() if key != "content"}
    if validator.has_local_evidence_metadata(outside_content):
        return ["local evidence belongs only to reference_plan.content.items"]
    placeholder_issues = validator.placeholder_http_issues(outside_content)
    if placeholder_issues:
        return placeholder_issues
    local = validator.has_local_file_evidence(content)
    modern = required_contract == 2 or declared == 2 or "items" in content
    if modern:
        if any(key in content for key in ("reference_registry", "references", "verified_references")):
            return ["contract 2 requires only top-level internet_access/items, without duplicate registry aliases"]
        return validator.validate_reference_registry(content, source_root=source_root)
    if local:
        return ["local file evidence cannot use a legacy reference plan"]
    # Retain the captured pre-contract external-only shape, without inventing missing
    # verification metadata or retroactively claiming it passed the modern validator.
    references = content.get("references")
    if (not isinstance(references, list) or not all(isinstance(item, dict)
            and all(item.get(key) for key in ("ref_id", "type", "gbt7714", "supports"))
            for item in references)):
        return ["legacy external reference plan requires the existing references shape"]
    return validator.placeholder_http_issues(content)


def validate_reference_artifact(artifact: dict[str, Any], *, source_root: Path | None = None,
                                required_contract: int | None = None) -> dict[str, Any]:
    issues = reference_quality_issues(artifact, source_root=source_root, required_contract=required_contract)
    if issues:
        raise ValueError("reference evidence validation failed: " + "; ".join(issues))
    result = dict(artifact)
    if required_contract == 2 or "items" in result["content"] or result.get("reference_evidence_contract") == 2:
        result["reference_evidence_contract"] = REFERENCE_EVIDENCE_CONTRACT
    return result
