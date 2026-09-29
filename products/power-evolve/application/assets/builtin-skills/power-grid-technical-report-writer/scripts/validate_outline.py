#!/usr/bin/env python3
"""Validate the strict report outline and role-specific heading rules.

Checks:
- Chapter 1 uses the fixed project-overview architecture with background/significance, research status, and research content/approach.
- Research status is embedded in Chapter 1; technical chapters start from Chapter 2.
- Specific-topic reports map each research-content subpoint to one technical chapter; total reports map each task to one technical chapter.
- Technical chapters place an unheaded lead directly under the chapter title; no visible “概述/技术路线/技术架构” level-2 headings are allowed.
- Every technical chapter defaults to three core level-2 research subpoints at X.1-X.3; 4-5 are allowed only with a source-grounded expansion reason.
- Each core level-2 section has 2-4 level-3 headings by default; up to 5 is allowed only with an explicit source-grounded expansion reason.
- Every core heading explicitly combines a power-domain object/constraint, a concrete computing technology, and its technical role, and stays within the current chapter scope.
- Internal assessment requirements have embedded body locations and hidden source identity.
- Non-evaluation report themes forbid evaluation/validation/testing-like level-2 and level-3 headings.
- Standalone validation level-2 sections are available only for evaluation-related report themes and require an explicit exception.
- The chapter summary follows the last core section (and any allowed standalone evaluation section); quotation-mark preference applies to summary body prose, not as a special title-style gate.
- No technical chapter imports headings or schedule items from another task.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any

from title_specificity import (
    bare_family_title_pattern,
    family_level_technology,
    based_on_signature_issue,
    technical_signature_issue,
    is_based_on_heading_style,
    power_domain_signal_issue,
    raw_english_technology_tokens,
    chinese_heading_technology_issue,
    heading_task_subject,
    heading_task_subject_has_power_signal,
    heading_has_evaluation_term,
    task_subjects_are_duplicate,
)
from report_text_utils import outline_technology_option_violations

FIRST_TITLE = "项目概述"
FIRST_LEVEL2 = ["项目背景与研究意义", "国内外研究现状", "主要研究内容及思路"]
FIRST_LEVEL3 = [
    ("1.1.1", "项目研究背景"),
    ("1.1.2", "项目研究意义"),
    ("1.2.1", "国外研究现状"),
    ("1.2.2", "国内研究现状"),
    ("1.3.1", "主要研究内容"),
    ("1.3.2", "研究思路"),
]
CONCLUSION = {"总结", "总结与展望", "结论"}
STANDALONE_VALIDATION_TITLES = {
    "实验与结果分析", "实验结果分析", "系统测试", "应用验证", "测试与验证",
    "验证与分析", "综合验证", "性能测试", "实验验证",
}
MAX_TITLE_LENGTH = 25
SIMPLE_FUNCTIONAL_TITLES = {
    "实验", "评价指标", "实验设置", "数据集", "测试环境", "实验结果",
    "结果分析", "消融实验", "参数设置", "应用验证", "系统测试",
}
GENERIC = {
    "总体方案", "总体设计", "关键技术", "核心技术", "核心方法", "技术方案",
    "方法设计", "技术实现", "系统实现", "结果分析", "综合应用", "总体架构",
    "智能技术", "模型研究", "优化方法", "技术研究", "方法研究", "相关分析",
    "进一步研究", "数据处理", "模型训练", "参数设置", "模块设计", "综合机制",
    "总体体系", "工程应用",
}
ACTION_PREFIXES = (
    "研究", "开展", "研发", "构建", "建立", "提出", "实现", "提升", "解决",
    "评估", "定义",
)
DANGLING_SUFFIXES = ("的", "与", "及", "和", "基于", "面向", "针对", "通过", "利用", "用于")
TASK_CONCEPT_TERMS = {"机制", "建模", "体系", "定义"}
TECH_RESEARCH_HEADS = ("技术", "方法")
ENGINEERING_TERMS = {
    "系统", "平台", "架构", "模块", "组件", "接口", "部署", "集成", "应用",
    "服务", "流程", "测试", "验证", "工程",
}
ALLOWED_NOMINALIZATION_CHARS = set(
    "技术方法算法模型系统平台架构模块组件接口部署集成应用服务流程研究构建分析验证的与及和"
)
SUSPICIOUS_ADDED_TERMS = {
    "基于", "融合", "协同", "增强", "可信", "自适应", "智能", "创新", "先进", "领先",
    "多模态", "闭环", "优化", "安全", "高效", "精准",
}
POWER_TERMS = {
    "电力", "电网", "数字化电网", "配电", "配电网", "输电", "调度", "潮流",
    "变压器", "线路", "机组", "新能源", "储能", "负荷", "继电保护", "保护",
    "运行方式", "运行状态", "故障", "设备", "电压", "有功", "无功", "功率",
    "安全边界", "调控", "调峰", "调频", "供电", "台区", "变电站", "运检",
}
AI_TERMS = {
    "人工智能", "知识图谱", "知识", "语义", "表征", "本体", "抽取", "对齐",
    "生成式", "大模型", "小模型", "语言模型", "机器学习", "深度学习", "强化学习",
    "神经网络", "图神经网络", "智能体", "多智能体", "检索增强", "知识增强",
    "推理", "置信度", "价值对齐", "智能决策", "策略生成", "智能服务", "智能分配",
    "关系感知", "风险感知", "语义检索", "智能辅助", "模型协同", "迁移适配",
    "Transformer", "图Transformer", "图对比学习", "增量图学习", "神经符号推理",
    "贝叶斯", "马尔科夫", "扩散模型", "状态空间", "神经算子", "混合检索", "RAG", "混合专家", "元学习", "数字孪生",
}
INNOVATION_TERMS = {
    "约束", "融合", "增强", "协同", "对齐", "感知", "驱动", "自适应", "演化",
    "趋优", "校准", "校核", "增量", "多模态", "价值对齐", "安全回退", "冲突消解",
    "知识增强", "风险感知", "关系感知", "统一映射", "闭环", "编排", "迁移", "集成", "适配",
    "Transformer", "图Transformer", "图对比", "神经符号", "贝叶斯", "马尔科夫", "扩散模型",
    "状态空间", "神经算子", "多智能体", "混合专家", "元学习", "数字孪生", "分布鲁棒", "变分推断", "检索增强", "混合检索",
}
GENERIC_COMPUTING_TECH = {
    "人工智能", "机器学习", "深度学习", "神经网络", "大模型", "优化算法", "智能分析",
    "数据驱动", "智能算法", "预测模型", "分类模型", "通用模型", "算法模型",
}


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def headings(chapter: dict[str, Any], level: int) -> list[dict[str, Any]]:
    return [h for h in chapter.get("section_outline", []) if h.get("level") == level]


def l3_under(chapter: dict[str, Any], prefix: str) -> list[str]:
    return [
        str(h.get("title", "")).strip()
        for h in headings(chapter, 3)
        if str(h.get("number", "")).startswith(prefix + ".")
    ]


def is_summary(title: str) -> bool:
    return title.strip() in {"本章小结", "小结"}


def is_validation(h: dict[str, Any]) -> bool:
    title = str(h.get("title", "")).strip()
    return h.get("heading_kind") == "validation" or title in STANDALONE_VALIDATION_TITLES


def contains_any(text: str, terms: set[str]) -> bool:
    return any(term in text for term in terms)


def norm(title: str) -> str:
    return re.sub(r"\s+", "", title)


def semantic_chars(text: str) -> set[str]:
    return {ch.lower() for ch in text if ch.isalnum() or "\u4e00" <= ch <= "\u9fff"}


def visible_title_length(text: str) -> int:
    return len(re.sub(r"\s+", "", text))


def is_simple_functional_heading(heading: dict[str, Any]) -> bool:
    title = str(heading.get("title", "")).strip()
    return heading.get("heading_kind") in {"functional", "validation"} or title in SIMPLE_FUNCTIONAL_TITLES

def component_visible(component: str, title: str, threshold: float = 0.5) -> bool:
    comp = semantic_chars(norm(component))
    target = semantic_chars(norm(title))
    if not comp:
        return False
    return len(comp & target) / len(comp) >= threshold



def title_added_information(original: str, title: str) -> list[str]:
    original_norm = norm(original)
    title_norm = norm(title)
    added: list[str] = []
    for term in sorted(SUSPICIOUS_ADDED_TERMS, key=len, reverse=True):
        if term in title_norm and term not in original_norm:
            added.append(term)
    source_chars = semantic_chars(original_norm) | ALLOWED_NOMINALIZATION_CHARS
    extra_chars = sorted(semantic_chars(title_norm) - source_chars)
    if extra_chars:
        added.append("新增字符:" + "".join(extra_chars))
    return added


def incomplete_title(title: str) -> bool:
    t = title.strip()
    return not t or t.endswith(DANGLING_SUFFIXES) or any(x in t for x in ("、", "，", ","))

def task_concept_as_title_center(title: str) -> str | None:
    """Return a task-like concept when it is used as the title center/landing point.

    Embedded mentions are not banned by string alone. We reject standalone/end concepts and
    mechanical relabeling such as 风险评估方法、设备状态建模技术、协同机制模型.
    """
    t = re.sub(r"\s+", "", title)
    for term in TASK_CONCEPT_TERMS:
        if t == term or t.endswith(term) or t.endswith(term + "研究"):
            return term
        for head in TECH_RESEARCH_HEADS:
            if t.endswith(term + head):
                return term
    return None



def require_metadata(
    errors: list[str], chapter_id: str, heading: dict[str, Any], parent_task_id: str
) -> None:
    number = str(heading.get("number", "?"))
    for field in ("technical_object", "technical_method", "technical_role", "specificity_basis"):
        if not str(heading.get(field, "")).strip():
            errors.append(f"第{chapter_id}章 {number} 缺少 {field} 元数据。")
    if str(heading.get("parent_task_id", "")) != parent_task_id:
        errors.append(f"第{chapter_id}章 {number} 未正确关联所属课题 {parent_task_id}。")
    obj = norm(str(heading.get("technical_object", "")))
    method = norm(str(heading.get("technical_method", "")))
    signature = norm(str(heading.get("technical_signature", "")))
    title = norm(str(heading.get("title", "")))
    if obj and not component_visible(obj, title, 0.5):
        errors.append(f"第{chapter_id}章 {number} 标题未充分体现技术对象：{obj}。")
    visible_method = signature or method
    if visible_method and not component_visible(visible_method, title, 0.55):
        errors.append(f"第{chapter_id}章 {number} 标题未充分体现中文技术签名/技术方法：{visible_method}。")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("outline", type=Path)
    args = parser.parse_args()
    data = load(args.outline)

    errors: list[str] = []
    warnings: list[str] = []
    chapters = data.get("chapters", [])

    task_book_scope = str(data.get("task_book_scope", "")).strip()
    if task_book_scope not in {"specific_topic", "total_report", "not_applicable"}:
        errors.append(
            "结构化目录必须登记 task_book_scope，取值为 specific_topic、total_report 或 not_applicable。"
        )
    total_report_mode = task_book_scope == "total_report"

    report_theme_type = str(data.get("report_theme_type", "")).strip()
    if report_theme_type not in {"evaluation-related", "non-evaluation"}:
        errors.append(
            "结构化目录必须登记 report_theme_type，取值为 evaluation-related 或 non-evaluation；"
            "该字段由模型根据报告研究主题自动判定，考核指标、测试条件或实验数据本身不能把普通技术报告判成评估主题。"
        )

    for violation in outline_technology_option_violations(data):
        errors.append(f"目录可选技术方案不合规：{violation}")
    evaluation_related = report_theme_type == "evaluation-related"

    report_tasks_raw = data.get("report_tasks", [])
    report_tasks: list[dict[str, Any]] = []
    report_task_by_id: dict[str, dict[str, Any]] = {}
    if total_report_mode:
        if not isinstance(report_tasks_raw, list) or not report_tasks_raw:
            errors.append("总报告必须登记非空 report_tasks，并按任务书课题原始顺序列出全部课题。")
        else:
            report_tasks = report_tasks_raw
            seen_task_ids: set[str] = set()
            task_order_values: list[int] = []
            for task in report_tasks:
                task_id = str(task.get("task_id", "")).strip()
                task_order = task.get("task_order")
                task_title = str(task.get("task_title", "")).strip()
                normalized_title = str(task.get("normalized_chapter_title", "")).strip()
                task_role = str(task.get("task_role", "")).strip()
                point_ids = task.get("research_point_ids", [])
                if not task_id:
                    errors.append("report_tasks 中存在缺少 task_id 的课题。")
                    continue
                if task_id in seen_task_ids:
                    errors.append(f"report_tasks 中课题 {task_id} 重复。")
                seen_task_ids.add(task_id)
                report_task_by_id[task_id] = task
                if not isinstance(task_order, int) or task_order < 1:
                    errors.append(f"课题 {task_id} 缺少有效 task_order。")
                else:
                    task_order_values.append(task_order)
                if not task_title:
                    errors.append(f"课题 {task_id} 缺少 task_title。")
                if not normalized_title:
                    errors.append(f"课题 {task_id} 缺少 normalized_chapter_title。")
                if task_role not in {"technical-research", "engineering-implementation"}:
                    errors.append(f"课题 {task_id} 缺少有效 task_role。")
                if not isinstance(point_ids, list) or not point_ids:
                    errors.append(f"总报告课题 {task_id} 必须登记至少一个 research_point_ids。")
            if task_order_values and task_order_values != list(range(1, len(report_tasks) + 1)):
                errors.append(
                    f"report_tasks 必须按课题原始顺序连续排列，实际 task_order 为 {task_order_values}。"
                )
            if report_tasks:
                for i, task in enumerate(report_tasks, start=1):
                    expected_role = (
                        "engineering-implementation" if i == len(report_tasks) else "technical-research"
                    )
                    actual_role = str(task.get("task_role", "")).strip()
                    if actual_role != expected_role:
                        errors.append(
                            f"总报告第{i}个课题应标记为 {expected_role}，实际为 {actual_role!r}。"
                        )

    total_planned_words = 0
    for chapter in chapters:
        cid = str(chapter.get("id", "?"))
        chapter_title = str(chapter.get("title", "")).strip()
        if visible_title_length(chapter_title) > MAX_TITLE_LENGTH:
            reason = str(chapter.get("title_length_exception_reason", "")).strip()
            message = (
                f"第{cid}章标题超过{MAX_TITLE_LENGTH}个可见字符："
                f"{visible_title_length(chapter_title)}，{chapter_title!r}。"
            )
            if reason:
                warnings.append(message + f" 已记录例外理由：{reason}")
            else:
                warnings.append(message + " 应优先压缩；若受来源原文约束无法安全缩短，记录 title_length_exception_reason。")
        for heading in chapter.get("section_outline", []):
            heading_title = str(heading.get("title", "")).strip()
            if visible_title_length(heading_title) > MAX_TITLE_LENGTH:
                warnings.append(
                    f"第{cid}章 {heading.get('number', '?')} 标题超过{MAX_TITLE_LENGTH}个可见字符："
                    f"{visible_title_length(heading_title)}，{heading_title!r}。"
                )

        target_words = chapter.get("target_words")
        if not isinstance(target_words, int) or target_words <= 0:
            errors.append(f"第{cid}章必须登记正整数 target_words。")
            continue
        total_planned_words += target_words
        is_final_conclusion = chapter is chapters[-1] and chapter_title in CONCLUSION
        minimum_words = chapter.get("minimum_words")
        if is_final_conclusion:
            if not (700 <= target_words <= 800):
                errors.append(f"最后一章 target_words 必须位于700—800字，实际为 {target_words}。")
            if minimum_words != 700:
                errors.append(f"最后一章 minimum_words 必须固定为700，实际为 {minimum_words!r}。")
            maximum_words = chapter.get("maximum_words")
            if maximum_words != 800:
                errors.append(f"最后一章 maximum_words 必须固定为800，实际为 {maximum_words!r}。")
        else:
            expected_minimum = math.ceil(target_words * 0.8)
            if minimum_words != expected_minimum:
                errors.append(
                    f"第{cid}章 minimum_words 必须等于计划字数的80%并向上取整："
                    f"target_words={target_words}，期望 {expected_minimum}，实际 {minimum_words!r}。"
                )

    declared_total = data.get("target_words")
    if isinstance(declared_total, int) and chapters and total_planned_words != declared_total:
        errors.append(f"各章计划字数合计 {total_planned_words} 与全文 target_words {declared_total} 不一致。")

    if len(chapters) < 3:
        errors.append("目录至少应包含项目概述、一个技术章和总结章。")
    else:
        first = chapters[0]
        if str(first.get("id", "")) != "1":
            errors.append("项目概述必须是第1章。")
        if str(first.get("title", "")) != FIRST_TITLE:
            errors.append("第一章必须命名为“项目概述”。")
        first_l2 = [str(h.get("title", "")) for h in headings(first, 2)]
        first_nums = [str(h.get("number", "")) for h in headings(first, 2)]
        if first_l2 != FIRST_LEVEL2:
            errors.append(f"第一章二级标题必须依次且仅为：{FIRST_LEVEL2}；实际为：{first_l2}。")
        if first_nums != ["1.1", "1.2", "1.3"]:
            errors.append(f"第一章二级标题编号必须依次且仅为 1.1、1.2、1.3；实际为：{first_nums}。")

        first_l3 = [(str(h.get("number", "")), str(h.get("title", ""))) for h in headings(first, 3)]
        if first_l3 != FIRST_LEVEL3:
            errors.append(
                "第一章三级标题必须依次且仅为："
                + "、".join(f"{num} {title}" for num, title in FIRST_LEVEL3)
                + f"；实际为：{first_l3}。"
            )

        final_chapter = chapters[-1]
        final_title = str(final_chapter.get("title", "")).strip()
        if final_title not in CONCLUSION:
            errors.append("最后一章必须为总结/总结与展望/结论。")
        if str(final_chapter.get("id", "")) != str(len(chapters)):
            errors.append(f"最后一章编号必须连续为第{len(chapters)}章。")
        final_outline = final_chapter.get("section_outline", []) or []
        lower_headings = [h for h in final_outline if isinstance(h, dict) and int(h.get("level") or 0) >= 2]
        if lower_headings:
            errors.append("最后一章只能保留一个一级标题，不得设置任何二级、三级或更低级标题。")
        level1_rows = [h for h in final_outline if isinstance(h, dict) and int(h.get("level") or 0) == 1]
        if len(level1_rows) > 1:
            errors.append("最后一章 section_outline 最多保留一个一级标题记录。")
        elif level1_rows:
            row = level1_rows[0]
            if str(row.get("title", "")).strip() != final_title or str(row.get("number", "")).strip() != str(final_chapter.get("id", "")):
                errors.append("最后一章 section_outline 的唯一一级标题必须与章标题和章号完全一致。")

    tech = chapters[1:-1] if len(chapters) >= 3 else []
    if total_report_mode and report_tasks and len(tech) != len(report_tasks):
        errors.append(
            f"总报告必须一个课题对应一个技术章：课题 {len(report_tasks)} 个，技术章 {len(tech)} 个。"
        )

    source_orders: list[int] = []
    point_ids_seen: set[str] = set()
    task_ids_seen_in_chapters: set[str] = set()
    task_roles: dict[str, str] = {}
    task_orders: dict[str, int] = {}
    total_core_titles = 0
    global_based_style_count = 0
    global_technical_heading_count = 0
    global_technology_ending_count = 0
    global_method_ending_count = 0

    for idx, chapter in enumerate(tech, start=1):
        cid = str(chapter.get("id", "?"))
        expected_cid = str(idx + 1)
        if cid != expected_cid:
            errors.append(f"技术章编号应从第2章起连续排列：期望 {expected_cid}，实际 {cid}。")

        parent_task_id = str(chapter.get("parent_task_id", "")).strip()
        parent_task_order = chapter.get("parent_task_order")
        task_role = str(chapter.get("task_role", "")).strip()
        if not parent_task_id:
            errors.append(f"第{cid}章缺少 parent_task_id。")
        if not isinstance(parent_task_order, int) or parent_task_order < 1:
            errors.append(f"第{cid}章缺少有效 parent_task_order。")
        if task_role not in {"technical-research", "engineering-implementation"}:
            errors.append(f"第{cid}章缺少有效 task_role。")
        if parent_task_id:
            if parent_task_id in task_roles and task_roles[parent_task_id] != task_role:
                errors.append(f"课题 {parent_task_id} 的 task_role 不一致。")
            task_roles[parent_task_id] = task_role
            if isinstance(parent_task_order, int):
                if parent_task_id in task_orders and task_orders[parent_task_id] != parent_task_order:
                    errors.append(f"课题 {parent_task_id} 的 parent_task_order 不一致。")
                task_orders[parent_task_id] = parent_task_order

        title = str(chapter.get("title", "")).strip()
        expected_task: dict[str, Any] | None = None
        if total_report_mode:
            if parent_task_id in task_ids_seen_in_chapters:
                errors.append(f"总报告课题 {parent_task_id} 被多个技术章重复使用。")
            task_ids_seen_in_chapters.add(parent_task_id)
            if idx <= len(report_tasks):
                expected_task = report_tasks[idx - 1]
                expected_task_id = str(expected_task.get("task_id", "")).strip()
                expected_task_order = expected_task.get("task_order")
                expected_task_role = str(expected_task.get("task_role", "")).strip()
                if parent_task_id != expected_task_id:
                    errors.append(
                        f"总报告第{cid}章必须对应第{idx}个课题 {expected_task_id}，实际为 {parent_task_id}。"
                    )
                if parent_task_order != expected_task_order:
                    errors.append(
                        f"总报告第{cid}章 parent_task_order 应为 {expected_task_order}，实际为 {parent_task_order}。"
                    )
                if task_role != expected_task_role:
                    errors.append(
                        f"总报告第{cid}章 task_role 应为 {expected_task_role}，实际为 {task_role}。"
                    )
            original = str(chapter.get("source_task_title", "")).strip()
            approved = str(chapter.get("source_task_normalized_title", "")).strip()
            basis = str(chapter.get("task_title_normalization_basis", "")).strip()
            if not original:
                errors.append(f"总报告第{cid}章缺少 source_task_title。")
            if not approved:
                errors.append(f"总报告第{cid}章缺少 source_task_normalized_title。")
            elif title != approved:
                errors.append(f"总报告第{cid}章标题必须与已确认课题章名完全一致：{approved!r}，实际 {title!r}。")
            if not basis:
                errors.append(f"总报告第{cid}章缺少 task_title_normalization_basis。")
            if expected_task is not None:
                task_title = str(expected_task.get("task_title", "")).strip()
                normalized_title = str(expected_task.get("normalized_chapter_title", "")).strip()
                if original != task_title:
                    errors.append(
                        f"总报告第{cid}章 source_task_title 与 report_tasks 不一致：期望 {task_title!r}，实际 {original!r}。"
                    )
                if approved != normalized_title:
                    errors.append(
                        f"总报告第{cid}章 source_task_normalized_title 与 report_tasks 不一致："
                        f"期望 {normalized_title!r}，实际 {approved!r}。"
                    )
        else:
            original = str(chapter.get("source_research_subpoint_title", "")).strip()
            approved = str(chapter.get("source_research_normalized_title", "")).strip()
            basis = str(chapter.get("title_normalization_basis", "")).strip()
            if not original:
                errors.append(f"第{cid}章缺少 source_research_subpoint_title。")
            if not approved:
                errors.append(f"第{cid}章缺少 source_research_normalized_title。")
            elif title != approved:
                errors.append(f"第{cid}章标题必须与已确认标题完全一致：{approved!r}，实际 {title!r}。")
            if not basis:
                errors.append(f"第{cid}章缺少 title_normalization_basis。")
        if title.startswith(ACTION_PREFIXES):
            errors.append(f"第{cid}章标题仍以任务动作词开头：{title!r}。")
        if incomplete_title(title):
            errors.append(f"第{cid}章标题关系不完整或存在并列拼接：{title!r}。")
        if original and title:
            added_info = title_added_information(original, title)
            if added_info:
                errors.append(
                    f"第{cid}章标题疑似增加来源标题没有的信息：{', '.join(added_info)}；"
                    f"原文={original!r}，标题={title!r}。"
                )

        if task_role == "technical-research":
            center_term = task_concept_as_title_center(title)
            if center_term:
                errors.append(
                    f"第{cid}章技术研究标题把任务性概念“{center_term}”作为中心或通过机械加技术中心词改名：{title!r}。"
                )
            if not title.endswith(TECH_RESEARCH_HEADS):
                errors.append(f"第{cid}章技术研究标题应直接落到技术、方法、算法或模型：{title!r}。")
        elif task_role == "engineering-implementation":
            if not contains_any(title, ENGINEERING_TERMS):
                errors.append(f"第{cid}章工程实现标题未体现系统、平台、架构、模块、接口、部署、集成或应用：{title!r}。")

        point_ids = chapter.get("source_research_point_ids")
        if total_report_mode:
            if not isinstance(point_ids, list) or not point_ids:
                errors.append(f"总报告第{cid}章必须关联所属课题的全部研究内容小点。")
                point_ids = []
            expected_point_ids = (
                expected_task.get("research_point_ids", []) if expected_task is not None else []
            )
            if isinstance(point_ids, list) and isinstance(expected_point_ids, list):
                if [str(x) for x in point_ids] != [str(x) for x in expected_point_ids]:
                    errors.append(
                        f"总报告第{cid}章 source_research_point_ids 必须与所属课题全部小点及顺序一致："
                        f"期望 {expected_point_ids}，实际 {point_ids}。"
                    )
        else:
            if not isinstance(point_ids, list) or len(point_ids) != 1:
                errors.append(f"具体课题报告第{cid}章必须且只能关联一个研究内容小点。")
                point_ids = []

        for point_id in point_ids:
            if str(point_id) in point_ids_seen:
                errors.append(f"研究内容小点 {point_id} 被多个技术章重复使用。")
            point_ids_seen.add(str(point_id))

        if not total_report_mode:
            order = chapter.get("source_research_order")
            if not isinstance(order, int) or order < 1:
                errors.append(f"第{cid}章缺少有效 source_research_order。")
            else:
                source_orders.append(order)
                if order != idx:
                    errors.append(f"第{cid}章与研究内容小点原始顺序不一致：应为 {idx}，实际 {order}。")

        level2 = headings(chapter, 2)
        level3_all = headings(chapter, 3)
        if task_role == "technical-research":
            for heading in level2 + level3_all:
                heading_title = str(heading.get("title", "")).strip()
                heading_number = str(heading.get("number", "?"))
                center_term = task_concept_as_title_center(heading_title)
                if center_term:
                    errors.append(
                        f"第{cid}章 {heading_number} 把任务性概念“{center_term}”作为标题中心或机械改名：{heading_title!r}。"
                    )
        if not evaluation_related:
            for heading in level2 + level3_all:
                heading_title = str(heading.get("title", "")).strip()
                if is_summary(heading_title):
                    continue
                if heading_has_evaluation_term(heading_title):
                    errors.append(
                        f"第{cid}章 {heading.get('number', '?')} 属于非评估主题，二/三级标题不得出现验证、评估、评价、测试、试验、实验等评价验证类词：{heading_title!r}。"
                        "任务书中的测试/验收要求应转写为性能约束、工况条件、可靠性、时延、精度、边界等技术语义后融入技术标题或正文。"
                    )
        # v1.1.26: every substantive L2 heading in a technical chapter must have a task subject
        # that independently carries a strong electric-power signal. “本章小结” is structural only.
        for heading in level2:
            heading_title = str(heading.get("title", "")).strip()
            if is_summary(heading_title):
                continue
            technical_signature = str(heading.get("technical_signature", "")).strip()
            if not heading_task_subject_has_power_signal(heading_title, technical_signature):
                task_subject = heading_task_subject(heading_title, technical_signature)
                errors.append(
                    f"第{cid}章 {heading.get('number', '?')} 二级标题主语缺少电力相关词：{task_subject!r}。"
                    "标题含‘的’时，以‘的’之后完整部分作为主语；主语本身必须出现电网/调度/变电/线路/功率/运检等电力领域词。"
                )

        forbidden_intro_titles = {"概述", "技术路线", "技术架构", "技术路线与总体架构"}
        for h in level2:
            if str(h.get("title", "")).strip() in forbidden_intro_titles:
                errors.append(
                    f"第{cid}章不得设置“{str(h.get('title', '')).strip()}”二级标题；"
                    "背景、研究意义和总体技术路线/架构必须合并到一级标题后的无标题章首导入正文。"
                )
        if len(level2) < 4:
            errors.append(f"第{cid}章至少应包含X.1—X.3三个默认核心二级标题和本章小结。")

        summary_headings = [h for h in level2 if is_summary(str(h.get("title", "")))]
        if not summary_headings:
            errors.append(f"第{cid}章缺少本章小结。")

        validation_headings = [h for h in level2 if is_validation(h)]
        validation_mode = str(chapter.get("standalone_validation_mode", "none")).strip() or "none"
        if validation_mode not in {"none", "large-data", "user-requested"}:
            errors.append(f"第{cid}章 standalone_validation_mode 无效：{validation_mode!r}。")
        if not evaluation_related:
            if validation_mode != "none" or validation_headings:
                errors.append(
                    f"第{cid}章为非评估主题，不得启用独立验证/评估/测试二级节；standalone_validation_mode 必须为 none。"
                )
        else:
            if validation_headings and validation_mode == "none":
                errors.append(
                    f"第{cid}章评估主题下如需独立验证二级节仍必须登记例外模式；"
                    "仅大量成体系数据或用户明确要求时允许。"
                )
            if validation_mode in {"large-data", "user-requested"}:
                if not validation_headings:
                    warnings.append(f"第{cid}章声明独立验证例外，但目录中未设置验证二级节。")
                if not str(chapter.get("standalone_validation_reason", "")).strip():
                    errors.append(f"第{cid}章启用独立验证例外但缺少 standalone_validation_reason。")
        if len(validation_headings) > 1:
            errors.append(f"第{cid}章最多允许一个独立验证二级节。")

        core = [h for h in level2 if not is_summary(str(h.get("title", ""))) and not is_validation(h)]
        core_count = len(core)
        declared_core_count = chapter.get("core_section_count", 3)
        expansion_reason = str(chapter.get("core_section_expansion_reason", "")).strip()
        if core_count < 3 or core_count > 5:
            errors.append(f"第{cid}章核心技术二级标题默认3个，必要时最多扩展到5个；实际为 {core_count} 个。")
        if declared_core_count != core_count:
            errors.append(f"第{cid}章 core_section_count 应与实际核心二级标题数一致：声明 {declared_core_count}，实际 {core_count}。")
        if core_count > 3 and not expansion_reason:
            errors.append(f"第{cid}章扩展到{core_count}个核心二级标题但缺少 core_section_expansion_reason；必须说明哪些预期目标/进度技术点无法合理归并。")
        if core_count == 3 and expansion_reason:
            warnings.append(f"第{cid}章保持默认3个核心二级标题，无需填写 core_section_expansion_reason。")
        expected_core_numbers = [f"{cid}.{i}" for i in range(1, core_count + 1)]
        actual_core_numbers = [str(h.get("number", "")) for h in core]
        if actual_core_numbers != expected_core_numbers:
            errors.append(f"第{cid}章核心二级标题编号必须连续为 {expected_core_numbers}；实际为 {actual_core_numbers}。")

        next_number = core_count + 1
        if validation_headings:
            expected_validation_number = f"{cid}.{next_number}"
            if str(validation_headings[0].get("number", "")) != expected_validation_number:
                errors.append(f"第{cid}章独立验证二级节如启用，编号必须为 {expected_validation_number}。")
            next_number += 1
        if summary_headings:
            expected_summary_number = f"{cid}.{next_number}"
            actual_summary_numbers = [str(h.get("number", "")) for h in summary_headings]
            if actual_summary_numbers != [expected_summary_number]:
                errors.append(f"第{cid}章本章小结编号应为 {expected_summary_number}；实际为 {actual_summary_numbers}。")

        primary_subject = str(chapter.get("primary_technical_subject", "")).strip()
        if not primary_subject:
            errors.append(f"第{cid}章缺少 primary_technical_subject，无法保证研究内容核心技术主语得到整体展开。")
        primary_subject_source = str(chapter.get("primary_subject_source_text", "")).strip()
        if not primary_subject_source:
            errors.append(f"第{cid}章缺少 primary_subject_source_text。")
        primary_subject_section_number = str(chapter.get("primary_subject_section_number", "")).strip()
        primary_subject_share = chapter.get("primary_subject_target_share")
        primary_subject_exception = str(chapter.get("primary_subject_share_exception_reason", "")).strip()
        if not isinstance(primary_subject_share, (int, float)):
            errors.append(f"第{cid}章 primary_subject_target_share 必须为数值。")
        elif primary_subject_share < 0.25 and not primary_subject_exception:
            errors.append(
                f"第{cid}章核心技术主语整体展开节计划占比仅为 {primary_subject_share:.1%}，低于25%，且未提供例外理由。"
            )

        scheduled = chapter.get("schedule_technology_item_ids", [])
        if not isinstance(scheduled, list):
            errors.append(f"第{cid}章 schedule_technology_item_ids 必须为数组。")
            scheduled = []
        covered_schedule: set[str] = set()
        primary_subject_sections: list[dict[str, Any]] = []
        chapter_based_style_count = 0
        chapter_technical_heading_count = 0
        chapter_level3_task_subjects: list[dict[str, str]] = []
        chapter_technology_ending_count = 0
        chapter_method_ending_count = 0

        for h in core:
            htitle = str(h.get("title", "")).strip()
            hnum = str(h.get("number", "?"))
            if task_role == "technical-research":
                chapter_technical_heading_count += 1
                global_technical_heading_count += 1
                if is_based_on_heading_style(htitle):
                    chapter_based_style_count += 1
                    global_based_style_count += 1
            if h.get("heading_kind") != "innovation":
                errors.append(f"第{cid}章 {hnum} 核心技术标题必须标记 heading_kind=innovation。")
            if htitle in SIMPLE_FUNCTIONAL_TITLES or is_simple_functional_heading(h):
                errors.append(f"第{cid}章 {hnum} 为简洁功能性标题，不能占用X.1-X.N核心技术标题：{htitle!r}。")
            if len(htitle) < 10:
                errors.append(f"第{cid}章 {hnum} 核心标题信息不足：{htitle!r}。")
            if htitle.startswith(ACTION_PREFIXES) or incomplete_title(htitle):
                errors.append(f"第{cid}章 {hnum} 标题关系不完整：{htitle!r}。")
            if task_role == "technical-research":
                if not htitle.endswith(TECH_RESEARCH_HEADS):
                    errors.append(f"第{cid}章 {hnum} 技术研究核心标题应直接以‘技术’或‘方法’结尾：{htitle!r}。")
                elif htitle.endswith("技术"):
                    chapter_technology_ending_count += 1
                    global_technology_ending_count += 1
                elif htitle.endswith("方法"):
                    chapter_method_ending_count += 1
                    global_method_ending_count += 1
            elif not contains_any(htitle, ENGINEERING_TERMS):
                warnings.append(f"第{cid}章 {hnum} 工程实现标题未显式体现工程对象：{htitle!r}。")
            total_core_titles += 1
            power_element = str(h.get("power_element", "")).strip()
            if not power_element:
                errors.append(f"第{cid}章 {hnum} 缺少 power_element 元数据。")
            elif not component_visible(power_element, htitle, 0.45):
                errors.append(f"第{cid}章 {hnum} 标题未充分体现电力对象或约束：{power_element!r}。")
            if task_role == "technical-research":
                power_issue = power_domain_signal_issue(htitle)
                if power_issue:
                    errors.append(
                        f"第{cid}章 {hnum} 技术标题缺少独立可见的电力领域关键词：{htitle!r}；"
                        "‘基于……的……’句式不能替代电力语义，应在同一标题中保留电网/调度/变电/运检/线路/功率等强领域信号。"
                    )
                english_tokens = raw_english_technology_tokens(htitle)
                if english_tokens:
                    errors.append(
                        f"第{cid}章 {hnum} 二级技术标题仍裸露英文技术名/缩写：{english_tokens}；"
                        "目录应改用简洁、有实际路线含义的中文技术表达，原始英文名保留在内部元数据或正文首次定义中。"
                    )
            rp = str(h.get("research_point_id", ""))
            if point_ids and rp not in {str(x) for x in point_ids}:
                errors.append(f"第{cid}章 {hnum} 未正确关联当前研究内容小点。")
            required_core_fields = [
                "power_element", "derivation_basis",
                "specific_computing_technology", "technology_specificity_basis", "technology_origin",
                "shared_chapter_question", "chain_order", "chain_role", "depends_on_previous",
            ]
            if task_role == "technical-research":
                required_core_fields.append("technical_signature")
            for field in required_core_fields:
                value = h.get(field)
                if isinstance(value, str):
                    missing = not value.strip()
                else:
                    missing = value is None
                if missing:
                    errors.append(f"第{cid}章 {hnum} 缺少 {field} 元数据。")
            specific_tech = str(h.get("specific_computing_technology", "")).strip()
            technical_signature = str(h.get("technical_signature", "")).strip()
            technical_role = str(h.get("technical_role", "")).strip()
            family_pattern = bare_family_title_pattern(htitle)
            based_on_issue = based_on_signature_issue(htitle)
            if task_role == "technical-research" and based_on_issue:
                errors.append(
                    f"第{cid}章 {hnum} 使用了‘基于……的……’句式，但‘基于’后的技术仍不够具体：{based_on_issue}；"
                    "应写明具体模型/算法变体、关键机制、约束或组合方式。"
                )
            if family_pattern:
                errors.append(
                    f"第{cid}章 {hnum} 标题仍停留在技术族粒度：出现“基于{family_pattern}的……”；"
                    "应继续写明具体变体、结构、关键机制、约束或组合方式。"
                )
            if task_role == "technical-research" and specific_tech:
                family_issue = family_level_technology(
                    specific_tech, role=technical_role, power_element=power_element
                )
                signature_issue = technical_signature_issue(
                    specific_tech, role=technical_role, power_element=power_element
                )
                if specific_tech in GENERIC_COMPUTING_TECH or family_issue or signature_issue:
                    broad = family_issue or signature_issue or specific_tech
                    errors.append(
                        f"第{cid}章 {hnum} specific_computing_technology 技术显化不足：{specific_tech!r}"
                        f"（问题：{broad!r}）；不能只写技术族或Span抽取、双塔匹配、置信校准、参数更新等任务动作，"
                        "应进一步落到可区分的具体模型/算法变体、关键机制、约束或组合方式。"
                    )
            if task_role == "technical-research" and technical_signature:
                english_signature_tokens = raw_english_technology_tokens(technical_signature)
                if english_signature_tokens:
                    errors.append(
                        f"第{cid}章 {hnum} technical_signature 必须是用于目录显示的中文语义技术签名，"
                        f"不能直接包含英文技术名/缩写：{english_signature_tokens}。"
                    )
                signature_issue = technical_signature_issue(
                    technical_signature, role=technical_role, power_element=power_element
                )
                if signature_issue:
                    errors.append(
                        f"第{cid}章 {hnum} technical_signature 过于宽泛：{technical_signature!r}（{signature_issue}）。"
                    )
                elif not component_visible(technical_signature, htitle, 0.70):
                    errors.append(
                        f"第{cid}章 {hnum} 标题未直接显化 technical_signature={technical_signature!r}：{htitle!r}。"
                    )
            if task_role == "technical-research" and specific_tech and technical_signature:
                # Original technology names may remain English in metadata while technical_signature is the
                # Chinese route-semantic form used in the heading. Character overlap is therefore not a valid
                # equivalence test across languages; technology_specificity_basis carries that mapping.
                same_script = bool(raw_english_technology_tokens(specific_tech)) == bool(raw_english_technology_tokens(technical_signature))
                if same_script and not component_visible(technical_signature, specific_tech, 0.55) and not component_visible(specific_tech, technical_signature, 0.55):
                    warnings.append(
                        f"第{cid}章 {hnum} specific_computing_technology 与 technical_signature 关联度较低，请确认未登记两套不同技术："
                        f"{specific_tech!r} vs {technical_signature!r}。"
                    )
            origin = str(h.get("technology_origin", "")).strip()
            if origin and origin not in {"source_confirmed", "model_suggested", "user_confirmed_design"}:
                errors.append(f"第{cid}章 {hnum} technology_origin 无效：{origin!r}。")
            expected_index = int(hnum.split(".")[-1]) if hnum.count(".") == 1 and hnum.split(".")[-1].isdigit() else None
            expected_chain_order = expected_index
            if h.get("chain_order") != expected_chain_order:
                errors.append(
                    f"第{cid}章 {hnum} chain_order 应为 {expected_chain_order}，实际为 {h.get('chain_order')}。"
                )
            depends = h.get("depends_on_previous")
            if expected_index == 1:
                if depends is not False:
                    errors.append(f"第{cid}章 {hnum} X.1 的 depends_on_previous 必须为 false。")
                if not str(h.get("output_to_next", "")).strip():
                    errors.append(f"第{cid}章 {hnum} 缺少 output_to_next，无法建立与X.2的承接。")
            elif expected_index in {2, 3}:
                if depends is not True:
                    errors.append(f"第{cid}章 {hnum} depends_on_previous 必须为 true。")
                if not str(h.get("handoff_from_previous", "")).strip():
                    errors.append(f"第{cid}章 {hnum} 缺少 handoff_from_previous，无法说明前序输入。")
                if expected_index == 2 and not str(h.get("output_to_next", "")).strip():
                    errors.append(f"第{cid}章 {hnum} 缺少 output_to_next，无法建立与X.3的承接。")
            if "primary_subject_section" not in h or not isinstance(h.get("primary_subject_section"), bool):
                errors.append(f"第{cid}章 {hnum} 必须显式登记布尔字段 primary_subject_section。")
            elif h.get("primary_subject_section") is True:
                primary_subject_sections.append(h)
                heading_primary_subject = str(h.get("primary_technical_subject", "")).strip()
                if not heading_primary_subject:
                    errors.append(f"第{cid}章 {hnum} 主体技术整体展开节缺少 primary_technical_subject。")
                elif primary_subject and heading_primary_subject != primary_subject:
                    errors.append(
                        f"第{cid}章 {hnum} 的 primary_technical_subject 与章级字段不一致：{heading_primary_subject!r} != {primary_subject!r}。"
                    )
                if str(h.get("primary_subject_coverage_role", "")).strip() != "overall":
                    errors.append(f"第{cid}章 {hnum} 主体技术整体展开节必须设置 primary_subject_coverage_role=overall。")
                if primary_subject and not component_visible(primary_subject, htitle, 0.55):
                    errors.append(
                        f"第{cid}章 {hnum} 被指定为主体技术整体展开节，但标题未直接体现核心技术主语 {primary_subject!r}：{htitle!r}。"
                    )
            if h.get("research_subpoint_index") != expected_index:
                errors.append(f"第{cid}章 {hnum} research_subpoint_index 应为 {expected_index}，实际为 {h.get('research_subpoint_index')}。")
            source_ids = h.get("source_item_ids", [])
            if not isinstance(source_ids, list) or not source_ids:
                errors.append(f"第{cid}章 {hnum} 未登记研究小点来源事项。")
            require_metadata(errors, cid, h, parent_task_id)
            ids = h.get("schedule_item_ids", [])
            if not isinstance(ids, list):
                errors.append(f"第{cid}章 {hnum} schedule_item_ids 必须为数组。")
            else:
                covered_schedule.update(str(x) for x in ids)

        if not primary_subject_sections:
            errors.append(f"第{cid}章 X.1—X.N 至少一节必须设置 primary_subject_section=true，整体展开核心技术主语。")
        else:
            actual_primary_numbers = [str(h.get("number", "")) for h in primary_subject_sections]
            if primary_subject_section_number and primary_subject_section_number not in actual_primary_numbers:
                errors.append(
                    f"第{cid}章 primary_subject_section_number={primary_subject_section_number!r} 与实际主体技术整体展开节 {actual_primary_numbers} 不一致。"
                )

        shared_questions = {
            str(h.get("shared_chapter_question", "")).strip() for h in core
            if str(h.get("shared_chapter_question", "")).strip()
        }
        if len(shared_questions) != 1:
            errors.append(
                f"第{cid}章 X.1—X.N 必须共享同一个 shared_chapter_question，实际为 {sorted(shared_questions)}。"
            )
        chain_roles = [str(h.get("chain_role", "")).strip() for h in core]
        if len({x for x in chain_roles if x}) != len([x for x in chain_roles if x]):
            warnings.append(f"第{cid}章 X.1—X.N chain_role 存在重复，请确认各核心节职责是否真正承接。")

        missing_schedule = {str(x) for x in scheduled} - covered_schedule
        if missing_schedule:
            errors.append(f"第{cid}章进度计划主要技术事项未进入核心标题：{', '.join(sorted(missing_schedule))}。")

        expected_goal_ids = chapter.get("expected_goal_item_ids", [])
        if not isinstance(expected_goal_ids, list):
            errors.append(f"第{cid}章 expected_goal_item_ids 必须为数组。")
            expected_goal_ids = []
        heading_term_plan = chapter.get("heading_source_term_plan", [])
        if not isinstance(heading_term_plan, list):
            errors.append(f"第{cid}章 heading_source_term_plan 必须为数组。")
            heading_term_plan = []
        required_heading_term_sources = {
            "expected-output": {str(x) for x in expected_goal_ids},
            "schedule-plan": {str(x) for x in scheduled},
            "assessment-requirement": {str(x) for x in chapter.get("assessment_requirement_item_ids", []) if str(x)},
        }
        if task_book_scope != "not_applicable" and any(required_heading_term_sources.values()) and not heading_term_plan:
            errors.append(
                f"第{cid}章缺少 heading_source_term_plan；任务书预期目标、考核要求和课题进度中的关键技术词必须按宽泛词→二级、窄技术词→三级分散映射到目录。"
            )
        target_heading_map = {str(h.get("number", "")): h for h in level2 + level3_all}
        planned_source_ids: dict[str, set[str]] = {key: set() for key in required_heading_term_sources}
        term_target_branches: set[str] = set()
        for row in heading_term_plan:
            if not isinstance(row, dict):
                errors.append(f"第{cid}章 heading_source_term_plan 中存在非对象条目。")
                continue
            source_type = str(row.get("source_type", "")).strip()
            source_item_id = str(row.get("source_item_id", "")).strip()
            term = str(row.get("term", "")).strip()
            granularity = str(row.get("granularity", "")).strip()
            target_number = str(row.get("target_heading_number", "")).strip()
            if source_type not in required_heading_term_sources:
                errors.append(f"第{cid}章标题来源词 {term!r} 的 source_type 无效：{source_type!r}。")
                continue
            if not source_item_id:
                errors.append(f"第{cid}章 heading_source_term_plan 存在缺少 source_item_id 的条目。")
            else:
                planned_source_ids[source_type].add(source_item_id)
            if not term:
                errors.append(f"第{cid}章来源事项 {source_item_id} 缺少可见技术词 term。")
            if granularity not in {"broad", "narrow"}:
                errors.append(f"第{cid}章来源技术词 {term!r} 的 granularity 必须为 broad 或 narrow。")
            target = target_heading_map.get(target_number)
            if target is None:
                errors.append(f"第{cid}章来源技术词 {term!r} 的目标标题不存在：{target_number!r}。")
                continue
            level = int(target.get("level") or 0)
            if not re.match(rf"^{re.escape(cid)}\.(?:1|2|3)(?:\.|$)", target_number):
                errors.append(f"第{cid}章来源技术词 {term!r} 必须落在X.1—X.N或其三级标题，实际为 {target_number}。")
            if granularity == "broad" and level != 2:
                errors.append(f"第{cid}章概括性技术词 {term!r} 应进入二级标题，实际目标为 {target_number}。")
            if granularity == "narrow" and level != 3:
                errors.append(f"第{cid}章窄范围技术词 {term!r} 应进入三级标题，实际目标为 {target_number}。")
            target_title = norm(str(target.get("title", "")))
            if term and norm(term) not in target_title:
                errors.append(
                    f"第{cid}章来源技术词 {term!r} 未直接出现在目标标题 {target_number}={target.get('title', '')!r} 中。"
                )
            m_branch = re.match(rf"^({re.escape(cid)}\.[123])(?:\.|$)", target_number)
            if m_branch:
                term_target_branches.add(m_branch.group(1))
        for source_type, required_ids in required_heading_term_sources.items():
            missing_ids = required_ids - planned_source_ids[source_type]
            if missing_ids:
                errors.append(
                    f"第{cid}章 {source_type} 的关键技术事项尚未形成标题词映射：{', '.join(sorted(missing_ids))}。"
                )
        if len(heading_term_plan) >= 3 and len(term_target_branches) < 2:
            errors.append(
                f"第{cid}章任务书关键技术词过度集中在同一研究小点，至少应在不破坏技术链的前提下分散到两个X.1—X.N分支。"
            )

        assessment_ids = chapter.get("assessment_requirement_item_ids", [])
        if not isinstance(assessment_ids, list):
            errors.append(f"第{cid}章 assessment_requirement_item_ids 必须为数组。")
            assessment_ids = []
        assessment_plan = chapter.get("assessment_coverage_plan", [])
        if not isinstance(assessment_plan, list):
            errors.append(f"第{cid}章 assessment_coverage_plan 必须为数组。")
            assessment_plan = []
        planned_assessment_ids = set()
        valid_sections = {str(h.get("number", "")) for h in level2 + level3_all}
        core_section_pattern = re.compile(rf"^{re.escape(cid)}\.(?:1|2|3)(?:\.|$)")
        for plan in assessment_plan:
            item_id = str(plan.get("assessment_item_id", "")).strip()
            if not item_id:
                errors.append(f"第{cid}章存在缺少 assessment_item_id 的内部技术要求覆盖计划。")
                continue
            planned_assessment_ids.add(item_id)
            for field in ("planned_section", "content_form", "prose_realization", "evidence_status"):
                if not str(plan.get(field, "")).strip():
                    errors.append(f"第{cid}章内部技术要求 {item_id} 缺少 {field}。")
            if plan.get("source_identity_hidden") is not True:
                errors.append(f"第{cid}章内部技术要求 {item_id} 必须设置 source_identity_hidden=true。")
            planned_section = str(plan.get("planned_section", ""))
            if planned_section not in valid_sections:
                errors.append(f"第{cid}章内部技术要求 {item_id} 的正文位置不在目录中：{planned_section}。")
            elif not core_section_pattern.match(planned_section):
                errors.append(
                    f"第{cid}章内部技术要求 {item_id} 默认必须融入X.1—X.N或其三级标题：{planned_section}。"
                )
            evidence_section = str(plan.get("evidence_section", "")).strip()
            if evidence_section and evidence_section not in valid_sections:
                errors.append(f"第{cid}章内部技术要求 {item_id} 的可选证据位置不在目录中：{evidence_section}。")
            if "validation_section" in plan:
                errors.append(f"第{cid}章内部技术要求 {item_id} 仍使用已废弃字段 validation_section。")
        missing_assessment = {str(x) for x in assessment_ids} - planned_assessment_ids
        if missing_assessment:
            errors.append(f"第{cid}章内部技术要求未建立正文隐性覆盖计划：{', '.join(sorted(missing_assessment))}。")

        # Level-3 technical headings must be concrete and more specific than their parent level-2 heading.
        level3 = level3_all
        parent_titles = {str(h.get("number")): str(h.get("title", "")) for h in level2}
        for h in level3:
            if h.get("heading_kind") != "technical":
                continue
            htitle = str(h.get("title", "")).strip()
            hnum = str(h.get("number", "?"))
            if task_role == "technical-research":
                chapter_technical_heading_count += 1
                global_technical_heading_count += 1
                if is_based_on_heading_style(htitle):
                    chapter_based_style_count += 1
                    global_based_style_count += 1
            if is_simple_functional_heading(h):
                if h.get("heading_kind") not in {"functional", "validation"}:
                    warnings.append(
                        f"第{cid}章 {hnum} 使用简洁功能标题 {htitle!r}，建议标记 heading_kind=functional。"
                    )
                continue
            if htitle in GENERIC or len(htitle) < 7:
                errors.append(f"第{cid}章 {hnum} 三级技术标题过于笼统：{htitle!r}。")
            if htitle.startswith(ACTION_PREFIXES) or incomplete_title(htitle):
                errors.append(f"第{cid}章 {hnum} 三级标题关系不完整：{htitle!r}。")
            if task_role == "technical-research":
                if not htitle.endswith(TECH_RESEARCH_HEADS):
                    errors.append(f"第{cid}章 {hnum} 技术研究三级标题应直接以‘技术’或‘方法’结尾：{htitle!r}。")
                elif htitle.endswith("技术"):
                    chapter_technology_ending_count += 1
                    global_technology_ending_count += 1
                elif htitle.endswith("方法"):
                    chapter_method_ending_count += 1
                    global_method_ending_count += 1
            require_metadata(errors, cid, h, parent_task_id)
            l3_role = str(h.get("technical_role", "")).strip()
            l3_power = str(h.get("power_element", "")).strip()
            if task_role == "technical-research":
                if l3_power and not component_visible(l3_power, htitle, 0.45):
                    errors.append(f"第{cid}章 {hnum} 三级技术标题未充分体现 power_element={l3_power!r}：{htitle!r}。")
                power_issue = power_domain_signal_issue(htitle)
                if power_issue:
                    errors.append(
                        f"第{cid}章 {hnum} 三级技术标题缺少独立可见的电力领域关键词：{htitle!r}；"
                        "不得仅依赖上位二级标题补足电力语义。"
                    )
                english_tokens = raw_english_technology_tokens(htitle)
                if english_tokens:
                    errors.append(
                        f"第{cid}章 {hnum} 三级技术标题仍裸露英文技术名/缩写：{english_tokens}；"
                        "应改为能够看出技术路线的中文语义技术名。"
                    )
            l3_method = str(h.get("technical_method", "")).strip()
            l3_signature = str(h.get("technical_signature", "")).strip()
            if task_role == "technical-research":
                task_subject = heading_task_subject(htitle, l3_signature)
                if not task_subject:
                    errors.append(
                        f"第{cid}章 {hnum} 无法提取三级标题的技术任务主语；应让标题清楚区分具体技术签名与其承担的电力任务。"
                    )
                else:
                    for previous in chapter_level3_task_subjects:
                        if task_subjects_are_duplicate(task_subject, previous["subject"]):
                            errors.append(
                                f"第{cid}章三级技术标题任务主语重复：{previous['number']}={previous['subject']!r}，"
                                f"{hnum}={task_subject!r}。同一章内即使前置技术签名不同，‘的’之后或直接复合标题中承担的"
                                "电力任务主语也必须互不重复；应把两个三级标题拆成不同的处理对象、步骤、输出或技术职责。"
                            )
                            break
                    chapter_level3_task_subjects.append({"number": hnum, "subject": task_subject, "title": htitle})
            if task_role == "technical-research" and not l3_signature:
                errors.append(f"第{cid}章 {hnum} 三级技术标题缺少 technical_signature；三级标题不得仅继承上位技术。")
            elif task_role == "technical-research":
                english_signature_tokens = raw_english_technology_tokens(l3_signature)
                if english_signature_tokens:
                    errors.append(
                        f"第{cid}章 {hnum} 三级 technical_signature 必须使用中文语义技术签名，"
                        f"不能直接包含英文技术名/缩写：{english_signature_tokens}。"
                    )
                sig_issue = technical_signature_issue(l3_signature, role=l3_role, power_element=l3_power)
                if sig_issue:
                    errors.append(
                        f"第{cid}章 {hnum} technical_signature={l3_signature!r} 仍不够具体（{sig_issue}）；"
                        "应显式写出具体模型/算法变体或关键机制组合。"
                    )
                elif not component_visible(l3_signature, htitle, 0.70):
                    errors.append(
                        f"第{cid}章 {hnum} 标题未直接显化 technical_signature={l3_signature!r}：{htitle!r}。"
                    )
            l3_family = family_level_technology(l3_method, role=l3_role, power_element=l3_power)
            l3_method_issue = technical_signature_issue(l3_method, role=l3_role, power_element=l3_power)
            l3_family_pattern = bare_family_title_pattern(htitle)
            l3_based_on_issue = based_on_signature_issue(htitle)
            if task_role == "technical-research" and l3_based_on_issue:
                errors.append(
                    f"第{cid}章 {hnum} ‘基于’后的技术签名仍不够具体：{l3_based_on_issue}。"
                )
            if l3_family_pattern:
                errors.append(
                    f"第{cid}章 {hnum} 三级标题仍停留在技术族粒度：出现“基于{l3_family_pattern}的……”；"
                    "应进一步明确细粒度技术变体或关键机制。"
                )
            if task_role == "technical-research" and (l3_family or l3_method_issue):
                errors.append(
                    f"第{cid}章 {hnum} technical_method 技术显化不足：{l3_method!r}（{l3_family or l3_method_issue!r}）；"
                    "三级技术标题不能只写技术族或Span抽取、双塔匹配、置信校准、样本重加权、参数更新等任务动作。"
                )
            named_technology = str(h.get("named_technology", "")).strip()
            named_technology_basis = str(h.get("named_technology_basis", "")).strip()
            if task_role == "technical-research" and not named_technology:
                errors.append(
                    f"第{cid}章 {hnum} 三级技术标题必须登记 named_technology；"
                    "不得只依靠上位二级标题中的技术名称。"
                )
            elif named_technology:
                named_issue = technical_signature_issue(named_technology, role=l3_role, power_element=l3_power)
                if named_issue:
                    errors.append(
                        f"第{cid}章 {hnum} named_technology={named_technology!r} 仍不够具体（{named_issue}）；"
                        "应登记能够区分技术路线的具体模型/算法变体或关键机制组合。"
                    )
                # named_technology may intentionally preserve the canonical English name. The title-visible
                # equivalent is technical_signature, which is already checked above for Chinese semantics and visibility.
                if not named_technology_basis:
                    errors.append(f"第{cid}章 {hnum} 使用具体技术名但缺少 named_technology_basis。")
            parent_num = ".".join(hnum.split(".")[:2])
            parent_title = parent_titles.get(parent_num, "")
            if parent_title and norm(htitle) == norm(parent_title):
                errors.append(f"第{cid}章 {hnum} 三级标题与上位二级标题重复，未进一步具体化。")

        # Every core level-2 section defaults to 2-4 level-3 headings; a fifth needs an explicit reason.
        level3_expansion_reasons = chapter.get("level3_expansion_reasons", {}) or {}
        for core_heading in core:
            parent_num = str(core_heading.get("number", ""))
            group = [h for h in level3_all if str(h.get("number", "")).startswith(parent_num + ".")]
            if not 2 <= len(group) <= 5:
                errors.append(f"第{cid}章 {parent_num} 默认应设置2—4个三级标题，必要时最多5个；实际为 {len(group)} 个。")
                continue
            if len(group) == 5 and not str(level3_expansion_reasons.get(parent_num, "")).strip():
                errors.append(f"第{cid}章 {parent_num} 扩展到5个三级标题但缺少 level3_expansion_reasons[{parent_num!r}]；必须说明来源目标覆盖需要。")
            actual_numbers = [str(h.get("number", "")) for h in group]
            expected_numbers = [f"{parent_num}.{i}" for i in range(1, len(group) + 1)]
            if actual_numbers != expected_numbers:
                errors.append(f"第{cid}章 {parent_num} 三级标题编号必须从1开始连续：期望 {expected_numbers}，实际 {actual_numbers}。")

        if task_role == "technical-research" and chapter_technical_heading_count:
            expected_technology_endings = math.floor(0.40 * chapter_technical_heading_count + 0.5)
            expected_method_endings = chapter_technical_heading_count - expected_technology_endings
            if chapter_technology_ending_count != expected_technology_endings or chapter_method_ending_count != expected_method_endings:
                errors.append(
                    f"第{cid}章二、三级技术标题结尾分布应按最接近40%/60%的可整数化数量配置："
                    f"共{chapter_technical_heading_count}条时应为技术{expected_technology_endings}条、方法{expected_method_endings}条，"
                    f"实际为技术{chapter_technology_ending_count}条、方法{chapter_method_ending_count}条。"
                    "模型/算法可以写入 technical_signature 或标题中部，但正式技术研究标题不再以‘模型/算法’收尾。"
                )
            based_ratio = chapter_based_style_count / chapter_technical_heading_count
            if based_ratio < 0.40 - 1e-9:
                errors.append(
                    f"第{cid}章二、三级技术标题中‘基于……的……’句式占比为 {based_ratio:.1%} "
                    f"({chapter_based_style_count}/{chapter_technical_heading_count})，低于40%下限；"
                    "应保留具体 technical_signature，并将部分适合显化技术点的标题改为‘基于具体技术签名的……’句式。"
                )
            elif based_ratio > 0.60 + 1e-9:
                errors.append(
                    f"第{cid}章二、三级技术标题中‘基于……的……’句式占比为 {based_ratio:.1%} "
                    f"({chapter_based_style_count}/{chapter_technical_heading_count})，超过60%上限；"
                    "保留具体 technical_signature，将部分标题改为直接复合技术签名表达。"
                )

    # Parent-task role order.
    if task_orders:
        max_order = max(task_orders.values())
        if sorted(set(task_orders.values())) != list(range(1, max_order + 1)):
            errors.append(f"课题顺序不连续：{sorted(set(task_orders.values()))}。")
        for task_id, order in task_orders.items():
            expected_role = "engineering-implementation" if order == max_order else "technical-research"
            if task_roles.get(task_id) != expected_role:
                errors.append(
                    f"课题 {task_id} 顺序为 {order}，应标记为 {expected_role}，实际为 {task_roles.get(task_id)}。"
                )

    if not total_report_mode and source_orders and source_orders != list(range(1, len(tech) + 1)):
        errors.append(f"技术章顺序与研究内容小点原始顺序不一致：{source_orders}。")

    if total_report_mode and report_tasks:
        expected_task_ids = [str(task.get("task_id", "")).strip() for task in report_tasks]
        actual_task_ids = [str(chapter.get("parent_task_id", "")).strip() for chapter in tech]
        if actual_task_ids != expected_task_ids:
            errors.append(
                f"总报告技术章必须按课题原始顺序一一对应：期望 {expected_task_ids}，实际 {actual_task_ids}。"
            )


    if global_technical_heading_count:
        technology_ending_ratio = global_technology_ending_count / global_technical_heading_count
        if technology_ending_ratio < 0.35 - 1e-9 or technology_ending_ratio > 0.45 + 1e-9:
            errors.append(
                f"全文技术研究章二、三级技术标题以‘技术’结尾的比例为 {technology_ending_ratio:.1%} "
                f"({global_technology_ending_count}/{global_technical_heading_count})，应围绕40%目标控制在35%—45%的整数容差内；"
                "其余约60%应以‘方法’结尾。"
            )
        global_based_ratio = global_based_style_count / global_technical_heading_count
        if global_based_ratio < 0.40 - 1e-9:
            errors.append(
                f"全文技术研究章二、三级技术标题中‘基于……的……’句式占比为 {global_based_ratio:.1%} "
                f"({global_based_style_count}/{global_technical_heading_count})，低于40%下限。"
            )
        elif global_based_ratio > 0.60 + 1e-9:
            errors.append(
                f"全文技术研究章二、三级技术标题中‘基于……的……’句式占比为 {global_based_ratio:.1%} "
                f"({global_based_style_count}/{global_technical_heading_count})，超过60%上限。"
            )

    if not total_core_titles and tech:
        errors.append("未找到可校验的技术章核心二级标题。")

    if not data.get("references_required", False):
        errors.append("目录必须设置参考文献。")

    for warning in warnings:
        print("WARNING:", warning)
    for error in errors:
        print("ERROR:", error)
    print(("校验失败" if errors else "校验通过") + f"：{len(errors)} 个错误，{len(warnings)} 个警告。")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
