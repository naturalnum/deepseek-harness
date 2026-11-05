"""Catalog serialization and strict cache controls; no LibreOffice process."""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from xml.etree import ElementTree
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime/office'))
import refresh_word
import word_catalog as catalog


class CatalogUtf8Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def prepared(self):
        document = catalog.E.Element(catalog.tag('document'), nsmap={'w': catalog.W})
        body = catalog.E.SubElement(document, catalog.tag('body'))
        for group in 'CFT':
            paragraph = catalog.E.SubElement(body, catalog.tag('p'))
            for kind in ['begin', 'instruction', 'separate', 'end']:
                run = catalog.E.SubElement(paragraph, catalog.tag('r'))
                if kind == 'instruction':
                    catalog.E.SubElement(run, catalog.tag('instrText')).text = ' TOC \\f ' + group
                else:
                    catalog.E.SubElement(run, catalog.tag('fldChar')).set(catalog.tag('fldCharType'), kind)
        labels = ['内容摘要', '研究😀背景', '图 1 中文示意', '表 1 电压 ΔU']
        for index, label in enumerate(labels):
            paragraph = catalog.E.SubElement(body, catalog.tag('p'))
            props = catalog.E.SubElement(paragraph, catalog.tag('pPr'))
            catalog.E.SubElement(props, catalog.tag('pStyle')).set(catalog.tag('val'), 'Heading1' if index < 2 else 'Normal')
            run = catalog.E.SubElement(paragraph, catalog.tag('r'))
            catalog.E.SubElement(run, catalog.tag('t')).text = label
            if index >= 2:
                for kind in ['begin', 'instruction', 'end']:
                    run = catalog.E.SubElement(paragraph, catalog.tag('r'))
                    if kind == 'instruction':
                        catalog.E.SubElement(run, catalog.tag('instrText')).text = f' TC "{label}" \\f {"F" if index == 2 else "T"}'
                    else:
                        catalog.E.SubElement(run, catalog.tag('fldChar')).set(catalog.tag('fldCharType'), kind)
        section = catalog.E.SubElement(body, catalog.tag('sectPr'))
        catalog.E.SubElement(section, catalog.tag('pgSz')).set(catalog.tag('w'), '11906')
        margins = catalog.E.SubElement(section, catalog.tag('pgMar'))
        for side in ['left', 'right']:
            margins.set(catalog.tag(side), '1440')
        styles = catalog.E.Element(catalog.tag('styles'), nsmap={'w': catalog.W})
        for name in ['Normal', 'Heading1', 'TOC1', 'TOC2', 'TOC3']:
            style = catalog.E.SubElement(styles, catalog.tag('style'))
            style.set(catalog.tag('styleId'), name)
            style.set(catalog.tag('type'), 'paragraph')
            catalog.E.SubElement(style, catalog.tag('name')).set(catalog.tag('val'), name)
            if name == 'Normal':
                style.set(catalog.tag('default'), '1')
            if name == 'Heading1':
                props = catalog.E.SubElement(style, catalog.tag('pPr'))
                catalog.E.SubElement(props, catalog.tag('outlineLvl')).set(catalog.tag('val'), '0')
        source = self.root / 'source.docx'
        with ZipFile(source, 'x') as zipped:
            zipped.writestr('word/document.xml', catalog.xml(document))
            zipped.writestr('word/styles.xml', catalog.xml(styles))
            zipped.writestr('preserved.txt', b'unchanged package member')
        prepared = self.root / 'prepared'
        catalog.prepare(source, prepared)
        native = self.root / 'calculated'
        native.mkdir()
        for index, rows in enumerate([labels[:2], labels[2:3], labels[3:]]):
            (native / f'index-{index}.txt').write_text(''.join(label + '\t' + str(index + 1) + '\n' for label in rows), encoding='utf-8')
        return source, prepared, native, labels

    def test_utf8_chinese_and_supplementary_labels_preserve_original_fields_and_members(self):
        source, prepared, native, labels = self.prepared()
        catalog.apply_cache(prepared, native)
        received = json.loads((prepared / 'cache.json').read_text())
        self.assertEqual([row['label'] for rows in received.values() for row in rows], labels)
        with ZipFile(source) as before, ZipFile(prepared / 'final.docx') as after:
            self.assertEqual(before.namelist(), after.namelist())
            for name in before.namelist():
                if name != 'word/document.xml':
                    self.assertEqual(before.read(name), after.read(name))
            self.assertEqual([field['code'] for field in catalog.fields(catalog.parse_xml(before.read('word/document.xml')))],
                             [field['code'] for field in catalog.fields(catalog.parse_xml(after.read('word/document.xml')))])

    def test_lossy_question_marks_remain_rejected(self):
        _, prepared, native, _ = self.prepared()
        path = native / 'index-0.txt'
        path.write_bytes(path.read_bytes().decode('utf-8').encode('ascii', errors='replace'))
        with self.assertRaisesRegex(ValueError, 'Native entry order/title mismatch'):
            catalog.apply_cache(prepared, native)
        self.assertFalse((prepared / 'final.docx').exists())

    def test_wrong_order_and_wrong_title_remain_rejected(self):
        _, prepared, native, _ = self.prepared()
        path = native / 'index-0.txt'
        lines = path.read_text(encoding='utf-8').splitlines(keepends=True)
        for content in [''.join(reversed(lines)), '另一个标题\t1\n' + lines[1]]:
            path.write_text(content, encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Native entry order/title mismatch'):
                catalog.apply_cache(prepared, native)
            self.assertFalse((prepared / 'final.docx').exists())

    def test_invalid_page_remains_rejected(self):
        _, prepared, native, _ = self.prepared()
        path = native / 'index-0.txt'
        path.write_text(path.read_text(encoding='utf-8').replace('\t1', '\tinvalid'), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Unsupported native page label'):
            catalog.apply_cache(prepared, native)

    def test_macro_emits_explicit_utf8_stream_to_same_escaped_fixed_paths(self):
        destination = self.root / '目录"cache'
        destination.mkdir()
        writer = refresh_word.Writer('/not-executed', self.root, time.monotonic() + 150, 4)
        with patch.object(writer, 'run', side_effect=lambda _: (destination / 'complete.txt').write_text('complete\n')) as run:
            writer.macro(self.root / '输入.docx', destination, True)
        run.assert_called_once_with(['macro:///Standard.Module1.Main()'])
        macro = ElementTree.parse(writer.profile / 'user/basic/Standard/Module1.xba').getroot().text
        self.assertIn('com.sun.star.io.TextOutputStream', macro)
        self.assertIn('textStream.setEncoding("UTF-8")', macro)
        self.assertIn('textStream.writeString(indexes.getByIndex(i).getAnchor().String & Chr(10))', macro)
        self.assertIn('ConvertToURL("' + str(destination / 'index-').replace('"', '""') + '" & i & ".txt")', macro)
        self.assertNotIn('Print #outFile, indexes', macro)


if __name__ == '__main__':
    unittest.main()
