"""封面报告编号、分类号和密级区块的动态横向布局。"""

from pathlib import Path
import unicodedata

from config import (
    COVER_METADATA_FONT_SIZE_PT,
    PAGE_MARGIN_LEFT_MM,
    PAGE_MARGIN_RIGHT_MM,
    PAGE_WIDTH_MM,
)


_HEITI_FONT_CANDIDATES = (
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "C:/Windows/Fonts/simhei.ttf",
)


def _twips(mm):
    return round(mm * 1440 / 25.4)


def _font_path(candidates):
    return next((path for path in candidates if Path(path).is_file()), None)


def _is_east_asian(character):
    return ord(character) > 127 and unicodedata.east_asian_width(character) in (
        "W",
        "F",
        "A",
    )


def _measure_with_pillow(text):
    try:
        from PIL import ImageFont
    except ImportError:
        return None

    heiti_path = _font_path(_HEITI_FONT_CANDIDATES)
    if not heiti_path:
        return None

    scale = 4
    dpi = 96 * scale
    pixel_size = round(COVER_METADATA_FONT_SIZE_PT * dpi / 72)
    heiti_font = ImageFont.truetype(heiti_path, pixel_size)
    width_pixels = heiti_font.getlength(text)
    return width_pixels * 25.4 / dpi


def _estimate_width_mm(text):
    """缺少目标字体时，以黑体的常见中西文字宽估算。"""
    em_units = 0.0
    for character in text:
        if _is_east_asian(character):
            em_units += 1.0
        elif character in "MW@%":
            em_units += 0.9
        elif character in "ilI1.,:;'|!":
            em_units += 0.3
        elif character in "-_()[]{}":
            em_units += 0.45
        elif character.isspace():
            em_units += 0.25
        elif character.isupper():
            em_units += 0.68
        else:
            em_units += 0.52
    return em_units * COVER_METADATA_FONT_SIZE_PT * 25.4 / 72


def measure_cover_metadata_width_mm(text):
    measured = _measure_with_pillow(str(text))
    return measured if measured is not None else _estimate_width_mm(str(text))


def calculate_cover_metadata_indents_twips(texts):
    """返回统一左右缩进，使最长行右端贴齐右页边距内侧。"""
    lines = [str(text).strip() for text in texts if str(text).strip()]
    max_width_mm = max(
        (measure_cover_metadata_width_mm(line) for line in lines),
        default=0,
    )
    available_width_mm = (
        PAGE_WIDTH_MM - PAGE_MARGIN_LEFT_MM - PAGE_MARGIN_RIGHT_MM
    )
    max_width_mm = min(max_width_mm, available_width_mm)
    left_indent_mm = max(0, available_width_mm - max_width_mm)
    return _twips(left_indent_mm), 0
