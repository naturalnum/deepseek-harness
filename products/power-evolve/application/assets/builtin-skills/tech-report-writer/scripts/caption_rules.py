"""Shared caption recognition for OOXML formatting, catalog marking and validation."""

import re

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
FIGURE_CAPTION_RE = re.compile(
    r"^图\s*(?P<number>[A-Z0-9]+-\d+)[ \t\u3000]+(?P<title>\S.*)$"
)
TABLE_CAPTION_RE = re.compile(
    r"^表\s*(?P<number>[A-Z0-9]+-\d+)[ \t\u3000]+(?P<title>\S.*)$"
)
_EXPLANATION_VERBS = (
    r"应表达|应展示|应给出|给出|展示|显示|表明|说明|反映|可见|"
    r"所示|用于表达|用于展示|用于说明|用于给出"
)
EXPLANATION_LEAD_RE = re.compile(
    r"^(?:图|表)\s*[A-Z0-9]+-\d+\s*[：:]?\s*(?:" + _EXPLANATION_VERBS + ")"
)
_EXPLANATION_TITLE_PREFIX_RE = re.compile("^(?:" + _EXPLANATION_VERBS + ")")


def paragraph_text(paragraph):
    return "".join(node.text or "" for node in paragraph.iter(W + "t"))


def is_caption(paragraph, kind, style_name, adjacent_blocks=(), *, include_continued=False):
    """Require a numbered title and Caption style, direct centering or its adjacent object.

    Adjacent blocks are supplied nearest first: previous blocks for figures,
    following blocks for tables. Empty paragraphs may separate a caption from
    its object. Continued-table labels can be formatted but are not catalog items.
    This function reads both ElementTree and lxml elements without changing them.
    """
    text = re.sub(r"\s+", " ", paragraph_text(paragraph).strip())
    match = (FIGURE_CAPTION_RE if kind == "figure" else TABLE_CAPTION_RE).match(text)
    if match is None:
        return False
    title = match.group("title")
    if kind == "table" and not include_continued and re.match(r"^[（(]续[)）]", title):
        return False
    if _EXPLANATION_TITLE_PREFIX_RE.match(title.lstrip("：: ")):
        return False
    if style_name.lower() == "caption":
        return True
    alignment = paragraph.find(f"./{W}pPr/{W}jc")
    if alignment is not None and alignment.get(W + "val") == "center":
        return True
    for node in adjacent_blocks:
        if node.tag == W + "tbl":
            return kind == "table"
        if node.tag == W + "p":
            if kind == "figure" and any(
                node.find(f".//{W}{tag}") is not None
                for tag in ("drawing", "pict", "object")
            ):
                return True
            if paragraph_text(node).strip():
                return False
    return False
