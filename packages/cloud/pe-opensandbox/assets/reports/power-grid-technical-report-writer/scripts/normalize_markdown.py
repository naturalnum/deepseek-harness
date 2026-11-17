#!/usr/bin/env python3
"""Normalize final Markdown without model participation.

Operations outside fenced/inline code and LaTeX math:
- Normalize long-dash variants to either ASCII '-' or Unicode em dash '—'.
- Remove whitespace between a digit and an adjacent Han character in either order.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

FENCE_RE = re.compile(r"^\s*(```+|~~~+)")
PROTECTED_RE = re.compile(
    r"(`+.*?`+|\$\$.*?\$\$|(?<!\\)\$(?!\$).*?(?<!\\)\$|\\\[.*?\\\]|\\\(.*?\\\))",
    re.S,
)
LONG_DASH_RE = re.compile(r"[—–―﹘－]+")
HAN = r"\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
DIGIT_HAN_SPACE_RE_1 = re.compile(rf"(?<=\d)[ \t\u3000]+(?=[{HAN}])")
DIGIT_HAN_SPACE_RE_2 = re.compile(rf"(?<=[{HAN}])[ \t\u3000]+(?=\d)")


def normalize_segment(segment: str, dash: str) -> tuple[str, int, int]:
    segment, dash_count = LONG_DASH_RE.subn(dash, segment)
    segment, space_count_1 = DIGIT_HAN_SPACE_RE_1.subn("", segment)
    segment, space_count_2 = DIGIT_HAN_SPACE_RE_2.subn("", segment)
    return segment, dash_count, space_count_1 + space_count_2


def normalize_unprotected(text: str, dash: str) -> tuple[str, int, int]:
    parts: list[str] = []
    cursor = 0
    dash_count = 0
    space_count = 0
    for match in PROTECTED_RE.finditer(text):
        normalized, d_count, s_count = normalize_segment(text[cursor:match.start()], dash)
        parts.append(normalized)
        parts.append(match.group(0))
        dash_count += d_count
        space_count += s_count
        cursor = match.end()
    normalized, d_count, s_count = normalize_segment(text[cursor:], dash)
    parts.append(normalized)
    dash_count += d_count
    space_count += s_count
    return "".join(parts), dash_count, space_count


def normalize_markdown(text: str, dash: str) -> tuple[str, int, int]:
    output: list[str] = []
    buffer: list[str] = []
    in_fence = False
    fence_char = ""
    fence_len = 0
    total_dash = 0
    total_space = 0

    def flush_buffer() -> None:
        nonlocal total_dash, total_space
        if not buffer:
            return
        normalized, d_count, s_count = normalize_unprotected("".join(buffer), dash)
        output.append(normalized)
        total_dash += d_count
        total_space += s_count
        buffer.clear()

    for line in text.splitlines(keepends=True):
        match = FENCE_RE.match(line)
        if match:
            marker = match.group(1)
            char = marker[0]
            if not in_fence:
                flush_buffer()
                in_fence = True
                fence_char = char
                fence_len = len(marker)
                output.append(line)
                continue
            if char == fence_char and len(marker) >= fence_len:
                output.append(line)
                in_fence = False
                fence_char = ""
                fence_len = 0
                continue
        if in_fence:
            output.append(line)
        else:
            buffer.append(line)
    flush_buffer()
    return "".join(output), total_dash, total_space


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("markdown", type=Path)
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--in-place", action="store_true")
    output.add_argument("-o", "--output", type=Path)
    parser.add_argument("--dash-style", choices=("hyphen", "em-dash"), default="hyphen")
    args = parser.parse_args()

    if not args.markdown.is_file():
        parser.error(f"Markdown file not found: {args.markdown}")
    if not args.in_place and args.output is None:
        parser.error("choose --in-place or --output")

    dash = "-" if args.dash_style == "hyphen" else "—"
    text = args.markdown.read_text(encoding="utf-8")
    normalized, dash_count, space_count = normalize_markdown(text, dash)
    destination = args.markdown if args.in_place else args.output
    assert destination is not None
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(normalized, encoding="utf-8")
    print(f"清洗完成：长划线替换 {dash_count} 处，数字与汉字间空格删除 {space_count} 处；输出 {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
