#!/usr/bin/env python3
"""Cross-skill consistency audit for the v1.1.31 active rule baseline.

Historical changelogs/release notes are intentionally excluded. This validator checks
only files that can affect runtime behavior or current user-facing skill instructions.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ORCHESTRATOR_ROOT = Path(__file__).resolve().parents[1]
SKILLS_ROOT = ORCHESTRATOR_ROOT.parent
ROOT = SKILLS_ROOT
GEN = SKILLS_ROOT / "power-grid-technical-report-writer"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def active_generator_files():
    for base in [GEN / "stages", GEN / "references", GEN / "templates", GEN / "schemas", GEN / "examples", GEN / "compiled-packs"]:
        for p in base.rglob("*"):
            if not p.is_file() or p.suffix.lower() not in {".md", ".json"}:
                continue
            if p.name in {"CHANGELOG.md", "current-rule-baseline.md", "compile-report.json"}:
                continue
            if "rule-migration-manifest" in p.name or "runtime-pack-manifest" in p.name:
                continue
            yield p
    yield GEN / "SKILL.md"
    yield GEN / "README.md"


def main() -> int:
    errors: list[str] = []
    registry = json.loads(read(ORCHESTRATOR_ROOT / "skill-registry.json"))

    # 1) One title-length limit throughout the suite.
    if registry.get("workflow", {}).get("max_outline_title_chars") != 25:
        errors.append("skill-registry.json: max_outline_title_chars 必须统一为25")
    workflow_cfg = registry.get("workflow", {})
    if workflow_cfg.get("enforce_based_on_heading_ratio_gate") is not True:
        errors.append("skill-registry.json: 必须启用目录‘基于……的……’比例硬门禁")
    if workflow_cfg.get("enforce_power_domain_heading_gate") is not True:
        errors.append("skill-registry.json: 必须启用二三级技术标题电力领域语义独立门禁")
    if workflow_cfg.get("enforce_level3_task_subject_uniqueness_gate") is not True:
        errors.append("skill-registry.json: 必须启用同章三级技术标题任务主语唯一性门禁")
    for flag, label in [
        ("enforce_level2_subject_power_gate", "二级标题任务主语电力语义"),
        ("enforce_non_evaluation_heading_gate", "非评估主题目录禁词"),
        ("enforce_heading_source_term_gate", "任务书关键技术词标题映射"),
        ("enforce_heading_ending_distribution_gate", "技术/方法标题结尾分布"),
    ]:
        if workflow_cfg.get(flag) is not True:
            errors.append(f"skill-registry.json: 必须启用{label}硬门禁")
    ratio_expectations = {
        "heading_technology_ending_target_ratio": 0.40,
        "heading_method_ending_target_ratio": 0.60,
        "heading_technology_ending_report_min_ratio": 0.35,
        "heading_technology_ending_report_max_ratio": 0.45,
    }
    for key, expected in ratio_expectations.items():
        if float(workflow_cfg.get(key, -1)) != expected:
            errors.append(f"skill-registry.json: {key} 必须统一为 {expected}")
    if float(workflow_cfg.get("based_on_heading_ratio_min", -1)) != 0.40 or float(workflow_cfg.get("based_on_heading_ratio_max", -1)) != 0.60:
        errors.append("skill-registry.json: ‘基于……的……’比例必须统一为40%—60%")
    cross_files = [
        ORCHESTRATOR_ROOT / "scripts" / "workflow_engine.py",
        ORCHESTRATOR_ROOT / "scripts" / "report_text_utils.py",
        ORCHESTRATOR_ROOT / "SKILL.md",
        SKILLS_ROOT / "report-reviewer" / "SKILL.md",
        GEN / "scripts" / "report_text_utils.py",
    ]
    old_30 = re.compile(r"(?:目录|标题).{0,30}(?:30个|30 个)(?:可见)?字符|缩短到30个字符", re.S)
    for p in cross_files:
        if old_30.search(read(p)):
            errors.append(f"{p.relative_to(ROOT)}: 仍含旧30字符目录标题规则")

    # 2) Active generator rules must not carry superseded title metadata/ratio/numbering/drawing rules.
    forbidden = [
        (re.compile(r"至少\s*60%.*(?:电力|核心标题)|不低于\s*60%|minimum_explicit_power_term_ratio|core_level2_power_title_ratio"), "旧60%电力词比例"),
        (re.compile(r"\bai_element\b|\binnovation_method\b"), "旧标题元数据字段"),
        (re.compile(r"X\.3\s*章内研究小点一|X\.4\s*章内研究小点二|X\.5\s*章内研究小点三"), "旧X.3/X.4/X.5核心研究点编号"),
        (re.compile(r"初步绘图\s*Prompt|初版生成结构化图表占位和初步\s*Prompt"), "旧绘图Prompt规则"),
        (re.compile(r"[“\"]机制[”\"]改为具体[“\"]技术[”\"]或[“\"]方法|[“\"]体系[”\"]改为.*[“\"]框架"), "旧标题机械替换规则"),
        (re.compile(r"机制、建模、体系、定义、评估"), "旧版将评估无条件列入任务中心禁用词"),
        (re.compile(r"只有(?:存在)?大量成体系数据或用户明确要求时.{0,50}(?:独立验证|验证类二级)", re.S), "旧版不区分报告主题的验证章节例外规则"),
    ]
    for p in active_generator_files():
        text = read(p)
        for pat, label in forbidden:
            if pat.search(text):
                errors.append(f"{p.relative_to(ROOT)}: {label}")

    # 3) Current technical-title rules must be structurally consolidated.
    title_path = GEN / "references" / "technical-title-naming.md"
    title = read(title_path)
    if title.count("## 6. 核心二级标题统一硬规则") != 1:
        errors.append("technical-title-naming.md: 核心二级标题统一硬规则必须且只能有一处")
    for stale in ["## 13. 核心二级标题的创新技术与承接链硬规则", "## 7. 核心标题逐项电力语义完整性"]:
        if stale in title:
            errors.append(f"technical-title-naming.md: 仍有重复/旧章节 {stale}")
    if "“框架”不作为技术研究标题的落脚点" not in title:
        errors.append("technical-title-naming.md: 缺少当前‘框架不作为技术研究标题落脚点’规则")
    if "技术变体/关键机制" not in title or "RAG/检索增强生成" not in title or "图神经网络/GNN" not in title:
        errors.append("technical-title-naming.md: 缺少v1.1.19技术签名级标题规则")
    if "40%—60%的双向硬门禁" not in title or "低于40%或高于60%均为硬性错误" not in title:
        errors.append("technical-title-naming.md: ‘基于……的……’必须实行40%—60%双向硬门禁")
    for required in [
        "report_theme_type=evaluation-related | non-evaluation",
        "二级标题主语必须独立带有电力相关词",
        "“的”之后的完整部分就是主语",
        "非评估主题不得生成验证、评估类二三级章节",
        "heading_source_term_plan",
        "概括性→二级、窄技术点→三级",
        "约40%“技术”、60%“方法”",
    ]:
        if required not in title:
            errors.append(f"technical-title-naming.md: 缺少v1.1.26目录规则 {required}")
    soft_lower = re.compile(r"不足40%不作为硬性错误|低于40%.{0,40}(?:不作为硬性错误|仅.*警告|warning)|低于30%.{0,40}(?:警告|warning)|可用于突出技术点但不是强制|不是强制模板", re.S | re.I)
    for p2 in active_generator_files():
        if soft_lower.search(read(p2)):
            errors.append(f"{p2.relative_to(ROOT)}: 仍含‘基于……的……’低比例软提示旧规则")
    orchestrator_utils = read(ORCHESTRATOR_ROOT / "scripts" / "report_text_utils.py")
    if "Technical L2/L3 headings may exceed the 25-character guideline" not in orchestrator_utils:
        errors.append("report-workflow-orchestrator/report_text_utils.py: 未实现技术签名/40%—60%比例优先于25字符门禁")
    orchestrator_engine = read(ORCHESTRATOR_ROOT / "scripts" / "workflow_engine.py")
    if "deterministic_based_on_heading_ratio_gate" not in orchestrator_engine or "_outline_based_on_ratio_gate(s, item, registry)" not in orchestrator_engine:
        errors.append("report-workflow-orchestrator/workflow_engine.py: 目录生成后未接入40%—60%比例确定性门禁")
    if "deterministic_power_domain_heading_gate" not in orchestrator_engine or "_outline_power_domain_gate(s, item, registry)" not in orchestrator_engine:
        errors.append("report-workflow-orchestrator/workflow_engine.py: 目录生成后未接入电力领域语义独立确定性门禁")
    new_gate_checks = [
        ("deterministic_level2_subject_power_gate", "_outline_level2_subject_power_gate(s, item, registry)", "二级标题任务主语电力语义"),
        ("deterministic_non_evaluation_heading_gate", "_outline_evaluation_theme_gate(s, item, registry)", "非评估主题目录禁词"),
        ("deterministic_heading_source_term_gate", "_outline_heading_source_term_gate(s, item, registry)", "任务书关键技术词标题映射"),
        ("deterministic_heading_ending_distribution_gate", "_outline_heading_ending_gate(s, item, registry)", "技术/方法标题结尾分布"),
    ]
    for marker, call, label in new_gate_checks:
        if marker not in orchestrator_engine or call not in orchestrator_engine:
            errors.append(f"report-workflow-orchestrator/workflow_engine.py: 目录生成后未接入{label}确定性门禁")
    stale_inheritance_patterns = [
        re.compile(r"上位(?:二级)?标题.{0,40}(?:已|已经).{0,30}(?:细粒度|具体技术).{0,50}(?:可以不|不必|非必要时不).{0,20}重复", re.S),
        re.compile(r"非必要时不重复上位标题中的细粒度技术名", re.S),
    ]
    for p in active_generator_files():
        text = read(p)
        if any(pat.search(text) for pat in stale_inheritance_patterns):
            errors.append(f"{p.relative_to(ROOT)}: 仍允许三级标题继承上位标题具体性")

    reviewer = read(SKILLS_ROOT / "report-reviewer" / "SKILL.md")
    if "technology_family_too_broad" not in reviewer or "technology_signature_not_visible" not in reviewer or "operation_level_heading" not in reviewer or "三级技术标题不得继承上位标题的具体性" not in reviewer:
        errors.append("report-reviewer/SKILL.md: 未同步技术签名/技术族/任务操作级标题审查规则")
    if "based_on_heading_ratio_out_of_range" not in reviewer or "40%—60%双向硬门禁" not in reviewer:
        errors.append("report-reviewer/SKILL.md: 未同步40%—60%标题句式比例审查")
    for issue in [
        "level2_subject_power_signal_missing",
        "non_evaluation_heading_policy_violation",
        "heading_source_term_coverage_missing",
        "heading_ending_distribution_mismatch",
    ]:
        if issue not in reviewer:
            errors.append(f"report-reviewer/SKILL.md: 未同步v1.1.26目录问题类型 {issue}")

    # v1.1.29: chapter-parent mainline logic correction + v1.1.28 metric allocation retained.
    coverage = read(GEN / "references" / "three-subpoint-and-indicator-coverage.md")
    for required in ["章节内容边界", "直接子问题", "4—5个核心二级标题", "分析正文最多选择2个指标", "最后一个技术章节", "不得复述“超过××、不低于××、小于××”"]:
        if required not in coverage:
            errors.append(f"three-subpoint-and-indicator-coverage.md: 缺少v1.1.28规则 {required}")
    summary_text_v128 = read(GEN / "references" / "chapter-summary.md")
    for required in ["正文中用中文引号", "每个X.i最多选择1个", "最后一个技术章节"]:
        if required not in summary_text_v128:
            errors.append(f"chapter-summary.md: 缺少v1.1.28小结规则 {required}")
    if "判断不采用“数据预处理、模型优化、系统实现、性能分析、应用分析”等词语黑名单" not in coverage:
        errors.append("three-subpoint-and-indicator-coverage.md: v1.1.29必须明确不采用通用词黑名单，而按一级—二级主线逻辑判断")
    if "chapter_mainline_map" not in title or "parent_logic_link" not in title:
        errors.append("technical-title-naming.md: 缺少v1.1.29 chapter_mainline_map / parent_logic_link 规则")
    if "该规则针对小结正文，不新增目录标题引号限制" not in reviewer:
        errors.append("report-reviewer/SKILL.md: 未明确v1.1.29引号规则只针对本章小结正文")
    result_rules = read(GEN / "references" / "result-analysis-generation.md")
    if "结果分析正文最多重点分析2个指标" not in result_rules:
        errors.append("result-analysis-generation.md: 缺少单实验最多重点分析2指标规则")
    for issue in [
        "chapter_parent_logic_mismatch",
        "future_chapter_scope_leak",
        "unnecessary_core_heading_expansion",
        "chapter_summary_unnecessary_quotes",
        "experiment_metric_analysis_overload",
        "chapter_summary_metric_overload",
        "hard_indicator_allocation_violation",
    ]:
        if issue not in reviewer:
            errors.append(f"report-reviewer/SKILL.md: 未同步v1.1.28问题类型 {issue}")

    # v1.1.30: outline technology options + abstract task-book assessment result priority.
    for key, expected in [
        ("enforce_outline_technology_option_gate", True),
        ("require_abstract_opening_candidates", True),
        ("require_abstract_assessment_result_metadata", True),
        ("require_qualitative_assessment_results", True),
    ]:
        if workflow_cfg.get(key) is not expected:
            errors.append(f"skill-registry.json: v1.1.30 必须设置 {key}={expected}")
    if workflow_cfg.get("outline_technology_option_min") != 2 or workflow_cfg.get("outline_technology_option_max") != 3:
        errors.append("skill-registry.json: 未锁定目录可选技术默认2—3个")
    if workflow_cfg.get("abstract_opening_candidate_min") != 3 or workflow_cfg.get("abstract_opening_candidate_max") != 5:
        errors.append("skill-registry.json: 未锁定摘要业务需求首句候选3—5个")
    if workflow_cfg.get("abstract_supplementary_metric_max") != 2:
        errors.append("skill-registry.json: 非任务书摘要补充指标上限必须为2")

    for required in ["technology_option_sets", "source_locked=true", "2—3个可选技术", "正式目录正文 + 可选技术方案"]:
        if required not in title:
            errors.append(f"technical-title-naming.md: 缺少v1.1.30可选技术规则 {required}")
    if "_outline_technology_option_gate(s, item, registry)" not in orchestrator_engine or "deterministic_technology_option_gate" not in orchestrator_engine:
        errors.append("report-workflow-orchestrator/workflow_engine.py: 未接入目录可选技术确定性门禁")
    generator_utils = read(GEN / "scripts" / "report_text_utils.py")
    if "outline_technology_option_violations" not in generator_utils:
        errors.append("power-grid-technical-report-writer/report_text_utils.py: 缺少可选技术结构校验")

    abstract_rules = read(GEN / "references" / "abstract-and-introduction.md")
    for required in [
        "3—5个业务需求背景首句候选",
        "task_book_assessment_results",
        "supplementary_result_metrics",
        "定性指标",
        "最多1—2个",
    ]:
        if required not in abstract_rules:
            errors.append(f"abstract-and-introduction.md: 缺少v1.1.30摘要规则 {required}")
    abstract_schema = json.loads(read(GEN / "schemas" / "abstract-evidence.schema.json"))
    abstract_required = set(abstract_schema.get("required", []))
    for field in ["business_need_opening_candidates", "selected_business_need_opening", "task_book_assessment_results", "supplementary_result_metrics"]:
        if field not in abstract_required:
            errors.append(f"abstract-evidence.schema.json: required 缺少 {field}")
    response_schema = read(GEN / "schemas" / "generator-response.schema.json")
    for field in ["opening_sentence_candidates_cn", "selected_opening_sentence_cn", "assessment_result_coverage", "supplementary_metrics_used"]:
        if field not in response_schema:
            errors.append(f"generator-response.schema.json: generate_abstract 缺少 {field}")
    for issue in [
        "technology_option_plan_missing_or_invalid",
        "technology_option_scope_mismatch",
        "abstract_opening_candidate_weak",
        "abstract_assessment_result_coverage_missing",
        "abstract_qualitative_assessment_result_missing",
        "abstract_supplementary_metric_overload",
    ]:
        if issue not in reviewer:
            errors.append(f"report-reviewer/SKILL.md: 未同步v1.1.30问题类型 {issue}")

    # v1.1.19: power-domain visibility and based-on surface form are independent hard constraints.
    if "电力语义显化与技术签名显化是并列的两个硬门禁" not in title:
        errors.append("technical-title-naming.md: 缺少电力语义+技术签名并列硬门禁")
    if "不能替代电力领域语义门禁" not in title:
        errors.append("technical-title-naming.md: 未明确‘基于……的……’不能替代电力领域语义")
    if "power_domain_signal_missing" not in reviewer:
        errors.append("report-reviewer/SKILL.md: 未同步电力领域语义缺失问题类型")

    # v1.1.19: formal technical L2/L3 headings use route-semantic Chinese technology names.
    if "不得直接裸露在二、三级技术标题中" not in title or "中文语义 technical_signature" not in title:
        errors.append("technical-title-naming.md: 缺少二三级技术标题中文语义技术名规则")
    if "english_technology_in_heading" not in reviewer:
        errors.append("report-reviewer/SKILL.md: 未同步英文技术名/缩写裸露问题类型")
    if "deterministic_chinese_technology_heading_gate" not in orchestrator_engine or "_outline_chinese_technology_heading_gate(s, item, registry)" not in orchestrator_engine:
        errors.append("report-workflow-orchestrator/workflow_engine.py: 目录生成后未接入中文技术标题确定性门禁")
    if "deterministic_level3_task_subject_uniqueness_gate" not in orchestrator_engine or "_outline_level3_task_subject_gate(s, item, registry)" not in orchestrator_engine:
        errors.append("report-workflow-orchestrator/workflow_engine.py: 目录生成后未接入三级标题任务主语唯一性门禁")
    if "同一技术章内所有技术类三级标题的任务主语必须互不重复" not in title:
        errors.append("technical-title-naming.md: 缺少同章三级技术标题任务主语唯一性规则")
    if "duplicate_level3_task_subject" not in reviewer:
        errors.append("report-reviewer/SKILL.md: 未同步三级标题任务主语重复问题类型")
    examples_dir = GEN / "examples"
    latin_title = re.compile(r"[A-Za-z]")
    for ep in examples_dir.glob("*.json"):
        try:
            obj = json.loads(read(ep))
        except Exception:
            continue
        def walk(node):
            if isinstance(node, dict):
                title_text = node.get("title")
                level = node.get("level")
                kind = node.get("heading_kind")
                if isinstance(title_text, str) and latin_title.search(title_text) and ((level == 2 and kind == "innovation") or (level == 3 and kind == "technical")):
                    errors.append(f"{ep.relative_to(ROOT)}: 正向技术标题示例仍裸露英文技术名/缩写: {title_text}")
                sig = node.get("technical_signature")
                if isinstance(sig, str) and latin_title.search(sig):
                    errors.append(f"{ep.relative_to(ROOT)}: technical_signature 示例仍含英文技术名/缩写: {sig}")
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)
        walk(obj)

    # v1.1.20: chapter-summary content rules have one canonical source.
    chapter_summary = GEN / "references" / "chapter-summary.md"
    if not chapter_summary.exists():
        errors.append("power-grid-technical-report-writer: 缺少 references/chapter-summary.md")
    else:
        summary_text = read(chapter_summary)
        for required in ["唯一权威规则源", "总—分—总", "500—600", "100—150", "约300字", "传统方法", "自然转写", "展示前检查"]:
            if required not in summary_text:
                errors.append(f"chapter-summary.md: 缺少统一规则要素 {required}")
        for removed in ["### 6.1 REAL_PROJECT_EVIDENCE", "### 6.2 REFERENCE_EXPERIMENT", "适用边界", "能力边界", "仍需保留的条件、限制或待验证事项"]:
            if removed in summary_text:
                errors.append(f"chapter-summary.md: 已删除的防御性小结规则重新出现 {removed}")
        runtime_manifest = json.loads(read(GEN / "references" / "runtime-pack-manifest.json"))
        for pack in ["20-outline", "30-chapter-planning-core", "40-chapter-writing-core"]:
            if "references/chapter-summary.md" not in runtime_manifest["packs"][pack]["sources"]:
                errors.append(f"runtime-pack-manifest.json: {pack} 未加载 chapter-summary.md")
        duplicate_patterns = [
            re.compile(r"本章小结.{0,50}采用.{0,20}总[—-]分[—-]总"),
            re.compile(r"本章小结.{0,50}(?:目标|约|控制).{0,20}500[—-]600"),
        ]
        for base in [GEN / "stages", GEN / "references"]:
            for sp in base.rglob("*.md"):
                if sp == chapter_summary or sp.name == "CHANGELOG.md":
                    continue
                st = read(sp)
                if any(pat.search(st) for pat in duplicate_patterns):
                    errors.append(f"{sp.relative_to(ROOT)}: 仍重复维护本章小结正文规则，应引用 chapter-summary.md")

    # v1.1.22: figure/table catalog entries directly continue the main TOC without visible labels.
    formatter_root = SKILLS_ROOT / "tech-report-writer"
    toc_styles_path = formatter_root / "scripts" / "toc_styles.py"
    if not toc_styles_path.exists():
        errors.append("tech-report-writer: 缺少 scripts/toc_styles.py")
    else:
        toc = read(toc_styles_path)
        for required in ["ensure_figure_table_catalogs", "mark_figure_table_captions", '_toc_field_paragraph("F"', '_toc_field_paragraph("T"', "without labels"]:
            if required not in toc:
                errors.append(f"tech-report-writer/toc_styles.py: 缺少图/表条目连续目录能力 {required}")
    formatter_rules = read(formatter_root / "references" / "technical-report-format.md")
    for required in ["主目录", "点引导线", "不得显示", "空行"]:
        if required not in formatter_rules:
            errors.append(f"tech-report-writer/technical-report-format.md: 缺少图/表条目连续目录规则 {required}")
    formatter_validator = read(formatter_root / "scripts" / "report_validator.py")
    for required in [r"\f\s+F", r"\f\s+T", "不得设置独立"]:
        if required not in formatter_validator:
            errors.append(f"tech-report-writer/report_validator.py: 缺少图/表条目连续目录结构校验 {required}")

    # v1.1.31: catalog TC collection must be caption-only and Word fields auto-refreshed.
    for key, expected in [
        ("enforce_caption_only_catalog_tc", True),
        ("normalize_catalog_explanation_leads", True),
        ("require_abstract_main_toc_tc", True),
        ("auto_refresh_word_catalog_fields", True),
        ("require_catalog_visual_qa", True),
    ]:
        if workflow_cfg.get(key) is not expected:
            errors.append(f"skill-registry.json: v1.1.31 必须设置 {key}={expected}")
    toc = read(toc_styles_path) if toc_styles_path.exists() else ""
    for required in ["ensure_abstract_catalog_marks", "_is_true_caption", "_remove_tc_identifier", "FIGURE_CAPTION_RE"]:
        if required not in toc:
            errors.append(f"tech-report-writer/toc_styles.py: 缺少v1.1.31目录采集能力 {required}")
    generator_text = read(formatter_root / "scripts" / "report_generator.py")
    if "_normalize_catalog_explanation_leads" not in generator_text or "该图" not in generator_text or "该表" not in generator_text:
        errors.append("tech-report-writer/report_generator.py: 未接入图表说明段去编号歧义处理")
    word_refresh = formatter_root / "scripts" / "word_field_refresh.py"
    if not word_refresh.exists():
        errors.append("tech-report-writer: 缺少 scripts/word_field_refresh.py")
    else:
        refresh_text = read(word_refresh)
        for required in ["TablesOfContents", "Fields.Update", "Microsoft Word"]:
            if required not in refresh_text:
                errors.append(f"tech-report-writer/word_field_refresh.py: 缺少Word自动更新能力 {required}")
    for required in ["内容摘要", "ABSTRACT", "非图题/表题段落禁止写入", "未找到目录项"]:
        if required not in formatter_rules:
            errors.append(f"tech-report-writer/technical-report-format.md: 缺少v1.1.31目录规则 {required}")
    if "catalog_explanation_misclassified_risk" not in reviewer or "caption_catalog_boundary_invalid" not in reviewer:
        errors.append("report-reviewer/SKILL.md: 未同步v1.1.31图表目录误采集问题类型")

    # v1.1.27: Markdown/HTML LaTeX must become native Word OMML; raw LaTeX cannot survive delivery.
    formatter_root = SKILLS_ROOT / "tech-report-writer"
    formatter_skill = read(formatter_root / "SKILL.md")
    for required in ["Word 原生 OMML", "不得把 LaTeX 源码", "内部公式标记", "未编号显示公式"]:
        if required not in formatter_skill:
            errors.append(f"tech-report-writer/SKILL.md: 缺少v1.1.27公式转换规则 {required}")
    math_adapter = formatter_root / "scripts" / "markdown_math.py"
    if not math_adapter.exists():
        errors.append("tech-report-writer: 缺少 scripts/markdown_math.py")
    else:
        math_text = read(math_adapter)
        for required in ["normalize_markdown_display_math", "normalize_html_math", "replace_inline_math_preserving_code", "split_formula_tag"]:
            if required not in math_text:
                errors.append(f"tech-report-writer/markdown_math.py: 缺少公式归一化能力 {required}")
    adapter_text = read(formatter_root / "scripts" / "orchestration_adapter.py")
    for required in ["normalize_markdown_display_math", "normalize_html_math", "replace_inline_math_preserving_code"]:
        if required not in adapter_text:
            errors.append(f"tech-report-writer/orchestration_adapter.py: 未接入公式归一化 {required}")
    format_text = read(formatter_root / "scripts" / "format_existing_report.py")
    for required in ["_iter_content_paragraphs", "_replace_inline_formula_markers", "_replace_formula_markers", "_pandoc_math_elements"]:
        if required not in format_text:
            errors.append(f"tech-report-writer/format_existing_report.py: 缺少Word原生公式转换能力 {required}")
    validator_text = read(formatter_root / "scripts" / "report_validator.py")
    for required in ["_raw_latex_math_errors", "RAW_LATEX_DELIMITER_RE", "RAW_LATEX_COMMAND_RE", "RAW_MATH_MARKER_RE"]:
        if required not in validator_text:
            errors.append(f"tech-report-writer/report_validator.py: 缺少LaTeX残留门禁 {required}")
    if workflow_cfg.get("normalize_markdown_math_for_word") is not True or workflow_cfg.get("reject_raw_latex_in_word") is not True:
        errors.append("skill-registry.json: 必须启用Word公式归一化与原始LaTeX残留门禁")
    orchestrator_skill = read(ORCHESTRATOR_ROOT / "SKILL.md")
    if "公式做确定性归一化并转为 Word 原生 OMML" not in orchestrator_skill:
        errors.append("report-workflow-orchestrator/SKILL.md: Word交付链未声明公式OMML转换")
    upstream_formula = read(GEN / "references" / "formula-and-symbol-rules.md")
    if "Markdown 源格式" not in upstream_formula or "Word 原生 OMML" not in upstream_formula:
        errors.append("power-grid-technical-report-writer/formula-and-symbol-rules.md: 未明确Markdown公式与Word成品格式分层")

    # 4) Experiment evidence is one canonical two-layer model, not override-on-top-of-old-rules.
    layering = read(GEN / "references" / "experiment-evidence-layering.md")
    for required in ["REAL_PROJECT_EVIDENCE", "REFERENCE_EXPERIMENT", "## 5. 全局统一约束"]:
        if required not in layering:
            errors.append(f"experiment-evidence-layering.md: 缺少 {required}")
    if "本分层规则优先于" in layering or "旧式绝对表述" in layering:
        errors.append("experiment-evidence-layering.md: 仍采用‘新规则覆盖旧规则’式冲突处理")

    # 5) Figure semantics are unified: reference data may be generated, actual figures remain placeholders.
    figure = read(GEN / "references" / "figure-and-table-guide.md")
    if re.search(r"【此处插入图(?:X-X|\d+-\d+)】", figure) is None or "不得实际绘制" not in figure:
        errors.append("figure-and-table-guide.md: 白框占位/不实际绘图规则不完整")
    exp = read(GEN / "references" / "experiment-reference-generation.md")
    if "实际插图仍按白框占位规则处理" not in exp:
        errors.append("experiment-reference-generation.md: 实验参考图与白框占位规则未显式对齐")

    # 6) Abstract constraints belong upstream; formatter must not negate them.
    formatter = read(SKILLS_ROOT / "tech-report-writer" / "SKILL.md")
    if "不在排版阶段重新裁决" not in formatter or "上游摘要约束" not in formatter:
        errors.append("tech-report-writer/SKILL.md: 摘要排版职责未与上游摘要门禁明确分层")
    if re.search(r"中文摘要：.*不限制字数|英文摘要：.*不限制英文词数", formatter):
        errors.append("tech-report-writer/SKILL.md: 仍使用容易否定上游规则的‘摘要不限制’表述")

    # 7) Reference style is one style end to end.
    for p in [GEN / "references" / "citation-and-evidence.md", SKILLS_ROOT / "report-reviewer" / "SKILL.md", SKILLS_ROOT / "tech-report-writer" / "SKILL.md"]:
        if "GB/T 7714" not in read(p):
            errors.append(f"{p.relative_to(ROOT)}: 缺少GB/T 7714统一规则")

    if errors:
        print(f"rule consistency validation failed: {len(errors)} errors")
        for e in errors:
            print("ERROR:", e)
        return 1
    print("rule consistency validation passed: 0 errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
