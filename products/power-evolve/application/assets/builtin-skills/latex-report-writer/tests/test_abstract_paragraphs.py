"""Preserve actual reviewed bilingual abstract paragraphs without raw TeX prose."""

import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
from markdown_to_latex import build_tex, escape_text, parse_front_matter

SOURCE = (SKILL / "tests/fixtures/native-three-paragraph-abstracts.md").read_text(encoding="utf-8")
CN_BLOCK = SOURCE.split("# 摘要\n", 1)[1].split("**关键词：**", 1)[0].strip()
EN_BLOCK = SOURCE.split("# Abstract\n", 1)[1].split("**Keywords:**", 1)[0].strip()
CN_PARAGRAPHS = re.split(r"\n\s*\n", CN_BLOCK)
EN_PARAGRAPHS = re.split(r"\n\s*\n", EN_BLOCK)


def report(cn: str, en: str) -> str:
    return ("# 段落兼容 QA 报告\n\n# 摘要\n" + cn + "\n\n**关键词：** 配电；验证\n\n"
            "# Abstract\n" + en + "\n\n**Keywords:** distribution; validation\n\n"
            "# 1 验证范围\n正文。\n\n# 参考文献\n[1] 测试条目[M]. 2026.\n")


class AbstractParagraphs(unittest.TestCase):
    def convert(self, markdown: str) -> str:
        with tempfile.TemporaryDirectory(prefix="latex-abstract-") as directory:
            source, destination = Path(directory) / "source.md", Path(directory) / "report.tex"
            source.write_text(markdown, encoding="utf-8")
            build_tex(source, destination, "QA Abstract Paragraph Report")
            return destination.read_text(encoding="utf-8")

    def test_actual_three_paragraphs_keep_exact_word_order_and_return_type(self):
        parsed = parse_front_matter(SOURCE.splitlines())
        self.assertEqual(len(CN_PARAGRAPHS), 3)
        self.assertEqual(len(EN_PARAGRAPHS), 3)
        self.assertIsInstance(parsed[1], str)
        self.assertIsInstance(parsed[3], str)
        self.assertEqual(parsed[1].split("\n\n"), CN_PARAGRAPHS)
        self.assertEqual(parsed[3].split("\n\n"), EN_PARAGRAPHS)

    def test_actual_three_paragraphs_use_escaped_tex_boundaries_through_cli(self):
        with tempfile.TemporaryDirectory(prefix="latex-abstract-") as directory:
            destination = Path(directory) / "report.tex"
            result = subprocess.run(
                [sys.executable, "-B", str(SKILL / "scripts/markdown_to_latex.py"),
                 str(SKILL / "tests/fixtures/native-three-paragraph-abstracts.md"),
                 str(destination), "--title-en", "QA Abstract Paragraph Report"],
                capture_output=True, text=True, timeout=15,
                env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            rendered = destination.read_text(encoding="utf-8")
        self.assertIn("abstract-cn={" + "\\endgraf\n".join(map(escape_text, CN_PARAGRAPHS)) + "},", rendered)
        self.assertIn("abstract-en={" + "\\endgraf\n".join(map(escape_text, EN_PARAGRAPHS)) + "},", rendered)
        self.assertEqual(rendered.count(r"\endgraf"), 4)
        self.assertIn("title-cn={配电负荷异常识别 QA 技术报告}", rendered)
        self.assertIn("keywords-cn={配电负荷，数据质量核查，中位数绝对偏差，修正标准分数，混淆矩阵}", rendered)

    def test_continuous_lines_stay_one_paragraph_and_blank_lines_split(self):
        parsed = parse_front_matter(report("中文第一行。\n连续第二行。\n\n\n中文第二段。",
                                          "First line.\nContinued line.\n \nSecond paragraph.").splitlines())
        self.assertEqual(parsed[1], "中文第一行。 连续第二行。\n\n中文第二段。")
        self.assertEqual(parsed[3], "First line. Continued line.\n\nSecond paragraph.")
        self.assertEqual(parsed[2], "配电；验证")
        self.assertEqual(parsed[4], "distribution; validation")

    def test_ordinary_single_paragraph_and_inline_math_remain_compatible(self):
        cn, en = r"中文摘要包含 $\mu=1$。", "The supplied abstract contains $x=2$."
        parsed = parse_front_matter(report(cn, en).splitlines())
        self.assertEqual((parsed[1], parsed[3]), (cn, en))
        rendered = self.convert(report(cn, en))
        self.assertIn(r"abstract-cn={中文摘要包含 \(\mu=1\)。}", rendered)
        self.assertIn(r"abstract-en={The supplied abstract contains \(x=2\).}", rendered)
        self.assertNotIn(r"\endgraf", rendered)

    def test_each_paragraph_escapes_prose_commands_and_retains_cjk_inline_math(self):
        cn = "原文 \\input{secret} 与 10%。\n\n中文关系 $\\mu=1$ 与 $x_1=2$。"
        rendered = self.convert(report(cn, "First paragraph & text.\n\nSecond paragraph #2."))
        self.assertIn(r"原文 \textbackslash{}input\{secret\} 与 10\%。\endgraf", rendered)
        self.assertNotIn(r"\input{secret}", rendered)
        self.assertIn(r"中文关系 \(\mu=1\) 与 \(x_1=2\)。", rendered)
        self.assertIn("First paragraph \\& text.\\endgraf\nSecond paragraph \\#2.", rendered)


if __name__ == "__main__":
    unittest.main(verbosity=2)
