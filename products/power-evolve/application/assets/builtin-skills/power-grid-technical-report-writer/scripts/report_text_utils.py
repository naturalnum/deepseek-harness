#!/usr/bin/env python3
"""Deterministic text metrics and Markdown normalization helpers.

The functions in this module deliberately avoid model participation. They are used by
workflow gates and standalone scripts after report generation.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Iterable

CJK = r"\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
LONG_DASHES = "\u2012\u2013\u2014\u2015"
TARGET_KEYS = (
    "target_words",
    "planned_words",
    "word_budget",
    "target_length",
    "target_characters",
    "planned_characters",
)
TEXT_KEYS = ("chapter_text", "markdown", "body", "text", "content")


def content_to_text(value: Any) -> str:
    """Extract the main generated text from a common artifact/content shape."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in TEXT_KEYS:
            candidate = value.get(key)
            if isinstance(candidate, str):
                return candidate
        # Some integrations wrap the final file path instead of returning content.
        for key in ("file_path", "path", "markdown_path"):
            candidate = value.get(key)
            if isinstance(candidate, str):
                p = Path(candidate)
                if p.is_file():
                    return p.read_text(encoding="utf-8")
        return ""
    return ""


def _strip_nonprose_markdown(text: str) -> str:
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.S)
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"~~~.*?~~~", " ", text, flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    # Remove Markdown control symbols while preserving visible text.
    text = re.sub(r"^[ \t]{0,3}#{1,6}[ \t]+", "", text, flags=re.M)
    text = re.sub(r"^[ \t]*[-+*][ \t]+", "", text, flags=re.M)
    text = re.sub(r"^[ \t]*\d+[.)][ \t]+", "", text, flags=re.M)
    text = text.replace("`", "")
    return text


def effective_word_count(text: str) -> int:
    """Count Chinese characters plus Latin/number tokens.

    Chinese report plans commonly use “字数”. Each CJK character counts as one;
    each contiguous Latin/number token counts as one. Markdown syntax, URLs, HTML
    comments and fenced code blocks are excluded.
    """
    clean = _strip_nonprose_markdown(text)
    cjk_count = len(re.findall(fr"[{CJK}]", clean))
    non_cjk = re.sub(fr"[{CJK}]", " ", clean)
    token_count = len(re.findall(r"[A-Za-z0-9]+(?:[._/%+:~-][A-Za-z0-9]+)*", non_cjk))
    return cjk_count + token_count


def _coerce_positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    if isinstance(value, str):
        m = re.search(r"\d[\d,]*", value)
        if m:
            result = int(m.group(0).replace(",", ""))
            return result if result > 0 else None
    return None


def _find_target_in_mapping(mapping: dict[str, Any]) -> int | None:
    for key in TARGET_KEYS:
        if key in mapping:
            result = _coerce_positive_int(mapping[key])
            if result:
                return result
    content = mapping.get("content")
    if isinstance(content, dict):
        for key in TARGET_KEYS:
            if key in content:
                result = _coerce_positive_int(content[key])
                if result:
                    return result
    if isinstance(content, str):
        patterns = (
            r"(?:目标|计划|预计)(?:篇幅|字数|字符数)\s*[:：]?\s*(\d[\d,]*)",
            r"(?:篇幅|字数)预算\s*[:：]?\s*(\d[\d,]*)",
            r"target_words\s*[:=]\s*(\d[\d,]*)",
        )
        for pattern in patterns:
            m = re.search(pattern, content, flags=re.I)
            if m:
                return int(m.group(1).replace(",", ""))
    return None


def find_chapter_target_words(
    chapter_id: str,
    chapter_plan_artifact: dict[str, Any] | None,
    outline_artifact: dict[str, Any] | None,
) -> int | None:
    """Resolve the confirmed chapter target, preferring the chapter plan."""
    if chapter_plan_artifact:
        result = _find_target_in_mapping(chapter_plan_artifact)
        if result:
            return result

    if not outline_artifact:
        return None
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return None
    chapters = outline.get("chapters")
    if not isinstance(chapters, list):
        return None
    wanted = str(chapter_id)
    for chapter in chapters:
        if not isinstance(chapter, dict):
            continue
        cid = str(chapter.get("id") or chapter.get("chapter_id") or "")
        if cid == wanted:
            return _find_target_in_mapping(chapter)
    return None


def chapter_length_metrics(text: str, target_words: int, minimum_ratio: float = 0.8) -> dict[str, Any]:
    actual = effective_word_count(text)
    minimum = int(target_words * minimum_ratio + 0.999999)
    ratio = actual / target_words if target_words else 0.0
    return {
        "count_method": "cjk_characters_plus_latin_number_tokens",
        "actual_words": actual,
        "planned_target_words": int(target_words),
        "minimum_ratio": float(minimum_ratio),
        "minimum_required_words": minimum,
        "length_ratio": round(ratio, 4),
        "length_gate_passed": actual >= minimum,
        "shortfall_words": max(0, minimum - actual),
    }


def fixed_range_length_metrics(text: str, minimum_words: int, maximum_words: int, target_words: int | None = None) -> dict[str, Any]:
    """Count effective words and enforce an inclusive fixed range."""
    actual = effective_word_count(text)
    target = int(target_words if target_words else round((minimum_words + maximum_words) / 2))
    passed = int(minimum_words) <= actual <= int(maximum_words)
    return {
        "count_method": "cjk_characters_plus_latin_number_tokens",
        "actual_words": actual,
        "planned_target_words": target,
        "minimum_required_words": int(minimum_words),
        "maximum_allowed_words": int(maximum_words),
        "length_gate_passed": passed,
        "shortfall_words": max(0, int(minimum_words) - actual),
        "excess_words": max(0, actual - int(maximum_words)),
        "range_rule": "inclusive_fixed_range",
    }



def extract_chapter_summary_text(text: str) -> str:
    """Extract the final technical-chapter section titled 本章小结 from Markdown."""
    raw = text or ""
    heading = re.search(r"(?m)^\s*#{2,6}\s+(?:\d+(?:\.\d+)*\s*)?本章小结\s*$", raw)
    if not heading:
        return ""
    tail = raw[heading.end():]
    # 本章小结必须位于技术章末尾；如异常出现后续同级/更高标题，只取到该标题前。
    nxt = re.search(r"(?m)^\s*#{1,2}\s+.+$", tail)
    if nxt:
        tail = tail[:nxt.start()]
    return tail.strip()


SIMULATION_NOTICE_RE = re.compile(
    r"(?:^|\n)\s*(?:说明[:：]\s*)?[^\n]{0,80}(?:模拟生成|模拟数据|模型生成)[^\n]{0,120}(?:实际实验|实际结果|替换|实验设计|结果展示)[^\n]*\s*$",
    flags=re.M,
)


def simulation_chapter_end_notice_metrics(text: str) -> dict[str, Any]:
    """Check whether a single simulation notice appears at the very end of a chapter."""
    raw = (text or "").rstrip()
    matches = list(SIMULATION_NOTICE_RE.finditer(raw))
    if not matches:
        return {"notice_count": 0, "notice_at_chapter_end": False, "notice_gate_passed": False}
    last = matches[-1]
    tail = raw[last.end():].strip()
    return {
        "notice_count": len(matches),
        "notice_at_chapter_end": not bool(tail),
        "notice_gate_passed": len(matches) == 1 and not bool(tail),
        "notice_text": last.group(0).strip(),
    }


def _strip_simulation_notice_from_summary(summary: str) -> str:
    """Remove the single chapter-end simulation notice from summary word/paragraph metrics."""
    raw = (summary or "").rstrip()
    matches = list(SIMULATION_NOTICE_RE.finditer(raw))
    if matches and not raw[matches[-1].end():].strip():
        raw = raw[:matches[-1].start()].rstrip()
    return raw


def chapter_summary_metrics(text: str) -> dict[str, Any]:
    """Deterministically validate the 500–600字 总—分—总 chapter-summary structure."""
    summary = extract_chapter_summary_text(text)
    if not summary:
        return {
            "detected": False,
            "applicable": False,
            "summary_gate_passed": True,
            "reason": "chapter_summary_not_detected",
        }
    # 章末模拟数据统一说明不属于本章小结500—600字，也不参与三段结构统计。
    summary = _strip_simulation_notice_from_summary(summary)
    # Natural paragraphs: ignore empty lines, headings, list-only/control lines.
    paragraphs = []
    for block in re.split(r"\n\s*\n+", summary):
        clean = re.sub(r"(?m)^\s*#{1,6}\s+.*$", " ", block).strip()
        if clean:
            paragraphs.append(clean)
    total = effective_word_count(summary)
    if len(paragraphs) >= 3:
        opening = effective_word_count(paragraphs[0])
        ending = effective_word_count(paragraphs[-1])
        middle = sum(effective_word_count(p) for p in paragraphs[1:-1])
    else:
        opening = effective_word_count(paragraphs[0]) if paragraphs else 0
        middle = 0
        ending = effective_word_count(paragraphs[-1]) if len(paragraphs) >= 2 else 0
    total_ok = 500 <= total <= 600
    opening_ok = 100 <= opening <= 150
    # “约300字”留适度弹性，避免因结果丰富导致机械压缩。
    middle_ok = 260 <= middle <= 340
    # 默认100–150；实验结果丰富时允许结尾适度扩到180，但总字数仍不得超过600。
    ending_ok = 100 <= ending <= 180
    structure_ok = len(paragraphs) >= 3
    # v1.1.29: quotation marks in chapter-summary BODY are a style signal, not a hard gate.
    # Count paired/standalone quote-like punctuation after headings have been stripped from the summary.
    summary_body_for_quotes = re.sub(r"(?m)^\s*#{1,6}\s+.*$", " ", summary)
    unnecessary_quote_mark_count = sum(summary_body_for_quotes.count(ch) for ch in "“”\"'《》「」『』")
    return {
        "detected": True,
        "applicable": True,
        "paragraph_count": len(paragraphs),
        "actual_words": total,
        "minimum_words": 500,
        "maximum_words": 600,
        "opening_words": opening,
        "opening_range": [100, 150],
        "middle_words": middle,
        "middle_target_range": [260, 340],
        "ending_words": ending,
        "ending_default_range": [100, 150],
        "ending_extended_max_for_rich_experiments": 180,
        "total_gate_passed": total_ok,
        "opening_gate_passed": opening_ok,
        "middle_gate_passed": middle_ok,
        "ending_gate_passed": ending_ok,
        "structure_gate_passed": structure_ok,
        "unnecessary_quote_mark_count": unnecessary_quote_mark_count,
        "quote_style_preference_passed": unnecessary_quote_mark_count == 0,
        "summary_gate_passed": total_ok and opening_ok and middle_ok and ending_ok and structure_ok,
        "count_method": "cjk_characters_plus_latin_number_tokens",
    }

def heading_bridge_metrics(
    text: str,
    *,
    mode: str = "short_50_100",
    short_min: int = 50,
    short_max: int = 100,
) -> dict[str, Any]:
    """Measure unheaded prose between the first H1 and the first following H2.

    Supports Markdown and simple HTML chapter payloads.  Technical chapters use
    mode ``technical_chapter_intro``: they only need to prove that H1/H2 are not
    adjacent here because their separate chapter-introduction rule is much longer.
    ``not_applicable`` is used for chapters without H2 (for example the final
    conclusion chapter).
    """
    if mode == "not_applicable":
        return {
            "mode": mode,
            "applicable": False,
            "detected": True,
            "bridge_words": 0,
            "bridge_gate_passed": True,
            "minimum_required_words": 0,
            "maximum_allowed_words": None,
        }

    raw = text or ""
    segment = None
    detected = False
    has_h2 = False

    # Markdown first.
    h1 = re.search(r"(?m)^\s*#(?!#)\s+.+$", raw)
    if h1:
        h2 = re.search(r"(?m)^\s*##(?!#)\s+.+$", raw[h1.end():])
        if h2:
            has_h2 = True
            segment = raw[h1.end():h1.end()+h2.start()]
            detected = True
        else:
            detected = True
    else:
        # Simple HTML payload support.
        h1_html = re.search(r"<h1\b[^>]*>.*?</h1>", raw, flags=re.I | re.S)
        if h1_html:
            h2_html = re.search(r"<h2\b[^>]*>.*?</h2>", raw[h1_html.end():], flags=re.I | re.S)
            if h2_html:
                has_h2 = True
                segment = raw[h1_html.end():h1_html.end()+h2_html.start()]
                detected = True
            else:
                detected = True

    if detected and not has_h2:
        return {
            "mode": "not_applicable",
            "applicable": False,
            "detected": True,
            "bridge_words": 0,
            "bridge_gate_passed": True,
            "minimum_required_words": 0,
            "maximum_allowed_words": None,
        }

    if not detected or segment is None:
        return {
            "mode": mode,
            "applicable": True,
            "detected": False,
            "bridge_words": 0,
            "bridge_gate_passed": False,
            "minimum_required_words": int(short_min),
            "maximum_allowed_words": int(short_max) if mode == "short_50_100" else None,
            "reason": "unable_to_locate_h1_h2_boundary",
        }

    # Remove headings/HTML/control markup before counting actual bridge prose.
    clean = re.sub(r"<[^>]+>", " ", segment)
    clean = re.sub(r"(?m)^\s*#{1,6}\s+.*$", " ", clean)
    words = effective_word_count(clean)
    maximum = int(short_max) if mode == "short_50_100" else None
    passed = words >= int(short_min) and (maximum is None or words <= maximum)
    return {
        "mode": mode,
        "applicable": True,
        "detected": True,
        "bridge_words": words,
        "bridge_gate_passed": passed,
        "minimum_required_words": int(short_min),
        "maximum_allowed_words": maximum,
        "shortfall_words": max(0, int(short_min) - words),
        "excess_words": max(0, words - maximum) if maximum is not None else 0,
    }

def iter_outline_headings(outline_artifact: dict[str, Any]) -> Iterable[dict[str, Any]]:
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return []
    rows: list[dict[str, Any]] = []
    for chapter in outline.get("chapters", []) or []:
        if not isinstance(chapter, dict):
            continue
        chapter_role = str(chapter.get("task_role") or "")
        rows.append({
            "chapter_id": str(chapter.get("id") or chapter.get("chapter_id") or ""),
            "number": str(chapter.get("id") or chapter.get("chapter_id") or ""),
            "level": 1,
            "title": str(chapter.get("title") or ""),
            "task_role": chapter_role,
            "heading_kind": "chapter",
            "technical_signature": "",
            "allow_long_title": bool(chapter.get("allow_long_title")),
            "title_length_rationale": chapter.get("title_length_rationale"),
        })
        for heading in chapter.get("section_outline", []) or []:
            if not isinstance(heading, dict) or int(heading.get("level") or 0) == 1:
                continue
            rows.append({
                "chapter_id": str(chapter.get("id") or chapter.get("chapter_id") or ""),
                "number": str(heading.get("number") or ""),
                "level": int(heading.get("level") or 0),
                "title": str(heading.get("title") or ""),
                "task_role": chapter_role,
                "heading_kind": str(heading.get("heading_kind") or ""),
                "technical_signature": str(heading.get("technical_signature") or ""),
                "allow_long_title": bool(heading.get("allow_long_title")),
                "title_length_rationale": heading.get("title_length_rationale"),
            })
    return rows


def visible_title_length(title: str) -> int:
    return len(re.sub(r"\s+", "", title.strip()))


STRONG_POWER_DOMAIN_TERMS = {
    "电力", "电网", "配电", "配电网", "输电", "变电", "变压器", "调度", "潮流", "线路", "机组",
    "新能源", "储能", "电压", "有功", "无功", "功率", "继电保护", "运行方式", "安全边界", "调控",
    "调峰", "调频", "供电", "台区", "变电站", "运检",
}

EVALUATION_HEADING_TERMS = {"验证", "评估", "评价", "测评", "评测", "验收", "测试", "试验", "实验"}


def heading_has_evaluation_term(title: str) -> bool:
    raw = re.sub(r"\s+", "", str(title or ""))
    return any(term in raw for term in EVALUATION_HEADING_TERMS)


def title_has_power_domain_signal(title: str) -> bool:
    raw = re.sub(r"\s+", "", str(title or ""))
    return any(term in raw for term in STRONG_POWER_DOMAIN_TERMS)


def outline_power_domain_visibility_violations(outline_artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """Require every technical-research L2/L3 technical heading to expose power context itself."""
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return []
    violations: list[dict[str, Any]] = []
    for chapter in outline.get("chapters", []) or []:
        if not isinstance(chapter, dict) or str(chapter.get("task_role") or "") != "technical-research":
            continue
        cid = str(chapter.get("id") or chapter.get("chapter_id") or "")
        for heading in chapter.get("section_outline", []) or []:
            if not isinstance(heading, dict):
                continue
            level = int(heading.get("level") or 0)
            kind = str(heading.get("heading_kind") or "")
            if not ((level == 2 and kind == "innovation") or (level == 3 and kind == "technical")):
                continue
            title = str(heading.get("title") or "")
            if title_has_power_domain_signal(title):
                continue
            violations.append({
                "chapter_id": cid,
                "number": str(heading.get("number") or ""),
                "level": level,
                "title": title,
                "heading_kind": kind,
            })
    return violations


LATIN_TECH_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+_.-]*")


def outline_chinese_technology_heading_violations(outline_artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """Reject raw English technology names/acronyms in technical L2/L3 headings.

    Original English names may remain in metadata; formal outline titles and title-visible
    technical_signature values use route-semantic Chinese expressions.
    """
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return []
    violations: list[dict[str, Any]] = []
    for chapter in outline.get("chapters", []) or []:
        if not isinstance(chapter, dict) or str(chapter.get("task_role") or "") != "technical-research":
            continue
        cid = str(chapter.get("id") or chapter.get("chapter_id") or "")
        for heading in chapter.get("section_outline", []) or []:
            if not isinstance(heading, dict):
                continue
            level = int(heading.get("level") or 0)
            kind = str(heading.get("heading_kind") or "")
            if not ((level == 2 and kind == "innovation") or (level == 3 and kind == "technical")):
                continue
            title = str(heading.get("title") or "")
            signature = str(heading.get("technical_signature") or "")
            title_tokens = LATIN_TECH_TOKEN_RE.findall(title)
            signature_tokens = LATIN_TECH_TOKEN_RE.findall(signature)
            if not title_tokens and not signature_tokens:
                continue
            violations.append({
                "chapter_id": cid,
                "number": str(heading.get("number") or ""),
                "level": level,
                "title": title,
                "technical_signature": signature,
                "title_tokens": title_tokens,
                "signature_tokens": signature_tokens,
            })
    return violations


def is_based_on_heading_style(title: str) -> bool:
    raw = re.sub(r"\s+", "", str(title or ""))
    return bool(re.match(r"^基于.{2,40}的.+", raw))


def _technical_heading_subject(title: str, technical_signature: str = "") -> str:
    raw = re.sub(r"\s+", "", str(title or "")).strip("：:，,。；;、")
    m = re.match(r"^基于.{2,80}?的(.+)$", raw)
    if m:
        return m.group(1).strip("：:，,。；;、")
    sig = re.sub(r"\s+", "", str(technical_signature or ""))
    if sig and sig in raw:
        raw = raw.replace(sig, "", 1)
    return raw.strip("：:，,。；;、")


def _normalized_level3_task_subject(subject: str) -> str:
    t = re.sub(r"[\s_\-—–/：:，,。；;、()（）]+", "", str(subject or "")).lower()
    for landing in ("方法", "技术", "算法", "模型"):
        if t.endswith(landing):
            t = t[: -len(landing)]
            break
    return t


def _task_subject_duplicate(a: str, b: str) -> bool:
    from difflib import SequenceMatcher
    na, nb = _normalized_level3_task_subject(a), _normalized_level3_task_subject(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    shorter, longer = sorted((na, nb), key=len)
    if len(shorter) >= 6 and shorter in longer and len(shorter) / max(len(longer), 1) >= 0.85:
        return True
    return min(len(na), len(nb)) >= 8 and SequenceMatcher(None, na, nb).ratio() >= 0.90


def outline_level2_subject_power_violations(outline_artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """Require every substantive L2 task subject in technical chapters to carry power semantics.

    Chapter-summary headings are the only structural exception. For 基于X的Y, Y is
    the subject. For a direct-composite heading, remove the visible technical_signature
    once and validate the remaining task subject.
    """
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return []
    violations: list[dict[str, Any]] = []
    for chapter in outline.get("chapters", []) or []:
        if not isinstance(chapter, dict) or str(chapter.get("task_role") or "") not in {"technical-research", "engineering-implementation"}:
            continue
        cid = str(chapter.get("id") or chapter.get("chapter_id") or "")
        for heading in chapter.get("section_outline", []) or []:
            if not isinstance(heading, dict):
                continue
            if int(heading.get("level") or 0) != 2:
                continue
            title = str(heading.get("title") or "")
            if title.strip() in {"本章小结", "小结"}:
                continue
            signature = str(heading.get("technical_signature") or "")
            subject = _technical_heading_subject(title, signature)
            if title_has_power_domain_signal(subject):
                continue
            violations.append({
                "chapter_id": cid,
                "number": str(heading.get("number") or ""),
                "title": title,
                "task_subject": subject,
            })
    return violations


def outline_evaluation_heading_violations(outline_artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """Forbid evaluation/validation/testing-like L2/L3 headings for non-evaluation themes."""
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return []
    theme = str(outline.get("report_theme_type") or "")
    if theme == "evaluation-related":
        return []
    violations: list[dict[str, Any]] = []
    for chapter in outline.get("chapters", []) or []:
        if not isinstance(chapter, dict) or str(chapter.get("task_role") or "") not in {"technical-research", "engineering-implementation"}:
            continue
        cid = str(chapter.get("id") or chapter.get("chapter_id") or "")
        if str(chapter.get("standalone_validation_mode") or "none") != "none":
            violations.append({
                "chapter_id": cid, "number": "", "level": 2, "title": "",
                "problem": "standalone_validation_mode_not_none",
            })
        for heading in chapter.get("section_outline", []) or []:
            if not isinstance(heading, dict):
                continue
            level = int(heading.get("level") or 0)
            if level not in {2, 3}:
                continue
            title = str(heading.get("title") or "")
            if title.strip() in {"本章小结", "小结"} or not heading_has_evaluation_term(title):
                continue
            violations.append({
                "chapter_id": cid,
                "number": str(heading.get("number") or ""),
                "level": level,
                "title": title,
                "problem": "evaluation_like_heading_in_non_evaluation_report",
            })
    if theme not in {"evaluation-related", "non-evaluation"}:
        violations.insert(0, {
            "chapter_id": "", "number": "", "level": 0, "title": "",
            "problem": "report_theme_type_missing_or_invalid",
        })
    return violations


def outline_heading_ending_distribution_violations(outline_artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """Target approximately 40% 技术 endings and 60% 方法 endings for technical-research L2/L3 headings."""
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return []
    violations: list[dict[str, Any]] = []
    report_total = report_tech = report_method = 0
    for chapter in outline.get("chapters", []) or []:
        if not isinstance(chapter, dict) or str(chapter.get("task_role") or "") != "technical-research":
            continue
        eligible = []
        for heading in chapter.get("section_outline", []) or []:
            if not isinstance(heading, dict):
                continue
            level = int(heading.get("level") or 0)
            kind = str(heading.get("heading_kind") or "")
            if (level == 2 and kind == "innovation") or (level == 3 and kind == "technical"):
                eligible.append(heading)
        if not eligible:
            continue
        invalid = [h for h in eligible if not str(h.get("title") or "").endswith(("技术", "方法"))]
        for h in invalid:
            violations.append({
                "scope": "heading", "chapter_id": str(chapter.get("id") or chapter.get("chapter_id") or ""),
                "number": str(h.get("number") or ""), "title": str(h.get("title") or ""),
                "problem": "invalid_landing_word",
            })
        tech = sum(str(h.get("title") or "").endswith("技术") for h in eligible)
        method = sum(str(h.get("title") or "").endswith("方法") for h in eligible)
        total = len(eligible)
        expected_tech = math.floor(0.40 * total + 0.5)
        expected_method = total - expected_tech
        report_total += total; report_tech += tech; report_method += method
        if tech != expected_tech or method != expected_method:
            violations.append({
                "scope": "chapter", "chapter_id": str(chapter.get("id") or chapter.get("chapter_id") or ""),
                "total_count": total, "technology_count": tech, "method_count": method,
                "expected_technology_count": expected_tech, "expected_method_count": expected_method,
                "problem": "ending_distribution_mismatch",
            })
    if report_total:
        ratio = report_tech / report_total
        if ratio < 0.35 - 1e-9 or ratio > 0.45 + 1e-9:
            violations.append({
                "scope": "report", "chapter_id": "", "total_count": report_total,
                "technology_count": report_tech, "method_count": report_method,
                "technology_ratio": ratio, "problem": "report_technology_ending_ratio_out_of_range",
            })
    return violations


def outline_heading_source_term_violations(outline_artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate task-book key technical term placement: broad→L2, narrow→L3, visibly present."""
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return []
    task_book_scope = str(outline.get("task_book_scope") or "")
    violations: list[dict[str, Any]] = []
    for chapter in outline.get("chapters", []) or []:
        if not isinstance(chapter, dict) or str(chapter.get("task_role") or "") not in {"technical-research", "engineering-implementation"}:
            continue
        cid = str(chapter.get("id") or chapter.get("chapter_id") or "")
        expected_ids = {str(x) for x in (chapter.get("expected_goal_item_ids") or [])}
        schedule_ids = {str(x) for x in (chapter.get("schedule_technology_item_ids") or [])}
        assessment_ids = {str(x) for x in (chapter.get("assessment_requirement_item_ids") or [])}
        required = {"expected-output": expected_ids, "schedule-plan": schedule_ids, "assessment-requirement": assessment_ids}
        plan = chapter.get("heading_source_term_plan") or []
        if task_book_scope != "not_applicable" and any(required.values()) and not plan:
            violations.append({"chapter_id": cid, "problem": "heading_source_term_plan_missing"})
            continue
        heading_map = {str(h.get("number") or ""): h for h in (chapter.get("section_outline") or []) if isinstance(h, dict)}
        covered = {key: set() for key in required}
        branches: set[str] = set()
        for row in plan:
            if not isinstance(row, dict):
                violations.append({"chapter_id": cid, "problem": "invalid_heading_source_term_plan_item"}); continue
            st = str(row.get("source_type") or ""); sid = str(row.get("source_item_id") or "")
            term = str(row.get("term") or ""); gran = str(row.get("granularity") or "")
            target_num = str(row.get("target_heading_number") or "")
            if st not in required:
                violations.append({"chapter_id": cid, "source_item_id": sid, "term": term, "problem": "invalid_source_type"}); continue
            covered[st].add(sid)
            target = heading_map.get(target_num)
            if target is None:
                violations.append({"chapter_id": cid, "source_item_id": sid, "term": term, "target_heading_number": target_num, "problem": "target_heading_missing"}); continue
            level = int(target.get("level") or 0)
            if (gran == "broad" and level != 2) or (gran == "narrow" and level != 3) or gran not in {"broad", "narrow"}:
                violations.append({"chapter_id": cid, "source_item_id": sid, "term": term, "target_heading_number": target_num, "problem": "granularity_level_mismatch"})
            if re.sub(r"\s+", "", term) not in re.sub(r"\s+", "", str(target.get("title") or "")):
                violations.append({"chapter_id": cid, "source_item_id": sid, "term": term, "target_heading_number": target_num, "problem": "term_not_visible_in_target_heading"})
            m = re.match(rf"^({re.escape(cid)}\.\d+)(?:\.|$)", target_num)
            if m: branches.add(m.group(1))
        for st, ids in required.items():
            for missing in sorted(ids - covered[st]):
                violations.append({"chapter_id": cid, "source_item_id": missing, "source_type": st, "problem": "source_item_not_mapped_to_heading_term"})
        if len(plan) >= 3 and len(branches) < 2:
            violations.append({"chapter_id": cid, "problem": "heading_source_terms_not_distributed"})
    return violations



def outline_technology_option_violations(outline_artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate optional technology sets generated alongside technical outline headings.

    Each core L2 innovation heading needs one option set. If the source has not uniquely
    locked a route, the set carries 2-3 genuinely distinct candidates and exactly one
    recommendation. Source-locked sections may carry one source-confirmed candidate.
    Candidate metadata is companion information only and never counts as a formal heading.
    """
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return []
    violations: list[dict[str, Any]] = []
    for chapter in outline.get("chapters", []) or []:
        if not isinstance(chapter, dict) or str(chapter.get("task_role") or "") != "technical-research":
            continue
        cid = str(chapter.get("id") or chapter.get("chapter_id") or "")
        core_numbers = {
            str(h.get("number") or "")
            for h in chapter.get("section_outline", []) or []
            if isinstance(h, dict)
            and int(h.get("level") or 0) == 2
            and str(h.get("heading_kind") or "") == "innovation"
        }
        sets = chapter.get("technology_option_sets")
        if not isinstance(sets, list):
            violations.append({"chapter_id": cid, "problem": "technology_option_sets_missing"})
            continue
        by_section: dict[str, dict[str, Any]] = {}
        for row in sets:
            if not isinstance(row, dict):
                violations.append({"chapter_id": cid, "problem": "invalid_technology_option_set"})
                continue
            section = str(row.get("section_number") or "").strip()
            if not section:
                violations.append({"chapter_id": cid, "problem": "technology_option_section_missing"})
                continue
            if section in by_section:
                violations.append({"chapter_id": cid, "section_number": section, "problem": "duplicate_technology_option_set"})
                continue
            by_section[section] = row
            if section not in core_numbers and not re.match(rf"^{re.escape(cid)}\.\d+\.\d+$", section):
                violations.append({"chapter_id": cid, "section_number": section, "problem": "technology_option_target_not_core_or_level3"})

            problem_or_role = str(row.get("problem_or_role") or "").strip()
            if not problem_or_role:
                violations.append({"chapter_id": cid, "section_number": section, "problem": "technology_option_problem_or_role_missing"})
            source_locked = row.get("source_locked")
            if not isinstance(source_locked, bool):
                violations.append({"chapter_id": cid, "section_number": section, "problem": "technology_option_source_locked_invalid"})
                source_locked = False
            candidates = row.get("candidates")
            if not isinstance(candidates, list):
                violations.append({"chapter_id": cid, "section_number": section, "problem": "technology_candidates_missing"})
                continue
            if source_locked:
                if len(candidates) != 1:
                    violations.append({"chapter_id": cid, "section_number": section, "candidate_count": len(candidates), "problem": "source_locked_option_must_have_one_candidate"})
            elif len(candidates) < 2 or len(candidates) > 3:
                violations.append({"chapter_id": cid, "section_number": section, "candidate_count": len(candidates), "problem": "unlocked_option_requires_two_or_three_candidates"})

            candidate_ids: list[str] = []
            signatures: list[str] = []
            recommended_ids: list[str] = []
            for idx, cand in enumerate(candidates, 1):
                if not isinstance(cand, dict):
                    violations.append({"chapter_id": cid, "section_number": section, "candidate_index": idx, "problem": "invalid_technology_candidate"})
                    continue
                candidate_id = str(cand.get("candidate_id") or "").strip()
                technology_name = str(cand.get("technology_name") or "").strip()
                signature = str(cand.get("technical_signature_cn") or "").strip()
                mechanisms = cand.get("key_mechanisms")
                fit_reason = str(cand.get("fit_reason") or "").strip()
                origin = str(cand.get("origin") or "").strip()
                if not candidate_id or not technology_name or not signature or not fit_reason:
                    violations.append({"chapter_id": cid, "section_number": section, "candidate_index": idx, "problem": "technology_candidate_required_metadata_missing"})
                if not isinstance(mechanisms, list) or not (1 <= len([x for x in mechanisms if str(x or "").strip()]) <= 3):
                    violations.append({"chapter_id": cid, "section_number": section, "candidate_index": idx, "problem": "technology_candidate_key_mechanisms_invalid"})
                if origin not in {"source_confirmed", "model_suggested", "user_confirmed_design"}:
                    violations.append({"chapter_id": cid, "section_number": section, "candidate_index": idx, "problem": "technology_candidate_origin_invalid"})
                if source_locked and origin != "source_confirmed":
                    violations.append({"chapter_id": cid, "section_number": section, "candidate_index": idx, "problem": "source_locked_candidate_must_be_source_confirmed"})
                if LATIN_TECH_TOKEN_RE.search(signature):
                    violations.append({"chapter_id": cid, "section_number": section, "candidate_index": idx, "problem": "technology_candidate_signature_must_be_chinese"})
                if candidate_id:
                    candidate_ids.append(candidate_id)
                if signature:
                    signatures.append(re.sub(r"\s+", "", signature))
                if cand.get("recommended") is True and candidate_id:
                    recommended_ids.append(candidate_id)
            if len(candidate_ids) != len(set(candidate_ids)):
                violations.append({"chapter_id": cid, "section_number": section, "problem": "technology_candidate_ids_not_unique"})
            if not source_locked and len(signatures) != len(set(signatures)):
                violations.append({"chapter_id": cid, "section_number": section, "problem": "technology_candidates_not_distinct"})
            if len(recommended_ids) != 1:
                violations.append({"chapter_id": cid, "section_number": section, "problem": "technology_option_requires_exactly_one_recommended_candidate"})
            declared_recommended = str(row.get("recommended_candidate_id") or "").strip()
            if declared_recommended and declared_recommended not in candidate_ids:
                violations.append({"chapter_id": cid, "section_number": section, "problem": "recommended_candidate_id_not_found"})
            if recommended_ids and declared_recommended and recommended_ids[0] != declared_recommended:
                violations.append({"chapter_id": cid, "section_number": section, "problem": "recommended_candidate_id_mismatch"})
            selected = str(row.get("selected_candidate_id") or "").strip()
            if selected and selected not in candidate_ids:
                violations.append({"chapter_id": cid, "section_number": section, "problem": "selected_candidate_id_not_found"})
            status = str(row.get("selection_status") or "").strip()
            if not status:
                violations.append({"chapter_id": cid, "section_number": section, "problem": "technology_option_selection_status_missing"})

        for missing in sorted(core_numbers - set(by_section)):
            violations.append({"chapter_id": cid, "section_number": missing, "problem": "core_heading_missing_technology_option_set"})
    return violations

def outline_level3_task_subject_violations(outline_artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """Reject repeated L3 technical task subjects within the same technical-research chapter."""
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return []
    violations: list[dict[str, Any]] = []
    for chapter in outline.get("chapters", []) or []:
        if not isinstance(chapter, dict) or str(chapter.get("task_role") or "") != "technical-research":
            continue
        cid = str(chapter.get("id") or chapter.get("chapter_id") or "")
        seen: list[dict[str, str]] = []
        for heading in chapter.get("section_outline", []) or []:
            if not isinstance(heading, dict):
                continue
            if int(heading.get("level") or 0) != 3 or str(heading.get("heading_kind") or "") != "technical":
                continue
            title = str(heading.get("title") or "")
            signature = str(heading.get("technical_signature") or "")
            subject = _technical_heading_subject(title, signature)
            if not subject:
                continue
            duplicate = next((row for row in seen if _task_subject_duplicate(subject, row["subject"])), None)
            if duplicate:
                violations.append({
                    "chapter_id": cid,
                    "number": str(heading.get("number") or ""),
                    "title": title,
                    "task_subject": subject,
                    "duplicate_of_number": duplicate["number"],
                    "duplicate_of_title": duplicate["title"],
                    "duplicate_of_subject": duplicate["subject"],
                })
            else:
                seen.append({"number": str(heading.get("number") or ""), "title": title, "subject": subject})
    return violations


def outline_based_on_ratio_violations(
    outline_artifact: dict[str, Any],
    minimum_ratio: float = 0.40,
    maximum_ratio: float = 0.60,
) -> list[dict[str, Any]]:
    """Check the required `基于……的……` ratio per technical chapter and globally.

    Only technical-research level-2 innovation headings and level-3 technical headings
    are counted, matching the generator's deterministic outline validator.
    """
    outline = outline_artifact.get("content", outline_artifact)
    if not isinstance(outline, dict):
        return []
    violations: list[dict[str, Any]] = []
    total = 0
    based = 0
    for chapter in outline.get("chapters", []) or []:
        if not isinstance(chapter, dict) or str(chapter.get("task_role") or "") != "technical-research":
            continue
        eligible = []
        for heading in chapter.get("section_outline", []) or []:
            if not isinstance(heading, dict):
                continue
            level = int(heading.get("level") or 0)
            kind = str(heading.get("heading_kind") or "")
            if (level == 2 and kind == "innovation") or (level == 3 and kind == "technical"):
                eligible.append(heading)
        if not eligible:
            continue
        chapter_based = sum(is_based_on_heading_style(str(h.get("title") or "")) for h in eligible)
        chapter_total = len(eligible)
        ratio = chapter_based / chapter_total
        total += chapter_total
        based += chapter_based
        if ratio < minimum_ratio - 1e-9 or ratio > maximum_ratio + 1e-9:
            violations.append({
                "scope": "chapter",
                "chapter_id": str(chapter.get("id") or chapter.get("chapter_id") or ""),
                "based_count": chapter_based,
                "total_count": chapter_total,
                "ratio": ratio,
                "minimum_ratio": minimum_ratio,
                "maximum_ratio": maximum_ratio,
            })
    if total:
        ratio = based / total
        if ratio < minimum_ratio - 1e-9 or ratio > maximum_ratio + 1e-9:
            violations.append({
                "scope": "report",
                "chapter_id": "",
                "based_count": based,
                "total_count": total,
                "ratio": ratio,
                "minimum_ratio": minimum_ratio,
                "maximum_ratio": maximum_ratio,
            })
    return violations


def outline_title_violations(outline_artifact: dict[str, Any], max_chars: int = 25) -> list[dict[str, Any]]:
    violations: list[dict[str, Any]] = []
    for heading in iter_outline_headings(outline_artifact):
        length = visible_title_length(heading["title"])
        if length <= max_chars:
            continue
        if heading.get("allow_long_title") and heading.get("title_length_rationale"):
            continue
        # Technical L2/L3 headings may exceed the 25-character guideline when the extra
        # length is needed to keep a concrete technical signature visible and to satisfy
        # the required 40%–60% `基于……的……` distribution. The generator's own outline
        # validator still reports length as a warning, but the orchestrator must not
        # force a rewrite that would weaken technical specificity.
        is_signature_heading = (
            heading.get("task_role") == "technical-research"
            and heading.get("level") in {2, 3}
            and heading.get("heading_kind") in {"innovation", "technical"}
            and bool(str(heading.get("technical_signature") or "").strip())
        )
        if is_signature_heading:
            continue
        violations.append({**heading, "title_length": length, "max_title_chars": max_chars})
    return violations


def _normalize_noncode_segment(segment: str, dash_target: str, remove_digit_cjk_spaces: bool) -> tuple[str, int, int]:
    dash_count = sum(segment.count(ch) for ch in LONG_DASHES)
    if dash_count:
        segment = re.sub(f"[{LONG_DASHES}]", dash_target, segment)
    space_count = 0
    if remove_digit_cjk_spaces:
        p1 = re.compile(fr"(?<=[0-9])[^\S\r\n]+(?=[{CJK}])")
        p2 = re.compile(fr"(?<=[{CJK}])[^\S\r\n]+(?=[0-9])")
        space_count += len(p1.findall(segment)) + len(p2.findall(segment))
        segment = p1.sub("", segment)
        segment = p2.sub("", segment)
    return segment, dash_count, space_count


def normalize_markdown_text(
    text: str,
    dash_style: str = "hyphen",
    remove_digit_cjk_spaces: bool = True,
) -> tuple[str, dict[str, Any]]:
    """Normalize prose outside fenced and inline code.

    dash_style is configurable because both ASCII hyphen and Chinese em dash are
    valid house-style choices. The suite default is ``hyphen``.
    """
    if dash_style not in {"hyphen", "em-dash"}:
        raise ValueError("dash_style must be 'hyphen' or 'em-dash'")
    dash_target = "-" if dash_style == "hyphen" else "—"
    out: list[str] = []
    in_fence = False
    fence_marker = ""
    dash_total = 0
    space_total = 0

    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
                fence_marker = ""
            out.append(line)
            continue
        if in_fence:
            out.append(line)
            continue

        # Preserve inline code spans and normalize only prose fragments.
        parts = re.split(r"(`[^`\n]*`)", line)
        for index, part in enumerate(parts):
            if index % 2 == 1:
                out.append(part)
                continue
            normalized, dash_count, space_count = _normalize_noncode_segment(
                part, dash_target, remove_digit_cjk_spaces
            )
            out.append(normalized)
            dash_total += dash_count
            space_total += space_count

    normalized_text = "".join(out)
    return normalized_text, {
        "dash_style": dash_style,
        "dash_replacements": dash_total,
        "digit_cjk_space_removals": space_total,
        "changed": normalized_text != text,
    }


def normalize_markdown_file(
    input_path: Path,
    output_path: Path | None = None,
    *,
    dash_style: str = "hyphen",
    remove_digit_cjk_spaces: bool = True,
) -> dict[str, Any]:
    text = input_path.read_text(encoding="utf-8")
    normalized, stats = normalize_markdown_text(text, dash_style, remove_digit_cjk_spaces)
    destination = output_path or input_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(normalized, encoding="utf-8")
    return {**stats, "input": str(input_path), "output": str(destination)}


def json_dump(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)

ABSTRACT_ORDERING_SEQUENCES = (
    ("第一", "第二", "第三"),
    ("首先", "其次", "再次"),
)


def split_abstract_paragraphs(text: str) -> list[str]:
    """Split a generated abstract body into natural paragraphs.

    Blank-line separated paragraphs are preferred. If the generator emitted exactly
    three non-empty lines without blank lines, those lines are accepted as the three
    paragraphs. Headings and keyword lines are not expected in ``abstract_cn``.
    """
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", normalized) if p.strip()]
    if len(paragraphs) == 1:
        lines = [line.strip() for line in normalized.split("\n") if line.strip()]
        if len(lines) == 3:
            paragraphs = lines
    return paragraphs


def _ordering_sequence(text: str) -> list[str] | None:
    for sequence in ABSTRACT_ORDERING_SEQUENCES:
        positions = [text.find(marker) for marker in sequence]
        if all(pos >= 0 for pos in positions) and positions == sorted(positions):
            return list(sequence)
    return None


def _normalize_abstract_sentence(text: str) -> str:
    return re.sub(r"\s+", "", str(text or "")).strip("。！？!?；; \t\r\n")


def first_full_sentence(text: str) -> str:
    """Return the first complete Chinese/English sentence without terminal punctuation."""
    raw = str(text or "").strip()
    if not raw:
        return ""
    m = re.search(r"[。！？!?]", raw)
    return raw[: m.start()].strip() if m else raw.strip()


def abstract_quality_metrics(
    content: Any,
    *,
    total_min: int = 700,
    total_max: int = 800,
    paragraph_1_min: int = 200,
    paragraph_1_max: int = 250,
    paragraph_2_min: int = 300,
    paragraph_2_max: int = 350,
    require_bilingual: bool = True,
    require_ordering: bool = True,
    require_opening_candidates: bool = True,
    opening_candidate_min: int = 3,
    opening_candidate_max: int = 5,
    max_supplementary_metrics: int = 2,
    require_assessment_result_metadata: bool = True,
) -> dict[str, Any]:
    """Return deterministic length/shape/evidence metrics for the bilingual abstract artifact.

    v1.1.30 adds three non-prose metadata gates:
    - 3-5 business-need opening-sentence candidates and one selected first sentence;
    - task-book assessment result coverage with explicit quantitative/qualitative kind;
    - at most two non-task-book supplementary result metrics.

    The function intentionally does not infer whether every task-book item is present; that
    semantic completeness remains grounded in ``abstract_evidence``/Reviewer. It does ensure
    that every supplied qualitative or mixed item has a real result statement rather than an
    empty requirement echo.
    """
    if not isinstance(content, dict):
        return {
            "valid": False,
            "errors": ["摘要产物 content 必须为对象，并包含摘要正文、首句候选、考核结果覆盖和补充指标字段"],
            "paragraph_count": 0,
        }

    cn = str(content.get("abstract_cn") or "").strip()
    en = str(content.get("abstract_en") or "").strip()
    kw_cn = str(content.get("keywords_cn") or "").strip()
    kw_en = str(content.get("keywords_en") or "").strip()
    paragraphs = split_abstract_paragraphs(cn)
    counts = [effective_word_count(p) for p in paragraphs]
    total = effective_word_count(cn)
    p1 = counts[0] if len(counts) > 0 else 0
    p2 = counts[1] if len(counts) > 1 else 0
    p3 = counts[2] if len(counts) > 2 else 0
    p1_order = _ordering_sequence(paragraphs[0]) if len(paragraphs) > 0 else None
    p2_order = _ordering_sequence(paragraphs[1]) if len(paragraphs) > 1 else None

    opening_candidates = content.get("opening_sentence_candidates_cn")
    selected_opening = str(content.get("selected_opening_sentence_cn") or "").strip()
    assessment_rows = content.get("assessment_result_coverage")
    supplementary = content.get("supplementary_metrics_used")

    errors: list[str] = []
    if len(paragraphs) != 3:
        errors.append(f"中文摘要必须恰好为3个自然段，当前为{len(paragraphs)}段")
    if not (total_min <= total <= total_max):
        errors.append(f"中文摘要总有效字数必须为{total_min}—{total_max}字，当前为{total}字")
    if not (paragraph_1_min <= p1 <= paragraph_1_max):
        errors.append(f"中文摘要第一段必须为{paragraph_1_min}—{paragraph_1_max}字，当前为{p1}字")
    if not (paragraph_2_min <= p2 <= paragraph_2_max):
        errors.append(f"中文摘要第二段必须为{paragraph_2_min}—{paragraph_2_max}字，当前为{p2}字")
    if require_ordering:
        if p1_order is None:
            errors.append("中文摘要第一段必须使用“第一/第二/第三”或“首先/其次/再次”等顺序词排序关键挑战")
        if p2_order is None:
            errors.append("中文摘要第二段必须使用“第一/第二/第三”或“首先/其次/再次”等顺序词排序对应技术点")
    if require_bilingual:
        if not en:
            errors.append("generate_abstract 必须同时生成英文摘要 abstract_en")
        if not kw_en:
            errors.append("generate_abstract 必须同时生成英文关键词 keywords_en")
    if not kw_cn:
        errors.append("generate_abstract 必须生成中文关键词 keywords_cn")

    if require_opening_candidates:
        if not isinstance(opening_candidates, list):
            errors.append("generate_abstract 必须生成 opening_sentence_candidates_cn 业务需求背景首句候选数组")
            opening_candidates = []
        else:
            clean_candidates = [str(x or "").strip() for x in opening_candidates]
            if not (opening_candidate_min <= len(clean_candidates) <= opening_candidate_max):
                errors.append(
                    f"业务需求背景首句候选必须为{opening_candidate_min}—{opening_candidate_max}句，当前为{len(clean_candidates)}句"
                )
            if any(not x for x in clean_candidates):
                errors.append("业务需求背景首句候选不得为空")
            normalized_candidates = [_normalize_abstract_sentence(x) for x in clean_candidates if x]
            if len(normalized_candidates) != len(set(normalized_candidates)):
                errors.append("业务需求背景首句候选必须从不同分析角度生成，不得重复")
            if not selected_opening:
                errors.append("generate_abstract 必须提供 selected_opening_sentence_cn")
            elif _normalize_abstract_sentence(selected_opening) not in set(normalized_candidates):
                errors.append("selected_opening_sentence_cn 必须来自 opening_sentence_candidates_cn")
            first_sentence = first_full_sentence(cn)
            if selected_opening and first_sentence and _normalize_abstract_sentence(first_sentence) != _normalize_abstract_sentence(selected_opening):
                errors.append("中文摘要第一完整句必须使用 selected_opening_sentence_cn；用户改选候选时应同步替换首句")

    assessment_kind_counts = {"quantitative": 0, "qualitative": 0, "mixed": 0}
    if require_assessment_result_metadata:
        if not isinstance(assessment_rows, list):
            errors.append("generate_abstract 必须提供 assessment_result_coverage；存在任务书时用于逐项跟踪定量和定性考核结果")
            assessment_rows = []
        for idx, row in enumerate(assessment_rows or [], 1):
            if not isinstance(row, dict):
                errors.append(f"assessment_result_coverage 第{idx}项必须为对象")
                continue
            kind = str(row.get("assessment_kind") or "").strip()
            result = str(row.get("result_statement") or "").strip()
            item_id = str(row.get("assessment_item_id") or "").strip()
            name = str(row.get("assessment_name") or "").strip()
            status = str(row.get("evidence_status") or "").strip()
            if not item_id or not name:
                errors.append(f"assessment_result_coverage 第{idx}项缺少考核事项编号或名称")
            if kind not in assessment_kind_counts:
                errors.append(f"assessment_result_coverage 第{idx}项 assessment_kind 必须为 quantitative/qualitative/mixed")
            else:
                assessment_kind_counts[kind] += 1
            if not result:
                if kind in {"qualitative", "mixed"}:
                    errors.append(f"定性/混合考核事项第{idx}项必须写出已形成能力、功能、成果状态或工程效果，不能只保留要求")
                else:
                    errors.append(f"assessment_result_coverage 第{idx}项缺少 result_statement")
            if not status:
                errors.append(f"assessment_result_coverage 第{idx}项缺少 evidence_status")

    if supplementary is None:
        supplementary = []
    if not isinstance(supplementary, list):
        errors.append("supplementary_metrics_used 必须为数组")
        supplementary = []
    elif len(supplementary) > max_supplementary_metrics:
        errors.append(
            f"摘要中的非任务书补充指标最多{max_supplementary_metrics}个，当前为{len(supplementary)}个；优先只写任务书考核指标"
        )
    for idx, row in enumerate(supplementary, 1):
        if not isinstance(row, dict) or not str(row.get("metric_name") or "").strip() or not str(row.get("result_statement") or "").strip():
            errors.append(f"supplementary_metrics_used 第{idx}项必须包含 metric_name 和 result_statement")

    return {
        "valid": not errors,
        "count_method": "cjk_characters_plus_latin_number_tokens",
        "paragraph_count": len(paragraphs),
        "total_words": total,
        "paragraph_words": counts,
        "paragraph_1_words": p1,
        "paragraph_2_words": p2,
        "paragraph_3_words": p3,
        "total_range": [total_min, total_max],
        "paragraph_1_range": [paragraph_1_min, paragraph_1_max],
        "paragraph_2_range": [paragraph_2_min, paragraph_2_max],
        "paragraph_1_ordering": p1_order,
        "paragraph_2_ordering": p2_order,
        "opening_candidate_count": len(opening_candidates or []) if isinstance(opening_candidates, list) else 0,
        "selected_opening_sentence_cn": selected_opening,
        "abstract_first_sentence_cn": first_full_sentence(cn),
        "assessment_result_count": len(assessment_rows or []) if isinstance(assessment_rows, list) else 0,
        "assessment_kind_counts": assessment_kind_counts,
        "supplementary_metric_count": len(supplementary or []) if isinstance(supplementary, list) else 0,
        "supplementary_metric_max": max_supplementary_metrics,
        "english_abstract_present": bool(en),
        "english_keywords_present": bool(kw_en),
        "chinese_keywords_present": bool(kw_cn),
        "errors": errors,
    }
