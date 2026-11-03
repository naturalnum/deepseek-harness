#!/usr/bin/env python3
"""Validate effective Chinese report word counts against confirmed targets.

Counting policy:
- Each Han character counts as one.
- Each contiguous Latin-letter or numeric token counts as one.
- Markdown headings, fenced code, inline code, math, HTML comments, and link URLs
  are excluded so formatting and formulas cannot inflate the count.

Examples:
  python scripts/validate_word_count.py chapter.md --target 5000
  python scripts/validate_word_count.py report.md --outline outline.json
"""
from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
LATIN_NUM_TOKEN_RE = re.compile(r"[A-Za-z0-9]+(?:[._/-][A-Za-z0-9]+)*")
HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+")
NUMBERED_CHAPTER_RE = re.compile(r"^#\s+(?:第\s*)?(\d+)(?:\s*章)?(?:\s+|$)")
FENCE_RE = re.compile(r"^\s*(```+|~~~+)")
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
DISPLAY_MATH_RE = re.compile(r"\$\$.*?\$\$|\\\[.*?\\\]", re.S)
INLINE_MATH_RE = re.compile(r"(?<!\\)\$(?!\$).*?(?<!\\)\$|\\\(.*?\\\)")
INLINE_CODE_RE = re.compile(r"(`+)(.*?)\1")
LINK_RE = re.compile(r"!?(?:\[([^\]]*)\])\([^)]*\)")
REFERENCE_LINK_RE = re.compile(r"^\s*\[[^\]]+\]:\s+\S+.*$", re.M)
MARKDOWN_MARKER_RE = re.compile(r"[*_~>|]+|^\s*[-+*]\s+|^\s*\d+[.)]\s+", re.M)


@dataclass(frozen=True)
class CountResult:
    actual: int
    target: int
    minimum: int
    ratio: float
    maximum: int | None = None

    @property
    def passed(self) -> bool:
        return self.actual >= self.minimum and (self.maximum is None or self.actual <= self.maximum)


def remove_fenced_code(text: str) -> str:
    kept: list[str] = []
    in_fence = False
    fence_char = ""
    fence_len = 0
    for line in text.splitlines():
        match = FENCE_RE.match(line)
        if match:
            marker = match.group(1)
            char = marker[0]
            if not in_fence:
                in_fence = True
                fence_char = char
                fence_len = len(marker)
            elif char == fence_char and len(marker) >= fence_len:
                in_fence = False
                fence_char = ""
                fence_len = 0
            continue
        if not in_fence:
            kept.append(line)
    return "\n".join(kept)


def strip_nonprose(text: str) -> str:
    text = remove_fenced_code(text)
    text = HTML_COMMENT_RE.sub(" ", text)
    text = DISPLAY_MATH_RE.sub(" ", text)
    text = INLINE_MATH_RE.sub(" ", text)
    text = INLINE_CODE_RE.sub(" ", text)
    text = REFERENCE_LINK_RE.sub(" ", text)
    text = LINK_RE.sub(lambda m: m.group(1) or " ", text)
    lines = [line for line in text.splitlines() if not HEADING_RE.match(line)]
    text = "\n".join(lines)
    text = MARKDOWN_MARKER_RE.sub(" ", text)
    return text


def count_effective_words(text: str) -> int:
    prose = strip_nonprose(text)
    han_count = len(HAN_RE.findall(prose))
    without_han = HAN_RE.sub(" ", prose)
    latin_num_count = len(LATIN_NUM_TOKEN_RE.findall(without_han))
    return han_count + latin_num_count


def evaluate(actual: int, target: int, min_ratio: float) -> CountResult:
    if target <= 0:
        raise ValueError("target must be a positive integer")
    minimum = math.ceil(target * min_ratio)
    return CountResult(actual=actual, target=target, minimum=minimum, ratio=actual / target)


def evaluate_range(actual: int, target: int, minimum: int, maximum: int) -> CountResult:
    if minimum <= 0 or maximum < minimum:
        raise ValueError("invalid fixed word range")
    return CountResult(actual=actual, target=target, minimum=minimum, maximum=maximum, ratio=actual / target)


def split_numbered_chapters(text: str) -> dict[str, str]:
    chapters: dict[str, list[str]] = {}
    current: str | None = None
    in_fence = False
    fence_char = ""
    fence_len = 0
    for line in text.splitlines():
        fence = FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            char = marker[0]
            if not in_fence:
                in_fence = True
                fence_char = char
                fence_len = len(marker)
            elif char == fence_char and len(marker) >= fence_len:
                in_fence = False
                fence_char = ""
                fence_len = 0
        if not in_fence:
            match = NUMBERED_CHAPTER_RE.match(line)
            if match:
                current = match.group(1)
                chapters.setdefault(current, [])
                continue
        if current is not None:
            chapters[current].append(line)
    return {chapter_id: "\n".join(lines) for chapter_id, lines in chapters.items()}


def validate_single(path: Path, target: int, min_ratio: float) -> list[tuple[str, CountResult]]:
    actual = count_effective_words(path.read_text(encoding="utf-8"))
    return [(path.name, evaluate(actual, target, min_ratio))]


def validate_outline(path: Path, outline_path: Path, min_ratio: float) -> list[tuple[str, CountResult]]:
    report = path.read_text(encoding="utf-8")
    outline = json.loads(outline_path.read_text(encoding="utf-8"))
    chapter_texts = split_numbered_chapters(report)
    results: list[tuple[str, CountResult]] = []
    for chapter in outline.get("chapters", []):
        chapter_id = str(chapter.get("id", "")).strip()
        title = str(chapter.get("title", "")).strip()
        target = chapter.get("target_words")
        if not chapter_id or not isinstance(target, int) or target <= 0:
            raise ValueError(f"outline chapter {chapter_id or '?'} lacks a positive integer target_words")
        chapter_text = chapter_texts.get(chapter_id)
        if chapter_text is None:
            results.append((f"第{chapter_id}章 {title}（未找到正文）", evaluate(0, target, min_ratio)))
            continue
        actual = count_effective_words(chapter_text)
        is_final_conclusion = chapter is outline.get("chapters", [])[-1] and (
            str(chapter.get("chapter_type", "")).strip().lower() == "conclusion"
            or title in {"总结", "总结与展望", "结论"}
        )
        if is_final_conclusion:
            results.append((f"第{chapter_id}章 {title}", evaluate_range(actual, target, 700, 800)))
        else:
            results.append((f"第{chapter_id}章 {title}", evaluate(actual, target, min_ratio)))
    return results


def print_results(results: Iterable[tuple[str, CountResult]], as_json: bool) -> int:
    rows = []
    failed = False
    for label, result in results:
        status = "pass" if result.passed else "fail"
        failed = failed or not result.passed
        rows.append({
            "unit": label,
            "status": status,
            "actual_words": result.actual,
            "target_words": result.target,
            "minimum_words": result.minimum,
            "maximum_words": result.maximum,
            "completion_ratio": round(result.ratio, 4),
        })
    if as_json:
        print(json.dumps({"status": "fail" if failed else "pass", "results": rows}, ensure_ascii=False, indent=2))
    else:
        for row in rows:
            print(
                f"{row['status'].upper()}: {row['unit']} - "
                f"actual={row['actual_words']}, target={row['target_words']}, "
                f"minimum={row['minimum_words']}"
                + (f", maximum={row['maximum_words']}" if row.get('maximum_words') is not None else "")
                + f", ratio={row['completion_ratio']:.1%}"
            )
        print("字数校验失败。" if failed else "字数校验通过。")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("markdown", type=Path)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--target", type=int, help="Target words for one chapter or section")
    group.add_argument("--outline", type=Path, help="Structured outline JSON with chapter target_words")
    parser.add_argument("--min-ratio", type=float, default=0.8)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    if not (0 < args.min_ratio <= 1):
        parser.error("--min-ratio must be greater than 0 and no more than 1")
    if not args.markdown.is_file():
        parser.error(f"Markdown file not found: {args.markdown}")

    try:
        if args.target is not None:
            results = validate_single(args.markdown, args.target, args.min_ratio)
        else:
            if not args.outline or not args.outline.is_file():
                parser.error(f"Outline file not found: {args.outline}")
            results = validate_outline(args.markdown, args.outline, args.min_ratio)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}")
        return 2
    return print_results(results, args.as_json)


if __name__ == "__main__":
    raise SystemExit(main())
