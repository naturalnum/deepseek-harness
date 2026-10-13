"""Existing converter entry checks for local report figures and rejected sources."""

from io import BytesIO
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NullObject, NumberObject, TextStringObject
from reportlab.pdfgen.canvas import Canvas

from test_numbered_headings import MARKDOWN

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
from markdown_to_latex import build_tex


class LocalImages(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="latex-image-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source/report.md"
        self.source.parent.mkdir()
        self.destination = self.root / "export/report.tex"

    def convert(self, reference, alt="图2-3 研究思路", following=""):
        figure = f"![{alt}]({reference})\n\n{following}\n"
        self.source.write_text(MARKDOWN.replace("# 参考文献", figure + "\n# 参考文献"), encoding="utf-8")
        build_tex(self.source, self.destination, "Confirmed Technical Report")
        return self.destination.read_text()

    def raster(self, name, format="PNG"):
        path = self.source.parent / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (24, 12), (20, 110, 180)).save(path, format=format)
        return path

    def test_png_and_jpeg_use_real_graphics_relative_to_source(self):
        for name, format in (("figures/diagram.png", "PNG"), ("figures/diagram.jpg", "JPEG"),
                             ("figures/中文 图.jpeg", "JPEG")):
            with self.subTest(name=name):
                source = self.raster(name, format)
                reference = f"<{name}>" if " " in name else name
                generated = self.convert(reference, following="图2-3 研究思路")
                self.assertIn(r"\includegraphics[", generated)
                self.assertIn(r"\setcounter{figure}{2}", generated)
                self.assertEqual(generated.count(r"\caption{研究思路}"), 1)
                self.assertNotIn("![", generated)
                self.assertNotIn(r"\reportfigureplaceholder", generated)
                assets = list((self.destination.parent / "report-images").glob("*"))
                self.assertTrue(any(path.read_bytes() == source.read_bytes() for path in assets))

    def test_local_pdf_is_a_real_graphic(self):
        figure = self.source.parent / "diagram.pdf"
        canvas = Canvas(str(figure), pagesize=(200, 100))
        canvas.rect(20, 20, 160, 60)
        canvas.drawString(30, 45, "Confirmed diagram")
        canvas.save()
        generated = self.convert("diagram.pdf")
        self.assertIn(r"\includegraphics[", generated)
        self.assertTrue(any(path.read_bytes() == figure.read_bytes()
                            for path in (self.destination.parent / "report-images").glob("*.pdf")))

    def test_pdf_static_view_destination_is_allowed_and_active_actions_fail(self):
        for active in (False, True):
            with self.subTest(active=active):
                writer = PdfWriter()
                page = writer.add_blank_page(200, 100)
                destination = (DictionaryObject({NameObject("/S"): NameObject("/JavaScript"),
                                                 NameObject("/JS"): TextStringObject("app.alert('test')")})
                               if active else ArrayObject([page.indirect_reference, NameObject("/XYZ"),
                                                           NullObject(), NullObject(), NumberObject(0)]))
                writer._root_object[NameObject("/OpenAction")] = destination
                stream = BytesIO()
                writer.write(stream)
                (self.source.parent / "view.pdf").write_bytes(stream.getvalue())
                if active:
                    with self.assertRaisesRegex(ValueError, "active"):
                        self.convert("view.pdf")
                else:
                    self.assertIn(r"\includegraphics[", self.convert("view.pdf"))

    def test_missing_and_invalid_images_fail_explicitly(self):
        for name, content in (("missing.png", None), ("bad.png", b"not a PNG"),
                              ("bad.jpg", b"not a JPEG"), ("bad.pdf", b"%PDF-1.7\ninvalid"),
                              ("bad.txt", b"not an image")):
            with self.subTest(name=name):
                if content is not None:
                    (self.source.parent / name).write_bytes(content)
                with self.assertRaisesRegex(ValueError, "[Ii]mage|[Ff]igure"):
                    self.convert(name)
                self.assertFalse(self.destination.exists())
        self.raster("disguised.png", "JPEG")
        with self.assertRaisesRegex(ValueError, "format"):
            self.convert("disguised.png")

    def test_external_absolute_parent_and_symlink_paths_are_rejected(self):
        outside = self.root / "outside.png"
        Image.new("RGB", (10, 10), "red").save(outside)
        (self.source.parent / "linked.png").symlink_to(outside)
        (self.source.parent / "linked-directory").symlink_to(self.root, target_is_directory=True)
        for reference in ("https://example.invalid/image.png", "file:///etc/passwd", "//example.invalid/image.png",
                          str(outside), "../outside.png", "%2e%2e/outside.png", "linked.png", "linked-directory/outside.png"):
            with self.subTest(reference=reference):
                with self.assertRaisesRegex(ValueError, "local|relative|symlink|directory"):
                    self.convert(reference)

    def test_unsafe_or_invalid_svg_is_rejected_before_conversion(self):
        template = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">%s</svg>'
        for payload in ('<image href="https://example.invalid/x.png"/>',
                        '<use href="file:///etc/passwd"/>', '<script>alert(1)</script>',
                        '<foreignObject/>', '<style>@import "https://example.invalid/x.css";</style>',
                        '<rect fill="url(https://example.invalid/x)"/>', '<rect onload="alert(1)"/>',
                        '<rect style="fill:u\\72l(https://example.invalid/x)"/>',
                        '<rect style="fill:url/**/(https://example.invalid/x)"/>',
                        '<svg xml:base="file:///etc/"/>',
                        '<rect xmlns:x="urn:other" x:resource="https://example.invalid/x"/>'):
            with self.subTest(payload=payload):
                (self.source.parent / "unsafe.svg").write_text(template % payload)
                with self.assertRaisesRegex(ValueError, "SVG"):
                    self.convert("unsafe.svg")
        for svg in ('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + template % "&x;",
                    '<svg><broken></svg>', '<html/>'):
            with self.subTest(svg=svg):
                (self.source.parent / "invalid.svg").write_text(svg)
                with self.assertRaisesRegex(ValueError, "SVG"):
                    self.convert("invalid.svg")

    def test_caption_numbers_and_duplicate_captions_are_checked(self):
        self.raster("diagram.png")
        with self.assertRaisesRegex(ValueError, "chapter"):
            self.convert("diagram.png", alt="图1-1 研究思路")
        with self.assertRaisesRegex(ValueError, "caption"):
            self.convert("diagram.png", following="图2-3 不同图题")

    def test_export_asset_directory_cannot_redirect_writes(self):
        self.raster("diagram.png")
        self.destination.parent.mkdir()
        (self.destination.parent / "report-images").symlink_to(self.source.parent, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.convert("diagram.png")

    def test_existing_nonregular_image_asset_fails_without_blocking(self):
        figure = self.raster("diagram.png")
        assets = self.destination.parent / "report-images"
        assets.mkdir(parents=True)
        os.mkfifo(assets / (hashlib.sha256(figure.read_bytes()).hexdigest() + ".png"))
        with self.assertRaisesRegex(ValueError, "regular file"):
            self.convert("diagram.png")


if __name__ == "__main__":
    unittest.main(verbosity=2)
