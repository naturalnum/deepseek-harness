"""Caption delimiters through the standalone and public generator normalizers."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from report_text_utils import normalize_markdown_text

SOURCE = ("# 2 配电负荷异常识别方法\n\n## 2.1 参数\n\n### 2.1.1 条件\n\n"
          "![图2-1 配电负荷异常识别方法技术路线](figures/fig2-1-v5.svg)\n\n"
          "图2-1 配电负荷异常识别方法技术路线\n\n"
          "表2-1 修正标准分数与普通标准分数在12条验证记录上的计数与指标\n\n"
          "正文 20 字—说明，图 2-1 所示。\n")
EXPECTED = SOURCE.replace("正文 20 字—说明，图 2-1 所示。", "正文20字-说明，图2-1所示。")


class MarkdownCaptionNormalization(unittest.TestCase):
    def test_actual_qa_caption_prefixes_through_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "before.md", Path(directory) / "after.md"
            source.write_text(SOURCE, encoding="utf-8")
            result = subprocess.run([sys.executable, str(ROOT / "scripts/normalize_markdown.py"),
                                     str(source), "--output", str(output)], capture_output=True,
                                    text=True, timeout=10, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(output.read_text(encoding="utf-8"), EXPECTED)
            self.assertEqual(source.read_text(encoding="utf-8"), SOURCE)

    def test_actual_qa_caption_prefixes_through_public_function(self):
        normalized, stats = normalize_markdown_text(SOURCE)
        self.assertEqual(normalized, EXPECTED)
        self.assertTrue(stats["changed"])

    def test_caption_titles_still_cleaned_and_inline_code_unchanged(self):
        source = "图2-1 20 条记录—分组\n表2-1 10 个值—分组\n表2-1中的20 条记录。\n`图2-1 20 条记录—分组`\n"
        expected = "图2-1 20条记录-分组\n表2-1 10个值-分组\n表2-1中的20条记录。\n`图2-1 20 条记录—分组`\n"
        normalized, _ = normalize_markdown_text(source)
        self.assertEqual(normalized, expected)
        self.assertEqual(normalize_markdown_text(normalized)[0], expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
