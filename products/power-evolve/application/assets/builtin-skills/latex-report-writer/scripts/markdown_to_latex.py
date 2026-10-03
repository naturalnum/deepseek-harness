#!/usr/bin/env python3
"""Convert the supplied report Markdown into a semantic techreport LaTeX file.

The converter is intentionally conservative: it preserves prose, inline math,
display math, tables, appendices and references, while moving the abstract and front-matter
fields into the bundled report class.  It does not invent missing project
metadata or replace source placeholders.
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import unicodedata
from pathlib import Path

from report_images import prepare_image


INLINE_MATH = re.compile(r"(\\\(.*?\\\)|\$.*?\$)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
NUMBERED_HEADING = {
    1: re.compile(r"^(?:第([0-9]+|[一二三四五六七八九十百]+)章\s*|([0-9]+)\s+)(\S.*)$"),
    2: re.compile(r"^([0-9]+\.[0-9]+)\s+(\S.*)$"),
    3: re.compile(r"^([0-9]+\.[0-9]+\.[0-9]+)\s+(\S.*)$"),
}
TABLE_CAPTION = re.compile(r"^表\s*[0-9]+[-－][0-9]+\s*(.*)$")
FIGURE_CAPTION = re.compile(r"^图\s*([0-9]+)[-－]([0-9]+)\s*(\S.*)$")
MARKDOWN_IMAGE = re.compile(r'^!\[([^\]]*)\]\((?:<([^<>]+)>|([^\s()]+))(?:\s+"[^"]*")?\)$')
EQUATION_TAG = re.compile(r"\s*\\tag\{[^{}]*\}")
EQUATION_LABEL = re.compile(r"\s*\\label\{[^{}]*\}")
SENTENCE_END = re.compile(r"(?:[。！？.!?…]|\\text\{[。！？.!?…]+\})\s*$")

def escape_plain(text: str) -> str:
    """Escape LaTeX special characters in non-math text."""

    replacements = {
        "\\": r"\textbackslash{}",
        "&": r"\&",
        "%": r"\%",
        "$": r"\$",
        "#": r"\#",
        "_": r"\_",
        "{": r"\{",
        "}": r"\}",
        "~": r"\textasciitilde{}",
        "^": r"\textasciicircum{}",
    }
    return "".join(replacements.get(char, char) for char in text)


def escape_text(text: str) -> str:
    """Escape ordinary text while leaving inline math untouched."""

    pieces = INLINE_MATH.split(text)
    rendered: list[str] = []
    for piece in pieces:
        if not piece:
            continue
        if INLINE_MATH.fullmatch(piece):
            if piece.startswith("$"):
                rendered.append("\\(" + piece[1:-1] + "\\)")
            else:
                rendered.append(piece)
        else:
            rendered.append(escape_plain(piece))
    return "".join(rendered)


def parse_numbered_heading(title: str, level: int) -> tuple[tuple[int, ...], str] | None:
    """Read an explicit chapter/section number at its Markdown heading depth."""

    title = title.strip()
    pattern = NUMBERED_HEADING.get(level)
    match = pattern.fullmatch(title) if pattern else None
    if match is None:
        return None
    if level == 1:
        number = match.group(1) or match.group(2)
        if number.isascii():
            chapter = int(number)
        else:
            digits = dict(zip("一二三四五六七八九", range(1, 10)))
            chapter, digit = 0, 0
            for char in number:
                if char in digits:
                    digit = digits[char]
                else:
                    chapter += (digit or 1) * {"十": 10, "百": 100}[char]
                    digit = 0
            chapter += digit
        return (chapter,), match.group(3)
    return tuple(int(part) for part in match.group(1).split(".")), match.group(2)


def clean_heading(title: str, level: int) -> str:
    """Remove explicit Markdown numbering so the class prints it once."""

    numbered = parse_numbered_heading(title, level)
    return numbered[1] if numbered else title.strip()


def parse_abstract_block(lines: list[str], keyword_label: str) -> tuple[str, str]:
    """Return blank-line-separated prose paragraphs and the supplied keyword value."""

    keyword_pattern = re.compile(r"^\*{0,2}" + re.escape(keyword_label) + r"\*{0,2}\s*(.*)$", re.IGNORECASE)
    paragraphs: list[str] = []
    paragraph: list[str] = []
    keywords = ""
    for raw in lines:
        line = raw.strip()
        keyword = keyword_pattern.match(line)
        if not line or keyword:
            if paragraph:
                paragraphs.append(" ".join(paragraph))
                paragraph.clear()
            if keyword:
                keywords = keyword.group(1).strip()
        else:
            paragraph.append(line)
    if paragraph:
        paragraphs.append(" ".join(paragraph))
    return "\n\n".join(paragraphs), keywords


def render_abstract(abstract: str) -> str:
    """Escape each prose paragraph, preserving inline math and controlled paragraph ends."""

    # The fixed paragraph primitive alias survives key-value argument parsing;
    # source prose still passes through escape_text and cannot supply commands.
    return "\\endgraf\n".join(escape_text(paragraph) for paragraph in abstract.split("\n\n"))


def parse_front_matter(lines: list[str]) -> tuple[str, str, str, str, str, int, int]:
    """Return title, bilingual abstracts/keywords and body/refs offsets; abstract strings retain blank-line paragraph boundaries."""

    if not lines or not lines[0].startswith("# "):
        raise ValueError("Markdown must start with a level-1 report title")
    title = lines[0][2:].strip()
    abstract_start = next(
        i for i, line in enumerate(lines)
        if line.strip() in ("# 摘要", "# 中文摘要")
    )
    english_candidates = [i for i, line in enumerate(lines) if line.strip() == "# Abstract"]
    english_start = english_candidates[0] if english_candidates else None
    refs_start = next(i for i, line in enumerate(lines) if line.strip() == "# 参考文献")
    front_end = english_start if english_start is not None else abstract_start
    body_start = next((
        i for i, line in enumerate(lines)
        if front_end < i < refs_start
        and (heading := HEADING.match(line))
        and len(heading.group(1)) == 1
        and parse_numbered_heading(heading.group(2), 1) is not None
    ), None)
    if body_start is None:
        raise ValueError("The report body requires a numbered level-1 chapter heading")

    cn_end = english_start if english_start is not None else body_start
    cn_block = lines[abstract_start + 1 : cn_end]
    en_block = (
        lines[english_start + 1 : body_start]
        if english_start is not None
        else []
    )
    if not any(line.strip() for line in cn_block):
        raise ValueError("The Chinese abstract block is required")

    abstract_cn, cn_keywords = parse_abstract_block(cn_block, "关键词：")
    abstract_en, en_keywords = parse_abstract_block(en_block, "Keywords:")
    if not abstract_cn or not cn_keywords:
        raise ValueError("The Chinese abstract and keywords are required")
    if not abstract_en or not en_keywords:
        raise ValueError("The English abstract and keywords must be supplied explicitly")
    return (
        title,
        abstract_cn,
        cn_keywords,
        abstract_en,
        en_keywords,
        body_start,
        refs_start,
    )


def table_cell_width(text: str) -> float:
    """Estimate a cell's visual width in mixed Chinese/Latin table text."""

    width = 0.0
    for char in text.strip():
        if char.isspace():
            width += 0.45
        elif unicodedata.east_asian_width(char) in {"W", "F"}:
            width += 2.0
        elif unicodedata.category(char).startswith("P"):
            width += 0.9
        else:
            width += 0.95
    return max(width, 1.0)


def table_column_spec(rows: list[list[str]], alignments: list[str] | None = None) -> str:
    """Allocate centered wrapped columns from the longest content in each column.

    The total width is kept below the text width so the inter-column padding and
    booktabs rules remain inside the page. Markdown alignment markers are kept in
    the parser API for compatibility, but technical-report tables are centered
    uniformly as required by the report layout.
    """

    column_count = max(len(row) for row in rows)
    normalized = [row + [""] * (column_count - len(row)) for row in rows]
    max_widths = [
        max(table_cell_width(row[index]) for row in normalized)
        for index in range(column_count)
    ]
    target_width = 0.94 if column_count <= 4 else 0.90
    min_width = {
        1: 0.90,
        2: 0.18,
        3: 0.12,
        4: 0.10,
        5: 0.08,
        6: 0.07,
    }.get(column_count, 0.06)
    # A mild nonlinear weighting gives genuinely long text columns enough
    # room, while short numeric/result columns retain compact widths.
    weighted_widths = [width**1.60 for width in max_widths]
    minimums = [min_width] * column_count
    remaining = max(target_width - sum(minimums), 0.0)
    total_content_width = sum(weighted_widths)
    widths = [
        minimum + remaining * content_width / total_content_width
        for minimum, content_width in zip(minimums, weighted_widths)
    ]
    # Round consistently while preserving the target total to avoid tiny
    # accumulated overflows in tables with many columns.
    rounded = [round(width, 3) for width in widths]
    rounded[-1] = round(target_width - sum(rounded[:-1]), 3)
    columns = [
        ">{\\centering\\arraybackslash}p{" + f"{width:.3f}" + r"\textwidth}"
        for width in rounded
    ]
    return "@{}" + "".join(columns) + "@{}"


def render_table(rows: list[list[str]], caption: str, alignments: list[str] | None = None) -> str:
    """Render a Markdown table with its caption and body kept together."""

    if len(rows) < 2:
        return ""
    column_count = max(len(row) for row in rows)
    normalized = [row + [""] * (column_count - len(row)) for row in rows]
    header = normalized[0]
    body = normalized[1:]
    spec = table_column_spec(normalized, alignments)

    def render_row(row: list[str]) -> str:
        cells = [escape_text(cell.strip()) for cell in row]
        return " & ".join(cells) + r" \\"

    lines = [
        r"\reporttablebefore",
        r"\begingroup",
        r"\thispagestyle{trbody}",
        r"\reporttablefont",
        r"\setlength{\parindent}{0pt}",
        r"\setlength{\parskip}{0pt}",
        r"\setlength{\tabcolsep}{3pt}",
        r"\renewcommand{\arraystretch}{1.0}",
        r"\noindent\begin{minipage}{\textwidth}",
        r"\centering",
    ]
    if caption:
        lines.append(r"\reporttablecaption{" + escape_text(caption) + "}")
    lines.extend(
        [
            r"\begin{tabular}{" + spec + "}",
            r"\toprule",
            render_row(header),
            r"\midrule",
        ]
    )
    lines.extend(render_row(row) for row in body)
    lines.extend(
        [
            r"\bottomrule",
            r"\end{tabular}",
            r"\end{minipage}",
            r"\endgroup",
            r"\reporttableafter",
        ]
    )
    return "\n".join(lines) + "\n"


def render_equation(raw_lines: list[str]) -> str:
    """Render math in the class's fixed-visual-clearance equation block."""

    body = "\n".join(line.rstrip() for line in raw_lines).strip()
    # Numbering belongs to the class. Ignore a trailing Markdown-authored tag
    # so generated equations cannot disagree with the section counter.
    body = EQUATION_TAG.sub("", body).strip()
    return "\n".join([r"\begin{reportequation}", body, r"\end{reportequation}"]) + "\n"


def equation_ends_sentence(raw_lines: list[str]) -> bool:
    """Return whether visible equation punctuation terminates the sentence."""

    body = "\n".join(line.rstrip() for line in raw_lines).strip()
    # Tags and labels are structural tokens rather than visible sentence
    # punctuation, and may appear after the punctuation authored in Markdown.
    body = EQUATION_TAG.sub("", body)
    body = EQUATION_LABEL.sub("", body)
    return bool(SENTENCE_END.search(body.rstrip()))


def normalize_table_caption(raw: str) -> str:
    """Convert a Markdown table label into the title passed to the class."""

    match = TABLE_CAPTION.match(raw.strip())
    if not match:
        return ""
    caption = match.group(1).strip()
    caption = re.sub(r"^(?:给出(?:了)?|列出(?:了)?)\s*", "", caption)
    # Keep the formal title concise when the source line also contains an
    # explanatory sentence about how the table should be interpreted.
    caption = re.split(r"[。！？!?]", caption, maxsplit=1)[0].strip()
    return caption


def parse_table_lines(table_lines: list[str]) -> tuple[list[list[str]], list[str]]:
    """Parse Markdown rows and alignment markers for the LaTeX table renderer."""

    parsed_rows: list[list[str]] = []
    alignments: list[str] = []
    for table_line in table_lines:
        cells = [cell.strip() for cell in table_line.strip("|").split("|")]
        if cells and all(re.fullmatch(r":?-+:?", cell.replace(" ", "")) for cell in cells):
            for cell in cells:
                marker = cell.replace(" ", "")
                if marker.startswith(":") and marker.endswith(":"):
                    alignments.append("center")
                elif marker.endswith(":"):
                    alignments.append("right")
                elif marker.startswith(":"):
                    alignments.append("left")
                else:
                    alignments.append("left")
            continue
        parsed_rows.append(cells)
    return parsed_rows, alignments


def render_body(body_lines: list[str], image_context: tuple[Path, Path] | None = None) -> str:
    """Render report content and use the source/project directories for local image assets."""

    output: list[str] = []
    paragraph: list[str] = []
    paragraph_noindent = False
    pending_equation_explanation_noindent = False
    first_section = True
    heading_numbers = [0, 0, 0]
    figure_number = 0
    i = 0

    def flush_paragraph() -> None:
        nonlocal paragraph_noindent
        if paragraph:
            rendered = escape_text(" ".join(part.strip() for part in paragraph))
            if paragraph_noindent:
                rendered = r"\noindent " + rendered
            output.append(rendered)
            output.append("")
            paragraph.clear()
            paragraph_noindent = False

    while i < len(body_lines):
        raw = body_lines[i].rstrip("\n")
        stripped = raw.strip()

        if not stripped:
            flush_paragraph()
            i += 1
            continue

        heading_match = HEADING.match(raw)
        if heading_match:
            flush_paragraph()
            pending_equation_explanation_noindent = False
            level = len(heading_match.group(1))
            numbered = parse_numbered_heading(heading_match.group(2), level)
            title = numbered[1] if numbered else heading_match.group(2).strip()
            previous_output = next((item for item in reversed(output) if item), "")
            previous_heading = re.match(
                r"^\\(section|subsection|subsubsection|paragraph)\{",
                previous_output,
            )
            if previous_heading:
                transition = (previous_heading.group(1), level)
                if transition == ("section", 2):
                    output.append(r"\reportsectiontosubsectiongap")
                elif transition == ("subsection", 3):
                    output.append(r"\reportsubsectiontosubsubsectiongap")
            if level == 1 and not first_section:
                output.append(r"\clearpage")
            if level <= 3 and (numbered or level > 1):
                command = ("section", "subsection", "subsubsection")[level - 1]
                number = numbered[0] if numbered else tuple(
                    heading_numbers[:level - 1] + [heading_numbers[level - 1] + 1]
                )
                if number[:-1] != tuple(heading_numbers[:level - 1]):
                    raise ValueError(f"Heading number {'.'.join(map(str, number))} does not match its parent heading")
                if number[-1] != heading_numbers[level - 1] + 1:
                    output.append(r"\setcounter{" + command + "}{" + str(number[-1] - 1) + "}")
                heading_numbers[level - 1] = number[-1]
                heading_numbers[level:] = [0] * (3 - level)
                if level == 1:
                    figure_number = 0
            if level == 1:
                command = r"\section{" if numbered else r"\section*{"
                output.append(command + escape_text(title) + "}")
                # The supplied source explicitly labels the two defect-dataset
                # tables in Chapter 4 as 表4-2 and 表4-3; 表4-1 is not present
                # in the Markdown, so preserve the source numbering gap.
                if title == "高分辨率视觉关系提取应用":
                    output.append(r"\setcounter{table}{1}")
                first_section = False
            elif level == 2:
                output.append(r"\subsection{" + escape_text(title) + "}")
            elif level == 3:
                output.append(r"\subsubsection{" + escape_text(title) + "}")
            else:
                output.append(r"\paragraph{" + escape_text(title) + "}")
            output.append("")
            i += 1
            continue

        if stripped in (r"\[", "$$"):
            flush_paragraph()
            # A blank source line before an equation ends the preceding prose
            # paragraph. Do not preserve that blank as a second, empty LaTeX
            # paragraph: starting display math from vertical mode would create
            # an empty body line before the equation.
            while output and output[-1] == "":
                output.pop()
            equation: list[str] = []
            end_marker = r"\]" if stripped == r"\[" else "$$"
            i += 1
            while i < len(body_lines) and body_lines[i].strip() != end_marker:
                equation.append(body_lines[i])
                i += 1
            if i >= len(body_lines):
                raise ValueError("Unterminated display equation")
            output.append(render_equation(equation))
            pending_equation_explanation_noindent = not equation_ends_sentence(equation)
            i += 1
            continue

        if stripped.startswith("表"):
            next_nonblank = i + 1
            while next_nonblank < len(body_lines) and not body_lines[next_nonblank].strip():
                next_nonblank += 1
            if next_nonblank >= len(body_lines) or not body_lines[next_nonblank].lstrip().startswith("|"):
                paragraph.append(raw)
                i += 1
                continue

            # Some source paragraphs introduce a table with an inline sentence,
            # e.g. “表1-1给出了……。”  Promote that sentence to the formal
            # caption while keeping any explanatory remainder as body text.
            caption = ""
            if paragraph:
                paragraph_text = " ".join(part.strip() for part in paragraph).strip()
                inline_match = re.match(
                    r"^表\s*[0-9]+[-－][0-9]+\s*(?:给出(?:了)?|列出(?:了)?)?\s*([^。！？!?]+)[。！？!?](.*)$",
                    paragraph_text,
                )
                if inline_match:
                    caption = inline_match.group(1).strip()
                    remainder = inline_match.group(2).strip()
                    paragraph.clear()
                    if remainder:
                        paragraph.append(remainder)
            if not caption:
                caption = normalize_table_caption(stripped)
            flush_paragraph()
            pending_equation_explanation_noindent = False
            i = next_nonblank
            table_lines: list[str] = []
            while i < len(body_lines) and body_lines[i].lstrip().startswith("|"):
                table_lines.append(body_lines[i].strip())
                i += 1
            parsed_rows, alignments = parse_table_lines(table_lines)

            # Other source tables put the caption immediately after the table.
            # Move it above the body so the final report follows the governing
            # technical-report rule without changing the table data.
            after_table = i
            after_caption = None
            while after_table < len(body_lines) and not body_lines[after_table].strip():
                after_table += 1
            if after_table < len(body_lines):
                after_caption_text = normalize_table_caption(body_lines[after_table].strip())
                if after_caption_text:
                    after_caption = after_caption_text
                    i = after_table + 1
            if not caption and after_caption:
                caption = after_caption
            output.append(render_table(parsed_rows, caption or "实验结果", alignments))
            output.append("")
            continue

        # Tables whose caption is embedded in the preceding prose or placed
        # after the Markdown table still need to be recognized at the row
        # marker itself. This branch handles the latter form.
        if stripped.startswith("|"):
            flush_paragraph()
            pending_equation_explanation_noindent = False
            table_lines: list[str] = []
            while i < len(body_lines) and body_lines[i].strip().startswith("|"):
                table_lines.append(body_lines[i].strip())
                i += 1
            parsed_rows, alignments = parse_table_lines(table_lines)
            after_table = i
            caption = ""
            while after_table < len(body_lines) and not body_lines[after_table].strip():
                after_table += 1
            if after_table < len(body_lines):
                caption = normalize_table_caption(body_lines[after_table].strip())
                if caption:
                    i = after_table + 1
            output.append(render_table(parsed_rows, caption or "实验结果", alignments))
            output.append("")
            continue

        if stripped.startswith("!["):
            image = MARKDOWN_IMAGE.fullmatch(stripped)
            if image is None:
                raise ValueError("Unsupported Markdown figure image syntax; use a standalone local image reference")
            if image_context is None:
                raise ValueError("Figure images require the source Markdown directory and LaTeX project directory")
            alt = image.group(1).strip()
            caption = FIGURE_CAPTION.fullmatch(alt)
            next_nonblank = i + 1
            while next_nonblank < len(body_lines) and not body_lines[next_nonblank].strip():
                next_nonblank += 1
            following = (FIGURE_CAPTION.fullmatch(body_lines[next_nonblank].strip())
                         if next_nonblank < len(body_lines) else None)
            if caption and following and caption.groups() != following.groups():
                raise ValueError("Figure image alt caption disagrees with the following caption")
            caption = following or caption
            title = caption.group(3) if caption else alt
            if not title:
                raise ValueError("Figure image requires a supplied caption")
            if caption and int(caption.group(1)) != heading_numbers[0]:
                raise ValueError("Figure image caption number does not match the current chapter")
            serial = int(caption.group(2)) if caption else figure_number + 1
            if serial < 1:
                raise ValueError("Figure image caption serial must be positive")
            asset = prepare_image(*image_context, image.group(2) or image.group(3))
            flush_paragraph()
            pending_equation_explanation_noindent = False
            if serial != figure_number + 1:
                output.append(r"\setcounter{figure}{" + str(serial - 1) + "}")
            output.extend([
                r"\begin{figure}[htbp]",
                r"\centering",
                r"\includegraphics[width=\textwidth,height=0.65\textheight,keepaspectratio]{" + asset + "}",
                r"\caption{" + escape_text(title) + "}",
                r"\label{fig:" + str(heading_numbers[0]) + "-" + str(serial) + "}",
                r"\end{figure}", "",
            ])
            figure_number = serial
            i = next_nonblank + 1 if following else i + 1
            continue

        # Retain explicitly authored placeholder syntax for unfinished source figures.
        figure_match = re.match(r"^【图\s*[0-9]+[-－][0-9]+\s*占位：(.+?)】$", stripped)
        if figure_match:
            flush_paragraph()
            pending_equation_explanation_noindent = False
            description = figure_match.group(1).strip().rstrip("。")
            output.append(r"\reportfigureplaceholder{" + escape_text(description) + "}")
            figure_number += 1
            output.append("")
            i += 1
            continue

        if not paragraph:
            paragraph_noindent = (
                pending_equation_explanation_noindent and stripped.startswith("式中")
            )
            pending_equation_explanation_noindent = False
        paragraph.append(raw)
        i += 1

    flush_paragraph()
    return "\n".join(output).rstrip() + "\n"


def render_references(lines: list[str]) -> str:
    output = [r"\begin{reportbibliography}"]
    rendered = False
    for raw in lines:
        stripped = raw.strip()
        if not stripped:
            continue
        if "待补充来源" in stripped or "待填写" in stripped:
            continue
        match = re.match(r"^\[[0-9]+\]\s*(.*)$", stripped)
        if match:
            output.append(r"\reportbibitem{" + escape_text(match.group(1)) + "}")
        else:
            output.append(r"\reportbibitem{" + escape_text(stripped) + "}")
        rendered = True
    if not rendered:
        output.append(
            r"\reportbibitem{本报告源文档未提供完整参考文献条目，正文引用编号需在定稿前按原始文献补充核验}"
        )
    output.append(r"\end{reportbibliography}")
    return "\n".join(output) + "\n"


def split_report_sections(
    lines: list[str],
) -> tuple[list[str], list[str], list[tuple[str, str, list[str]]]]:
    """Separate body, references and labeled appendices at level-1 headings.

    Appendices may precede or follow references. Their single uppercase labels
    must be unique and increasing; authored gaps are retained at rendering.
    """

    body: list[str] = []
    references: list[str] = []
    appendices: list[tuple[str, str, list[str]]] = []
    current = body
    references_seen = False
    for line in lines:
        heading = HEADING.match(line)
        if heading and len(heading.group(1)) == 1:
            title = heading.group(2).strip()
            if title == "参考文献":
                if references_seen:
                    raise ValueError("Duplicate references heading")
                references_seen = True
                current = references
                continue
            if title.startswith("附录"):
                appendix = re.fullmatch(r"附录[ \t]*([A-Z])[ \t]+(\S.*)", title)
                if appendix is None:
                    raise ValueError("Invalid appendix heading; use a single uppercase label and title")
                label, appendix_title = appendix.groups()
                if appendices and label <= appendices[-1][0]:
                    raise ValueError("Duplicate or out-of-order appendix label")
                appendix_lines: list[str] = []
                appendices.append((label, appendix_title, appendix_lines))
                current = appendix_lines
                continue
            if current is not body:
                raise ValueError("Only level-1 appendix or references headings may follow the report body")
        current.append(line)
    return body, references, appendices


def render_appendices(
    appendices: list[tuple[str, str, list[str]]], image_context: tuple[Path, Path],
) -> str:
    """Use the class appendix counters and retain each appendix's body content."""

    if not appendices:
        return ""
    output = [r"\reportappendices"]
    previous_number = 0
    for label, title, lines in appendices:
        number = ord(label) - ord("A") + 1
        if number != previous_number + 1:
            output.append(r"\setcounter{section}{" + str(number - 1) + "}")
        output.append(r"\appendixsection{" + escape_text(title) + "}")
        output.append(render_body(lines, image_context))
        previous_number = number
    return "\n".join(output) + "\n"


def build_tex(source: Path, destination: Path, title_en: str) -> None:
    if not title_en.strip():
        raise ValueError("--title-en must contain the supplied English cover title")
    title_en = title_en.strip()
    lines = source.read_text(encoding="utf-8-sig").splitlines()
    title, abstract_cn, keywords_cn, abstract_en, keywords_en, body_start, _ = parse_front_matter(lines)
    body_lines, reference_lines, appendix_sections = split_report_sections(lines[body_start:])
    image_context = (source.parent.resolve(), destination.parent.resolve())
    body = render_body(body_lines, image_context)
    appendices = render_appendices(appendix_sections, image_context)
    references = render_references(reference_lines)
    today = dt.date.today()
    generated_report_date = f"{today.year}年{today.month}月{today.day}日"

    preamble = r"""\documentclass{techreport}

% Allow long mixed Chinese/math paragraphs to wrap without changing required body fonts.
\setlength{\emergencystretch}{4em}
\sloppy
% Chinese paragraphs containing inline math can have a short final line even
% when the page is visually sound; do not report that harmless badness.
\hbadness=10000

% Generated from the supplied Markdown. Missing metadata remains blank unless the
% report-generation date is required by the format. English metadata is supplied explicitly.
\techreportsetup{
  report-no={},
  class-no={},
  secret-level={},
  project-source={},
  title-cn={TITLE_CN},
  title-en={TITLE_EN},
  project-name={},
  series-no={},
  cooperator={},
  report-date={GENERATED_REPORT_DATE},
  work-period={},
  leader={},
  staff={},
  writer={},
  abstract-cn={ABSTRACT_CN},
  keywords-cn={KEYWORDS_CN},
  abstract-en={ABSTRACT_EN},
  keywords-en={KEYWORDS_EN}
}

\begin{document}

\makecover
\makeapproval
\reportfrontmatter
\makeabstract
\makereporttoc
\reportmainmatter

"""
    replacements = {
        "TITLE_CN": escape_text(title),
        "TITLE_EN": escape_text(title_en),
        "ABSTRACT_CN": render_abstract(abstract_cn),
        "KEYWORDS_CN": escape_text(keywords_cn),
        "ABSTRACT_EN": render_abstract(abstract_en),
        "KEYWORDS_EN": escape_text(keywords_en),
        "GENERATED_REPORT_DATE": escape_text(generated_report_date),
    }
    for key, value in replacements.items():
        preamble = preamble.replace(key, value)

    tex = preamble + body + "\n" + appendices + references + "\n\\end{document}\n"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(tex, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--title-en", required=True, help="Supplied English cover title; no automatic translation")
    args = parser.parse_args()
    try:
        build_tex(args.source.resolve(), args.destination.resolve(), args.title_en)
    except ValueError as exc:
        parser.error(str(exc))
    print(f"Wrote {args.destination.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
