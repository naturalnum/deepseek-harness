"""Final reviewed report text must survive deterministic Word preparation.

Run with the report Python dependencies: python3 tests/test_orchestration_adapter.py
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from orchestration_adapter import chapter_data, final_report_data, abstract_data, create_word_report
from docx import Document
from engine.parser import parse_html_to_elements
from format_existing_report import _configure_body
from docx.oxml.ns import qn
from docx.shared import Pt
from report_validator import validate_report


FINAL_MARKER = "REPORT-REVISION-20261003"
OLD_MARKER = "REPORT-OLD-20261003"
FINAL_REPORT = f"""# 测试负荷异常识别技术报告

## 中文摘要

中文摘要包含最终确认的测试结论。

**关键词：** 电网；负荷；中位数

## ABSTRACT

The reviewed report records the final test result.

**Keywords:** power grid; load; median

# 1 项目概述

{FINAL_MARKER}：测试数据仅支持局部结论。

## 1.1 研究范围

不得把本测试解释为生产性能。

# 2 配电负荷异常识别

表2-1 测试结果

| 指标 | 数值 |
| --- | ---: |
| 识别数 | 3 |

# 3 总结

确认的总结只包含本测试的结论。

# 参考文献

[1] 测试文献作者. 测试方法说明[R]. 2026.
"""


def payload(source=FINAL_REPORT):
    return {
        "source_report": {"artifact_id": "report-qa", "version": 2,
                          "content": {"markdown": source}},
        "approved_chapters": [{"artifact_id": "chapter-1", "version": 1,
                               "content": {"title": "项目概述", "markdown": f"# 1 项目概述\n\n{OLD_MARKER}"}}],
        "abstract": {"content": {"abstract_cn": OLD_MARKER, "keywords_cn": "旧；词",
                                 "abstract_en": OLD_MARKER, "keywords_en": "old; words"}},
        "reference_plan": {"content": {"items": [{"gbt7714_entry": f"测试作者. {OLD_MARKER}[R]. 2026."}]}},
        "word_metadata": {"report_no": "QA-001", "class_no": "QA-TM", "secret_level": "公开测试",
                          "project_source": "非生产测试项目", "title_cn": "测试负荷异常识别技术报告",
                          "title_en": "Test Load Anomaly Report", "project_name": "测试项目",
                          "report_date": "2026年10月"},
    }


class FinalReportSource(unittest.TestCase):
    def test_final_heading_numbers_names_and_levels_keep_reviewed_order(self):
        source = FINAL_REPORT.replace(
            "不得把本测试解释为生产性能。",
            "不得把本测试解释为生产性能。\n\n### 1.1.1 测试边界\n\n只描述测试边界。\n\n"
            "## 测试备注\n\n保留未编号标题。\n\n### 测试说明\n\n不补造编号。",
        ).replace("表2-1 测试结果", "## 2.1 固定测试结果\n\n### 2.1.1 计算方法\n\n表2-1 测试结果")
        final = final_report_data(payload(source)["source_report"])
        document = Document()
        for chapter in final["chapters"]:
            _, errors, _ = parse_html_to_elements(document, chapter["content_html"], "CONTENT")
            self.assertEqual(errors, [])
        _configure_body(document)
        expected = [("Heading 1", "1 项目概述"), ("Heading 2", "1.1 研究范围"),
                    ("Heading 3", "1.1.1 测试边界"), ("Heading 2", "测试备注"),
                    ("Heading 3", "测试说明"), ("Heading 1", "2 配电负荷异常识别"),
                    ("Heading 2", "2.1 固定测试结果"), ("Heading 3", "2.1.1 计算方法"),
                    ("Heading 1", "3 总结")]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reviewed-headings.docx"
            document.save(path)
            readback = Document(path)
            headings = [paragraph for paragraph in readback.paragraphs
                        if paragraph.style.name.startswith("Heading ")]
            self.assertEqual([(paragraph.style.name, paragraph.text) for paragraph in headings], expected)
            for paragraph in headings:
                self.assertFalse(paragraph._p.xpath("./w:pPr/w:numPr"), "the source already supplies numbers")
                self.assertEqual(paragraph._p.pPr.find(qn("w:outlineLvl")).get(qn("w:val")),
                                 str(int(paragraph.style.name[-1]) - 1))
            errors = validate_report(str(path))["errors"]
            self.assertFalse(any("级标题“" in error for error in errors), errors)
            self.assertFalse(any("正文段内符号 run“" in error for error in errors), errors)
            unnumbered = next(paragraph for paragraph in headings if paragraph.text == "测试备注")
            for run in unnumbered.runs:
                run.font.size = Pt(12)
            readback.save(path)
            errors = validate_report(str(path))["errors"]
            self.assertIn("二级标题“测试备注”格式不符合表 B-1", errors)

    def test_numeric_prose_is_not_a_list_or_heading(self):
        prose = "1.1 这里是正文数据说明。"
        source = FINAL_REPORT.replace("不得把本测试解释为生产性能。", prose + "\n\n1. 真实列表项")
        final = final_report_data(payload(source)["source_report"])
        document = Document()
        for chapter in final["chapters"]:
            _, errors, _ = parse_html_to_elements(document, chapter["content_html"], "CONTENT")
            self.assertEqual(errors, [])
        _configure_body(document)
        paragraphs = [paragraph for paragraph in document.paragraphs if paragraph.text == prose]
        self.assertEqual(len(paragraphs), 1, "keep the complete numeric prose")
        paragraph = paragraphs[0]
        self.assertEqual(paragraph.style.name, "Normal")
        self.assertFalse(paragraph._p.xpath("./w:pPr/w:numPr"))
        self.assertEqual(paragraph.runs[0].font.size.pt, 12)
        self.assertFalse(paragraph.runs[0].font.bold)
        self.assertEqual(paragraph._p.pPr.find(qn("w:snapToGrid")).get(qn("w:val")), "0")
        list_item = next(paragraph for paragraph in document.paragraphs if paragraph.text == "真实列表项")
        self.assertEqual(list_item.style.name, "List Number")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "numeric-prose.docx"
            document.save(path)
            errors = validate_report(str(path))["errors"]
            self.assertFalse(any(f"二级标题“{prose}" in error for error in errors), errors)

    def test_final_report_replaces_prior_confirmed_chapter_text(self):
        chapters = chapter_data(payload())
        text = "\n".join(row["content_html"] for row in chapters)
        self.assertIn(FINAL_MARKER, text)
        self.assertNotIn(OLD_MARKER, text)

    def test_front_matter_and_references_are_not_body_chapters(self):
        chapters = chapter_data(payload())
        self.assertEqual([row["title"] for row in chapters],
                         ["项目概述", "配电负荷异常识别", "总结"])
        self.assertNotIn("ABSTRACT", "\n".join(row["content_html"] for row in chapters))
        self.assertNotIn("测试文献作者", "\n".join(row["content_html"] for row in chapters))

    def test_absent_final_source_keeps_standalone_chapter_support(self):
        data = payload()
        del data["source_report"]
        self.assertIn(OLD_MARKER, chapter_data(data)[0]["content_html"])

    def test_reviewed_abstracts_references_and_table_reach_word_elements(self):
        data = final_report_data(payload()["source_report"])
        abstracts = abstract_data(data["abstract"])
        self.assertIn("最终确认", abstracts["abstract_cn"])
        self.assertIn("reviewed report", abstracts["abstract_en"])
        self.assertEqual(abstracts["keywords_cn"], "电网；负荷；中位数")
        self.assertIn("测试文献作者", data["references"]["references_html"])
        document = Document()
        fragments = [abstracts["abstract_cn"], abstracts["abstract_en"],
                     *(chapter["content_html"] for chapter in data["chapters"]),
                     data["references"]["references_html"]]
        for fragment in fragments:
            _, errors, _ = parse_html_to_elements(document, fragment, "CONTENT")
            self.assertEqual(errors, [])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "final.docx"
            document.save(path)
            readback = Document(path)
            text = "\n".join(paragraph.text for paragraph in readback.paragraphs)
            self.assertIn(FINAL_MARKER, text)
            self.assertNotIn(OLD_MARKER, text)
            self.assertIn("reviewed report", text)
            self.assertIn("测试文献作者", text)
            self.assertEqual(len(readback.tables), 1)
            self.assertEqual([[cell.text for cell in row.cells] for row in readback.tables[0].rows],
                             [["指标", "数值"], ["识别数", "3"]])

    def test_file_source_and_supported_front_matter_heading_forms(self):
        source = FINAL_REPORT.replace("## 中文摘要", "# 摘要").replace("## ABSTRACT", "# Abstract")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.md"
            path.write_text("\ufeff" + source, encoding="utf-8")
            data = payload()
            data["source_report"]["content"] = {"markdown_path": str(path)}
            self.assertEqual(len(chapter_data(data)), 3)

    def test_create_receipt_uses_only_this_edition_data_directory(self):
        # Exercise the adapter's JSON and receipt paths with the real Word element
        # writer; Linux UNO template rendering is covered by container acceptance.
        def command(cmd, env, cwd):
            if cmd[-1] != "create-report":
                return subprocess.run(cmd, env={**env, "PYTHONDONTWRITEBYTECODE": "1"}, cwd=cwd,
                                      capture_output=True, text=True, check=True, timeout=20)
            directory = Path(env["TECH_REPORT_OUTPUT_DIR"])
            document = Document()
            abstracts = json.loads((directory / "abstract.json").read_text())
            for key in ("abstract_cn", "abstract_en"):
                _, errors, _ = parse_html_to_elements(document, abstracts[key], "CONTENT")
                self.assertEqual(errors, [])
            for path in sorted(directory.glob("chapter_*.json")):
                row = json.loads(path.read_text())
                _, errors, _ = parse_html_to_elements(document, row["content_html"], "CONTENT")
                self.assertEqual(errors, [])
            references = json.loads((directory / "references.json").read_text())
            _, errors, _ = parse_html_to_elements(document, references["references_html"], "CONTENT")
            self.assertEqual(errors, [])
            document.save(directory / "report.docx")
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "word"
            output.mkdir()
            stale = output / "chapter_9.json"
            stale.write_text(OLD_MARKER)
            stale_appendices = output / "appendices.json"
            stale_appendices.write_text(OLD_MARKER)
            data = payload()
            data["output_preferences"] = {"workspace_dir": str(root), "output_dir": str(output)}
            request = {"skill_name": "tech-report-writer", "action": "create_word_report", "payload": data,
                       "orchestration": {"enabled": True, "request_id": "source-qa",
                                         "caller_skill": "report-workflow-orchestrator"}}
            with patch("orchestration_adapter.run_command", side_effect=command):
                response = create_word_report(request)
            content = response["artifact"]["content"]
            current = Path(content["data_dir"])
            self.assertEqual(current.parent, output.resolve())
            self.assertEqual(Path(content["docx_path"]).parent, current)
            self.assertEqual(stale.read_text(), OLD_MARKER)
            self.assertEqual(stale_appendices.read_text(), OLD_MARKER)
            self.assertFalse((current / "chapter_9.json").exists())
            self.assertFalse((current / "appendices.json").exists())
            self.assertEqual(content["source_report_version"], 2)
            document = Document(content["docx_path"])
            text = "\n".join(paragraph.text for paragraph in document.paragraphs)
            self.assertIn(FINAL_MARKER, text)
            self.assertNotIn(OLD_MARKER, text)
            self.assertIn("最终确认", text)
            self.assertIn("reviewed report", text)
            self.assertIn("测试文献作者", text)
            self.assertEqual(len(document.tables), 1)

            del data["source_report"]
            with patch("orchestration_adapter.run_command", side_effect=command):
                legacy = create_word_report(request)["artifact"]["content"]
            self.assertNotEqual(legacy["data_dir"], content["data_dir"])
            legacy_text = "\n".join(paragraph.text for paragraph in Document(legacy["docx_path"]).paragraphs)
            self.assertIn(OLD_MARKER, legacy_text)
            self.assertNotIn(FINAL_MARKER, legacy_text)
            self.assertEqual(Path(legacy["docx_path"]).parent, Path(legacy["data_dir"]))

    def test_broken_final_sources_cannot_select_old_chapters(self):
        for source in (None, "", "Unstructured report", FINAL_REPORT.replace("# 2 配电", "# 4 配电"),
                       FINAL_REPORT.replace("# 1 项目概述", "# 1项目概述"),
                       FINAL_REPORT.replace("## ABSTRACT", "## OTHER"),
                       FINAL_REPORT.replace("| 识别数 | 3 |", "| 识别数 | 3 | 4 |")):
            with self.subTest(source_type=type(source).__name__):
                with self.assertRaises(ValueError):
                    chapter_data(payload(source))

    def test_invalid_final_source_is_blocked_without_falling_back(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = payload("This is not a final report")
            data["output_preferences"] = {"output_dir": str(root / "output")}
            request = {"skill_name": "tech-report-writer", "action": "create_word_report", "payload": data,
                       "orchestration": {"enabled": True, "request_id": "source-qa",
                                         "caller_skill": "report-workflow-orchestrator"}}
            request_path, response_path = root / "request.json", root / "response.json"
            request_path.write_text(json.dumps(request), encoding="utf-8")
            result = subprocess.run([sys.executable, "-B", str(SCRIPTS / "orchestration_adapter.py"),
                                     str(request_path), str(response_path)], capture_output=True, text=True, timeout=20,
                                    env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            response = json.loads(response_path.read_text(encoding="utf-8"))
            self.assertEqual(response["status"], "blocked")
            self.assertIn("final source_report", response["error"]["message"])
            self.assertEqual(list(root.rglob("*.docx")), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
