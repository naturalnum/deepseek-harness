import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone

_CST = timezone(timedelta(hours=8))

_SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 将运行产物写入调用者的工作区，避免污染已安装的 Skill 目录。
# 如需显式指定位置，可设置 TECH_REPORT_OUTPUT_DIR。
_OUTPUT_DIR = os.path.abspath(
    os.environ.get("TECH_REPORT_OUTPUT_DIR", os.path.join(os.getcwd(), "output"))
)

# Word 模板属于生成资产，统一放在 assets/。
_ASSETS_DIR = os.path.join(_SKILL_DIR, "assets")


def normalize_cooperator_names(value) -> list[str]:
    """将合作单位字符串或数组规范化为按原顺序排列的单位名称列表。"""
    if value is None or value == "":
        return []
    values = value if isinstance(value, list) else [value]
    names = []
    for item in values:
        if not isinstance(item, str):
            raise TypeError("合作单位名称必须是字符串")
        for name in re.split(r"(?:\r?\n|[、；;]+)", item):
            normalized = re.sub(r"[ \t]+", " ", name).strip()
            if normalized:
                names.append(normalized)
    return names


def format_cooperator_names(value) -> str:
    """将多个合作单位转换为 Word 手动换行文本，确保每个单位独占一行。"""
    return "\n".join(normalize_cooperator_names(value))


def format_cover_bottom_block(
    cooperator,
    report_date: str,
    report_writing_unit: str,
) -> str:
    """生成封面页底连续区块，日期固定为最后一行且不插入空行。"""
    lines = [report_writing_unit.strip()]
    lines.extend(normalize_cooperator_names(cooperator))
    normalized_date = str(report_date or "").strip()
    if normalized_date:
        lines.append(normalized_date)
    return "\n".join(line for line in lines if line)


def today_cn() -> str:
    """返回当前日期，格式为 yyyy年m月d日（中国时区）。"""
    return datetime.now(_CST).strftime("%-Y年%-m月%-d日")


def date_to_year_month(d) -> tuple:
    """返回日期的年和月，均为数字。"""
    return d.year, d.month


def get_output_path(filename: str) -> str:
    """
    获取 output 目录下文件的完整路径。

    :param filename: 文件名（如 "cover_info.json"）
    :return: 完整文件路径
    """
    return os.path.join(_OUTPUT_DIR, filename)


def get_template_path(filename: str) -> str:
    """
    获取 assets 目录下文件的完整路径。

    :param filename: 文件名（如 "report.docx"）
    :return: 完整文件路径
    """
    return os.path.join(_ASSETS_DIR, filename)


def load_output_json(filename: str) -> dict:
    """
    加载 output 目录下的 JSON 文件。

    先尝试严格 json.load() 解析；失败时尝试 json_repair 自动修复。

    :param filename: 文件名（如 "cover_info.json"）
    :return: JSON 数据字典
    :raises FileNotFoundError: 如果文件不存在
    :raises json.JSONDecodeError: JSON 格式无效且无法自动修复
    """
    filepath = get_output_path(filename)
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"文件不存在: {filepath}")

    with open(filepath, "r", encoding="utf-8") as f:
        raw = f.read()

    # 先尝试严格解析（正常情况零开销）
    try:
        return json.loads(raw)
    except json.JSONDecodeError as original_error:
        # 严格解析失败 → 尝试 json_repair 自动修复
        try:
            from json_repair import repair_json  # type: ignore[import-untyped]

            fixed = repair_json(raw)
            data = json.loads(fixed)
            print(
                f"⚠️  {filename} JSON 格式有误，已自动修复",
                file=sys.stderr,
            )
            return data
        except ImportError:
            # json-repair 未安装 → 抛出原始错误
            raise original_error
        except Exception:
            # 修复也失败 → 保留原始错误信息
            raise original_error


def save_output_json(filename: str, data: dict) -> str:
    """
    保存数据到 output 目录下的 JSON 文件。

    :param filename: 文件名（如 "cover_info.json"）
    :param data: 要保存的数据
    :return: 保存的文件路径
    """
    filepath = get_output_path(filename)
    os.makedirs(os.path.dirname(filepath), exist_ok=True)

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return filepath


def clear_output_dir() -> int:
    """
    清除 output 目录下的所有文件。

    :return: 删除的文件数量
    """
    if not os.path.exists(_OUTPUT_DIR):
        return 0

    count = 0
    for filename in os.listdir(_OUTPUT_DIR):
        filepath = os.path.join(_OUTPUT_DIR, filename)
        if os.path.isfile(filepath):
            os.remove(filepath)
            count += 1

    return count


def parse_date_str(date_str: str) -> date:
    """解析日期字符串，支持 YYYY-MM-DD 或 YYYYMMDD 格式"""
    date_str = date_str.strip()
    if len(date_str) == 8:
        return date(int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]))
    return date.fromisoformat(date_str)
