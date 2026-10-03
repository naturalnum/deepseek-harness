#!/usr/bin/env python3
"""校验生成后的技术报告 DOCX 页面、分节、页眉和页脚。"""

import os
import re
import zipfile
from xml.etree import ElementTree as ET

from config import (
    COVER_BOTTOM_BLOCK_WIDTH_MM,
    COVER_BOTTOM_FONT_SIZE_PT,
    COVER_HEITI_FONT,
    COVER_METADATA_FONT_SIZE_PT,
    COVER_PROJECT_SOURCE_FONT_SIZE_PT,
    COVER_SERIES_FONT_SIZE_PT,
    COVER_TITLE_CN_FONT_SIZE_PT,
    FOOTER_DISTANCE_MM,
    HEADER_DISTANCE_MM,
    PAGE_HEIGHT_MM,
    PAGE_MARGIN_BOTTOM_MM,
    PAGE_MARGIN_LEFT_MM,
    PAGE_MARGIN_RIGHT_MM,
    PAGE_MARGIN_TOP_MM,
    PAGE_WIDTH_MM,
    REPORT_WRITING_UNIT,
)
from cover_layout import calculate_cover_metadata_indents_twips
from catalog_cache import _ranges

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
VML_NS = "urn:schemas-microsoft-com:vml"
M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"
W = f"{{{W_NS}}}"
R = f"{{{R_NS}}}"
PR = f"{{{PR_NS}}}"
V = f"{{{VML_NS}}}"
M = f"{{{M_NS}}}"


def _twips(mm):
    return round(mm * 1440 / 25.4)


def _attr(element, name, default=None):
    if element is None:
        return default
    return element.get(f"{W}{name}", default)


def _close(actual, expected, tolerance=3):
    try:
        return abs(int(actual) - int(expected)) <= tolerance
    except (TypeError, ValueError):
        return False


def _part_text(root):
    return "".join(root.itertext()).strip()


def _has_page_field(root):
    return any(
        re.search(r"\bPAGE\b", element.text or "")
        for element in root.iter(f"{W}instrText")
    )


def _default_reference(section, tag):
    for element in section.findall(f"{W}{tag}Reference"):
        ref_type = _attr(element, "type", "default")
        if ref_type == "default":
            return element.get(f"{R}id")
    return None


def _resolve_reference(sections, index, tag):
    for current in range(index, -1, -1):
        rel_id = _default_reference(sections[current], tag)
        if rel_id:
            return rel_id
    return None


def _paragraph_text(paragraph):
    return "".join(element.text or "" for element in paragraph.iter(f"{W}t"))


GBT7714_TYPE_RE = re.compile(r"\[(J|M|C|D|R|S|P|N|DB|CP|EB|DS(?=\]|/OL\]))(?:/(OL|DK|CD|MT))?\]")
GBT7714_CITATION_DATE_RE = re.compile(r"\[\d{4}-\d{2}-\d{2}\]")
FORMULA_NUMBER_RE = re.compile(r"^（[A-Z0-9]+-\d+）$")
INLINE_SYMBOL_RE = re.compile(
    r"[!-/:-@\[-`{-~]"
    r"|[\u2000-\u206F\u2100-\u214F\u2190-\u22FF\u2300-\u23FF]"
    r"|[\u2460-\u24FF\u25A0-\u25FF\u3000-\u303F\uFF00-\uFF65]"
    r"|[°℃‰±×÷≈≠≤≥∞√∑∏∫∂∇μΩαβγδΔλφθσ]"
)
RAW_MATH_MARKER_RE = re.compile(r"\[\[TECH_REPORT_(?:INLINE_)?MATH_B64:[A-Za-z0-9_=-]+\]\]")
RAW_LATEX_DELIMITER_RE = re.compile(r"\$\$|\\\[|\\\]|\\\(|\\\)")
RAW_LATEX_COMMAND_RE = re.compile(
    r"\\(?:frac|dfrac|tfrac|sum|prod|int|oint|sqrt|alpha|beta|gamma|delta|lambda|mu|sigma|theta|phi|omega|"
    r"mathrm|mathbf|mathit|text|begin|end|left|right|cdot|times|leq|geq|neq|infty|partial|nabla|tag|overline|hat|bar)\b"
)
RAW_LATEX_SCRIPT_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*[_^]\{[^{}]+\}")
RAW_INLINE_DOLLAR_RE = re.compile(r"(?<!\\)(?<!\$)\$(?!\$)(.+?)(?<!\\)\$(?!\$)")


def _element_contains_math(element):
    return (
        element.find(f".//{M}oMath") is not None
        or element.find(f".//{M}oMathPara") is not None
    )


def _is_display_formula_block(element):
    if element.tag == f"{W}tbl":
        return _element_contains_math(element)
    if element.tag != f"{W}p" or not _element_contains_math(element):
        return False
    plain_text = _paragraph_text(element).strip()
    return not plain_text or FORMULA_NUMBER_RE.fullmatch(plain_text) is not None


def _paragraph_has_zero_first_line_indent(paragraph):
    indent = paragraph.find(f"./{W}pPr/{W}ind")
    if indent is None:
        return False
    first_line = _attr(indent, "firstLine")
    first_line_chars = _attr(indent, "firstLineChars")
    return (
        first_line in (None, "0")
        and first_line_chars in (None, "0")
        and (first_line == "0" or first_line_chars == "0")
    )


def _formula_following_paragraph_indent_errors(document):
    """检查独立公式后的第一个实际文字段落是否取消首行缩进。"""
    body = document.find(f"{W}body")
    if body is None:
        return []
    children = list(body)
    errors = []
    seen_targets = set()

    for index, child in enumerate(children):
        if not _is_display_formula_block(child):
            continue
        for candidate in children[index + 1 :]:
            if candidate.tag == f"{W}tbl":
                if _is_display_formula_block(candidate):
                    continue
                break
            if candidate.tag != f"{W}p":
                continue
            if _is_display_formula_block(candidate):
                continue
            text = _paragraph_text(candidate).strip()
            if not text:
                continue
            if FORMULA_NUMBER_RE.fullmatch(text):
                continue
            key = id(candidate)
            if key not in seen_targets and not _paragraph_has_zero_first_line_indent(candidate):
                errors.append(
                    f"公式后的段落“{text[:30]}”首行不应缩进"
                )
                seen_targets.add(key)
            break
    return errors


def _gbt7714_reference_error(text):
    marker = GBT7714_TYPE_RE.search(text)
    if marker is None:
        return "缺少 GB/T 7714—2015 文献类型标识"
    if marker.group(2) == "OL":
        if GBT7714_CITATION_DATE_RE.search(text) is None:
            return "联机电子资源缺少引用日期 [YYYY-MM-DD]"
        if re.search(r"https?://\S+", text) is None:
            return "联机电子资源缺少 http(s) URL"
    if not text.endswith("."):
        return "条目应以半角句点 . 结束"
    return None


def _paragraph_text_with_breaks(paragraph):
    parts = []
    for element in paragraph.iter():
        if element.tag == f"{W}t":
            parts.append(element.text or "")
        elif element.tag == f"{W}br":
            parts.append("\n")
    return "".join(parts)


def _approval_person_name_spacing_errors(paragraphs):
    """仅检查审批页已填写的人员字段，不检查其他页面的人名。"""
    start = next(
        (
            i
            for i, paragraph in enumerate(paragraphs)
            if _paragraph_text(paragraph).strip().startswith("工作单位：")
        ),
        None,
    )
    if start is None:
        return []

    end = len(paragraphs)
    for i in range(start, len(paragraphs)):
        if paragraphs[i].find(f"./{W}pPr/{W}sectPr") is not None:
            end = i + 1
            break

    approval_paragraphs = paragraphs[start:end]
    errors = []
    two_char_name = re.compile(
        r"(?<![\u4e00-\u9fff])[\u4e00-\u9fff]{2}(?![\u4e00-\u9fff])"
    )
    for label in ("项目负责人", "工作人员", "报告编写"):
        prefix_re = re.compile(rf"^{re.escape(label)}\s*[:：]?\s*")
        paragraph = next(
            (
                item
                for item in approval_paragraphs
                if prefix_re.match(_paragraph_text(item).strip())
            ),
            None,
        )
        if paragraph is None:
            continue
        value = prefix_re.sub("", _paragraph_text(paragraph).strip(), count=1).strip()
        if value and two_char_name.search(value):
            errors.append(
                f"审批页{label}中的两字中文姓名应在两个字之间加入一个半角空格"
            )
    return errors


def _field_instructions(paragraph):
    return "".join(
        element.text or "" for element in paragraph.iter(f"{W}instrText")
    )


def _text_run_properties(paragraph):
    properties = []
    for run in paragraph.findall(f"{W}r"):
        if not "".join(node.text or "" for node in run.iter(f"{W}t")):
            continue
        run_properties = run.find(f"{W}rPr")
        fonts = run_properties.find(f"{W}rFonts") if run_properties is not None else None
        size = run_properties.find(f"{W}sz") if run_properties is not None else None
        bold = run_properties.find(f"{W}b") if run_properties is not None else None
        bold_value = _attr(bold, "val", "true") if bold is not None else "false"
        properties.append(
            {
                "eastAsia": fonts.get(f"{W}eastAsia") if fonts is not None else None,
                "ascii": fonts.get(f"{W}ascii") if fonts is not None else None,
                "size": _attr(size, "val"),
                "bold": str(bold_value).lower() not in ("0", "false", "off", "none"),
            }
        )
    return properties


def _paragraph_format_matches(paragraph, *, east_asia, size, ascii_font=None, bold=False):
    properties = _text_run_properties(paragraph)
    if not properties:
        return False
    return all(
        item["eastAsia"] == east_asia
        and item["size"] == str(size)
        and (ascii_font is None or item["ascii"] == ascii_font)
        and item["bold"] is bold
        for item in properties
    )


def _is_english_dominant(text):
    letters = len(re.findall(r"[A-Za-z]", text))
    chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
    return letters > chinese * 2 and letters >= 8


def _has_page_break_before(paragraph):
    page_break = paragraph.find(f"./{W}pPr/{W}pageBreakBefore")
    if page_break is None:
        return False
    return str(_attr(page_break, "val", "true")).lower() not in (
        "0",
        "false",
        "off",
        "none",
    )


def _paragraph_style_name(paragraph, style_names):
    style = paragraph.find(f"./{W}pPr/{W}pStyle")
    return style_names.get(_attr(style, "val"), "")


def _run_flag_enabled(run_properties, tag):
    node = run_properties.find(f"{W}{tag}") if run_properties is not None else None
    if node is None:
        return False
    return str(_attr(node, "val", "true")).lower() not in (
        "0", "false", "off", "none",
    )


def _raw_latex_math_errors(document):
    """Block DOCX delivery when Markdown/LaTeX source leaked into visible Word text."""
    errors = []
    for paragraph in document.findall(f".//{W}body//{W}p"):
        text = _paragraph_text(paragraph).strip()
        if not text:
            continue
        problem = None
        if RAW_MATH_MARKER_RE.search(text):
            problem = "残留内部公式标记，未转换为 Word 原生公式"
        elif RAW_LATEX_DELIMITER_RE.search(text):
            problem = "残留 LaTeX 公式定界符"
        elif RAW_LATEX_COMMAND_RE.search(text) or RAW_LATEX_SCRIPT_RE.search(text):
            problem = "残留 LaTeX 公式命令/上下标源码"
        else:
            for match in RAW_INLINE_DOLLAR_RE.finditer(text):
                body = match.group(1).strip()
                if body and ("\\" in body or not re.search(r"[\u4e00-\u9fff]", body)):
                    problem = "残留 $...$ 行内公式源码"
                    break
        if problem:
            snippet = re.sub(r"\s+", " ", text)[:60]
            errors.append(f"{problem}: “{snippet}”")
            if len(errors) >= 10:
                break
    return errors


def _inline_symbol_run_format_errors(document, style_names):
    """检查正文普通文本 run 中符号是否仍带异常字体/字号/装饰属性。"""
    paragraphs = document.findall(f".//{W}body/{W}p")
    texts = [_paragraph_text(item).strip() for item in paragraphs]
    body_start = next(
        (
            index for index, (paragraph, text) in enumerate(zip(paragraphs, texts))
            if _paragraph_style_name(paragraph, style_names).lower() == "heading 1"
            and re.match(r"^1\s+\S", text)
        ),
        None,
    )
    if body_start is None:
        return []

    errors = []
    for paragraph, text in zip(paragraphs[body_start:], texts[body_start:]):
        if not text:
            continue
        style_name = _paragraph_style_name(paragraph, style_names).lower()
        if (
            style_name.startswith("toc ")
            or style_name in ("heading 1", "heading 2", "heading 3", "002二级标题", "003三级标题", "caption")
            or re.match(r"^附录\s+[A-Z]\s+\S", text)
            or re.match(r"^(?:图|表)\s*[A-Z]?\d+-\d+\s*\S", text)
            or re.match(r"^(?:注(?:\s*\d+)?[:：]|[a-z]\s+\S)", text)
            or text == "参考文献"
        ):
            continue
        jc = paragraph.find(f"./{W}pPr/{W}jc")
        if _attr(jc, "val") in ("center", "right") and len(text) < 120:
            continue

        for run in paragraph.findall(f"{W}r"):
            run_text = "".join(node.text or "" for node in run.iter(f"{W}t"))
            if not run_text or INLINE_SYMBOL_RE.search(run_text) is None:
                continue
            if any(
                run.find(f".//{W}{tag}") is not None
                for tag in (
                    "fldChar", "instrText", "drawing", "object", "pict",
                    "footnoteReference", "endnoteReference", "commentReference",
                )
            ):
                continue
            if run.find(f".//{M}oMath") is not None:
                continue
            run_properties = run.find(f"{W}rPr")
            if run_properties is not None and run_properties.find(f"{W}vertAlign") is not None:
                continue
            fonts = run_properties.find(f"{W}rFonts") if run_properties is not None else None
            size = run_properties.find(f"{W}sz") if run_properties is not None else None
            size_cs = run_properties.find(f"{W}szCs") if run_properties is not None else None
            bad_theme = bool(
                fonts is not None
                and any(
                    fonts.get(f"{W}{name}") is not None
                    for name in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme", "hint")
                )
            )
            bad_font = (
                fonts is None
                or fonts.get(f"{W}eastAsia") != "宋体"
                or fonts.get(f"{W}ascii") != "Times New Roman"
                or fonts.get(f"{W}hAnsi") != "Times New Roman"
            )
            bad_size = _attr(size, "val") != "24" or _attr(size_cs, "val") != "24"
            bad_decoration = (
                _run_flag_enabled(run_properties, "b")
                or _run_flag_enabled(run_properties, "i")
                or _run_flag_enabled(run_properties, "u")
            )
            if bad_theme or bad_font or bad_size or bad_decoration:
                errors.append(
                    f"正文段内符号 run“{run_text[:24]}”字体/字号/装饰属性未归一化"
                )
                if len(errors) >= 10:
                    return errors
    return errors


def validate_report(path):
    errors = []
    warnings = []

    if not os.path.isfile(path):
        return {"valid": False, "errors": [f"文件不存在: {path}"], "warnings": []}

    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        return {"valid": False, "errors": [f"DOCX 文件无效: {exc}"], "warnings": []}

    with archive:
        try:
            document = ET.fromstring(archive.read("word/document.xml"))
            relationships = ET.fromstring(
                archive.read("word/_rels/document.xml.rels")
            )
            styles = ET.fromstring(archive.read("word/styles.xml"))
        except (KeyError, ET.ParseError) as exc:
            return {
                "valid": False,
                "errors": [f"DOCX 核心结构无效: {exc}"],
                "warnings": [],
            }

        rel_targets = {
            element.get("Id"): element.get("Target")
            for element in relationships.findall(f"{PR}Relationship")
        }
        style_names = {
            _attr(style, "styleId"): _attr(style.find(f"{W}name"), "val", "")
            for style in styles.findall(f"{W}style")
        }
        sections = document.findall(f".//{W}sectPr")
        if len(sections) < 5:
            errors.append(f"成品报告至少应有 5 个分节，当前为 {len(sections)} 个")

        expected_page = (_twips(PAGE_WIDTH_MM), _twips(PAGE_HEIGHT_MM))
        expected_margins = {
            "top": _twips(PAGE_MARGIN_TOP_MM),
            "bottom": _twips(PAGE_MARGIN_BOTTOM_MM),
            "left": _twips(PAGE_MARGIN_LEFT_MM),
            "right": _twips(PAGE_MARGIN_RIGHT_MM),
            "header": _twips(HEADER_DISTANCE_MM),
            "footer": _twips(FOOTER_DISTANCE_MM),
        }

        for index, section in enumerate(sections, start=1):
            page_size = section.find(f"{W}pgSz")
            if not (
                _close(_attr(page_size, "w"), expected_page[0])
                and _close(_attr(page_size, "h"), expected_page[1])
            ):
                errors.append(f"第 {index} 节不是 A4 纵向页面")

            margins = section.find(f"{W}pgMar")
            for name, expected in expected_margins.items():
                if not _close(_attr(margins, name), expected):
                    errors.append(f"第 {index} 节的 {name} 页面参数不符合规范")

        if len(sections) >= 5:
            abstract_numbering = sections[2].find(f"{W}pgNumType")
            if not (
                _attr(abstract_numbering, "fmt") == "lowerRoman"
                and _attr(abstract_numbering, "start") == "1"
            ):
                errors.append("摘要页应使用从 i 开始的小写罗马页码")

            toc_numbering = sections[-2].find(f"{W}pgNumType")
            if _attr(toc_numbering, "fmt") != "lowerRoman":
                errors.append("目录页应延续小写罗马页码")

            body_numbering = sections[-1].find(f"{W}pgNumType")
            if not (
                _attr(body_numbering, "fmt") == "decimal"
                and _attr(body_numbering, "start") == "1"
            ):
                errors.append("正文应从阿拉伯数字第 1 页重新编号")

        part_cache = {}

        def load_related(rel_id):
            if not rel_id:
                return None
            target = rel_targets.get(rel_id)
            if not target:
                return None
            part_name = target if target.startswith("word/") else f"word/{target}"
            if part_name not in part_cache:
                try:
                    part_cache[part_name] = ET.fromstring(archive.read(part_name))
                except (KeyError, ET.ParseError):
                    part_cache[part_name] = None
            return part_cache[part_name]

        body_header_text = ""
        cover_footer = None
        if sections:
            cover_footer = load_related(
                _resolve_reference(sections, 0, "footer")
            )
            for index in range(min(2, len(sections))):
                footer = load_related(_resolve_reference(sections, index, "footer"))
                if footer is not None and _has_page_field(footer):
                    errors.append(f"第 {index + 1} 节不应显示页码")

            if len(sections) >= 3:
                abstract_footer = load_related(
                    _resolve_reference(sections, 2, "footer")
                )
                if abstract_footer is None or not _has_page_field(abstract_footer):
                    errors.append("摘要页缺少 PAGE 页码域")

            body_footer = load_related(
                _resolve_reference(sections, len(sections) - 1, "footer")
            )
            if body_footer is None or not _has_page_field(body_footer):
                errors.append("正文页脚缺少 PAGE 页码域")

            for index in range(max(0, len(sections) - 1)):
                header = load_related(_resolve_reference(sections, index, "header"))
                if header is not None and _part_text(header):
                    errors.append(f"第 {index + 1} 节不应显示正文页眉")

            body_header = load_related(
                _resolve_reference(sections, len(sections) - 1, "header")
            )
            if body_header is None or not _part_text(body_header):
                errors.append("正文缺少中文报告名称页眉")
            else:
                body_header_text = _part_text(body_header)
                if body_header.find(f".//{W}pBdr/{W}bottom") is None:
                    errors.append("正文页眉与正文之间缺少下边框")

        paragraphs = [
            paragraph
            for paragraph in document.findall(f".//{W}body/{W}p")
            if paragraph.find(f".//{W}txbxContent") is None
        ]

        errors.extend(_approval_person_name_spacing_errors(paragraphs))
        errors.extend(_formula_following_paragraph_indent_errors(document))
        errors.extend(_inline_symbol_run_format_errors(document, style_names))
        errors.extend(_raw_latex_math_errors(document))

        # 主目录、图目录、表目录必须同时存在。图/表目录使用隐藏 TC 域
        # 收集图题/表题，并复用 TOC 样式，因此更新域后可得到与主目录
        # 一致的字体、行距、点引导线和页码对齐。
        field_instructions = [_field_instructions(paragraph) for paragraph in paragraphs]
        try:
            toc_cache_paragraph_ids = {id(node) for _, nodes in _ranges(document).values() for node in nodes}
        except ValueError as exc:
            errors.append("目录域结构错误: " + str(exc))
            toc_cache_paragraph_ids = set()
        if not any("TOC" in ins and '\\o "1-3"' in ins for ins in field_instructions):
            errors.append("缺少主目录 TOC 域")
        if not any(re.search(r"\\f\s+F(?:\s|$)", ins) for ins in field_instructions if "TOC" in ins):
            errors.append("缺少图目录 TOC 域")
        if not any(re.search(r"\\f\s+T(?:\s|$)", ins) for ins in field_instructions if "TOC" in ins):
            errors.append("缺少表目录 TOC 域")
        paragraph_texts = [_paragraph_text(paragraph).strip() for paragraph in paragraphs]
        if "图目录" in paragraph_texts or "表目录" in paragraph_texts:
            errors.append("主目录后的图/表条目不得设置独立的“图目录”或“表目录”可见标题")
        figure_caption_re = re.compile(r"^图\s*[A-Z0-9]+-\d+[ \t\u3000]+\S+")
        table_caption_re = re.compile(r"^表\s*[A-Z0-9]+-\d+[ \t\u3000]+\S+")
        explanatory_lead_re = re.compile(
            r"^(?:图|表)\s*[A-Z0-9]+-\d+\s*[：:]?\s*(?:应表达|应展示|应给出|给出|展示|"
            r"显示|表明|说明|反映|可见|所示|用于表达|用于展示|用于说明|用于给出)"
        )
        for paragraph in paragraphs:
            if id(paragraph) in toc_cache_paragraph_ids:
                continue
            text = re.sub(r"\s+", " ", _paragraph_text(paragraph).strip())
            instruction = _field_instructions(paragraph)
            has_fig_tc = bool(re.search(r"\bTC\b.*\\f\s+F(?:\s|$)", instruction))
            has_table_tc = bool(re.search(r"\bTC\b.*\\f\s+T(?:\s|$)", instruction))
            is_figure_caption = bool(figure_caption_re.match(text)) and not explanatory_lead_re.match(text)
            is_table_caption = (
                bool(table_caption_re.match(text))
                and not explanatory_lead_re.match(text)
                and not re.match(r"^表\s*[A-Z0-9]+-\d+[ \t\u3000]+[（(]续[)）]", text)
            )
            if is_figure_caption and not has_fig_tc:
                errors.append(f"图题“{text[:30]}”缺少图目录 TC 域")
            if is_table_caption and not has_table_tc:
                errors.append(f"表题“{text[:30]}”缺少表目录 TC 域")
            if has_fig_tc and not is_figure_caption:
                errors.append(f"非图题段落不得写入图目录 TC 域：“{text[:30]}”")
            if has_table_tc and not is_table_caption:
                errors.append(f"非表题段落不得写入表目录 TC 域：“{text[:30]}”")
            if explanatory_lead_re.match(text):
                errors.append(
                    f"图表说明段不得以图号/表号起句，应改写为“该图/该表/上述趋势”等：“{text[:30]}”"
                )

        for text in paragraph_texts:
            if re.search(
                r"未找到[^。；;]{0,20}目录项|No table of (?:contents|figures|tables) entries found",
                text,
                flags=re.IGNORECASE,
            ):
                errors.append("目录区域仍显示“未找到目录项”类错误文本，主目录/图目录/表目录尚未正确更新")

        cover_paragraphs = []
        for paragraph in paragraphs:
            cover_paragraphs.append(paragraph)
            if paragraph.find(f"./{W}pPr/{W}sectPr") is not None:
                break

        cover_body_tables = []
        body = document.find(f"{W}body")
        for child in list(body) if body is not None else []:
            if (
                child.tag == f"{W}p"
                and child.find(f"./{W}pPr/{W}sectPr") is not None
            ):
                break
            if child.tag != f"{W}tbl":
                continue
            cover_body_tables.append(child)

        bottom_textboxes = [
            shape
            for shape in document.iter(f"{V}shape")
            if shape.get("id") == "CoverBottomTextBox"
        ]
        bottom_textbox = (
            bottom_textboxes[0] if len(bottom_textboxes) == 1 else None
        )
        bottom_textbox_paragraphs = (
            bottom_textbox.findall(f".//{W}txbxContent/{W}p")
            if bottom_textbox is not None
            else []
        )
        if bottom_textbox is None:
            errors.append(
                "封面报告编写单位、合作单位和发布日期应位于无边框浮动文本框"
            )
        else:
            style = bottom_textbox.get("style", "")
            width_match = re.search(
                r"(?:^|;)width:([0-9.]+)pt(?:;|$)",
                style,
            )
            expected_width_pt = COVER_BOTTOM_BLOCK_WIDTH_MM * 72 / 25.4
            if (
                len(bottom_textboxes) != 1
                or bottom_textbox.get("filled") != "f"
                or bottom_textbox.get("stroked") != "f"
                or "position:absolute" not in style
                or "mso-position-horizontal:center" not in style
                or "mso-position-horizontal-relative:margin" not in style
                or "mso-position-vertical:bottom" not in style
                or "mso-position-vertical-relative:margin" not in style
                or width_match is None
                or abs(float(width_match.group(1)) - expected_width_pt) > 0.1
            ):
                errors.append(
                    "封面页底文本框应无边框，并在页边距内水平居中、底端贴齐下页边距"
                )

            bottom_lines = [
                _paragraph_text(paragraph).strip()
                for paragraph in bottom_textbox_paragraphs
            ]
            if any(
                paragraph.find(f".//{W}br") is not None
                for paragraph in bottom_textbox_paragraphs
            ):
                errors.append("封面页底各单位和发布日期不得使用手动换行")
            if any(not line for line in bottom_lines):
                errors.append("封面页底单位和发布日期之间不应存在空段落")
            elif not bottom_lines or bottom_lines[0] != REPORT_WRITING_UNIT:
                errors.append("封面报告编写单位应使用中文全称")
            elif len(bottom_lines) < 2:
                errors.append("封面页底最后一段应为报告发布日期")
            elif any(re.search(r"[、；;]", line) for line in bottom_lines[1:-1]):
                errors.append("封面合作（协作）单位名称应每个单位独占一段")

            invalid_spacing = False
            for paragraph in bottom_textbox_paragraphs:
                spacing = paragraph.find(f"./{W}pPr/{W}spacing")
                snap_to_grid = paragraph.find(f"./{W}pPr/{W}snapToGrid")
                if (
                    spacing is None
                    or not _close(_attr(spacing, "line"), 240)
                    or _attr(spacing, "lineRule") != "auto"
                    or not _close(_attr(spacing, "before", 0), 0)
                    or not _close(_attr(spacing, "after", 0), 0)
                    or _attr(snap_to_grid, "val") != "0"
                ):
                    invalid_spacing = True
                    break
            if invalid_spacing:
                errors.append(
                    "封面页底文本框各段应为段前段后 0、单倍行距并关闭网格对齐"
                )

        if cover_footer is not None and _part_text(cover_footer):
            errors.append("封面页底内容不应放在页脚中")
        if cover_body_tables:
            errors.append("封面页底内容不应使用表格")
        if len(bottom_textboxes) > 1:
            errors.append("封面正文层只能有一个页底浮动文本框")
        if any(
            _paragraph_text(paragraph).strip() == REPORT_WRITING_UNIT
            for paragraph in cover_paragraphs
        ):
            errors.append("封面页底内容不应作为普通正文段落")
        if any(
            paragraph.find(f"./{W}pPr/{W}framePr") is not None
            for paragraph in cover_paragraphs
        ):
            errors.append("封面页底不应继续使用浮动段落框")

        metadata_paragraphs = []
        for label in ("报告编号", "分类号", "密级"):
            metadata_paragraphs.append(
                next(
                    (
                        item
                        for item in paragraphs
                        if _paragraph_text(item).strip().startswith(f"{label}：")
                        or _paragraph_text(item).strip().startswith(f"{label}:")
                    ),
                    None,
                )
            )
        expected_metadata_left, expected_metadata_right = (
            calculate_cover_metadata_indents_twips(
                _paragraph_text(paragraph).strip()
                for paragraph in metadata_paragraphs
                if paragraph is not None
            )
        )
        for label, paragraph in zip(
            ("报告编号", "分类号", "密级"), metadata_paragraphs
        ):
            paragraph_properties = (
                paragraph.find(f"./{W}pPr") if paragraph is not None else None
            )
            alignment = (
                paragraph_properties.find(f"{W}jc")
                if paragraph_properties is not None
                else None
            )
            indent = (
                paragraph_properties.find(f"{W}ind")
                if paragraph_properties is not None
                else None
            )
            tabs = (
                paragraph_properties.find(f"{W}tabs")
                if paragraph_properties is not None
                else None
            )
            if (
                paragraph is None
                or _attr(alignment, "val") != "left"
                or not _close(_attr(indent, "left"), expected_metadata_left)
                or not _close(_attr(indent, "right"), expected_metadata_right)
                or tabs is not None
                or any(
                    _attr(indent, name) is not None
                    for name in (
                        "leftChars",
                        "rightChars",
                        "firstLine",
                        "firstLineChars",
                        "hanging",
                        "hangingChars",
                    )
                )
            ):
                errors.append(
                    f"封面{label}行应与其余封面元数据左对齐，且最长行右端贴齐右页边距内侧"
                )
            if paragraph is not None and not _paragraph_format_matches(
                paragraph,
                east_asia=COVER_HEITI_FONT,
                ascii_font=COVER_HEITI_FONT,
                size=round(COVER_METADATA_FONT_SIZE_PT * 2),
                bold=False,
            ):
                errors.append(f"封面{label}应为五号黑体、非粗体")

        cover_title = next(
            (
                paragraph
                for paragraph in cover_paragraphs
                if body_header_text
                and _paragraph_text(paragraph).strip() == body_header_text
            ),
            None,
        )
        if cover_title is None:
            errors.append("无法依据正文页眉定位封面技术报告中文名称")
        else:
            title_index = cover_paragraphs.index(cover_title)
            if not _paragraph_format_matches(
                cover_title,
                east_asia=COVER_HEITI_FONT,
                ascii_font=COVER_HEITI_FONT,
                size=round(COVER_TITLE_CN_FONT_SIZE_PT * 2),
                bold=False,
            ):
                errors.append("封面技术报告中文名称应为小二号黑体、非粗体")

            source_paragraph = next((paragraph for paragraph in cover_paragraphs[:title_index]
                if any(node.get(f"{W}name") == "PEReportSource"
                       for node in paragraph.iter(f"{W}bookmarkStart"))), None)
            if source_paragraph is None:
                source_paragraph = next(
                    (paragraph for paragraph in reversed(cover_paragraphs[:title_index])
                     if _paragraph_text(paragraph).strip() and not re.match(
                         r"^(?:报告编号|分类号|密级)[:：]", _paragraph_text(paragraph).strip())),
                    None,
                )
            if source_paragraph is None or (_paragraph_text(source_paragraph).strip() and not _paragraph_format_matches(
                source_paragraph,
                east_asia=COVER_HEITI_FONT,
                ascii_font=COVER_HEITI_FONT,
                size=round(COVER_PROJECT_SOURCE_FONT_SIZE_PT * 2),
                bold=False,
            )):
                errors.append("封面科研项目来源应为小三号黑体、非粗体")

            bottom_index = len(cover_paragraphs)
            series_paragraphs = [
                paragraph
                for paragraph in cover_paragraphs[title_index + 1 : bottom_index]
                if _paragraph_text(paragraph).strip()
                and not _is_english_dominant(_paragraph_text(paragraph).strip())
            ]
            if any(
                not _paragraph_format_matches(
                    paragraph,
                    east_asia=COVER_HEITI_FONT,
                    ascii_font=COVER_HEITI_FONT,
                    size=round(COVER_SERIES_FONT_SIZE_PT * 2),
                    bold=False,
                )
                for paragraph in series_paragraphs
            ):
                errors.append("封面系列报告名称及序号应为小三号黑体、非粗体")

        if bottom_textbox_paragraphs and any(
            not _paragraph_format_matches(
                paragraph,
                east_asia=COVER_HEITI_FONT,
                ascii_font=COVER_HEITI_FONT,
                size=round(COVER_BOTTOM_FONT_SIZE_PT * 2),
                bold=False,
            )
            for paragraph in bottom_textbox_paragraphs
        ):
            errors.append(
                "封面报告编写单位、合作单位和报告发布日期应为四号黑体、非粗体"
            )

        title_requirements = {
            "内容摘要": ("黑体", "Times New Roman", 36),
            "ABSTRACT": ("Times New Roman", "Times New Roman", 36),
            "目  录": ("黑体", "Times New Roman", 36),
        }
        for label, (east_asia, ascii_font, size) in title_requirements.items():
            paragraph = next(
                (
                    item
                    for item in paragraphs
                    if _paragraph_text(item).strip().replace("\u3000", " ") == label
                ),
                None,
            )
            if paragraph is None or not _paragraph_format_matches(
                paragraph,
                east_asia=east_asia,
                ascii_font=ascii_font,
                size=size,
                bold=False,
            ):
                errors.append(f"{label} 标题字体、字号或粗体属性不符合表 B-1")

        for keyword_label in ("关键词：", "KEYWORDS:"):
            keyword_paragraph = next(
                (
                    paragraph
                    for paragraph in paragraphs
                    if _paragraph_text(paragraph).strip().startswith(keyword_label)
                ),
                None,
            )
            indent = (
                keyword_paragraph.find(f"./{W}pPr/{W}ind")
                if keyword_paragraph is not None
                else None
            )
            if (
                indent is None
                or _attr(indent, "firstLineChars") != "200"
                or any(
                    _attr(indent, name) is not None
                    for name in ("left", "leftChars", "right", "rightChars", "hanging")
                )
            ):
                errors.append(f"{keyword_label} 段落应首行缩进 2 字符且不设置左右缩进")

        for label in ("内容摘要", "ABSTRACT"):
            title_paragraph = next(
                (paragraph for paragraph in paragraphs if _paragraph_text(paragraph).strip() == label),
                None,
            )
            instruction = _field_instructions(title_paragraph) if title_paragraph is not None else ""
            if not (
                re.search(rf'\bTC\s+"{re.escape(label)}"', instruction)
                and re.search(r"\\f\s+C\b", instruction)
                and re.search(r'\\l\s+"1"', instruction)
            ):
                errors.append(f"摘要标题“{label}”缺少自动目录 TC 域")
            if (
                title_paragraph is not None
                and title_paragraph.find(f"./{W}pPr/{W}outlineLvl") is not None
            ):
                errors.append(f"摘要标题“{label}”不应通过大纲级别重复进入目录")

        toc_instruction = " ".join(
            _field_instructions(paragraph) for paragraph in paragraphs
        )
        if not (
            re.search(r"\bTOC\b", toc_instruction)
            and re.search(r"\\f\s+C\b", toc_instruction)
        ):
            errors.append("目录域缺少 TC 标识符，无法自动生成摘要前两行")

        toc_styles = []
        for style in styles.findall(f"{W}style"):
            style_name_element = style.find(f"{W}name")
            style_name = _attr(style_name_element, "val", "")
            if re.fullmatch(r"toc \d+|目录 \d+", style_name, flags=re.IGNORECASE):
                toc_styles.append((style_name, style))
        if not toc_styles:
            errors.append("文档缺少自动目录条目样式")
        for style_name, style in toc_styles:
            run_properties = style.find(f"{W}rPr")
            fonts = run_properties.find(f"{W}rFonts") if run_properties is not None else None
            size = run_properties.find(f"{W}sz") if run_properties is not None else None
            bold = run_properties.find(f"{W}b") if run_properties is not None else None
            if (
                fonts is None
                or fonts.get(f"{W}eastAsia") != "宋体"
                or fonts.get(f"{W}ascii") != "Times New Roman"
                or _attr(size, "val") != "24"
                or bold is not None
            ):
                errors.append(
                    f"自动目录样式“{style_name}”应为宋体/Times New Roman 小四、非粗体"
                )

        for paragraph in paragraphs:
            if (id(paragraph) not in toc_cache_paragraph_ids
                    and _paragraph_text(paragraph).strip() in ("内容摘要i", "ABSTRACTi")):
                errors.append("目录摘要条目不应使用固定文本，应由 TOC 域自动生成")

        paragraph_texts = [_paragraph_text(paragraph).strip() for paragraph in paragraphs]

        # 参考文献内容校验：无参考文献页时不触发；存在时统一按 GB/T 7714—2015 顺序编码制。
        reference_heading_index = next((i for i, text in enumerate(paragraph_texts) if text == "参考文献"), None)
        if reference_heading_index is not None:
            reference_entries = [text for text in paragraph_texts[reference_heading_index + 1:] if text]
            expected_reference_number = 1
            for text in reference_entries:
                match = re.match(r"^\[(\d+)\]\s+\S", text)
                if match is None:
                    errors.append(f"参考文献第 {expected_reference_number} 条应以“[{expected_reference_number}] ”开头")
                    expected_reference_number += 1
                    continue
                actual_number = int(match.group(1))
                if actual_number != expected_reference_number:
                    errors.append(f"参考文献编号应连续，期望 [{expected_reference_number}]，收到 [{actual_number}]")
                detail = _gbt7714_reference_error(text)
                if detail:
                    errors.append(f"参考文献 [{actual_number}] 不符合 GB/T 7714—2015：{detail}")
                expected_reference_number += 1

        for index, text in enumerate(paragraph_texts):
            placeholder = re.match(r"^【此处插入图\s*([A-Z0-9]+-\d+)】$", text)
            if placeholder is None:
                continue
            next_text = paragraph_texts[index + 1] if index + 1 < len(paragraph_texts) else ""
            if not re.match(rf"^图\s*{re.escape(placeholder.group(1))}(?:\s|\S)", next_text):
                errors.append(f"图{placeholder.group(1)}的占位段落应位于对应图题上方")

        body_start = next(
            (
                index
                for index, (paragraph, text) in enumerate(zip(paragraphs, paragraph_texts))
                if _paragraph_style_name(paragraph, style_names).lower() == "heading 1"
                and re.match(r"^1\s+\S", text)
            ),
            None,
        )
        if body_start is not None:
            for paragraph, text in zip(paragraphs[body_start:], paragraph_texts[body_start:]):
                style_name = _paragraph_style_name(paragraph, style_names).lower()
                if text == "参考文献" or re.match(r"^附录\s+[A-Z]\s+\S", text):
                    if not _has_page_break_before(paragraph):
                        errors.append(f"{text} 应另起一页")
                    continue

                if style_name == "heading 1":
                    if not _has_page_break_before(paragraph):
                        errors.append(f"一级标题“{text[:30]}”应另起一页")
                    if not _paragraph_format_matches(
                        paragraph,
                        east_asia="黑体",
                        ascii_font="Times New Roman",
                        size=30,
                        bold=False,
                    ):
                        errors.append(f"一级标题“{text[:30]}”格式不符合表 B-1")
                    continue

                if style_name in ("heading 2", "002二级标题"):
                    if not _paragraph_format_matches(
                        paragraph,
                        east_asia="黑体",
                        ascii_font="Times New Roman",
                        size=28,
                        bold=False,
                    ):
                        errors.append(f"二级标题“{text[:30]}”格式不符合表 B-1")
                    continue

                if style_name in ("heading 3", "003三级标题"):
                    if not _paragraph_format_matches(
                        paragraph,
                        east_asia="黑体",
                        ascii_font="Times New Roman",
                        size=24,
                        bold=False,
                    ):
                        errors.append(f"三级标题“{text[:30]}”格式不符合表 B-1")
                    continue

                if re.match(r"^(?:\d+(?:\.\d+){3,}|（\d+）|\d+）|[①-⑳])", text):
                    run_properties = _text_run_properties(paragraph)
                    if any(
                        item["bold"] or item["eastAsia"] == "黑体"
                        for item in run_properties
                    ):
                        errors.append(f"正文编号列项“{text[:30]}”不应使用黑体或粗体")

        text_positions = {}
        for index, paragraph in enumerate(paragraphs):
            text = _paragraph_text(paragraph).strip()
            for label in ("内容摘要", "ABSTRACT", "KEYWORDS:", "目  录"):
                if label in text and label not in text_positions:
                    text_positions[label] = index

        required_labels = ("内容摘要", "ABSTRACT", "KEYWORDS:", "目  录")
        if not all(label in text_positions for label in required_labels):
            errors.append("无法确认中英文摘要和目录的结构顺序")
        else:
            positions = [text_positions[label] for label in required_labels]
            if positions != sorted(positions):
                errors.append("中英文摘要、关键词和目录的顺序不正确")
            abstract_start = text_positions["内容摘要"]
            english_keywords = text_positions["KEYWORDS:"]
            for paragraph in paragraphs[abstract_start:english_keywords]:
                if paragraph.find(f"./{W}pPr/{W}sectPr") is not None:
                    errors.append("中英文摘要之间不应存在分节符")
                    break

        xml_names = [
            name
            for name in archive.namelist()
            if name.startswith("word/") and name.endswith(".xml")
        ]
        for name in xml_names:
            raw = archive.read(name)
            root = ET.fromstring(raw)
            visible_text = "".join(
                node.text or "" for node in root.iter(f"{W}t")
            )
            if re.search(r"\{\{[A-Z][A-Z0-9_]*\}\}", visible_text):
                errors.append(f"文档中残留未替换占位符: {name}")

    return {"valid": not errors, "errors": errors, "warnings": warnings}
