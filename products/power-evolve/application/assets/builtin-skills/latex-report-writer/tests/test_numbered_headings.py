"""Standard-library regressions for confirmed report Markdown conversion."""

from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
from markdown_to_latex import build_tex, clean_heading, parse_front_matter, render_body


MARKDOWN = r"""# 2026 技术报告

# 摘要
中文摘要来自最终确认输入。
关键词：配电；验证

# Abstract
The supplied abstract describes the confirmed report.
Keywords: distribution; validation

# 1 项目概述
项目正文保留引用 [1] 与行内公式 $E=mc^2$。

## 1.1 研究范围
1 项目中的数字是正文。

# 2 研究方法
## 2.1 模型与验证
### 2.1.1 计算关系
2.1.1 本段中的数字也是正文。

\[
P = \frac{U^2}{R}\label{eq:power}
\]

式中，$U$ 为电压。

表2-1 输入参数
| 参数 | 数值 |
| --- | ---: |
| 电压 $U$ | 220 |
| 电阻 $R$ | 10 |

# 参考文献
[1] 测试作者. 配电验证方法[M]. 北京: 测试出版社, 2026.
"""


class NumberedReportHeadings(unittest.TestCase):
    def test_confirmed_markdown_uses_existing_cli_without_content_loss(self):
        with tempfile.TemporaryDirectory(prefix="latex-heading-") as directory:
            source = Path(directory) / "confirmed.md"
            destination = Path(directory) / "confirmed.tex"
            source.write_text(MARKDOWN, encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SKILL / "scripts/markdown_to_latex.py"),
                 str(source), str(destination), "--title-en", "Confirmed Technical Report"],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            generated = destination.read_text(encoding="utf-8")
        self.assertEqual(
            re.findall(r"\\(section|subsection|subsubsection)\{([^}]+)\}", generated),
            [("section", "项目概述"), ("subsection", "研究范围"),
             ("section", "研究方法"), ("subsection", "模型与验证"),
             ("subsubsection", "计算关系")],
        )
        self.assertNotIn(r"\setcounter{section}", generated)
        self.assertIn("title-cn={2026 技术报告}", generated)
        self.assertIn("中文摘要来自最终确认输入。", generated)
        self.assertIn("The supplied abstract describes the confirmed report.", generated)
        self.assertIn(r"项目正文保留引用 [1] 与行内公式 \(E=mc^2\)。", generated)
        self.assertIn("1 项目中的数字是正文。", generated)
        self.assertIn("2.1.1 本段中的数字也是正文。", generated)
        self.assertIn(r"\begin{reportequation}", generated)
        self.assertIn(r"P = \frac{U^2}{R}\label{eq:power}", generated)
        self.assertIn(r"\reporttablecaption{输入参数}", generated)
        self.assertIn(r"电压 \(U\) & 220", generated)
        self.assertIn(r"电阻 \(R\) & 10", generated)
        self.assertIn(r"\reportbibitem{测试作者. 配电验证方法[M]. 北京: 测试出版社, 2026.}", generated)

    def test_arabic_and_chinese_chapters_produce_the_same_hierarchy(self):
        with tempfile.TemporaryDirectory(prefix="latex-heading-") as directory:
            root = Path(directory)
            source, destination = root / "confirmed.md", root / "confirmed.tex"
            results = []
            for markdown in (MARKDOWN, MARKDOWN.replace("# 1 项目概述", "# 第一章 项目概述")
                             .replace("# 2 研究方法", "# 第2章 研究方法")):
                source.write_text(markdown, encoding="utf-8")
                build_tex(source, destination, "Confirmed Technical Report")
                results.append(destination.read_text(encoding="utf-8"))
            self.assertEqual(results[0], results[1])

    def test_front_matter_and_plain_numbers_do_not_start_chapters(self):
        parsed = parse_front_matter(MARKDOWN.splitlines())
        self.assertEqual(MARKDOWN.splitlines()[parsed[5]], "# 1 项目概述")
        self.assertEqual(MARKDOWN.splitlines()[parsed[6]], "# 参考文献")
        rendered = render_body(["# 摘要", "1 数字正文", "# 参考文献", "2.1 数字正文"])
        self.assertNotRegex(rendered, r"\\section\{")
        self.assertIn(r"\section*{摘要}", rendered)
        self.assertIn(r"\section*{参考文献}", rendered)
        self.assertIn("1 数字正文", rendered)
        self.assertIn("2.1 数字正文", rendered)

    def test_authored_heading_number_gaps_are_retained(self):
        rendered = render_body([
            "# 3 验证方法", "## 3.4 边界条件", "### 3.4.2 计算过程",
            "# 5 结论", "## 5.1 应用范围", "### 5.1.1 工程建议",
        ])
        self.assertIn("\\setcounter{section}{2}\n\\section{验证方法}", rendered)
        self.assertIn("\\setcounter{subsection}{3}\n\\subsection{边界条件}", rendered)
        self.assertIn("\\setcounter{subsubsection}{1}\n\\subsubsection{计算过程}", rendered)
        self.assertIn("\\setcounter{section}{4}\n\\section{结论}", rendered)
        self.assertIn(r"\subsection{应用范围}", rendered)
        self.assertIn(r"\subsubsection{工程建议}", rendered)

    def test_heading_prefixes_require_the_correct_depth_and_separator(self):
        for level, heading in ((1, "1.1 研究范围"), (1, "1项目概述"),
                               (2, "1.1.1 计算关系"), (2, "1.1范围"),
                               (3, "2.1.1.2 计算步骤")):
            with self.subTest(level=level, heading=heading):
                self.assertEqual(clean_heading(heading, level), heading)

    def test_legacy_chinese_chapter_numbers_are_retained(self):
        for chapter, number in (("第十章", 10), ("第十二章", 12), ("第二十一章", 21),
                                ("第一百二十三章", 123), ("第12章", 12)):
            with self.subTest(chapter=chapter):
                rendered = render_body([f"# {chapter}验证方法", f"## {number}.1 研究范围"])
                self.assertIn(f"\\setcounter{{section}}{{{number - 1}}}", rendered)
                self.assertIn(r"\section{验证方法}", rendered)
                self.assertIn(r"\subsection{研究范围}", rendered)

    def test_inconsistent_numbered_parent_fails_without_renumbering(self):
        for lines in (["# 1 项目概述", "## 2.1 研究范围"],
                      ["# 2 研究方法", "## 2.1 研究范围", "### 2.2.1 计算关系"]):
            with self.subTest(lines=lines):
                with self.assertRaisesRegex(ValueError, "does not match its parent"):
                    render_body(lines)

    def test_report_requires_a_numbered_chapter(self):
        markdown = MARKDOWN.replace("# 1 项目概述", "# 项目概述")\
            .replace("# 2 研究方法", "# 研究方法")
        with self.assertRaisesRegex(ValueError, "numbered level-1 chapter"):
            parse_front_matter(markdown.splitlines())

    def test_required_english_metadata_remains_required(self):
        with tempfile.TemporaryDirectory(prefix="latex-heading-") as directory:
            source, destination = Path(directory) / "confirmed.md", Path(directory) / "confirmed.tex"
            source.write_text(MARKDOWN, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "--title-en"):
                build_tex(source, destination, " ")
            for missing in ("The supplied abstract describes the confirmed report.",
                            "Keywords: distribution; validation"):
                source.write_text(MARKDOWN.replace(missing, ""), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "supplied explicitly"):
                    build_tex(source, destination, "Confirmed Technical Report")
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
