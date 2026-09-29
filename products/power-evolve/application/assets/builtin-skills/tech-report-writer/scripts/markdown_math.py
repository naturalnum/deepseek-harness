#!/usr/bin/env python3
"""Deterministic Markdown/HTML math normalization for Word generation.

The report generator authors formulas in Markdown LaTeX.  The Word formatter consumes
internal base64 markers and replaces those markers with native Word OMML through
Pandoc.  This module is the missing bridge between the two representations.
"""
from __future__ import annotations

import base64
import re
from typing import Callable

from bs4 import BeautifulSoup, NavigableString, Tag

DISPLAY_MARKER_PREFIX = "TECH_REPORT_MATH_B64"
INLINE_MARKER_PREFIX = "TECH_REPORT_INLINE_MATH_B64"

_INLINE_DOLLAR_RE = re.compile(r"(?<!\\)(?<!\$)\$(?!\$)(.+?)(?<!\\)\$(?!\$)")
_INLINE_PAREN_RE = re.compile(r"\\\((.+?)\\\)")
_INLINE_DOUBLE_DOLLAR_RE = re.compile(r"\$\$(.+?)\$\$")
_TAG_RE = re.compile(r"\\tag\s*\{([^{}]+)\}")
_FORMULA_NUMBER_RE = re.compile(r"^[（(]\s*([A-Z0-9]+-\d+)\s*[）)]$")
_CODE_SPAN_RE = re.compile(r"(`+)(.+?)\1")


def _encode_marker(prefix: str, latex: str) -> str:
    payload = base64.urlsafe_b64encode(latex.strip().encode("utf-8")).decode("ascii")
    return f"[[{prefix}:{payload}]]"


def inline_math_marker(latex: str) -> str:
    return _encode_marker(INLINE_MARKER_PREFIX, latex)


def display_math_marker(latex: str) -> str:
    return _encode_marker(DISPLAY_MARKER_PREFIX, latex)


def split_formula_tag(latex: str) -> tuple[str, str | None]:
    """Remove a Markdown LaTeX ``\tag{...}`` and return its Word number text.

    The upstream authoring rule requires chapter-local numbers such as ``3-1``.  The
    Word formatter renders the number separately as ``（3-1）`` so the tag must not be
    passed to Pandoc as part of the equation body.
    """
    tags = _TAG_RE.findall(latex)
    if not tags:
        return latex.strip(), None
    number = tags[-1].strip()
    cleaned = _TAG_RE.sub("", latex).strip()
    return cleaned, f"（{number}）"


def normalize_formula_number_line(text: str) -> str | None:
    match = _FORMULA_NUMBER_RE.fullmatch(text.strip())
    return f"（{match.group(1)}）" if match else None


def _looks_like_inline_math(body: str) -> bool:
    candidate = body.strip()
    if not candidate or "\n" in candidate:
        return False
    # Avoid interpreting paired currency signs around ordinary Chinese prose as math.
    # LaTeX containing Chinese is still allowed when a backslash command is present.
    if re.search(r"[\u4e00-\u9fff]", candidate) and "\\" not in candidate:
        return False
    return True


def replace_inline_math_delimiters(text: str) -> str:
    """Replace Markdown inline math with internal Word-math markers.

    Supports ``$...$`` and ``\\(...\\)``.  A single-line ``$$...$$`` that reaches this
    function is treated as inline math as a safety fallback; normal display blocks are
    converted earlier by :func:`normalize_markdown_display_math`.
    """

    def dollar_repl(match: re.Match[str]) -> str:
        body = match.group(1)
        return inline_math_marker(body) if _looks_like_inline_math(body) else match.group(0)

    text = _INLINE_DOUBLE_DOLLAR_RE.sub(lambda m: inline_math_marker(m.group(1)), text)
    text = _INLINE_PAREN_RE.sub(lambda m: inline_math_marker(m.group(1)), text)
    return _INLINE_DOLLAR_RE.sub(dollar_repl, text)


def replace_inline_math_preserving_code(text: str) -> str:
    """Replace inline math while leaving Markdown inline-code spans untouched."""
    placeholders: list[str] = []

    def stash(match: re.Match[str]) -> str:
        placeholders.append(match.group(0))
        return f"\x00TECHCODE{len(placeholders) - 1}\x00"

    protected = _CODE_SPAN_RE.sub(stash, text)
    protected = replace_inline_math_delimiters(protected)
    for index, original in enumerate(placeholders):
        protected = protected.replace(f"\x00TECHCODE{index}\x00", original)
    return protected


def _consume_display_block(lines: list[str], start: int, opener: str, closer: str) -> tuple[int, str] | None:
    """Consume a display-math block starting at ``start``.

    The opener must be the first non-whitespace token on the line.  Both one-line and
    multiline blocks are accepted.  Returns ``(last_line_index, formula_body)``.
    """
    stripped = lines[start].strip()
    if not stripped.startswith(opener):
        return None
    rest = stripped[len(opener):]
    if closer in rest:
        body, tail = rest.split(closer, 1)
        if tail.strip():
            return None
        return start, body.strip()

    body_lines: list[str] = []
    if rest.strip():
        body_lines.append(rest)
    for index in range(start + 1, len(lines)):
        current = lines[index]
        if closer in current:
            before, tail = current.split(closer, 1)
            if tail.strip():
                return None
            if before.strip():
                body_lines.append(before)
            return index, "\n".join(body_lines).strip()
        body_lines.append(current)
    return None


def normalize_markdown_display_math(markdown: str) -> str:
    """Convert Markdown display math blocks to internal Word markers.

    Fenced code blocks are preserved verbatim.  ``\tag{3-1}`` is split into a formula
    marker followed by the Word-side number paragraph.  An explicit number line after
    a formula is normalized to full-width Chinese parentheses.
    """
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    index = 0
    fence: str | None = None
    pending_formula = False

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        fence_match = re.match(r"^(```+|~~~+)", stripped)
        if fence is not None:
            out.append(line)
            if stripped.startswith(fence):
                fence = None
            index += 1
            pending_formula = False
            continue
        if fence_match:
            fence = fence_match.group(1)[:3]
            out.append(line)
            index += 1
            pending_formula = False
            continue

        consumed = _consume_display_block(lines, index, "$$", "$$")
        if consumed is None:
            consumed = _consume_display_block(lines, index, r"\[", r"\]")
        if consumed is not None:
            last_index, body = consumed
            clean_body, tag_number = split_formula_tag(body)
            if clean_body:
                out.append(display_math_marker(clean_body))
                if tag_number:
                    out.append(tag_number)
                pending_formula = tag_number is None
            else:
                # Keep malformed/empty math visible so the final validator can block it.
                out.extend(lines[index:last_index + 1])
                pending_formula = False
            index = last_index + 1
            continue

        if pending_formula:
            normalized_number = normalize_formula_number_line(line)
            if normalized_number:
                out.append(normalized_number)
                index += 1
                pending_formula = False
                continue
            if stripped:
                pending_formula = False

        out.append(line)
        index += 1

    return "\n".join(out)


def normalize_html_math(content_html: str) -> str:
    """Normalize raw LaTeX delimiters that arrive through a prebuilt HTML chapter.

    Full-paragraph display formulas become display markers.  Inline formulas in text
    nodes become inline markers.  ``code`` and ``pre`` content is intentionally left
    unchanged.
    """
    if not content_html or not isinstance(content_html, str):
        return content_html
    soup = BeautifulSoup(content_html, "html.parser")

    for paragraph in list(soup.find_all("p")):
        raw = paragraph.get_text("", strip=True)
        body: str | None = None
        if raw.startswith("$$") and raw.endswith("$$") and len(raw) >= 4:
            body = raw[2:-2].strip()
        elif raw.startswith(r"\[") and raw.endswith(r"\]") and len(raw) >= 4:
            body = raw[2:-2].strip()
        if body is None:
            continue
        clean_body, tag_number = split_formula_tag(body)
        if not clean_body:
            continue
        paragraph.clear()
        paragraph.append(display_math_marker(clean_body))
        paragraph["style"] = "font-family:宋体;font-size:10.5pt;text-align:center;text-indent:0"
        if tag_number:
            next_text = ""
            sibling = paragraph.find_next_sibling("p")
            if sibling is not None:
                next_text = sibling.get_text("", strip=True)
            normalized_existing = normalize_formula_number_line(next_text)
            if normalized_existing is None:
                number_p = soup.new_tag("p")
                number_p["style"] = "font-family:宋体;font-size:10.5pt;text-align:right;text-indent:0"
                number_p.string = tag_number
                paragraph.insert_after(number_p)
            elif sibling is not None and next_text != normalized_existing:
                sibling.clear()
                sibling.append(normalized_existing)

    for node in list(soup.find_all(string=True)):
        if not isinstance(node, NavigableString):
            continue
        parent = node.parent
        if isinstance(parent, Tag) and parent.name in {"code", "pre", "script", "style"}:
            continue
        text = str(node)
        replaced = replace_inline_math_delimiters(text)
        if replaced != text:
            node.replace_with(replaced)

    return str(soup)
