#!/usr/bin/env python3
"""Basic formula and symbol-definition checks for Markdown technical reports.

This validator is intentionally conservative. It detects missing display formulas in
required chapters and checks whether a symbol explanation cue appears near each
formula. It cannot verify mathematical correctness.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


CHAPTER_RE = re.compile(r"^#\s+(?P<num>\d+)\s*[.、]?\s*(?P<title>.+?)\s*$")
DISPLAY_BLOCK_RE = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
BRACKET_BLOCK_RE = re.compile(r"\\\[(.+?)\\\]", re.DOTALL)
BEGIN_ENV_RE = re.compile(
    r"\\begin\{(?:equation\*?|align\*?|aligned|gather\*?)\}(.+?)"
    r"\\end\{(?:equation\*?|align\*?|aligned|gather\*?)\}",
    re.DOTALL,
)
INLINE_RE = re.compile(r"(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)")
DEFINITION_CUE_RE = re.compile(
    r"式中|其中|符号说明|表示|分别表示|为(?:第|对应|给定|权重|参数|变量|集合|矩阵|向量)|"
    r"denote|where\b",
    re.IGNORECASE,
)
TRIVIAL_RE = re.compile(
    r"^\s*(?:\d+(?:\.\d+)?\s*[+\-*/]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?%?)\s*$"
)


@dataclass
class Formula:
    start: int
    end: int
    body: str
    kind: str


@dataclass
class Chapter:
    number: str
    title: str
    start: int
    end: int
    text: str


def parse_chapter_set(value: str | None) -> set[str]:
    if not value:
        return set()
    return {part.strip() for part in value.split(",") if part.strip()}


def split_chapters(text: str) -> list[Chapter]:
    lines = text.splitlines(keepends=True)
    offsets: list[int] = []
    pos = 0
    for line in lines:
        offsets.append(pos)
        pos += len(line)

    heads: list[tuple[str, str, int]] = []
    for i, line in enumerate(lines):
        m = CHAPTER_RE.match(line.rstrip("\n"))
        if m:
            heads.append((m.group("num"), m.group("title").strip(), offsets[i]))

    chapters: list[Chapter] = []
    for idx, (number, title, start) in enumerate(heads):
        end = heads[idx + 1][2] if idx + 1 < len(heads) else len(text)
        chapters.append(Chapter(number, title, start, end, text[start:end]))
    return chapters


def find_formulas(text: str) -> list[Formula]:
    found: list[Formula] = []
    for kind, pattern in (
        ("display", DISPLAY_BLOCK_RE),
        ("bracket", BRACKET_BLOCK_RE),
        ("environment", BEGIN_ENV_RE),
    ):
        for m in pattern.finditer(text):
            found.append(Formula(m.start(), m.end(), m.group(1).strip(), kind))
    found.sort(key=lambda x: x.start)
    return found


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def nearby_text(text: str, start: int, end: int, before_lines: int = 3, after_lines: int = 8) -> tuple[str, str]:
    before = text[:start].splitlines()[-before_lines:]
    after = text[end:].splitlines()[:after_lines]
    return "\n".join(before), "\n".join(after)


def has_meaningful_formula(formulas: Iterable[Formula]) -> bool:
    for f in formulas:
        body = re.sub(r"\\tag\{[^}]+\}", "", f.body).strip()
        if len(body) >= 8 and not TRIVIAL_RE.match(body):
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate formula coverage and nearby symbol explanations.")
    parser.add_argument("report", type=Path, help="Markdown report path")
    parser.add_argument(
        "--require-chapters",
        default="",
        help="Comma-separated chapter numbers that must contain a meaningful display formula, e.g. 2,3,4",
    )
    parser.add_argument(
        "--exempt-chapters",
        default="1",
        help="Comma-separated chapters exempt from formula coverage checks; default: 1",
    )
    parser.add_argument(
        "--allow-missing-definition",
        action="store_true",
        help="Do not fail when a display formula has no nearby symbol explanation cue",
    )
    args = parser.parse_args()

    if not args.report.exists():
        print(f"ERROR: file not found: {args.report}", file=sys.stderr)
        return 2

    text = args.report.read_text(encoding="utf-8")
    chapters = split_chapters(text)
    require = parse_chapter_set(args.require_chapters)
    exempt = parse_chapter_set(args.exempt_chapters)

    errors: list[str] = []
    warnings: list[str] = []

    if require and not chapters:
        errors.append("未识别到 '# 2 章节标题' 形式的一级章节标题，无法执行按章公式校验。")

    chapter_map = {c.number: c for c in chapters}
    for num in sorted(require):
        ch = chapter_map.get(num)
        if ch is None:
            errors.append(f"要求校验的第 {num} 章不存在。")
            continue
        formulas = find_formulas(ch.text)
        if not has_meaningful_formula(formulas):
            errors.append(f"第 {num} 章《{ch.title}》被标记为 must，但未发现承担核心论证作用的显示公式。")

    all_formulas = find_formulas(text)
    for f in all_formulas:
        before, after = nearby_text(text, f.start, f.end)
        global_line = line_number(text, f.start)
        if not DEFINITION_CUE_RE.search(after):
            message = f"第 {global_line} 行附近的显示公式后未发现紧邻的符号解释提示（如“式中”“其中”）。"
            if args.allow_missing_definition:
                warnings.append(message)
            else:
                errors.append(message)
        if not before.strip():
            warnings.append(f"第 {global_line} 行附近的显示公式前缺少引出性文字。")

    # Detect chapters that are neither explicitly required nor exempt and have no formula.
    for ch in chapters:
        if ch.number in require or ch.number in exempt:
            continue
        formulas = find_formulas(ch.text)
        if not has_meaningful_formula(formulas):
            warnings.append(
                f"第 {ch.number} 章《{ch.title}》未发现显示公式；请确认其公式需求是否为 should/exempt，并记录理由。"
            )

    inline_count = len(INLINE_RE.findall(text))
    print(f"识别章节：{len(chapters)}")
    print(f"显示公式：{len(all_formulas)}")
    print(f"行内公式：{inline_count}")

    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")

    if errors:
        print(f"校验失败：{len(errors)} 个错误，{len(warnings)} 个警告。")
        return 1
    print(f"校验通过：0 个错误，{len(warnings)} 个警告。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
