"""
CSS内联样式解析与映射模块。

将HTML标签的 style 属性中的CSS属性解析并映射到python-docx的
Run和Paragraph对象上。不支持的CSS属性记录警告信息。

所有函数不抛出异常。
"""

import re
from typing import List, Optional, Tuple

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

# ---------------------------------------------------------------------------
# 颜色名称映射表（常用CSS颜色名 -> 十六进制）
# ---------------------------------------------------------------------------
_COLOR_NAMES: dict = {
    "red": "FF0000",
    "blue": "0000FF",
    "green": "008000",
    "black": "000000",
    "white": "FFFFFF",
    "yellow": "FFFF00",
    "orange": "FFA500",
    "purple": "800080",
    "pink": "FFC0CB",
    "gray": "808080",
    "grey": "808080",
    "brown": "A52A2A",
    "navy": "000080",
    "teal": "008080",
    "maroon": "800000",
    "aqua": "00FFFF",
    "fuchsia": "FF00FF",
    "lime": "00FF00",
    "olive": "808000",
    "silver": "C0C0C0",
    "gold": "FFD700",
    "coral": "FF7F50",
    "crimson": "DC143C",
    "cyan": "00FFFF",
    "darkblue": "00008B",
    "darkcyan": "008B8B",
    "darkgreen": "006400",
    "darkmagenta": "8B008B",
    "darkred": "8B0000",
    "darkyellow": "9B870C",
    "darkgray": "A9A9A9",
    "darkgrey": "A9A9A9",
    "lightgray": "D3D3D3",
    "lightgrey": "D3D3D3",
    "lightblue": "ADD8E6",
    "lightgreen": "90EE90",
    "magenta": "FF00FF",
    "orangered": "FF4500",
    "salmon": "FA8072",
    "skyblue": "87CEEB",
    "tomato": "FF6347",
    "violet": "EE82EE",
    "wheat": "F5DEB3",
    "indigo": "4B0082",
    "ivory": "FFFFF0",
    "khaki": "F0E68C",
    "lavender": "E6E6FA",
    "tan": "D2B48C",
    "turquoise": "40E0D0",
    "beige": "F5F5DC",
}

# Word 高亮颜色枚举值映射（用于 _find_closest_highlight_color）
_WD_COLOR_MAP = {
    "yellow": 7,
    "green": 4,
    "cyan": 11,
    "magenta": 5,
    "blue": 2,
    "red": 6,
    "darkblue": 9,
    "darkcyan": 14,
    "darkgreen": 10,
    "darkmagenta": 13,
    "darkred": 16,
    "darkyellow": 15,
    "darkgray": 8,
    "lightgray": 12,
    "black": 1,
    "white": 0,
    "none": 17,
}


def _find_closest_highlight_color(r: int, g: int, b: int) -> Optional[int]:
    """
    将RGB颜色近似匹配到Word支持的高亮颜色。

    使用欧几里得距离选择最接近的Word高亮颜色。

    Args:
        r, g, b: RGB颜色分量 (0-255)。

    Returns:
        Word高亮颜色枚举值，若无法匹配则返回 None。
    """
    known_colors = {
        "black": (0, 0, 0),
        "blue": (0, 0, 255),
        "cyan": (0, 255, 255),
        "green": (0, 128, 0),
        "magenta": (255, 0, 255),
        "red": (255, 0, 0),
        "yellow": (255, 255, 0),
        "darkblue": (0, 0, 139),
        "darkcyan": (0, 139, 139),
        "darkgreen": (0, 100, 0),
        "darkmagenta": (139, 0, 139),
        "darkred": (139, 0, 0),
        "darkyellow": (128, 128, 0),
        "darkgray": (169, 169, 169),
        "lightgray": (211, 211, 211),
        "white": (255, 255, 255),
    }
    min_dist = float("inf")
    closest = None
    for name, (cr, cg, cb) in known_colors.items():
        dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
        if dist < min_dist:
            min_dist = dist
            closest = name
    return _WD_COLOR_MAP.get(closest)


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


def parse_color(value: str) -> Optional[RGBColor]:
    """
    解析CSS颜色值并返回RGBColor对象。

    支持格式：
    - 十六进制：#RRGGBB 或 #RGB
    - RGB函数：rgb(r, g, b) 或 rgba(r, g, b, a)
    - 预定义颜色名：red, blue, green 等

    Args:
        value: CSS颜色字符串。

    Returns:
        RGBColor对象，解析失败返回 None。
    """
    if not value or not isinstance(value, str):
        return None

    value = value.strip().lower()

    if not value:
        return None

    try:
        # 颜色名
        if value in _COLOR_NAMES:
            hex_val = _COLOR_NAMES[value]
            return RGBColor.from_string(hex_val)

        # 十六进制颜色
        if value.startswith("#"):
            hex_val = value[1:]
            if len(hex_val) == 3:
                hex_val = "".join(c * 2 for c in hex_val)
            if len(hex_val) == 6:
                return RGBColor.from_string(hex_val)
            return None

        # rgb() / rgba()
        if value.startswith("rgb"):
            match = re.match(r"rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", value)
            if match:
                r = max(0, min(255, int(match.group(1))))
                g = max(0, min(255, int(match.group(2))))
                b = max(0, min(255, int(match.group(3))))
                return RGBColor(r, g, b)
            return None
    except Exception:
        return None

    return None


def parse_font_size(value: str) -> Optional[Pt]:
    """
    解析CSS字体大小并返回Pt对象。

    支持单位：
    - pt: 直接使用
    - px: 1px ≈ 0.75pt
    - em/rem: 基准12pt
    - 纯数字：视为pt

    Args:
        value: CSS字体大小字符串。

    Returns:
        Pt对象，解析失败返回 None。
    """
    if not value or not isinstance(value, str):
        return None

    value = value.strip().lower()
    if not value:
        return None

    try:
        # 数字+单位
        match = re.match(r"([\d.]+)\s*(pt|px|em|rem|%)?", value)
        if match:
            num = float(match.group(1))
            unit = match.group(2)

            if unit == "px":
                # 1px ≈ 0.75pt
                return Pt(num * 0.75)
            elif unit == "em" or unit == "rem":
                return Pt(num * 12)
            elif unit == "%":
                return Pt(num / 100 * 12)
            else:
                # 默认视为pt
                return Pt(num)

        return None
    except Exception:
        return None


def apply_style_to_run(run, style_str: str) -> List[str]:
    """
    解析 style 属性字符串并应用到 Run 对象。

    支持的CSS属性：
    - color: 文本颜色
    - background-color: 高亮颜色
    - font-size: 字体大小
    - font-family: 字体名称
    - font-weight: bold → bold=True
    - font-style: italic → italic=True
    - text-decoration: underline → underline=True

    Args:
        run: python-docx 的 Run 对象。
        style_str: HTML标签的 style 属性值。

    Returns:
        不支持的CSS属性名列表（作为警告信息）。
    """
    warnings: List[str] = []
    if not style_str or not isinstance(style_str, str):
        return warnings

    # 支持的CSS属性与处理函数映射
    supported_props = {
        "color",
        "background-color",
        "font-size",
        "font-family",
        "font-weight",
        "font-style",
        "text-decoration",
        "letter-spacing",
    }

    properties = _parse_style_string(style_str)

    for prop_name, prop_value in properties:
        prop_name_lower = prop_name.strip().lower()

        if prop_name_lower not in supported_props:
            warnings.append(f"[样式] 不支持的CSS属性: {prop_name}")
            continue

        try:
            if prop_name_lower == "color":
                color = parse_color(prop_value)
                if color:
                    run.font.color.rgb = color

            elif prop_name_lower == "background-color":
                color = parse_color(prop_value)
                if color:
                    hl = _find_closest_highlight_color(color.red, color.green, color.blue)
                    if hl is not None:
                        run.font.highlight_color = hl

            elif prop_name_lower == "font-size":
                size = parse_font_size(prop_value)
                if size:
                    run.font.size = size

            elif prop_name_lower == "font-family":
                # 取第一个字体名
                font_name = prop_value.split(",")[0].strip().strip("'\"")
                if font_name:
                    run.font.name = font_name
                    # 设置东亚字体（中文等）
                    _set_east_asian_font(run, font_name)

            elif prop_name_lower == "font-weight":
                if prop_value.strip().lower() in ("bold", "700", "800", "900"):
                    run.bold = True

            elif prop_name_lower == "font-style":
                if prop_value.strip().lower() == "italic":
                    run.italic = True

            elif prop_name_lower == "text-decoration":
                if "underline" in prop_value.strip().lower():
                    run.underline = True
                elif "line-through" in prop_value.strip().lower():
                    run.font.strike = True

            elif prop_name_lower == "letter-spacing":
                spacing_twips = _parse_length_twips(prop_value)
                if spacing_twips is not None:
                    _set_run_spacing(run, spacing_twips)

        except Exception:
            # 应用样式失败，静默忽略，不中断流程
            continue

    return warnings


def apply_style_to_paragraph(paragraph, style_str: str) -> List[str]:
    """
    解析 style 属性字符串并应用到 Paragraph 对象。

    支持的CSS属性：
    - text-align: 文本对齐 (left/center/right/justify)

    Args:
        paragraph: python-docx 的 Paragraph 对象。
        style_str: HTML标签的 style 属性值。

    Returns:
        不支持的CSS属性名列表（作为警告信息）。
    """
    warnings: List[str] = []
    if not style_str or not isinstance(style_str, str):
        return warnings

    supported_props = {
        "text-align",
        "line-height",
        "text-indent",
        "margin-top",
        "margin-bottom",
        "page-break-before",
    }
    # Run 级别属性在段落处理时不报不支持（由 apply_style_to_run 处理）
    _run_level_props = {
        "color",
        "background-color",
        "font-size",
        "font-family",
        "font-weight",
        "font-style",
        "text-decoration",
        "letter-spacing",
    }
    properties = _parse_style_string(style_str)

    for prop_name, prop_value in properties:
        prop_name_lower = prop_name.strip().lower()

        if prop_name_lower not in supported_props:
            if prop_name_lower not in _run_level_props:
                warnings.append(f"[样式] 不支持的CSS属性: {prop_name}")
            continue

        try:
            if prop_name_lower == "text-align":
                align_map = {
                    "left": WD_ALIGN_PARAGRAPH.LEFT,
                    "center": WD_ALIGN_PARAGRAPH.CENTER,
                    "right": WD_ALIGN_PARAGRAPH.RIGHT,
                    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
                }
                align = align_map.get(prop_value.strip().lower())
                if align is not None:
                    paragraph.alignment = align

            elif prop_name_lower == "line-height":
                line_val = _parse_line_height(prop_value)
                if line_val is not None:
                    paragraph.paragraph_format.line_spacing = line_val

            elif prop_name_lower == "text-indent":
                indent = _parse_length_twips(prop_value)
                if indent is not None:
                    # 允许负值（悬挂缩进）
                    paragraph.paragraph_format.first_line_indent = Pt(indent / 20.0)

            elif prop_name_lower == "margin-top":
                twips = _parse_length_twips(prop_value)
                if twips is not None:
                    paragraph.paragraph_format.space_before = Pt(twips / 20.0)

            elif prop_name_lower == "margin-bottom":
                twips = _parse_length_twips(prop_value)
                if twips is not None:
                    paragraph.paragraph_format.space_after = Pt(twips / 20.0)

            elif prop_name_lower == "page-break-before":
                if prop_value.strip().lower() == "always":
                    paragraph.paragraph_format.page_break_before = True

        except Exception:
            continue

    return warnings


def _parse_length_twips(value: str) -> Optional[int]:
    """
    将 CSS 长度值解析为 twips（1/20 磅）。

    支持单位：pt, px, em, rem, in, cm, mm。
    纯数字视为 pt。

    Args:
        value: CSS 长度字符串（如 "2em", "24pt", "1.5"）。

    Returns:
        twips 整数，解析失败返回 None。
    """
    if not value or not isinstance(value, str):
        return None

    value = value.strip().lower()
    if not value:
        return None

    try:
        match = re.match(r"([\d.-]+)\s*(pt|px|em|rem|in|cm|mm|%)?", value)
        if not match:
            return None

        num = float(match.group(1))
        unit = match.group(2)

        # 统一转为磅 (pt)
        if unit is None or unit == "pt":
            pt_val = num
        elif unit == "px":
            pt_val = num * 0.75
        elif unit == "em" or unit == "rem":
            pt_val = num * 12  # 基准 12pt
        elif unit == "in":
            pt_val = num * 72  # 1 inch = 72pt
        elif unit == "cm":
            pt_val = num * 28.35  # 1cm ≈ 28.35pt
        elif unit == "mm":
            pt_val = num * 2.835  # 1mm ≈ 2.835pt
        elif unit == "%":
            pt_val = num / 100 * 12  # 相对 12pt 基准
        else:
            return None

        # pt → twips (×20)
        return int(round(pt_val * 20))
    except Exception:
        return None


def _set_run_spacing(run, twips: int) -> None:
    """
    通过 OOXML 设置 Run 的字符间距 (letter-spacing)。

    python-docx 高层 API 不直接暴露此属性，通过操作 rPr 下的
    w:spacing 元素实现。val 单位为 twips（1/20 磅）。

    Args:
        run: python-docx Run 对象。
        twips: 间距值（twips），正值为扩大间距，负值为缩小。
    """
    try:
        rPr = run._r.get_or_add_rPr()
        # 移除已有的 spacing 元素
        existing = rPr.findall(qn("w:spacing"))
        for el in existing:
            rPr.remove(el)
        # 添加新的 spacing
        spacing = _make_ooxml_element("w:spacing", {"w:val": str(twips)})
        rPr.append(spacing)
    except Exception:
        pass


def _make_ooxml_element(tag: str, attrs: Optional[dict] = None):
    """创建带属性的 lxml OOXML 元素。"""
    e = OxmlElement(tag)
    if attrs:
        for k, v in attrs.items():
            e.set(qn(k), str(v))
    return e


def _parse_line_height(value: str) -> Optional[float]:
    """
    解析 CSS line-height 值并返回 python-docx line_spacing 适用的值。

    规则：
    - 纯数字（如 1.5）→ 直接作为行高倍数
    - 带单位（如 24pt）→ 转为 Pt 对象后取磅值
    - 百分比（如 150%）→ 转为倍数

    python-docx 的 line_spacing 接受 float（倍数）或 Pt/Emu 等长度对象。

    Args:
        value: CSS line-height 字符串。

    Returns:
        float（行高倍数）或 None。
    """
    if not value or not isinstance(value, str):
        return None

    value = value.strip().lower()
    if not value:
        return None

    try:
        # 纯数字（无单位）：行高倍数，如 1.5
        if re.match(r"^[\d.]+$", value):
            return float(value)

        # 百分比：150% → 1.5
        if value.endswith("%"):
            return float(value[:-1]) / 100.0

        # 带单位：转为 Pt 后除以基准字号得到倍数
        match = re.match(r"([\d.]+)\s*(pt|px|em|rem)?", value)
        if match:
            num = float(match.group(1))
            unit = match.group(2)
            if unit is None or unit == "pt":
                return num / 12.0  # 基准 12pt
            elif unit == "px":
                return (num * 0.75) / 12.0
            elif unit == "em" or unit == "rem":
                return num

        return None
    except Exception:
        return None


def _parse_style_string(style_str: str) -> List[Tuple[str, str]]:
    """
    将 style 属性字符串解析为 (属性名, 属性值) 列表。

    例如: "color: red; font-size: 12pt" →
    [('color', 'red'), ('font-size', '12pt')]

    Args:
        style_str: CSS style 属性值。

    Returns:
        (属性名, 属性值) 元组列表。
    """
    result = []
    if not style_str or not isinstance(style_str, str):
        return result

    # 按分号分割各属性
    declarations = style_str.split(";")
    for decl in declarations:
        decl = decl.strip()
        if not decl or ":" not in decl:
            continue

        # 分割属性名和值
        parts = decl.split(":", 1)
        if len(parts) != 2:
            continue

        prop_name = parts[0].strip()
        prop_value = parts[1].strip()

        if prop_name and prop_value:
            result.append((prop_name, prop_value))

    return result
