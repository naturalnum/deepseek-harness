#!/usr/bin/env python3
from __future__ import annotations
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
REQUIRED=[
    ("references/experiment-evidence-layering.md", "REFERENCE_EXPERIMENT"),
    ("references/experiment-evidence-layering.md", "不得因为“没有真实实验数据”而只停留在方案论证"),
    ("references/interaction-protocol.md", "不得默认只留空白占位"),
    ("references/content-generation-mode.md", "不得以占位替代参考实验"),
    ("SKILL.md", "不得默认退化为“只写方案论证、案例化场景、预期效果或待补数据位”"),
]
FORBIDDEN_SOURCE_PHRASES=[
    "不虚构数据、实验结果、第三方测试",
    "证据强度决定结论强度，不虚构数据、文献、实验或应用成效",
    "`model_autonomous`模式下影响真实数据和结果的缺失：使用明确占位，不补数",
    "缺少实际数据：不得补数",
    "用户未提供结果数据时，只能保留设计目标、验证方案、待补数据位或保守结论，不能生成虚构结果",
    "仍不得虚构项目数据、实验结果、应用成效、论文和标准",
]
errors=[]
for rel,phrase in REQUIRED:
    text=(ROOT/rel).read_text(encoding="utf-8")
    if phrase not in text: errors.append(f"缺少必要分层规则：{rel} :: {phrase}")
for base in [ROOT/"stages", ROOT/"references"]:
    for p in base.rglob("*.md"):
        text=p.read_text(encoding="utf-8")
        for phrase in FORBIDDEN_SOURCE_PHRASES:
            if phrase in text:
                errors.append(f"仍存在未分层的绝对禁令：{p.relative_to(ROOT)} :: {phrase}")
if errors:
    print("FAIL")
    for e in errors: print("-",e)
    sys.exit(1)
print("PASS: REAL_PROJECT_EVIDENCE / REFERENCE_EXPERIMENT 语义分层无已知旧规则冲突。")
