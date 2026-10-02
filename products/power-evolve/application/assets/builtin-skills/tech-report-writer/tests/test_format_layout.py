"""The report's declared line spacing must not snap to a legacy page grid."""
from pathlib import Path
import sys
import unittest

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from format_existing_report import _format_body, _format_reference


class ParagraphGridSpacing(unittest.TestCase):
    def check_spacing(self, formatter, text):
        document = Document()
        grid = OxmlElement('w:docGrid')
        grid.set(qn('w:type'), 'lines')
        grid.set(qn('w:linePitch'), '312')
        document.sections[0]._sectPr.append(grid)
        paragraph = document.add_paragraph(text)
        formatter(paragraph)
        snap = paragraph._p.pPr.find(qn('w:snapToGrid'))
        self.assertIsNotNone(snap, 'an absent override inherits the template grid')
        self.assertEqual(snap.get(qn('w:val')), '0')
        self.assertEqual(paragraph.paragraph_format.line_spacing, 1.5)
        self.assertEqual(paragraph.text, text)
        self.assertEqual(paragraph.runs[0].font.size.pt, 12)
        self.assertEqual(grid.get(qn('w:linePitch')), '312', 'retain the source template grid')

    def test_wrapped_body_keeps_declared_spacing(self):
        self.check_spacing(_format_body, 'REPORT-REVISION-20261003：本次测试使用独立目录与受控材料，不构成生产结论。')

    def test_wrapped_reference_keeps_declared_spacing(self):
        self.check_spacing(_format_reference, '[1] 测试组. 固定输入均值计算组件测试记录[R]. 2026.')


if __name__ == '__main__':
    unittest.main(verbosity=2)
