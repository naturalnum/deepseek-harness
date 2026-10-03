"""Fixed-Runner component build of real SVG, PNG, JPEG and PDF report figures."""

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

from test_numbered_headings import MARKDOWN

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
from report_images import svg_to_pdf


class LocalImagesCompilation(unittest.TestCase):
    def test_real_local_figures_compile_without_shell_escape(self):
        root = Path(os.environ.get("LATEX_COMPAT_OUTPUT", tempfile.mkdtemp(prefix="latex-image-compile-"))) / "images"
        source_directory, output = root / "source", root / "export"
        source_directory.mkdir(parents=True, exist_ok=True)
        output.mkdir(parents=True, exist_ok=True)
        svg = (SKILL / "tests/fixtures/native-research-flow.svg").read_bytes()
        self.assertEqual(hashlib.sha256(svg).hexdigest(), "286a8047a0ae3d5e2b8c68565f4a43ba8b2f8f2044446e6e8f9acc89bd93cfac")
        (source_directory / "diagram.svg").write_bytes(svg)
        (source_directory / "diagram.pdf").write_bytes(svg_to_pdf(svg))
        subprocess.run(["pdftoppm", "-png", "-singlefile", "-r", "110",
                        str(source_directory / "diagram.pdf"), str(source_directory / "diagram")], check=True)
        with Image.open(source_directory / "diagram.png") as image:
            image.convert("RGB").save(source_directory / "diagram.jpg", quality=95)
        svg_figure = "![图1-1 配电负荷异常识别研究思路](diagram.svg)\n\n图1-1 配电负荷异常识别研究思路\n"
        other_figures = "\n".join(f"![图2-{index} {format}格式验证](diagram.{format})\n"
                                  for index, format in enumerate(("png", "jpg", "pdf"), 1))
        markdown = MARKDOWN.replace("# 2 研究方法", svg_figure + "\n# 2 研究方法")\
            .replace("# 参考文献", other_figures + "\n# 参考文献")
        source, tex = source_directory / "report.md", output / "report.tex"
        source.write_text(markdown, encoding="utf-8")
        for path in (SKILL / "assets/template").iterdir():
            if path.is_file():
                shutil.copy2(path, output / path.name)
        conversion = subprocess.run([sys.executable, str(SKILL / "scripts/markdown_to_latex.py"), str(source), str(tex),
                                     "--title-en", "Local Figure Component Report", "--font-profile", "portable"], text=True, capture_output=True)
        (output / "conversion.stdout").write_text(conversion.stdout + conversion.stderr)
        self.assertEqual(conversion.returncode, 0, conversion.stderr)
        generated = tex.read_text()
        self.assertEqual(generated.count(r"\includegraphics["), 4)
        self.assertEqual(generated.count(r"\caption{配电负荷异常识别研究思路}"), 1)
        self.assertNotIn(r"\reportfigureplaceholder", generated)
        self.assertNotIn("![", generated)
        # The exported project compiles after its source images are removed.
        shutil.rmtree(source_directory)
        with (output / "build.stdout").open("w") as stream:
            build = subprocess.run([sys.executable, str(SKILL / "scripts/build_latex_report.py"), str(tex)],
                                   stdout=stream, stderr=subprocess.STDOUT)
        self.assertEqual(build.returncode, 0, (output / "build.stdout").read_text()[-4000:])
        subprocess.run([sys.executable, str(SKILL / "scripts/validate_latex_report.py"),
                        str(tex.with_suffix(".pdf")), "--log", str(tex.with_suffix(".log")),
                        "--font-profile", "portable"], check=True, capture_output=True, text=True)
        self.assertIn("-no-shell-escape", (output / "build.stdout").read_text())
        text = subprocess.check_output(["pdftotext", "-layout", str(tex.with_suffix(".pdf")), "-"], text=True)
        (output / "report.txt").write_text(text)
        compact = re.sub(r"\s+", "", text)
        self.assertIn("校准集(16条)", compact)
        self.assertIn("中位数/MAD", compact)
        self.assertIn("混淆矩阵", compact)
        self.assertIn("图1-1配电负荷异常识别研究思路", compact)
        self.assertIn("图2-1png格式验证", compact)
        self.assertIn("图2-2jpg格式验证", compact)
        self.assertIn("图2-3pdf格式验证", compact)
        self.assertIn("表2-1输入参数", compact)
        self.assertIn("（2-1）", compact)
        self.assertIn("[1]测试作者.", compact)
        images = subprocess.check_output(["pdfimages", "-list", str(tex.with_suffix(".pdf"))], text=True)
        (output / "pdfimages.txt").write_text(images)
        self.assertGreaterEqual(len(re.findall(r"(?m)^\s*\d+\s+\d+\s+image", images)), 2)
        self.assertIn("jpeg", images)


if __name__ == "__main__":
    unittest.main(verbosity=2)
