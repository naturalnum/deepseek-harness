#!/usr/bin/env python3
"""Adapter between the integrated workflow protocol and tech-report-writer scripts.

This script performs deterministic data preparation and script invocation. The child
Skill still owns final page-by-page visual inspection before returning validation pass.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from markdown_math import (
    normalize_formula_number_line,
    normalize_html_math,
    normalize_markdown_display_math,
    replace_inline_math_preserving_code,
)

SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL_DIR / "scripts"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def unwrap(value: Any) -> Any:
    if isinstance(value, dict) and "content" in value and (
        any(k in value for k in ("artifact_id", "artifact_type", "version")) or len(value) == 1
    ):
        return value.get("content")
    return value


def pick_text(value: Any) -> str:
    value = unwrap(value)
    if isinstance(value, str):
        path = Path(value)
        if "\n" not in value and path.is_file():
            return path.read_text(encoding="utf-8")
        return value
    if isinstance(value, dict):
        for key in ("markdown", "report_markdown", "text", "body", "report_text", "content_markdown"):
            if isinstance(value.get(key), str):
                return value[key]
        for key in ("markdown_path", "file_path", "path"):
            candidate = value.get(key)
            if isinstance(candidate, str) and Path(candidate).is_file():
                return Path(candidate).read_text(encoding="utf-8")
    return ""


def inline_markdown(text: str) -> str:
    # Markdown formulas must become internal markers before HTML escaping; otherwise
    # $...$/\\(...\\) reaches Word as literal LaTeX source. Inline-code spans are
    # protected by the helper and therefore remain ordinary code text.
    text = replace_inline_math_preserving_code(text)
    escaped = html.escape(text, quote=False)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", escaped)
    escaped = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"<a href='\2'>\1</a>", escaped)
    return escaped


def markdown_to_html(markdown: str, chapter_num: int, chapter_title: str) -> str:
    # Display math is normalized before the line-oriented Markdown parser. This keeps
    # multiline $$...$$ / \\[...\\] blocks from being flattened into prose.
    markdown = normalize_markdown_display_math(markdown)
    lines = markdown.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    first_h1_seen = False
    paragraph: list[str] = []
    code_fence: str | None = None
    code_lines: list[str] = []
    list_mode: str | None = None

    def flush_paragraph() -> None:
        if paragraph:
            text = " ".join(x.strip() for x in paragraph if x.strip())
            if text:
                out.append("<p style='font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em'>" + inline_markdown(text) + "</p>")
            paragraph.clear()

    def close_list() -> None:
        nonlocal list_mode
        if list_mode:
            out.append(f"</{list_mode}>")
            list_mode = None

    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        fence_match = re.match(r"^(```+|~~~+)", stripped)
        if code_fence is not None:
            if stripped.startswith(code_fence):
                out.append("<pre style='font-family:Consolas;font-size:10.5pt'>" + html.escape("\n".join(code_lines)) + "</pre>")
                code_lines.clear(); code_fence = None
            else:
                code_lines.append(line)
            continue
        if fence_match:
            flush_paragraph(); close_list()
            code_fence = fence_match.group(1)[:3]
            continue
        if not line.strip():
            flush_paragraph(); close_list(); continue
        if re.fullmatch(r"\[\[TECH_REPORT_MATH_B64:[A-Za-z0-9_=-]+\]\]", line.strip()):
            flush_paragraph(); close_list()
            out.append("<p style='font-family:宋体;font-size:10.5pt;line-height:1.0;text-align:center;text-indent:0'>" + html.escape(line.strip(), quote=False) + "</p>")
            continue
        formula_number = normalize_formula_number_line(line)
        if formula_number:
            flush_paragraph(); close_list()
            out.append("<p style='font-family:宋体;font-size:10.5pt;line-height:1.0;text-align:right;text-indent:0'>" + formula_number + "</p>")
            continue
        m = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if m:
            flush_paragraph(); close_list()
            level = min(len(m.group(1)), 3)
            title = re.sub(r"^\d+(?:\.\d+)*\s+", "", m.group(2)).strip()
            if level == 1:
                first_h1_seen = True
                out.append(f"<h1 style='font-family:黑体;font-size:15pt;page-break-before:always'>{chapter_num} {inline_markdown(title)}</h1>")
            elif level == 2:
                out.append(f"<h2 style='font-family:黑体;font-size:14pt'>{inline_markdown(title)}</h2>")
            else:
                out.append(f"<h3 style='font-family:黑体;font-size:12pt'>{inline_markdown(title)}</h3>")
            continue
        m = re.match(r"^[-*+]\s+(.+)$", line)
        if m:
            flush_paragraph()
            if list_mode != "ul": close_list(); out.append("<ul>"); list_mode = "ul"
            out.append("<li>" + inline_markdown(m.group(1)) + "</li>")
            continue
        m = re.match(r"^\d+[.)、]\s*(.+)$", line)
        if m:
            flush_paragraph()
            if list_mode != "ol": close_list(); out.append("<ol>"); list_mode = "ol"
            out.append("<li>" + inline_markdown(m.group(1)) + "</li>")
            continue
        if line.lstrip().startswith(">"):
            flush_paragraph(); close_list()
            out.append("<p style='font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em'>" + inline_markdown(line.lstrip()[1:].strip()) + "</p>")
            continue
        paragraph.append(line)
    flush_paragraph(); close_list()
    if code_fence is not None and code_lines:
        out.append("<pre style='font-family:Consolas;font-size:10.5pt'>" + html.escape("\n".join(code_lines)) + "</pre>")
    if not first_h1_seen:
        out.insert(0, f"<h1 style='font-family:黑体;font-size:15pt;page-break-before:always'>{chapter_num} {inline_markdown(chapter_title)}</h1>")
    return "\n".join(out)


def title_from_content(content: Any, fallback: str) -> str:
    content = unwrap(content)
    if isinstance(content, dict):
        for key in ("title", "chapter_title", "name"):
            if isinstance(content.get(key), str) and content[key].strip():
                return content[key].strip()
    text = pick_text(content)
    m = re.search(r"^#\s+(?:\d+\s+)?(.+)$", text, flags=re.MULTILINE)
    return m.group(1).strip() if m else fallback


def split_markdown_chapters(markdown: str) -> list[tuple[str, str]]:
    matches = list(re.finditer(r"^#\s+(?:第?\d+章?\s*)?(.+?)\s*$", markdown, flags=re.MULTILINE))
    if not matches:
        return [("正文", markdown)] if markdown.strip() else []
    result = []
    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        result.append((match.group(1).strip(), markdown[start:end].strip()))
    return result


def outline_rows(outline_artifact: Any, chapters: list[dict[str, Any]]) -> dict[str, Any]:
    content = unwrap(outline_artifact)
    rows = content.get("chapters") if isinstance(content, dict) else None
    out = []
    if isinstance(rows, list):
        for idx, row in enumerate(rows, 1):
            if not isinstance(row, dict): continue
            sections = row.get("sections") or row.get("section_outline") or []
            normalized_sections = []
            for sec in sections:
                if isinstance(sec, str): normalized_sections.append({"title": sec})
                elif isinstance(sec, dict) and sec.get("title"): normalized_sections.append({"title": str(sec["title"])})
            out.append({"num": idx, "title": str(row.get("title") or row.get("chapter_title") or f"第{idx}章"), "sections": normalized_sections})
    if not out:
        out = [{"num": c["num"], "title": c["title"], "sections": []} for c in chapters]
    return {"chapters": out}


def abstract_data(abstract_artifact: Any) -> dict[str, Any]:
    content = unwrap(abstract_artifact)
    if not isinstance(content, dict):
        return {}
    cn = content.get("abstract_cn") or content.get("chinese_abstract") or content.get("summary_cn")
    en = content.get("abstract_en") or content.get("english_abstract") or content.get("summary_en")
    kw_cn = content.get("keywords_cn") or content.get("chinese_keywords") or content.get("keywords")
    kw_en = content.get("keywords_en") or content.get("english_keywords")
    if isinstance(kw_cn, list): kw_cn = "；".join(str(x) for x in kw_cn)
    if isinstance(kw_en, list): kw_en = "; ".join(str(x) for x in kw_en)
    if isinstance(cn, str) and not cn.lstrip().startswith("<"):
        cn = "<p style='font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em'>" + inline_markdown(cn) + "</p>"
    elif isinstance(cn, str):
        cn = normalize_html_math(cn)
    if isinstance(en, str) and not en.lstrip().startswith("<"):
        en = "<p style='font-family:Times New Roman;font-size:12pt;line-height:1.5;text-indent:2em'>" + inline_markdown(en) + "</p>"
    elif isinstance(en, str):
        en = normalize_html_math(en)
    return {"abstract_cn": cn or "", "keywords_cn": kw_cn or "", "abstract_en": en or "", "keywords_en": kw_en or ""}


def references_data(reference_artifact: Any) -> dict[str, Any]:
    content = unwrap(reference_artifact)
    if not isinstance(content, dict):
        return {"references_html": ""}
    items = content.get("items") or content.get("references") or content.get("verified_references") or []
    if not isinstance(items, list):
        return {"references_html": ""}
    paragraphs: list[str] = []
    for idx, item in enumerate(items, 1):
        if not isinstance(item, dict):
            continue
        if item.get("verification_status") not in {None, "verified"}:
            continue
        entry = str(item.get("gbt7714_entry") or "").strip()
        if not entry:
            continue
        entry = re.sub(r"^\[\d+\]\s*", "", entry).strip()
        paragraphs.append(
            "<p style='font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em'>"
            + f"[{idx}] " + html.escape(entry) + "</p>"
        )
    return {"references_html": "\n".join(paragraphs)}


def chapter_data(payload: dict[str, Any]) -> list[dict[str, Any]]:
    approved = payload.get("approved_chapters") or []
    result: list[dict[str, Any]] = []
    for idx, artifact in enumerate(approved, 1):
        content = unwrap(artifact)
        title = title_from_content(content, f"第{idx}章")
        if isinstance(content, dict) and isinstance(content.get("content_html"), str):
            body = normalize_html_math(content["content_html"])
        elif isinstance(content, dict) and isinstance(content.get("html"), str):
            body = normalize_html_math(content["html"])
        else:
            body = markdown_to_html(pick_text(content), idx, title)
        result.append({"num": idx, "title": title, "content_html": body})
    if result:
        return result
    report_md = pick_text(payload.get("source_report"))
    for idx, (title, md) in enumerate(split_markdown_chapters(report_md), 1):
        result.append({"num": idx, "title": title, "content_html": markdown_to_html(md, idx, title)})
    return result


def run_command(cmd: list[str], env: dict[str, str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, env=env, text=True, capture_output=True, check=True)


def create_word_report(request: dict[str, Any]) -> dict[str, Any]:
    payload = request.get("payload") or {}
    output_pref = payload.get("output_preferences") or {}
    workspace = Path(output_pref.get("workspace_dir") or os.getcwd()).resolve()
    output_dir = Path(output_pref.get("output_dir") or workspace / "output" / "word")
    if not output_dir.is_absolute(): output_dir = workspace / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    metadata = payload.get("word_metadata") or {}
    required = {"report_no", "class_no", "secret_level", "project_source", "title_cn", "title_en", "project_name", "report_date"}
    missing = sorted(x for x in required if not str(metadata.get(x) or "").strip())
    if missing:
        raise ValueError("missing required Word metadata: " + ", ".join(missing))
    cover_keys = ["report_no", "class_no", "secret_level", "project_source", "title_cn", "title_en", "project_name", "series_no", "cooperator", "report_date", "work_period", "leader", "staff", "writer"]
    cover = {key: metadata.get(key, [] if key == "cooperator" else "") for key in cover_keys}
    chapters = chapter_data(payload)
    if not chapters:
        raise ValueError("no approved chapters or parseable Markdown content were provided")
    outline = outline_rows(payload.get("outline"), chapters)
    abstract = abstract_data(payload.get("abstract"))
    references = references_data(payload.get("reference_plan"))
    missing_abstract = [key for key, value in abstract.items() if not str(value or "").strip()]
    if missing_abstract:
        raise ValueError("abstract artifact is missing required Word fields: " + ", ".join(missing_abstract))

    save_json(output_dir / "cover_info.json", cover)
    save_json(output_dir / "outline.json", outline)
    save_json(output_dir / "abstract.json", abstract)
    if references.get("references_html"):
        save_json(output_dir / "references.json", references)
    for row in chapters:
        save_json(output_dir / f"chapter_{row['num']}.json", row)

    env = os.environ.copy(); env["TECH_REPORT_OUTPUT_DIR"] = str(output_dir)
    py = sys.executable
    validations = [[py, str(SCRIPTS / "main.py"), "validate-cover"], [py, str(SCRIPTS / "main.py"), "validate-outline"], [py, str(SCRIPTS / "main.py"), "validate-abstract"]]
    validations += [[py, str(SCRIPTS / "main.py"), "validate-chapter", str(row["num"])] for row in chapters]
    if references.get("references_html"):
        validations.append([py, str(SCRIPTS / "main.py"), "validate-references"])
    logs = []
    for cmd in validations:
        proc = run_command(cmd, env, workspace); logs.append({"cmd": cmd[-1], "stdout": proc.stdout, "stderr": proc.stderr})
    before = set(output_dir.glob("*.docx"))
    proc = run_command([py, str(SCRIPTS / "main.py"), "create-report"], env, workspace)
    after = set(output_dir.glob("*.docx"))
    candidates = sorted(after - before, key=lambda x: x.stat().st_mtime)
    if not candidates:
        candidates = sorted(after, key=lambda x: x.stat().st_mtime)
    if not candidates:
        raise RuntimeError("create-report completed without a DOCX output")
    docx = candidates[-1].resolve()
    source = payload.get("source_report") or {}
    artifact_id = f"word_{uuid.uuid4().hex[:16]}"
    return {
        "request_id": request["orchestration"]["request_id"],
        "skill_name": "tech-report-writer",
        "action": request["action"],
        "status": "success",
        "artifact": {
            "artifact_type": "word_report", "artifact_id": artifact_id, "version": 1,
            "content": {
                "docx_path": str(docx), "data_dir": str(output_dir),
                "source_report_artifact_id": source.get("artifact_id") if isinstance(source, dict) else None,
                "source_report_version": source.get("version") if isinstance(source, dict) else None,
            },
            "summary": "已使用技术报告模板生成 DOCX，等待独立结构与视觉验收。",
        },
        "metadata": {"preflight_validations": logs, "create_stdout": proc.stdout, "create_stderr": proc.stderr},
        "error": None,
    }


def format_existing(request: dict[str, Any]) -> dict[str, Any]:
    payload = request.get("payload") or {}
    artifact = payload.get("word_report") or {}
    content = unwrap(artifact)
    docx_path = content.get("docx_path") if isinstance(content, dict) else None
    if not docx_path or not Path(docx_path).is_file():
        raise ValueError("word_report.content.docx_path does not point to a file")
    src = Path(docx_path).resolve()
    dst = src.with_name(f"{src.stem}_格式修复版{src.suffix}")
    index = 2
    while dst.exists():
        dst = src.with_name(f"{src.stem}_格式修复版_v{index}{src.suffix}"); index += 1
    proc = subprocess.run([sys.executable, str(SCRIPTS / "format_existing_report.py"), str(src), str(dst)], text=True, capture_output=True, check=True)
    source_id = artifact.get("artifact_id") if isinstance(artifact, dict) else None
    return {
        "request_id": request["orchestration"]["request_id"], "skill_name": "tech-report-writer",
        "action": request["action"], "status": "success",
        "artifact": {
            "artifact_type": "word_report", "artifact_id": f"word_{uuid.uuid4().hex[:16]}", "version": 1,
            "content": {"docx_path": str(dst), "based_on_word_artifact_id": source_id},
            "summary": "已根据校验问题另存为格式修复版，等待重新验收。",
        },
        "metadata": {"stdout": proc.stdout, "stderr": proc.stderr}, "error": None,
    }


def validate_word(request: dict[str, Any]) -> dict[str, Any]:
    payload = request.get("payload") or {}
    artifact = payload.get("word_report") or {}
    content = unwrap(artifact)
    docx_path = content.get("docx_path") if isinstance(content, dict) else None
    if not docx_path or not Path(docx_path).is_file():
        raise ValueError("word_report.content.docx_path does not point to a file")
    docx = Path(docx_path).resolve()
    sys.path.insert(0, str(SCRIPTS))
    from report_validator import validate_report  # type: ignore
    structural = validate_report(str(docx))
    render_dir = docx.parent / f"{docx.stem}_visual_qa"
    render_json = render_dir / "render.json"
    render_proc = subprocess.run([sys.executable, str(SCRIPTS / "render_for_visual_qa.py"), str(docx), str(render_dir), "--json-out", str(render_json)], text=True, capture_output=True)
    render = load_json(render_json) if render_json.is_file() else {"success": False, "error": render_proc.stderr or render_proc.stdout}
    supplied_visual = payload.get("visual_qa_result") or {}
    visual_status = supplied_visual.get("status") or ("rendered_pending_inspection" if render.get("success") else "blocked")
    visual_issues = list(supplied_visual.get("issues", []))
    catalog_qa = render.get("catalog_qa") or {}
    if catalog_qa.get("checked") and catalog_qa.get("ok") is False:
        if catalog_qa.get("not_found_markers"):
            visual_issues.append("目录区域仍显示“未找到目录项”类错误文本")
        if catalog_qa.get("missing_figure_catalog_entries"):
            visual_issues.append(
                "图目录未显示全部已标记图题："
                + "、".join(catalog_qa["missing_figure_catalog_entries"][:5])
            )
        if catalog_qa.get("missing_table_catalog_entries"):
            visual_issues.append(
                "表目录未显示全部已标记表题："
                + "、".join(catalog_qa["missing_table_catalog_entries"][:5])
            )
        if visual_status == "passed":
            # visual_qa.status follows formatter-response.schema.json; the
            # workflow-level decision below carries the "revise" instruction.
            visual_status = "failed"
    visual = {
        "status": visual_status,
        "page_count": int(render.get("page_count") or supplied_visual.get("page_count") or 0),
        "inspected_pages": supplied_visual.get("inspected_pages", []),
        "render_dir": render.get("render_dir", str(render_dir)),
        "pdf_path": render.get("pdf_path"),
        "png_paths": render.get("png_paths", []),
        "issues": visual_issues,
        "catalog_qa": catalog_qa,
    }
    passed = bool(structural.get("valid")) and visual["status"] == "passed" and visual["page_count"] > 0 and len(set(visual["inspected_pages"])) >= visual["page_count"]
    decision = "pass" if passed else ("revise" if structural.get("errors") or visual.get("issues") else "blocked")
    return {
        "request_id": request["orchestration"]["request_id"], "skill_name": "tech-report-writer",
        "action": request["action"], "status": "success",
        "validation_result": {
            "validated_artifact_id": artifact.get("artifact_id"),
            "validated_version": artifact.get("version"),
            "decision": decision, "valid": passed, "docx_path": str(docx),
            "structural_validation": {"passed": bool(structural.get("valid")), "errors": structural.get("errors", []), "warnings": structural.get("warnings", [])},
            "visual_qa": visual,
            "revision_instruction": "；".join(structural.get("errors", []) + visual.get("issues", [])),
        },
        "error": None,
    }


def blocked_response(request: dict[str, Any], message: str) -> dict[str, Any]:
    return {"request_id": request.get("orchestration", {}).get("request_id"), "skill_name": "tech-report-writer", "action": request.get("action"), "status": "blocked", "error": {"message": message}}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("request", type=Path)
    ap.add_argument("response", type=Path)
    args = ap.parse_args()
    request = load_json(args.request)
    try:
        if request.get("skill_name") != "tech-report-writer": raise ValueError("skill_name must be tech-report-writer")
        action = request.get("action")
        if action == "create_word_report": result = create_word_report(request)
        elif action == "format_existing_word_report": result = format_existing(request)
        elif action == "validate_word_report": result = validate_word(request)
        else: raise ValueError(f"unsupported action: {action}")
    except Exception as exc:
        result = blocked_response(request, str(exc))
    save_json(args.response, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("status") == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
