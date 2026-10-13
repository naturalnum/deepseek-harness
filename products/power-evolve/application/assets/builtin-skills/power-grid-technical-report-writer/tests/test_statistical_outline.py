"""Synthetic source-locked statistics through the actual outline validator.

The fixture adapts the rejected native QA candidate with correct headings and metadata.
It uses only median/MAD, modified and ordinary Z-scores, and confusion-matrix counts.
Run: PYTHONDONTWRITEBYTECODE=1 python3 tests/test_statistical_outline.py
"""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from title_specificity import (
    technical_signature_issue,
    based_on_signature_issue,
    operation_level_technology,
    chinese_heading_technology_issue,
)


def statistical_outline():
    return json.loads((ROOT / "tests/fixtures/statistical-outline.json").read_text(encoding="utf-8"))


def total_outline():
    data = statistical_outline()
    data["task_book_scope"] = "total_report"
    technical = data["chapters"][1]
    engineering = copy.deepcopy(technical)
    # Renumber companion heading references along with the copied chapter.
    engineering = json.loads(re.sub(r"(?<![0-9.])2\.(?=\d)", "3.", json.dumps(engineering, ensure_ascii=False)))
    engineering.update(id="3", title="配电负荷异常标记集成系统", parent_task_id="T2",
                       parent_task_order=2, task_role="engineering-implementation",
                       chapter_type="engineering-integration", source_research_point_ids=["RC2"])
    for heading in engineering["section_outline"]:
        if "parent_task_id" in heading:
            heading["parent_task_id"] = "T2"
        if "research_point_id" in heading:
            heading["research_point_id"] = "RC2"
        if "source_item_ids" in heading:
            heading["source_item_ids"] = ["RC2"]
    data["report_tasks"] = []
    for chapter in (technical, engineering):
        title = chapter["title"]
        chapter.update(source_task_title=title, source_task_normalized_title=title,
                       task_title_normalization_basis="保留合成任务书中的对象与职责")
        data["report_tasks"].append({"task_id": chapter["parent_task_id"],
                                     "task_order": chapter["parent_task_order"],
                                     "task_title": title, "normalized_chapter_title": title,
                                     "task_role": chapter["task_role"],
                                     "research_point_ids": chapter["source_research_point_ids"]})
    data["chapters"].insert(2, engineering)
    data["chapters"][-1]["id"] = "4"
    data["chapters"][-1]["section_outline"][0]["number"] = "4"
    data["target_words"] += engineering["target_words"]
    return data


class StatisticalOutlineTest(unittest.TestCase):
    def validate(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outline.json"
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return subprocess.run([sys.executable, str(ROOT / "scripts/validate_outline.py"), str(path)],
                                  capture_output=True, text=True, timeout=10,
                                  env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))

    def assert_passes(self, data):
        result = self.validate(data)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_rejected(self, data, reason):
        result = self.validate(data)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(reason, result.stdout)

    def test_complete_named_statistics_are_specific_without_invented_ai_mechanisms(self):
        for signature in ("中位数", "中位数绝对偏差", "修正标准分数", "普通标准分数", "混淆矩阵"):
            with self.subTest(signature=signature):
                self.assertIsNone(technical_signature_issue(signature))
                self.assertIsNone(based_on_signature_issue("基于" + signature + "的配电负荷异常标记方法"))

    def test_generic_statistics_and_task_labels_remain_rejected(self):
        for signature in ("统计分析", "稳健统计", "修正分数", "零尺度拒绝", "比例因子归一化",
                          "校准数据分离", "置信校准", "机器学习", "图神经网络"):
            with self.subTest(signature=signature):
                self.assertIsNotNone(technical_signature_issue(signature))

    def test_source_locked_statistical_outline_passes_real_cli(self):
        self.assert_passes(statistical_outline())

    def test_local_report_retains_provided_technical_and_engineering_parent_roles(self):
        for role in ("technical-research", "engineering-implementation"):
            with self.subTest(role=role):
                data = statistical_outline()
                data["chapters"][1]["task_role"] = role
                data["chapters"][1]["parent_task_order"] = 2
                if role == "engineering-implementation":
                    chapter = data["chapters"][1]
                    chapter["title"] = chapter["source_research_subpoint_title"] = chapter["source_research_normalized_title"] = "配电负荷异常标记集成系统"
                self.assert_passes(data)

    def test_local_report_still_requires_parent_identity_order_and_role(self):
        for field, reason in (("parent_task_id", "缺少 parent_task_id"),
                              ("parent_task_order", "缺少有效 parent_task_order"),
                              ("task_role", "缺少有效 task_role"),
                              ("source_research_point_ids", "必须且只能关联一个研究内容小点")):
            with self.subTest(field=field):
                data = statistical_outline()
                del data["chapters"][1][field]
                self.assert_rejected(data, reason)
        data = total_outline()
        data["task_book_scope"] = "specific_topic"
        data["chapters"][2]["parent_task_id"] = "T1"
        data["chapters"][2]["parent_task_order"] = 1
        data["chapters"][2]["source_research_order"] = 2
        self.assert_rejected(data, "课题 T1 的 task_role 不一致")

    def test_total_report_retains_complete_order_and_role_rules(self):
        data = total_outline()
        self.assert_passes(data)
        for index, wrong_role, expected in ((0, "engineering-implementation", "technical-research"),
                                             (1, "technical-research", "engineering-implementation")):
            with self.subTest(index=index):
                changed = copy.deepcopy(data)
                changed["report_tasks"][index]["task_role"] = wrong_role
                changed["chapters"][index + 1]["task_role"] = wrong_role
                self.assert_rejected(changed, "应标记为 " + expected)
        changed = copy.deepcopy(data)
        changed["report_tasks"].reverse()
        self.assert_rejected(changed, "report_tasks 必须按课题原始顺序连续排列")

    def test_statistical_names_do_not_bypass_title_source_or_candidate_rules(self):
        mutations = [
            (lambda c: c["section_outline"][0].update(title="基于中位数绝对偏差的稳健尺度技术"), "电力"),
            (lambda c: c["section_outline"][8].update(title="混淆矩阵配电负荷误报评价方法"), "属于非评估主题"),
            (lambda c: c["heading_source_term_plan"][0].update(term="未出现在标题的来源术语"), "未直接出现在目标标题"),
            (lambda c: c.pop("technology_option_sets"), "technology_option_sets_missing"),
            (lambda c: c["technology_option_sets"][0]["candidates"][0].update(origin="model_suggested"), "source_locked_candidate_must_be_source_confirmed"),
            (lambda c: c["technology_option_sets"][0]["candidates"].append(copy.deepcopy(c["technology_option_sets"][0]["candidates"][0])), "source_locked_option_must_have_one_candidate"),
        ]
        for mutate, reason in mutations:
            with self.subTest(reason=reason):
                data = statistical_outline()
                mutate(data["chapters"][1])
                self.assert_rejected(data, reason)

    def test_statistical_names_retain_heading_ending_and_based_on_ratios(self):
        for ending in (True, False):
            with self.subTest(ending=ending):
                data = statistical_outline()
                for heading in data["chapters"][1]["section_outline"]:
                    if ending:
                        heading["title"] = re.sub("技术$", "方法", heading["title"])
                    else:
                        heading["title"] = re.sub(r"^基于(.+?)的", r"\1", heading["title"])
                self.assert_rejected(data, "结尾分布" if ending else "低于40%下限")

    def mathematical_outline(self, predicate):
        # Replace the source-locked named classifier in the complete synthetic fixture.
        data = json.loads(json.dumps(statistical_outline(), ensure_ascii=False).replace("修正标准分数", predicate))
        for heading in data["chapters"][1]["section_outline"]:
            if predicate in heading["title"]:
                heading["title_length_exception_reason"] = "完整数学谓词和电力主语不能继续压缩"
        return data

    def test_complete_residual_predicates_remain_specific_with_classification_roles(self):
        predicates = (
            "绝对残差严格大于十二千瓦",
            "绝对残差严格大于十二千瓦分类判定",
            "绝对残差严格大于15千瓦分类判定",
            "绝对差值严格小于7.5伏检测方法",
            "绝对残差严格大于二十点五兆瓦异常识别技术",
            "绝对差值严格大于零点五毫秒",
            "绝对残差严格大于一百零二千瓦",
            "绝对残差严格大于一千零一十五千瓦",
            "绝对残差严格大于一万零二千瓦",
            "绝对差值严格小于0百分比",
        )
        for predicate in predicates:
            with self.subTest(predicate=predicate):
                self.assertIsNone(technical_signature_issue(predicate, role="分类判定", power_element="配电负荷"))
                self.assertIsNone(operation_level_technology(predicate, role="分类判定", power_element="配电负荷"))
                self.assertIsNone(based_on_signature_issue("基于" + predicate + "的配电负荷异常标记方法"))
                self.assertIsNone(chinese_heading_technology_issue(predicate))

    def test_partial_negative_and_generic_predicates_still_fail(self):
        for predicate in (
            "绝对残差", "绝对差值", "固定阈值", "分类", "日志留存", "样本读取", "零分母处理",
            "残差严格大于十二千瓦", "绝对值严格大于十二千瓦",
            "绝对残差十二千瓦", "绝对残差大于十二千瓦", "绝对残差严格大于千瓦",
            "绝对残差严格大于十二", "绝对残差严格大于十二单位",
            "绝对残差严格大于阈值千瓦", "绝对残差严格大于负十二千瓦",
            "绝对残差严格大于-12千瓦", "绝对残差严格大于+12千瓦",
            "绝对残差严格大于十二点千瓦", "绝对残差严格大于十十千瓦",
            "绝对残差严格大于二十二三千瓦", "绝对残差严格大于1..2千瓦",
            "绝对残差严格大于.5千瓦", "绝对残差严格大于012千瓦",
            "绝对残差严格大于无穷大千瓦", "绝对残差严格大于Infinity千瓦",
            "绝对残差严格大于十二kW", "绝对残差严格大于十二千瓦日志读取",
            "非绝对残差严格大于十二千瓦", "不采用绝对残差严格大于十二千瓦",
            "绝对残差不严格大于十二千瓦", "绝对残差严格大于十二千瓦或分类",
        ):
            with self.subTest(predicate=predicate):
                self.assertIsNotNone(technical_signature_issue(predicate, role="分类判定", power_element="配电负荷"))
                self.assertIsNotNone(based_on_signature_issue("基于" + predicate + "的配电负荷异常标记方法"))

    def test_complete_mathematical_predicates_pass_the_real_outline_cli(self):
        for predicate in ("绝对残差严格大于十二千瓦分类判定", "绝对差值严格小于7.5伏"):
            with self.subTest(predicate=predicate):
                self.assert_passes(self.mathematical_outline(predicate))

    def test_source_locked_does_not_admit_incomplete_mathematical_signatures(self):
        for predicate in ("绝对残差", "固定阈值分类", "绝对残差严格大于十二", "执行日志留存"):
            with self.subTest(predicate=predicate):
                data = self.mathematical_outline(predicate)
                sets = data["chapters"][1]["technology_option_sets"]
                self.assertTrue(all(row["source_locked"] is True for row in sets))
                self.assert_rejected(data, "技术显化不足")

    def test_mathematical_specificity_retains_chinese_source_structure_and_ratio_checks(self):
        predicate = "绝对残差严格大于十二千瓦分类判定"
        mutations = (
            (lambda c: c["section_outline"][3].update(title="基于" + predicate + "的记录分类方法"), "电力"),
            (lambda c: c["section_outline"][3].update(title="基于" + predicate + "的配电负荷classification方法"), "英文"),
            (lambda c: c["heading_source_term_plan"][2].update(term="未出现在标题的来源术语"), "未直接出现在目标标题"),
            (lambda c: c["technology_option_sets"][1]["candidates"][0].update(origin="model_suggested"),
             "source_locked_candidate_must_be_source_confirmed"),
            (lambda c: c["section_outline"].pop(4), "核心技术二级标题默认3个"),
            (lambda c: [h.update(title=re.sub(r"^基于(.+?)的", r"\1", h["title"]))
                        for h in c["section_outline"]], "低于40%下限"),
            (lambda c: [h.update(title=re.sub("技术$", "方法", h["title"]))
                        for h in c["section_outline"]], "结尾分布"),
        )
        for mutate, reason in mutations:
            with self.subTest(reason=reason):
                data = self.mathematical_outline(predicate)
                mutate(data["chapters"][1])
                self.assert_rejected(data, reason)


if __name__ == "__main__":
    unittest.main()
