#!/usr/bin/env python3
"""Detect active-rule residues that conflict with the v1.1.20 canonical baseline."""
from __future__ import annotations
import re, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ACTIVE_EXT={'.md','.json','.py'}
EXCLUDE={'CHANGELOG.md','current-rule-baseline.md','validate_current_rule_conflicts.py'}
FORBIDDEN=[
    (re.compile(r'至少\s*60%.*(?:电力|核心标题)|显式电力词比例.*60%|minimum_explicit_power_term_ratio|core_level2_power_title_ratio'), '旧60%电力词比例规则'),
    (re.compile(r'\bai_element\b|\binnovation_method\b|人工智能元素、创新方法|人工智能元素和创新方法'), '旧标题元数据字段'),
    (re.compile(r'目录中的一级、二级和三级标题默认不超过30个可见字符|超过30个字符.*heading_too_long'), '旧30字符标题上限'),
    (re.compile(r'初步绘图 Prompt|初版生成结构化图表占位和初步 Prompt'), '旧绘图Prompt规则'),
    (re.compile(r'普通三级标题，上位标题已经限定电力场景|技术类三级标题.*(?:可|可以).*依赖上位标题.*电力'), '旧三级标题继承电力场景规则'),
]
# Phrases are allowed only when explicitly quoted as rejected old behavior in the layering rule.
ALLOW_PATHS={'references/experiment-evidence-layering.md','scripts/validate_experiment_evidence_layering.py'}

def main()->int:
    errors=[]
    for p in ROOT.rglob('*'):
        if not p.is_file() or p.suffix not in ACTIVE_EXT or p.name in EXCLUDE :
            continue
        rel=p.relative_to(ROOT).as_posix()
        text=p.read_text(encoding='utf-8',errors='ignore')
        for pat,label in FORBIDDEN:
            if pat.search(text):
                errors.append(f'{rel}: {label}')
    # Current title file must contain one merged core-title rule and no old duplicate sections.
    title=(ROOT/'references/technical-title-naming.md').read_text(encoding='utf-8')
    if title.count('## 6. 核心二级标题统一硬规则') != 1 or '## 13. 核心二级标题的创新技术与承接链硬规则' in title or '## 7. 核心标题逐项电力语义完整性' in title:
        errors.append('references/technical-title-naming.md: 核心标题规则未统一或仍有重复章节')
    if '技术变体/关键机制' not in title or 'RAG/检索增强生成' not in title or '图神经网络/GNN' not in title:
        errors.append('references/technical-title-naming.md: 缺少技术族细化到变体/关键机制的当前规则')
    if '40%—60%的双向硬门禁' not in title or '低于40%或高于60%均为硬性错误' not in title:
        errors.append('references/technical-title-naming.md: 缺少“基于……的……”40%—60%双向硬门禁')
    if '电力语义显化与技术签名显化是并列的两个硬门禁' not in title or '不能替代电力领域语义门禁' not in title:
        errors.append('references/technical-title-naming.md: 缺少电力语义与技术签名并列硬门禁')
    if '不得直接裸露在二、三级技术标题中' not in title or '中文语义 technical_signature' not in title:
        errors.append('references/technical-title-naming.md: 缺少二三级技术标题中文语义技术名规则')
    if '同一技术章内所有技术类三级标题的任务主语必须互不重复' not in title:
        errors.append('references/technical-title-naming.md: 缺少同章三级技术标题任务主语唯一性规则')
    latin=re.compile(r'[A-Za-z]')
    import json
    for ep in (ROOT/'examples').glob('*.json'):
        try:
            obj=json.loads(ep.read_text(encoding='utf-8'))
        except Exception:
            continue
        def walk(node):
            if isinstance(node,dict):
                ttl=node.get('title'); lvl=node.get('level'); kind=node.get('heading_kind')
                if isinstance(ttl,str) and latin.search(ttl) and ((lvl==2 and kind=='innovation') or (lvl==3 and kind=='technical')):
                    errors.append(f'{ep.name}: 正向技术标题示例仍裸露英文技术名/缩写: {ttl}')
                sig=node.get('technical_signature')
                if isinstance(sig,str) and latin.search(sig):
                    errors.append(f'{ep.name}: technical_signature 示例仍含英文技术名/缩写: {sig}')
                for v in node.values(): walk(v)
            elif isinstance(node,list):
                for v in node: walk(v)
        walk(obj)
    soft_lower = re.compile(r'不足40%不作为硬性错误|低于40%.{0,40}(?:不作为硬性错误|仅.*警告|warning)|低于30%.{0,40}(?:警告|warning)|可用于突出技术点但不是强制|不是强制模板', re.S|re.I)
    for p in ROOT.rglob('*'):
        if not p.is_file() or p.suffix not in ACTIVE_EXT or p.name in EXCLUDE:
            continue
        rel=p.relative_to(ROOT).as_posix()
        if soft_lower.search(p.read_text(encoding='utf-8',errors='ignore')):
            errors.append(f'{rel}: 仍含“基于……的……”低比例软提示旧规则')
    style=(ROOT/'references/narrative-and-heading-style.md').read_text(encoding='utf-8')
    stage40=(ROOT/'stages/40-chapter-writing.md').read_text(encoding='utf-8')
    for rel,text in [('references/narrative-and-heading-style.md', style), ('stages/40-chapter-writing.md', stage40)]:
        if '可以采用“基于图神经网络的故障关联识别技术”' in text or '例如“基于图神经网络的故障关联识别技术”' in text:
            errors.append(f'{rel}: 仍把图神经网络族级名称作为正向具体标题示例')
    if errors:
        for e in errors: print('ERROR:',e)
        print(f'规则冲突校验失败：{len(errors)}项')
        return 1
    print('规则冲突校验通过：活动源规则未发现已知旧规则残留。')
    return 0
if __name__=='__main__': raise SystemExit(main())
