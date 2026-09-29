#!/usr/bin/env python3
"""Validate report voice, cross-chapter references, summaries and citation style.

Use ``--mode chapter`` before showing any chapter or section draft. Use ``--mode final``
for the assembled report. Explicit chapter-number narration is prohibited throughout
formal prose; Chapter 1 section 1.3.2 describes research logic rather than chapter order.
The validator also checks quantitative/qualitative/power-domain content in chapter
summaries and the final conclusion, plus consistent “等人/团队” attribution in
Chapter 1 section 1.2 “国内外研究现状”.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

PLACEHOLDER = "【待补充来源】"
SOURCE_PATTERNS = [
    (re.compile(r"任务书"), "任务书或任务来源词汇"),
    (re.compile(r"(?:子)?课题[一二三四五六七八九十0-9]+|(?:本|当前|该)课题"), "课题来源称谓"),
    (re.compile(r"课题分工|项目分工"), "行政分工口吻"),
    (re.compile(r"申报书|申报材料|项目合同|合同条款|会议纪要"), "外部文件名称"),
    (re.compile(r"最终材料|结题材料|验收材料|交付材料|报审材料"), "外部成果材料名称"),
    (re.compile(r"用户提供的材料|根据现有材料|(?:现有|相关|上述|所提供)材料(?:显示|表明)"), "材料来源口吻"),
    (re.compile(r"按照验收要求|根据验收要求"), "验收来源口吻"),
    (re.compile(r"考核(?:指标|要求|细则)|规定(?:的)?指标|既定指标要求|任务指标|项目指标|课题指标|验收指标"), "外部规定或考核来源口吻"),
    (re.compile(r"(?:课题)?进度计划"), "进度计划来源口吻"),
    (re.compile(r"(?<![A-Za-z0-9])(?:AR|SP|RP|TASK)-\d+(?![A-Za-z0-9])", re.IGNORECASE), "内部事项编号"),
]
CROSS_CHAPTER_PATTERNS = [
    (re.compile(r"第[一二三四五六七八九十百0-9]+章"), "具体章节编号互引"),
    (re.compile(r"(?:上一章|下一章|前一章|后一章|最后一章)"), "章序关系互引"),
]
PLACEHOLDER_PATTERNS = [
    (re.compile(r"待补充参考文献|参考文献占位"), "非统一文献占位"),
    (re.compile(r"【待补充来源[:：][^】]+】"), "带说明的非统一来源占位"),
]

POWER_TERM_RE = re.compile(
    r"电力|电网|调度|配电|输电|变电|电力设备|变压器|线路|机组|负荷|新能源|储能|潮流|故障|保护|运行方式|安全边界|运检|检修|供电|台区|电压|有功|无功|频率"
)
QUANTITATIVE_RE = re.compile(
    r"(?:\d+(?:\.\d+)?\s*(?:%|％|ms|s|秒|分钟|小时|kV|V|MW|kW|MVar|kVar|Hz|℃|条|项|类|组|次|个|套|台|座|回|点|样本|工况|节点|支路|设备))|(?:【待补充数据[:：][^】]+】)",
    re.IGNORECASE,
)
QUALITATIVE_RE = re.compile(
    r"提升|降低|增强|支撑|满足|形成|实现|改善|保持|适用|保障|提高|缩短|减少|稳定|可靠|准确|安全|可解释|具备|表明|能力|边界"
)
AUTHOR_ET_AL_RE = re.compile(
    r"(?<![A-Za-z\u4e00-\u9fff])([A-Z][A-Za-z.'’\-]*(?:\s+[A-Z][A-Za-z.'’\-]*){0,3}|[\u4e00-\u9fff]{2,4})等人"
)
AUTHOR_TEAM_RE = re.compile(
    r"(?<![A-Za-z\u4e00-\u9fff])([A-Z][A-Za-z.'’\-]*(?:\s+[A-Z][A-Za-z.'’\-]*){0,3}|[\u4e00-\u9fff]{2,4})团队"
)
GENERIC_TEAM_PREFIXES = {
    "国内", "国外", "相关", "研究", "科研", "项目", "技术", "本文", "该项", "多个", "某个", "现有", "学术", "工程", "研发", "专家"
}


def heading_info(line: str) -> tuple[int, str] | None:
    match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line.strip())
    if not match:
        return None
    return len(match.group(1)), match.group(2).strip()


def normalized_heading_title(title: str) -> str:
    title = re.sub(r"^第[一二三四五六七八九十百0-9]+章\s*", "", title.strip())
    title = re.sub(r"^\d+(?:\.\d+)*[、.．]?\s*", "", title)
    return title.strip()


def section_blocks(text: str) -> list[tuple[int, int, str, str]]:
    lines = text.splitlines()
    headings: list[tuple[int, int, str]] = []
    in_fence = False
    for idx, line in enumerate(lines):
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        info = heading_info(line)
        if info:
            level, title = info
            headings.append((idx, level, title))
    blocks: list[tuple[int, int, str, str]] = []
    for pos, (idx, level, title) in enumerate(headings):
        end = len(lines)
        for next_idx, next_level, _ in headings[pos + 1:]:
            if next_level <= level:
                end = next_idx
                break
        body = "\n".join(lines[idx + 1:end]).strip()
        blocks.append((idx + 1, level, title, body))
    return blocks


def research_status_body(text: str) -> str:
    for _, level, title, body in section_blocks(text):
        if level in {2, 3} and normalized_heading_title(title) == "国内外研究现状":
            return body
    # Some chapter drafts may use a top-level heading for the current subsection.
    for _, level, title, body in section_blocks(text):
        if normalized_heading_title(title) == "国内外研究现状":
            return body
    return ""


def author_attribution_styles(text: str) -> tuple[set[str], set[str]]:
    et_al = {m.group(1) for m in AUTHOR_ET_AL_RE.finditer(text)}
    teams = {m.group(1) for m in AUTHOR_TEAM_RE.finditer(text)}
    teams = {name for name in teams if name not in GENERIC_TEAM_PREFIXES}
    return et_al, teams


def summary_findings(text: str) -> list[tuple[int, str, str]]:
    findings: list[tuple[int, str, str]] = []
    for line, level, title, body in section_blocks(text):
        normalized = normalized_heading_title(title)
        is_chapter_summary = normalized == "本章小结"
        is_final_summary = level == 1 and normalized in {"总结", "总结与展望", "结论"}
        if not (is_chapter_summary or is_final_summary):
            continue
        label = "本章小结" if is_chapter_summary else "最终总结"
        compact = re.sub(r"\s+", " ", body)
        if not body:
            findings.append((line, f"{label}内容为空", title))
            continue
        if not QUANTITATIVE_RE.search(body):
            findings.append((line, f"{label}缺少有效定量表述", compact[:160]))
        if not QUALITATIVE_RE.search(body):
            findings.append((line, f"{label}缺少定性能力判断", compact[:160]))
        if not POWER_TERM_RE.search(body):
            findings.append((line, f"{label}缺少电力对象或应用意义", compact[:160]))
    return findings


def validate(text: str, mode: str) -> list[tuple[int, str, str]]:
    findings: list[tuple[int, str, str]] = []
    in_fence = False
    skip_language_section = False

    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or stripped.startswith("<!--"):
            continue

        heading = heading_info(line)
        if heading:
            level, title = heading
            # External source/document vocabulary is prohibited in headings as well as prose.
            for pattern, label in SOURCE_PATTERNS:
                if pattern.search(title):
                    findings.append((lineno, label, title))
            if level == 1:
                skip_language_section = (
                    title.strip() == "参考文献"
                    or "参考文献来源与获取链接" in title
                    or "待补充来源清单" in title
                )
            continue

        if skip_language_section:
            continue

        for pattern, label in SOURCE_PATTERNS + PLACEHOLDER_PATTERNS:
            if pattern.search(line):
                findings.append((lineno, label, stripped))
        for pattern, label in CROSS_CHAPTER_PATTERNS:
            if pattern.search(line):
                findings.append((lineno, label, stripped))

    findings.extend(summary_findings(text))

    dev_body = research_status_body(text)
    if dev_body:
        et_al_names, team_names = author_attribution_styles(dev_body)
        if et_al_names and team_names:
            findings.append((0, "第一章国内外研究现状作者指代样式混用", f"检测到‘等人’样式：{', '.join(sorted(et_al_names))}；‘团队’样式：{', '.join(sorted(team_names))}"))

    if mode == "final":
        if not re.search(r"(?m)^#\s+参考文献\s*$", text):
            findings.append((0, "缺少参考文献章节", "最终报告必须包含顶级参考文献章节"))
        if PLACEHOLDER in text and "待补充来源清单" not in text:
            findings.append((0, "缺少待补充来源清单", "存在【待补充来源】时，附录必须包含待补充来源清单"))

        ref_match = re.search(r"(?ms)^#\s+参考文献\s*$\n(.*?)(?=^#\s+|\Z)", text)
        ref_body = ref_match.group(1).strip() if ref_match else ""
        has_real_refs = bool(re.search(r"(?m)^\s*(?:\[?\d+\]?|[-*])\s+\S", ref_body))
        if has_real_refs and "参考文献来源与获取链接" not in text:
            findings.append((0, "缺少文献链接附录", "存在已核验参考文献时，必须包含参考文献来源与获取链接"))

    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("--mode", choices=("chapter", "final"), default="final")
    args = parser.parse_args()

    text = args.report.read_text(encoding="utf-8")
    findings = validate(text, args.mode)
    if findings:
        print(f"Report language validation failed ({args.mode} mode):")
        for line, label, excerpt in findings:
            print(f"- line {line}: {label}: {excerpt}")
        return 1

    if args.mode == "chapter":
        print("当前章节未发现外部材料词汇、外部规定口吻、课题编号、非法占位或禁止的跨章互引；如包含小结，其定量、定性与电力语义检查通过。")
    else:
        print("完整报告语言、来源附录、小结与总结证据、电力语义及第一章国内外研究现状作者指代一致性检查通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
