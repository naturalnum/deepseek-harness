#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from workflow_engine import (
    apply_response,
    confirm,
    load_json,
    new_state,
    prepare_pending_request,
    request_revision,
    save_json,
    submit_chapter_content_briefs,
    submit_project_intake,
    submit_word_report_metadata,
)


def main() -> int:
    ap = argparse.ArgumentParser(description="Integrated report Skill workflow CLI")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init")
    p.add_argument("state", type=Path)
    p.add_argument("--project-id", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--goal", required=True)
    p.add_argument("--report-type", default="科技项目结题技术报告")
    p.add_argument("--mode", choices=["pending_selection", "source_grounded", "model_autonomous"], default="pending_selection")

    p = sub.add_parser("next")
    p.add_argument("state", type=Path)
    p.add_argument("--registry", type=Path, default=Path(__file__).resolve().parents[1] / "skill-registry.json")
    p.add_argument("--request-out", type=Path)

    p = sub.add_parser("apply")
    p.add_argument("state", type=Path)
    p.add_argument("response", type=Path)
    p.add_argument("--registry", type=Path, default=Path(__file__).resolve().parents[1] / "skill-registry.json")
    p.add_argument("--source-root", type=Path, help="Explicit caller-provided authorized root for local reference bytes")

    p = sub.add_parser("submit-intake")
    p.add_argument("state", type=Path)
    p.add_argument("answers", type=Path, help="JSON file containing answers to the four fixed project-intake questions")

    p = sub.add_parser("submit-chapter-briefs")
    p.add_argument("state", type=Path)
    p.add_argument("answers", type=Path, help="JSON array with one approximate-content item per proposed chapter")

    p = sub.add_parser("submit-word-metadata")
    p.add_argument("state", type=Path)
    p.add_argument("metadata", type=Path, help="JSON object containing cover and Word report metadata")

    p = sub.add_parser("confirm")
    p.add_argument("state", type=Path)
    p.add_argument("target")
    p.add_argument("--source-root", type=Path, help="Recheck local reference bytes beneath this caller-provided root")

    p = sub.add_parser("request-revision", help="Record explicit user feedback on the current unconfirmed version")
    p.add_argument("state", type=Path)
    p.add_argument("target")
    p.add_argument("--artifact-id", required=True)
    p.add_argument("--version", type=int, required=True)
    p.add_argument("--request-id", required=True, help="Stable user request ID; distinct from the next child request ID")
    p.add_argument("--feedback-file", type=Path, required=True, help='Read-only JSON object containing only {"feedback": "nonempty user feedback"}')

    p = sub.add_parser("status")
    p.add_argument("state", type=Path)

    args = ap.parse_args()

    if args.cmd == "init":
        state = new_state(args.project_id, {"title": args.title, "goal": args.goal, "report_type": args.report_type}, args.mode)
        save_json(args.state, state)
        print(f"initialized: {args.state}")
        return 0

    state = load_json(args.state)
    if args.cmd == "next":
        registry = load_json(args.registry)
        state, action = prepare_pending_request(state, registry)
        save_json(args.state, state)
        if args.request_out and not action.get("kind"):
            save_json(args.request_out, action)
            print(args.request_out)
        else:
            print(json.dumps(action, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "apply":
        registry = load_json(args.registry)
        response = load_json(args.response)
        updated = apply_response(state, response, registry, source_root=args.source_root)
        save_json(args.state, updated)
        print(json.dumps({"stage": updated["stage"], "last_error": updated.get("last_error")}, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "submit-intake":
        answers = load_json(args.answers)
        updated = submit_project_intake(state, answers)
        save_json(args.state, updated)
        print(json.dumps({"stage": updated["stage"], "project_intake": "confirmed"}, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "submit-chapter-briefs":
        raw = json.loads(args.answers.read_text(encoding="utf-8"))
        items = raw.get("items") if isinstance(raw, dict) else raw
        updated = submit_chapter_content_briefs(state, items)
        save_json(args.state, updated)
        print(json.dumps({"stage": updated["stage"], "chapter_content_briefs": "confirmed"}, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "submit-word-metadata":
        metadata = load_json(args.metadata)
        updated = submit_word_report_metadata(state, metadata)
        save_json(args.state, updated)
        print(json.dumps({"stage": updated["stage"], "word_report_metadata": "confirmed"}, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "confirm":
        updated = confirm(state, args.target, source_root=args.source_root)
        save_json(args.state, updated)
        print(json.dumps({"stage": updated["stage"], "confirmed": args.target}, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "request-revision":
        feedback = load_json(args.feedback_file)
        if not isinstance(feedback, dict) or set(feedback) != {"feedback"}:
            raise ValueError('feedback file must contain only {"feedback": "nonempty user feedback"}')
        updated = request_revision(state, args.target, args.artifact_id, args.version,
                                   feedback["feedback"], args.request_id)
        save_json(args.state, updated)
        record = next(item for item in updated["user_revision_requests"] if item["request_id"] == args.request_id)
        print(json.dumps({"stage": updated["stage"], "user_request_id": args.request_id,
                          "target": args.target, "revision_status": record["status"]}, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "status":
        summary = {
            "project_id": state["project_id"], "stage": state["stage"],
            "content_generation_mode": state.get("content_generation_mode"),
            "project_intake_status": state.get("project_intake", {}).get("status"),
            "chapter_content_briefs_status": state.get("chapter_content_briefs", {}).get("status"),
            "word_report_metadata_status": state.get("word_report", {}).get("metadata_status"),
            "word_report_status": state.get("word_report", {}).get("status"),
            "current_chapter_id": state.get("current_chapter_id"),
            "chapter_order": state.get("chapter_order", []),
            "confirmed_chapters": [cid for cid, v in state.get("chapters", {}).items() if v.get("status") == "confirmed"],
            "pending_action": state.get("pending_action"), "last_error": state.get("last_error")
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
