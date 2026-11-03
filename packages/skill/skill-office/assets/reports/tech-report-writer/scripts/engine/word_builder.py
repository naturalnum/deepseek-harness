"""
Word元素构建模块。

负责将HTML标签转换为python-docx的Word元素：
段落、标题、表格、列表、超链接、图片等。

处理内联元素（b, i, u, span, a, br, img）的递归格式化。

所有函数不抛出异常，异常情况通过返回值和警告列表体现。
"""

from typing import Any, Dict, List, Optional, Tuple, Union

from bs4 import NavigableString, Tag
from docx.document import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from docx.table import Table
from docx.text.paragraph import Paragraph

from engine.image_handler import handle_image_to_paragraph
from engine.style_mapper import (
    _make_ooxml_element,
    _parse_length_twips,
    _parse_style_string,
    _set_run_spacing,
    apply_style_to_paragraph,
    parse_color,
    parse_font_size,
)

# ---------------------------------------------------------------------------
# 统一类型别名
# ---------------------------------------------------------------------------
WordElement = Union[Paragraph, Table]
"""可插入文档的Word元素类型（段落或表格）。"""


# ---------------------------------------------------------------------------
# 标题样式映射
# ---------------------------------------------------------------------------
_HEADING_STYLE_MAP = {
    "h1": "Heading 1",
    "h2": "Heading 2",
    "h3": "Heading 3",
    "h4": "Heading 4",
    "h5": "Heading 5",
    "h6": "Heading 6",
}


def build_heading(
    doc: Document,
    tag: Tag,
    context: Dict[str, Any],
) -> Tuple[Optional[Paragraph], List[str]]:
    """
    构建标题段落（h1-h6）。

    Args:
        doc: Word Document 对象。
        tag: BeautifulSoup Tag 对象。
        context: 上下文字典（包含 placeholder_name, document 等）。

    Returns:
        (Paragraph对象或None, 警告列表)
    """
    warnings: List[str] = []
    tag_name = tag.name.lower() if hasattr(tag, "name") and tag.name else ""
    level = tag_name[1:]  # 提取 '1' ~ '6'

    try:
        heading_level = int(level)
        if heading_level < 1 or heading_level > 6:
            heading_level = 1
    except (ValueError, TypeError):
        heading_level = 1

    try:
        para = doc.add_paragraph()
        style_name = _HEADING_STYLE_MAP.get(tag_name, "Heading 1")
        para.style = doc.styles[style_name]  # type: ignore[assignment]

        # 显式设置 outline level，确保 TOC（目录）能正确识别标题层级
        # 即使模板中 Heading 样式被自定义覆盖，TOC 依然能工作
        try:
            from docx.oxml.ns import qn
            from docx.oxml import OxmlElement

            pPr = para._element.get_or_add_pPr()
            # 移除已有的 outlineLvl（如果有）
            for old_lvl in pPr.findall(qn("w:outlineLvl")):
                pPr.remove(old_lvl)
            outline_lvl = OxmlElement("w:outlineLvl")
            # OOXML outlineLvl 从 0 开始：0=Level1, 1=Level2, ...
            outline_lvl.set(qn("w:val"), str(heading_level - 1))
            pPr.append(outline_lvl)
        except Exception:
            pass  # outlineLvl 设置失败不影响内容

        # 应用段落级别样式
        style_str = tag.get("style", "") if hasattr(tag, "get") else ""
        if style_str:
            para_warnings = apply_style_to_paragraph(para, style_str)
            warnings.extend(para_warnings)

        # 提取 Run 级样式（font-family/color/font-size 等）传递给子元素
        run_fmt = _parse_inline_style_to_dict(style_str) if style_str else None

        # 处理内联内容
        inline_warnings = add_inline_content(para, tag, context, run_fmt or None)
        warnings.extend(inline_warnings)

        return para, warnings

    except Exception:
        # 构建失败时返回一个简单段落作为降级
        try:
            fallback = doc.add_paragraph()
            fallback.text = tag.get_text() if hasattr(tag, "get_text") else str(tag)
            return fallback, warnings
        except Exception:
            return None, warnings


def build_paragraph(
    doc: Document,
    tag: Tag,
    context: Dict[str, Any],
) -> Tuple[Optional[Paragraph], List[str]]:
    """
    构建普通段落（p）。

    Args:
        doc: Word Document 对象。
        tag: BeautifulSoup Tag 对象。
        context: 上下文字典。

    Returns:
        (Paragraph对象或None, 警告列表)
    """
    warnings: List[str] = []

    try:
        para = doc.add_paragraph()

        # 应用段落级别样式
        style_str = tag.get("style", "") if hasattr(tag, "get") else ""
        if style_str:
            para_warnings = apply_style_to_paragraph(para, style_str)
            warnings.extend(para_warnings)

        # 提取 Run 级样式（font-family/color/font-size 等）传递给子元素
        run_fmt = _parse_inline_style_to_dict(style_str) if style_str else None

        # 处理内联内容
        inline_warnings = add_inline_content(para, tag, context, run_fmt or None)
        warnings.extend(inline_warnings)

        return para, warnings

    except Exception:
        # 降级：创建纯文本段落
        try:
            fallback = doc.add_paragraph()
            fallback.text = tag.get_text() if hasattr(tag, "get_text") else str(tag)
            return fallback, warnings
        except Exception:
            return None, warnings


def build_table(
    doc: Document,
    tag: Tag,
    context: Dict[str, Any],
) -> Tuple[Optional[Union[Table, List[Union[Paragraph, Table]]]], List[str]]:
    """
    构建Word表格（table）。

    支持 colspan 和 rowspan 属性合并单元格。
    如果存在 <caption>，返回 [caption段落, table] 列表，
    确保 caption 随表格一起被移动到正确位置。

    Args:
        doc: Word Document 对象。
        tag: BeautifulSoup <table> Tag 对象。
        context: 上下文字典。

    Returns:
        (Table对象 / [caption段落, table]列表 / None, 警告列表)
    """
    warnings: List[str] = []

    try:
        # ---- 处理 <caption> 表格标题 ----
        caption_tag = tag.find("caption", recursive=False)
        caption_para = None
        if caption_tag is not None:
            caption_para, cap_warnings = _add_table_caption(doc, caption_tag, context)
            warnings.extend(cap_warnings)

        # 获取所有行
        rows = tag.find_all("tr", recursive=False)
        if not rows:
            # 也尝试递归查找（处理 thead/tbody 包装）
            rows = tag.find_all("tr")

        if not rows:
            return None, warnings

        # ---- 计算表格网格尺寸 ----
        num_rows = len(rows)
        max_cols = 0
        row_cell_counts = []

        for row in rows:
            cells = row.find_all(["td", "th"], recursive=False)
            if not cells:
                cells = row.find_all(["td", "th"])
            col_count = 0
            for cell in cells:
                colspan = int(cell.get("colspan", 1))
                col_count += colspan
            row_cell_counts.append(col_count)
            max_cols = max(max_cols, col_count)

        if max_cols == 0:
            return None, warnings

        num_cols = max_cols

        # ---- 创建Word表格 ----
        table = doc.add_table(rows=num_rows, cols=num_cols)
        table.style = doc.styles["Table Grid"]  # type: ignore[assignment]

        # ---- 网格占用追踪（处理 rowspan） ----
        occupied = [[False] * num_cols for _ in range(num_rows)]

        for i, row in enumerate(rows):
            cells = row.find_all(["td", "th"], recursive=False)
            if not cells:
                cells = row.find_all(["td", "th"])

            col_idx = 0

            for cell_tag in cells:
                # 跳过已被上一行的 rowspan 占用的列
                while col_idx < num_cols and occupied[i][col_idx]:
                    col_idx += 1

                if col_idx >= num_cols:
                    break

                colspan = int(cell_tag.get("colspan", 1))
                rowspan = int(cell_tag.get("rowspan", 1))

                # 限制范围
                colspan = max(1, min(colspan, num_cols - col_idx))
                rowspan = max(1, min(rowspan, num_rows - i))

                # 标记占用的网格位置
                for r in range(i, i + rowspan):
                    for c in range(col_idx, col_idx + colspan):
                        if r < num_rows and c < num_cols:
                            occupied[r][c] = True

                # 获取Word单元格
                try:
                    word_cell = table.cell(i, col_idx)

                    # 合并单元格
                    if colspan > 1 or rowspan > 1:
                        end_row = min(i + rowspan - 1, num_rows - 1)
                        end_col = min(col_idx + colspan - 1, num_cols - 1)
                        try:
                            word_cell.merge(table.cell(end_row, end_col))
                            # python-docx 0.8.11 的 merge() 只在首单元格
                            # 设置 vMerge="restart"，遗漏了后续单元格的
                            # vMerge 继续标记，需手动补齐。
                            _fix_vmerge(table, i, col_idx, end_row, end_col)
                        except Exception:
                            pass  # 合并失败不中断

                    # 对 th 标签内容加粗
                    cell_extra_fmt = {"bold": False}

                    # ---- 填充单元格内容 ----
                    # 逐个处理子节点：文本/内联元素→段落；嵌套<table>→递归构建
                    cell_warnings = _fill_cell_content(word_cell, cell_tag, doc, context, cell_extra_fmt)
                    warnings.extend(cell_warnings)

                except Exception:
                    warnings.append(f"[表格] 处理单元格({i},{col_idx})时出错")

                col_idx += colspan

        if caption_para is not None:
            return [caption_para, table], warnings
        return table, warnings

    except Exception:
        return None, warnings


def _fix_vmerge(
    table: Table,
    start_row: int,
    start_col: int,
    end_row: int,
    end_col: int,
) -> None:
    """
    修复 python-docx 0.8.11 merge() 后缺失的 vMerge 继续标记。

    python-docx 的 cell.merge() 只在起始单元格写入
    ``<w:vMerge w:val="restart"/>``，合并范围内后续单元格不会
    自动添加 ``<w:vMerge/>``（continue），导致 Word 无法正确
    识别垂直合并。本函数补齐这些缺失的标记。

    通过直接操作 XML 避免触发 python-docx 的 cell 自动创建行为。

    Args:
        table: Word Table 对象。
        start_row: 合并起始行索引。
        start_col: 合并起始列索引。
        end_row: 合并结束行索引。
        end_col: 合并结束列索引。
    """
    try:
        ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        # 通过 table._tbl 直接获取所有行，避免 table.cell() 的副作用
        tr_elements = table._tbl.findall(f"{{{ns}}}tr")
        for r in range(start_row, end_row + 1):
            if r >= len(tr_elements):
                break
            tr = tr_elements[r]
            tc_elements = tr.findall(f"{{{ns}}}tc")
            for c in range(start_col, end_col + 1):
                if r == start_row and c == start_col:
                    continue  # 首单元格由 python-docx merge 处理
                if c >= len(tc_elements):
                    break
                try:
                    tc = tc_elements[c]
                    tcPr = tc.find(f"{{{ns}}}tcPr")
                    if tcPr is None:
                        tcPr = OxmlElement("w:tcPr")
                        tc.insert(0, tcPr)
                    existing = tcPr.find(f"{{{ns}}}vMerge")
                    if existing is not None:
                        # 如果 python-docx 错误地写入了 restart，
                        # 修正为 continue（即去掉 val 属性）
                        val = existing.get(f"{{{ns}}}val")
                        if val == "restart":
                            existing.attrib.pop(f"{{{ns}}}val", None)
                    else:
                        vm = OxmlElement("w:vMerge")
                        tcPr.append(vm)
                except Exception:
                    pass
    except Exception:
        pass


def _add_table_caption(
    doc: Document,
    caption_tag: Tag,
    context: Dict[str, Any],
) -> Tuple[Optional[object], List[str]]:
    """
    为表格添加标题段落（<caption>）。

    创建一个居中、粗体的段落，渲染 caption 内部的文本和内联元素，
    通过 space_after 与表格之间留出间距。

    Args:
        doc: Word Document。
        caption_tag: BeautifulSoup <caption> Tag。
        context: 上下文字典。

    Returns:
        (caption段落对象或None, 警告字符串列表)
    """
    warnings: List[str] = []
    cap_para = None
    try:
        # 创建标题段落
        cap_para = doc.add_paragraph()
        cap_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        # 标题和表格之间留间距（替代独立 spacer 段落）
        cap_para.paragraph_format.space_after = Pt(2)

        # 将 caption 内的文本作为粗体渲染
        cap_formatting = {"bold": True}
        style_str = caption_tag.get("style", "") if hasattr(caption_tag, "get") else ""
        if style_str:
            cap_warnings = apply_style_to_paragraph(cap_para, style_str)
            warnings.extend(cap_warnings)
            # 也解析样式到格式字典（函数已从顶部导入）
            for prop_name, prop_value in _parse_style_string(style_str):
                if prop_name.lower() == "color":
                    c = parse_color(prop_value)
                    if c:
                        cap_formatting["color"] = c

        inline_warnings = add_inline_content(cap_para, caption_tag, context, cap_formatting)
        warnings.extend(inline_warnings)

    except Exception:
        cap_para = None  # caption 处理失败不影响表格生成

    return cap_para, warnings


def _fill_cell_content(
    word_cell,
    cell_tag: Tag,
    doc: Document,
    context: Dict[str, Any],
    extra_formatting: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """
    填充单个表格单元格的内容，支持嵌套表格。

    逐个遍历 <td>/<th> 的直接子节点：
    - 文本节点和内联标签 → 追加到段落的 Run 中
    - <table> 标签 → 递归调用 build_table()，然后将生成的
      Word Table 从文档正文移入当前单元格

    Args:
        word_cell: python-docx Cell 对象。
        cell_tag: BeautifulSoup <td> 或 <th> Tag 对象。
        doc: Word Document 对象。
        context: 上下文字典。
        extra_formatting: 累积的格式字典（如 th 的 bold=True）。

    Returns:
        警告字符串列表。
    """
    warnings: List[str] = []
    children = list(cell_tag.children) if hasattr(cell_tag, "children") else []

    # 纯文本单元格（无子标签）：直接处理
    if not children or all(isinstance(c, NavigableString) for c in children):
        # 清除默认空段落，使用第一个段落作为容器
        for p in word_cell.paragraphs:
            p.clear()
        cell_para = word_cell.paragraphs[0]
        inline_warnings = add_inline_content(cell_para, cell_tag, context, extra_formatting)
        warnings.extend(inline_warnings)
        _apply_cell_style(cell_para, cell_tag)
        return warnings

    # 混合内容单元格：逐个处理子节点
    # 清除所有默认空段落（后续根据需要重建）
    for p in word_cell.paragraphs:
        p.clear()

    # 记录当前有一个可用的空段落，避免第一个子节点重复创建
    current_para = word_cell.paragraphs[0]

    for child in children:
        if isinstance(child, NavigableString):
            # 文本节点：追加到当前段落
            text = str(child)
            if text.strip():
                run = current_para.add_run(text)
                if extra_formatting:
                    _apply_formatting_dict(run, extra_formatting)

        elif hasattr(child, "name") and child.name:
            tag_name = child.name.lower()

            if tag_name == "table":
                # ---- 嵌套表格：递归构建 ----
                nested_result, nested_warnings = build_table(doc, child, context)
                warnings.extend(nested_warnings)
                if nested_result is not None:
                    if isinstance(nested_result, list):
                        # 有 caption：[caption_para, table] 依次移入单元格
                        for elem in nested_result:
                            _move_element_into_cell(word_cell, elem._element)
                    else:
                        # 无 caption：直接移动 table
                        _move_element_into_cell(word_cell, nested_result._element)
                # 嵌套表格之后追加一个空段落，供后续内容使用
                current_para = word_cell.add_paragraph()

            else:
                # ---- 内联/块级标签：通过 dispatch 追加到当前段落 ----
                sub_warnings = _dispatch_inline_child(current_para, child, context, extra_formatting)
                warnings.extend(sub_warnings)

    # 删除末尾可能残留的空段落
    _cleanup_trailing_empty_paragraphs(word_cell)

    return warnings


def _move_element_into_cell(word_cell, element) -> None:
    """
    将一个 XML 元素从原父节点移动到指定单元格内。

    用于将嵌套表格从文档正文转移到所属单元格中。
    """
    try:
        parent = element.getparent()
        if parent is not None:
            parent.remove(element)
        tc = word_cell._tc
        tc.append(element)
    except Exception:
        pass


def _cleanup_trailing_empty_paragraphs(word_cell) -> None:
    """
    删除单元格末尾的空段落（嵌套表格插入后可能残留）。
    至少保留一个段落作为单元格占位。
    """
    try:
        paragraphs = word_cell.paragraphs
        if len(paragraphs) <= 1:
            return
        # 从后往前检查，删除空段落
        for p in reversed(paragraphs):
            if len(paragraphs) <= 1:
                break
            if not p.text.strip():
                try:
                    p._element.getparent().remove(p._element)
                except Exception:
                    pass
    except Exception:
        pass


def _apply_cell_style(para, cell_tag) -> None:
    """将 cell_tag 的 style 属性应用到单元格段落。"""
    try:
        style_str = cell_tag.get("style", "") if hasattr(cell_tag, "get") else ""
        if style_str:
            apply_style_to_paragraph(para, style_str)
    except Exception:
        pass


def build_list(
    doc: Document,
    tag: Tag,
    context: Dict[str, Any],
    ordered: bool = False,
    level: int = 0,
) -> Tuple[List[Paragraph], List[str]]:
    """
    构建列表（ul/ol）。

    使用Word内置列表样式处理项目符号和编号。
    支持嵌套列表递归处理。

    Args:
        doc: Word Document 对象。
        tag: BeautifulSoup <ul> 或 <ol> Tag 对象。
        context: 上下文字典。
        ordered: 是否为有序列表。
        level: 嵌套层级（0开始）。

    Returns:
        (Paragraph列表, 警告列表)
    """
    elements: List[Paragraph] = []
    warnings: List[str] = []

    try:
        # 确定列表样式
        if ordered:
            style_names = [
                "List Number",
                "List Number 2",
                "List Number 3",
                "List Number 4",
                "List Number 5",
            ]
        else:
            style_names = [
                "List Bullet",
                "List Bullet 2",
                "List Bullet 3",
                "List Bullet 4",
                "List Bullet 5",
            ]

        style_name = style_names[min(level, len(style_names) - 1)]

        # 获取所有 li 元素
        list_items = tag.find_all("li", recursive=False)
        if not list_items:
            list_items = tag.find_all("li")

        for li in list_items:
            # 检查 li 中是否包含嵌套列表
            nested_lists = li.find_all(["ul", "ol"], recursive=False)
            _ = len(nested_lists) > 0

            # 创建列表项段落
            para = doc.add_paragraph()

            # 应用列表样式
            try:
                para.style = doc.styles[style_name]  # type: ignore[assignment]
            except KeyError:
                # 如果样式不存在，使用基本列表样式
                try:
                    para.style = doc.styles["List Number" if ordered else "List Bullet"]  # type: ignore[assignment]
                except KeyError:
                    pass

            # 应用内联样式
            style_str = li.get("style", "") if hasattr(li, "get") else ""
            if style_str:
                li_warnings = apply_style_to_paragraph(para, style_str)
                warnings.extend(li_warnings)

            # 处理 li 的直接文本和内联元素（不包括嵌套列表）
            for child in li.children:
                if isinstance(child, Tag) and child.name in ("ul", "ol"):
                    continue  # 嵌套列表单独处理
                inline_warnings = _dispatch_inline_child(para, child, context)
                warnings.extend(inline_warnings)

            elements.append(para)

            # 递归处理嵌套列表
            for nested in nested_lists:
                nested_ordered = nested.name == "ol"
                nested_elements, nested_warnings = build_list(
                    doc, nested, context, ordered=nested_ordered, level=level + 1
                )
                elements.extend(nested_elements)
                warnings.extend(nested_warnings)

        return elements, warnings

    except Exception:
        return elements, warnings


def add_inline_content(
    para,
    tag: Tag,
    context: Dict[str, Any],
    extra_formatting: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """
    递归处理HTML标签内的内联内容，向段落添加 Run。

    遍历 tag 的所有子节点，委托 _dispatch_inline_child 路由到对应的
    内联处理器（文本节点 / br / b / i / u / span / a / img / div 等）。

    Args:
        para: python-docx Paragraph 对象。
        tag: BeautifulSoup Tag 对象。
        context: 上下文字典。
        extra_formatting: 额外的格式设置，如 {'bold': True}。

    Returns:
        警告字符串列表。
    """
    warnings: List[str] = []

    try:
        for child in tag.children:
            child_warnings = _dispatch_inline_child(para, child, context, extra_formatting)
            warnings.extend(child_warnings)
    except Exception:
        pass

    return warnings


# =========================================================================
# 内联元素处理器（由 _dispatch_inline_child 调度）
# 每个处理器的签名统一为：
#   (para, child, context, extra_formatting) -> List[str]
# =========================================================================

#: 内联标签名 -> 处理器函数的 dispatch 表
_INLINE_DISPATCH: dict = {}


def _register(tag_names):
    """装饰器：将函数注册到 _INLINE_DISPATCH 中。"""

    def decorator(fn):
        for name in tag_names:
            _INLINE_DISPATCH[name] = fn
        return fn

    return decorator


def _dispatch_inline_child(
    para,
    child,
    context: Dict[str, Any],
    extra_formatting: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """
    向段落添加单个子元素的路由入口。

    根据节点类型（文本/Tag）和标签名查表分派到对应处理器。
    未知标签回退到纯文本处理。

    Args:
        para: 段落对象。
        child: BeautifulSoup 子节点。
        context: 上下文字典。
        extra_formatting: 累积的格式字典。

    Returns:
        警告字符串列表。
    """
    # ---- 文本节点 ----
    if isinstance(child, NavigableString):
        return _handle_text_node(para, child, context, extra_formatting)

    # ---- 确保是 Tag ----
    if not hasattr(child, "name") or child.name is None:
        return []

    tag_name = child.name.lower() if child.name else ""

    # ---- 查表分派 ----
    handler = _INLINE_DISPATCH.get(tag_name, _handle_unknown_tag)
    try:
        return handler(para, child, context, extra_formatting)
    except Exception:
        return []


# ---- 文本节点处理器 ----


def _handle_text_node(para, child, context, extra_formatting) -> List[str]:
    """处理 NavigableString 文本节点：创建 Run 并应用累积格式。"""
    text = str(child)
    if text:
        run = para.add_run(text)
        if extra_formatting:
            _apply_formatting_dict(run, extra_formatting)
    return []


# ---- 换行处理器 ----


@_register(["br"])
def _handle_br(para, child, context, extra_formatting) -> List[str]:
    """处理 <br>：在当前 Run 中插入换行符。"""
    run = para.add_run()
    run.add_break()
    return []


# ---- 统一格式化标签处理器（b/strong, i/em, u） ----

#: 标签名 -> 格式化字典 key 的映射
_FORMAT_FLAG_MAP = {
    "b": "bold",
    "strong": "bold",
    "i": "italic",
    "em": "italic",
    "u": "underline",
    "ins": "underline",  # 插入线 → 下划线
    "del": "strike",  # 删除线 → 中划线
    "sub": "subscript",  # 下标
    "sup": "superscript",  # 上标
}


@_register(["b", "strong", "i", "em", "u", "del", "ins", "sub", "sup"])
def _handle_formatting_tag(para, child, context, extra_formatting) -> List[str]:
    """
    处理格式化标签（<b>/<strong>/<i>/<em>/<u>）。

    将标签对应的格式标志合并到累积格式化字典中（不修改原字典），
    然后递归处理子节点。
    """
    tag_name = child.name.lower() if child.name else ""
    flag_key = _FORMAT_FLAG_MAP.get(tag_name)
    if flag_key is None:
        return []

    fmt = (extra_formatting or {}).copy()
    fmt[flag_key] = True

    warnings: List[str] = []
    for sub in child.children:
        sub_warnings = _dispatch_inline_child(para, sub, context, fmt)
        warnings.extend(sub_warnings)
    return warnings


# ---- span 处理器 ----


@_register(["span"])
def _handle_span(para, child, context, extra_formatting) -> List[str]:
    """
    处理 <span>：解析 style 属性并合并到累积格式字典，
    然后递归处理子节点。不创建额外的 Word 结构。
    """
    fmt = (extra_formatting or {}).copy()
    style_str = child.get("style", "")
    if style_str:
        span_fmt = _parse_inline_style_to_dict(style_str)
        fmt.update(span_fmt)

    warnings: List[str] = []
    for sub in child.children:
        sub_warnings = _dispatch_inline_child(para, sub, context, fmt)
        warnings.extend(sub_warnings)
    return warnings


# ---- 超链接处理器 ----


@_register(["a"])
def _handle_a(para, child, context, extra_formatting) -> List[str]:
    """
    处理 <a>：创建超链接。

    python-docx 仅支持 href 属性，以下属性无法直接映射到 Word，
    将通过警告告知调用方：
    - target（如 _blank）：Word 不支持运行时打开方式
    - title：Word 原生超链接不支持悬停提示
    - rel / download / hreflang 等：均不支持

    如有特殊链接类型（mailto:/tel:），也会记录警告供调用方知晓。
    """
    warnings: List[str] = []

    href = child.get("href", "")

    # ---- 检测不支持的属性并追加警告 ----
    unsupported_attrs = _get_unsupported_link_attrs(child)
    if unsupported_attrs:
        warnings.append(f"[链接] 以下属性在Word中不受支持（已忽略）: {', '.join(sorted(unsupported_attrs))}")

    # ---- 特殊协议的提示 ----
    if href:
        lower_href = href.strip().lower()
        if lower_href.startswith("mailto:"):
            warnings.append("[链接] href 为 mailto: 协议，Word 中将以纯文本显示")
        elif lower_href.startswith("tel:"):
            warnings.append("[链接] href 为 tel: 协议，Word 中将以纯文本显示")

    link_text = child.get_text()
    if link_text:
        _add_hyperlink_to_paragraph(para, href, link_text, extra_formatting)
    return warnings


#: <a> 标签中 python-docx 不支持的属性集合（会触发警告）
_UNSUPPORTED_LINK_ATTRS = {
    "target",  # 如 _blank — Word 不支持运行时打开方式
    "title",  # 悬停提示 — Word 超链接没有此机制
    "rel",  # 如 nofollow/noreferrer
    "download",  # 强制下载
    "hreflang",  # 语言声明
    "type",  # MIME 类型
    "ping",  # 点击追踪
    "referrerpolicy",
    "media",
    "shape",
    "coords",
    "rev",
    "charset",
    "name",  # 锚点名称（Word 不支持命名锚点）
    "accesskey",
}


def _get_unsupported_link_attrs(tag) -> list:
    """
    从 <a> 标签中提取不被 python-docx 支持的属性名列表。

    Args:
        tag: BeautifulSoup <a> Tag 对象。

    Returns:
        不支持的属性名列表（仅返回实际存在于 tag 上的属性）。
    """
    if not hasattr(tag, "attrs"):
        return []
    present = [attr for attr in _UNSUPPORTED_LINK_ATTRS if tag.has_attr(attr)]
    return present


# ---- 图片处理器 ----


@_register(["img"])
def _handle_img(para, child, context, extra_formatting) -> List[str]:
    """
    处理 <img>：将图片插入到当前段落中。
    加载失败时在段落中插入降级文本 [图片加载失败: src]。
    """
    warnings: List[str] = []
    img_warnings = handle_image_to_paragraph(para, child)
    warnings.extend(img_warnings)
    # 检查是否有图片被插入（run 中包含图片）
    has_picture = any(
        r._element.findall(".//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}inline")
        for r in para.runs
    )
    if not has_picture:
        src = child.get("src", "") if hasattr(child, "get") else ""
        para.add_run(f"[图片加载失败: {src}]")
    return warnings


# ---- <mark> 高亮标记处理器 ----

# Word 高亮颜色枚举值（黄色）
_WD_YELLOW = 7


@_register(["mark"])
def _handle_mark(para, child, context, extra_formatting) -> List[str]:
    """
    处理 <mark>：对包含的文本设置黄色高亮背景。

    在 Word 中映射为 run.font.highlight_color = 7 (YELLOW)。
    """
    fmt = (extra_formatting or {}).copy()
    fmt["highlight"] = _WD_YELLOW

    warnings: List[str] = []
    for sub in child.children:
        sub_warnings = _dispatch_inline_child(para, sub, context, fmt)
        warnings.extend(sub_warnings)
    return warnings


# ---- <small> 小号字体处理器 ----

_SMALL_FONT_RATIO = 0.8  # small 字体缩放比例


@_register(["small"])
def _handle_small(para, child, context, extra_formatting) -> List[str]:
    """
    处理 <small>：将内部字体缩小为正常大小的 80%。

    在当前上下文字体大小基础上乘以 0.8；若未指定字体大小，
    则使用 Word 默认正文大小（11pt）作为基准。
    """
    fmt = (extra_formatting or {}).copy()
    # 获取当前字体大小作为基准
    base_size = fmt.get("font_size", Pt(11))
    try:
        new_size = Pt(int(base_size.pt * _SMALL_FONT_RATIO))
        fmt["font_size"] = new_size
    except Exception:
        pass  # 计算失败则保持原大小

    warnings: List[str] = []
    for sub in child.children:
        sub_warnings = _dispatch_inline_child(para, sub, context, fmt)
        warnings.extend(sub_warnings)
    return warnings


# ---- div 透明处理器 ----


@_register(["div"])
def _handle_div(para, child, context, extra_formatting) -> List[str]:
    """
    处理 <div>：透明传递，不创建额外结构，递归处理子元素。
    """
    warnings: List[str] = []
    for sub in child.children:
        sub_warnings = _dispatch_inline_child(para, sub, context, extra_formatting)
        warnings.extend(sub_warnings)
    return warnings


# ---- 未知标签回退处理器 ----


def _handle_unknown_tag(para, child, context, extra_formatting) -> List[str]:
    """
    处理不支持的标签：忽略标签本身，仅提取内部文本作为 Run。
    """
    text = child.get_text()
    if text:
        run = para.add_run(text)
        if extra_formatting:
            _apply_formatting_dict(run, extra_formatting)
    return []


def _add_hyperlink_to_paragraph(
    para,
    url: str,
    text: str,
    extra_formatting: Optional[Dict[str, Any]] = None,
) -> None:
    """
    向段落添加一个超链接。

    使用XML操作实现，因为python-docx高层API不直接支持超链接。

    Args:
        para: 段落对象。
        url: 链接URL。
        text: 显示文本。
        extra_formatting: 额外的格式设置。
    """
    try:
        part = para.part
        r_id = part.relate_to(
            url,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
            is_external=True,
        )

        # 创建 w:hyperlink 元素
        hyperlink = OxmlElement("w:hyperlink")
        hyperlink.set(qn("r:id"), r_id)

        # 创建 w:r (run) 元素
        r = OxmlElement("w:r")

        # 创建 run properties
        rPr = OxmlElement("w:rPr")
        # 超链接样式颜色（蓝色）
        c = OxmlElement("w:color")
        c.set(qn("w:val"), "0563C1")
        rPr.append(c)
        # 下划线
        u = OxmlElement("w:u")
        u.set(qn("w:val"), "single")
        rPr.append(u)

        if extra_formatting:
            if extra_formatting.get("bold"):
                rPr.append(_make_ooxml_element("w:b"))
            if extra_formatting.get("italic"):
                rPr.append(_make_ooxml_element("w:i"))
            if extra_formatting.get("strike"):
                rPr.append(_make_ooxml_element("w:strike"))
            if extra_formatting.get("subscript"):
                rPr.append(_make_ooxml_element("w:vertAlign", {"w:val": "subscript"}))
            if extra_formatting.get("superscript"):
                rPr.append(_make_ooxml_element("w:vertAlign", {"w:val": "superscript"}))

        r.append(rPr)

        # 创建文本节点
        t = OxmlElement("w:t")
        t.set(qn("xml:space"), "preserve")
        t.text = text
        r.append(t)

        hyperlink.append(r)
        para._element.append(hyperlink)

    except Exception:
        # 降级：添加普通文本
        run = para.add_run(f"{text} ({url})")
        if extra_formatting:
            _apply_formatting_dict(run, extra_formatting)


def _parse_inline_style_to_dict(style_str: str) -> Dict[str, Any]:
    """
    将内联 style 字符串解析为格式化字典。

    用于 span 标签的样式继承。

    Args:
        style_str: CSS style 属性值。

    Returns:
        格式化字典，键为 bold/italic/underline/color/font_size/font_name。
    """
    fmt: Dict[str, Any] = {}
    if not style_str:
        return fmt

    properties = _parse_style_string(style_str)

    for prop_name, prop_value in properties:
        prop_lower = prop_name.lower()
        if prop_lower == "font-weight":
            if prop_value.strip().lower() in ("bold", "700", "800", "900"):
                fmt["bold"] = True
        elif prop_lower == "font-style":
            if prop_value.strip().lower() == "italic":
                fmt["italic"] = True
        elif prop_lower == "text-decoration":
            v = prop_value.strip().lower()
            if "underline" in v:
                fmt["underline"] = True
            elif "line-through" in v:
                fmt["strike"] = True
        elif prop_lower == "letter-spacing":
            twips = _parse_length_twips(prop_value)
            if twips is not None:
                fmt["letter_spacing_twips"] = twips
        elif prop_lower == "color":
            color = parse_color(prop_value)
            if color:
                fmt["color"] = color
        elif prop_lower == "font-size":
            size = parse_font_size(prop_value)
            if size:
                fmt["font_size"] = size
        elif prop_lower == "font-family":
            font_name = prop_value.split(",")[0].strip().strip("'\"")
            if font_name:
                fmt["font_name"] = font_name

    return fmt


# _make_ooxml_element 从 engine.style_mapper 统一导入，见模块顶部


def _apply_formatting_dict(run, fmt: Dict[str, Any]) -> None:
    """
    将格式化字典应用到 Run 对象。

    Args:
        run: python-docx Run 对象。
        fmt: 格式化字典。
    """
    try:
        if fmt.get("bold"):
            run.bold = True
        if fmt.get("italic"):
            run.italic = True
        if fmt.get("underline"):
            run.underline = True
        if fmt.get("strike"):
            run.font.strike = True
        if fmt.get("subscript"):
            run.font.subscript = True
        if fmt.get("superscript"):
            run.font.superscript = True
        if fmt.get("highlight"):
            run.font.highlight_color = fmt["highlight"]
        if fmt.get("color"):
            run.font.color.rgb = fmt["color"]
        if fmt.get("font_size"):
            run.font.size = fmt["font_size"]
        if fmt.get("font_name"):
            run.font.name = fmt["font_name"]
            # 设置东亚字体（中文等）
            _set_east_asian_font(run, fmt["font_name"])
        if fmt.get("letter_spacing_twips"):
            _set_run_spacing(run, fmt["letter_spacing_twips"])
    except Exception:
        pass


def _set_east_asian_font(run, font_name: str) -> None:
    """
    设置 Run 的东亚字体（用于中文、日文、韩文等）。

    Args:
        run: python-docx Run 对象。
        font_name: 字体名称。
    """
    try:
        from lxml import etree

        rPr = run._element.get_or_add_rPr()
        rFonts = rPr.find(qn("w:rFonts"))
        if rFonts is None:
            rFonts = etree.SubElement(rPr, qn("w:rFonts"))
        rFonts.set(qn("w:eastAsia"), font_name)
    except Exception:
        pass


def build_plain_text_paragraph(
    doc: Document,
    text: str,
    context: Dict[str, Any],
) -> Paragraph:
    """
    构建纯文本段落。

    Args:
        doc: Word Document 对象。
        text: 纯文本内容。
        context: 上下文字典。

    Returns:
        Paragraph 对象。
    """
    para = doc.add_paragraph()
    para.add_run(text)
    return para
