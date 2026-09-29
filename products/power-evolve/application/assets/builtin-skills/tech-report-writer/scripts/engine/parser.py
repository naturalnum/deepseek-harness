"""
HTML解析与标签调度模块。

使用BeautifulSoup解析HTML片段，将识别到的标签分派给
word_builder 模块创建对应的Word元素。

支持递归处理HTML树结构，忽略不支持的标签（仅保留文本）。
处理标签钩子（tag_hooks），允许用户自定义标签行为。

所有函数不抛出异常，异常情况通过返回值体现。
"""

from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from bs4 import BeautifulSoup, NavigableString, Tag
from docx.document import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

from engine.word_builder import (
    _dispatch_inline_child,
    build_heading,
    build_list,
    build_paragraph,
    build_table,
)

#: 解析器可产生的Word元素类型
_WordElement = Union[Paragraph, Table]
"""单个Word元素（段落或表格）。"""
_ParseResult = Union[_WordElement, List[_WordElement]]
"""解析结果：单个元素、元素列表或None（包含失败信息时）。"""


# ---------------------------------------------------------------------------
# 支持的块级标签集合
# ---------------------------------------------------------------------------
_SUPPORTED_BLOCK_TAGS = {
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "table",
    "ul",
    "ol",
    "div",
}

# 内联标签（在 add_inline_content 中处理）
_INLINE_TAGS = {
    "b",
    "strong",
    "i",
    "em",
    "u",
    "br",
    "span",
    "a",
    "img",
}


def parse_html_to_elements(
    doc: Document,
    html_str: str,
    placeholder_name: str,
    tag_hooks: Optional[Dict[str, Callable]] = None,
) -> Tuple[List[_WordElement], List[str], List[str]]:
    """
    解析HTML片段并生成Word元素列表。

    将HTML字符串解析为BeautifulSoup树，递归遍历顶层子元素，
    将每个元素转换为python-docx对象（段落、表格等）。

    处理流程：
    1. 使用BeautifulSoup + lxml解析HTML
    2. 遍历顶层子元素
    3. 对每个支持的元素调用对应的构建函数
    4. 应用标签钩子（如果有）
    5. 收集错误和警告信息

    Args:
        doc: python-docx Document 对象。
        html_str: HTML片段字符串。
        placeholder_name: 所属占位符名称（用于钩子上下文）。
        tag_hooks: 标签钩子字典，键为标签名，值为钩子函数。

    Returns:
        (元素列表, 错误列表, 警告列表)
        元素列表中的元素可能为 None（处理失败的元素）。
    """
    errors: List[str] = []
    warnings: List[str] = []
    elements: List[_WordElement] = []

    if not html_str or not isinstance(html_str, str):
        return elements, errors, warnings

    # ---- 1. 解析HTML ----
    try:
        soup = BeautifulSoup(html_str, "lxml")
    except Exception as e:
        errors.append(f"[解析] HTML解析失败: {e}")
        return elements, errors, warnings

    # ---- 2. 获取顶层子元素 ----
    # 如果解析后存在body，使用body的子元素
    if soup.body:
        top_level_children = list(soup.body.children)
    else:
        top_level_children = list(soup.children)

    # 过滤只保留有意义的节点（Tag 或 非空文本）
    top_level_children = [
        c for c in top_level_children if isinstance(c, Tag) or (isinstance(c, NavigableString) and str(c).strip())
    ]

    if not top_level_children:
        return elements, errors, warnings

    # ---- 3. 上下文构建 ----
    context = {
        "placeholder_name": placeholder_name,
        "document": doc,
    }

    # ---- 4. 遍历并处理每个元素 ----
    for child in top_level_children:
        element, elem_errors, elem_warnings = _process_node(doc, child, context, tag_hooks)

        if elem_errors:
            errors.extend(elem_errors)
        if elem_warnings:
            warnings.extend(elem_warnings)
        if element is not None:
            # _process_node 可能返回单个元素或列表
            if isinstance(element, list):
                elements.extend(element)
            else:
                elements.append(element)

    return elements, errors, warnings


def _process_node(
    doc: Document,
    node: Tag,
    context: Dict[str, Any],
    tag_hooks: Optional[Dict[str, Callable]] = None,
) -> Tuple[Optional[_ParseResult], List[str], List[str]]:
    """
    处理单个HTML节点，生成对应的Word元素。

    递归处理：div透明传递，不支持的标签仅保留文本。

    Args:
        doc: Document 对象。
        node: BeautifulSoup 节点。
        context: 上下文字典。
        tag_hooks: 标签钩子字典。

    Returns:
        (Word元素/元素列表/None, 错误列表, 警告列表)
    """
    errors: List[str] = []
    warnings: List[str] = []

    # ---- 纯文本节点 ----
    if isinstance(node, NavigableString):
        text = str(node).strip()
        if text:
            para = doc.add_paragraph()
            para.add_run(text)
            return para, errors, warnings
        return None, errors, warnings

    # ---- 确保是 Tag ----
    if not hasattr(node, "name") or node.name is None:
        return None, errors, warnings

    tag_name = node.name.lower() if node.name else ""
    if not tag_name:
        return None, errors, warnings

    # ---- 处理块级标签 ----
    try:
        result = None

        # 标题 h1-h6
        if tag_name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            result, elem_warnings = build_heading(doc, node, context)
            warnings.extend(elem_warnings)

        # 段落 p
        elif tag_name == "p":
            result, elem_warnings = build_paragraph(doc, node, context)
            warnings.extend(elem_warnings)

        # 表格 table
        elif tag_name == "table":
            result, elem_warnings = build_table(doc, node, context)
            warnings.extend(elem_warnings)

        # 无序列表 ul
        elif tag_name == "ul":
            result, elem_warnings = build_list(doc, node, context, ordered=False)
            warnings.extend(elem_warnings)

        # 有序列表 ol
        elif tag_name == "ol":
            result, elem_warnings = build_list(doc, node, context, ordered=True)
            warnings.extend(elem_warnings)

        # div 透明处理：递归处理子元素
        elif tag_name == "div":
            sub_results: List[_WordElement] = []
            for sub_child in node.children:
                if isinstance(sub_child, NavigableString) and not str(sub_child).strip():
                    continue
                sub_result, sub_errors, sub_warnings = _process_node(doc, sub_child, context, tag_hooks)
                errors.extend(sub_errors)
                warnings.extend(sub_warnings)
                if sub_result is not None:
                    if isinstance(sub_result, list):
                        sub_results.extend(sub_result)
                    else:
                        sub_results.append(sub_result)
            return sub_results, errors, warnings

        # 内联标签或包含内联标签的未知标签：作为段落处理
        elif tag_name in _INLINE_TAGS:
            para = doc.add_paragraph()
            inline_warnings = _dispatch_inline_child(para, node, context)
            warnings.extend(inline_warnings)
            result = para

        # 不支持的标签：仅保留内部文本
        else:
            text = node.get_text().strip()
            if text:
                para = doc.add_paragraph()
                para.add_run(text)
                result = para
            else:
                return None, errors, warnings

        # ---- 应用标签钩子 ----
        if tag_hooks and tag_name in tag_hooks:
            try:
                hook_result = tag_hooks[tag_name](node, result, context)
                if hook_result is not None:
                    result = hook_result
            except Exception as e:
                errors.append(f"[钩子] 占位符'{context.get('placeholder_name', '')}'的'{tag_name}'钩子执行异常: {e}")
                # 回退使用未经修改的 result

        return result, errors, warnings

    except Exception as e:
        # 处理过程中出现意外异常，尝试降级处理
        errors.append(f"[解析] 处理标签'{tag_name}'时发生异常: {e}")
        # 尝试创建降级段落
        try:
            text = node.get_text() if hasattr(node, "get_text") else str(node)
            if text.strip():
                fallback = doc.add_paragraph()
                fallback.add_run(text.strip())
                return fallback, errors, warnings
        except Exception:
            pass
        return None, errors, warnings
