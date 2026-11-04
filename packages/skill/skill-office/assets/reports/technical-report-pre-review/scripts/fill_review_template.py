from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt


# The retained template declares 方正仿宋_GBK.  FangSong preserves the intended
# 仿宋 appearance when that proprietary family is unavailable.
FONT_NAME = "FangSong"


@dataclass
class ExpertReview:
    number: int
    persona: str
    verdict: str
    opinions: list[str]
    reply: list[str]


@dataclass
class ReviewDraft:
    metadata: dict[str, str]
    experts: list[ExpertReview]


def parse_front_matter(lines: list[str]) -> tuple[dict[str, str], list[str]]:
    if not lines or lines[0].strip() != "---":
        raise ValueError("Markdown must start with YAML front matter.")
    try:
        end = next(index for index in range(1, len(lines)) if lines[index].strip() == "---")
    except StopIteration as exc:
        raise ValueError("YAML front matter is not closed.") from exc
    metadata: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"Invalid front matter line: {line}")
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip().strip("\"'")
    return metadata, lines[end + 1 :]


def parse_numbered_items(text: str, *, field_name: str) -> list[str]:
    items: list[str] = []
    expected_number = 1
    forbidden_labels = re.compile(r"^(?:总体评价|总体意见|综合评价)\s*[：:]")
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            raise ValueError(f"{field_name} cannot contain nested headings.")
        match = re.match(r"^(\d+)[.、]\s*(.+)$", line)
        if match:
            number = int(match.group(1))
            if number != expected_number:
                raise ValueError(
                    f"{field_name} numbering must start at 1 and continue without gaps; "
                    f"expected {expected_number}, found {number}."
                )
            item = match.group(2).strip()
            if forbidden_labels.match(item):
                raise ValueError(
                    f"{field_name} must express overall judgments as normal numbered opinions "
                    "without an explicit Overall Evaluation label."
                )
            items.append(item)
            expected_number += 1
        elif items:
            items[-1] = f"{items[-1]} {line}"
        else:
            raise ValueError(f"{field_name} must start directly with numbered item 1.")
    return items


def parse_review(path: Path) -> ReviewDraft:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    metadata, body_lines = parse_front_matter(lines)
    body = "\n".join(body_lines)
    second_level_headings = [
        heading.strip()
        for heading in re.findall(r"^##\s+(.+?)\s*$", body, re.MULTILINE)
    ]
    expected_headings = [f"专家{number}" for number in range(1, 6)]
    if second_level_headings != expected_headings:
        raise ValueError(
            "Markdown body must contain only Expert 1 through Expert 5 as second-level headings, in order."
        )
    matches = list(re.finditer(r"^##\s+专家([1-5])\s*$", body, re.MULTILINE))
    experts: list[ExpertReview] = []
    for index, match in enumerate(matches):
        number = int(match.group(1))
        section_end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        section = body[match.end() : section_end]
        third_level_headings = [
            heading.strip()
            for heading in re.findall(r"^###\s+(.+?)\s*$", section, re.MULTILINE)
        ]
        if third_level_headings != ["审查意见", "回复"]:
            raise ValueError(
                f"Expert {number} must contain only the headings Review Opinions and Reply in that order; "
                "do not add an Overall Evaluation heading."
            )
        persona_match = re.search(r"^审稿人类型[：:]\s*(.+)$", section, re.MULTILINE)
        verdict_match = re.search(r"^审查结论[：:]\s*(.+)$", section, re.MULTILINE)
        opinions_match = re.search(
            r"^###\s+审查意见\s*$([\s\S]*?)^###\s+回复\s*$",
            section,
            re.MULTILINE,
        )
        reply_match = re.search(r"^###\s+回复\s*$([\s\S]*)$", section, re.MULTILINE)
        if not persona_match or not verdict_match or not opinions_match or not reply_match:
            raise ValueError(f"Expert {number} is missing persona, verdict, opinions, or reply.")
        opinions = parse_numbered_items(
            opinions_match.group(1), field_name=f"Expert {number} review opinions"
        )
        reply_text = "\n".join(
            line.strip()
            for line in reply_match.group(1).splitlines()
            if line.strip() and not line.strip().startswith("#")
        )
        if reply_text and re.match(r"^1[.、]", reply_text):
            reply = parse_numbered_items(reply_text, field_name=f"Expert {number} reply")
        else:
            reply = [reply_text] if reply_text else []
        experts.append(
            ExpertReview(
                number=number,
                persona=persona_match.group(1).strip(),
                verdict=verdict_match.group(1).strip(),
                opinions=opinions,
                reply=reply or ["（待项目组填写）"],
            )
        )
    draft = ReviewDraft(metadata=metadata, experts=experts)
    validate_review(draft)
    return draft


def validate_review(draft: ReviewDraft) -> None:
    required = {"project_name", "lead_unit", "invited", "returned", "approved", "rejected"}
    missing = sorted(required - set(draft.metadata))
    if missing:
        raise ValueError(f"Missing metadata fields: {', '.join(missing)}")
    counts: dict[str, int] = {}
    for key in ("invited", "returned", "approved", "rejected"):
        try:
            counts[key] = int(draft.metadata[key])
        except ValueError as exc:
            raise ValueError(f"{key} must be an integer.") from exc
        if counts[key] < 0:
            raise ValueError(f"{key} cannot be negative.")
    if counts["approved"] + counts["rejected"] != counts["returned"]:
        raise ValueError("approved + rejected must equal returned.")
    if [expert.number for expert in draft.experts] != [1, 2, 3, 4, 5]:
        raise ValueError("Expert sections must be numbered 1 through 5 in order.")
    if len({expert.persona for expert in draft.experts}) != 5:
        raise ValueError("Reviewer personas must be distinct.")
    for expert in draft.experts:
        if not 1 <= len(expert.opinions) <= 4:
            raise ValueError(f"Expert {expert.number} must have 1 to 4 opinions.")
        if not expert.verdict:
            raise ValueError(f"Expert {expert.number} has no verdict.")


def set_font(run, *, bold: bool = False, size: float = 14.0) -> None:
    run.font.name = FONT_NAME
    run.font.size = Pt(size)
    run.font.bold = True if bold else None
    run.font.color.rgb = None
    run.font.highlight_color = None
    r_pr = run._element.get_or_add_rPr()
    r_fonts = r_pr.rFonts
    if r_fonts is None:
        r_fonts = OxmlElement("w:rFonts")
        r_pr.insert(0, r_fonts)
    for attribute in ("ascii", "hAnsi", "eastAsia", "cs"):
        r_fonts.set(qn(f"w:{attribute}"), FONT_NAME)
    r_fonts.set(qn("w:hint"), "eastAsia")
    for node in r_pr.findall(qn("w:szCs")):
        r_pr.remove(node)
    size_cs = OxmlElement("w:szCs")
    size_cs.set(qn("w:val"), str(int(round(size * 2))))
    r_pr.append(size_cs)
    # Match the source document's East Asian run properties exactly.
    for tag in ("w:b", "w:bCs"):
        for node in r_pr.findall(qn(tag)):
            r_pr.remove(node)
        if bold:
            r_pr.append(OxmlElement(tag))


def clear_cell(cell) -> None:
    tc_pr = cell._tc.tcPr
    for child in list(cell._tc):
        if child is not tc_pr:
            cell._tc.remove(child)
    cell._tc.append(OxmlElement("w:p"))


def apply_paragraph_style(paragraph, document, *, indent: bool) -> None:
    if "p0" in [style.name for style in document.styles]:
        paragraph.style = document.styles["p0"]
    paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
    paragraph.paragraph_format.first_line_indent = Cm(0.99) if indent else None


def add_text_paragraph(cell, document, text: str, *, bold: bool, indent: bool, first: bool = False):
    paragraph = cell.paragraphs[0] if first else cell.add_paragraph()
    apply_paragraph_style(paragraph, document, indent=indent)
    run = paragraph.add_run(text)
    set_font(run, bold=bold)
    return paragraph


def replace_cell_value(cell, document, text: str, *, bold: bool = True) -> None:
    clear_cell(cell)
    add_text_paragraph(cell, document, text, bold=bold, indent=False, first=True)


def fill_document(draft: ReviewDraft, template_path: Path, output_path: Path) -> None:
    if template_path.resolve() == output_path.resolve():
        raise ValueError("Output path must differ from template path.")
    document = Document(template_path)
    if not document.tables or len(document.tables[0].rows) < 9:
        raise ValueError("Template must contain the expected nine-row table.")
    table = document.tables[0]
    meta = draft.metadata
    replace_cell_value(table.rows[0].cells[1], document, meta["project_name"])
    replace_cell_value(table.rows[1].cells[1], document, meta["lead_unit"])
    replace_cell_value(table.rows[2].cells[1], document, f"聘请{meta['invited']}人")
    replace_cell_value(table.rows[2].cells[2], document, f"回收{meta['returned']}份")
    replace_cell_value(table.rows[3].cells[1], document, f"同意通过{meta['approved']}份")
    replace_cell_value(table.rows[3].cells[2], document, f"不同意通过{meta['rejected']}份")

    for expert in draft.experts:
        row = table.rows[expert.number + 3]
        properties = row._tr.get_or_add_trPr()
        if properties.find(qn("w:cantSplit")) is None:
            properties.append(OxmlElement("w:cantSplit"))
        cell = row.cells[0]
        clear_cell(cell)
        add_text_paragraph(
            cell,
            document,
            f"专家{expert.number}：",
            bold=True,
            indent=False,
            first=True,
        )
        for index, opinion in enumerate(expert.opinions, start=1):
            add_text_paragraph(
                cell,
                document,
                f"{index}. {opinion}",
                bold=False,
                indent=True,
            )
        add_text_paragraph(cell, document, "回复：", bold=True, indent=False)
        for index, reply in enumerate(expert.reply, start=1):
            text = reply if reply == "（待项目组填写）" else f"{index}. {reply}"
            add_text_paragraph(cell, document, text, bold=False, indent=True)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    document.save(output_path)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate a review Markdown file and fill the retained Word template."
    )
    parser.add_argument("markdown", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--template",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "assets" / "pre_review_template.docx",
    )
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    draft = parse_review(args.markdown)
    if args.validate_only:
        print("VALID")
        return
    fill_document(draft, args.template, args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
