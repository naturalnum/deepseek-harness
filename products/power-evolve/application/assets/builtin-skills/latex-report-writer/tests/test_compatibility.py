"""Container-only explicit-title regression with a real two-pass XeLaTeX build."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
from markdown_to_latex import build_tex

MARKDOWN = """# 技能兼容性技术报告

# 摘要
中文摘要来自明确输入，转换器不得覆盖。
关键词：兼容性；测试

# Abstract
The supplied abstract must remain unchanged.
Keywords: compatibility; test

# 第一章 验证方法
本报告仅验证转换和编译流程。关系为 $E=mc^2$。

## 1.1 编译检查
通用报告标题应能与明确提供的英文标题一起编译。

# 参考文献
[1] 测试作者. 编译验证方法[M]. 北京: 测试出版社, 2026.
"""


class LatexCompatibility(unittest.TestCase):
    def test_explicit_title_compiles_and_missing_title_fails(self):
        root = Path(os.environ.get("LATEX_COMPAT_OUTPUT", tempfile.mkdtemp(prefix="latex-compat-")))
        root.mkdir(parents=True, exist_ok=True)
        source, tex = root / "generic.md", root / "generic.tex"
        source.write_text(MARKDOWN, encoding="utf-8")
        for path in (SKILL / "assets/template").iterdir():
            if path.is_file():
                shutil.copy2(path, root / path.name)
        command = [sys.executable, str(SKILL / "scripts/markdown_to_latex.py"), str(source), str(tex)]
        missing = subprocess.run(command, text=True, capture_output=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("--title-en", missing.stderr)
        blank = subprocess.run(command + ["--title-en", "   "], text=True, capture_output=True)
        self.assertNotEqual(blank.returncode, 0)
        self.assertFalse(tex.exists())
        with self.assertRaisesRegex(ValueError, "supplied explicitly"):
            source.write_text(MARKDOWN.replace("The supplied abstract must remain unchanged.", ""), encoding="utf-8")
            build_tex(source, tex, "Runtime Compatibility Report")
        source.write_text(MARKDOWN, encoding="utf-8")
        subprocess.run(command + ["--title-en", "Runtime Compatibility & Report", "--font-profile", "portable"], check=True)
        generated = tex.read_text()
        self.assertIn("Runtime Compatibility \\& Report", generated)
        self.assertIn("中文摘要来自明确输入", generated)
        self.assertIn("The supplied abstract must remain unchanged.", generated)
        log = root / "build.stdout"
        with log.open("w") as output:
            process = subprocess.run([sys.executable, str(SKILL / "scripts/build_latex_report.py"), str(tex)],
                                     stdout=output, stderr=subprocess.STDOUT)
        self.assertEqual(process.returncode, 0, log.read_text()[-4000:])
        subprocess.run([sys.executable, str(SKILL / "scripts/validate_latex_report.py"),
                        str(tex.with_suffix(".pdf")), "--log", str(tex.with_suffix(".log")),
                        "--font-profile", "portable"], check=True, capture_output=True, text=True)
        pdf = tex.with_suffix(".pdf")
        self.assertGreater(pdf.stat().st_size, 0)
        text = subprocess.check_output(["pdftotext", str(pdf), "-"], text=True)
        self.assertIn("Runtime Compatibility & Report", text)
        self.assertIn("技能兼容性技术报告", text)
        self.assertIn("The supplied abstract must remain unchanged.", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
