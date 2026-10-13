"""Preserve real QA source appendices separately from formal bibliography items."""

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

SOURCE = (SKILL / "tests/fixtures/native-reference-appendix.md").read_text(encoding="utf-8")
PREFIX, TAIL = SOURCE.split("# 参考文献\n", 1)
REFERENCES, APPENDIX = TAIL.split("# 附录 A 参考文献来源与获取链接\n", 1)


class ReportAppendices(unittest.TestCase):
    def convert(self, source: str) -> str:
        with tempfile.TemporaryDirectory(prefix="latex-appendix-") as directory:
            markdown, tex = Path(directory) / "report.md", Path(directory) / "report.tex"
            markdown.write_text(source, encoding="utf-8")
            build_tex(markdown, tex, "QA Reference Appendix Report")
            return tex.read_text(encoding="utf-8")

    def test_actual_qa_appendix_after_references_uses_formal_cli(self):
        with tempfile.TemporaryDirectory(prefix="latex-appendix-") as directory:
            tex = Path(directory) / "report.tex"
            result = subprocess.run(
                [sys.executable, "-B", str(SKILL / "scripts/markdown_to_latex.py"),
                 str(SKILL / "tests/fixtures/native-reference-appendix.md"), str(tex),
                 "--title-en", "QA Reference Appendix Report"],
                capture_output=True, text=True, timeout=15,
                env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            rendered = tex.read_text(encoding="utf-8")
        self.assertEqual(rendered.count(r"\reportbibitem{"), 4)
        self.assertEqual(rendered.count(r"\reportappendices"), 1)
        self.assertEqual(rendered.count(r"\appendixsection{参考文献来源与获取链接}"), 1)
        self.assertLess(rendered.index(r"\section{验证范围}"), rendered.index(r"\reportappendices"))
        self.assertLess(rendered.index(r"\reportappendices"), rendered.index(r"\begin{reportbibliography}"))
        appendix_tex, bibliography_tex = rendered.split(r"\begin{reportbibliography}", 1)
        for line in APPENDIX.splitlines():
            if line.strip():
                self.assertIn(escape_text(line), appendix_tex)
                self.assertNotIn(escape_text(line), bibliography_tex)
        for reference in REFERENCES.splitlines():
            if reference.strip():
                content = re.sub(r"^\[\d+\]\s*", "", reference)
                self.assertIn(r"\reportbibitem{" + escape_text(content) + "}", bibliography_tex)

    def test_appendix_before_references_follows_the_same_template_order(self):
        before = PREFIX + "# 附录 A 参考文献来源与获取链接\n" + APPENDIX + "\n# 参考文献\n" + REFERENCES
        self.assertEqual(self.convert(before), self.convert(SOURCE))

    def test_multiple_appendices_preserve_body_urls_tables_and_math(self):
        second = ("\n# 附录 B 补充核验\n\n第二份附录记录 $x=1$ 与 https://example.org/qa?x=1&y=2。\n\n"
                  "$$\ny=2\n$$\n\n表1-1 核验值\n| 参数 | 值 |\n| --- | --- |\n| x | 1 |\n")
        rendered = self.convert(SOURCE + second)
        self.assertEqual(re.findall(r"\\appendixsection\{([^}]+)\}", rendered),
                         ["参考文献来源与获取链接", "补充核验"])
        self.assertIn(r"第二份附录记录 \(x=1\) 与 https://example.org/qa?x=1\&y=2。", rendered)
        self.assertIn("\\begin{reportequation}\ny=2", rendered)
        self.assertIn(r"\reporttablecaption{核验值}", rendered)
        self.assertIn("x & 1", rendered)
        self.assertEqual(rendered.count(r"\reportbibitem{"), 4)

    def test_invalid_or_duplicate_appendix_labels_fail(self):
        for heading in ("# 附录 A 重复", "# 附录 a 小写", "# 附录 AA 超界", "# 附录 1 数字",
                        "# 附录 B", "# 附录 缺少编号"):
            with self.subTest(heading=heading), self.assertRaisesRegex(ValueError, "appendix"):
                self.convert(SOURCE + "\n" + heading + "\n正文保留。\n")

    def test_authored_appendix_label_gaps_are_not_silently_renumbered(self):
        rendered = self.convert(SOURCE + "\n# 附录 C 补充核验\n\nC.1 原编号正文。\n")
        self.assertIn("\\setcounter{section}{2}\n\\appendixsection{补充核验}", rendered)
        self.assertIn("C.1 原编号正文。", rendered)
        with self.assertRaisesRegex(ValueError, "appendix"):
            self.convert(SOURCE + "\n# 附录 C 补充\n\n正文。\n# 附录 B 倒序\n\n正文。\n")

    def test_ordinary_report_without_appendices_keeps_four_references(self):
        rendered = self.convert(PREFIX + "# 参考文献\n" + REFERENCES)
        self.assertEqual(rendered.count(r"\reportbibitem{"), 4)
        self.assertNotIn(r"\reportappendices", rendered)
        self.assertNotIn(r"\appendixsection", rendered)
        self.assertIn(r"\section{验证范围}", rendered)

    def test_actual_bold_keywords_are_parsed_without_marker_leakage(self):
        parsed = parse_front_matter(SOURCE.splitlines())
        self.assertEqual(parsed[2], "配电负荷，数据质量核查，中位数绝对偏差，修正标准分数，混淆矩阵")
        self.assertEqual(parsed[4], "distribution load, data quality check, median absolute deviation, modified z-score, confusion matrix")
        self.assertNotIn("**", parsed[1] + parsed[2] + parsed[3] + parsed[4])


if __name__ == "__main__":
    unittest.main(verbosity=2)
