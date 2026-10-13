#!/usr/bin/env python3
"""科技报告编写工具 - CLI 入口。

命令列表：
    current-date         输出当前日期及参考信息
    create-report        基于 output/ 中的数据生成 .docx 报告
    validate-cover       校验 cover_info.json 格式
    validate-outline     校验 outline.json 格式
    validate-abstract    校验 abstract.json 格式
    validate-chapter N   校验 chapter_N.json 格式
    validate-appendices  校验可选 appendices.json 格式
    validate-references  校验 references.json 格式
"""

import argparse
import html
import json
import os
import re
import shutil
import sys

from utils import get_output_path, load_output_json


# ============================================================
# 校验函数
# ============================================================


def _validate_cover_data(data: dict) -> tuple:
    """
    校验 cover_info.json 格式。

    标题、项目名称和报告日期必须非空。
    其余封面字段必须存在且为字符串；用户明确确认不适用时允许留空。
    """
    required_non_empty = [
        "title_cn",
        "title_en",
        "project_name",
        "report_date",
    ]
    required_strings = [
        "report_no",
        "class_no",
        "secret_level",
        "project_source",
        "series_no",
        "work_period",
        "leader",
        "staff",
        "writer",
    ]
    if not isinstance(data, dict):
        return False, "cover_info 必须是 JSON 对象"

    for field in required_non_empty:
        if field not in data:
            return False, f"cover_info 缺少必需字段：{field}"
        if not isinstance(data[field], str) or not data[field].strip():
            return False, f"cover_info.{field} 必须是非空字符串"

    for field in required_strings:
        if field not in data:
            return False, f"cover_info 缺少字段：{field}"
        if not isinstance(data[field], str):
            return False, f"cover_info.{field} 必须是字符串"

    if "cooperator" not in data:
        return False, "cover_info 缺少字段：cooperator"
    cooperator = data["cooperator"]
    if not isinstance(cooperator, (str, list)):
        return False, "cover_info.cooperator 必须是字符串或字符串数组"
    if isinstance(cooperator, list) and any(
        not isinstance(item, str) or not item.strip() for item in cooperator
    ):
        return False, "cover_info.cooperator 数组中的单位名称必须是非空字符串"

    return True, ""


def _validate_outline_data(data: dict) -> tuple:
    """
    校验 outline.json 格式。

    必需字段：chapters（数组）
    每章必需：num（编号）, title（标题）
    可选：sections（子节数组）
    """
    if not isinstance(data, dict):
        return False, "outline 必须是 JSON 对象"

    chapters = data.get("chapters")
    if not isinstance(chapters, list) or len(chapters) == 0:
        return False, "outline.chapters 必须是非空数组"

    for i, ch in enumerate(chapters):
        if not isinstance(ch, dict):
            return False, f"outline.chapters[{i}] 必须是对象"
        if "num" not in ch or not isinstance(ch["num"], (int, str)):
            return False, f"outline.chapters[{i}] 缺少 num 字段（编号）"
        if "title" not in ch or not isinstance(ch["title"], str) or not ch["title"].strip():
            return False, f"outline.chapters[{i}] 缺少 title 字段（标题）"

        # 可选 sections
        sections = ch.get("sections", [])
        if sections:
            if not isinstance(sections, list):
                return False, f"outline.chapters[{i}].sections 必须是数组"
            for j, sec in enumerate(sections):
                if not isinstance(sec, dict):
                    return False, f"outline.chapters[{i}].sections[{j}] 必须是对象"
                if "title" not in sec or not isinstance(sec["title"], str) or not sec["title"].strip():
                    return False, f"outline.chapters[{i}].sections[{j}] 缺少 title"

    return True, ""


def _validate_abstract_data(data: dict) -> tuple:
    """
    校验 abstract.json 格式。

    必需字段：abstract_cn, keywords_cn, abstract_en, keywords_en
    格式规则：中文关键词全角分号（；），英文关键词半角分号+空格（; ）
    """
    if not isinstance(data, dict):
        return False, "abstract 必须是 JSON 对象"

    required = ["abstract_cn", "keywords_cn", "abstract_en", "keywords_en"]
    for field in required:
        if field not in data:
            return False, f"abstract 缺少必需字段：{field}"
        if not isinstance(data[field], str) or not data[field].strip():
            return False, f"abstract.{field} 必须是非空字符串"

    # 摘要内容、字数/词数、段落结构、写作人称和必含要素不在本格式 Skill 中校验。
    # 本 Skill 只校验数据字段和确定性的版式格式。

    # 关键词只校验分隔符格式，不限制数量。
    kw_cn = data["keywords_cn"]
    if "；" not in kw_cn and ";" in kw_cn:
        return False, "中文关键词请使用全角分号（；）分隔"
    kw_en = data["keywords_en"]
    if ";" not in kw_en and "；" in kw_en:
        return False, "英文关键词请使用半角分号+空格（; ）分隔"
    return True, ""


def _validate_chapter_data(data: dict, expected_num: int = None) -> tuple:
    """
    校验 chapter_N.json 格式。

    必需字段：num, title, content_html
    可选校验：num 与 expected_num 一致
    """
    if not isinstance(data, dict):
        return False, "chapter 必须是 JSON 对象"

    # 必需字段
    for field in ("num", "title", "content_html"):
        if field not in data:
            return False, f"chapter 缺少必需字段：{field}"

    # num 类型兼容 int/str
    num = data["num"]
    if isinstance(num, str):
        try:
            num = int(num)
        except ValueError:
            return False, f"chapter.num 不是有效编号：{num}"

    # title 非空
    if not isinstance(data["title"], str) or not data["title"].strip():
        return False, "chapter.title 必须是非空字符串"

    # content_html 非空
    if not isinstance(data["content_html"], str) or not data["content_html"].strip():
        return False, "chapter.content_html 必须是非空字符串"

    # 编号一致性（如果提供了期望编号）
    if expected_num is not None and num != expected_num:
        return False, f"chapter.num={num} 与文件名中的编号 {expected_num} 不一致"

    paragraph_html = re.findall(
        r"<p\b[^>]*>(.*?)</p>", data["content_html"], flags=re.IGNORECASE | re.DOTALL
    )
    paragraph_texts = [
        re.sub(r"\s+", "", html.unescape(re.sub(r"<[^>]+>", "", value)))
        for value in paragraph_html
    ]
    for index, text in enumerate(paragraph_texts):
        placeholder = re.match(r"^【此处插入图\s*([A-Z0-9]+-\d+)】$", text)
        if placeholder is None:
            continue
        next_text = paragraph_texts[index + 1] if index + 1 < len(paragraph_texts) else ""
        caption = re.match(r"^图\s*([A-Z0-9]+-\d+)(?:\s|\S)", next_text)
        if caption is None or caption.group(1) != placeholder.group(1):
            return False, (
                f"图{placeholder.group(1)}的占位段落必须紧接在对应图题上方"
            )

    return True, ""


GBT7714_TYPE_RE = re.compile(r"\[(J|M|C|D|R|S|P|N|DB|CP|EB|DS(?=\]|/OL\]))(?:/(OL|DK|CD|MT))?\]")
GBT7714_CITATION_DATE_RE = re.compile(r"\[\d{4}-\d{2}-\d{2}\]")


def _validate_gbt7714_reference_entry(entry: str) -> tuple[bool, str]:
    marker_match = GBT7714_TYPE_RE.search(entry)
    if marker_match is None:
        return False, "缺少 GB/T 7714—2015 文献类型标识（如 [J]、[M]、[S]、[EB/OL]）"
    carrier = marker_match.group(2)
    if carrier == "OL":
        if GBT7714_CITATION_DATE_RE.search(entry) is None:
            return False, "联机电子资源缺少引用日期 [YYYY-MM-DD]"
        if re.search(r"https?://\S+", entry) is None:
            return False, "联机电子资源缺少 http(s) URL"
    if not entry.endswith("."):
        return False, "GB/T 7714—2015 条目应以半角句点 . 结束"
    return True, ""


def _validate_references_data(data: dict) -> tuple:
    """
    校验 references.json 格式。

    必需字段：references_html
    """
    if not isinstance(data, dict):
        return False, "references 必须是 JSON 对象"

    if "references_html" not in data:
        return False, "references 缺少必需字段：references_html"

    if not isinstance(data["references_html"], str):
        return False, "references.references_html 必须是字符串"

    references_html = data["references_html"].strip()
    if not references_html:
        return True, ""

    entries = [
        re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", value))).strip()
        for value in re.findall(
            r"<p\b[^>]*>(.*?)</p>",
            references_html,
            flags=re.IGNORECASE | re.DOTALL,
        )
    ]
    entries = [entry for entry in entries if entry]
    for expected, entry in enumerate(entries, start=1):
        match = re.match(r"^\[(\d+)\]\s+\S", entry)
        if match is None:
            return False, f"第 {expected} 条参考文献应以“[{expected}] ”开头"
        if int(match.group(1)) != expected:
            return False, f"参考文献编号应连续，期望 [{expected}]，收到 [{match.group(1)}]"
        ok, message = _validate_gbt7714_reference_entry(entry)
        if not ok:
            return False, f"第 {expected} 条参考文献不符合 GB/T 7714—2015：{message}"

    return True, ""


def _validate_appendices_data(data: dict) -> tuple:
    """校验可选 appendices.json 的结构和连续编号。"""
    if not isinstance(data, dict):
        return False, "appendices 必须是 JSON 对象"

    appendices = data.get("appendices")
    if not isinstance(appendices, list) or not appendices:
        return False, "appendices.appendices 必须是非空数组"

    expected_ids = [chr(ord("A") + i) for i in range(len(appendices))]
    actual_ids = []
    for index, appendix in enumerate(appendices):
        if not isinstance(appendix, dict):
            return False, f"appendices.appendices[{index}] 必须是对象"
        for field in ("id", "title", "content_html"):
            value = appendix.get(field)
            if not isinstance(value, str) or not value.strip():
                return False, f"appendices.appendices[{index}].{field} 必须是非空字符串"
        appendix_id = appendix["id"].strip().upper()
        if not re.fullmatch(r"[A-Z]", appendix_id):
            return False, f"附录编号必须是单个大写字母，收到: {appendix['id']}"
        actual_ids.append(appendix_id)

    if actual_ids != expected_ids:
        return False, f"附录编号必须从 A 连续排列，当前为: {', '.join(actual_ids)}"

    return True, ""


# ============================================================
# 命令实现
# ============================================================


def cmd_current_date(args):
    """输出当前日期及参考信息。"""
    from datetime import date, timedelta

    today = date.today()
    info = {
        "today": today.strftime("%Y-%m-%d"),
        "today_cn": f"{today.year}年{today.month}月{today.day}日",
        "report_month": f"{today.year}年{today.month}月",
        "current_year": str(today.year),
        "current_month": f"{today.month:02d}",
        "hint": "封面报告日期通常使用 report_month 格式",
    }
    print(json.dumps(info, ensure_ascii=False, indent=2))


def cmd_create_report(args):
    """生成科技报告 .docx 文件，并复制到 /workspace/user/files/。"""
    from report_generator import generate_report

    result = generate_report()
    if not result.get("success"):
        for err in result.get("errors", []):
            print(f"错误: {err}", file=sys.stderr)
        sys.exit(1)

    out = result.get("output", "")
    if not out:
        return

    print(f"报告已生成: {out}")

    # 复制到用户文件目录
    dest_dir = "/workspace/user/files"
    if not os.path.isdir("/workspace"):
        return
    try:
        os.makedirs(dest_dir, exist_ok=True)
        dest_path = os.path.join(dest_dir, os.path.basename(out))
        shutil.copy2(out, dest_path)
        print(f"已复制到: {dest_path}")
    except OSError as e:
        print(f"复制到 {dest_dir} 失败: {e}", file=sys.stderr)


def _validate_file(filename: str, validator):
    """通用校验：读文件 → 校验 → 打印结果。"""
    try:
        data = load_output_json(filename)
    except FileNotFoundError:
        print(f"错误：{filename} 不存在", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"错误：{filename} JSON 格式无效 - {e}", file=sys.stderr)
        sys.exit(1)

    ok, err = validator(data)
    if not ok:
        print(f"错误：{err}", file=sys.stderr)
        sys.exit(1)
    print(f"校验通过：output/{filename}")


def cmd_validate_cover(args):
    """校验 cover_info.json 格式。"""
    _validate_file("cover_info.json", _validate_cover_data)


def cmd_validate_outline(args):
    """校验 outline.json 格式。"""
    _validate_file("outline.json", _validate_outline_data)


def cmd_validate_abstract(args):
    """校验 abstract.json 格式。"""
    _validate_file("abstract.json", _validate_abstract_data)


def cmd_validate_chapter(args):
    """校验 chapter_N.json 格式。"""
    num = args.num
    try:
        num = int(num)
    except (TypeError, ValueError):
        print(f"错误：章节编号必须是数字，收到: {num}", file=sys.stderr)
        sys.exit(1)

    filename = f"chapter_{num}.json"

    def validator(data):
        return _validate_chapter_data(data, expected_num=num)

    _validate_file(filename, validator)


def cmd_validate_references(args):
    """校验 references.json 格式。"""
    _validate_file("references.json", _validate_references_data)


def cmd_validate_appendices(args):
    """校验 appendices.json 格式。"""
    _validate_file("appendices.json", _validate_appendices_data)


def cmd_validate_report(args):
    """校验最终 DOCX 的页面、分节、页眉和页脚。"""
    from report_validator import validate_report

    result = validate_report(os.path.abspath(args.path))
    for warning in result.get("warnings", []):
        print(f"警告：{warning}", file=sys.stderr)
    if not result.get("valid"):
        for error in result.get("errors", []):
            print(f"错误：{error}", file=sys.stderr)
        sys.exit(1)
    print(f"最终格式校验通过：{os.path.abspath(args.path)}")


# ============================================================
# 入口
# ============================================================


def main():
    parser = argparse.ArgumentParser(description="科技报告编写工具")
    subparsers = parser.add_subparsers(dest="command", help="可用命令")

    # current-date
    p_date = subparsers.add_parser("current-date", help="获取当前日期及参考信息")
    p_date.set_defaults(func=cmd_current_date)

    # create-report
    p_create = subparsers.add_parser("create-report", help="生成科技报告 .docx")
    p_create.set_defaults(func=cmd_create_report)

    # validate-cover
    p_vcover = subparsers.add_parser("validate-cover", help="校验 cover_info.json")
    p_vcover.set_defaults(func=cmd_validate_cover)

    # validate-outline
    p_voutline = subparsers.add_parser("validate-outline", help="校验 outline.json")
    p_voutline.set_defaults(func=cmd_validate_outline)

    # validate-abstract
    p_vabstract = subparsers.add_parser("validate-abstract", help="校验 abstract.json")
    p_vabstract.set_defaults(func=cmd_validate_abstract)

    # validate-chapter
    p_vchapter = subparsers.add_parser("validate-chapter", help="校验 chapter_N.json")
    p_vchapter.add_argument("num", help="章节编号（如 1, 2, 3）")
    p_vchapter.set_defaults(func=cmd_validate_chapter)

    # validate-references
    p_vref = subparsers.add_parser("validate-references", help="校验 references.json")
    p_vref.set_defaults(func=cmd_validate_references)

    # validate-appendices
    p_vappendices = subparsers.add_parser(
        "validate-appendices", help="校验 appendices.json"
    )
    p_vappendices.set_defaults(func=cmd_validate_appendices)

    # validate-report
    p_vreport = subparsers.add_parser("validate-report", help="校验最终 DOCX 格式")
    p_vreport.add_argument("path", help="待校验的 .docx 文件路径")
    p_vreport.set_defaults(func=cmd_validate_report)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    args.func(args)


if __name__ == "__main__":
    main()
