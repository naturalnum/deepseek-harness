"""Container-only XeLaTeX checks of authored headings and contents numbers."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_numbered_headings import MARKDOWN

SKILL = Path(__file__).resolve().parents[1]


class NumberedHeadingsCompilation(unittest.TestCase):
    def test_confirmed_markdown_compiles_with_matching_heading_and_contents_numbers(self):
        root = Path(os.environ.get("LATEX_COMPAT_OUTPUT", tempfile.mkdtemp(prefix="latex-heading-compile-")))
        sparse = MARKDOWN.replace("# 1 项目概述", "# 3 项目概述").replace("## 1.1 研究范围", "## 3.4 研究范围")\
            .replace("# 2 研究方法", "# 5 研究方法").replace("## 2.1 模型与验证", "## 5.1 模型与验证")\
            .replace("### 2.1.1 计算关系", "### 5.1.1 计算关系").replace("表2-1", "表5-1")
        for name, markdown, numbers in (
            ("confirmed", MARKDOWN, ("1", "1.1", "2", "2.1", "2.1.1")),
            ("sparse", sparse, ("3", "3.4", "5", "5.1", "5.1.1")),
        ):
            with self.subTest(name=name):
                output = root / name
                output.mkdir(parents=True, exist_ok=True)
                source, tex = output / "report.md", output / "report.tex"
                source.write_text(markdown, encoding="utf-8")
                for path in (SKILL / "assets/template").iterdir():
                    if path.is_file():
                        shutil.copy2(path, output / path.name)
                subprocess.run(
                    [sys.executable, str(SKILL / "scripts/markdown_to_latex.py"), str(source), str(tex),
                     "--title-en", "Confirmed Technical Report", "--font-profile", "portable"], check=True,
                )
                stdout = output / "build.stdout"
                with stdout.open("w") as stream:
                    result = subprocess.run(
                        [sys.executable, str(SKILL / "scripts/build_latex_report.py"), str(tex)],
                        stdout=stream, stderr=subprocess.STDOUT,
                    )
                self.assertEqual(result.returncode, 0, stdout.read_text()[-4000:])
                subprocess.run([sys.executable, str(SKILL / "scripts/validate_latex_report.py"),
                                str(tex.with_suffix(".pdf")), "--log", str(tex.with_suffix(".log")),
                                "--font-profile", "portable"], check=True, capture_output=True, text=True)
                text = subprocess.check_output(["pdftotext", "-layout", str(tex.with_suffix(".pdf")), "-"], text=True)
                (output / "report.txt").write_text(text, encoding="utf-8")
                headings = ("项目概述", "研究范围", "研究方法", "模型与验证", "计算关系")
                for number, title in zip(numbers, headings):
                    self.assertRegex(text, rf"(?m)^\s*{re.escape(number)}\s+{title}\s*$")
                    self.assertIn(r"\numberline {" + number + "}" + title, tex.with_suffix(".toc").read_text())
                self.assertNotRegex(text, r"(?m)^\s*(?:1\s+1|3\s+3)\s+项目概述")
                compact = re.sub(r"\s+", "", text)
                chapter = numbers[2]
                self.assertIn("表" + chapter + "-1输入参数", compact)
                self.assertIn("（" + chapter + "-1）", compact)
                self.assertIn("[1]测试作者.", compact)
                self.assertIn("电压U220", compact)
                self.assertIn("电阻R10", compact)
                self.assertIn(r"\newlabel{eq:power}{{" + chapter + "-1}", tex.with_suffix(".aux").read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
