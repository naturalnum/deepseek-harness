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

from local_images import local_image_uri, localize_html_images

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


def source_image_root(source: Any) -> Path:
    """File-backed Markdown resolves figures beside that file, inside the current workspace."""
    workspace = Path.cwd().resolve()
    content = unwrap(source)
    candidate = None
    if isinstance(content, dict) and not any(isinstance(content.get(key), str) for key in
            ("markdown", "report_markdown", "text", "body", "report_text", "content_markdown")):
        candidate = next((content[key] for key in ("markdown_path", "file_path", "path")
                          if isinstance(content.get(key), str)), None)
    elif isinstance(content, str) and "\n" not in content and Path(content).is_file():
        candidate = content
    if candidate is None:
        return workspace
    source_path = Path(candidate).resolve()
    if not source_path.is_relative_to(workspace):
        raise ValueError("image-bearing report Markdown must be inside the current workspace")
    return source_path.parent


def inline_markdown(text: str, image_root: Path | None = None) -> str:
    # Markdown formulas must become internal markers before HTML escaping; otherwise
    # $...$/\\(...\\) reaches Word as literal LaTeX source. Inline-code spans are
    # protected by the helper and therefore remain ordinary code text.
    fragments = []
    token = "TECHREPORTINLINE" + uuid.uuid4().hex
    def protect(match):
        if match.group(1) is not None:
            fragment = "<code>" + html.escape(match.group(1), quote=False) + "</code>"
        else:
            uri = local_image_uri(match.group(3).strip(), image_root or Path.cwd().resolve())
            fragment = "<img src='" + uri + "' alt='" + html.escape(match.group(2), quote=True) + "'/>"
        fragments.append(fragment)
        return token + str(len(fragments) - 1) + "END"
    text = re.sub(r"`([^`]+)`|(?<!\\)!\[([^\]]*)\]\(([^)\n]+)\)", protect, text)
    text = replace_inline_math_preserving_code(text)
    escaped = html.escape(text, quote=False)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", escaped)
    escaped = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"<a href='\2'>\1</a>", escaped)
    for index, fragment in enumerate(fragments):
        escaped = escaped.replace(token + str(index) + "END", fragment)
    return escaped


def markdown_table_html(lines: list[str], image_root: Path | None = None) -> str:
    """Keep pipe-table cells and alignment as native Word table input."""
    def cells(line: str) -> list[str]:
        return [cell.strip().replace(r"\|", "|") for cell in re.split(r"(?<!\\)\|", line.strip().strip("|"))]

    rows = [cells(line) for line in lines]
    if len(rows) < 2 or not all(re.fullmatch(r":?-{3,}:?", cell) for cell in rows[1]):
        raise ValueError("invalid Markdown table delimiter")
    if any(len(row) != len(rows[0]) for row in rows[1:]):
        raise ValueError("Markdown table rows have inconsistent cell counts")
    alignment = ["center" if cell.startswith(":") and cell.endswith(":") else
                 "right" if cell.endswith(":") else "left" for cell in rows[1]]
    rendered = ["<table style='border-collapse:collapse;width:100%'>"]
    for index, row in enumerate([rows[0], *rows[2:]]):
        tag = "th" if index == 0 else "td"
        rendered.append("<tr>" + "".join(
            f"<{tag} style='text-align:{align};font-family:宋体;font-size:10.5pt'>"
            + inline_markdown(cell, image_root) + f"</{tag}>" for cell, align in zip(row, alignment)) + "</tr>")
    return "\n".join([*rendered, "</table>"])


def markdown_to_html(markdown: str, chapter_num: int, chapter_title: str, image_root: Path | None = None) -> str:
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
    table_lines: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            text = " ".join(x.strip() for x in paragraph if x.strip())
            if text:
                out.append("<p style='font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em'>" + inline_markdown(text, image_root) + "</p>")
            paragraph.clear()

    def close_list() -> None:
        nonlocal list_mode
        if list_mode:
            out.append(f"</{list_mode}>")
            list_mode = None

    for index, raw in enumerate(lines):
        line = raw.rstrip()
        stripped = line.strip()
        if table_lines:
            if "|" in line and line.strip():
                table_lines.append(line)
                continue
            out.append(markdown_table_html(table_lines, image_root))
            table_lines.clear()
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
        if "|" in line and index + 1 < len(lines) and re.fullmatch(
            r"\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*", lines[index + 1]
        ):
            flush_paragraph(); close_list()
            table_lines.append(line)
            continue
        if not line.strip():
            flush_paragraph(); close_list(); continue
        image = re.fullmatch(r"!\[([^\]]*)\]\(([^)\n]+)\)", stripped)
        if image:
            flush_paragraph(); close_list()
            out.append("<p style='text-align:center;text-indent:0'>" + inline_markdown(stripped, image_root) + "</p>")
            caption = image.group(1).strip()
            following = next((item.strip() for item in lines[index + 1:] if item.strip()), "")
            if re.fullmatch(r"图\d+-\d+\s+.+", caption) and following != caption:
                if re.match(r"图\d+-\d+\s+", following):
                    raise ValueError("report image alt and following figure caption disagree")
                out.append("<p>" + inline_markdown(caption, image_root) + "</p>")
            continue
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
            title = m.group(2).strip()
            if level == 1:
                first_h1_seen = True
                title = re.sub(r"^\d+(?:\.\d+)*\s+", "", title).strip()
                out.append(f"<h1 style='font-family:黑体;font-size:15pt;page-break-before:always'>{chapter_num} {inline_markdown(title, image_root)}</h1>")
            elif level == 2:
                out.append(f"<h2 style='font-family:黑体;font-size:14pt'>{inline_markdown(title, image_root)}</h2>")
            else:
                out.append(f"<h3 style='font-family:黑体;font-size:12pt'>{inline_markdown(title, image_root)}</h3>")
            continue
        m = re.match(r"^[-*+]\s+(.+)$", line)
        if m:
            flush_paragraph()
            if list_mode != "ul": close_list(); out.append("<ul>"); list_mode = "ul"
            out.append("<li>" + inline_markdown(m.group(1), image_root) + "</li>")
            continue
        m = re.match(r"^\d+(?:\.(?!\d)|[)、])\s*(.+)$", line)
        if m:
            flush_paragraph()
            if list_mode != "ol": close_list(); out.append("<ol>"); list_mode = "ol"
            out.append("<li>" + inline_markdown(m.group(1), image_root) + "</li>")
            continue
        if line.lstrip().startswith(">"):
            flush_paragraph(); close_list()
            out.append("<p style='font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em'>" + inline_markdown(line.lstrip()[1:].strip(), image_root) + "</p>")
            continue
        paragraph.append(line)
    if table_lines:
        out.append(markdown_table_html(table_lines, image_root))
    flush_paragraph(); close_list()
    if code_fence is not None and code_lines:
        out.append("<pre style='font-family:Consolas;font-size:10.5pt'>" + html.escape("\n".join(code_lines)) + "</pre>")
    if not first_h1_seen:
        out.insert(0, f"<h1 style='font-family:黑体;font-size:15pt;page-break-before:always'>{chapter_num} {inline_markdown(chapter_title, image_root)}</h1>")
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
        cn = "\n".join("<p style='font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em'>"
                       + inline_markdown(part.strip()) + "</p>" for part in re.split(r"\n\s*\n", cn) if part.strip())
    elif isinstance(cn, str):
        cn = normalize_html_math(cn)
    if isinstance(en, str) and not en.lstrip().startswith("<"):
        en = "\n".join("<p style='font-family:Times New Roman;font-size:12pt;line-height:1.5;text-indent:2em'>"
                       + inline_markdown(part.strip()) + "</p>" for part in re.split(r"\n\s*\n", en) if part.strip())
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


def final_report_data(source_report: Any) -> dict[str, Any]:
    """Project the reviewed Markdown into Word fields without older snapshots."""
    markdown = pick_text(source_report).lstrip("\ufeff").replace("\r\n", "\n")
    markdown = re.sub(r"<!--.*?-->", "", markdown, flags=re.DOTALL)
    if not markdown.strip():
        raise ValueError("final source_report must contain readable Markdown")
    image_root = source_image_root(source_report) if "![" in markdown else None
    sections: list[dict[str, Any]] = []
    active: dict[str, Any] | None = None
    report_title = ""
    fence: str | None = None
    chapter_count = 0
    for line in markdown.splitlines():
        stripped = line.strip()
        fence_match = re.match(r"^(```+|~~~+)", stripped)
        if fence_match:
            marker = fence_match.group(1)[:3]
            fence = None if fence == marker else marker if fence is None else fence
        heading = None if fence is not None or fence_match else re.fullmatch(r"(#{1,2})\s+(.+?)\s*", line)
        if heading:
            level, title = len(heading.group(1)), heading.group(2).strip()
            body = re.fullmatch(r"(?:第\s*(\d+)\s*章\s*|([1-9]\d*)[.、]?\s+)(.+)", title) if level == 1 else None
            if title in {"摘要", "中文摘要", "内容摘要"} and chapter_count == 0:
                kind = "abstract_cn"
            elif title.lower() in {"abstract", "english abstract", "英文摘要"} and chapter_count == 0:
                kind = "abstract_en"
            elif title == "参考文献":
                kind = "references"
            elif body:
                number = int(body.group(1) or body.group(2))
                if number != chapter_count + 1 or any(section["kind"] in {"references", "appendix"} for section in sections):
                    raise ValueError("final source_report body chapters must be consecutive before references and appendices")
                chapter_count += 1
                kind, title = "chapter", body.group(3).strip()
            elif level == 1 and re.fullmatch(r"附录\s+[A-Z]\s+.+", title):
                kind = "appendix"
            elif level == 1 and not report_title and not sections:
                report_title = title
                continue
            elif level == 1:
                raise ValueError("final source_report has an unsupported top-level heading")
            else:
                kind = ""
            if kind:
                if kind in {"abstract_cn", "abstract_en", "references"} and any(section["kind"] == kind for section in sections):
                    raise ValueError("final source_report has duplicate front matter or references")
                active = {"kind": kind, "title": title, "lines": []}
                sections.append(active)
                continue
        if active is not None:
            active["lines"].append(line)
        elif stripped and not stripped.startswith("<!--"):
            raise ValueError("final source_report text is outside a recognized report section")
    if fence is not None or chapter_count == 0:
        raise ValueError("final source_report must contain complete numbered body chapters")
    result: dict[str, Any] = {"chapters": [], "abstract": {}, "references": {"references_html": ""}, "appendices": []}
    for section in sections:
        text = "\n".join(section["lines"]).strip()
        if not text:
            raise ValueError("final source_report contains an empty report section")
        kind = section["kind"]
        if kind == "chapter":
            number = len(result["chapters"]) + 1
            result["chapters"].append({"num": number, "title": section["title"],
                                       "content_html": markdown_to_html(f"# {number} {section['title']}\n\n{text}", number, section["title"], image_root)})
        elif kind in {"abstract_cn", "abstract_en"}:
            language = kind.removeprefix("abstract_")
            keyword_pattern = r"^\s*\*{0,2}(?:关键词|Keywords)\s*[:：]\s*\*{0,2}\s*(.+?)\s*$"
            keywords = [re.match(keyword_pattern, line, re.IGNORECASE) for line in section["lines"]]
            found = [match for match in keywords if match]
            if len(found) != 1:
                raise ValueError("final source_report requires one keyword line for each abstract")
            paragraphs = "\n".join(line for line, match in zip(section["lines"], keywords) if not match).strip()
            if not paragraphs:
                raise ValueError("final source_report abstract must not be empty")
            result["abstract"][kind] = paragraphs
            result["abstract"][f"keywords_{language}"] = found[0].group(1)
        elif kind == "references":
            result["references"] = {"references_html": "\n".join(
                "<p style='font-family:宋体;font-size:12pt;line-height:1.5;text-indent:2em'>"
                + inline_markdown(entry.strip(), image_root) + "</p>" for entry in re.split(r"\n\s*\n|\n(?=\[\d+\])", text) if entry.strip())}
        elif kind == "appendix":
            match = re.fullmatch(r"附录\s+([A-Z])\s+(.+)", section["title"])
            result["appendices"].append({"id": match.group(1), "title": match.group(2),
                                         "content_html": markdown_to_html(text, 0, match.group(2), image_root).split("\n", 1)[1]})
    if set(result["abstract"]) != {"abstract_cn", "abstract_en", "keywords_cn", "keywords_en"}:
        raise ValueError("final source_report requires supplied bilingual abstracts and keywords")
    if [item["id"] for item in result["appendices"]] != [chr(ord("A") + index) for index in range(len(result["appendices"]))]:
        raise ValueError("final source_report appendix identifiers must be consecutive from A")
    return result


def chapter_data(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if "source_report" in payload:
        return final_report_data(payload["source_report"])["chapters"]
    approved = payload.get("approved_chapters") or []
    result: list[dict[str, Any]] = []
    for idx, artifact in enumerate(approved, 1):
        content = unwrap(artifact)
        title = title_from_content(content, f"第{idx}章")
        if isinstance(content, dict) and isinstance(content.get("content_html"), str):
            body = normalize_html_math(localize_html_images(content["content_html"], source_image_root(artifact)))
        elif isinstance(content, dict) and isinstance(content.get("html"), str):
            body = normalize_html_math(localize_html_images(content["html"], source_image_root(artifact)))
        else:
            body = markdown_to_html(pick_text(content), idx, title, source_image_root(artifact))
        result.append({"num": idx, "title": title, "content_html": body})
    return result


def run_command(cmd: list[str], env: dict[str, str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, env=env, text=True, capture_output=True, check=True)


def create_word_report(request: dict[str, Any]) -> dict[str, Any]:
    payload = request.get("payload") or {}
    output_pref = payload.get("output_preferences") or {}
    workspace = Path(output_pref.get("workspace_dir") or os.getcwd()).resolve()
    output_root = Path(output_pref.get("output_dir") or workspace / "output" / "word")
    if not output_root.is_absolute(): output_root = workspace / output_root
    metadata = payload.get("word_metadata") or {}
    required = {"report_no", "class_no", "secret_level", "project_source", "title_cn", "title_en", "project_name", "report_date"}
    missing = sorted(x for x in required if not str(metadata.get(x) or "").strip())
    if missing:
        raise ValueError("missing required Word metadata: " + ", ".join(missing))
    cover_keys = ["report_no", "class_no", "secret_level", "project_source", "title_cn", "title_en", "project_name", "series_no", "cooperator", "report_date", "work_period", "leader", "staff", "writer"]
    cover = {key: metadata.get(key, [] if key == "cooperator" else "") for key in cover_keys}
    final = final_report_data(payload["source_report"]) if "source_report" in payload else None
    chapters = final["chapters"] if final is not None else chapter_data(payload)
    if not chapters:
        raise ValueError("no approved chapters or parseable Markdown content were provided")
    outline = outline_rows(None if final is not None else payload.get("outline"), chapters)
    abstract = abstract_data(final["abstract"] if final is not None else payload.get("abstract"))
    references = final["references"] if final is not None else references_data(payload.get("reference_plan"))
    missing_abstract = [key for key, value in abstract.items() if not str(value or "").strip()]
    if missing_abstract:
        raise ValueError("abstract artifact is missing required Word fields: " + ", ".join(missing_abstract))

    # The generator reads every chapter JSON in its directory; isolate each output
    # so an earlier edition cannot supply stale chapters, references or appendices.
    output_dir = output_root / f"report-{uuid.uuid4().hex[:16]}"
    output_dir.mkdir(parents=True, exist_ok=False)
    output_dir = output_dir.resolve()
    save_json(output_dir / "cover_info.json", cover)
    save_json(output_dir / "outline.json", outline)
    save_json(output_dir / "abstract.json", abstract)
    if references.get("references_html"):
        save_json(output_dir / "references.json", references)
    if final is not None and final["appendices"]:
        save_json(output_dir / "appendices.json", {"appendices": final["appendices"]})
    for row in chapters:
        save_json(output_dir / f"chapter_{row['num']}.json", row)

    env = os.environ.copy(); env["TECH_REPORT_OUTPUT_DIR"] = str(output_dir)
    py = sys.executable
    validations = [[py, str(SCRIPTS / "main.py"), "validate-cover"], [py, str(SCRIPTS / "main.py"), "validate-outline"], [py, str(SCRIPTS / "main.py"), "validate-abstract"]]
    validations += [[py, str(SCRIPTS / "main.py"), "validate-chapter", str(row["num"])] for row in chapters]
    if references.get("references_html"):
        validations.append([py, str(SCRIPTS / "main.py"), "validate-references"])
    if final is not None and final["appendices"]:
        validations.append([py, str(SCRIPTS / "main.py"), "validate-appendices"])
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
    if render_proc.returncode != 0 or render.get("success") is not True or catalog_qa.get("checked") is not True:
        visual_issues.append("渲染或目录实证检查失败：" + str(render.get("error", "目录未通过检查")))
        visual_status = "failed"
    if catalog_qa.get("checked") and catalog_qa.get("ok") is False:
        if catalog_qa.get("missing_main_catalog_entries"):
            visual_issues.append("主目录未显示完整标题及页码：" + "、".join(catalog_qa["missing_main_catalog_entries"][:5]))
        if catalog_qa.get("incorrect_catalog_pages"):
            visual_issues.append("目录页码缓存与实际分页不一致")
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
        "page_count": render.get("page_count", 0),
        "inspected_pages": supplied_visual.get("inspected_pages", []),
        "render_dir": render.get("render_dir", str(render_dir)),
        "pdf_path": render.get("pdf_path"),
        "png_paths": render.get("png_paths", []),
        "issues": visual_issues,
        "catalog_qa": catalog_qa,
    }
    page_count = visual["page_count"]
    inspected = visual["inspected_pages"]
    all_pages_inspected = (type(page_count) is int and page_count > 0
                           and isinstance(inspected, list) and len(inspected) == page_count
                           and all(type(page) is int and 1 <= page <= page_count for page in inspected)
                           and len(set(inspected)) == page_count)
    if visual["status"] == "passed" and not all_pages_inspected:
        visual["status"] = "failed"
        visual["issues"].append("逐页视觉检查记录必须恰好覆盖 1..page_count，不能缺页、重复或越界。")
    passed = bool(structural.get("valid")) and visual["status"] == "passed" and all_pages_inspected
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
