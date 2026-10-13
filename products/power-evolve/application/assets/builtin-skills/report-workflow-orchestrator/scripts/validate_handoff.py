#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("file", type=Path)
    ap.add_argument("--kind", choices=["request", "generator-response", "reviewer-response", "formatter-response"], required=True)
    args = ap.parse_args()
    try:
        data = json.loads(args.file.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"ERROR: invalid JSON: {exc}")
        return 2
    errors = []
    if args.kind == "request":
        for key in ("orchestration", "skill_name", "action", "payload"):
            if key not in data: errors.append(f"missing {key}")
        if data.get("orchestration", {}).get("enabled") is not True: errors.append("orchestration.enabled must be true")
        if not data.get("orchestration", {}).get("request_id"): errors.append("missing request_id")
    elif args.kind == "generator-response":
        for key in ("request_id", "skill_name", "action", "status"):
            if key not in data: errors.append(f"missing {key}")
        if data.get("status") == "success":
            art = data.get("artifact") or {}
            for key in ("artifact_type", "artifact_id", "version", "content"):
                if key not in art: errors.append(f"missing artifact.{key}")
            required_handoffs = {
                "generate_outline": "review_outline",
                "revise_outline": "review_outline",
                "generate_chapter": "review_chapter",
                "revise_chapter": "review_chapter",
                "assemble_report": "review_report",
                "revise_report": "review_report",
            }
            expected = required_handoffs.get(data.get("action"))
            if expected:
                handoff = (data.get("metadata") or {}).get("next_required_handoff") or {}
                if handoff.get("skill_name") != "report-reviewer": errors.append("metadata.next_required_handoff.skill_name must be report-reviewer")
                if handoff.get("action") != expected: errors.append(f"metadata.next_required_handoff.action must be {expected}")
                if handoff.get("reviewed_artifact_id") != art.get("artifact_id"): errors.append("next_required_handoff artifact_id mismatch")
                if handoff.get("reviewed_version") != art.get("version"): errors.append("next_required_handoff version mismatch")
    elif args.kind == "reviewer-response":
        for key in ("request_id", "skill_name", "action", "status"):
            if key not in data: errors.append(f"missing {key}")
        if data.get("status") == "success":
            review = data.get("review_result") or {}
            for key in ("reviewed_artifact_id", "reviewed_version", "decision", "overall_score", "issues", "must_fix", "revision_instruction"):
                if key not in review: errors.append(f"missing review_result.{key}")
    else:
        for key in ("request_id", "skill_name", "action", "status"):
            if key not in data: errors.append(f"missing {key}")
        if data.get("status") == "success":
            if data.get("action") in {"create_word_report", "format_existing_word_report"}:
                art = data.get("artifact") or {}
                for key in ("artifact_type", "artifact_id", "version", "content"):
                    if key not in art: errors.append(f"missing artifact.{key}")
                if art.get("artifact_type") != "word_report": errors.append("artifact.artifact_type must be word_report")
            elif data.get("action") == "validate_word_report":
                result = data.get("validation_result") or {}
                for key in ("validated_artifact_id", "validated_version", "decision", "valid", "docx_path", "structural_validation", "visual_qa", "revision_instruction"):
                    if key not in result: errors.append(f"missing validation_result.{key}")
    if errors:
        for x in errors: print("ERROR:", x)
        return 1
    print("handoff validation passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
