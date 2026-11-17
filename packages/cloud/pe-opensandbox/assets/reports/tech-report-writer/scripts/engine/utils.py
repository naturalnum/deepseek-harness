"""
辅助工具函数模块。

提供HTML判断、占位符查找与提取、表格模板行展开等通用功能。
所有函数不抛出异常，异常情况通过返回值体现。
"""

from __future__ import annotations

import copy
import re
from typing import Any, Dict, List, Optional, Union

from docx.document import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

# ---------------------------------------------------------------------------
# HTML 检测正则：
# 匹配 < 后紧跟 / 或字母开头的标签名（无空格，否则 "a < b" 会误命中），
# 同时兼容 <?xml / <!DOCTYPE 等声明。
# 命中：<p>, </div>, <br/>, <h1, <?xml, <!DOCTYPE
# 不命中：a < b, x > 5, <<<, < 不是标签, <3
# ---------------------------------------------------------------------------
_HTML_TAG_PATTERN = re.compile(r"</?[a-zA-Z][a-zA-Z0-9]*|<[?!][a-zA-Z]")


def is_html(value: str) -> bool:
    """
    判断字符串是否包含 HTML 标签结构。

    规则：查找 <tagname 或 </tagname 模式（< 后紧跟可选的 /，
    然后是至少一个字母开头的标签名）。

    若未命中标签模式，即使字符串包含 < 和 > 字符（如 "a < b"、
    "x > 5"、HTML 源码展示片段等），也不会被误判为 HTML。

    Args:
        value: 待判断的字符串。

    Returns:
        True 表示包含 HTML 标签结构，False 表示纯文本。

    Examples:
        >>> is_html("<p>Hello</p>")
        True
        >>> is_html("<div class='x'>text</div>")
        True
        >>> is_html("Plain text")
        False
        >>> is_html("a < b and c > d")
        False
        >>> is_html("<<< error >>>")
        False
    """
    if not isinstance(value, str):
        return False
    return bool(_HTML_TAG_PATTERN.search(value))


def extract_placeholder_name(text: str) -> Optional[str]:
    """
    从占位符文本中提取占位符名称。

    占位符格式：{{placeholder_name}}
    仅当整段文本完全是一个占位符时才返回名称。

    Args:
        text: 段落文本（去除前后空白后）。

    Returns:
        占位符名称字符串，若不是占位符则返回 None。

    Examples:
        >>> extract_placeholder_name("{{title}}")
        'title'
        >>> extract_placeholder_name("plain text")
        None
    """
    if not isinstance(text, str):
        return None
    text = text.strip()
    pattern = re.compile(r"^\{\{(.+)\}\}$")
    match = pattern.match(text)
    if match:
        return match.group(1).strip()
    return None


def find_inline_placeholders(text: str) -> List[str]:
    """
    查找文本中所有内联占位符名称。

    用于段落中混合了占位符和普通文本的情况，如 '{{YEAR}}年{{MONTH}}月份'。

    Args:
        text: 段落文本。

    Returns:
        占位符名称列表（按出现顺序，不去重）。

    Examples:
        >>> find_inline_placeholders("{{YEAR}}年{{MONTH}}月份")
        ['YEAR', 'MONTH']
        >>> find_inline_placeholders("no placeholder")
        []
    """
    if not isinstance(text, str):
        return []
    return re.findall(r"\{\{(.+?)\}\}", text)


def find_all_placeholders(doc: Document) -> Dict[str, List]:
    """
    在文档中查找所有占位符段落。

    遍历文档正文、页眉、页脚、表格中的所有段落，
    查找文本完全等于 {{placeholder_name}} 的段落。

    Args:
        doc: python-docx 的 Document 对象。

    Returns:
        字典，键为占位符名称，值为包含该占位符的段落对象列表。
    """
    placeholders: Dict[str, List] = {}

    def _check_paragraphs(paragraphs):
        """检查段落列表中的纯占位符段落。"""
        for para in paragraphs:
            name = extract_placeholder_name(para.text)
            if name:
                if name not in placeholders:
                    placeholders[name] = []
                placeholders[name].append(para)

    def _check_inline_paragraphs(paragraphs):
        """检查段落列表中的内联占位符（占位符与文字混排）。"""
        for para in paragraphs:
            # 跳过已被纯占位符检测收录的段落
            if extract_placeholder_name(para.text) is not None:
                continue
            names = find_inline_placeholders(para.text)
            for name in names:
                if name not in placeholders:
                    placeholders[name] = []
                if para not in placeholders[name]:
                    placeholders[name].append(para)

    # 1. 文档正文段落（包含纯占位符段落和内联占位符段落）
    _check_paragraphs(doc.paragraphs)
    _check_inline_paragraphs(doc.paragraphs)

    # 2. 正文层浮动文本框中的段落。python-docx 的 doc.paragraphs
    # 不包含 w:txbxContent 内的段落，需要从 XML 层单独收集。
    from docx.text.paragraph import Paragraph

    for textbox_content in doc.element.body.iter(qn("w:txbxContent")):
        textbox_paragraphs = [
            Paragraph(p_el, doc._body)
            for p_el in textbox_content.findall(qn("w:p"))
        ]
        _check_paragraphs(textbox_paragraphs)
        _check_inline_paragraphs(textbox_paragraphs)

    # 3. 页眉和页脚。直接读取已存在的关系部件，避免 python-docx
    # 在访问 section.header/footer 时创建原本不存在的空白页眉页脚。
    checked_parts = set()
    for section in doc.sections:
        for ref_tag in ("headerReference", "footerReference"):
            for ref in section._sectPr.findall(qn(f"w:{ref_tag}")):
                rel_id = ref.get(qn("r:id"))
                part = doc.part.related_parts.get(rel_id)
                if part is None or id(part) in checked_parts:
                    continue
                checked_parts.add(id(part))
                paragraphs = [
                    Paragraph(p_el, part.element)
                    for p_el in part.element.iter(qn("w:p"))
                ]
                _check_paragraphs(paragraphs)
                _check_inline_paragraphs(paragraphs)

    # 4. 表格中的段落 — 通过 XML 层遍历，避免 gridSpan/vMerge 幽灵格
    for table in doc.tables:
        for tr_el in table._tbl.findall(f"{{{_WML_NS}}}tr"):
            for tc in tr_el.findall(f"{{{_WML_NS}}}tc"):
                # 跳过 vMerge continue 幽灵格
                tcPr = tc.find(f"{{{_WML_NS}}}tcPr")
                if tcPr is not None:
                    vm = tcPr.find(f"{{{_WML_NS}}}vMerge")
                    if vm is not None and vm.get(f"{{{_WML_NS}}}val") != "restart":
                        continue
                # 收集单元格内所有段落的文本
                for p_el in tc.findall(f".//{{{_WML_NS}}}p"):
                    # 用 python-docx 的 Paragraph 包装以便统一处理
                    from docx.text.paragraph import Paragraph

                    para = Paragraph(p_el, None)
                    _check_paragraphs([para])
                    _check_inline_paragraphs([para])

    return placeholders


def remove_paragraph(para) -> None:
    """
    从文档中安全删除一个段落。

    通过操作XML元素从父节点中移除段落。

    Args:
        para: python-docx 的 Paragraph 对象。
    """
    try:
        p = para._element
        p.getparent().remove(p)
    except Exception:
        # 段落可能已经被移除或没有父节点，静默忽略
        pass


def insert_elements_after(anchor_element, new_elements: List) -> None:
    """
    在指定元素之后插入一系列Word元素。

    Args:
        anchor_element: 锚点元素的 _element (lxml元素)。
        new_elements: 要插入的Word元素列表（Paragraph、Table等python-docx对象）。
    """
    insert_point = anchor_element
    for elem in new_elements:
        try:
            elem_elem = elem._element
            # 从当前位置移除（如果是通过 add_* 创建的，则在文档末尾）
            parent = elem_elem.getparent()
            if parent is not None:
                parent.remove(elem_elem)
            # 插入到锚点之后
            insert_point.addnext(elem_elem)
            insert_point = elem_elem
        except Exception:
            # 插入失败时跳过该元素
            continue


def get_sorted_placeholder_names(content_map: Dict[str, str]) -> List[str]:
    """
    按字母顺序获取占位符名称列表。

    用于无模板模式下按字母顺序插入内容。

    Args:
        content_map: 内容字典。

    Returns:
        按字母顺序排序的占位符名称列表。
    """
    return sorted(content_map.keys())


def set_doc_default_font(doc: Document, font_name: str, font_size_pt: Optional[float] = None) -> None:
    """
    设置文档的默认西文+中文字体（修改 docDefaults 中的 w:rFonts）。

    修改后所有未单独指定字体的段落/Run 都会继承该字体。
    仅应在无模板模式下调用；有模板模式应保留模板自身字体设置。

    Args:
        doc: python-docx Document 对象。
        font_name: 字体名称，如 '仿宋'、'宋体'、'Arial'。
        font_size_pt: 可选，默认字号（磅），不传则保持 docDefaults 原值。
    """
    from lxml import etree

    try:
        styles_elem = doc.styles.element
        defaults = styles_elem.find(qn("w:docDefaults"))
        if defaults is None:
            defaults = etree.SubElement(styles_elem, qn("w:docDefaults"))

        rPrDefault = defaults.find(qn("w:rPrDefault"))
        if rPrDefault is None:
            rPrDefault = etree.SubElement(defaults, qn("w:rPrDefault"))

        rPr = rPrDefault.find(qn("w:rPr"))
        if rPr is None:
            rPr = etree.SubElement(rPrDefault, qn("w:rPr"))

        # 移除旧的 w:rFonts（含主题引用 minorHAnsi/minorEastAsia 等）
        for old in rPr.findall(qn("w:rFonts")):
            rPr.remove(old)

        rFonts = etree.SubElement(rPr, qn("w:rFonts"))
        rFonts.set(qn("w:ascii"), font_name)
        rFonts.set(qn("w:hAnsi"), font_name)
        rFonts.set(qn("w:eastAsia"), font_name)
        rFonts.set(qn("w:cs"), font_name)

        if font_size_pt is not None:
            for old_sz in rPr.findall(qn("w:sz")):
                rPr.remove(old_sz)
            for old_szCs in rPr.findall(qn("w:szCs")):
                rPr.remove(old_szCs)
            half_pts = str(int(round(font_size_pt * 2)))
            sz = etree.SubElement(rPr, qn("w:sz"))
            sz.set(qn("w:val"), half_pts)
            szCs = etree.SubElement(rPr, qn("w:szCs"))
            szCs.set(qn("w:val"), half_pts)

        # 同时修改内置样式的字体，避免标题等样式使用模板自带字体
        _update_style_fonts(doc, font_name)

    except Exception:
        pass  # 字体设置失败不阻塞文档生成


# =========================================================================
# 表格模板行检测与展开
# =========================================================================

# WordprocessingML 命名空间
_WML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def find_table_template_rows(doc: Document) -> List[Dict[str, Any]]:
    """
    收集文档中所有含 ``{{...}}`` 占位符的表格行作为模板行候选。

    只要求行内至少有一格是 ``{{xxx}}`` 格式即可，不需要全行都是。

    Args:
        doc: python-docx Document 对象。

    Returns:
        列表，每项为模板行信息：
        - table_idx: 表格索引
        - row_idx:   行索引
        - anchors:   该行所有 {{xxx}} 占位符名列表
        - table:     Table 对象
        - row:       Row 对象
    """
    result: List[Dict[str, Any]] = []

    try:
        for t_idx, table in enumerate(doc.tables):
            tr_elements = table._tbl.findall(f"{{{_WML_NS}}}tr")
            for r_idx, tr_el in enumerate(tr_elements):
                anchors: List[str] = []
                tc_elements = tr_el.findall(f"{{{_WML_NS}}}tc")
                for tc in tc_elements:
                    tcPr = tc.find(f"{{{_WML_NS}}}tcPr")
                    if tcPr is not None:
                        vm = tcPr.find(f"{{{_WML_NS}}}vMerge")
                        if vm is not None and vm.get(f"{{{_WML_NS}}}val") != "restart":
                            continue
                    t_texts = [t.text or "" for t in tc.findall(f".//{{{_WML_NS}}}t")]
                    text = "".join(t_texts).strip()
                    m = re.match(r"^\s*\{\{(.+?)\}\}\s*$", text)
                    if m:
                        anchors.append(m.group(1).strip())

                if anchors:
                    result.append({
                        "table_idx": t_idx,
                        "row_idx": r_idx,
                        "anchors": anchors,
                        "table": table,
                        "row": table.rows[r_idx],
                    })
    except Exception:
        pass

    return result


#: 单元格值类型：字符串或显式类型 dict
CellValue = Union[str, Dict[str, str]]


def _normalize_cell_value(raw: CellValue) -> tuple:
    """
    将单元格值统一为 (类型, 内容字符串)。

    规则和 content_map 的 value 一致：
    - str → (None, str) 自动检测
    - {"type":"text"|"html", "content":"..."} → 显式

    Returns:
        (type_or_None, content_str)
    """
    if isinstance(raw, str):
        return (None, raw)
    if isinstance(raw, dict):
        ct = (raw.get("type") or "").strip().lower()
        c = raw.get("content", "") or ""
        if ct in ("text", "html"):
            return (ct, c)
        return (None, c)
    return ("text", str(raw))


def _cell_is_html(raw: CellValue) -> bool:
    """判断单元格值是否应作为 HTML 渲染。"""
    ct, content = _normalize_cell_value(raw)
    if ct is not None:
        return ct == "html"
    return bool(_HTML_TAG_PATTERN.search(content) if content else False)


def fill_cloned_row_by_position(
    tr_element,
    cell_values: List[CellValue],
    doc: Document,
    placeholder_name: str,
    tag_hooks: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """
    在克隆的 <w:tr> 元素中，按列位置填充单元格数据。

    遍历 <w:tc> 元素，跳过 vMerge continue 幽灵格。
    对于每个真实格，按 ``cell_values`` 中对应位置的值填入：
    - 纯文本 str → 替换 <w:t> 文本
    - str 含 HTML → 通过 parse_html_to_elements 渲染后移入单元格
    - {"type":"html"/"text", "content":"..."} → 按指定类型处理

    Args:
        tr_element: 克隆后的 lxml <w:tr> 元素。
        cell_values: 按列位置的单元格值列表。
        doc: python-docx Document 对象（供 HTML 渲染用）。
        placeholder_name: 占位符名（供警告消息）。
        tag_hooks: 标签钩子。

    Returns:
        警告列表。
    """
    warnings: List[str] = []
    tc_elements = tr_element.findall(f"{{{_WML_NS}}}tc")

    # 收集真实格索引（跳过 vMerge continue 幽灵格）
    real_tcs: List[int] = []
    for idx, tc in enumerate(tc_elements):
        tcPr = tc.find(f"{{{_WML_NS}}}tcPr")
        if tcPr is not None:
            vm = tcPr.find(f"{{{_WML_NS}}}vMerge")
            if vm is not None and vm.get(f"{{{_WML_NS}}}val") != "restart":
                continue  # 幽灵格，跳过
        real_tcs.append(idx)

    for pos, tc_idx in enumerate(real_tcs):
        if pos >= len(cell_values):
            break

        tc = tc_elements[tc_idx]
        raw = cell_values[pos]
        if raw is None or (isinstance(raw, str) and not raw):
            raw = ""

        if _cell_is_html(raw):
            # HTML 内容：清除格内所有段落，渲染 HTML 后移入
            _clear_cell_content(tc)
            _, html_str = _normalize_cell_value(raw)
            if html_str:
                cell_warnings = _render_html_into_cell(
                    tc, html_str, doc, placeholder_name, tag_hooks
                )
                warnings.extend(cell_warnings)
        else:
            # 纯文本内容：替换第一个 <w:t> 的文本
            _, text = _normalize_cell_value(raw)
            t_elements = tc.findall(f".//{{{_WML_NS}}}t")
            if t_elements:
                t_elements[0].text = text
                ns_xml = "http://www.w3.org/XML/1998/namespace"
                if t_elements[0].get(f"{{{ns_xml}}}space") is None:
                    t_elements[0].set(f"{{{ns_xml}}}space", "preserve")
                for t in t_elements[1:]:
                    t.text = ""

    return warnings


def _clear_cell_content(tc) -> None:
    """清除 <w:tc> 内所有 <w:p> 段落元素。"""
    for p in tc.findall(f"{{{_WML_NS}}}p"):
        tc.remove(p)


def _render_html_into_cell(
    tc,
    html_str: str,
    doc: Document,
    placeholder_name: str,
    tag_hooks: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """
    将 HTML 片段渲染为 Word 元素，移入指定单元格。

    Args:
        tc: <w:tc> lxml 元素。
        html_str: HTML 内容字符串。
        doc: Document 对象。
        placeholder_name: 占位符名。
        tag_hooks: 标签钩子。

    Returns:
        警告列表。
    """
    from engine.parser import parse_html_to_elements as _parse_html

    warnings: List[str] = []
    try:
        elements, errors, parse_warnings = _parse_html(
            doc, html_str, placeholder_name, tag_hooks
        )
        warnings.extend(parse_warnings)
        if errors:
            warnings.extend(errors)
            # 降级：写入纯文本
            p_el = OxmlElement("w:p")
            r_el = OxmlElement("w:r")
            t_el = OxmlElement("w:t")
            t_el.set(qn("xml:space"), "preserve")
            t_el.text = html_str
            r_el.append(t_el)
            p_el.append(r_el)
            tc.append(p_el)
            return warnings

        if not elements:
            return warnings

        for elem in elements:
            if elem is None:
                continue
            try:
                parent = elem._element.getparent()
                if parent is not None:
                    parent.remove(elem._element)
                tc.append(elem._element)
            except Exception:
                pass

    except Exception as e:
        warnings.append(f"[表格格HTML] 渲染失败: {e}")
        # 降级：纯文本
        p_el = OxmlElement("w:p")
        r_el = OxmlElement("w:r")
        t_el = OxmlElement("w:t")
        t_el.set(qn("xml:space"), "preserve")
        t_el.text = html_str
        r_el.append(t_el)
        p_el.append(r_el)
        tc.append(p_el)

    return warnings


def _update_style_fonts(doc: Document, font_name: str) -> None:
    """
    将文档中所有样式的 w:rFonts 统一设置为指定字体。

    Heading/List 等样式自身定义了字体，优先级高于 docDefaults，
    需要一并修改才能真正生效。
    """
    from lxml import etree

    theme_attrs = ["asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"]

    try:
        for style in doc.styles:
            if not hasattr(style, "element") or style.element is None:
                continue
            rPr = style.element.find(qn("w:rPr"))
            if rPr is None:
                continue
            # 删除主题颜色引用，避免标题显示蓝色
            for color in rPr.findall(qn("w:color")):
                if color.get(qn("w:themeColor")) is not None:
                    rPr.remove(color)
            for rFonts in rPr.findall(qn("w:rFonts")):
                # 删除主题引用，否则 Word 优先使用主题字体
                for attr in theme_attrs:
                    if rFonts.get(qn(f"w:{attr}")) is not None:
                        del rFonts.attrib[qn(f"w:{attr}")]
                rFonts.set(qn("w:ascii"), font_name)
                rFonts.set(qn("w:hAnsi"), font_name)
                rFonts.set(qn("w:eastAsia"), font_name)
                rFonts.set(qn("w:cs"), font_name)
    except Exception:
        pass
