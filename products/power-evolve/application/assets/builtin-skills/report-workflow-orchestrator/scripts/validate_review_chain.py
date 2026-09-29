#!/usr/bin/env python3
"""Validate mandatory reviewer and Word validation chains."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def latest(slot: dict[str, Any]) -> dict[str, Any] | None:
    values = slot.get("versions", [])
    return values[-1] if values else None


def has_pass(slot: dict[str, Any], artifact: dict[str, Any] | None) -> bool:
    if not artifact:
        return False
    for review in reversed(slot.get("reviews", [])):
        if str(review.get("review_source", "")).startswith("deterministic_"):
            continue
        if review.get("decision") != "pass":
            continue
        if review.get("reviewed_version") != artifact.get("version"):
            continue
        if artifact.get("artifact_id") and review.get("reviewed_artifact_id") != artifact.get("artifact_id"):
            continue
        required = {
            "reviewed_artifact_id", "reviewed_version", "decision", "overall_score",
            "issues", "must_fix", "revision_instruction",
        }
        if required.issubset(review):
            return True
    return False


def has_word_pass(slot: dict[str, Any], artifact: dict[str, Any] | None) -> bool:
    if not artifact:
        return False
    for result in reversed(slot.get("reviews", [])):
        if result.get("decision") != "pass" or result.get("valid") is not True:
            continue
        if result.get("validated_version") != artifact.get("version"):
            continue
        if result.get("validated_artifact_id") != artifact.get("artifact_id"):
            continue
        structural = result.get("structural_validation") or {}
        visual = result.get("visual_qa") or {}
        page_count = int(visual.get("page_count") or 0)
        inspected = set(visual.get("inspected_pages") or [])
        if structural.get("passed") is True and visual.get("status") == "passed" and page_count > 0 and len(inspected) >= page_count:
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate mandatory report-reviewer handoffs in a workflow state")
    ap.add_argument("state", type=Path)
    args = ap.parse_args()
    state = load(args.state)
    errors: list[str] = []

    outline_slot = state.get("artifacts", {}).get("outline")
    if outline_slot and outline_slot.get("approved_version") is not None:
        artifact = next((x for x in outline_slot.get("versions", []) if x.get("version") == outline_slot.get("approved_version")), None)
        if not has_pass(outline_slot, artifact):
            errors.append("approved outline has no structured report-reviewer pass result for its approved version")

    for chapter_id, chapter in state.get("chapters", {}).items():
        if chapter.get("status") != "confirmed":
            continue
        slot = chapter.get("content", {})
        approved = slot.get("approved_version")
        artifact = next((x for x in slot.get("versions", []) if x.get("version") == approved), None)
        if not has_pass(slot, artifact):
            errors.append(f"confirmed chapter {chapter_id} has no structured report-reviewer pass result")

    report_slot = state.get("artifacts", {}).get("report")
    if state.get("stage") == "COMPLETED" or (report_slot and report_slot.get("approved_version") is not None):
        approved = (report_slot or {}).get("approved_version")
        artifact = next((x for x in (report_slot or {}).get("versions", []) if x.get("version") == approved), None)
        if not has_pass(report_slot or {}, artifact):
            errors.append("completed report has no structured report-reviewer pass result for its approved version")

    word_slot = state.get("artifacts", {}).get("word_report")
    if state.get("stage") == "COMPLETED":
        artifact = latest(word_slot or {})
        if not has_word_pass(word_slot or {}, artifact):
            errors.append("completed workflow has no structural and full-page visual validation pass for the final Word report")

    if errors:
        print("review chain validation failed")
        for error in errors:
            print("ERROR:", error)
        return 1
    print("review chain validation passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
