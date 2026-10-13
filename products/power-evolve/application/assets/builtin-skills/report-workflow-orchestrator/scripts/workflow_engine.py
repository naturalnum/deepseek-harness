#!/usr/bin/env python3
"""File-based state machine for the integrated report Skill suite.

The engine does not call an LLM itself. It creates standard child-Skill requests and
applies their JSON responses, so it can be embedded in any agent framework.
"""
from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from reference_evidence import REFERENCE_EVIDENCE_CONTRACT, validate_reference_artifact
from report_text_utils import (
    abstract_quality_metrics,
    chapter_length_metrics,
    chapter_summary_metrics,
    simulation_chapter_end_notice_metrics,
    fixed_range_length_metrics,
    content_to_text,
    find_chapter_target_words,
    heading_bridge_metrics,
    normalize_markdown_text,
    outline_title_violations,
    outline_based_on_ratio_violations,
    outline_power_domain_visibility_violations,
    outline_chinese_technology_heading_violations,
    outline_level2_subject_power_violations,
    outline_evaluation_heading_violations,
    outline_heading_ending_distribution_violations,
    outline_heading_source_term_violations,
    outline_technology_option_violations,
    outline_level3_task_subject_violations,
)

PROJECT_INTAKE_QUESTIONS = [
    {
        "id": "task_book",
        "question": "有没有任务书？如果有，本报告对应任务书中的哪个课题，还是任务书总报告？",
        "required": True,
        "answer_schema": {
            "available": "boolean",
            "scope": "课题 | 总报告 | 无任务书",
            "topic_name_or_number": "string，可为空",
        },
    },
    {
        "id": "content_generation_mode",
        "question": "后续内容生成依据选择哪种模式：基于已有内容生成，还是交由大模型自行生成？",
        "required": True,
        "options": ["source_grounded", "model_autonomous"],
    },
    {
        "id": "report_constraints",
        "question": "是否有指定报告字数、模板或章节数量要求？",
        "required": True,
        "answer_schema": {
            "has_requirements": "boolean",
            "target_words": "integer|string|null",
            "template": "string|null",
            "chapter_count": "integer|null",
        },
    },
    {
        "id": "experimental_data",
        "question": "有没有可提供的实验数据？没有也可以，不会限制实验部分生成；后续将由大模型生成实验设置、数据集方案、对比/消融设计、模拟数据和结果分析，供补做实验或替换；内部保留来源状态，正式报告仅在使用模拟数据的章节末尾统一说明一次。",
        "required": True,
        "answer_schema": {
            "available": "boolean",
            "description": "string，可为空",
            "files_or_locations": "array，可为空",
        },
    },
]

WORD_REPORT_METADATA_FIELDS = [
    {"id": "report_no", "question": "报告编号是什么？", "required": True, "user_confirmation_required": True},
    {"id": "class_no", "question": "分类号是什么？", "required": True, "user_confirmation_required": True},
    {"id": "secret_level", "question": "密级是什么？", "required": True, "user_confirmation_required": True},
    {"id": "project_source", "question": "项目来源是什么？", "required": True},
    {"id": "title_cn", "question": "Word 报告中文标题是什么？", "required": True},
    {"id": "title_en", "question": "Word 报告英文标题是什么？", "required": True},
    {"id": "project_name", "question": "项目名称是什么？", "required": True},
    {"id": "series_no", "question": "系列编号是什么？不适用时填写空字符串。", "required": True, "allow_empty": True},
    {"id": "cooperator", "question": "合作（协作）单位有哪些？不适用时填写空数组。", "required": True},
    {"id": "report_date", "question": "报告日期是什么？例如 2026年8月。", "required": True},
    {"id": "work_period", "question": "工作起止时间是什么？不适用时填写空字符串。", "required": True, "allow_empty": True},
    {"id": "leader", "question": "项目负责人是谁？不适用时填写空字符串。", "required": True, "allow_empty": True},
    {"id": "staff", "question": "主要参加人员有哪些？不适用时填写空字符串。", "required": True, "allow_empty": True},
    {"id": "writer", "question": "报告编写人是谁？不适用时填写空字符串。", "required": True, "allow_empty": True},
]

REQUIRED_WORD_VALIDATION_FIELDS = {
    "validated_artifact_id", "validated_version", "decision", "valid",
    "docx_path", "structural_validation", "visual_qa", "revision_instruction",
}

REQUIRED_REVIEW_FIELDS = {
    "reviewed_artifact_id", "reviewed_version", "decision", "overall_score",
    "issues", "must_fix", "revision_instruction",
}

STAGES = {
    "INITIALIZED", "PROJECT_PROFILE_DRAFTED", "PROJECT_PROFILE_CONFIRMED",
    "ARGUMENT_ARCHITECTURE_DRAFTED", "ARGUMENT_ARCHITECTURE_CONFIRMED",
    "OUTLINE_DRAFTED", "OUTLINE_REVIEWING", "OUTLINE_REVISION_REQUIRED",
    "OUTLINE_REVIEW_PASSED", "OUTLINE_CONFIRMED", "REFERENCE_PLAN_DRAFTED",
    "REFERENCE_PLAN_CONFIRMED", "CHAPTER_MATERIALS_READY", "CHAPTER_PLAN_DRAFTED",
    "CHAPTER_PLAN_CONFIRMED", "CHAPTER_DRAFTED", "CHAPTER_REVIEWING",
    "CHAPTER_REVISION_REQUIRED", "CHAPTER_REVIEW_PASSED", "CHAPTER_CONFIRMED",
    "ABSTRACT_DRAFTED", "ABSTRACT_CONFIRMED", "REPORT_ASSEMBLED",
    "REPORT_REVIEWING", "REPORT_REVISION_REQUIRED", "REPORT_REVIEW_PASSED",
    "REPORT_CONFIRMED", "WORD_REPORT_FORMATTING", "WORD_REPORT_GENERATED",
    "WORD_REPORT_VALIDATING", "WORD_REPORT_REVISION_REQUIRED", "WORD_REPORT_VALIDATED",
    "WORD_REPORT_CONFIRMED", "COMPLETED", "AWAITING_USER", "FAILED"
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value: dict[str, Any]) -> None:
    """Atomically replace JSON and confirm file and directory synchronization.

    A directory-sync error leaves the replacement visible but its persistence
    unconfirmed. Read the file before deciding whether to repeat an action.
    """
    serialized = json.dumps(value, ensure_ascii=False, indent=2)
    path.parent.mkdir(parents=True, exist_ok=True)
    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", suffix=".tmp", delete=False) as file:
            temporary = Path(file.name)
            file.write(serialized)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        temporary = None
        try:
            os.fsync(directory_fd)
        except OSError as error:
            raise RuntimeError("JSON file may already be updated, but commit is not confirmed: "
                               "directory synchronization failed; reread the state before "
                               "continuing and do not automatically replay the stage action") from error
    finally:
        try:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        finally:
            os.close(directory_fd)


def _project_intake_complete(state: dict[str, Any]) -> bool:
    intake = state.get("project_intake", {})
    answers = intake.get("answers") or {}
    required = {"task_book", "content_generation_mode", "report_constraints", "experimental_data"}
    if intake.get("status") != "confirmed" or not required.issubset(answers):
        return False
    return answers.get("content_generation_mode") in {"source_grounded", "model_autonomous"}


def _project_intake_action(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "user_input",
        "target": "project_intake",
        "title": "建立项目档案草案前置问卷",
        "questions": copy.deepcopy(PROJECT_INTAKE_QUESTIONS),
        "prefilled_answers": copy.deepcopy(state.get("project_intake", {}).get("answers", {})),
        "instruction": "请一次性回答四个固定问题。没有相关材料或要求时请明确填写‘无’或 available=false。",
    }


def submit_project_intake(state: dict[str, Any], answers: dict[str, Any]) -> dict[str, Any]:
    s = copy.deepcopy(state)
    if s.get("stage") != "INITIALIZED":
        raise ValueError("project intake can only be submitted before the project profile is generated")
    required = {"task_book", "content_generation_mode", "report_constraints", "experimental_data"}
    missing = sorted(required - set(answers))
    if missing:
        raise ValueError(f"project intake missing required answers: {', '.join(missing)}")
    mode = answers.get("content_generation_mode")
    if mode not in {"source_grounded", "model_autonomous"}:
        raise ValueError("content_generation_mode must be source_grounded or model_autonomous")
    task_book = answers.get("task_book")
    constraints = answers.get("report_constraints")
    experimental = answers.get("experimental_data")
    if not isinstance(task_book, dict) or "available" not in task_book:
        raise ValueError("task_book must be an object containing available and scope")
    if task_book.get("available") and not str(task_book.get("scope") or "").strip():
        raise ValueError("task_book.scope is required when a task book is available")
    if not isinstance(constraints, dict) or "has_requirements" not in constraints:
        raise ValueError("report_constraints must contain has_requirements")
    if not isinstance(experimental, dict) or "available" not in experimental:
        raise ValueError("experimental_data must contain available")

    s["project_intake"] = {"status": "confirmed", "answers": copy.deepcopy(answers), "submitted_at": now()}
    s["content_generation_mode"] = mode
    s["chapter_content_briefs"] = {
        "status": "pending" if mode == "source_grounded" else "not_required",
        "targets": [],
        "items": [],
    }
    s["report_context"] = copy.deepcopy(s.get("report_context", {}))
    s["report_context"]["task_book"] = copy.deepcopy(task_book)
    s["report_context"]["report_constraints"] = copy.deepcopy(constraints)
    s["report_context"]["experimental_data"] = copy.deepcopy(experimental)
    if constraints.get("target_words") not in (None, ""):
        s["report_context"]["expected_length"] = constraints.get("target_words")
    if constraints.get("template") not in (None, ""):
        s["report_context"]["template_requirement"] = constraints.get("template")
    if constraints.get("chapter_count") not in (None, ""):
        s["report_context"]["chapter_count_requirement"] = constraints.get("chapter_count")
    _record(s, "project_intake_submitted", content_generation_mode=mode)
    return s


def _architecture_requirements() -> dict[str, Any]:
    return {
        "chapter_mapping": "Return content.proposed_chapters or content.report_scope_confirmation.chapter_mapping as a non-empty list of chapter objects.",
        "chapter_fields": {
            "chapter_title": "non-empty chapter title",
            "chapter_type": "foundation | technical-research | conclusion; include at least one technical-research chapter",
            "chapter_id": "optional unique stable string",
            "chapter_no": "optional unique positive integer",
        },
        "preserve_existing_outline_rules": True,
        "state_write_policy": "Return a child response for apply; never edit workflow state or an already applied artifact directly.",
    }


def _structured_chapters(content: Any) -> list[dict[str, str]]:
    """Read the same chapter mapping at admission, confirmation and brief collection.

    Legacy technical-only mappings may omit chapter_type. Complete mappings use
    explicit roles, so foundation and conclusion are never inferred from titles.
    """
    if not isinstance(content, dict):
        raise ValueError("argument architecture chapter mapping requires object content")
    keys = ("proposed_chapters", "technical_chapters", "chapter_candidates",
            "research_content_chapter_mapping", "research_contents", "chapter_mapping")
    locations = [("content.proposed_chapters", content["proposed_chapters"], "proposed_chapters")] if "proposed_chapters" in content else []
    scope = content.get("report_scope_confirmation")
    if isinstance(scope, dict) and "chapter_mapping" in scope:
        locations.append(("content.report_scope_confirmation.chapter_mapping", scope["chapter_mapping"], "chapter_mapping"))
    locations.extend((f"content.{key}", content[key], key) for key in keys[1:] if key in content)
    if not locations:
        raise ValueError("argument architecture needs content.proposed_chapters or content.report_scope_confirmation.chapter_mapping")
    path, rows, field = locations[0]
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"{path} must be a non-empty chapter object list")
    chapters: list[dict[str, str]] = []
    seen_keys: set[str] = set()
    seen_numbers: set[int] = set()
    roles: set[str] = set()
    for index, row in enumerate(rows, 1):
        row_path = f"{path}[{index - 1}]"
        if not isinstance(row, dict):
            raise ValueError(f"{row_path} must be a chapter object")
        title = next((row[key].strip() for key in ("chapter_title", "proposed_title", "title", "name", "research_content")
                      if isinstance(row.get(key), str) and row[key].strip()), "")
        if not title:
            raise ValueError(f"{row_path}.chapter_title must be non-empty")
        role = row.get("chapter_type")
        if role is None and field != "proposed_chapters" and path != "content.report_scope_confirmation.chapter_mapping":
            role = "technical-research"
        if not isinstance(role, str) or role not in {"foundation", "technical-research", "conclusion"}:
            raise ValueError(f"{row_path}.chapter_type must identify foundation, technical-research or conclusion")
        if role != "technical-research" and role in roles:
            raise ValueError(f"{row_path} duplicates the {role} chapter")
        roles.add(role)
        number = row.get("chapter_no")
        if number is not None:
            if type(number) is not int or number < 1 or number in seen_numbers:
                raise ValueError(f"{row_path}.chapter_no must be a unique positive integer")
            seen_numbers.add(number)
        key = row.get("chapter_id", row.get("id", row.get("research_content_id")))
        if key is None:
            key = role if role != "technical-research" else f"technical_{number or index}"
        if not isinstance(key, str) or not key.strip() or key.strip() in seen_keys:
            raise ValueError(f"{row_path}.chapter_id must be a unique non-empty string")
        key = key.strip()
        if key in {"foundation", "conclusion"} and key != role:
            raise ValueError(f"{row_path}.chapter_id conflicts with its chapter_type")
        seen_keys.add(key)
        chapters.append({"chapter_key": key, "suggested_title": title, "chapter_type": role})
    if "technical-research" not in roles:
        raise ValueError(f"{path} must contain at least one technical-research chapter")
    if any(row["chapter_type"] == "foundation" for row in chapters[1:]) \
            or any(row["chapter_type"] == "conclusion" for row in chapters[:-1]):
        raise ValueError(f"{path} must place the foundation chapter first and conclusion chapter last")
    return chapters


def _chapter_brief_targets(state: dict[str, Any]) -> list[dict[str, str]]:
    architecture = _latest(_artifact_slot(state, "argument_architecture")) or {}
    content = architecture.get("content")
    chapters = _structured_chapters(content)
    targets = [{"chapter_key": row["chapter_key"], "suggested_title": row["suggested_title"]} for row in chapters]
    if not any(row["chapter_type"] == "foundation" for row in chapters):
        targets.insert(0, {"chapter_key": "foundation", "suggested_title": "第一章（背景、研究现状和主要研究内容）"})
    if not any(row["chapter_type"] == "conclusion" for row in chapters):
        targets.append({"chapter_key": "conclusion", "suggested_title": "总结与展望"})
    return targets


def _chapter_briefs_action(state: dict[str, Any]) -> dict[str, Any]:
    targets = _chapter_brief_targets(state)
    return {
        "kind": "user_input",
        "target": "chapter_content_briefs",
        "title": "目录生成前的逐章内容说明",
        "chapter_targets": targets,
        "required_item_schema": {
            "chapter_key": "必须与 chapter_targets 中的 chapter_key 对应",
            "approximate_content": "该章准备写什么、已有成果或希望覆盖的重点；无特殊要求时明确填写‘无特殊要求’",
            "available_materials": "可选数组",
            "known_data_or_results": "可选数组",
        },
        "instruction": "当前选择了基于已有内容生成。请在生成目录前，按每个拟定章节分别说明大概内容；这里只收集内容意图，不修改既有目录生成规则。",
    }


def submit_chapter_content_briefs(state: dict[str, Any], items: list[dict[str, Any]]) -> dict[str, Any]:
    s = copy.deepcopy(state)
    if s.get("stage") != "ARGUMENT_ARCHITECTURE_CONFIRMED":
        raise ValueError("chapter content briefs can only be submitted after argument architecture confirmation")
    if s.get("content_generation_mode") != "source_grounded":
        raise ValueError("chapter content briefs are only required in source_grounded mode")
    if not isinstance(items, list) or not items:
        raise ValueError("chapter content briefs must be a non-empty list")
    targets = _chapter_brief_targets(s)
    target_keys = {x["chapter_key"] for x in targets}
    provided: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("each chapter content brief must be an object")
        key = str(item.get("chapter_key") or "").strip()
        content = str(item.get("approximate_content") or "").strip()
        if not key or not content:
            raise ValueError("each chapter content brief requires chapter_key and approximate_content")
        provided[key] = copy.deepcopy(item)
    missing = sorted(target_keys - set(provided))
    if missing:
        raise ValueError(f"missing chapter content briefs for: {', '.join(missing)}")
    s["chapter_content_briefs"] = {
        "status": "confirmed",
        "targets": targets,
        "items": [provided[x["chapter_key"]] for x in targets],
        "submitted_at": now(),
    }
    _record(s, "chapter_content_briefs_submitted", chapter_count=len(targets))
    return s


def _word_metadata_prefill(state: dict[str, Any]) -> dict[str, Any]:
    context = state.get("report_context", {})
    profile = _latest(_artifact_slot(state, "project_profile")) or {}
    profile_content = profile.get("content") if isinstance(profile, dict) else {}
    if not isinstance(profile_content, dict):
        profile_content = {}
    title_cn = str(context.get("title") or profile_content.get("report_title") or "").strip()
    return {
        "report_no": context.get("report_no", ""),
        "class_no": context.get("class_no", ""),
        "secret_level": context.get("secret_level", ""),
        "project_source": context.get("project_source", "国家电网有限公司总部科技项目"),
        "title_cn": title_cn,
        "title_en": context.get("title_en", ""),
        "project_name": context.get("project_name") or title_cn,
        "series_no": context.get("series_no", ""),
        "cooperator": context.get("cooperator", []),
        "report_date": context.get("report_date", ""),
        "work_period": context.get("work_period", ""),
        "leader": context.get("leader", ""),
        "staff": context.get("staff", ""),
        "writer": context.get("writer", ""),
    }


def _word_metadata_complete(state: dict[str, Any]) -> bool:
    word = state.get("word_report", {})
    metadata = word.get("metadata") or {}
    if word.get("metadata_status") != "confirmed":
        return False
    required_non_empty = {"report_no", "class_no", "secret_level", "project_source", "title_cn", "title_en", "project_name", "report_date"}
    required_present = {item["id"] for item in WORD_REPORT_METADATA_FIELDS}
    if not required_present.issubset(metadata):
        return False
    if any(not str(metadata.get(key) or "").strip() for key in required_non_empty):
        return False
    return isinstance(metadata.get("cooperator"), (str, list))


def _word_metadata_action(state: dict[str, Any]) -> dict[str, Any]:
    existing = copy.deepcopy(state.get("word_report", {}).get("metadata") or {})
    prefilled = _word_metadata_prefill(state)
    prefilled.update(existing)
    return {
        "kind": "user_input",
        "target": "word_report_metadata",
        "title": "生成 Word 报告前的封面与报告信息",
        "fields": copy.deepcopy(WORD_REPORT_METADATA_FIELDS),
        "prefilled_values": prefilled,
        "instruction": "请确认全部字段。报告编号、分类号和密级必须由用户明确提供；不适用字段按提示填写空字符串或空数组。",
    }


def submit_word_report_metadata(state: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    s = copy.deepcopy(state)
    if s.get("stage") != "REPORT_CONFIRMED":
        raise ValueError("word report metadata can only be submitted after the final Markdown report is confirmed")
    if not isinstance(metadata, dict):
        raise ValueError("word report metadata must be an object")
    required_present = {item["id"] for item in WORD_REPORT_METADATA_FIELDS}
    missing = sorted(required_present - set(metadata))
    if missing:
        raise ValueError(f"word report metadata missing fields: {', '.join(missing)}")
    required_non_empty = {"report_no", "class_no", "secret_level", "project_source", "title_cn", "title_en", "project_name", "report_date"}
    empty = sorted(key for key in required_non_empty if not str(metadata.get(key) or "").strip())
    if empty:
        raise ValueError(f"word report metadata fields must not be empty: {', '.join(empty)}")
    if not isinstance(metadata.get("cooperator"), (str, list)):
        raise ValueError("word report metadata cooperator must be a string or array")
    s.setdefault("word_report", {})["metadata_status"] = "confirmed"
    s["word_report"]["metadata"] = copy.deepcopy(metadata)
    s["word_report"]["metadata_submitted_at"] = now()
    _record(s, "word_report_metadata_submitted")
    return s


def _validate_word_result(result: dict[str, Any], require_visual_qa: bool = True) -> None:
    missing = sorted(REQUIRED_WORD_VALIDATION_FIELDS - set(result))
    if missing:
        raise ValueError(f"validation_result is not structured; missing fields: {', '.join(missing)}")
    if result.get("decision") not in {"pass", "revise", "blocked"}:
        raise ValueError("validation_result.decision is invalid")
    structural = result.get("structural_validation")
    visual = result.get("visual_qa")
    if not isinstance(structural, dict) or not isinstance(visual, dict):
        raise ValueError("structural_validation and visual_qa must be objects")
    if not isinstance(structural.get("errors", []), list) or not isinstance(visual.get("issues", []), list):
        raise ValueError("validation errors and visual issues must be arrays")
    if result.get("decision") == "pass":
        if result.get("valid") is not True or structural.get("passed") is not True:
            raise ValueError("word validation cannot pass unless structural validation passes")
        if require_visual_qa:
            if visual.get("status") != "passed":
                raise ValueError("word validation cannot pass without passed visual QA")
            page_count = visual.get("page_count")
            inspected = visual.get("inspected_pages")
            if (type(page_count) is not int or page_count <= 0
                    or not isinstance(inspected, list) or len(inspected) != page_count
                    or not all(type(page) is int and 1 <= page <= page_count for page in inspected)
                    or len(set(inspected)) != page_count):
                raise ValueError("word validation pass requires inspected pages to cover exactly 1..page_count")


def _validate_structured_review(review: dict[str, Any]) -> None:
    missing = sorted(REQUIRED_REVIEW_FIELDS - set(review))
    if missing:
        raise ValueError(f"review_result is not structured; missing fields: {', '.join(missing)}")
    if review.get("decision") not in {"pass", "minor_revision", "major_revision", "revise", "blocked"}:
        raise ValueError("review_result.decision is invalid")
    if not isinstance(review.get("issues"), list) or not isinstance(review.get("must_fix"), list):
        raise ValueError("review_result.issues and must_fix must be arrays")


def _has_pass_review(slot: dict[str, Any], artifact: dict[str, Any] | None) -> bool:
    if not artifact:
        return False
    version = artifact.get("version")
    artifact_id = artifact.get("artifact_id")
    for review in reversed(slot.get("reviews", [])):
        if review.get("review_source", "").startswith("deterministic_"):
            continue
        if review.get("reviewed_version") != version or review.get("decision") != "pass":
            continue
        reviewed_id = review.get("reviewed_artifact_id")
        if reviewed_id and artifact_id and reviewed_id != artifact_id:
            continue
        return True
    return False


def new_state(project_id: str, report_context: dict[str, Any], mode: str = "pending_selection") -> dict[str, Any]:
    if mode not in {"pending_selection", "source_grounded", "model_autonomous"}:
        raise ValueError(f"invalid content generation mode: {mode}")
    return {
        "schema_version": "1.1.3",
        "project_id": project_id,
        "stage": "INITIALIZED",
        "report_context": report_context,
        "content_generation_mode": mode,
        "project_intake": {"status": "pending", "answers": {}},
        "chapter_content_briefs": {
            "status": "not_required" if mode == "model_autonomous" else "pending",
            "targets": [],
            "items": [],
        },
        "current_chapter_id": None,
        "chapter_order": [],
        "artifacts": {},
        "chapters": {},
        "revision_counters": {"outline": 0, "abstract": 0, "report": 0, "word_report": 0, "chapters": {}},
        "quality_gates": {"outline_title_failures": 0, "power_domain_heading_failures": 0, "chinese_technology_heading_failures": 0, "level3_task_subject_failures": 0, "based_on_heading_ratio_failures": 0, "chapter_length_failures": {}, "heading_bridge_failures": {}, "chapter_summary_failures": {}, "abstract_failures": 0},
        "word_report": {"metadata_status": "pending", "metadata": {}, "status": "not_started"},
        "confirmations": {},
        "pending_action": None,
        "last_request_id": None,
        "last_error": None,
        "history": [{"at": now(), "event": "state_initialized", "stage": "INITIALIZED"}]
    }


def _artifact_slot(state: dict[str, Any], key: str) -> dict[str, Any]:
    return state["artifacts"].setdefault(key, {"versions": [], "reviews": [], "approved_version": None})


def _chapter_slot(state: dict[str, Any], chapter_id: str) -> dict[str, Any]:
    return state["chapters"].setdefault(chapter_id, {
        "materials": None,
        "experiment_reference_package": None,
        "plan": {"versions": [], "approved_version": None},
        "content": {"versions": [], "reviews": [], "approved_version": None},
        "status": "not_started"
    })


def _latest(slot: dict[str, Any], key: str = "versions") -> dict[str, Any] | None:
    values = slot.get(key, [])
    return values[-1] if values else None


def _confirmation_target(state: dict[str, Any]) -> str | None:
    return {
        "PROJECT_PROFILE_DRAFTED": "project_profile",
        "ARGUMENT_ARCHITECTURE_DRAFTED": "argument_architecture",
        "OUTLINE_REVIEW_PASSED": "outline",
        "REFERENCE_PLAN_DRAFTED": "reference_plan",
        "CHAPTER_PLAN_DRAFTED": f"chapter_plan:{state.get('current_chapter_id')}",
        "CHAPTER_REVIEW_PASSED": f"chapter:{state.get('current_chapter_id')}",
        "ABSTRACT_DRAFTED": "abstract",
        "REPORT_REVIEW_PASSED": "report",
        "WORD_REPORT_VALIDATED": "word_report",
    }.get(state["stage"])


def _revision_slot(state: dict[str, Any], target: str) -> dict[str, Any]:
    if target.startswith(("chapter:", "chapter_plan:")):
        kind, cid = target.split(":", 1)
        slot = state.get("chapters", {}).get(cid, {}).get("content" if kind == "chapter" else "plan")
    else:
        slot = state.get("artifacts", {}).get(target)
    if not isinstance(slot, dict) or not _latest(slot):
        raise ValueError("revision target has no artifact version")
    return slot


def _active_user_revision(state: dict[str, Any]) -> dict[str, Any] | None:
    return next((item for item in reversed(state.get("user_revision_requests", []))
                 if item["status"] == "requested"), None)


def _chapter_limit_revision_target(state: dict[str, Any]) -> str | None:
    """Identify an unconfirmed chapter stopped by its recorded failed-review limit."""
    if state.get("stage") != "AWAITING_USER":
        return None
    sources = {
        "heading bridge gate revision limit reached": "deterministic_heading_bridge_gate",
        "chapter length gate revision limit reached": "deterministic_chapter_length_gate",
        "chapter summary gate revision limit reached": "deterministic_chapter_summary_gate",
        "chapter revision limit reached": None,
    }
    error = state.get("last_error")
    cid = state.get("current_chapter_id")
    if not isinstance(error, dict) or error.get("message") not in sources:
        return None
    if not isinstance(cid, str) or not cid or error.get("chapter_id") != cid:
        return None
    chapter = state.get("chapters", {}).get(cid)
    if not isinstance(chapter, dict) or not isinstance(chapter.get("content"), dict):
        return None
    slot = chapter["content"]
    latest = _latest(slot)
    review = _latest(slot, "reviews")
    count = state.get("revision_counters", {}).get("chapters", {}).get(cid)
    if (chapter.get("status") == "confirmed" or not isinstance(latest, dict)
            or not isinstance(review, dict) or isinstance(count, bool)
            or not isinstance(count, int) or count <= 0
            or review.get("reviewed_version") != latest.get("version")
            or review.get("decision") not in {"minor_revision", "major_revision", "revise"}):
        return None
    source = sources[error["message"]]
    if source is not None:
        if review.get("review_source") != source:
            return None
        # Historical deterministic gate reviews bind by version, without an ID.
        if review.get("reviewed_artifact_id", latest.get("artifact_id")) != latest.get("artifact_id"):
            return None
    else:
        if (str(review.get("review_source", "")).startswith("deterministic_")
                or review.get("reviewed_artifact_id") != latest.get("artifact_id")):
            return None
        try:
            _validate_structured_review(review)
        except ValueError:
            return None
    return f"chapter:{cid}"


def request_revision(state: dict[str, Any], target: str, artifact_id: str, version: int,
                     feedback: str, request_id: str) -> dict[str, Any]:
    """Record explicit feedback on an unconfirmed artifact or exhausted chapter.

    The caller supplies a stable user request ID; replaying its exact arguments
    returns the unchanged state. This local Skill API does not authenticate a user:
    the invoking application must obtain the feedback from the human user. A
    recorded chapter revision limit permits one new request, without resetting
    counters or skipping the deterministic gates and current-version review.
    """
    for name, value in (("target", target), ("artifact_id", artifact_id),
                        ("feedback", feedback), ("request_id", request_id)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"revision {name} must be a nonempty string")
    if isinstance(version, bool) or not isinstance(version, int) or version <= 0:
        raise ValueError("revision version must be a positive integer")
    values = {"target": target, "artifact_id": artifact_id, "base_version": version,
              "feedback": feedback.strip(), "request_id": request_id}
    for previous in state.get("user_revision_requests", []):
        if previous["request_id"] == request_id:
            if any(previous.get(key) != value for key, value in values.items()):
                raise ValueError("user revision request_id conflicts with its recorded arguments")
            return copy.deepcopy(state)
    if target == "word_report":
        raise ValueError("user Word revision is not supported; formatter validation failures use the existing repair flow")
    if state.get("pending_action") is not None or _active_user_revision(state):
        raise ValueError("cannot request revision while another action or user revision is pending")
    if _confirmation_target(state) != target and _chapter_limit_revision_target(state) != target:
        raise ValueError(f"cannot revise {target!r} while stage={state['stage']}; expected={_confirmation_target(state)!r}")
    slot = _revision_slot(state, target)
    latest = _latest(slot)
    if slot.get("approved_version") is not None or state.get("confirmations", {}).get(target, {}).get("confirmed"):
        raise ValueError("cannot revise a user-confirmed target")
    if latest.get("artifact_id") != artifact_id or latest.get("version") != version:
        raise ValueError("revision baseline artifact_id/version does not match the current version")
    s = copy.deepcopy(state)
    s.setdefault("user_revision_requests", []).append({
        **values, "feedback_source": "user", "status": "requested",
        "requested_at": now(), "baseline_stage": state["stage"],
    })
    _record(s, "user_revision_requested", target=target, artifact_id=artifact_id,
            base_version=version, user_request_id=request_id)
    return s


def _artifact_output_paths(artifact: dict[str, Any]) -> list[str]:
    content = artifact.get("content")
    outputs = [content, *(content.get("figures") or [])] if isinstance(content, dict) else []
    paths = [output[key] for output in outputs if isinstance(output, dict)
             for key in ("file_path", "path", "markdown_path")
             if isinstance(output.get(key), str) and output[key]]
    texts = []
    if isinstance(content, str):
        texts = [content]
    elif isinstance(content, dict):
        texts = [content.get(key) for key in ("markdown", "text", "body", "report_text")]
    for text in texts:
        if isinstance(text, str):
            paths.extend(match.strip("<>") for match in re.findall(r"!\[[^\]]*\]\(([^)\s]+)\)", text)
                         if not re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:", match))
    return paths


def _user_revision_request(state: dict[str, Any], registry: dict[str, Any], revision: dict[str, Any]) -> dict[str, Any]:
    target = revision["target"]
    slot = _revision_slot(state, target)
    base = _latest(slot)
    if (base["artifact_id"], base["version"]) != (revision["artifact_id"], revision["base_version"]):
        raise ValueError("pending user revision baseline changed")
    if target.startswith("chapter:"):
        request = _chapter_revision_request(state, registry)
    elif target.startswith("chapter_plan:"):
        request = _chapter_plan_request(state, registry)
        request["action"] = registry["children"]["generator"]["actions"]["revise_chapter_plan"]
    else:
        alias = {"project_profile": "build_project_profile", "argument_architecture": "build_argument_architecture",
                 "outline": "revise_outline", "reference_plan": "search_references",
                 "abstract": "generate_abstract", "report": "revise_report"}[target]
        payload = {"report_context": state["report_context"]}
        if target == "project_profile":
            payload.update({"project_intake": copy.deepcopy(state["project_intake"]["answers"]),
                            "content_generation_mode": state["content_generation_mode"], "fixed_questions_completed": True})
        elif target == "argument_architecture":
            payload.update({"project_profile": _latest(_artifact_slot(state, "project_profile")),
                            "argument_architecture_requirements": _architecture_requirements()})
        elif target in {"outline", "reference_plan"}:
            payload.update({"project_profile": _latest(_artifact_slot(state, "project_profile")),
                            "argument_architecture": _latest(_artifact_slot(state, "argument_architecture")),
                            "chapter_content_briefs": copy.deepcopy(state.get("chapter_content_briefs"))})
            if target == "reference_plan":
                payload["outline"] = _latest(_artifact_slot(state, "outline"))
        elif target == "abstract":
            payload = _abstract_payload(state, registry)
        elif target == "report":
            payload = _assembly_payload(state)
        request = _request(registry, "generator", alias, payload)
    payload = request["payload"]
    payload.update({"base_artifact": copy.deepcopy(base), "user_feedback": copy.deepcopy(revision),
                    "revision_instruction": "Apply the explicit user feedback below. It is not a formal review result. "
                    "Preserve the confirmed scope, sources and original writing rules. Return a complete new version; "
                    "use new body/figure file paths, never edit state or overwrite historical files. " + revision["feedback"],
                    "revision_output_requirements": {"artifact_id": base["artifact_id"], "artifact_type": base["artifact_type"],
                        "version": base["version"] + 1,
                        "immutable_file_paths": [path for item in slot["versions"] for path in _artifact_output_paths(item)]}})
    if target in {"outline", "report"}:
        payload["review_result"] = copy.deepcopy(slot["reviews"][-1])
    return request


def _validate_user_revision_artifact(state: dict[str, Any], request: dict[str, Any], artifact: dict[str, Any]) -> dict[str, Any]:
    feedback = request["payload"].get("user_feedback")
    if not feedback:
        return artifact
    revision = _active_user_revision(state)
    if not revision or revision["request_id"] != feedback["request_id"]:
        raise ValueError("response has no matching pending user revision")
    slot = _revision_slot(state, revision["target"])
    base = _latest(slot)
    if (base["artifact_id"], base["version"]) != (revision["artifact_id"], revision["base_version"]):
        raise ValueError("pending user revision baseline changed")
    if not isinstance(artifact, dict) or artifact.get("artifact_id") != base["artifact_id"] or artifact.get("artifact_type") != base["artifact_type"]:
        raise ValueError("revision response artifact_id/type does not match its target")
    if isinstance(artifact.get("version"), bool) or artifact.get("version") != base["version"] + 1:
        raise ValueError("revision response must declare the next artifact version")
    if revision["target"].startswith(("chapter:", "chapter_plan:")):
        content = artifact.get("content")
        cid = revision["target"].split(":", 1)[1]
        if isinstance(content, dict) and "chapter_id" in content and str(content["chapter_id"]) != cid:
            raise ValueError("revision response chapter_id does not match its target")
    old_paths = {Path(path).resolve() for item in slot["versions"] for path in _artifact_output_paths(item)}
    if any(Path(path).resolve() in old_paths for path in _artifact_output_paths(artifact)):
        raise ValueError("revision response must use new body/figure file paths")
    item = copy.deepcopy(artifact)
    item.pop("quality_metrics", None)
    item.pop("review_status", None)
    return item


def _record(state: dict[str, Any], event: str, **extra: Any) -> None:
    state["history"].append({"at": now(), "event": event, "stage": state["stage"], **extra})


def _request(registry: dict[str, Any], role: str, action_alias: str, payload: dict[str, Any]) -> dict[str, Any]:
    child = registry["children"][role]
    action = child["actions"][action_alias]
    if role == "generator" and action_alias == "search_references":
        payload = {**payload, "reference_evidence_contract": REFERENCE_EVIDENCE_CONTRACT}
    request_id = f"req_{uuid.uuid4().hex[:16]}"
    return {
        "orchestration": {"enabled": True, "request_id": request_id, "caller_skill": "report-workflow-orchestrator"},
        "skill_name": child["skill_name"],
        "action": action,
        "payload": payload
    }


def next_action(state: dict[str, Any], registry: dict[str, Any]) -> dict[str, Any]:
    """Return the next legal child-Skill request or a user action descriptor."""
    revision = _active_user_revision(state)
    if revision:
        return _user_revision_request(state, registry, revision)
    stage = state["stage"]
    context = state["report_context"]

    if stage == "INITIALIZED":
        if not _project_intake_complete(state):
            return _project_intake_action(state)
        return _request(registry, "generator", "build_project_profile", {
            "report_context": context,
            "content_generation_mode": state["content_generation_mode"],
            "project_intake": copy.deepcopy(state["project_intake"]["answers"]),
            "fixed_questions_completed": True,
        })
    if stage == "PROJECT_PROFILE_DRAFTED":
        return {"kind": "user_confirmation", "target": "project_profile"}
    if stage == "PROJECT_PROFILE_CONFIRMED":
        return _request(registry, "generator", "build_argument_architecture", {
            "report_context": context, "project_profile": _latest(_artifact_slot(state, "project_profile")),
            "argument_architecture_requirements": _architecture_requirements(),
        })
    if stage == "ARGUMENT_ARCHITECTURE_DRAFTED":
        if state.get("content_generation_mode") == "source_grounded":
            artifact = _latest(_artifact_slot(state, "argument_architecture")) or {}
            try:
                _structured_chapters(artifact.get("content"))
            except ValueError as error:
                return _request(registry, "generator", "build_argument_architecture", {
                    "report_context": context, "project_profile": _latest(_artifact_slot(state, "project_profile")),
                    "base_artifact": copy.deepcopy(artifact),
                    "revision_instruction": f"Repair the structured chapter handoff: {error}. Preserve the original writing rules and scope; return a new artifact version for apply, then await explicit user confirmation.",
                    "argument_architecture_requirements": _architecture_requirements(),
                })
        return {"kind": "user_confirmation", "target": "argument_architecture"}
    if stage == "ARGUMENT_ARCHITECTURE_CONFIRMED":
        if state.get("content_generation_mode") == "source_grounded":
            briefs = state.get("chapter_content_briefs", {})
            if briefs.get("status") != "confirmed":
                return _chapter_briefs_action(state)
        return _request(registry, "generator", "generate_outline", {
            "report_context": context,
            "project_profile": _latest(_artifact_slot(state, "project_profile")),
            "argument_architecture": _latest(_artifact_slot(state, "argument_architecture")),
            "chapter_content_briefs": copy.deepcopy(state.get("chapter_content_briefs")),
            "preserve_existing_outline_rules": True,
        })
    if stage in {"OUTLINE_DRAFTED", "OUTLINE_REVIEWING"}:
        outline = _latest(_artifact_slot(state, "outline"))
        return _request(registry, "reviewer", "review_outline", {"report_context": context, "outline": outline})
    if stage == "OUTLINE_REVISION_REQUIRED":
        slot = _artifact_slot(state, "outline")
        return _request(registry, "generator", "revise_outline", {
            "report_context": context, "base_artifact": _latest(slot), "review_result": slot["reviews"][-1]
        })
    if stage == "OUTLINE_REVIEW_PASSED":
        return {"kind": "user_confirmation", "target": "outline"}
    if stage == "OUTLINE_CONFIRMED":
        if registry["workflow"].get("enable_reference_stage", True):
            return _request(registry, "generator", "search_references", {
                "report_context": context, "outline": _latest(_artifact_slot(state, "outline"))
            })
        return _start_or_continue_chapters(state, registry)
    if stage == "REFERENCE_PLAN_DRAFTED":
        return {"kind": "user_confirmation", "target": "reference_plan"}
    if stage == "REFERENCE_PLAN_CONFIRMED":
        return _start_or_continue_chapters(state, registry)
    if stage == "CHAPTER_MATERIALS_READY":
        return _chapter_plan_request(state, registry)
    if stage == "CHAPTER_PLAN_DRAFTED":
        return {"kind": "user_confirmation", "target": f"chapter_plan:{state['current_chapter_id']}"}
    if stage == "CHAPTER_PLAN_CONFIRMED":
        return _chapter_generation_request(state, registry)
    if stage in {"CHAPTER_DRAFTED", "CHAPTER_REVIEWING"}:
        return _chapter_review_request(state, registry)
    if stage == "CHAPTER_REVISION_REQUIRED":
        return _chapter_revision_request(state, registry)
    if stage == "CHAPTER_REVIEW_PASSED":
        return {"kind": "user_confirmation", "target": f"chapter:{state['current_chapter_id']}"}
    if stage == "CHAPTER_CONFIRMED":
        return _start_or_continue_chapters(state, registry)
    if stage == "ABSTRACT_REVISION_REQUIRED":
        slot = _artifact_slot(state, "abstract")
        payload = _abstract_payload(state, registry)
        payload.update({
            "base_artifact": copy.deepcopy(_latest(slot)),
            "deterministic_validation": copy.deepcopy(slot.get("reviews", [])[-1] if slot.get("reviews") else {}),
            "revision_mode": "repair_abstract_constraints",
        })
        return _request(registry, "generator", "generate_abstract", payload)
    if stage == "ABSTRACT_DRAFTED":
        return {"kind": "user_confirmation", "target": "abstract"}
    if stage == "ABSTRACT_CONFIRMED":
        return _request(registry, "generator", "assemble_report", _assembly_payload(state))
    if stage in {"REPORT_ASSEMBLED", "REPORT_REVIEWING"}:
        report = _latest(_artifact_slot(state, "report"))
        abstract = _latest(_artifact_slot(state, "abstract"))
        return _request(registry, "reviewer", "review_report", {
            "report_context": context,
            "report": report,
            "reference_plan": copy.deepcopy(_latest(_artifact_slot(state, "reference_plan"))),
            "abstract_quality_metrics": copy.deepcopy((abstract or {}).get("quality_metrics", {}).get("abstract_quality")),
            "structured_review_required": True,
        })
    if stage == "REPORT_REVISION_REQUIRED":
        slot = _artifact_slot(state, "report")
        return _request(registry, "generator", "revise_report", {
            "report_context": context, "base_artifact": _latest(slot), "review_result": slot["reviews"][-1],
            "reference_plan": copy.deepcopy(_latest(_artifact_slot(state, "reference_plan")))})
    if stage == "REPORT_REVIEW_PASSED":
        return {"kind": "user_confirmation", "target": "report"}
    if stage == "REPORT_CONFIRMED":
        if not registry["workflow"].get("enable_word_output", True):
            return {"kind": "complete_without_word_output"}
        if not _word_metadata_complete(state):
            return _word_metadata_action(state)
        return _request(registry, "formatter", "create_word_report", _word_format_payload(state))
    if stage in {"WORD_REPORT_FORMATTING"}:
        return _request(registry, "formatter", "create_word_report", _word_format_payload(state))
    if stage in {"WORD_REPORT_GENERATED", "WORD_REPORT_VALIDATING"}:
        return _request(registry, "formatter", "validate_word_report", _word_validation_payload(state))
    if stage == "WORD_REPORT_REVISION_REQUIRED":
        return _request(registry, "formatter", "format_existing_word_report", _word_revision_payload(state))
    if stage == "WORD_REPORT_VALIDATED":
        return {"kind": "user_confirmation", "target": "word_report"}
    if stage == "WORD_REPORT_CONFIRMED":
        return {"kind": "complete"}
    if stage == "COMPLETED":
        return {"kind": "complete"}
    if stage in {"AWAITING_USER", "FAILED"}:
        return {"kind": "user_resolution", "error": state.get("last_error")}
    raise ValueError(f"unsupported stage: {stage}")


def _start_or_continue_chapters(state: dict[str, Any], registry: dict[str, Any]) -> dict[str, Any]:
    pending = [cid for cid in state.get("chapter_order", []) if _chapter_slot(state, cid)["status"] != "confirmed"]
    if not pending:
        return _request(registry, "generator", "generate_abstract", _abstract_payload(state, registry))
    cid = pending[0]
    state["current_chapter_id"] = cid
    chapter = _chapter_slot(state, cid)
    if state["content_generation_mode"] == "source_grounded" and chapter.get("materials") is None:
        return _request(registry, "generator", "prepare_chapter_materials", {
            "report_context": state["report_context"], "chapter_id": cid,
            "outline": _latest(_artifact_slot(state, "outline")),
            "reference_plan": copy.deepcopy(_latest(_artifact_slot(state, "reference_plan"))),
            "approved_previous_chapters": _approved_chapter_summaries(state)
        })
    return _chapter_plan_request(state, registry)


def _chapter_plan_request(state: dict[str, Any], registry: dict[str, Any]) -> dict[str, Any]:
    cid = state["current_chapter_id"]
    chapter = _chapter_slot(state, cid)
    experimental = (state.get("project_intake", {}).get("answers", {}).get("experimental_data") or {})
    return _request(registry, "generator", "generate_chapter_plan", {
        "report_context": state["report_context"], "chapter_id": cid,
        "outline": _latest(_artifact_slot(state, "outline")), "chapter_materials": chapter.get("materials"),
        "reference_plan": copy.deepcopy(_latest(_artifact_slot(state, "reference_plan"))),
        "approved_previous_chapters": _approved_chapter_summaries(state),
        "experiment_reference_policy": {
            "allowed": True,
            "real_experimental_data_available": bool(experimental.get("available")),
            "generate_when_real_data_incomplete": True,
            "fill_missing_experiment_components_even_when_partial_real_data_exists": True,
            "default_action_when_validation_needed_and_real_data_missing": "generate_complete_reference_experiment",
            "reference_evidence_only": True,
            "may_appear_in_draft_report_when_explicitly_labeled": True,
            "do_not_fallback_to_placeholder_only": True,
            "allowed_data_statuses": ["simulated_reference", "illustrative_example", "expected_range"],
            "may_include": [
                "experiment_settings", "dataset_plan", "evaluation_metrics", "baseline_methods",
                "comparison_experiments", "ablation_experiments", "sensitivity_experiments",
                "robustness_experiments", "generalization_experiments", "simulated_reference_data",
                "reference_result_analysis"
            ],
            "must_not_be_claimed_as_verified_project_result": True,
        },
    })


def _is_conclusion_chapter(state: dict[str, Any], chapter_id: str) -> bool:
    outline_artifact = _latest(_artifact_slot(state, "outline"))
    if not outline_artifact:
        return False
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return False
    chapters = outline.get("chapters") or []
    wanted = str(chapter_id)
    for idx, chapter in enumerate(chapters):
        if not isinstance(chapter, dict):
            continue
        cid = str(chapter.get("id") or chapter.get("chapter_id") or "")
        if cid != wanted:
            continue
        title = str(chapter.get("title") or "").strip()
        chapter_type = str(chapter.get("chapter_type") or "").strip().lower()
        return idx == len(chapters) - 1 and (chapter_type == "conclusion" or title in {"总结", "总结与展望", "结论"})
    return False

def _strip_conclusion_heading(text: str) -> str:
    return re.sub(r"^\s*#\s+(?:总结与展望|总结|结论)\s*\n+", "", text, count=1)

def _chapter_length_requirement(state: dict[str, Any], registry: dict[str, Any], chapter_id: str) -> dict[str, Any]:
    chapter = _chapter_slot(state, chapter_id)
    target = find_chapter_target_words(
        chapter_id,
        _latest(chapter["plan"]),
        _latest(_artifact_slot(state, "outline")),
    )
    if _is_conclusion_chapter(state, chapter_id):
        return {
            "planned_target_words": target or int(registry["workflow"].get("final_conclusion_target_words", 750)),
            "minimum_required_words": int(registry["workflow"].get("final_conclusion_min_words", 700)),
            "maximum_allowed_words": int(registry["workflow"].get("final_conclusion_max_words", 800)),
            "fixed_range": True,
            "rule": "final_conclusion_700_800",
            "confirmation_required": True,
        }
    ratio = float(registry["workflow"].get("minimum_chapter_length_ratio", 0.8))
    return {
        "planned_target_words": target,
        "minimum_ratio": ratio,
        "minimum_required_words": int(target * ratio + 0.999999) if target else None,
        "confirmation_required": True,
    }


def _chapter_heading_bridge_requirement(state: dict[str, Any], registry: dict[str, Any], chapter_id: str) -> dict[str, Any]:
    mode = _chapter_heading_bridge_mode(state, chapter_id)
    return {
        "mode": mode,
        "minimum_words": int(registry["workflow"].get("heading_bridge_short_min_words", 50)) if mode != "not_applicable" else 0,
        "maximum_words": int(registry["workflow"].get("heading_bridge_short_max_words", 100)) if mode == "short_50_100" else None,
        "rule": (
            "第一章/一般非技术章一级标题后先写50—100字无标题过渡正文"
            if mode == "short_50_100"
            else "技术章保留既有长章首无标题导入，不额外叠加50—100字短引言"
            if mode == "technical_chapter_intro"
            else "本章无二级标题，不适用"
        ),
    }


def _chapter_generation_request(state: dict[str, Any], registry: dict[str, Any]) -> dict[str, Any]:
    cid = state["current_chapter_id"]
    chapter = _chapter_slot(state, cid)
    return _request(registry, "generator", "generate_chapter", {
        "report_context": state["report_context"], "chapter_id": cid,
        "outline": _latest(_artifact_slot(state, "outline")), "chapter_plan": _latest(chapter["plan"]),
        "reference_plan": copy.deepcopy(_latest(_artifact_slot(state, "reference_plan"))),
        "chapter_materials": chapter.get("materials"),
        "experiment_reference_package": copy.deepcopy(chapter.get("experiment_reference_package")),
        "approved_previous_chapters": _approved_chapter_summaries(state),
        "length_requirement": _chapter_length_requirement(state, registry, cid),
        "heading_bridge_requirement": _chapter_heading_bridge_requirement(state, registry, cid),
    })


def _chapter_review_request(state: dict[str, Any], registry: dict[str, Any]) -> dict[str, Any]:
    cid = state["current_chapter_id"]
    chapter = _chapter_slot(state, cid)
    current = _latest(chapter["content"])
    return _request(registry, "reviewer", "review_chapter", {
        "report_context": state["report_context"], "chapter_id": cid,
        "outline": _latest(_artifact_slot(state, "outline")), "chapter_plan": _latest(chapter["plan"]),
        "chapter": current,
        "reference_plan": copy.deepcopy(_latest(_artifact_slot(state, "reference_plan"))),
        "experiment_reference_package": copy.deepcopy(chapter.get("experiment_reference_package")),
        "approved_previous_chapters": _approved_chapter_summaries(state),
        "length_requirement": _chapter_length_requirement(state, registry, cid),
        "length_metrics": (current or {}).get("quality_metrics", {}).get("chapter_length"),
        "heading_bridge_requirement": _chapter_heading_bridge_requirement(state, registry, cid),
        "heading_bridge_metrics": (current or {}).get("quality_metrics", {}).get("heading_bridge"),
    })


def _chapter_revision_request(state: dict[str, Any], registry: dict[str, Any]) -> dict[str, Any]:
    cid = state["current_chapter_id"]
    chapter = _chapter_slot(state, cid)
    return _request(registry, "generator", "revise_chapter", {
        "report_context": state["report_context"], "chapter_id": cid,
        "base_artifact": _latest(chapter["content"]), "review_result": chapter["content"]["reviews"][-1],
        "outline": _latest(_artifact_slot(state, "outline")),
        "reference_plan": _latest(_artifact_slot(state, "reference_plan")),
        "chapter_materials": chapter.get("materials"),
        "experiment_reference_package": copy.deepcopy(chapter.get("experiment_reference_package")),
        "chapter_plan": _latest(chapter["plan"]),
        "length_requirement": _chapter_length_requirement(state, registry, cid),
        "heading_bridge_requirement": _chapter_heading_bridge_requirement(state, registry, cid),
    })


def _approved_chapter_summaries(state: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for cid in state.get("chapter_order", []):
        slot = _chapter_slot(state, cid)["content"]
        approved = slot.get("approved_version")
        if approved is None:
            continue
        item = next((x for x in slot["versions"] if x.get("version") == approved), None)
        if item:
            out.append({"chapter_id": cid, "version": approved, "summary": item.get("summary", "")})
    return out


def _abstract_payload(state: dict[str, Any], registry: dict[str, Any]) -> dict[str, Any]:
    workflow = registry.get("workflow", {})
    return {
        "report_context": state["report_context"],
        "outline": _latest(_artifact_slot(state, "outline")),
        "approved_chapters": _approved_chapter_summaries(state),
        "abstract_generation_requirements": {
            "generate_bilingual": bool(workflow.get("require_bilingual_abstract", True)),
            "paragraph_count": 3,
            "chinese_total_words": {
                "min": int(workflow.get("abstract_cn_total_min_words", 700)),
                "max": int(workflow.get("abstract_cn_total_max_words", 800)),
            },
            "paragraph_1_words": {
                "min": int(workflow.get("abstract_cn_paragraph_1_min_words", 200)),
                "max": int(workflow.get("abstract_cn_paragraph_1_max_words", 250)),
            },
            "paragraph_2_words": {
                "min": int(workflow.get("abstract_cn_paragraph_2_min_words", 300)),
                "max": int(workflow.get("abstract_cn_paragraph_2_max_words", 350)),
            },
            "paragraph_3_words": "use_remaining_budget_to_reach_total",
            "require_ordering_markers": bool(workflow.get("require_abstract_ordering_markers", True)),
            "ordering_marker_examples": [
                ["第一", "第二", "第三"],
                ["首先", "其次", "再次"],
            ],
            "ordering_scope": {
                "paragraph_1": "key_challenges",
                "paragraph_2": "corresponding_research_points",
            },
            "opening_sentence_candidates": {
                "count_min": int(workflow.get("abstract_opening_candidate_min", 3)),
                "count_max": int(workflow.get("abstract_opening_candidate_max", 5)),
                "rule": "Generate distinct business-need/background analysis sentences before drafting abstract_cn; candidates must not contain methods, metrics, or results. Select one and use it as the first complete Chinese abstract sentence unless the user chooses another.",
            },
            "assessment_result_rule": (
                "When a task book is available, paragraph 3 prioritizes in-scope task-book assessment results. "
                "Track quantitative and qualitative/mixed items in assessment_result_coverage; qualitative items must state the demonstrated capability, function, outcome status, applicability or engineering effect, not merely restate the requirement."
            ),
            "supplementary_metric_rule": (
                f"Use non-task-book supplementary metrics only when they materially improve the result summary; "
                f"use at most {int(workflow.get('abstract_supplementary_metric_max', 2))}. If no task book exists, select at most 1-2 strongest verified result metrics."
            ),
            "english_rule": "Generate abstract_en and keywords_en in the same action; use exactly three natural paragraphs separated by blank lines to mirror the Chinese structure. Faithfully mirror the finalized Chinese abstract without adding facts, including the selected business-need opening and assessment results.",
        },
    }


def _assembly_payload(state: dict[str, Any]) -> dict[str, Any]:
    chapters = []
    for cid in state.get("chapter_order", []):
        slot = _chapter_slot(state, cid)["content"]
        approved = slot.get("approved_version")
        item = next((x for x in slot["versions"] if x.get("version") == approved), None)
        if item:
            chapters.append(item)
    return {
        "report_context": state["report_context"],
        "outline": _latest(_artifact_slot(state, "outline")),
        "abstract": _latest(_artifact_slot(state, "abstract")),
        "approved_chapters": chapters,
        "reference_plan": _latest(_artifact_slot(state, "reference_plan")),
        "deterministic_postprocessing": {
            "enabled": True,
            "script": "report-workflow-orchestrator/scripts/normalize_markdown.py",
            "dash_style": "hyphen",
            "remove_digit_cjk_spaces": True,
        },
    }


def _word_format_payload(state: dict[str, Any]) -> dict[str, Any]:
    report = _latest(_artifact_slot(state, "report"))
    chapters = []
    for cid in state.get("chapter_order", []):
        slot = _chapter_slot(state, cid)["content"]
        approved = slot.get("approved_version")
        item = next((x for x in slot.get("versions", []) if x.get("version") == approved), None)
        if item:
            chapters.append(copy.deepcopy(item))
    return {
        "source_report": copy.deepcopy(report),
        "report_context": copy.deepcopy(state.get("report_context", {})),
        "word_metadata": copy.deepcopy(state.get("word_report", {}).get("metadata", {})),
        "outline": copy.deepcopy(_latest(_artifact_slot(state, "outline"))),
        "abstract": copy.deepcopy(_latest(_artifact_slot(state, "abstract"))),
        "approved_chapters": chapters,
        "reference_plan": copy.deepcopy(_latest(_artifact_slot(state, "reference_plan"))),
        "output_preferences": {
            "output_dir": "output/word",
            "preserve_professional_content": True,
            "overwrite_existing": False,
        },
    }


def _word_validation_payload(state: dict[str, Any]) -> dict[str, Any]:
    artifact = _latest(_artifact_slot(state, "word_report"))
    return {
        "word_report": copy.deepcopy(artifact),
        "validation_requirements": {
            "structural_validation": True,
            "render_pdf": True,
            "render_page_pngs": True,
            "inspect_every_page": True,
            "require_visual_qa": True,
        },
    }


def _word_revision_payload(state: dict[str, Any]) -> dict[str, Any]:
    slot = _artifact_slot(state, "word_report")
    return {
        "word_report": copy.deepcopy(_latest(slot)),
        "validation_result": copy.deepcopy(slot.get("reviews", [])[-1]),
        "formatting_constraints": {
            "preserve_professional_content": True,
            "save_as_new_version": True,
        },
    }


def apply_response(state: dict[str, Any], response: dict[str, Any], registry: dict[str, Any],
                   *, source_root: Path | None = None) -> dict[str, Any]:
    """Apply a child-Skill response and return a new state."""
    s = copy.deepcopy(state)
    req = s.get("pending_action")
    if not req or req.get("orchestration", {}).get("request_id") != response.get("request_id"):
        raise ValueError("response request_id does not match pending_action")
    if response.get("skill_name") != req.get("skill_name") or response.get("action") != req.get("action"):
        raise ValueError("response skill_name/action does not match pending_action")
    if response.get("status") != "success":
        s["stage"] = "AWAITING_USER" if response.get("status") == "blocked" else "FAILED"
        s["last_error"] = response.get("error") or {"message": "child skill failed"}
        _record(s, "child_response_error", action=response.get("action"), status=response.get("status"))
        revision = _active_user_revision(s)
        if revision and req.get("payload", {}).get("user_feedback"):
            revision["status"] = "failed"
            revision["child_request_id"] = response["request_id"]
        s["pending_action"] = None
        return s

    action = response["action"]
    generator_name = registry["children"]["generator"]["skill_name"]
    reviewer_name = registry["children"]["reviewer"]["skill_name"]
    formatter_name = registry["children"]["formatter"]["skill_name"]
    if response.get("skill_name") == generator_name:
        artifact = _validate_user_revision_artifact(s, req, response["artifact"])
        if action == registry["children"]["generator"]["actions"]["search_references"]:
            artifact = validate_reference_artifact(
                artifact, source_root=source_root,
                required_contract=req.get("payload", {}).get("reference_evidence_contract"))
        _apply_generator(s, action, artifact, registry)
        revision = _active_user_revision(s)
        if revision and req.get("payload", {}).get("user_feedback"):
            revision.update({"status": "applied", "revised_version": artifact["version"],
                             "child_request_id": response["request_id"]})
    elif response.get("skill_name") == reviewer_name:
        _apply_reviewer(s, action, response["review_result"], registry)
    elif response.get("skill_name") == formatter_name:
        _apply_formatter(s, action, response, registry)
    else:
        raise ValueError(f"unknown child skill: {response.get('skill_name')}")
    s["pending_action"] = None
    s["last_request_id"] = response["request_id"]
    _record(s, "child_response_applied", action=action)
    return s


def _append_version(slot: dict[str, Any], artifact: dict[str, Any]) -> dict[str, Any]:
    expected = len(slot["versions"]) + 1
    item = copy.deepcopy(artifact)
    item["version"] = expected
    slot["versions"].append(item)
    return item


def _outline_title_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    if not registry["workflow"].get("enforce_outline_title_limit", True):
        return True
    maximum = int(registry["workflow"].get("max_outline_title_chars", 25))
    violations = outline_title_violations(item, maximum)
    if not violations:
        return True
    slot = _artifact_slot(s, "outline")
    review = {
        "decision": "major_revision",
        "reviewed_version": item["version"],
        "review_source": "deterministic_outline_title_gate",
        "issues": [
            {
                "issue_id": f"TITLE-{index:03d}",
                "severity": "major",
                "type": "heading_too_long",
                "location": {"chapter_id": row["chapter_id"], "number": row["number"], "level": row["level"]},
                "problem": f"标题共{row['title_length']}个字符，超过默认上限{maximum}个字符：{row['title']}",
                "revision_requirement": "缩短非技术签名类超长标题并保留核心对象、方法或功能；技术研究章二、三级标题若为同时显化电力领域语义、具体 technical_signature 或满足40%—60%‘基于……的……’比例所必需，不应仅为25字符限制而删减关键领域词或关键技术；只有报告主题本身为评估相关时才可使用实验/评价/验证类功能标题；非评估主题不得在二三级目录中出现这类章节。",
            }
            for index, row in enumerate(violations, 1)
        ],
        "must_fix": ["将非技术签名类且未获例外批准的目录标题缩短到25个可见字符以内"],
        "revision_instruction": "缩短非技术签名类超长目录标题。技术研究章二、三级标题必须优先同时保留电力领域语义、具体 technical_signature 和40%—60%的‘基于……的……’句式比例；评估相关主题的功能性评价标题可以保持简洁；非评估主题不得设置验证、评估、评价、测试、试验、实验类二三级标题。",
    }
    slot["reviews"].append(review)
    s.setdefault("quality_gates", {}).setdefault("outline_title_failures", 0)
    s["quality_gates"]["outline_title_failures"] += 1
    s["revision_counters"]["outline"] += 1
    if s["revision_counters"]["outline"] > registry["workflow"].get("max_outline_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {"message": "outline title gate revision limit reached", "violations": violations}
    else:
        s["stage"] = "OUTLINE_REVISION_REQUIRED"
    return False


def _outline_chinese_technology_heading_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    workflow = registry.get("workflow", {})
    if not workflow.get("enforce_chinese_technology_heading_gate", True):
        return True
    violations = outline_chinese_technology_heading_violations(item)
    item.setdefault("quality_metrics", {})["chinese_technology_heading"] = {
        "passed": not violations,
        "violations": copy.deepcopy(violations),
    }
    if not violations:
        return True
    issues = []
    for index, row in enumerate(violations, 1):
        tokens = sorted(set((row.get("title_tokens") or []) + (row.get("signature_tokens") or [])))
        issues.append({
            "issue_id": f"CN-TECH-TITLE-{index:03d}",
            "severity": "major",
            "type": "english_technology_in_heading",
            "location": {"chapter_id": row.get("chapter_id", ""), "number": row.get("number", ""), "level": row.get("level")},
            "problem": f"二/三级技术标题或 technical_signature 仍裸露英文技术名/缩写 {tokens}：{row.get('title', '')}",
            "revision_requirement": (
                "保留原始技术路线和内部英文元数据，将目录中裸露的英文模型名/缩写改写为简洁、有技术含义的中文路线表达；"
                "不得机械展开成长难英文全称直译，也不得泛化成‘智能模型/深度模型/优化算法’。例如 GraphSAGE 可表达为‘图邻域采样聚合’，"
                "HGT 可表达为‘异构图变换注意力’，RAG 应表达为‘检索增强生成’并继续保留混合检索/重排序/多查询等细化机制。"
            ),
        })
    slot = _artifact_slot(s, "outline")
    slot["reviews"].append({
        "decision": "major_revision",
        "reviewed_version": item["version"],
        "review_source": "deterministic_chinese_technology_heading_gate",
        "issues": issues,
        "must_fix": ["所有技术研究章二、三级技术标题使用可辨识技术路线的中文语义技术签名，不直接裸露英文模型名或英文缩写"],
        "revision_instruction": (
            "只修改标题显示语言，不改变已经锁定的电力对象、技术路线、三节承接关系和40%—60%的‘基于……的……’比例。"
            "原始英文技术名保留在 specific_computing_technology / named_technology 等内部字段，technical_signature 改为标题中实际显示的中文语义技术签名。"
        ),
    })
    s.setdefault("quality_gates", {}).setdefault("chinese_technology_heading_failures", 0)
    s["quality_gates"]["chinese_technology_heading_failures"] += 1
    s["revision_counters"]["outline"] += 1
    if s["revision_counters"]["outline"] > workflow.get("max_outline_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {"message": "Chinese technology heading gate revision limit reached", "violations": violations}
    else:
        s["stage"] = "OUTLINE_REVISION_REQUIRED"
    return False


def _outline_level2_subject_power_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    workflow = registry.get("workflow", {})
    if not workflow.get("enforce_level2_subject_power_gate", True):
        return True
    violations = outline_level2_subject_power_violations(item)
    item.setdefault("quality_metrics", {})["level2_subject_power"] = {"passed": not violations, "violations": copy.deepcopy(violations)}
    if not violations:
        return True
    issues = [{
        "issue_id": f"L2-SUBJECT-POWER-{i:03d}", "severity": "major", "type": "level2_subject_power_signal_missing",
        "location": {"chapter_id": row.get("chapter_id", ""), "number": row.get("number", ""), "level": 2},
        "problem": f"二级标题主语缺少电力相关词：{row.get('task_subject', '')!r}；原标题：{row.get('title', '')}",
        "revision_requirement": "标题含‘的’时以‘的’之后完整部分为主语，必须把电网、调度、变电、线路、功率、运检等真实电力对象/业务词放入主语；不得只把电力词放在‘的’之前的技术修饰部分。",
    } for i, row in enumerate(violations, 1)]
    slot = _artifact_slot(s, "outline")
    slot["reviews"].append({
        "decision": "major_revision", "reviewed_version": item["version"],
        "review_source": "deterministic_level2_subject_power_gate", "issues": issues,
        "must_fix": ["每个技术章核心二级标题的主语本身必须带有电力相关词"],
        "revision_instruction": "保留技术签名、承接链和‘基于……的……’比例，只调整二级标题主语，使‘的’之后或直接复合标题的任务主语独立包含电力领域词。",
    })
    s.setdefault("quality_gates", {}).setdefault("level2_subject_power_failures", 0); s["quality_gates"]["level2_subject_power_failures"] += 1
    s["revision_counters"]["outline"] += 1
    if s["revision_counters"]["outline"] > workflow.get("max_outline_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"; s["last_error"] = {"message": "level-2 subject power gate revision limit reached", "violations": violations}
    else:
        s["stage"] = "OUTLINE_REVISION_REQUIRED"
    return False


def _outline_evaluation_theme_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    workflow = registry.get("workflow", {})
    if not workflow.get("enforce_non_evaluation_heading_gate", True):
        return True
    violations = outline_evaluation_heading_violations(item)
    item.setdefault("quality_metrics", {})["evaluation_heading_policy"] = {"passed": not violations, "violations": copy.deepcopy(violations)}
    if not violations:
        return True
    issues = []
    for i, row in enumerate(violations, 1):
        problem = row.get("problem")
        if problem == "report_theme_type_missing_or_invalid":
            text = "目录缺少有效 report_theme_type；必须自动判断为 evaluation-related 或 non-evaluation。"
        elif problem == "standalone_validation_mode_not_none":
            text = "非评估主题仍启用了 standalone_validation_mode。"
        else:
            text = f"非评估主题的二/三级标题出现验证、评估、评价、测试、试验或实验类词：{row.get('title', '')}"
        issues.append({
            "issue_id": f"THEME-HEADING-{i:03d}", "severity": "major", "type": "non_evaluation_heading_policy_violation",
            "location": {"chapter_id": row.get("chapter_id", ""), "number": row.get("number", ""), "level": row.get("level")},
            "problem": text,
            "revision_requirement": "只有报告研究主题本身属于评估/评价/测试方法研究时才允许评价验证类目录。普通技术报告即使任务书含考核、验收、测试条件，也应转写为性能约束、工况、时延、精度、可靠性或能力边界，融入技术标题或正文。",
        })
    slot = _artifact_slot(s, "outline")
    slot["reviews"].append({
        "decision": "major_revision", "reviewed_version": item["version"],
        "review_source": "deterministic_non_evaluation_heading_gate", "issues": issues,
        "must_fix": ["非评估主题的二三级目录不得设置验证、评估、评价、测试、试验、实验等类似章节"],
        "revision_instruction": "先按报告核心研究主题确认 report_theme_type。非评估主题删除评价验证式目录表达，并把任务书中的测试/验收含义改写为技术约束或性能语义；不要删除需要覆盖的技术要求。",
    })
    s.setdefault("quality_gates", {}).setdefault("non_evaluation_heading_failures", 0); s["quality_gates"]["non_evaluation_heading_failures"] += 1
    s["revision_counters"]["outline"] += 1
    if s["revision_counters"]["outline"] > workflow.get("max_outline_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"; s["last_error"] = {"message": "non-evaluation heading gate revision limit reached", "violations": violations}
    else:
        s["stage"] = "OUTLINE_REVISION_REQUIRED"
    return False


def _outline_heading_source_term_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    workflow = registry.get("workflow", {})
    if not workflow.get("enforce_heading_source_term_gate", True):
        return True
    violations = outline_heading_source_term_violations(item)
    item.setdefault("quality_metrics", {})["heading_source_term_coverage"] = {"passed": not violations, "violations": copy.deepcopy(violations)}
    if not violations:
        return True
    issues = [{
        "issue_id": f"SOURCE-TERM-{i:03d}", "severity": "major", "type": "heading_source_term_coverage_missing",
        "location": {"chapter_id": row.get("chapter_id", ""), "number": row.get("target_heading_number", ""), "section": "目录标题"},
        "problem": f"任务书关键技术词标题映射不完整：{row}",
        "revision_requirement": "从当前课题的预期目标、技术性考核要求和进度计划提取有实际技术意义的关键词；概括性较强的词进入X.1—X.N二级标题，覆盖面较窄的技术词进入对应三级标题，并在不破坏章内技术链的前提下分散覆盖。",
    } for i, row in enumerate(violations, 1)]
    slot = _artifact_slot(s, "outline")
    slot["reviews"].append({
        "decision": "major_revision", "reviewed_version": item["version"],
        "review_source": "deterministic_heading_source_term_gate", "issues": issues,
        "must_fix": ["预期目标、考核要求和进度计划中的关键技术词按宽→二级、窄→三级进入目录并保持来源可追溯"],
        "revision_instruction": "补齐 heading_source_term_plan，不按来源条款顺序机械堆标题；先服从X.1—X.N技术链，再把关键技术词分散嵌入最匹配的二三级标题。",
    })
    s.setdefault("quality_gates", {}).setdefault("heading_source_term_failures", 0); s["quality_gates"]["heading_source_term_failures"] += 1
    s["revision_counters"]["outline"] += 1
    if s["revision_counters"]["outline"] > workflow.get("max_outline_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"; s["last_error"] = {"message": "heading source term gate revision limit reached", "violations": violations}
    else:
        s["stage"] = "OUTLINE_REVISION_REQUIRED"
    return False



def _outline_technology_option_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    workflow = registry.get("workflow", {})
    if not workflow.get("enforce_outline_technology_option_gate", True):
        return True
    violations = outline_technology_option_violations(item)
    item.setdefault("quality_metrics", {})["technology_option_sets"] = {
        "passed": not violations,
        "violations": copy.deepcopy(violations),
    }
    if not violations:
        return True
    issues = [{
        "issue_id": f"TECH-OPTION-{i:03d}",
        "severity": "major",
        "type": "technology_option_plan_missing_or_invalid",
        "location": {"chapter_id": row.get("chapter_id", ""), "number": row.get("section_number", ""), "section": "目录可选技术方案"},
        "problem": f"目录阶段可选技术方案不完整或不合规：{row}",
        "revision_requirement": (
            "对技术路线未被来源唯一锁定的核心二级研究点给出2—3个同问题、同作用、同章节边界下的候选技术，"
            "标明中文技术签名、关键机制、适配理由、来源状态并且只推荐1项；来源唯一锁定时只保留1个来源技术。"
            "可选技术方案作为目录伴随信息，不得把多个候选同时写进正式目录标题。"
        ),
    } for i, row in enumerate(violations, 1)]
    slot = _artifact_slot(s, "outline")
    slot["reviews"].append({
        "decision": "major_revision",
        "reviewed_version": item["version"],
        "review_source": "deterministic_technology_option_gate",
        "issues": issues,
        "must_fix": ["补齐技术路线未锁定核心研究点的2—3个可选技术方案；来源锁定时不得虚构替代路线"],
        "revision_instruction": (
            "保持正式目录章节逻辑和任务边界不变，补齐 technology_option_sets。候选必须解决同一研究问题且有真实路线差异；"
            "目录标题只使用当前推荐/确认方案，候选块不编号、不进入正式目录。"
        ),
    })
    s.setdefault("quality_gates", {}).setdefault("technology_option_failures", 0)
    s["quality_gates"]["technology_option_failures"] += 1
    s["revision_counters"]["outline"] += 1
    if s["revision_counters"]["outline"] > workflow.get("max_outline_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {"message": "technology option gate revision limit reached", "violations": violations}
    else:
        s["stage"] = "OUTLINE_REVISION_REQUIRED"
    return False

def _outline_heading_ending_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    workflow = registry.get("workflow", {})
    if not workflow.get("enforce_heading_ending_distribution_gate", True):
        return True
    violations = outline_heading_ending_distribution_violations(item)
    item.setdefault("quality_metrics", {})["heading_ending_distribution"] = {"passed": not violations, "violations": copy.deepcopy(violations)}
    if not violations:
        return True
    issues = [{
        "issue_id": f"ENDING-{i:03d}", "severity": "major", "type": "heading_ending_distribution_mismatch",
        "location": {"chapter_id": row.get("chapter_id", ""), "number": row.get("number", ""), "section": "目录标题"},
        "problem": f"技术研究标题‘技术/方法’结尾分布不符合约40%/60%规则：{row}",
        "revision_requirement": "技术研究章二、三级技术标题仅以‘技术’或‘方法’落脚；每章按最接近40%的整数数量使用‘技术’，其余约60%使用‘方法’。模型/算法名称可以保留在标题中部或 technical_signature，但不再统一以‘方法’结尾，也不以‘模型/算法’收尾。",
    } for i, row in enumerate(violations, 1)]
    slot = _artifact_slot(s, "outline")
    slot["reviews"].append({
        "decision": "major_revision", "reviewed_version": item["version"],
        "review_source": "deterministic_heading_ending_distribution_gate", "issues": issues,
        "must_fix": ["技术研究章二三级标题按约40%‘技术’、60%‘方法’分配结尾，避免全部以‘方法’收尾"],
        "revision_instruction": "只调整落脚词及必要语法，不改变技术含义、主语、电力词、technical_signature、任务书关键词映射和‘基于……的……’比例。",
    })
    s.setdefault("quality_gates", {}).setdefault("heading_ending_distribution_failures", 0); s["quality_gates"]["heading_ending_distribution_failures"] += 1
    s["revision_counters"]["outline"] += 1
    if s["revision_counters"]["outline"] > workflow.get("max_outline_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"; s["last_error"] = {"message": "heading ending distribution gate revision limit reached", "violations": violations}
    else:
        s["stage"] = "OUTLINE_REVISION_REQUIRED"
    return False


def _outline_level3_task_subject_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    workflow = registry.get("workflow", {})
    if not workflow.get("enforce_level3_task_subject_uniqueness_gate", True):
        return True
    violations = outline_level3_task_subject_violations(item)
    item.setdefault("quality_metrics", {})["level3_task_subject_uniqueness"] = {
        "passed": not violations,
        "violations": copy.deepcopy(violations),
    }
    if not violations:
        return True
    issues = []
    for index, row in enumerate(violations, 1):
        issues.append({
            "issue_id": f"L3-SUBJECT-{index:03d}",
            "severity": "major",
            "type": "duplicate_level3_task_subject",
            "location": {"chapter_id": row.get("chapter_id", ""), "number": row.get("number", ""), "level": 3},
            "problem": (
                f"同一章三级技术标题的任务主语重复：{row.get('duplicate_of_number')}={row.get('duplicate_of_subject')!r}，"
                f"{row.get('number')}={row.get('task_subject')!r}。即使前置技术签名不同，也不能让多个三级标题反复承担同一电力任务。"
            ),
            "revision_requirement": (
                "保留各自具体技术签名、电力领域语义和40%—60%的‘基于……的……’比例，重新划分三级标题的处理对象、步骤、输出或技术职责；"
                "对于‘基于X的Y’标题，Y必须在同一章内唯一。不得只把前面的算法换掉而重复同一个Y。"
            ),
        })
    slot = _artifact_slot(s, "outline")
    slot["reviews"].append({
        "decision": "major_revision",
        "reviewed_version": item["version"],
        "review_source": "deterministic_level3_task_subject_uniqueness_gate",
        "issues": issues,
        "must_fix": ["同一技术章所有技术类三级标题的任务主语必须互不重复"],
        "revision_instruction": (
            "只重构重复的三级标题职责，不降低 technical_signature 粒度，不删除电力领域词，也不破坏‘基于……的……’40%—60%比例。"
            "优先让每个三级标题分别承担不同的输入处理、特征/知识构建、推断/优化、校准/验证或输出环节。"
        ),
    })
    s.setdefault("quality_gates", {}).setdefault("level3_task_subject_failures", 0)
    s["quality_gates"]["level3_task_subject_failures"] += 1
    s["revision_counters"]["outline"] += 1
    if s["revision_counters"]["outline"] > workflow.get("max_outline_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {"message": "level-3 task subject uniqueness gate revision limit reached", "violations": violations}
    else:
        s["stage"] = "OUTLINE_REVISION_REQUIRED"
    return False


def _outline_based_on_ratio_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    workflow = registry.get("workflow", {})
    if not workflow.get("enforce_based_on_heading_ratio_gate", True):
        return True
    minimum = float(workflow.get("based_on_heading_ratio_min", 0.40))
    maximum = float(workflow.get("based_on_heading_ratio_max", 0.60))
    violations = outline_based_on_ratio_violations(item, minimum, maximum)
    item.setdefault("quality_metrics", {})["based_on_heading_ratio"] = {
        "minimum_ratio": minimum,
        "maximum_ratio": maximum,
        "passed": not violations,
        "violations": copy.deepcopy(violations),
    }
    if not violations:
        return True

    issues = []
    for index, row in enumerate(violations, 1):
        scope = row.get("scope")
        ratio = float(row.get("ratio", 0.0))
        direction = "低于40%下限" if ratio < minimum else "超过60%上限"
        location = {"chapter_id": row.get("chapter_id", ""), "section": "目录标题"}
        scope_text = f"第{row.get('chapter_id')}章" if scope == "chapter" else "全文技术研究章"
        issues.append({
            "issue_id": f"BASED-STYLE-{index:03d}",
            "severity": "major",
            "type": "based_on_heading_ratio_out_of_range",
            "location": location,
            "problem": (
                f"{scope_text}二、三级技术标题中‘基于……的……’句式占比为{ratio:.1%}"
                f"（{row.get('based_count')}/{row.get('total_count')}），{direction}。"
            ),
            "revision_requirement": (
                "保留每条标题的具体 technical_signature，调整部分标题表面句式，使每个技术研究章及全文合计"
                "都满足40%—60%的‘基于具体技术签名的……’比例；不得用RAG/GNN/Transformer等族级名称充数，"
                "也不得为了25字符原则删除关键技术签名。"
            ),
        })

    slot = _artifact_slot(s, "outline")
    slot["reviews"].append({
        "decision": "major_revision",
        "reviewed_version": item["version"],
        "review_source": "deterministic_based_on_heading_ratio_gate",
        "issues": issues,
        "must_fix": ["将每个技术研究章及全文的‘基于……的……’二三级技术标题比例调整到40%—60%"],
        "revision_instruction": (
            "只调整目录标题的技术显化句式与必要的冗余修饰语：先保留具体技术签名，再保证‘基于具体技术签名的……’"
            "在每个技术研究章和全文均占40%—60%，最后才考虑25字符压缩。"
        ),
    })
    s.setdefault("quality_gates", {}).setdefault("based_on_heading_ratio_failures", 0)
    s["quality_gates"]["based_on_heading_ratio_failures"] += 1
    s["revision_counters"]["outline"] += 1
    if s["revision_counters"]["outline"] > workflow.get("max_outline_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {"message": "based-on heading ratio revision limit reached", "violations": violations}
    else:
        s["stage"] = "OUTLINE_REVISION_REQUIRED"
    return False


def _outline_power_domain_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    workflow = registry.get("workflow", {})
    if not workflow.get("enforce_power_domain_heading_gate", True):
        return True
    violations = outline_power_domain_visibility_violations(item)
    item.setdefault("quality_metrics", {})["power_domain_heading_visibility"] = {
        "passed": not violations,
        "violations": copy.deepcopy(violations),
    }
    if not violations:
        return True
    issues = []
    for index, row in enumerate(violations, 1):
        issues.append({
            "issue_id": f"POWER-TITLE-{index:03d}",
            "severity": "major",
            "type": "power_domain_signal_missing",
            "location": {"chapter_id": row.get("chapter_id", ""), "number": row.get("number", ""), "level": row.get("level")},
            "problem": f"技术标题缺少独立可见的电力领域关键词：{row.get('title', '')}",
            "revision_requirement": (
                "保留原具体 technical_signature 和当前‘基于……的……’比例，在同一标题中加入真实对应的电力对象、"
                "业务场景或运行约束，如电网/调度/变电/运检/线路/功率等；不得仅依赖上位标题补足领域语义。"
            ),
        })
    slot = _artifact_slot(s, "outline")
    slot["reviews"].append({
        "decision": "major_revision",
        "reviewed_version": item["version"],
        "review_source": "deterministic_power_domain_heading_gate",
        "issues": issues,
        "must_fix": ["所有技术研究章二、三级技术标题必须在各自标题中同时保留电力领域语义和具体技术签名"],
        "revision_instruction": (
            "不要通过删除‘基于……的……’或降低 technical_signature 粒度解决问题。优先按‘基于{technical_signature}的"
            "{电力对象/业务/约束}{技术作用}’或‘{电力对象/约束}+{technical_signature}+{技术作用}’重写，"
            "并继续满足40%—60%句式比例。"
        ),
    })
    s.setdefault("quality_gates", {}).setdefault("power_domain_heading_failures", 0)
    s["quality_gates"]["power_domain_heading_failures"] += 1
    s["revision_counters"]["outline"] += 1
    if s["revision_counters"]["outline"] > workflow.get("max_outline_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {"message": "power-domain heading gate revision limit reached", "violations": violations}
    else:
        s["stage"] = "OUTLINE_REVISION_REQUIRED"
    return False



def _chapter_heading_bridge_mode(state: dict[str, Any], chapter_id: str) -> str:
    """Resolve the H1→H2 bridge rule without weakening technical-chapter intro rules."""
    if _is_conclusion_chapter(state, chapter_id):
        return "not_applicable"
    outline_artifact = _latest(_artifact_slot(state, "outline"))
    outline = outline_artifact.get("content", outline_artifact) if outline_artifact else {}
    chapters = outline.get("chapters") if isinstance(outline, dict) else []
    wanted = str(chapter_id)
    for idx, chapter in enumerate(chapters or []):
        if not isinstance(chapter, dict):
            continue
        cid = str(chapter.get("id") or chapter.get("chapter_id") or "")
        if cid != wanted:
            continue
        sections = chapter.get("section_outline") or chapter.get("sections") or []
        has_h2 = any(
            isinstance(x, dict) and int(x.get("level") or 0) == 2
            for x in sections
        )
        if not has_h2:
            return "not_applicable"
        role = str(chapter.get("task_role") or "").lower()
        chapter_type = str(chapter.get("chapter_type") or "").lower()
        if idx > 0 and (
            role in {"technical-research", "engineering-implementation"}
            or chapter_type in {"technical", "algorithm", "system", "engineering", "foundation"}
        ):
            return "technical_chapter_intro"
        return "short_50_100"
    return "short_50_100"


def _chapter_heading_bridge_gate(s: dict[str, Any], chapter_id: str, item: dict[str, Any], registry: dict[str, Any]) -> bool:
    workflow = registry["workflow"]
    if not workflow.get("enforce_heading_bridge_gate", True):
        return True
    mode = _chapter_heading_bridge_mode(s, chapter_id)
    text = content_to_text(item.get("content"))
    metrics = heading_bridge_metrics(
        text,
        mode=mode,
        short_min=int(workflow.get("heading_bridge_short_min_words", 50)),
        short_max=int(workflow.get("heading_bridge_short_max_words", 100)),
    )
    item.setdefault("quality_metrics", {})["heading_bridge"] = metrics
    if metrics.get("bridge_gate_passed"):
        return True

    if not metrics.get("detected"):
        problem = "无法定位当前章节的一级标题与首个二级标题边界，不能确认无标题过渡正文是否存在。"
        requirement = "保持一级标题和二级标题的Markdown/HTML层级可识别，并在两者之间加入规定的无标题正文。"
    elif mode == "short_50_100" and metrics.get("bridge_words", 0) < metrics.get("minimum_required_words", 50):
        problem = f"一级标题与首个二级标题之间只有{metrics.get('bridge_words',0)}字正文，低于50字。"
        requirement = "在一级标题后补充50—100字有实际内容的无标题过渡正文，再进入首个二级标题。"
    elif mode == "short_50_100":
        problem = f"一级标题与首个二级标题之间有{metrics.get('bridge_words',0)}字正文，超过100字。"
        requirement = "将一般非技术章节的章首过渡压缩到50—100字；不要影响技术章既有长章首导入规则。"
    else:
        problem = "技术章一级标题后直接出现二级标题，缺少既有无标题章首导入正文。"
        requirement = "恢复技术章长章首导入正文；不得用50—100字短引言替代既有章首导入规则。"

    chapter = _chapter_slot(s, chapter_id)
    review = {
        "decision": "major_revision",
        "reviewed_version": item["version"],
        "review_source": "deterministic_heading_bridge_gate",
        "issues": [{
            "issue_id": "STRUCTURE-BRIDGE-001",
            "severity": "major",
            "type": "heading_transition_missing",
            "location": {"chapter_id": chapter_id, "section": "一级标题与首个二级标题之间"},
            "problem": problem,
            "revision_requirement": requirement,
            "expected_result": "一级标题后先有符合本章类型要求的无标题正文，再进入首个二级标题。",
        }],
        "must_fix": [requirement],
        "revision_instruction": requirement,
        "heading_bridge_metrics": metrics,
    }
    chapter["content"]["reviews"].append(review)
    failures = s.setdefault("quality_gates", {}).setdefault("heading_bridge_failures", {})
    failures[chapter_id] = failures.get(chapter_id, 0) + 1
    counts = s["revision_counters"]["chapters"]
    counts[chapter_id] = counts.get(chapter_id, 0) + 1
    if counts[chapter_id] > workflow.get("max_chapter_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {"message": "heading bridge gate revision limit reached", "chapter_id": chapter_id, "metrics": metrics}
    else:
        s["stage"] = "CHAPTER_REVISION_REQUIRED"
    return False


def _chapter_length_gate(s: dict[str, Any], chapter_id: str, item: dict[str, Any], registry: dict[str, Any]) -> bool:
    if not registry["workflow"].get("enforce_chapter_length_gate", True):
        return True
    chapter = _chapter_slot(s, chapter_id)
    target = find_chapter_target_words(
        chapter_id,
        _latest(chapter["plan"]),
        _latest(_artifact_slot(s, "outline")),
    )
    if not target:
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {
            "message": "missing confirmed chapter target words",
            "chapter_id": chapter_id,
            "required_action": "在目录或章节计划中确认目标字数后重新生成",
        }
        return False
    text = content_to_text(item.get("content"))
    is_conclusion = _is_conclusion_chapter(s, chapter_id)
    if is_conclusion:
        conclusion_min = int(registry["workflow"].get("final_conclusion_min_words", 700))
        conclusion_max = int(registry["workflow"].get("final_conclusion_max_words", 800))
        conclusion_target = int(registry["workflow"].get("final_conclusion_target_words", 750))
        lower_heading_matches = re.findall(r"(?m)^\s*#{2,6}\s+.+$", text)
        metrics = fixed_range_length_metrics(
            _strip_conclusion_heading(text), conclusion_min, conclusion_max, target_words=target or conclusion_target
        )
        metrics["lower_heading_count"] = len(lower_heading_matches)
        metrics["structure_gate_passed"] = not lower_heading_matches
    else:
        metrics = chapter_length_metrics(
            text,
            target,
            float(registry["workflow"].get("minimum_chapter_length_ratio", 0.8)),
        )
    item.setdefault("quality_metrics", {})["chapter_length"] = metrics
    if metrics["length_gate_passed"] and (not is_conclusion or metrics.get("structure_gate_passed", True)):
        return True

    if is_conclusion:
        if not metrics.get("structure_gate_passed", True):
            problem = f"最终总结章检测到{metrics['lower_heading_count']}个二级或更低级Markdown标题；该章只能保留一个一级标题。"
            requirement = "删除所有二级、三级或更低级标题，将其内容合并为一级标题下的连续自然段；同时保持正文700—800字。"
            must_fix = "删除最终总结章全部二三级及更低级标题"
            instruction = "最终总结章只保留一个一级标题。把分节内容改为自然段衔接，并同时保证正文有效字数700—800字。"
        elif metrics["actual_words"] < conclusion_min:
            problem = f"最终总结章有效字数为{metrics['actual_words']}，低于固定下限{conclusion_min}字。"
            requirement = f"补充{metrics['shortfall_words']}字左右的实质性总结内容，使正文达到{conclusion_min}—{conclusion_max}字。"
            must_fix = f"将最终总结章补充到{conclusion_min}—{conclusion_max}字"
            instruction = f"最终总结章只保留一级标题，通过连续自然段补充成果归纳、证据、局限与展望，达到{conclusion_min}—{conclusion_max}字。"
        else:
            problem = f"最终总结章有效字数为{metrics['actual_words']}，超过固定上限{conclusion_max}字。"
            requirement = f"压缩至少{metrics['excess_words']}字，保留核心成果、证据、局限与展望，使正文回到{conclusion_min}—{conclusion_max}字。"
            must_fix = f"将最终总结章压缩到{conclusion_min}—{conclusion_max}字"
            instruction = f"最终总结章只保留一级标题，删除重复复述和次要细节，通过连续自然段压缩到{conclusion_min}—{conclusion_max}字。"
    else:
        problem = (
            f"本章有效字数为{metrics['actual_words']}，低于最低要求"
            f"{metrics['minimum_required_words']}（计划{metrics['planned_target_words']}字的"
            f"{metrics['minimum_ratio']:.0%}）。"
        )
        requirement = (
            f"在不重复背景、定义和总结的前提下补充技术机理、实现过程、实验设置、"
            f"评价指标、结果分析或适用边界，使有效字数至少达到{metrics['minimum_required_words']}。"
        )
        must_fix = f"补足至少{metrics['shortfall_words']}个有效字，使本章达到计划字数的80%"
        instruction = (
            f"当前章不足计划篇幅的80%。保留现有有效内容，针对章节计划中尚未充分展开的"
            f"技术、实验与分析部分定向补写，完成后重新执行字数门禁。"
        )

    review = {
        "decision": "major_revision",
        "reviewed_version": item["version"],
        "review_source": "deterministic_chapter_length_gate",
        "issues": [{
            "issue_id": "LENGTH-001",
            "severity": "major",
            "type": "insufficient_length",
            "location": {"chapter_id": chapter_id, "section": "全文"},
            "problem": problem,
            "revision_requirement": requirement,
            "expected_result": "章节达到已确认篇幅下限后再进入内容审核和用户确认。",
        }],
        "must_fix": [must_fix],
        "revision_instruction": instruction,
        "length_metrics": metrics,
    }
    chapter["content"]["reviews"].append(review)
    failures = s.setdefault("quality_gates", {}).setdefault("chapter_length_failures", {})
    failures[chapter_id] = failures.get(chapter_id, 0) + 1
    counts = s["revision_counters"]["chapters"]
    counts[chapter_id] = counts.get(chapter_id, 0) + 1
    if counts[chapter_id] > registry["workflow"].get("max_chapter_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {
            "message": "chapter length gate revision limit reached",
            "chapter_id": chapter_id,
            "length_metrics": metrics,
        }
    else:
        s["stage"] = "CHAPTER_REVISION_REQUIRED"
    return False



def _chapter_summary_gate(s: dict[str, Any], chapter_id: str, item: dict[str, Any], registry: dict[str, Any]) -> bool:
    """Enforce the canonical 500–600字 chapter-summary structure when a technical summary is present."""
    if not registry.get("workflow", {}).get("enforce_chapter_summary_gate", True):
        return True
    if _is_conclusion_chapter(s, chapter_id):
        return True
    text = content_to_text(item.get("content"))
    metrics = chapter_summary_metrics(text)
    item.setdefault("quality_metrics", {})["chapter_summary"] = metrics
    # Section-by-section generation may not include 本章小结 yet; defer until it is present.
    if not metrics.get("detected"):
        return True
    chapter = _chapter_slot(s, chapter_id)
    ref_pkg = chapter.get("experiment_reference_package")
    notice_required = isinstance(ref_pkg, dict) and str(ref_pkg.get("draft_report_inclusion") or "") != "external_only"
    notice_metrics = simulation_chapter_end_notice_metrics(text) if notice_required else {"notice_gate_passed": True, "notice_count": 0, "notice_at_chapter_end": True}
    item.setdefault("quality_metrics", {})["simulation_chapter_end_notice"] = notice_metrics
    metrics["simulation_notice_required"] = notice_required
    metrics["simulation_notice_gate_passed"] = bool(notice_metrics.get("notice_gate_passed"))
    if metrics.get("summary_gate_passed") and metrics.get("simulation_notice_gate_passed"):
        return True

    problems = []
    requirements = []
    if not metrics.get("structure_gate_passed"):
        problems.append(f"本章小结仅检测到{metrics.get('paragraph_count', 0)}个自然段，无法形成清晰的总—分—总结构。")
        requirements.append("将本章小结组织为至少三个连续自然段：开头总述、中部分项归纳、结尾综合收束。")
    if not metrics.get("total_gate_passed"):
        problems.append(f"本章小结有效字数为{metrics.get('actual_words', 0)}，不在500—600字范围内。")
        requirements.append("调整本章小结整体篇幅到500—600字。")
    if not metrics.get("opening_gate_passed"):
        problems.append(f"本章小结开头总述约{metrics.get('opening_words', 0)}字，不在100—150字范围内。")
        requirements.append("将开头总述调整到100—150字，并包含总体成果及相较传统方法的简要优势。")
    if not metrics.get("middle_gate_passed"):
        problems.append(f"本章小结中部分项归纳约{metrics.get('middle_words', 0)}字，偏离约300字的目标范围。")
        requirements.append("将中部分项归纳控制在约300字，依次归纳X.1—X.N核心研究点成果并自然覆盖性能要求。")
    if not metrics.get("ending_gate_passed"):
        problems.append(f"本章小结结尾综合收束约{metrics.get('ending_words', 0)}字，不符合100—150字的默认范围或实验丰富时的适度扩展范围。")
        requirements.append("将结尾控制在100—150字；实验结果丰富时可适度增加，但整篇仍需保持500—600字。")

    if not metrics.get("simulation_notice_gate_passed"):
        problems.append("本章使用了模型生成的模拟实验数据，但未在整章最末尾保留唯一一次统一说明，或重复出现了多次模拟提示。")
        requirements.append("删除实验标题、表题和结果句中重复的‘参考/模拟’提示，只在本章小结之后、整章最末尾保留一句模拟数据说明；该说明不计入小结500—600字。")

    chapter["content"]["reviews"].append({
        "decision": "major_revision",
        "reviewed_version": item["version"],
        "review_source": "deterministic_chapter_summary_gate",
        "issues": [{
            "issue_id": "SUMMARY-001",
            "severity": "major",
            "type": "chapter_summary_structure_or_length",
            "location": {"chapter_id": chapter_id, "section": "本章小结"},
            "problem": "；".join(problems),
            "revision_requirement": "；".join(requirements),
            "expected_result": "本章小结形成500—600字的总—分—总连续正文，开头100—150字、中部约300字、结尾100—150字。",
        }],
        "must_fix": requirements,
        "revision_instruction": (
            "只修改本章小结：控制总字数500—600字；开头100—150字总结总体成果并简述相较传统方法的优势；"
            "中部约300字归纳X.1—X.N核心研究点并自然覆盖性能要求；结尾100—150字结合实验结果说明贡献，"
            "普通对比/消融等实验结果优先放在第二段并与具体方法绑定；任务书或材料特别强调的目标/要求对应结果放在第三段，"
            "写清方法、效果和相较传统/基线的优越性；使用模拟数据时只在整章末尾统一说明一次。"
        ),
        "chapter_summary_metrics": metrics,
    })
    failures = s.setdefault("quality_gates", {}).setdefault("chapter_summary_failures", {})
    failures[chapter_id] = failures.get(chapter_id, 0) + 1
    counts = s["revision_counters"]["chapters"]
    counts[chapter_id] = counts.get(chapter_id, 0) + 1
    if counts[chapter_id] > registry["workflow"].get("max_chapter_revision_rounds", 2):
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {"message": "chapter summary gate revision limit reached", "chapter_id": chapter_id, "metrics": metrics}
    else:
        s["stage"] = "CHAPTER_REVISION_REQUIRED"
    return False

def _abstract_quality_gate(s: dict[str, Any], item: dict[str, Any], registry: dict[str, Any]) -> bool:
    if not registry.get("workflow", {}).get("enforce_abstract_quality_gate", True):
        return True
    workflow = registry.get("workflow", {})
    metrics = abstract_quality_metrics(
        item.get("content"),
        total_min=int(workflow.get("abstract_cn_total_min_words", 700)),
        total_max=int(workflow.get("abstract_cn_total_max_words", 800)),
        paragraph_1_min=int(workflow.get("abstract_cn_paragraph_1_min_words", 200)),
        paragraph_1_max=int(workflow.get("abstract_cn_paragraph_1_max_words", 250)),
        paragraph_2_min=int(workflow.get("abstract_cn_paragraph_2_min_words", 300)),
        paragraph_2_max=int(workflow.get("abstract_cn_paragraph_2_max_words", 350)),
        require_bilingual=bool(workflow.get("require_bilingual_abstract", True)),
        require_ordering=bool(workflow.get("require_abstract_ordering_markers", True)),
        require_opening_candidates=bool(workflow.get("require_abstract_opening_candidates", True)),
        opening_candidate_min=int(workflow.get("abstract_opening_candidate_min", 3)),
        opening_candidate_max=int(workflow.get("abstract_opening_candidate_max", 5)),
        max_supplementary_metrics=int(workflow.get("abstract_supplementary_metric_max", 2)),
        require_assessment_result_metadata=bool(workflow.get("require_abstract_assessment_result_metadata", True)),
    )
    item.setdefault("quality_metrics", {})["abstract_quality"] = metrics
    if metrics.get("valid"):
        return True

    slot = _artifact_slot(s, "abstract")
    review = {
        "decision": "major_revision",
        "reviewed_version": item["version"],
        "review_source": "deterministic_abstract_quality_gate",
        "issues": [
            {
                "issue_id": f"ABSTRACT-{idx:03d}",
                "severity": "major",
                "type": "abstract_constraint_violation",
                "location": {"section": "摘要"},
                "problem": message,
                "revision_requirement": "仅调整摘要篇幅、中英文各三段结构（英文段间留空行）、业务需求首句候选/选中首句、挑战与技术点顺序、任务书考核结果覆盖、补充指标数量或双语字段；不得借修订新增正文不存在的技术、数值和结论。",
            }
            for idx, message in enumerate(metrics.get("errors", []), 1)
        ],
        "must_fix": list(metrics.get("errors", [])),
        "revision_instruction": (
            "保持摘要证据和事实边界不变，重新生成同一个摘要产物：中文摘要总有效字数700—800字，"
            "第一段200—250字，第二段300—350字，第三段补足总篇幅；第一段排序挑战、第二段按对应顺序排序技术点；"
            "同次输出3—5个业务需求背景首句候选并选1句作为中文摘要第一句；第三段优先写任务书考核结果，定量与定性指标都要结果化表达，非任务书补充指标最多1—2个；同次输出三自然段英文摘要（段间留空行）和英文关键词。"
        ),
        "abstract_metrics": metrics,
    }
    slot["reviews"].append(review)
    s.setdefault("quality_gates", {})["abstract_failures"] = s.setdefault("quality_gates", {}).get("abstract_failures", 0) + 1
    s.setdefault("revision_counters", {})["abstract"] = s.setdefault("revision_counters", {}).get("abstract", 0) + 1
    if s["revision_counters"]["abstract"] > int(workflow.get("max_abstract_revision_rounds", 2)):
        s["stage"] = "AWAITING_USER"
        s["last_error"] = {
            "message": "abstract quality gate revision limit reached",
            "abstract_metrics": metrics,
        }
    else:
        s["stage"] = "ABSTRACT_REVISION_REQUIRED"
    return False


def _normalize_report_artifact(artifact: dict[str, Any], registry: dict[str, Any]) -> dict[str, Any]:
    item = copy.deepcopy(artifact)
    if not registry["workflow"].get("normalize_markdown_on_assembly", True):
        return item
    dash_style = str(registry["workflow"].get("markdown_dash_style", "hyphen"))
    remove_spaces = bool(registry["workflow"].get("remove_digit_cjk_spaces", True))
    content = item.get("content")
    stats: dict[str, Any] = {"changed": False, "dash_replacements": 0, "digit_cjk_space_removals": 0, "dash_style": dash_style}
    if isinstance(content, str):
        item["content"], stats = normalize_markdown_text(content, dash_style, remove_spaces)
    elif isinstance(content, dict):
        for key in ("markdown", "text", "body", "report_text"):
            if isinstance(content.get(key), str):
                content[key], stats = normalize_markdown_text(content[key], dash_style, remove_spaces)
                break
        for key in ("file_path", "path", "markdown_path"):
            path_value = content.get(key)
            if isinstance(path_value, str) and Path(path_value).is_file():
                path = Path(path_value)
                normalized, file_stats = normalize_markdown_text(path.read_text(encoding="utf-8"), dash_style, remove_spaces)
                path.write_text(normalized, encoding="utf-8")
                stats = file_stats
                stats["file_path"] = str(path)
                break
    item.setdefault("quality_metrics", {})["markdown_normalization"] = stats
    return item


def _apply_generator(s: dict[str, Any], action: str, artifact: dict[str, Any], registry: dict[str, Any]) -> None:
    if action == registry["children"]["generator"]["actions"]["build_project_profile"]:
        _append_version(_artifact_slot(s, "project_profile"), artifact); s["stage"] = "PROJECT_PROFILE_DRAFTED"
    elif action == registry["children"]["generator"]["actions"]["build_argument_architecture"]:
        if not isinstance(artifact, dict) or artifact.get("artifact_type") != "argument_architecture":
            raise ValueError("argument architecture response requires an argument_architecture artifact")
        if s.get("content_generation_mode") == "source_grounded":
            _structured_chapters(artifact.get("content"))
        _append_version(_artifact_slot(s, "argument_architecture"), artifact); s["stage"] = "ARGUMENT_ARCHITECTURE_DRAFTED"
    elif action in {registry["children"]["generator"]["actions"]["generate_outline"], registry["children"]["generator"]["actions"]["revise_outline"]}:
        slot = _artifact_slot(s, "outline")
        item = _append_version(slot, artifact)
        item["review_status"] = "pending"
        s["stage"] = "OUTLINE_DRAFTED"
        # Try to obtain chapter order from a structured artifact.
        content = item.get("content")
        if isinstance(content, dict) and isinstance(content.get("chapters"), list):
            s["chapter_order"] = [str(x.get("id") or x.get("chapter_id")) for x in content["chapters"] if x.get("id") or x.get("chapter_id")]
        if _outline_title_gate(s, item, registry):
            if _outline_evaluation_theme_gate(s, item, registry):
                if _outline_power_domain_gate(s, item, registry):
                    if _outline_level2_subject_power_gate(s, item, registry):
                        if _outline_chinese_technology_heading_gate(s, item, registry):
                            if _outline_heading_source_term_gate(s, item, registry):
                                if _outline_technology_option_gate(s, item, registry):
                                    if _outline_heading_ending_gate(s, item, registry):
                                        if _outline_level3_task_subject_gate(s, item, registry):
                                            _outline_based_on_ratio_gate(s, item, registry)
    elif action == registry["children"]["generator"]["actions"]["search_references"]:
        _append_version(_artifact_slot(s, "reference_plan"), artifact); s["stage"] = "REFERENCE_PLAN_DRAFTED"
    elif action == registry["children"]["generator"]["actions"]["prepare_chapter_materials"]:
        cid = s["current_chapter_id"]; _chapter_slot(s, cid)["materials"] = artifact; s["stage"] = "CHAPTER_MATERIALS_READY"
    elif action in {registry["children"]["generator"]["actions"]["generate_chapter_plan"], registry["children"]["generator"]["actions"]["revise_chapter_plan"]}:
        cid = s["current_chapter_id"]
        chapter = _chapter_slot(s, cid)
        _append_version(chapter["plan"], artifact)
        plan_content = artifact.get("content") if isinstance(artifact, dict) else None
        if isinstance(plan_content, dict) and isinstance(plan_content.get("experiment_reference_package"), dict):
            chapter["experiment_reference_package"] = copy.deepcopy(plan_content["experiment_reference_package"])
        s["stage"] = "CHAPTER_PLAN_DRAFTED"
    elif action in {registry["children"]["generator"]["actions"]["generate_chapter"], registry["children"]["generator"]["actions"]["revise_chapter"]}:
        cid = s["current_chapter_id"]
        chapter = _chapter_slot(s, cid)
        item = _append_version(chapter["content"], artifact)
        item["review_status"] = "pending"
        chapter["status"] = "drafted"
        s["stage"] = "CHAPTER_DRAFTED"
        if _chapter_length_gate(s, cid, item, registry):
            if _chapter_heading_bridge_gate(s, cid, item, registry):
                _chapter_summary_gate(s, cid, item, registry)
    elif action == registry["children"]["generator"]["actions"]["generate_abstract"]:
        item = _append_version(_artifact_slot(s, "abstract"), artifact)
        s["stage"] = "ABSTRACT_DRAFTED"
        _abstract_quality_gate(s, item, registry)
    elif action in {registry["children"]["generator"]["actions"]["assemble_report"], registry["children"]["generator"]["actions"]["revise_report"]}:
        normalized_artifact = _normalize_report_artifact(artifact, registry)
        item = _append_version(_artifact_slot(s, "report"), normalized_artifact)
        item["review_status"] = "pending"
        s["stage"] = "REPORT_ASSEMBLED"
    else:
        raise ValueError(f"unsupported generator action: {action}")


def _apply_reviewer(s: dict[str, Any], action: str, review: dict[str, Any], registry: dict[str, Any]) -> None:
    _validate_structured_review(review)
    decision = review.get("decision")
    reviewed_version = review.get("reviewed_version")
    if action == registry["children"]["reviewer"]["actions"]["review_outline"]:
        slot = _artifact_slot(s, "outline")
        latest = _latest(slot)
        if not latest or latest.get("version") != reviewed_version:
            raise ValueError("outline review version mismatch")
        if latest.get("artifact_id") and review.get("reviewed_artifact_id") != latest.get("artifact_id"):
            raise ValueError("outline review artifact_id mismatch")
        slot["reviews"].append(copy.deepcopy(review))
        latest["review_status"] = "passed" if decision == "pass" else "revision_required"
        if decision == "pass": s["stage"] = "OUTLINE_REVIEW_PASSED"
        elif decision in {"minor_revision", "major_revision", "revise"}:
            s["revision_counters"]["outline"] += 1
            if s["revision_counters"]["outline"] > registry["workflow"].get("max_outline_revision_rounds", 2):
                s["stage"] = "AWAITING_USER"; s["last_error"] = {"message": "outline revision limit reached"}
            else: s["stage"] = "OUTLINE_REVISION_REQUIRED"
        else: s["stage"] = "AWAITING_USER"; s["last_error"] = {"message": "outline review blocked", "review": review}
    elif action == registry["children"]["reviewer"]["actions"]["review_chapter"]:
        cid = s["current_chapter_id"]; slot = _chapter_slot(s, cid)["content"]; latest = _latest(slot)
        if not latest or latest.get("version") != reviewed_version:
            raise ValueError("chapter review version mismatch")
        if latest.get("artifact_id") and review.get("reviewed_artifact_id") != latest.get("artifact_id"):
            raise ValueError("chapter review artifact_id mismatch")
        slot["reviews"].append(copy.deepcopy(review))
        latest["review_status"] = "passed" if decision == "pass" else "revision_required"
        if decision == "pass": s["stage"] = "CHAPTER_REVIEW_PASSED"
        elif decision in {"minor_revision", "major_revision", "revise"}:
            counts = s["revision_counters"]["chapters"]; counts[cid] = counts.get(cid, 0) + 1
            if counts[cid] > registry["workflow"].get("max_chapter_revision_rounds", 2):
                s["stage"] = "AWAITING_USER"; s["last_error"] = {"message": "chapter revision limit reached", "chapter_id": cid}
            else: s["stage"] = "CHAPTER_REVISION_REQUIRED"
        else: s["stage"] = "AWAITING_USER"; s["last_error"] = {"message": "chapter review blocked", "chapter_id": cid, "review": review}
    elif action == registry["children"]["reviewer"]["actions"]["review_report"]:
        slot = _artifact_slot(s, "report"); latest = _latest(slot)
        if not latest or latest.get("version") != reviewed_version:
            raise ValueError("report review version mismatch")
        if latest.get("artifact_id") and review.get("reviewed_artifact_id") != latest.get("artifact_id"):
            raise ValueError("report review artifact_id mismatch")
        slot["reviews"].append(copy.deepcopy(review))
        latest["review_status"] = "passed" if decision == "pass" else "revision_required"
        if decision == "pass": s["stage"] = "REPORT_REVIEW_PASSED"
        elif decision in {"minor_revision", "major_revision", "revise"}:
            s["revision_counters"]["report"] += 1
            if s["revision_counters"]["report"] > registry["workflow"].get("max_report_revision_rounds", 2):
                s["stage"] = "AWAITING_USER"; s["last_error"] = {"message": "report revision limit reached"}
            else: s["stage"] = "REPORT_REVISION_REQUIRED"
        else: s["stage"] = "AWAITING_USER"; s["last_error"] = {"message": "report review blocked", "review": review}
    else:
        raise ValueError(f"unsupported reviewer action: {action}")


def _apply_formatter(s: dict[str, Any], action: str, response: dict[str, Any], registry: dict[str, Any]) -> None:
    actions = registry["children"]["formatter"]["actions"]
    slot = _artifact_slot(s, "word_report")
    if action in {actions["create_word_report"], actions["format_existing_word_report"]}:
        artifact = response.get("artifact")
        if not isinstance(artifact, dict):
            raise ValueError("formatter response requires artifact")
        if artifact.get("artifact_type") != "word_report":
            raise ValueError("formatter artifact_type must be word_report")
        item = _append_version(slot, artifact)
        item["validation_status"] = "pending"
        s.setdefault("word_report", {})["status"] = "generated"
        s["stage"] = "WORD_REPORT_GENERATED"
        return
    if action == actions["validate_word_report"]:
        result = response.get("validation_result")
        if not isinstance(result, dict):
            raise ValueError("formatter validation response requires validation_result")
        _validate_word_result(result, bool(registry["workflow"].get("require_word_visual_qa", True)))
        latest = _latest(slot)
        if not latest or latest.get("version") != result.get("validated_version"):
            raise ValueError("word report validation version mismatch")
        if latest.get("artifact_id") and result.get("validated_artifact_id") != latest.get("artifact_id"):
            raise ValueError("word report validation artifact_id mismatch")
        slot["reviews"].append(copy.deepcopy(result))
        decision = result.get("decision")
        if decision == "pass":
            latest["validation_status"] = "passed"
            s.setdefault("word_report", {})["status"] = "validated"
            s["stage"] = "WORD_REPORT_VALIDATED"
        elif decision == "revise":
            latest["validation_status"] = "revision_required"
            s["revision_counters"]["word_report"] = s["revision_counters"].get("word_report", 0) + 1
            if s["revision_counters"]["word_report"] > registry["workflow"].get("max_word_format_revision_rounds", 2):
                s["stage"] = "AWAITING_USER"
                s["last_error"] = {"message": "word report formatting revision limit reached", "validation_result": result}
            else:
                s["stage"] = "WORD_REPORT_REVISION_REQUIRED"
        else:
            s["stage"] = "AWAITING_USER"
            s["last_error"] = {"message": "word report validation blocked", "validation_result": result}
        return
    raise ValueError(f"unsupported formatter action: {action}")


def _has_pass_word_validation(slot: dict[str, Any], artifact: dict[str, Any] | None) -> bool:
    if not artifact:
        return False
    for result in reversed(slot.get("reviews", [])):
        if result.get("validated_version") != artifact.get("version"):
            continue
        if result.get("validated_artifact_id") != artifact.get("artifact_id"):
            continue
        if result.get("decision") == "pass" and result.get("valid") is True:
            return True
    return False


def confirm(state: dict[str, Any], target: str, *, source_root: Path | None = None) -> dict[str, Any]:
    s = copy.deepcopy(state)
    if s.get("pending_action") is not None or _active_user_revision(s):
        raise ValueError("cannot confirm while an action or user revision is pending")
    expected = _confirmation_target(s)
    if expected != target:
        raise ValueError(f"cannot confirm {target!r} while stage={s['stage']}; expected={expected!r}")
    if target == "project_profile" and not _project_intake_complete(s):
        raise ValueError("project profile cannot be confirmed before all four fixed intake questions are answered")
    if target == "argument_architecture" and s.get("content_generation_mode") == "source_grounded":
        _structured_chapters((_latest(_artifact_slot(s, "argument_architecture")) or {}).get("content"))
    if target == "reference_plan":
        validate_reference_artifact(_latest(_artifact_slot(s, "reference_plan")), source_root=source_root)
    if target == "outline":
        slot = _artifact_slot(s, "outline")
        if not _has_pass_review(slot, _latest(slot)):
            raise ValueError("outline cannot be confirmed before report-reviewer returns a structured pass result for the current version")
    if target.startswith("chapter:"):
        cid = target.split(":", 1)[1]
        slot = _chapter_slot(s, cid)["content"]
        if not _has_pass_review(slot, _latest(slot)):
            raise ValueError("chapter cannot be confirmed before report-reviewer returns a structured pass result for the current version")
    if target == "report":
        slot = _artifact_slot(s, "report")
        if not _has_pass_review(slot, _latest(slot)):
            raise ValueError("report cannot be confirmed before report-reviewer returns a structured pass result for the current version")
    if target == "word_report":
        slot = _artifact_slot(s, "word_report")
        if not _has_pass_word_validation(slot, _latest(slot)):
            raise ValueError("word report cannot be confirmed before structural validation and full-page visual QA pass for the current version")
    s["confirmations"][target] = {"confirmed": True, "at": now()}
    if target == "project_profile": s["stage"] = "PROJECT_PROFILE_CONFIRMED"
    elif target == "argument_architecture":
        slot = _artifact_slot(s, "argument_architecture")
        slot["approved_version"] = _latest(slot)["version"]
        s["stage"] = "ARGUMENT_ARCHITECTURE_CONFIRMED"
    elif target == "outline":
        slot = _artifact_slot(s, "outline"); slot["approved_version"] = _latest(slot)["version"]; s["stage"] = "OUTLINE_CONFIRMED"
    elif target == "reference_plan":
        slot = _artifact_slot(s, "reference_plan"); slot["approved_version"] = _latest(slot)["version"]; s["stage"] = "REFERENCE_PLAN_CONFIRMED"
    elif target.startswith("chapter_plan:"):
        cid = target.split(":", 1)[1]; slot = _chapter_slot(s, cid)["plan"]; slot["approved_version"] = _latest(slot)["version"]; s["stage"] = "CHAPTER_PLAN_CONFIRMED"
    elif target.startswith("chapter:"):
        cid = target.split(":", 1)[1]
        chapter = _chapter_slot(s, cid)
        slot = chapter["content"]
        latest = _latest(slot)
        metrics = (latest or {}).get("quality_metrics", {}).get("chapter_length")
        if not metrics or not metrics.get("length_gate_passed"):
            raise ValueError("chapter cannot be confirmed before the 80% length gate passes")
        bridge = (latest or {}).get("quality_metrics", {}).get("heading_bridge")
        if not bridge or not bridge.get("bridge_gate_passed"):
            raise ValueError("chapter cannot be confirmed before the H1-to-H2 transition prose gate passes")
        slot["approved_version"] = latest["version"]
        chapter["status"] = "confirmed"
        s["stage"] = "CHAPTER_CONFIRMED"
    elif target == "abstract":
        slot = _artifact_slot(s, "abstract")
        latest = _latest(slot)
        metrics = (latest or {}).get("quality_metrics", {}).get("abstract_quality")
        if not metrics or not metrics.get("valid"):
            raise ValueError("abstract cannot be confirmed before the bilingual length/order quality gate passes")
        slot["approved_version"] = latest["version"]
        s["stage"] = "ABSTRACT_CONFIRMED"
    elif target == "report":
        slot = _artifact_slot(s, "report"); slot["approved_version"] = _latest(slot)["version"]; s["stage"] = "REPORT_CONFIRMED"
    if target == "word_report":
        slot = _artifact_slot(s, "word_report")
        slot["approved_version"] = _latest(slot)["version"]
        s["stage"] = "COMPLETED"
        s.setdefault("word_report", {})["status"] = "confirmed"
    _record(s, "user_confirmed", target=target)
    return s


def prepare_pending_request(state: dict[str, Any], registry: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    s = copy.deepcopy(state)
    if s.get("pending_action") is not None:
        return s, copy.deepcopy(s["pending_action"])
    action = next_action(s, registry)
    if action.get("kind"):
        return s, action
    s["pending_action"] = action
    s["last_request_id"] = action["orchestration"]["request_id"]
    _record(s, "request_prepared", action=action["action"], skill=action["skill_name"])
    return s, action
