"""
通用HTML-to-Word渲染引擎。

两个核心入口函数：
- generate()                — 无模板模式，传入内容字符串生成新文档
- generate_from_template() — 有模板模式，加载模板 .docx 并替换 {{占位符}}

核心原则：永不抛出异常，所有异常通过返回值中的 errors/warnings 列表体现。

用法:
    from engine import generate, generate_from_template

    # 无模板模式：传入内容字符串，直接生成
    result = generate(
        content="<h1>标题</h1><p>正文内容</p>",
        output_path="output.docx",
    )

    # 有模板模式：基于模板填充数据
    result = generate_from_template(
        template_path="template.docx",
        content_map={"title": "Hello", "body": "<p>Content</p>"},
        output_path="output.docx",
    )

    if result["success"]:
        print(f"生成成功: {result['output']}")
    else:
        print(f"错误: {result['errors']}")
"""

from __future__ import annotations

import copy as _copy
import os.path
from io import BytesIO
from typing import Any, Callable, Dict, List, Optional, Union

from docx import Document
from docx.table import Table as Table
from docx.text.paragraph import Paragraph as Paragraph

from engine.chart_renderer import ChartRenderer as ChartRenderer
from engine.parser import parse_html_to_elements
from engine.tag_style import Style as Style
from engine.tag_style import TagStyle as TagStyle
from engine.tag_style import cell as cell
from engine.utils import (
    CellValue,
    extract_placeholder_name,
    fill_cloned_row_by_position,
    find_all_placeholders,
    find_inline_placeholders,
    find_table_template_rows,
    get_sorted_placeholder_names,
    insert_elements_after,
    is_html,
    remove_paragraph,
    set_doc_default_font,
)
from engine.word_builder import WordElement as WordElement
from engine.word_builder import build_plain_text_paragraph

# content_map 中每个 value 的三种形式：
#   - 纯字符串：自动检测（同时含 < 和 > 则视为 HTML）
#   - dict {"type": "text"|"html", "content": "..."}：显式指定类型
#   - dict {"type": "rows", "content": [[...], ...]}：表格模板行展开
ContentValue = Union[str, Dict[str, Any]]


def _generate_document(
    template_path: Optional[str] = None,
    content_map: Optional[Dict[str, ContentValue]] = None,
    output_path: Optional[str] = None,
    placeholder_hooks: Optional[Dict[str, Callable]] = None,
    tag_hooks: Optional[Dict[str, Callable]] = None,
    allowed_image_dirs: Optional[List[str]] = None,
    default_font_name: Optional[str] = None,
) -> Dict[str, Union[bool, Union[str, BytesIO], List[str]]]:
    """
    内部实现：生成Word文档。

    根据是否提供模板路径，进入有模板或无模板模式。

    Args:
        template_path: 模板 .docx 文件路径。若为 None 则进入无模板模式。
        content_map: 占位符名 -> 内容的映射字典。支持三种 value 形式：
            - str: 自动检测 text/html
            - {"type":"text"|"html", "content":"..."}: 显式指定类型
            - {"type":"rows", "content":[[...],...]}: 表格模板行展开
        output_path: 输出文件路径。若为 None 则返回 BytesIO。
        placeholder_hooks: 占位符钩子字典。
        tag_hooks: 标签钩子字典。
        allowed_image_dirs: 本地图片路径白名单。
        default_font_name: 无模板模式下的默认字体名称。

    Returns:
        {"success": bool, "output": str|BytesIO|None, "errors": [...], "warnings": [...]}
    """
    errors: List[str] = []
    warnings: List[str] = []

    content_map = content_map or {}
    placeholder_hooks = placeholder_hooks or {}
    tag_hooks = tag_hooks or {}

    # 设置本地图片路径白名单（若指定）
    from engine.image_handler import set_allowed_image_dirs

    set_allowed_image_dirs(allowed_image_dirs)

    doc = None

    # =====================================================================
    # 阶段1：加载/创建文档
    # =====================================================================
    try:
        if template_path is not None:
            # --- 有模板模式 ---
            # 先检查文件是否存在
            if not os.path.isfile(template_path):
                return {
                    "success": False,
                    "output": None,
                    "errors": [f"[模板] 文件不存在: {template_path}"],
                    "warnings": [],
                }
            try:
                doc = Document(template_path)
            except Exception as e:
                return {
                    "success": False,
                    "output": None,
                    "errors": [f"[模板] 加载模板失败: {e}"],
                    "warnings": [],
                }

            # 用户指定了默认字体时设置 docDefaults（覆盖模板字体）
            if default_font_name:
                set_doc_default_font(doc, default_font_name)

            # 查找模板中的占位符
            placeholders_found = find_all_placeholders(doc)

            # 如果 content_map 不为空但模板中没找到占位符
            if content_map and not placeholders_found:
                return {
                    "success": False,
                    "output": None,
                    "errors": ["[模板] 未找到任何占位符"],
                    "warnings": [],
                }

            # 处理 content_map 中的每个占位符
            if content_map and placeholders_found:
                proc_errors, proc_warnings = _process_template_content(
                    doc, content_map, placeholders_found, placeholder_hooks, tag_hooks
                )
                errors.extend(proc_errors)
                warnings.extend(proc_warnings)

            # The three front-matter catalogs share one TOC style system.
            # Figure/table entries are collected from actual caption paragraphs
            # through hidden TC fields, then exposed by separate TOC fields.
            try:
                from toc_styles import (
                    ensure_abstract_catalog_marks,
                    ensure_figure_table_catalogs,
                    mark_figure_table_captions,
                )
                ensure_abstract_catalog_marks(doc)
                mark_figure_table_captions(doc)
                ensure_figure_table_catalogs(doc)
            except Exception as e:
                warnings.append(f"[目录] 图目录/表目录配置失败: {e}")

        else:
            # --- 无模板模式 ---
            doc = Document()

            # 用户指定了默认字体时设置 docDefaults
            if default_font_name:
                set_doc_default_font(doc, default_font_name)

            if content_map:
                proc_errors, proc_warnings = _process_no_template_content(
                    doc, content_map, placeholder_hooks, tag_hooks
                )
                errors.extend(proc_errors)
                warnings.extend(proc_warnings)

    except Exception as e:
        # 兜底捕获：确保任何意外异常都转换为错误返回
        return {
            "success": False,
            "output": None,
            "errors": [f"[引擎] 未预期的异常: {e}"],
            "warnings": [],
        }

    # =====================================================================
    # 阶段2：保存文档
    # =====================================================================
    output = None

    # 如果有不可恢复的错误（如HTML整体解析失败），不生成输出
    fatal_error_keywords = [
        "[解析] HTML解析失败",
        "[模板] 文件不存在",
        "[模板] 未找到任何占位符",
    ]
    has_fatal_error = any(any(keyword in err for keyword in fatal_error_keywords) for err in errors)

    if not has_fatal_error:
        try:
            if output_path:
                doc.save(output_path)
                output = output_path
            else:
                buffer = BytesIO()
                doc.save(buffer)
                buffer.seek(0)
                output = buffer
        except Exception as e:
            errors.append(f"[保存] 文件保存失败: {e}")
            output = None

    return {
        "success": len(errors) == 0,
        "output": output,
        "errors": errors,
        "warnings": warnings,
    }


# =========================================================================
# 公开入口函数
# =========================================================================


def generate(
    content: str,
    output_path: Optional[str] = None,
    tag_hooks: Optional[Dict[str, Callable]] = None,
    allowed_image_dirs: Optional[List[str]] = None,
    default_font_name: Optional[str] = None,
) -> Dict[str, Union[bool, Union[str, BytesIO], List[str]]]:
    """
    无模板模式：传入内容字符串，生成新的 Word 文档。

    Args:
        content: 文档内容字符串（支持 HTML 或 TagStyle 拼接的输出）。
        output_path: 输出文件路径。若为 None 则返回 BytesIO。
        tag_hooks: 标签钩子字典。
        allowed_image_dirs: 本地图片路径白名单。
        default_font_name: 全文默认字体名称。

    Returns:
        {"success": bool, "output": str|BytesIO|None, "errors": [...], "warnings": [...]}

    Example:
        from engine import generate
        from engine import TagStyle

        s = TagStyle(font_name="仿宋", font_size="16pt", indent="2em")
        result = generate(
            content=s.h1("标题") + s.p("正文内容"),
            output_path="out.docx",
            default_font_name="仿宋",
        )
    """
    return _generate_document(
        template_path=None,
        content_map={"body": content} if content else {},
        output_path=output_path,
        tag_hooks=tag_hooks,
        allowed_image_dirs=allowed_image_dirs,
        default_font_name=default_font_name,
    )


def generate_from_template(
    template_path: str,
    content_map: Dict[str, ContentValue],
    output_path: Optional[str] = None,
    placeholder_hooks: Optional[Dict[str, Callable]] = None,
    tag_hooks: Optional[Dict[str, Callable]] = None,
    allowed_image_dirs: Optional[List[str]] = None,
) -> Dict[str, Union[bool, Union[str, BytesIO], List[str]]]:
    """
    有模板模式：加载 Word 模板，替换其中的 {{占位符}} 并生成文档。

    content_map 的 value 支持三种形式：

    - str：自动检测 text/html
    - {"type": "text"|"html", "content": "..."}：显式指定类型
    - {"type": "rows", "content": [[...], ...]}：表格模板行展开
      按索引匹配：第 N 个 type="rows" 对应第 N 个模板行。
      每行的数组按列位置填入，单元格值也支持 str/{"type":"text"|"html","content":"..."}。

    Args:
        template_path: 模板 .docx 文件路径（必填）。
        content_map: 占位符名 -> 内容的映射字典。
        output_path: 输出文件路径。若为 None 则返回 BytesIO。
        placeholder_hooks: 占位符钩子字典。
        tag_hooks: 标签钩子字典。
        allowed_image_dirs: 本地图片路径白名单。

    Returns:
        {"success": bool, "output": str|BytesIO|None, "errors": [...], "warnings": [...]}

    Example:
        result = generate_from_template(
            template_path="template.docx",
            content_map={
                "TITLE": "阀室巡检报告",
                "检查人": "张建国",
                "阀室表格": {
                    "type": "rows",
                    "content": [
                        ["1", "<b>北干线1#</b>", "XX省道...", "截断阀室", "有", ""],
                        ["2", "南干线截断阀室", "XX市...", "分输阀室", "无", "需维护"],
                    ],
                },
            },
            output_path="output.docx",
        )
    """
    return _generate_document(
        template_path=template_path,
        content_map=content_map,
        output_path=output_path,
        placeholder_hooks=placeholder_hooks,
        tag_hooks=tag_hooks,
        allowed_image_dirs=allowed_image_dirs,
    )


# =========================================================================
# 内部辅助函数
# =========================================================================


def _normalize_content_value(raw_value: ContentValue) -> tuple:
    """
    将 content_map 的 value 统一为 (类型, 内容字符串) 的元组。

    处理三种形式：
    - 纯字符串 str：返回 (None, str_value)，类型待自动检测。
    - 结构化 dict type="text"|"html"：返回 ("html" 或 "text", dict["content"])。
    - 结构化 dict type="rows"：返回 ("rows", None)，content 由调用方单独处理。

    Args:
        raw_value: content_map 中某个 key 对应的 value。

    Returns:
        (type_str_or_None, content_str)，
        type 为 "html"/"text"/"rows"/None（None 表示需自动检测）。
    """
    if isinstance(raw_value, str):
        return None, raw_value

    if isinstance(raw_value, dict):
        content_type = (raw_value.get("type") or "").strip().lower()
        if content_type == "rows":
            return "rows", None
        content = raw_value.get("content", "") or ""
        if content_type not in ("html", "text"):
            content_type = None  # 非法 type 值，回退自动检测
        return content_type, content

    # 未知类型，当纯文本处理
    return "text", str(raw_value)


def _expand_table_row(
    doc: Document,
    tmpl: Dict[str, Any],
    row_data: List[List[Any]],
    placeholder_name: str,
    tag_hooks: Optional[Dict[str, Callable]] = None,
) -> List[str]:
    """
    展开单个表格模板行：克隆行 → 按列位置填数据 → 插入 → 删除原模板行。

    Args:
        doc: Document 对象。
        tmpl: find_table_template_rows 返回的模板行信息。
        row_data: 行数据列表，每项是单元格值列表（按列位置）。
        placeholder_name: 占位符名（用于警告消息）。
        tag_hooks: 标签钩子。

    Returns:
        警告列表。
    """
    warnings: List[str] = []

    try:
        row_element = tmpl["row"]._tr
        parent = row_element.getparent()
        if parent is None:
            return warnings

        insert_after = row_element
        for row_values in row_data:
            cloned_tr = _copy.deepcopy(row_element)
            cell_warnings = fill_cloned_row_by_position(
                cloned_tr, row_values, doc, placeholder_name, tag_hooks
            )
            warnings.extend(cell_warnings)
            insert_after.addnext(cloned_tr)
            insert_after = cloned_tr

        # 删除原始模板行
        parent.remove(row_element)

    except Exception as e:
        warnings.append(f"[表格展开] 处理异常: {e}")

    return warnings


def _should_parse_as_html(raw_value: ContentValue) -> bool:
    """
    判断 content_map 中某个 value 是否应按 HTML 解析。

    规则（按优先级）：
    1. 若 value 是 dict 且 type="html"  → True
    2. 若 value 是 dict 且 type="text" → False
    3. 若 value 是纯字符串，自动检测：同时包含 '<' 和 '>' → True

    Args:
        raw_value: content_map 中某个 key 对应的 value。

    Returns:
        True 表示应按 HTML 解析。
    """
    content_type, content = _normalize_content_value(raw_value)

    if content_type is not None:
        return content_type == "html"

    # 自动检测
    return is_html(content)


def _extract_content(raw_value: ContentValue) -> str:
    """
    从 content_map 的 value 中提取纯文本内容字符串。

    不管哪种形式，统一返回实际的内容文本。

    Args:
        raw_value: content_map 中的 value（字符串或 dict）。

    Returns:
        内容字符串。
    """
    _, content = _normalize_content_value(raw_value)
    return content


# =========================================================================
# 内部处理函数
# =========================================================================


def _process_template_content(
    doc: Document,
    content_map: Dict[str, ContentValue],
    placeholders_found: Dict[str, List],
    placeholder_hooks: Dict[str, Callable],
    tag_hooks: Dict[str, Callable],
) -> tuple:
    """
    处理模板模式下的内容替换。

    Args:
        doc: Document 对象。
        content_map: 内容字典。
        placeholders_found: 文档中找到的占位符字典。
        placeholder_hooks: 占位符钩子。
        tag_hooks: 标签钩子。

    Returns:
        (errors列表, warnings列表)
    """
    errors: List[str] = []
    warnings: List[str] = []

    # 分离纯占位符段落和内联占位符段落
    inline_paragraphs = set()
    for placeholder_name, paras in placeholders_found.items():
        for para in paras:
            if extract_placeholder_name(para.text) is None:
                inline_paragraphs.add(id(para))

    # 处理内联占位符段落（一段中有多个占位符混排文字）
    processed_inline = set()
    for placeholder_name, paras in placeholders_found.items():
        for para in paras:
            if id(para) in inline_paragraphs and id(para) not in processed_inline:
                processed_inline.add(id(para))
                _replace_inline_placeholders(para, content_map)

    # ---- 阶段A：表格模板行展开（type="rows" 的项） ----
    # key 必须匹配模板行中某个 {{key}} 占位符
    templates = find_table_template_rows(doc)
    for placeholder_name, raw_value in content_map.items():
        if not (isinstance(raw_value, dict) and (raw_value.get("type") or "").strip().lower() == "rows"):
            continue

        # 在模板行候选中查找包含 {{placeholder_name}} 的行
        matched = None
        for tmpl in templates:
            if placeholder_name in tmpl.get("anchors", []):
                matched = tmpl
                break

        if matched is None:
            warnings.append(
                f"[表格展开] 未找到包含{{{{{placeholder_name}}}}}的模板行，跳过"
            )
            continue

        row_data: List[List[CellValue]] = raw_value.get("content", []) or []
        tmp_warnings = _expand_table_row(doc, matched, row_data, placeholder_name, tag_hooks)
        warnings.extend(tmp_warnings)

    # ---- 阶段B：处理纯占位符段落（text/html 替换） ----
    for placeholder_name, raw_value in content_map.items():
        # 跳过 table 类型（已在阶段A处理）
        if isinstance(raw_value, dict) and (raw_value.get("type") or "").strip().lower() == "rows":
            continue

        if placeholder_name not in placeholders_found:
            continue  # 跳过模板中不存在的占位符

        placeholder_paragraphs = [p for p in placeholders_found[placeholder_name] if id(p) not in inline_paragraphs]
        if not placeholder_paragraphs:
            continue

        value = _extract_content(raw_value)

        if _should_parse_as_html(raw_value):
            # ---- HTML内容处理 ----
            elements, parse_errors, parse_warnings = parse_html_to_elements(doc, value, placeholder_name, tag_hooks)
            errors.extend(parse_errors)
            warnings.extend(parse_warnings)

            # 如果有HTML解析的致命错误，跳过此占位符
            if parse_errors:
                continue

            # 为参考文献标题添加分页：参考文献标题（占位符前一段）需与内容一起另起一页
            if placeholder_name == "REFERENCES" and placeholder_paragraphs:
                try:
                    from docx.oxml.ns import qn as _qn
                    prev_elem = placeholder_paragraphs[0]._element.getprevious()
                    if prev_elem is not None:
                        ns_w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                        prev_pPr = prev_elem.find(f"{{{ns_w}}}pPr")
                        if prev_pPr is None:
                            from docx.oxml import OxmlElement as _Oxml
                            prev_pPr = _Oxml("w:pPr")
                            prev_elem.insert(0, prev_pPr)
                        pb = prev_pPr.find(f"{{{ns_w}}}pageBreakBefore")
                        if pb is None:
                            from docx.oxml import OxmlElement as _Oxml
                            pb = _Oxml("w:pageBreakBefore")
                            pb.set(_qn("w:val"), "true")
                            prev_pPr.append(pb)
                except Exception:
                    pass

            # 应用占位符钩子
            if placeholder_name in placeholder_hooks:
                try:
                    context = {
                        "placeholder_name": placeholder_name,
                        "document": doc,
                        "original_value": value,
                    }
                    elements = placeholder_hooks[placeholder_name](elements, context)
                except Exception as e:
                    errors.append(f"[钩子] 占位符'{placeholder_name}'的钩子执行异常: {e}")
                    # 继续使用未经修改的 elements

            # 插入元素到第一个占位符段落位置
            if elements and placeholder_paragraphs:
                first_para = placeholder_paragraphs[0]

                # 若为 BODY 占位符，在正文之前插入 TOC 域代码
                if placeholder_name == "BODY":
                    _insert_toc_field_before(first_para, doc=doc)

                insert_elements_after(first_para._element, elements)

            # 删除所有占位符段落
            for para in placeholder_paragraphs:
                remove_paragraph(para)

        else:
            # ---- 纯文本内容处理 ----
            if not placeholder_paragraphs:
                continue

            # 应用占位符钩子（纯文本）
            final_text = value
            if placeholder_name in placeholder_hooks:
                try:
                    # 对于纯文本，创建一个临时段落元素列表传给钩子
                    temp_para = build_plain_text_paragraph(
                        doc,
                        value,
                        {"placeholder_name": placeholder_name, "document": doc},
                    )
                    context = {
                        "placeholder_name": placeholder_name,
                        "document": doc,
                        "original_value": value,
                    }
                    modified = placeholder_hooks[placeholder_name]([temp_para], context)
                    # 提取修改后的文本
                    if modified and len(modified) > 0:
                        if hasattr(modified[0], "text"):
                            final_text = modified[0].text
                            # 移除钩子创建的临时元素
                            try:
                                remove_paragraph(modified[0])
                            except Exception:
                                pass
                except Exception as e:
                    errors.append(f"[钩子] 占位符'{placeholder_name}'的钩子执行异常: {e}")

            # 纯文本占位符可能同时出现在封面、审批页和页眉中，
            # 每个位置都应替换，不能把后续出现位置当作重复段落删除。
            for para in placeholder_paragraphs:
                _set_paragraph_text(para, final_text)

    return errors, warnings


def _process_no_template_content(
    doc: Document,
    content_map: Dict[str, ContentValue],
    placeholder_hooks: Dict[str, Callable],
    tag_hooks: Dict[str, Callable],
) -> tuple:
    """
    处理无模板模式下的内容插入。

    按占位符名称字母顺序将 content_map 中的内容依次插入文档末尾。

    Args:
        doc: Document 对象。
        content_map: 内容字典。
        placeholder_hooks: 占位符钩子。
        tag_hooks: 标签钩子。

    Returns:
        (errors列表, warnings列表)
    """
    errors: List[str] = []
    warnings: List[str] = []

    sorted_names = get_sorted_placeholder_names(content_map)

    for placeholder_name in sorted_names:
        raw_value = content_map[placeholder_name]
        value = _extract_content(raw_value)

        if _should_parse_as_html(raw_value):
            # ---- HTML内容 ----
            elements, parse_errors, parse_warnings = parse_html_to_elements(doc, value, placeholder_name, tag_hooks)
            errors.extend(parse_errors)
            warnings.extend(parse_warnings)

            if parse_errors:
                continue

            # 应用占位符钩子
            if placeholder_name in placeholder_hooks:
                try:
                    context = {
                        "placeholder_name": placeholder_name,
                        "document": doc,
                        "original_value": value,
                    }
                    elements = placeholder_hooks[placeholder_name](elements, context)
                except Exception as e:
                    errors.append(f"[钩子] 占位符'{placeholder_name}'的钩子执行异常: {e}")
                    # 继续使用未经修改的 elements

            # 无模板模式下，元素已经通过 add_* 方法追加到文档末尾
            # 不需要额外操作

        else:
            # ---- 纯文本内容 ----
            para = build_plain_text_paragraph(doc, value, {"placeholder_name": placeholder_name, "document": doc})

            # 应用占位符钩子
            if placeholder_name in placeholder_hooks:
                try:
                    context = {
                        "placeholder_name": placeholder_name,
                        "document": doc,
                        "original_value": value,
                    }
                    placeholder_hooks[placeholder_name]([para], context)
                except Exception as e:
                    errors.append(f"[钩子] 占位符'{placeholder_name}'的钩子执行异常: {e}")

    return errors, warnings


def _configure_toc_styles(doc) -> None:
    """
    配置文档中所有 TOC 样式，确保目录条目使用正确的字体和行距。

    目录格式要求：
      - 中文：宋体小四（12pt），非粗体、非斜体
      - 数字/英文：Times New Roman 小四（12pt）
      - 一倍行距（single line spacing）

    覆盖两类 TOC 样式：
      1. 标准 Word toc 1 ~ toc 9
      2. WPS 自定义 目录 21 ~ 目录 91（模板中残留，eastAsia=黑体）
    """
    from docx.oxml.ns import qn
    from docx.shared import Pt

    # 需要清理的有害元素：粗体、斜体、小型大写、全部大写
    _EVIL_TAGS = ("w:b", "w:bCs", "w:i", "w:iCs", "w:smallCaps", "w:caps")

    try:
        # 收集所有需要配置的 TOC 样式名
        toc_style_names = []
        for style in doc.styles:
            name = style.name or ""
            # 匹配标准 toc N 和 WPS 目录 N1 样式
            if name.startswith("toc ") or name.startswith("目录 "):
                toc_style_names.append(name)

        for style_name in toc_style_names:
            try:
                style = doc.styles[style_name]
            except KeyError:
                continue

            font = style.font
            font.size = Pt(12)  # 小四 = 12pt
            font.bold = False
            font.italic = False
            font.name = None  # 清除预设，通过 rFonts 分别设置

            # 设置段落格式：一倍行距
            pf = style.paragraph_format
            pf.line_spacing = 1.0

            # 通过 XML 精确控制字体和清除有害格式标记
            style_elem = style.element
            rPr = style_elem.find(qn("w:rPr"))
            if rPr is None:
                from docx.oxml import OxmlElement as _Oxml
                rPr = _Oxml("w:rPr")
                name_elem = style_elem.find(qn("w:name"))
                if name_elem is not None:
                    style_elem.insert(list(style_elem).index(name_elem), rPr)
                else:
                    style_elem.append(rPr)

            # 移除旧的 rFonts
            old_rFonts = rPr.find(qn("w:rFonts"))
            if old_rFonts is not None:
                rPr.remove(old_rFonts)

            # 设置正确字体
            from docx.oxml import OxmlElement as _Oxml
            rFonts = _Oxml("w:rFonts")
            rFonts.set(qn("w:eastAsia"), "宋体")
            rFonts.set(qn("w:ascii"), "Times New Roman")
            rFonts.set(qn("w:hAnsi"), "Times New Roman")
            rPr.append(rFonts)

            # 移除所有有害元素（b, bCs, i, iCs, smallCaps, caps）
            for tag in _EVIL_TAGS:
                for elem in rPr.findall(qn(tag)):
                    rPr.remove(elem)

            # 统一 szCs 与 sz 大小
            sz = rPr.find(qn("w:sz"))
            szCs = rPr.find(qn("w:szCs"))
            if sz is not None:
                sz_val = sz.get(qn("w:val"))
                if szCs is not None:
                    szCs.set(qn("w:val"), sz_val)

    except Exception:
        pass  # TOC 样式配置失败不影响报告生成


def _add_section_break_after(para_element, doc) -> None:
    """
    在指定段落后插入分节符（下一页），将文档分为：
      - 目录部分（lowerRoman 页码，继续前节编号）
      - 正文部分（Arabic 页码，从 1 开始）

    同时修改文档级 sectPr 确保正文部分页码格式正确。

    Args:
        para_element: lxml w:p 元素，分节符将添加到其 w:pPr 中。
        doc: Document 对象。
    """
    from docx.oxml import OxmlElement as _Oxml
    from docx.oxml.ns import qn

    try:
        ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

        # 查找或创建 w:pPr
        pPr = para_element.find(f"{{{ns}}}pPr")
        if pPr is None:
            pPr = _Oxml("w:pPr")
            para_element.insert(0, pPr)

        # 检查是否已有 sectPr
        existing = pPr.find(f"{{{ns}}}sectPr")
        if existing is not None:
            return

        sectPr = _Oxml("w:sectPr")

        # 从文档级 sectPr 拷贝页面布局（页边距、纸张大小等）
        doc_sectPr = doc.sections[-1]._sectPr
        for child_tag in ("pgSz", "pgMar", "cols", "docGrid", "type"):
            for child in doc_sectPr.iterfind(f"{{{ns}}}{child_tag}"):
                import copy
                sectPr.append(copy.deepcopy(child))
                break

        # 设置目录部分页码：小写罗马数字，衔接前节编号
        pgNumType = _Oxml("w:pgNumType")
        pgNumType.set(qn("w:fmt"), "lowerRoman")
        sectPr.append(pgNumType)

        # 目录不显示页眉，只继承页脚页码；正文仍使用文档级页眉。
        for ref_tag in ("footerReference",):
            for ref in doc_sectPr.iterfind(f"{{{ns}}}{ref_tag}"):
                import copy
                sectPr.append(copy.deepcopy(ref))

        pPr.append(sectPr)

        # 修改文档级 sectPr：正文部分用阿拉伯数字，从第 1 页开始
        body_pgNumType = doc_sectPr.find(qn("w:pgNumType"))
        if body_pgNumType is not None:
            doc_sectPr.remove(body_pgNumType)
        body_pgNumType = _Oxml("w:pgNumType")
        body_pgNumType.set(qn("w:fmt"), "decimal")
        body_pgNumType.set(qn("w:start"), "1")
        doc_sectPr.append(body_pgNumType)

    except Exception:
        pass  # 分节设置失败不影响报告生成


def _insert_toc_field_before(para, doc=None) -> None:
    """
    在指定段落之前插入一个 TOC（目录）域代码段落，并设置目录分节。

    Word/WPS 的目录不是静态文本，而是通过 TOC 域代码动态生成的。
    最终排版阶段会优先调用 Microsoft Word 自动刷新并保存全部目录域；
    本函数只负责插入动态域和空缓存结果，不再写入“请手工更新域”提示。

    TOC 域代码使用 \\o "1-3" 采集正文标题，并使用 \\f C 采集
    摘要标题上的隐藏 TC 域。

    此外：
      - 配置 toc 1~3 样式为宋体小四 / Times New Roman / 一倍行距
      - 在 TOC 段落与正文之间插入分节符，目录页用小写罗马数字页码

    Args:
        para: 锚点段落对象，TOC 域将插入到此段落之前。
        doc: Document 对象（用于配置 TOC 样式和分节符）。
    """
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    try:
        # 配置 TOC 样式
        if doc is not None:
            _configure_toc_styles(doc)

        p = OxmlElement("w:p")

        # --- Run 1: fldChar begin ---
        r1 = OxmlElement("w:r")
        rPr1 = OxmlElement("w:rPr")
        r1.append(rPr1)
        fld_begin = OxmlElement("w:fldChar")
        fld_begin.set(qn("w:fldCharType"), "begin")
        fld_begin.set(qn("w:dirty"), "true")
        r1.append(fld_begin)
        p.append(r1)

        # --- Run 2: instrText ---
        r2 = OxmlElement("w:r")
        rPr2 = OxmlElement("w:rPr")
        r2.append(rPr2)
        instr = OxmlElement("w:instrText")
        instr.set(qn("xml:space"), "preserve")
        instr.text = ' TOC \\o "1-3" \\f C \\h \\z \\u '
        r2.append(instr)
        p.append(r2)

        # --- Run 3: fldChar separate ---
        r3 = OxmlElement("w:r")
        rPr3 = OxmlElement("w:rPr")
        r3.append(rPr3)
        fld_sep = OxmlElement("w:fldChar")
        fld_sep.set(qn("w:fldCharType"), "separate")
        r3.append(fld_sep)
        p.append(r3)

        # --- Run 4: 空缓存结果（由最终 Word 自动刷新填充） ---
        r4 = OxmlElement("w:r")
        rPr4 = OxmlElement("w:rPr")
        r4.append(rPr4)
        t = OxmlElement("w:t")
        t.set(qn("xml:space"), "preserve")
        t.text = ""
        r4.append(t)
        p.append(r4)

        # --- Run 5: fldChar end ---
        r5 = OxmlElement("w:r")
        rPr5 = OxmlElement("w:rPr")
        r5.append(rPr5)
        fld_end = OxmlElement("w:fldChar")
        fld_end.set(qn("w:fldCharType"), "end")
        r5.append(fld_end)
        p.append(r5)

        # 插入到锚点段落之前
        para._element.addprevious(p)

        # 在 TOC 域代码段落后插入分节符（目录/正文分节）
        if doc is not None:
            _add_section_break_after(p, doc)

    except Exception:
        pass  # TOC 插入失败不影响报告生成


def _merge_run_fonts(first_run, other_runs: list) -> None:
    """
    将其他 run 的字体属性合并到第一个 run 中。

    对于 w:rFonts 中的每个属性（ascii/hAnsi/eastAsia/cs/theme 等），
    如果 first_run 没有但 other_run 有，则复制到 first_run。
    字号同理：如果 first_run 没有 sz/szCs 但 other_run 有，则复制。

    这确保内联占位符替换后，替换文本能继承占位符 {{XXX}} 所在的 run 的字体。

    Args:
        first_run: 目标 run（保留的 run）。
        other_runs: 待合并的 run 列表（将被删除）。
    """
    from lxml import etree
    from docx.oxml.ns import qn

    try:
        rPr = first_run._element.get_or_add_rPr()
    except Exception:
        return

    # w:rFonts 属性名列表
    rfonts_attrs = [
        qn("w:ascii"), qn("w:hAnsi"), qn("w:eastAsia"), qn("w:cs"),
        qn("w:asciiTheme"), qn("w:hAnsiTheme"), qn("w:eastAsiaTheme"), qn("w:cstheme"),
    ]
    # 字号相关
    sz_attrs = [qn("w:sz"), qn("w:szCs")]

    for other_run in other_runs:
        try:
            other_rPr = other_run._element.find(qn("w:rPr"))
            if other_rPr is None:
                continue

            # 合并 w:rFonts
            other_rFonts = other_rPr.find(qn("w:rFonts"))
            if other_rFonts is not None:
                rFonts = rPr.find(qn("w:rFonts"))
                if rFonts is None:
                    rFonts = etree.SubElement(rPr, qn("w:rFonts"))
                for attr in rfonts_attrs:
                    if rFonts.get(attr) is None:
                        val = other_rFonts.get(attr)
                        if val is not None:
                            rFonts.set(attr, val)

            # 合并字号
            for sz_attr in sz_attrs:
                if rPr.find(sz_attr) is None:
                    other_sz = other_rPr.find(sz_attr)
                    if other_sz is not None:
                        sz_val = other_sz.get(qn("w:val"))
                        if sz_val is not None:
                            new_sz = etree.SubElement(rPr, sz_attr)
                            new_sz.set(qn("w:val"), sz_val)

            # 合并粗体
            if rPr.find(qn("w:b")) is None:
                other_b = other_rPr.find(qn("w:b"))
                if other_b is not None:
                    etree.SubElement(rPr, qn("w:b"))

            # 合并颜色
            if rPr.find(qn("w:color")) is None:
                other_color = other_rPr.find(qn("w:color"))
                if other_color is not None:
                    color_val = other_color.get(qn("w:val"))
                    if color_val is not None:
                        new_color = etree.SubElement(rPr, qn("w:color"))
                        new_color.set(qn("w:val"), color_val)

        except Exception:
            pass


def _replace_inline_placeholders(para, content_map: dict) -> None:
    """
    替换段落中的内联占位符（占位符与文字混排的情况）。

    如 '报告编号：{{REPORT_NO}}' 或 '{{YEAR}}年{{MONTH}}月份'，
    将所有 {{name}} 替换为 content_map 中对应的值。

    替换前会合并所有 run 的字体属性到第一个 run，
    确保替换后的文本继承占位符 run 的字体（如 ascii 字体）。

    Args:
        para: python-docx Paragraph 对象。
        content_map: 占位符名称 -> 内容的映射。
    """
    text = para.text
    names = find_inline_placeholders(text)
    if not names:
        return

    # 替换所有占位符
    new_text = text
    for name in names:
        if name in content_map:
            value = _extract_content(content_map[name])
            new_text = new_text.replace("{{" + name + "}}", value)

    # 合并其他 run 的字体属性到第一个 run，然后删除其余 run
    try:
        runs = para.runs
        if runs:
            first_run = runs[0]
            if len(runs) > 1:
                _merge_run_fonts(first_run, runs[1:])
                # 删除其余 run
                for run in runs[1:]:
                    try:
                        run._element.getparent().remove(run._element)
                    except Exception:
                        pass
            first_run.text = new_text
        elif new_text:
            para.add_run(new_text)
    except Exception:
        try:
            para.text = new_text
        except Exception:
            pass


def _set_paragraph_text(para, text: str) -> None:
    """
    安全地设置段落文本，保留原有格式。

    直接修改第一个 Run 的文本并删除其余 Run，从而保留模板中
    所有 Run 级别的 OOXML 属性（包括主题字体 w:asciiTheme、
    w:eastAsiaTheme、复杂脚本字体 w:cs 等）。

    Args:
        para: python-docx Paragraph 对象。
        text: 要设置的新文本。
    """
    try:
        runs = para.runs
        if not runs:
            if text:
                para.add_run(text)
            return

        # 保留第一个 run（含其全部格式属性），直接修改文本
        first_run = runs[0]
        first_run.text = text

        # 删除其余 run
        for run in runs[1:]:
            try:
                run._element.getparent().remove(run._element)
            except Exception:
                pass
    except Exception:
        # 降级：直接设置text属性
        try:
            para.text = text
        except Exception:
            pass
