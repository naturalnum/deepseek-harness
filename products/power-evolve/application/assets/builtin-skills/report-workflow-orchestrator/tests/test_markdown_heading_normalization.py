"""Synthetic Markdown through both real normalizer CLIs, heading validator and Word parser.

Run: PYTHONDONTWRITEBYTECODE=1 python3 tests/test_markdown_heading_normalization.py
No model, document generation or infrastructure is used.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT.parent / "power-grid-technical-report-writer"
sys.path.insert(0, str(ROOT.parent / "tech-report-writer" / "scripts"))
from orchestration_adapter import final_report_data

NORMALIZERS = [ROOT / "scripts" / "normalize_markdown.py", GENERATOR / "scripts" / "normalize_markdown.py"]
TITLES = ["项目概述", "电力负荷预测技术", "总结与展望"]
OUTLINE = {"chapters": [
    {"id": str(i), "title": title, "section_outline": [
        {"level": 2, "number": f"{i}.1", "title": "电力研究内容"},
        {"level": 3, "number": f"{i}.1.1", "title": "电力研究边界"},
    ] if i < 3 else []} for i, title in enumerate(TITLES, 1)
]}


def report(chinese_numbering=False):
    text = "# 合成报告\n\n# 摘要\n\n合成中文摘要。\n\n关键词：电力；负荷\n\n# Abstract\n\nSynthetic abstract.\n\nKeywords: power; load\n\n"
    for i, title in enumerate(TITLES, 1):
        number = f"第{i}章" if chinese_numbering else str(i)
        text += f"# {number} {title}\n\n正文 20 字—保留内容。\n\n"
        if i < 3:
            text += f"## {i}.1 电力研究内容\n\n段落内容。\n\n### {i}.1.1 电力研究边界\n\n边界内容。\n\n"
    return text + "# 参考文献\n\n[1] Synthetic reference.\n"


class MarkdownHeadingNormalizationTest(unittest.TestCase):
    def run_cli(self, script, *args):
        return subprocess.run([sys.executable, str(script), *map(str, args)],
                              capture_output=True, text=True, timeout=10,
                              env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))

    def normalize(self, script, source, directory):
        original, output = directory / "input.md", directory / "output.md"
        original.write_text(source, encoding="utf-8")
        result = self.run_cli(script, original, "--output", output)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(original.read_text(encoding="utf-8"), source)
        return output

    def test_normalized_report_passes_real_heading_coverage_with_locked_levels_and_order(self):
        for script in NORMALIZERS:
            for chinese_numbering in (False, True):
                with self.subTest(script=script.parent.parent.name, chinese_numbering=chinese_numbering), tempfile.TemporaryDirectory() as directory:
                    directory = Path(directory)
                    source = report(chinese_numbering)
                    output = self.normalize(script, source, directory)
                    text = output.read_text(encoding="utf-8")
                    outline = directory / "outline.json"
                    outline.write_text(json.dumps(OUTLINE, ensure_ascii=False), encoding="utf-8")
                    validated = self.run_cli(GENERATOR / "scripts" / "validate_heading_coverage.py", output, "--outline", outline)
                    self.assertEqual(validated.returncode, 0, validated.stdout + validated.stderr)
                    self.assertEqual([line for line in text.splitlines() if line.startswith("#")],
                                     [line for line in source.splitlines() if line.startswith("#")])

    def test_word_parser_reads_the_normalized_final_report(self):
        for script in NORMALIZERS:
            for chinese_numbering in (False, True):
                with self.subTest(script=script.parent.parent.name, chinese_numbering=chinese_numbering), tempfile.TemporaryDirectory() as directory:
                    output = self.normalize(script, report(chinese_numbering), Path(directory))
                    text = output.read_text(encoding="utf-8")
                    projected = final_report_data({"artifact_type": "report", "artifact_id": "synthetic-report", "version": 2, "content": text})
                    self.assertEqual([(row["num"], row["title"]) for row in projected["chapters"]], list(enumerate(TITLES, 1)))
                    self.assertIn("正文20字-保留内容。", projected["chapters"][0]["content_html"])
                    self.assertEqual(projected["abstract"]["abstract_cn"], "合成中文摘要。")
                    self.assertIn("Synthetic reference", projected["references"]["references_html"])

    def test_heading_prefix_is_protected_while_heading_text_and_prose_are_cleaned(self):
        source = "   #### 2.1.1 电力 20 对象—说明\n# 第 2 章 电力 20 对象—说明\n正文 20 字—说明。\n`正文 20 字—说明`\n```md\n## 2.1 电力 20 对象—说明\n```\n"
        expected = "   #### 2.1.1 电力20对象-说明\n# 第 2 章 电力20对象-说明\n正文20字-说明。\n`正文 20 字—说明`\n```md\n## 2.1 电力 20 对象—说明\n```\n"
        for script in NORMALIZERS:
            with self.subTest(script=script.parent.parent.name), tempfile.TemporaryDirectory() as directory:
                output = self.normalize(script, source, Path(directory))
                self.assertEqual(output.read_text(encoding="utf-8"), expected)


if __name__ == "__main__":
    unittest.main()
