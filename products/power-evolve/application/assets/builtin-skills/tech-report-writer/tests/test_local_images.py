"""Local report figures must reach Word or stop generation explicitly."""
from contextlib import contextmanager
from pathlib import Path
import os
import sys
import tempfile
import unittest
from zipfile import ZipFile

from docx import Document
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from orchestration_adapter import final_report_data, inline_markdown, chapter_data
from local_images import validate_svg
from engine.parser import parse_html_to_elements
from test_orchestration_adapter import FINAL_REPORT, payload


@contextmanager
def working_directory(path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def report_with_image(path):
    return FINAL_REPORT.replace("不得把本测试解释为生产性能。",
                                f"![图1-1 受控测试图]({path})\n\n图1-1 受控测试图")


class LocalReportImages(unittest.TestCase):
    def test_file_backed_markdown_uses_its_directory_and_inline_code_stays_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "review/figures").mkdir(parents=True)
            Image.new("RGB", (96, 48), "blue").save(root / "review/figures/figure.png")
            (root / "review/final.md").write_text(report_with_image("figures/figure.png"))
            with working_directory(root):
                result = final_report_data({"content": {"markdown_path": "review/final.md"}})
                self.assertIn("<img src='data:image/png;base64,", result["chapters"][0]["content_html"])
                self.assertEqual(inline_markdown("`![例子](missing.png)`"), "<code>![例子](missing.png)</code>")

    def test_relative_png_and_jpeg_become_real_word_media_with_one_caption(self):
        for suffix, image_format in (("png", "PNG"), ("jpg", "JPEG")):
            with self.subTest(format=image_format), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "figures").mkdir()
                Image.new("RGB", (96, 48), "#2b6cb0").save(root / f"figures/figure.{suffix}", image_format)
                (root / "final.md").write_text(report_with_image(f"figures/figure.{suffix}"))
                source = {"content": {"markdown_path": "final.md"}}
                with working_directory(root):
                    data = final_report_data(source)
                document = Document()
                for chapter in data["chapters"]:
                    _, errors, warnings = parse_html_to_elements(document, chapter["content_html"], "CONTENT")
                    self.assertEqual(errors, [])
                    self.assertEqual(warnings, [])
                self.assertEqual(len(document.inline_shapes), 1)
                self.assertEqual(sum(p.text == "图1-1 受控测试图" for p in document.paragraphs), 1)
                output = root / "report.docx"
                document.save(output)
                with ZipFile(output) as archive:
                    self.assertEqual(len([name for name in archive.namelist() if name.startswith("word/media/")]), 1)

    def test_missing_invalid_remote_or_escaping_images_stop_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bad.png").write_text("not an image")
            for path in ("missing.png", "bad.png", "https://example.test/image.png",
                         "../outside.png", "/tmp/outside.png", "file:///tmp/outside.png"):
                with self.subTest(path=path), working_directory(root):
                    with self.assertRaises(ValueError):
                        final_report_data(payload(report_with_image(path))["source_report"])
            with working_directory(root), self.assertRaises(ValueError):
                chapter_data({"approved_chapters": [{"content": {"title": "旧调用", "html":
                              '<h1>1 旧调用</h1><p><img src="https://example.test/image.png"/></p>'}}]})

    def test_symlink_components_cannot_expand_the_material_root(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            Image.new("RGB", (96, 48), "red").save(Path(outside) / "external.png")
            (root / "link.png").symlink_to(Path(outside) / "external.png")
            (root / "figures").symlink_to(outside, target_is_directory=True)
            for path in ("link.png", "figures/external.png"):
                with self.subTest(path=path), working_directory(root):
                    with self.assertRaises(ValueError):
                        final_report_data(payload(report_with_image(path))["source_report"])

    def test_svg_preserves_internal_markers_and_rejects_external_or_active_content(self):
        safe = b'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220"><defs><marker id="a"><path d="M0,0 L8,3 L0,6 z"/></marker></defs><line x1="1" x2="20" marker-end="url(#a)"/></svg>'
        checked, width, height = validate_svg(safe)
        self.assertIn(b'url(#a)', checked)
        self.assertEqual((width, height), (900, 220))
        for body in ('<script/>', '<foreignObject/>', '<image href="file:///tmp/private"/>',
                     '<use href="https://example.test/external.svg#a"/>', '<use href="../private.svg#a"/>',
                     '<rect fill="url(file:///tmp/private)"/>', '<rect style="fill: u\\rl(file:///tmp/private)"/>',
                     '<rect style="@import url(https://example.test/style)"/>', '<rect xml:base="/tmp"/>',
                     '<rect onclick="run()"/>'):
            with self.subTest(body=body), self.assertRaises(ValueError):
                validate_svg(('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220">' + body + '</svg>').encode())
        for prefix in ('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///tmp/private">]>', '<?external file="/tmp/private"?>'):
            with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                validate_svg(prefix.encode() + safe)
        with self.assertRaises(ValueError):
            validate_svg(safe.replace(b'width="900"', b'width="9000000"'))
        with self.assertRaises(ValueError):
            validate_svg(b'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220"/>')


if __name__ == "__main__":
    unittest.main(verbosity=2)
