"""Runner-only effective abstract leading, paragraph content and keyword placement."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
from markdown_to_latex import build_tex, parse_front_matter


def compact(text):
    text = re.sub(r"(?m)^\s*[ivxlcdm]+\s*$", "", text)
    return re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]", "", text)


class AbstractSpacing(unittest.TestCase):
    def test_three_paragraphs_have_18pt_effective_leading_and_attached_keywords(self):
        root = Path(os.environ.get("LATEX_ABSTRACT_OUTPUT", tempfile.mkdtemp(prefix="latex-abstract-spacing-")))
        root.mkdir(parents=True, exist_ok=True)
        source = SKILL / "tests/fixtures/native-three-paragraph-abstracts.md"
        tex = root / "report.tex"
        build_tex(source, tex, "QA Abstract Spacing Report", font_profile="portable")
        generated = tex.read_text()
        self.assertEqual(generated.count(r"\endgraf"), 4)
        for language in ("cn", "en"):
            generated = generated.replace("abstract-" + language + "={", "abstract-" + language + "={" +
                                          r"\typeout{QA-ABSTRACT-" + language.upper() + r"-BASELINE: \the\baselineskip}", 1)
        tex.write_text(generated)
        for name in ("techreport.cls", "report-logo.jpeg"):
            shutil.copy2(SKILL / "assets/template" / name, root / name)
        with (root / "build.log").open("w") as output:
            result = subprocess.run([sys.executable, str(SKILL / "scripts/build_latex_report.py"), str(tex)],
                                    stdout=output, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode, 0, (root / "build.log").read_text()[-4000:])
        log = tex.with_suffix(".log").read_text()
        for language in ("CN", "EN"):
            value = re.search("QA-ABSTRACT-" + language + r"-BASELINE: ([0-9.]+)pt", log)
            self.assertIsNotNone(value)
            self.assertAlmostEqual(float(value.group(1)), 18.0, places=4)
        text = subprocess.check_output(["pdftotext", "-layout", str(tex.with_suffix(".pdf")), "-"], text=True)
        (root / "report.txt").write_text(text)
        pages = text.split("\f")
        cn_index = next(i for i, page in enumerate(pages) if "内容摘要" in page)
        en_index = next(i for i, page in enumerate(pages) if "ABSTRACT" in page)
        cn_keyword = next(i for i, page in enumerate(pages) if "关键词：" in page)
        self.assertEqual(cn_keyword, cn_index)
        self.assertGreater(en_index, cn_index)
        parsed = parse_front_matter(source.read_text().splitlines())
        self.assertEqual(len(parsed[1].split("\n\n")), 3)
        self.assertEqual(len(parsed[3].split("\n\n")), 3)
        cn = text.split("内容摘要", 1)[1].split("关键词：", 1)[0]
        en = text.split("ABSTRACT", 1)[1].split("KEYWORDS:", 1)[0]
        self.assertEqual(compact(cn), compact(parsed[1]))
        self.assertEqual(compact(en), compact(parsed[3]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
