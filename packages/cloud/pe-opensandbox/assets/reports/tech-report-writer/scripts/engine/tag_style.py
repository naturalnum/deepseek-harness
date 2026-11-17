"""
TagStyle - 标签函数库

将 HTML 标签封装为 Python 函数，用户只需关注内容和样式，不用手写 HTML/CSS。

用法:
    from engine.tag_style import TagStyle, Style, cell
    from engine import generate

    s = TagStyle(font_name="仿宋", font_size="16pt", indent="2em")

    content_map = {
        "title": s.h1("报告标题"),
        "body": s.p("共发现" + s.bold("15条") + "隐患。"),
        "table": s.table_from(
            headers=["序号", "描述", "状态"],
            rows=[["1", "支护不足", "已整改"]],
        ),
    }

    result = generate(
        content=s.h1("报告标题") + s.p("共发现" + s.bold("15条") + "隐患。"),
        output_path="out.docx",
    )
"""

# 标记 cell() 返回值的特殊 key
_CELL_MARKER = "__tag_style_cell__"


class Style(object):
    """样式对象，只允许使用已支持的属性，IDE 可提示。"""

    def __init__(
        self,
        font_name=None,
        font_size=None,
        indent=None,
        color=None,
        background_color=None,
        bold=None,
        italic=None,
        underline=None,
        align=None,
        line_height=None,
        letter_spacing=None,
    ):
        self.font_name = font_name
        self.font_size = font_size
        self.indent = indent
        self.color = color
        self.background_color = background_color
        self.bold = bold
        self.italic = italic
        self.underline = underline
        self.align = align
        self.line_height = line_height
        self.letter_spacing = letter_spacing

    def _to_dict(self):
        """转为 dict，过滤掉 None 值。"""
        result = {}
        for key in (
            "font_name",
            "font_size",
            "indent",
            "color",
            "background_color",
            "bold",
            "italic",
            "underline",
            "align",
            "line_height",
            "letter_spacing",
        ):
            val = getattr(self, key)
            if val is not None:
                result[key] = val
        return result

    def _merge(self, override):
        """合并两个 Style，override 中的非 None 值覆盖 self。"""
        if override is None:
            return self
        merged = Style()
        for key in (
            "font_name",
            "font_size",
            "indent",
            "color",
            "background_color",
            "bold",
            "italic",
            "underline",
            "align",
            "line_height",
            "letter_spacing",
        ):
            val = getattr(override, key)
            if val is not None:
                setattr(merged, key, val)
            else:
                setattr(merged, key, getattr(self, key))
        return merged


class TagStyle(object):
    """标签函数库，每个 HTML 标签对应一个函数。"""

    def __init__(
        self,
        font_name=None,
        font_size=None,
        indent=None,
        color=None,
        background_color=None,
        bold=None,
        italic=None,
        underline=None,
        align=None,
        line_height=None,
        letter_spacing=None,
    ):
        """
        初始化 TagStyle 实例。

        Args:
            font_name       - 字体名称 (font-family)
            font_size       - 字体大小 (font-size)
            indent          - 首行缩进 (text-indent)
            color           - 文本颜色 (color)
            background_color - 背景颜色 (background-color)
            bold            - 粗体 (font-weight: bold)
            italic          - 斜体 (font-style: italic)
            underline       - 下划线 (text-decoration: underline)
            align           - 对齐方式 (text-align)
            line_height     - 行高 (line-height)
            letter_spacing  - 字符间距 (letter-spacing)
        """
        self._default = Style(
            font_name=font_name,
            font_size=font_size,
            indent=indent,
            color=color,
            background_color=background_color,
            bold=bold,
            italic=italic,
            underline=underline,
            align=align,
            line_height=line_height,
            letter_spacing=letter_spacing,
        )

    # ------------------------------------------------------------------
    # 块级标签
    # ------------------------------------------------------------------

    def h1(self, content, style=None):
        return self._block_tag("h1", content, style)

    def h2(self, content, style=None):
        return self._block_tag("h2", content, style)

    def h3(self, content, style=None):
        return self._block_tag("h3", content, style)

    def h4(self, content, style=None):
        return self._block_tag("h4", content, style)

    def h5(self, content, style=None):
        return self._block_tag("h5", content, style)

    def h6(self, content, style=None):
        return self._block_tag("h6", content, style)

    def p(self, content, style=None):
        return self._block_tag("p", content, style)

    def div(self, content, style=None):
        return self._block_tag("div", content, style)

    def ul(self, content, style=None):
        return self._block_tag("ul", content, style)

    def ol(self, content, style=None):
        return self._block_tag("ol", content, style)

    def li(self, content, style=None):
        return self._block_tag("li", content, style)

    def table(self, content, style=None):
        return self._block_tag("table", content, style)

    def tr(self, content, style=None):
        return self._block_tag("tr", content, style)

    def td(self, content, style=None, colspan=None, rowspan=None):
        return self._cell_tag("td", content, style, colspan, rowspan)

    def th(self, content, style=None, colspan=None, rowspan=None):
        return self._cell_tag("th", content, style, colspan, rowspan)

    def caption(self, content, style=None):
        return self._block_tag("caption", content, style)

    # ------------------------------------------------------------------
    # 内联标签
    # ------------------------------------------------------------------

    def bold(self, content, style=None):
        """粗体文本。"""
        css = self._to_css(self._merge_style(style, for_inline=True))
        if css:
            return '<b style="{}">{}</b>'.format(css, content)
        return "<b>{}</b>".format(content)

    def italic(self, content, style=None):
        """斜体文本。"""
        css = self._to_css(self._merge_style(style, for_inline=True))
        if css:
            return '<i style="{}">{}</i>'.format(css, content)
        return "<i>{}</i>".format(content)

    def underline(self, content, style=None):
        """下划线文本。"""
        css = self._to_css(self._merge_style(style, for_inline=True))
        if css:
            return '<u style="{}">{}</u>'.format(css, content)
        return "<u>{}</u>".format(content)

    def del_text(self, content, style=None):
        """删除线文本。"""
        css = self._to_css(self._merge_style(style, for_inline=True))
        if css:
            return '<del style="{}">{}</del>'.format(css, content)
        return "<del>{}</del>".format(content)

    def sup(self, content, style=None):
        """上标文本。"""
        css = self._to_css(self._merge_style(style, for_inline=True))
        if css:
            return '<sup style="{}">{}</sup>'.format(css, content)
        return "<sup>{}</sup>".format(content)

    def sub(self, content, style=None):
        """下标文本。"""
        css = self._to_css(self._merge_style(style, for_inline=True))
        if css:
            return '<sub style="{}">{}</sub>'.format(css, content)
        return "<sub>{}</sub>".format(content)

    def mark(self, content, style=None):
        """高亮标记文本。"""
        css = self._to_css(self._merge_style(style, for_inline=True))
        if css:
            return '<mark style="{}">{}</mark>'.format(css, content)
        return "<mark>{}</mark>".format(content)

    def small(self, content, style=None):
        """小号文本。"""
        css = self._to_css(self._merge_style(style, for_inline=True))
        if css:
            return '<small style="{}">{}</small>'.format(css, content)
        return "<small>{}</small>".format(content)

    def span(self, content, style=None):
        """行内容器。"""
        css = self._to_css(self._merge_style(style, for_inline=True))
        if css:
            return '<span style="{}">{}</span>'.format(css, content)
        return "<span>{}</span>".format(content)

    def link(self, text, url):
        """超链接。"""
        return '<a href="{}">{}</a>'.format(_escape_attr(url), text)

    def img(self, src, width=None, height=None):
        """图片。"""
        attrs = 'src="{}"'.format(_escape_attr(src))
        if width is not None:
            attrs += ' width="{}"'.format(width)
        if height is not None:
            attrs += ' height="{}"'.format(height)
        return "<img {}/>".format(attrs)

    def br(self):
        """换行。"""
        return "<br/>"

    # ------------------------------------------------------------------
    # table_from - 数据驱动表格快捷方法
    # ------------------------------------------------------------------

    def table_from(self, headers, rows, header_style=None, row_style=None, style=None):
        """
        数据驱动的表格快捷方法。

        Args:
            headers: 表头列表，如 ["序号", "描述", "状态"]
            rows: 数据行列表，每行是列表。
                  - 字符串 → 普通 <td>
                  - cell() 对象 → 带合并/样式的 <td>
            header_style: 表头行样式 Style 对象
            row_style: 所有数据行默认样式 Style 对象
            style: 整个表格样式 Style 对象

        Returns:
            HTML 字符串
        """
        parts = []

        # 表格开始（不继承段落级样式）
        table_css = self._to_css(self._merge_style(style, for_inline=True))
        if table_css:
            parts.append('<table style="{}">'.format(table_css))
        else:
            parts.append("<table>")

        # 表头行
        header_row_css = self._to_css(self._merge_style(header_style, for_inline=True))
        if header_row_css:
            parts.append('<tr style="{}">'.format(header_row_css))
        else:
            parts.append("<tr>")

        for h in headers:
            parts.append("<th>{}</th>".format(_escape_html(str(h))))
        parts.append("</tr>")

        # 数据行
        occupied = {}  # (row_idx, col_idx) -> remaining_rows
        for row_idx, row in enumerate(rows):
            row_css = self._to_css(self._merge_style(row_style, for_inline=True))
            if row_css:
                parts.append('<tr style="{}">'.format(row_css))
            else:
                parts.append("<tr>")

            col_idx = 0
            for cell_val in row:
                # 跳过被 rowspan 占用的列
                while (row_idx, col_idx) in occupied:
                    col_idx += 1

                if isinstance(cell_val, dict) and cell_val.get(_CELL_MARKER):
                    # cell() 返回的特殊 dict
                    content = cell_val.get("content", "")
                    colspan = cell_val.get("colspan", 1)
                    rowspan = cell_val.get("rowspan", 1)
                    cell_style = cell_val.get("style", "")

                    attrs = ""
                    if colspan > 1:
                        attrs += ' colspan="{}"'.format(colspan)
                    if rowspan > 1:
                        attrs += ' rowspan="{}"'.format(rowspan)
                        # 标记被占用的单元格
                        for dr in range(1, rowspan):
                            for dc in range(colspan):
                                occupied[(row_idx + dr, col_idx + dc)] = True
                    if cell_style:
                        attrs += ' style="{}"'.format(cell_style)

                    # cell 内容支持嵌套（已经是 HTML 字符串）
                    parts.append("<td{}>{}</td>".format(attrs, content))
                    col_idx += colspan
                else:
                    # 普通字符串
                    parts.append("<td>{}</td>".format(_escape_html(str(cell_val))))
                    col_idx += 1

            parts.append("</tr>")

        parts.append("</table>")
        return "".join(parts)

    # ------------------------------------------------------------------
    # 内部方法
    # ------------------------------------------------------------------

    # 标题标签（不继承 indent）
    _HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}

    def _merge_style(self, override, for_inline=False):
        """
        合并类默认样式和函数级覆盖样式。

        Args:
            override: Style 对象或 None
            for_inline: True 时排除段落级样式（indent/align/line_height）
        """
        if for_inline:
            # 内联标签不继承 indent/align/line_height
            base = Style(
                font_name=self._default.font_name,
                font_size=self._default.font_size,
                color=self._default.color,
                background_color=self._default.background_color,
                bold=self._default.bold,
                italic=self._default.italic,
                underline=self._default.underline,
                letter_spacing=self._default.letter_spacing,
            )
        else:
            base = self._default
        if override is not None:
            return base._merge(override)
        return base

    def _to_css(self, style):
        """将 Style 对象转为 CSS 字符串。"""
        if style is None:
            return ""

        css_map = {
            "font_name": "font-family",
            "font_size": "font-size",
            "indent": "text-indent",
            "color": "color",
            "background_color": "background-color",
            "align": "text-align",
            "line_height": "line-height",
            "letter_spacing": "letter-spacing",
        }

        parts = []
        for key, css_prop in css_map.items():
            val = getattr(style, key, None)
            if val is not None:
                parts.append("{}: {}".format(css_prop, val))
        if style.bold:
            parts.append("font-weight: bold")
        if style.italic:
            parts.append("font-style: italic")
        if style.underline:
            parts.append("text-decoration: underline")

        return "; ".join(parts)

    def _block_tag(self, tag, content, style):
        """生成块级标签 HTML。"""
        if tag in self._HEADING_TAGS:
            # 标题不继承 indent
            base = Style(
                font_name=self._default.font_name,
                font_size=self._default.font_size,
                color=self._default.color,
                background_color=self._default.background_color,
                bold=self._default.bold,
                italic=self._default.italic,
                underline=self._default.underline,
                align=self._default.align,
                line_height=self._default.line_height,
                letter_spacing=self._default.letter_spacing,
            )
            merged = base._merge(style) if style else base
        else:
            merged = self._merge_style(style)
        css = self._to_css(merged)
        if css:
            return '<{0} style="{1}">{2}</{0}>'.format(tag, css, content)
        return "<{0}>{1}</{0}>".format(tag, content)

    def _cell_tag(self, tag, content, style, colspan, rowspan):
        """生成 td/th 标签 HTML（支持 colspan/rowspan）。"""
        attrs = ""
        if colspan is not None and colspan > 1:
            attrs += ' colspan="{}"'.format(colspan)
        if rowspan is not None and rowspan > 1:
            attrs += ' rowspan="{}"'.format(rowspan)
        merged = self._merge_style(style, for_inline=True)
        css = self._to_css(merged)
        if css:
            attrs += ' style="{}"'.format(css)
        return "<{0}{1}>{2}</{0}>".format(tag, attrs, content)


# ------------------------------------------------------------------
# cell() 函数 — 单元格助手
# ------------------------------------------------------------------


def cell(content, colspan=1, rowspan=1, style=None):
    """
    单元格助手，用于 table_from 的 rows 中。

    普通单元格直接传字符串，需要合并或样式的用 cell()。

    Args:
        content: 单元格内容（可以是 HTML 字符串，支持嵌套）
        colspan: 列合并数
        rowspan: 行合并数
        style: Style 样式对象

    Returns:
        特殊 dict，table_from 内部识别处理。

    Example:
        cell("安全类", rowspan=2)
        cell("未整改", style=Style(color="red"))
        cell("合并", colspan=3, style=Style(bold=True))
    """
    css = ""
    if style is not None:
        css = _style_to_css(style)

    # 如果 content 不是已经是 HTML 的字符串，转义
    if isinstance(content, str) and "<" not in content:
        content = _escape_html(content)

    return {
        _CELL_MARKER: True,
        "content": content,
        "colspan": colspan,
        "rowspan": rowspan,
        "style": css,
    }


def _style_to_css(style):
    """将 Style 对象转为 CSS 字符串（独立函数，供 cell() 使用）。"""
    css_map = {
        "font_name": "font-family",
        "font_size": "font-size",
        "indent": "text-indent",
        "color": "color",
        "background_color": "background-color",
        "align": "text-align",
        "line_height": "line-height",
        "letter_spacing": "letter-spacing",
    }
    parts = []
    for key, css_prop in css_map.items():
        val = getattr(style, key, None)
        if val is not None:
            parts.append("{}: {}".format(css_prop, val))
    if style.bold:
        parts.append("font-weight: bold")
    if style.italic:
        parts.append("font-style: italic")
    if style.underline:
        parts.append("text-decoration: underline")
    return "; ".join(parts)


# ------------------------------------------------------------------
# 工具函数
# ------------------------------------------------------------------


def _escape_html(text):
    """转义 HTML 特殊字符。"""
    if not isinstance(text, str):
        return str(text)
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_attr(text):
    """转义 HTML 属性值中的特殊字符。"""
    if not isinstance(text, str):
        return str(text)
    return text.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
