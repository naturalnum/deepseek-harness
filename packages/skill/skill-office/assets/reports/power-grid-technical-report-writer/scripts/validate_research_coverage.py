#!/usr/bin/env python3
"""Validate task-role-aware research-content coverage mappings.

Modes:
- outline: every technical source item must be mapped to a research point, parent task,
  chapter, and section; default three in-chapter research subpoints with source-grounded 4-5 expansion, power-title ratio,
  assessment-indicator body coverage, and role-specific title traceability are checked.
- final: every technical source item must be confirmed, covered by appendix, or explicitly
  not applicable.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from title_specificity import (
    family_level_technology,
    heading_has_evaluation_term,
    heading_task_subject_has_power_signal,
)

TECHNICAL_SOURCE_TYPES = {
    "research-content", "schedule-plan", "assessment-requirement",
    "expected-output", "user-supplement",
}
FINAL_ALLOWED_TECHNICAL = {"confirmed", "covered-by-appendix", "not-applicable"}
MAJOR_SCHEDULE_ROLES = {"method", "implementation"}
TASK_CONCEPT_TERMS = {"机制", "建模", "体系", "定义"}
TECH_RESEARCH_HEADS = ("技术", "方法", "算法", "模型")
CORE_TECH_RESEARCH_HEADS = ("技术", "方法")
HEADING_SOURCE_TYPES = {"expected-output", "schedule-plan", "assessment-requirement"}
ENGINEERING_TERMS = {"系统", "平台", "架构", "模块", "组件", "接口", "部署", "集成", "应用", "服务", "测试", "验证", "工程"}
DANGLING_SUFFIXES = ("的", "与", "及", "和", "基于", "面向", "针对", "通过", "利用", "用于")
ACTION_PREFIXES = ("研究", "开展", "研发", "构建", "建立", "提出", "实现", "提升", "解决", "评估", "定义")
GENERIC = {"关键技术", "核心方法", "技术实现", "模型研究", "技术研究", "方法研究", "数据处理", "模型训练", "参数设置", "模块设计", "总体体系", "综合机制"}
POWER_TERMS = {
    "电力", "电网", "配电", "输电", "调度", "潮流", "变压器", "线路", "机组",
    "新能源", "储能", "负荷", "保护", "运行", "故障", "设备", "电压", "功率", "运检",
}
AI_TERMS = {
    "人工智能", "知识", "图谱", "语义", "表征", "本体", "抽取", "对齐", "生成式",
    "大模型", "小模型", "机器学习", "深度学习", "强化学习", "神经网络", "智能体",
    "推理", "检索", "置信", "价值对齐", "智能决策", "策略生成", "智能服务", "模型协同",
    "Transformer", "图Transformer", "图对比学习", "增量图学习", "神经符号推理",
    "贝叶斯", "马尔科夫", "扩散模型", "状态空间", "神经算子", "混合检索", "RAG", "混合专家", "元学习", "数字孪生", "多智能体",
}
INNOVATION_TERMS = {
    "约束", "融合", "增强", "协同", "对齐", "感知", "驱动", "自适应", "演化", "趋优",
    "校准", "校核", "增量", "冲突消解", "回退", "闭环", "编排", "统一", "迁移", "集成", "适配",
    "Transformer", "图对比", "神经符号", "贝叶斯", "马尔科夫", "扩散模型", "状态空间",
    "神经算子", "多智能体", "混合专家", "元学习", "数字孪生", "分布鲁棒", "变分推断", "检索增强", "混合检索", "RAG",
}
GENERIC_COMPUTING_TECH = {
    "人工智能", "机器学习", "深度学习", "神经网络", "大模型", "优化算法", "智能分析",
    "数据驱动", "智能算法", "预测模型", "分类模型", "通用模型", "算法模型",
}
ALLOWED_NOMINALIZATION_CHARS = set(
    "技术方法算法模型系统平台架构模块组件接口部署集成应用服务流程研究构建分析验证的与及和"
)
SUSPICIOUS_ADDED_TERMS = {
    "基于", "融合", "协同", "增强", "可信", "自适应", "智能", "创新", "先进", "领先",
    "多模态", "闭环", "优化", "安全", "高效", "精准",
}


def has_any(text: str, terms: set[str]) -> bool:
    return any(term in text for term in terms)


def norm(text: str) -> str:
    return re.sub(r"\s+", "", text)


def semantic_chars(text: str) -> set[str]:
    return {ch.lower() for ch in text if ch.isalnum() or "\u4e00" <= ch <= "\u9fff"}

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
    extra_chars = sorted(semantic_chars(title_norm) - (semantic_chars(original_norm) | ALLOWED_NOMINALIZATION_CHARS))
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



def validate_role_title(
    errors: list[str], label: str, title: str, role: str, *, core: bool = False, report_theme_type: str = "non-evaluation"
) -> None:
    if title in GENERIC or (core and len(title) < 10):
        errors.append(f"{label}标题信息不足：{title}")
    if title.startswith(ACTION_PREFIXES) or incomplete_title(title):
        errors.append(f"{label}标题关系不完整或存在并列拼接：{title}")
    if report_theme_type == "non-evaluation" and core and heading_has_evaluation_term(title):
        errors.append(f"{label}非评估主题的二、三级技术目录不得出现验证、评估、评价、测试、试验、实验等章节词：{title}")
    if role == "technical-research":
        center_term = task_concept_as_title_center(title)
        if center_term:
            errors.append(f"{label}把任务性概念“{center_term}”作为标题中心或机械改名：{title}")
        allowed_heads = CORE_TECH_RESEARCH_HEADS if core else TECH_RESEARCH_HEADS
        if not title.endswith(allowed_heads):
            if core:
                errors.append(f"{label}二、三级技术研究标题应以“技术”或“方法”收束，并按约40%技术、60%方法统筹：{title}")
            else:
                errors.append(f"{label}技术研究一级章标题应直接落到技术、方法、算法或模型：{title}")
    elif role == "engineering-implementation":
        if not has_any(title, ENGINEERING_TERMS):
            errors.append(f"{label}工程实现标题未体现系统、平台、架构、模块、接口、部署、集成或应用：{title}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("coverage", type=Path)
    parser.add_argument("--mode", choices=["outline", "final"], default="outline")
    args = parser.parse_args()

    data = json.loads(args.coverage.read_text(encoding="utf-8"))
    report_theme_type = str(data.get("report_theme_type", "")).strip()
    points = {x["id"]: x for x in data.get("primary_research_points", [])}
    items = {x["id"]: x for x in data.get("source_items", [])}
    mappings = data.get("chapter_mappings", [])
    errors: list[str] = []
    warnings: list[str] = []

    if report_theme_type not in {"evaluation-related", "non-evaluation"}:
        errors.append("research-content-coverage 必须声明 report_theme_type=evaluation-related 或 non-evaluation。")

    orders = [point.get("source_order") for point in points.values()]
    if any(not isinstance(x, int) or x < 1 for x in orders):
        errors.append("研究内容小点缺少有效 source_order。")
    elif sorted(orders) != list(range(1, len(points) + 1)):
        errors.append(f"研究内容小点 source_order 不连续或重复：{orders}")

    task_roles: dict[str, str] = {}
    task_orders: dict[str, int] = {}
    for pid, point in points.items():
        task_id = str(point.get("parent_task_id", ""))
        task_order = point.get("parent_task_order")
        role = str(point.get("task_role", ""))
        if not task_id:
            errors.append(f"研究内容小点 {pid} 缺少 parent_task_id")
        if not isinstance(task_order, int) or task_order < 1:
            errors.append(f"研究内容小点 {pid} 缺少有效 parent_task_order")
        if role not in {"technical-research", "engineering-implementation"}:
            errors.append(f"研究内容小点 {pid} 缺少有效 task_role")
        if task_id:
            if task_id in task_roles and task_roles[task_id] != role:
                errors.append(f"课题 {task_id} 的 task_role 不一致")
            task_roles[task_id] = role
            if isinstance(task_order, int):
                if task_id in task_orders and task_orders[task_id] != task_order:
                    errors.append(f"课题 {task_id} 的 parent_task_order 不一致")
                task_orders[task_id] = task_order
        title = str(point.get("chapter_technology", ""))
        validate_role_title(errors, f"研究内容小点 {pid} 的章", title, role, report_theme_type=report_theme_type)
        if not point.get("source_keywords"):
            errors.append(f"研究内容小点 {pid} 缺少 source_keywords")
        if not point.get("expected_capability"):
            errors.append(f"研究内容小点 {pid} 缺少 expected_capability")

    if task_orders:
        max_order = max(task_orders.values())
        if sorted(set(task_orders.values())) != list(range(1, max_order + 1)):
            errors.append(f"课题顺序不连续：{sorted(set(task_orders.values()))}")
        for task_id, order in task_orders.items():
            expected = "engineering-implementation" if order == max_order else "technical-research"
            if task_roles.get(task_id) != expected:
                errors.append(f"课题 {task_id} 顺序为 {order}，应标记为 {expected}，实际为 {task_roles.get(task_id)}")

    mappings_by_point: dict[str, list[dict]] = {}
    mappings_by_chapter: dict[str, list[dict]] = {}
    for mapping in mappings:
        mappings_by_point.setdefault(mapping.get("research_point_id", ""), []).append(mapping)
        mappings_by_chapter.setdefault(mapping.get("chapter_id", ""), []).append(mapping)

    if len(mappings) != len(points):
        errors.append(f"研究内容小点与技术章必须一一对应；小点数={len(points)}，映射数={len(mappings)}")

    for pid, point in points.items():
        point_mappings = mappings_by_point.get(pid, [])
        if not point_mappings:
            errors.append(f"研究内容小点 {pid} 未映射到技术章：{point.get('source_summary', '')}")
            continue
        if len(point_mappings) > 1:
            errors.append(f"研究内容小点 {pid} 被拆分到多个技术章")
        planned = point.get("planned_chapter_id", "")
        if planned and planned not in {x.get("chapter_id") for x in point_mappings}:
            errors.append(f"研究内容小点 {pid} 的 planned_chapter_id={planned} 与章节映射不一致")

    for chapter_id, chapter_maps in mappings_by_chapter.items():
        point_ids = {x.get("research_point_id") for x in chapter_maps}
        if chapter_id and len(point_ids) > 1:
            errors.append(f"技术章 {chapter_id} 合并了多个研究内容小点")

    mapping_orders = [m.get("source_order") for m in sorted(mappings, key=lambda x: int(x.get("chapter_id") or 0))]
    if all(isinstance(x, int) for x in mapping_orders):
        if mapping_orders != sorted(mapping_orders):
            errors.append(f"技术章顺序未跟随研究内容小点顺序：{mapping_orders}")
    else:
        errors.append("章节映射缺少有效 source_order")

    mapped_item_ids: set[str] = set()
    core_item_ids: set[str] = set()
    total_core_titles = 0
    assessment_plan_ids: set[str] = set()
    for mapping in mappings:
        pid = mapping.get("research_point_id", "")
        if pid not in points:
            errors.append(f"章节映射引用未知研究点：{pid}")
            continue
        point = points[pid]
        task_id = str(mapping.get("parent_task_id", ""))
        role = str(mapping.get("task_role", ""))
        if task_id != point.get("parent_task_id"):
            errors.append(f"研究点 {pid} 的章节映射 parent_task_id 与来源不一致")
        if mapping.get("parent_task_order") != point.get("parent_task_order"):
            errors.append(f"研究点 {pid} 的章节映射 parent_task_order 与来源不一致")
        if role != point.get("task_role"):
            errors.append(f"研究点 {pid} 的章节映射 task_role 与来源不一致")
        if mapping.get("source_order") != point.get("source_order"):
            errors.append(f"研究点 {pid} 的章节 source_order 与来源顺序不一致")
        if not mapping.get("chapter_technology"):
            errors.append(f"研究点 {pid} 缺少具体章节技术")
        if not mapping.get("research_status_topic"):
            errors.append(f"研究内容小点 {pid} 缺少第一章1.2国内外研究现状对应技术类别")

        validation_mode = str(mapping.get("standalone_validation_mode", "none")).strip() or "none"
        if validation_mode not in {"none", "large-data", "user-requested"}:
            errors.append(f"研究点 {pid} 的 standalone_validation_mode 无效：{validation_mode}")
        if report_theme_type == "non-evaluation" and validation_mode != "none":
            errors.append(f"研究点 {pid} 属于非评估主题，standalone_validation_mode 必须为 none；考核/测试要求应转写为技术约束、性能边界或正文证据。")
        if report_theme_type == "evaluation-related" and validation_mode in {"large-data", "user-requested"} and not str(mapping.get("standalone_validation_reason", "")).strip():
            errors.append(f"研究点 {pid} 启用独立验证例外但缺少 standalone_validation_reason")

        chapter_title = str(mapping.get("chapter_title", ""))
        approved_title = str(point.get("chapter_technology", ""))
        if not chapter_title:
            errors.append(f"研究内容小点 {pid} 缺少 chapter_title")
        elif chapter_title != approved_title:
            errors.append(f"研究内容小点 {pid} 的章标题必须与已确认标题一致：{approved_title!r}，实际 {chapter_title!r}")
        validate_role_title(errors, f"研究内容小点 {pid} 的章", chapter_title, role, report_theme_type=report_theme_type)
        source_title = str(point.get("source_summary", ""))
        if source_title and chapter_title:
            added_info = title_added_information(source_title, chapter_title)
            if added_info:
                errors.append(f"研究内容小点 {pid} 的章标题疑似增加原文没有的信息：{', '.join(added_info)}")
        if not str(mapping.get("title_alignment_basis", "")).strip():
            errors.append(f"研究内容小点 {pid} 缺少 title_alignment_basis")
        expected_chapter = str(int(point.get("source_order", 0)) + 1)
        if str(mapping.get("chapter_id", "")) != expected_chapter:
            errors.append(f"研究内容小点 {pid} 应映射到第{expected_chapter}章，实际为第{mapping.get('chapter_id')}章")

        for item_id in mapping.get("source_item_ids", []):
            mapped_item_ids.add(item_id)
            if item_id not in items:
                errors.append(f"章节映射引用未知事项：{item_id}")
            else:
                item = items[item_id]
                if item.get("research_point_id") != pid:
                    errors.append(f"章节映射 {pid} 混入其他研究点事项：{item_id}")
                if item.get("parent_task_id") != task_id:
                    errors.append(f"章节映射 {pid} 混入其他课题事项：{item_id}")

        plans = mapping.get("innovation_title_plans", [])
        plan_count = len(plans)
        declared_count = mapping.get("core_section_count", 3)
        expansion_reason = str(mapping.get("core_section_expansion_reason", "")).strip()
        if plan_count < 3 or plan_count > 5:
            errors.append(f"研究点 {pid} 核心二级标题默认3个，必要时最多扩展到5个；实际为 {plan_count} 个")
        if declared_count != plan_count:
            errors.append(f"研究点 {pid} core_section_count 与实际计划数不一致：声明 {declared_count}，实际 {plan_count}")
        if plan_count > 3 and not expansion_reason:
            errors.append(f"研究点 {pid} 扩展到{plan_count}个核心二级标题但缺少 core_section_expansion_reason；必须说明无法合理归并的预期目标/进度技术点")
        expected_sections = [f"{mapping.get('chapter_id')}.{i}" for i in range(1, plan_count + 1)]
        actual_sections = [str(plan.get("section_number", "")) for plan in plans]
        if actual_sections != expected_sections:
            errors.append(f"研究点 {pid} 核心标题编号必须连续为 {expected_sections}，实际为 {actual_sections}")
        for idx, plan in enumerate(plans, 1):
            title = str(plan.get("title", ""))
            section = str(plan.get("section_number", "?"))
            validate_role_title(errors, f"研究点 {pid} 的核心标题 {section} ", title, role, core=True, report_theme_type=report_theme_type)
            if role == "technical-research" and not heading_task_subject_has_power_signal(title, str(plan.get("technical_signature", ""))):
                errors.append(
                    f"研究点 {pid} 的核心二级标题 {section} 主语缺少独立电力语义：{title}；“的”之后完整部分视为主语，主语本身必须含电网/调度/设备/负荷等强电力词。"
                )
            total_core_titles += 1
            if plan.get("research_subpoint_index") != idx:
                errors.append(f"研究点 {pid} 的核心标题 {section} research_subpoint_index 应为 {idx}，实际为 {plan.get('research_subpoint_index')}")
            if not str(plan.get("derivation_basis", "")).strip():
                errors.append(f"研究点 {pid} 的核心标题 {section} 缺少 derivation_basis")
            power_element = str(plan.get("power_element", "")).strip()
            if power_element and not component_visible(power_element, title, 0.45):
                errors.append(f"研究点 {pid} 的核心标题 {section} 未充分体现电力对象或约束：{power_element}")
            if plan.get("parent_task_id") != task_id:
                errors.append(f"研究点 {pid} 的核心标题 {section} 未正确关联课题 {task_id}")
            for field in (
                "power_element", "technical_object",
                "technical_method", "technical_role", "specificity_basis",
                "specific_computing_technology", "technology_specificity_basis", "technology_origin",
                "shared_chapter_question", "chain_order", "chain_role", "depends_on_previous",
            ):
                value = plan.get(field)
                if isinstance(value, str):
                    missing = not value.strip()
                else:
                    missing = value is None
                if missing:
                    errors.append(f"研究点 {pid} 的核心标题 {section} 缺少 {field}")
            specific_tech = str(plan.get("specific_computing_technology", "")).strip()
            technical_signature = str(plan.get("technical_signature", "")).strip()
            if specific_tech:
                family_issue = family_level_technology(
                    specific_tech,
                    role=str(plan.get("technical_role", "")),
                    power_element=power_element,
                )
                if specific_tech in GENERIC_COMPUTING_TECH or family_issue:
                    errors.append(
                        f"研究点 {pid} 的核心标题 {section} 具体计算机技术过于宽泛，仍停留在技术族/上位概念："
                        f"{specific_tech}；应继续细化到具体变体、结构、关键机制、约束或组合方式。"
                    )
                elif technical_signature and not component_visible(technical_signature, title, 0.55):
                    errors.append(f"研究点 {pid} 的核心标题 {section} 未显式体现中文语义技术签名：{technical_signature}")
            origin = str(plan.get("technology_origin", "")).strip()
            if origin and origin not in {"source_confirmed", "model_suggested", "user_confirmed_design"}:
                errors.append(f"研究点 {pid} 的核心标题 {section} technology_origin 无效：{origin}")
            if plan.get("chain_order") != idx:
                errors.append(f"研究点 {pid} 的核心标题 {section} chain_order 应为 {idx}")
            if idx == 1:
                if plan.get("depends_on_previous") is not False:
                    errors.append(f"研究点 {pid} 的核心标题 {section} X.1 depends_on_previous 必须为 false")
                if not str(plan.get("output_to_next", "")).strip():
                    errors.append(f"研究点 {pid} 的核心标题 {section} 缺少 output_to_next")
            else:
                if plan.get("depends_on_previous") is not True:
                    errors.append(f"研究点 {pid} 的核心标题 {section} depends_on_previous 必须为 true")
                if not str(plan.get("handoff_from_previous", "")).strip():
                    errors.append(f"研究点 {pid} 的核心标题 {section} 缺少 handoff_from_previous")
                if idx < plan_count and not str(plan.get("output_to_next", "")).strip():
                    errors.append(f"研究点 {pid} 的核心标题 {section} 缺少 output_to_next")
            obj = norm(str(plan.get("technical_object", "")))
            method = norm(str(plan.get("technical_method", "")))
            tnorm = norm(title)
            if obj and not component_visible(obj, tnorm, 0.5):
                errors.append(f"研究点 {pid} 的核心标题 {section} 未充分体现技术对象：{obj}")
            method_marker = technical_signature or method
            if method_marker and not component_visible(method_marker, tnorm, 0.55):
                errors.append(f"研究点 {pid} 的核心标题 {section} 未充分体现技术方法/中文语义技术签名：{method_marker}")
            source_ids = plan.get("source_item_ids", [])
            if not source_ids:
                errors.append(f"研究点 {pid} 的核心标题 {section} 未关联来源事项")
            for item_id in source_ids:
                core_item_ids.add(item_id)
                if item_id not in items:
                    errors.append(f"核心标题 {section} 引用未知来源事项：{item_id}")
                else:
                    item = items[item_id]
                    if item.get("research_point_id") != pid:
                        errors.append(f"核心标题 {section} 混入其他研究点事项：{item_id}")
                    if item.get("parent_task_id") != task_id:
                        errors.append(f"核心标题 {section} 混入其他课题事项：{item_id}")

        shared_questions = {
            str(plan.get("shared_chapter_question", "")).strip() for plan in plans
            if str(plan.get("shared_chapter_question", "")).strip()
        }
        if len(shared_questions) != 1:
            errors.append(f"研究点 {pid} 的全部核心标题必须共享同一个 shared_chapter_question，实际为 {sorted(shared_questions)}")

        heading_term_plans = mapping.get("heading_source_term_plan", [])
        if not isinstance(heading_term_plans, list) or not heading_term_plans:
            errors.append(f"研究点 {pid} 缺少 heading_source_term_plan，无法证明预期目标、进度计划和考核要求中的关键技术词已分散进入二、三级标题")
            heading_term_plans = []
        planned_source_ids: set[str] = set()
        target_branches: set[str] = set()
        for hp in heading_term_plans:
            sid = str(hp.get("source_item_id", "")).strip()
            stype = str(hp.get("source_type", "")).strip()
            term = str(hp.get("term", "")).strip()
            granularity = str(hp.get("granularity", "")).strip()
            number = str(hp.get("target_heading_number", "")).strip()
            target_title = str(hp.get("target_heading_title", "")).strip()
            if not all((sid, stype, term, granularity, number, target_title)):
                errors.append(f"研究点 {pid} 的 heading_source_term_plan 存在空字段：{hp}")
                continue
            planned_source_ids.add(sid)
            if sid not in items:
                errors.append(f"研究点 {pid} 的标题技术词计划引用未知来源事项：{sid}")
            else:
                item = items[sid]
                if item.get("research_point_id") != pid or item.get("parent_task_id") != task_id:
                    errors.append(f"研究点 {pid} 的标题技术词计划混入其他课题/研究点事项：{sid}")
                if stype != item.get("source_type") or stype not in HEADING_SOURCE_TYPES:
                    errors.append(f"研究点 {pid} 的标题技术词计划 {sid} source_type 不一致或无效：{stype}")
            if norm(term) not in norm(target_title):
                errors.append(f"研究点 {pid} 的关键技术词“{term}”未直接出现在目标标题 {number}：{target_title}")
            parts = number.split('.')
            level = len(parts)
            if granularity == "broad" and level != 2:
                errors.append(f"研究点 {pid} 的概括性技术词“{term}”应落二级标题，实际目标为 {number}")
            if granularity == "narrow" and level != 3:
                errors.append(f"研究点 {pid} 的窄技术点“{term}”应落三级标题，实际目标为 {number}")
            if level >= 2:
                target_branches.add('.'.join(parts[:2]))
            if report_theme_type == "non-evaluation" and heading_has_evaluation_term(target_title):
                errors.append(f"研究点 {pid} 的非评估主题标题技术词计划仍生成验证/评估/测试/实验类标题：{number} {target_title}")
        required_heading_sources = {
            item_id for item_id in mapping.get("source_item_ids", [])
            if item_id in items and items[item_id].get("source_type") in HEADING_SOURCE_TYPES
        }
        missing_heading_sources = required_heading_sources - planned_source_ids
        if missing_heading_sources:
            errors.append(f"研究点 {pid} 的预期目标/进度计划/考核要求技术事项未全部建立标题技术词映射：{sorted(missing_heading_sources)}")
        if len(heading_term_plans) >= 3 and len(target_branches) < 2:
            errors.append(f"研究点 {pid} 的关键技术词过度集中在单一二级分支，应在不破坏目录逻辑前提下分散到至少两个X.1—X.N分支")

        assessment_plans = mapping.get("assessment_coverage_plans", [])
        if not isinstance(assessment_plans, list):
            errors.append(f"研究点 {pid} 的 assessment_coverage_plans 必须为数组")
            assessment_plans = []
        for ap in assessment_plans:
            aid = str(ap.get("assessment_item_id", "")).strip()
            if not aid:
                errors.append(f"研究点 {pid} 存在缺少 assessment_item_id 的考核覆盖计划")
                continue
            assessment_plan_ids.add(aid)
            if aid not in items:
                errors.append(f"研究点 {pid} 的考核覆盖计划引用未知事项：{aid}")
            else:
                item = items[aid]
                if item.get("source_type") != "assessment-requirement":
                    errors.append(f"研究点 {pid} 的考核覆盖计划 {aid} 不是 assessment-requirement")
                if item.get("research_point_id") != pid:
                    errors.append(f"研究点 {pid} 的考核覆盖计划混入其他研究点指标：{aid}")
                if item.get("parent_task_id") != task_id:
                    errors.append(f"研究点 {pid} 的考核覆盖计划混入其他课题指标：{aid}")
            for field in ("planned_section", "content_form", "prose_realization", "evidence_status"):
                if not str(ap.get(field, "")).strip():
                    errors.append(f"研究点 {pid} 的内部技术要求 {aid} 缺少 {field}")
            if ap.get("source_identity_hidden") is not True:
                errors.append(f"研究点 {pid} 的内部技术要求 {aid} 必须设置 source_identity_hidden=true")
            chapter_id = str(mapping.get("chapter_id"))
            planned_section = str(ap.get("planned_section", ""))
            if not planned_section.startswith((f"{chapter_id}.1", f"{chapter_id}.2", f"{chapter_id}.3")):
                errors.append(f"研究点 {pid} 的内部技术要求 {aid} 必须融入X.1—X.N正文：{planned_section}")
            evidence_section = str(ap.get("evidence_section", "")).strip()
            if evidence_section and not evidence_section.startswith(f"{chapter_id}."):
                errors.append(f"研究点 {pid} 的内部技术要求 {aid} 可选证据位置不属于本章：{evidence_section}")
            if "validation_section" in ap:
                errors.append(f"研究点 {pid} 的内部技术要求 {aid} 仍使用已废弃字段 validation_section")

    for item_id, item in items.items():
        source_type = item.get("source_type")
        status = item.get("coverage_status")
        technical = source_type in TECHNICAL_SOURCE_TYPES
        if technical:
            pid = item.get("research_point_id")
            if not pid or pid not in points:
                errors.append(f"技术事项 {item_id} 未分配有效研究点")
            else:
                point = points[pid]
                if item.get("parent_task_id") != point.get("parent_task_id"):
                    errors.append(f"技术事项 {item_id} 的 parent_task_id 与研究点不一致")
                if item.get("task_role") != point.get("task_role"):
                    errors.append(f"技术事项 {item_id} 的 task_role 与研究点不一致")
            if item_id not in mapped_item_ids:
                errors.append(f"技术事项 {item_id} 未进入任何章节映射")
            point_chapters = {x.get("chapter_id") for x in mappings_by_point.get(pid, [])}
            planned_chapter = item.get("planned_chapter_id", "")
            if planned_chapter and point_chapters and planned_chapter not in point_chapters:
                errors.append(f"技术事项 {item_id} 的计划章节 {planned_chapter} 与研究点章节映射不一致")

            if source_type == "schedule-plan" and item.get("content_role") in MAJOR_SCHEDULE_ROLES:
                if item_id not in core_item_ids:
                    errors.append(f"进度计划主要技术事项 {item_id} 未进入任何核心二级标题计划")

            if source_type == "assessment-requirement":
                if item_id not in assessment_plan_ids:
                    errors.append(f"内部技术要求 {item_id} 未建立所属技术章正文隐性覆盖计划")
                for field in ("assessment_name", "planned_section", "content_form", "prose_realization", "evidence_status"):
                    if not str(item.get(field, "")).strip():
                        errors.append(f"内部技术要求 {item_id} 缺少 {field}")
                if item.get("source_identity_hidden") is not True:
                    errors.append(f"内部技术要求 {item_id} 必须设置 source_identity_hidden=true")
                chapter_id = str(item.get("planned_chapter_id", ""))
                planned_section = str(item.get("planned_section", ""))
                if chapter_id and not planned_section.startswith((f"{chapter_id}.1", f"{chapter_id}.2", f"{chapter_id}.3")):
                    errors.append(f"内部技术要求 {item_id} 必须融入所属章X.1—X.N正文：{planned_section}")
                if "validation_section" in item:
                    errors.append(f"内部技术要求 {item_id} 仍使用已废弃字段 validation_section")
                if item.get("coverage_status") == "covered-by-appendix":
                    errors.append(f"内部技术要求 {item_id} 不能只通过附录覆盖，必须进入所属技术章正文")

            if args.mode == "outline":
                if not item.get("planned_chapter_id"):
                    errors.append(f"技术事项 {item_id} 缺少计划章节")
                if not item.get("planned_section"):
                    errors.append(f"技术事项 {item_id} 缺少计划小节")
                if status == "unmapped":
                    errors.append(f"技术事项 {item_id} 仍为 unmapped")
            else:
                if status not in FINAL_ALLOWED_TECHNICAL:
                    errors.append(f"技术事项 {item_id} 最终状态不完整：{status}")
                if status == "confirmed" and not item.get("confirmed_location"):
                    errors.append(f"技术事项 {item_id} 已标记 confirmed，但缺少正文位置")
                if source_type == "assessment-requirement" and status == "confirmed" and not item.get("confirmed_location"):
                    errors.append(f"内部技术要求 {item_id} 最终必须记录所属技术章正文位置")
                if status == "not-applicable" and not item.get("notes"):
                    warnings.append(f"技术事项 {item_id} 标记 not-applicable，建议记录原因")
        elif source_type == "administrative" and status != "administrative":
            warnings.append(f"行政事项 {item_id} 建议标记为 administrative")

    if mappings and not total_core_titles:
        errors.append("未找到可校验的核心二级标题")

    summary = data.get("coverage_summary", {})
    if summary.get("total_items") != len(items):
        errors.append(f"coverage_summary.total_items={summary.get('total_items')} 与实际事项数 {len(items)} 不一致")
    mapped_count = sum(1 for item_id in items if item_id in mapped_item_ids)
    if summary.get("mapped_items") != mapped_count:
        warnings.append(f"coverage_summary.mapped_items={summary.get('mapped_items')}，实际映射事项数为 {mapped_count}")

    if errors:
        print(f"研究内容覆盖校验失败（{args.mode}）：{len(errors)} 个错误，{len(warnings)} 个警告。")
        for error in errors:
            print(f"ERROR: {error}")
        for warning in warnings:
            print(f"WARNING: {warning}")
        return 1

    print(f"研究内容覆盖校验通过（{args.mode}）：{len(points)} 个研究内容小点，{len(items)} 个来源事项，{len(warnings)} 个警告。")
    for warning in warnings:
        print(f"WARNING: {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
