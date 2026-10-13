#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path

ALLOWED_DATA_STATUS = {"simulated_reference", "illustrative_example", "expected_range"}
FORBIDDEN_RESULT_PHRASES = ("实验结果表明", "已提升", "已达到", "实测表明", "验证结果证明")

def main() -> int:
    ap = argparse.ArgumentParser(description="Validate that a model-generated experiment package remains reference-only.")
    ap.add_argument("input")
    args = ap.parse_args()
    obj = json.loads(Path(args.input).read_text(encoding="utf-8"))
    errors=[]
    if obj.get("reference_only") is not True:
        errors.append("reference_only 必须为 true")
    if obj.get("evidence_status") != "model_generated_reference":
        errors.append("evidence_status 必须为 model_generated_reference")
    if obj.get("draft_report_inclusion") not in {"allowed_with_chapter_end_notice", "allowed_if_labeled", "external_only"}:
        errors.append("draft_report_inclusion 必须为 allowed_with_chapter_end_notice、allowed_if_labeled（兼容旧状态）或 external_only")
    for i,item in enumerate(obj.get("simulated_reference_data", []),1):
        if item.get("data_status") not in ALLOWED_DATA_STATUS:
            errors.append(f"simulated_reference_data[{i}] data_status 无效")
    rendered=json.dumps(obj, ensure_ascii=False)
    for phrase in FORBIDDEN_RESULT_PHRASES:
        if phrase in rendered:
            errors.append(f"实验参考包不得使用已完成事实口吻：{phrase}")
    for field in ("dataset_plan","evaluation_metrics","baseline_methods","reference_result_analysis","user_supplementation_checklist"):
        if not obj.get(field):
            errors.append(f"缺少或为空：{field}")
    if errors:
        for e in errors: print("ERROR:",e)
        print(f"校验失败：{len(errors)} 个错误")
        return 1
    print("校验通过：实验参考包保持参考证据语义，模拟数据状态有效，可按标注规则进入报告草稿。")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
