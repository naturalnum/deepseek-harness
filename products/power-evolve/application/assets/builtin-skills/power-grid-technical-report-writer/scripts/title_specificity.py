#!/usr/bin/env python3
"""Shared deterministic checks for technical-title granularity.

The checker enforces a lower bound for title-visible technical specificity.
It does not try to judge research novelty, but rejects headings that only expose
technology families or task/operation labels without a discriminative technical signature.
"""
from __future__ import annotations

import re

# Broad technology families: useful taxonomy / keywords, insufficient as final title granularity.
FAMILY_LEVEL_TECHS = {
    "人工智能", "机器学习", "深度学习", "神经网络", "大模型", "大语言模型", "语言模型", "优化算法", "智能分析", "数据驱动", "智能算法",
    "llm", "rag", "检索增强生成", "图神经网络", "gnn", "transformer", "图transformer",
    "强化学习", "多智能体", "多智能体强化学习", "知识图谱", "扩散模型", "状态空间模型",
    "混合专家", "元学习", "图对比学习", "对比学习", "神经算子", "span", "双塔",
}

# Task/operation labels that say what is done, but not what concrete technique performs it.
# They are allowed as the *role* portion of a title, but not as its technical signature by themselves.
OPERATION_LEVEL_LABELS = {
    "span抽取", "跨度抽取", "双塔匹配", "实体边界识别", "关系类型判别", "关系抽取", "实体抽取",
    "候选生成", "语义聚合", "上下文语义聚合", "术语对齐", "语义对齐", "实体匹配", "一致性筛选",
    "置信校准", "置信度校准", "样本重加权", "参数更新", "迁移适配", "少样本迁移适配",
    "相似度计算", "规则匹配", "原因推断", "故障推理", "目标验证", "准确率验证", "知识单元生成",
    "映射", "识别", "预测", "推理", "分类", "检测", "校准", "重加权", "更新",
}

# Concrete named variants / algorithms / architectures. Presence is a strong specificity signal.
KNOWN_SPECIFIC_VARIANTS = {
    "graphrag", "selfrag", "crag", "correctiverag", "raptor", "lightrag", "hyde", "colbert",
    "graphsage", "gat", "gatv2", "rgcn", "hgt", "gcn", "mamba", "ppo", "dqn", "sac", "td3",
    "globalpointer", "roberta", "deberta", "spanbert", "biaffine", "clip", "groundingdino",
    "lora", "maml", "focalloss", "focal", "patchtst", "timesnet", "informer", "autoformer",
    "fedavg", "fedprox", "lightgbm", "xgboost", "bert", "t5", "vit", "swin", "sam",
}

# Chinese route-semantic equivalents used in formal L2/L3 headings. These are intentionally
# concise route descriptions rather than literal full-name translations.
KNOWN_CHINESE_VARIANTS = {
    "全局指针", "全局指针跨度识别", "鲁棒预训练语言编码", "跨区间掩码预训练",
    "图邻域采样聚合", "异构图变换注意力", "对比式图文预训练", "开放词汇目标定位",
    "低秩适配", "模型无关元学习", "近端策略优化", "选择性状态空间", "后交互语义检索",
    "递归摘要树检索", "焦点损失", "提示分割", "双向长短期记忆条件随机场",
    "分块时序变换", "多周期时序建模", "梯度提升树", "联邦平均", "联邦近端优化",
    "双仿射关系建模", "原型网络", "共形预测", "温度缩放",
    "解耦注意力预训练语言编码", "后交互语义重排序", "稀疏门控双专家混合",
    "蒙特卡洛随机失活贝叶斯不确定性", "多域物理联合仿真数字孪生",
    # Named statistical estimators/transforms are concrete without added AI mechanisms.
    "中位数", "中位数绝对偏差", "标准分数", "修正标准分数", "混淆矩阵",
}

LATIN_TECH_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+_.-]*")

def raw_english_technology_tokens(text: str) -> list[str]:
    """Return Latin technology/name tokens that should not be exposed in formal L2/L3 headings.

    Formal technical headings are Chinese-only by default. Original model names/abbreviations
    belong in metadata or first-use body definitions, not in the outline title itself.
    """
    return LATIN_TECH_TOKEN_RE.findall(str(text or ""))


def chinese_heading_technology_issue(text: str) -> str | None:
    tokens = raw_english_technology_tokens(text)
    if tokens:
        return "raw_english:" + ",".join(tokens)
    return None

# Mechanism markers. A family-level method can become concrete when at least two independent
# route-distinguishing mechanisms are visible. A named variant plus one marker is also sufficient.
MECHANISM_MARKERS = {
    "混合检索", "稠密检索", "稀疏检索", "交叉编码重排序", "重排序", "多查询", "查询扩展",
    "关系类型感知", "异构图", "异构图注意力", "图注意力", "边类型感知", "时序门控", "门控更新",
    "多尺度", "时频", "稀疏注意力", "局部注意力", "安全约束", "物理约束", "反事实约束", "分层策略",
    "知识图谱约束", "规则约束", "领域约束", "提示约束", "指令模板增强", "实体标记", "领域蒸馏",
    "跨模态原型", "原型对比", "类别均衡", "温度缩放", "共形预测", "低秩适配", "参数高效微调",
    "多任务学习", "对抗训练", "难例挖掘", "动态负采样", "因果干预", "变分推断", "分布鲁棒",
    "不确定性量化", "图结构先验", "拓扑约束", "多视图", "协同训练", "自蒸馏", "课程学习",
    "邻域采样", "采样聚合", "图邻域采样聚合", "变换注意力", "对比式图文预训练",
    "开放词汇", "目标定位", "低秩适配", "模型无关元学习", "近端策略优化",
    "选择性状态空间", "后交互语义检索", "后交互语义重排序", "递归摘要树", "焦点损失", "提示分割",
    "解耦注意力", "稀疏门控", "多域物理联合仿真",
}

# Generic role / landing words do not make a technology family more specific.
GENERIC_ROLE_WORDS = {
    "技术", "方法", "算法", "模型", "系统", "平台", "服务", "模块", "机制", "框架", "应用",
    "识别", "预测", "推理", "分析", "生成", "表征", "对齐", "优化", "检索", "诊断", "评估",
    "校准", "抽取", "融合", "控制", "决策", "编排", "集成", "适配", "处理", "构建", "学习",
    "训练", "分类", "回归", "检测", "定位", "关联", "关系", "原因", "故障", "处置", "建议",
    "候选", "语义", "实体", "边界", "类型", "匹配", "一致性", "样本", "参数", "更新", "目标", "验证",
}

# Broad Latin tokens that must not be treated as named variants simply because they are Latin.
BROAD_LATIN_TOKENS = {"rag", "gnn", "llm", "ai", "nlp", "span", "transformer"}

# Strong power-domain signals for technical headings. Generic words such as “设备/故障/保护/负荷”
# are intentionally excluded when used alone because they are cross-industry and can let a pure
# computing title pass without actually exposing the electric-power context.
STRONG_POWER_DOMAIN_TERMS = {
    "电力", "电网", "配电", "配电网", "输电", "变电", "变压器", "调度", "潮流", "线路", "机组",
    "新能源", "储能", "电压", "有功", "无功", "功率", "继电保护", "运行方式", "安全边界", "调控",
    "调峰", "调频", "供电", "台区", "变电站", "运检",
}

# Evaluation/validation-like vocabulary is allowed in L2/L3 headings only when the report
# theme itself is evaluation-related. The mere presence of acceptance indicators, test
# conditions, experiment evidence, or project assessment requirements does not make the
# report an evaluation-related report.
EVALUATION_HEADING_TERMS = {
    "验证", "评估", "评价", "测评", "评测", "验收", "测试", "试验", "实验",
}


def heading_has_evaluation_term(title: str) -> bool:
    raw = re.sub(r"\s+", "", str(title or ""))
    return any(term in raw for term in EVALUATION_HEADING_TERMS)


def visible_power_domain_terms(title: str) -> set[str]:
    t = norm(title)
    return {term for term in STRONG_POWER_DOMAIN_TERMS if norm(term) in t}


def power_domain_signal_issue(title: str) -> str | None:
    """Return an issue when a technical heading lacks an independently visible power-domain signal."""
    if not str(title or "").strip():
        return "empty"
    if visible_power_domain_terms(title):
        return None
    return "missing_strong_power_domain_signal"


def norm(text: str) -> str:
    return re.sub(r"[\s_\-—–/]+", "", str(text or "")).lower()


def _strip_noise(text: str, *, role: str = "", power_element: str = "") -> str:
    t = norm(text)
    for component in (role, power_element):
        c = norm(component)
        if c:
            t = t.replace(c, "")
    changed = True
    while changed:
        changed = False
        for word in sorted(GENERIC_ROLE_WORDS, key=len, reverse=True):
            w = norm(word)
            if w and w in t:
                t2 = t.replace(w, "")
                if t2 != t:
                    t = t2
                    changed = True
    return t


def _named_variant_hits(text: str) -> set[str]:
    t = norm(text)
    hits = {v for v in KNOWN_SPECIFIC_VARIANTS if norm(v) in t}
    hits.update({v for v in KNOWN_CHINESE_VARIANTS if norm(v) in t})
    # Unknown named algorithms/models are often Latin tokens >=4 chars. Accept them in internal
    # metadata, but formal-heading Chinese-only enforcement is handled separately.
    for token in re.findall(r"[a-z][a-z0-9]{3,}", t):
        if token not in BROAD_LATIN_TOKENS and token not in {norm(x) for x in FAMILY_LEVEL_TECHS}:
            hits.add(token)
    return hits


def _mechanism_hits(text: str) -> set[str]:
    t = norm(text)
    return {m for m in MECHANISM_MARKERS if norm(m) in t}


def family_level_technology(technology: str, *, role: str = "", power_element: str = "") -> str | None:
    """Return the broad family token when technology is still only family-level."""
    t = norm(technology)
    if not t:
        return None
    if _named_variant_hits(t):
        return None

    for family in sorted(FAMILY_LEVEL_TECHS, key=len, reverse=True):
        f = norm(family)
        if not f or f not in t:
            continue
        if t == f:
            return family
        remainder = t.replace(f, "", 1)
        remainder = _strip_noise(remainder, role=role, power_element=power_element)
        meaningful = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", remainder)
        # Two mechanisms can make a family-specific route explicit even without a named variant.
        if len(_mechanism_hits(t)) >= 2:
            return None
        if len(meaningful) < 3:
            return family
    return None


def operation_level_technology(technology: str, *, role: str = "", power_element: str = "") -> str | None:
    """Return an operation label when the 'technology' is still just a task/action description."""
    t = norm(technology)
    if not t:
        return None
    named = _named_variant_hits(t)
    mechanisms = _mechanism_hits(t)
    # A named variant plus at least one mechanism is strong; a named variant alone is acceptable
    # when the operation is merely the role portion (e.g. GroundingDINO候选生成).
    if named:
        return None
    if len(mechanisms) >= 2:
        return None

    stripped = _strip_noise(t, role=role, power_element=power_element)
    for label in sorted(OPERATION_LEVEL_LABELS, key=len, reverse=True):
        l = norm(label)
        if not l:
            continue
        if t == l or l in t or stripped == l or (stripped and stripped in l):
            return label
    return None


def technical_signature_issue(technology: str, *, role: str = "", power_element: str = "") -> str | None:
    """Return a human-readable reason when a technical signature is too weak."""
    if not str(technology or "").strip():
        return "empty"
    family = family_level_technology(technology, role=role, power_element=power_element)
    if family:
        return f"family:{family}"
    op = operation_level_technology(technology, role=role, power_element=power_element)
    if op:
        return f"operation:{op}"

    t = norm(technology)
    named = _named_variant_hits(t)
    mechanisms = _mechanism_hits(t)
    # If it contains neither a named variant nor at least two discriminative mechanisms,
    # treat it as too weak. This is deliberately a conservative lower-bound check.
    if not named and len(mechanisms) < 2:
        return "no_discriminative_anchor"
    return None


def bare_family_title_pattern(title: str) -> str | None:
    """Catch common '基于<family>的...' title forms that are still family-level."""
    t = norm(title)
    if not t:
        return None
    for family in sorted(FAMILY_LEVEL_TECHS, key=len, reverse=True):
        f = norm(family)
        if f and f"基于{f}的" in t:
            return family
    return None


def based_on_signature_issue(title: str) -> str | None:
    """If a title uses 基于X的..., ensure X itself is a concrete technical signature."""
    raw = re.sub(r"\s+", "", str(title or ""))
    m = re.search(r"基于(.{1,40}?)的", raw, flags=re.I)
    if not m:
        return None
    signature = m.group(1)
    return technical_signature_issue(signature)


def listed_family_tokens(text: str) -> list[str]:
    t = norm(text)
    out: list[str] = []
    for family in sorted(FAMILY_LEVEL_TECHS, key=len, reverse=True):
        if norm(family) in t:
            out.append(family)
    return out


def is_based_on_heading_style(title: str) -> bool:
    """Return True for titles using the preferred `基于X的Y` surface form.

    This is a style counter only. Technical specificity is validated separately.
    """
    raw = re.sub(r"\s+", "", str(title or ""))
    return bool(re.match(r"^基于.{2,40}的.+", raw))


TITLE_LANDING_WORDS = ("方法", "技术", "算法", "模型")


def heading_task_subject(title: str, technical_signature: str = "") -> str:
    """Extract the title-visible task subject used for within-chapter L3 uniqueness checks.

    For `基于X的Y` headings, Y is the subject explicitly requested by the report style.
    For direct-composite headings, the visible technical signature is removed once so the
    remaining power-domain object + technical role becomes the comparable task subject.
    """
    raw = re.sub(r"\s+", "", str(title or "")).strip("：:，,。；;、")
    if not raw:
        return ""
    m = re.match(r"^基于.{2,80}?的(.+)$", raw)
    if m:
        return m.group(1).strip("：:，,。；;、")

    sig = re.sub(r"\s+", "", str(technical_signature or ""))
    subject = raw
    if sig and sig in subject:
        subject = subject.replace(sig, "", 1)
    return subject.strip("：:，,。；;、")


def heading_task_subject_has_power_signal(title: str, technical_signature: str = "") -> bool:
    """Require the task subject itself—not merely the preposed technical signature—to carry power semantics."""
    subject = heading_task_subject(title, technical_signature)
    return power_domain_signal_issue(subject) is None


def normalize_task_subject(subject: str) -> str:
    """Normalize a task subject while preserving its power-domain and technical-role semantics."""
    t = re.sub(r"[\s_\-—–/：:，,。；;、()（）]+", "", str(subject or "")).lower()
    for landing in TITLE_LANDING_WORDS:
        if t.endswith(landing):
            t = t[: -len(landing)]
            break
    return t


def task_subjects_are_duplicate(a: str, b: str) -> bool:
    """Return True for exact or near-identical L3 task subjects.

    The deterministic gate is intentionally conservative: it catches exact normalized
    repetition, superficial landing-word changes, and almost identical suffixes. Semantic
    paraphrases that still duplicate the same responsibility are left to report-reviewer.
    """
    from difflib import SequenceMatcher

    na, nb = normalize_task_subject(a), normalize_task_subject(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    shorter, longer = sorted((na, nb), key=len)
    if len(shorter) >= 6 and shorter in longer and len(shorter) / max(len(longer), 1) >= 0.85:
        return True
    return min(len(na), len(nb)) >= 8 and SequenceMatcher(None, na, nb).ratio() >= 0.90
