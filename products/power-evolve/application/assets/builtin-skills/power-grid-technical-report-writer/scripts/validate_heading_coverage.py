#!/usr/bin/env python3
"""Check that confirmed outline headings are preserved in generated Markdown.

The validator is intentionally deterministic. It compares numbered Markdown
headings against the confirmed structured outline and catches the common case
where level-3 headings are silently flattened into prose during chapter writing.
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ATX_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
NUMBERED_TITLE = re.compile(r"^(?:第\s*)?(\d+(?:\.\d+)*)(?:\s*[章节])?\s+(.+?)\s*$")


@dataclass(frozen=True)
class Heading:
    level: int
    number: str
    title: str
    line: int


def normalize_title(text: str) -> str:
    text = re.sub(r"\s+", "", text.strip())
    return text.rstrip("#").strip()


def load_outline(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_markdown(path: Path) -> list[Heading]:
    headings: list[Heading] = []
    in_fence = False
    fence_marker = ""
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith(("```", "~~~")):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
                fence_marker = ""
            continue
        if in_fence:
            continue
        match = ATX_HEADING.match(line)
        if not match:
            continue
        level = len(match.group(1))
        raw = match.group(2).strip().rstrip("#").strip()
        numbered = NUMBERED_TITLE.match(raw)
        if not numbered:
            continue
        headings.append(
            Heading(
                level=level,
                number=numbered.group(1),
                title=numbered.group(2).strip(),
                line=lineno,
            )
        )
    return headings


def chapter_selected(chapter: dict[str, Any], requested: set[str]) -> bool:
    return not requested or str(chapter.get("id", "")) in requested


def expected_headings(
    outline: dict[str, Any],
    requested_chapters: set[str],
    requested_sections: set[str],
    levels: set[int],
) -> list[Heading]:
    expected: list[Heading] = []
    for chapter in outline.get("chapters", []):
        cid = str(chapter.get("id", ""))
        if not chapter_selected(chapter, requested_chapters):
            continue
        for item in chapter.get("section_outline", []):
            level = item.get("level")
            if level not in levels:
                continue
            number = str(item.get("number", "")).strip()
            title = str(item.get("title", "")).strip()
            section_match = not requested_sections or any(
                number == prefix or number.startswith(prefix + ".")
                for prefix in requested_sections
            )
            if number and title and section_match:
                expected.append(Heading(level=level, number=number, title=title, line=0))
    return expected


def main() -> int:
    parser = argparse.ArgumentParser(
        description="校验生成的Markdown是否完整保留已确认目录中的二级、三级标题。"
    )
    parser.add_argument("markdown", type=Path)
    parser.add_argument("--outline", type=Path, required=True)
    parser.add_argument(
        "--chapter",
        action="append",
        default=[],
        help="仅校验指定章号，可重复使用，如 --chapter 2 --chapter 3。",
    )
    parser.add_argument(
        "--section",
        action="append",
        default=[],
        help="仅校验指定节及其下级标题，可重复使用，如 --section 2.1。",
    )
    parser.add_argument(
        "--levels",
        default="2,3",
        help="需要锁定的目录层级，默认2,3。",
    )
    args = parser.parse_args()

    try:
        levels = {int(x.strip()) for x in args.levels.split(",") if x.strip()}
    except ValueError:
        print("ERROR: --levels 必须是逗号分隔的整数，例如 2,3。")
        return 2
    if not levels:
        print("ERROR: --levels 不能为空。")
        return 2

    outline = load_outline(args.outline)
    actual = parse_markdown(args.markdown)
    expected = expected_headings(
        outline, set(args.chapter), set(args.section), levels
    )

    if not expected:
        print("ERROR: 未在结构化目录中找到符合当前章/节和层级条件的标题。")
        return 2

    errors: list[str] = []
    actual_by_number: dict[str, list[Heading]] = {}
    for heading in actual:
        actual_by_number.setdefault(heading.number, []).append(heading)

    matched_positions: list[int] = []
    for item in expected:
        candidates = actual_by_number.get(item.number, [])
        if not candidates:
            errors.append(
                f"缺少已确认的{item.level}级标题：{item.number} {item.title}。"
            )
            continue
        exact = [
            h
            for h in candidates
            if h.level == item.level and normalize_title(h.title) == normalize_title(item.title)
        ]
        if not exact:
            same_title = [
                h for h in candidates if normalize_title(h.title) == normalize_title(item.title)
            ]
            if same_title:
                h = same_title[0]
                errors.append(
                    f"标题层级改变：{item.number} {item.title} 应为{item.level}级，"
                    f"实际为{h.level}级（第{h.line}行）。"
                )
            else:
                actual_titles = "；".join(f"{h.title}（第{h.line}行）" for h in candidates)
                errors.append(
                    f"标题被改名：{item.number} 期望“{item.title}”，实际为“{actual_titles}”。"
                )
            continue
        chosen = exact[0]
        matched_positions.append(actual.index(chosen))

    if matched_positions != sorted(matched_positions):
        errors.append("已确认标题在正文中的出现顺序与目录不一致。")

    expected_l3 = [h for h in expected if h.level == 3]
    matched_l3 = 0
    for item in expected_l3:
        if any(
            h.number == item.number
            and h.level == item.level
            and normalize_title(h.title) == normalize_title(item.title)
            for h in actual
        ):
            matched_l3 += 1

    for error in errors:
        print("ERROR:", error)
    if errors:
        print(
            f"标题覆盖校验失败：{len(errors)}个错误；"
            f"已保留三级标题 {matched_l3}/{len(expected_l3)}。"
        )
        return 1

    print(
        f"标题覆盖校验通过：已确认标题全部按原编号、原名称、原层级和原顺序保留；"
        f"三级标题 {matched_l3}/{len(expected_l3)}。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
