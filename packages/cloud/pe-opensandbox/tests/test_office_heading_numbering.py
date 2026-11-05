"""Read original adapter code and test its two-line runtime correction without Office dependencies."""
import ast
import hashlib
from html.parser import HTMLParser
import importlib.util
from pathlib import Path
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[2]
SCRIPTS = ROOT / 'packages/skill/skill-office/assets/reports/tech-report-writer/scripts'
RECIPE = PACKAGE / 'runtime/office-completion/heading-numbering'
spec = importlib.util.spec_from_file_location('heading_recipe', RECIPE / 'prepare_context.py')
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)


def adapter(raw):
    # Only unused BeautifulSoup imports are omitted. Markdown/math function bodies
    # are the original bytes; no identity stub replaces their transformations.
    math_tree = ast.parse((SCRIPTS / 'markdown_math.py').read_bytes())
    math_tree.body = [node for node in math_tree.body
                      if not isinstance(node, ast.ImportFrom) or node.module != 'bs4']
    math = {'__name__': 'qa_original_math', '__file__': str(SCRIPTS / 'markdown_math.py')}
    exec(compile(math_tree, '<original-stdlib-math-path>', 'exec'), math)
    tree = ast.parse(raw)
    tree.body = [node for node in tree.body
                 if not isinstance(node, ast.ImportFrom) or node.module != 'markdown_math']
    environment = {'__name__': 'qa_adapter', '__file__': str(SCRIPTS / 'orchestration_adapter.py')}
    environment.update({name: math[name] for name in ['normalize_formula_number_line', 'normalize_html_math',
                       'normalize_markdown_display_math', 'replace_inline_math_preserving_code']})
    exec(compile(tree, '<actual-adapter-functions>', 'exec'), environment)
    return environment


class Headings(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.rows, self.current = [], None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag in ('h1', 'h2', 'h3'):
            self.current = [tag, '']

    def handle_data(self, data):
        if self.current is not None:
            self.current[1] += data

    def handle_endtag(self, tag):
        if self.current is not None and self.current[0] == tag:
            self.rows.append(self.current)
            self.current = None


class OfficeHeadingNumbers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = (SCRIPTS / 'orchestration_adapter.py').read_bytes()
        cls.runtime = recipe.patch_source(cls.original)
        cls.before, cls.after = adapter(cls.original), adapter(cls.runtime)

    def render(self, markdown, chapter=1):
        return self.after['markdown_to_html'](markdown, chapter, '项目')

    def test_explicit_chinese_h2_h3_numbers_are_preserved(self):
        md = '# 1 项目\n\n## 1.1 数据来源\n\n### 1.1.1 质量范围\n\n## 1.2 状态&电压\n'
        self.assertEqual(Headings(self.render(md)).rows,
                         [['h1', '1 项目'], ['h2', '1.1 数据来源'], ['h3', '1.1.1 质量范围'], ['h2', '1.2 状态&电压']])
        original = self.before['markdown_to_html'](md, 1, '项目')
        self.assertEqual(Headings(original).rows[1], ['h2', '数据来源'])

    def test_h1_keeps_original_chapter_selection(self):
        md = '# 8 上游标题\n\n正文。\n'
        self.assertEqual(self.render(md, 3), self.before['markdown_to_html'](md, 3, '项目'))
        self.assertEqual(Headings(self.render(md, 3)).rows, [['h1', '3 上游标题']])

    def test_existing_numbers_are_not_duplicated_and_unnumbered_input_is_not_invented(self):
        self.assertEqual(Headings(self.render('## 1.1 显式编号\n')).rows[-1], ['h2', '1.1 显式编号'])
        md = '# 1 项目\n\n## 未编号\n'
        self.assertEqual(self.render(md), self.before['markdown_to_html'](md, 1, '项目'))
        self.assertNotEqual(Headings(self.render(md)).rows[-1][1], '1.1 未编号')

    def test_same_chapter_titles_keep_distinct_source_numbers(self):
        md = '# 1 同名章\n\n## 1.1 同名节\n\n# 2 同名章\n\n## 2.1 同名节\n'
        chapters = self.after['chapter_data']({'source_report': {'markdown': md}})
        self.assertEqual([Headings(c['content_html']).rows[-1][1] for c in chapters], ['1.1 同名节', '2.1 同名节'])

    def test_wrong_duplicate_source_numbers_are_not_silently_repaired(self):
        md = '# 1 章\n\n## 1.1 节\n\n# 1 章\n\n## 1.1 节\n'
        chapters = self.after['chapter_data']({'source_report': {'markdown': md}})
        actual = [Headings(c['content_html']).rows[-1][1] for c in chapters]
        self.assertNotEqual(actual, ['1.1 节', '2.1 节'])  # Formal source/outline comparison must reject this input.
        self.assertEqual(actual, ['1.1 节', '1.1 节'])

    def test_inline_markdown_math_and_code_fences_keep_original_transformations(self):
        md = '# 1 项目\n\n## 1.1 **电压** `U` $U$\n\n```markdown\n## 9.9 代码\n```\n'
        rendered = self.render(md)
        self.assertIn('<strong>电压</strong>', rendered)
        self.assertIn('<code>U</code>', rendered)
        self.assertIn('TECH_REPORT_INLINE_MATH_B64', rendered)
        self.assertEqual(rendered.replace('1.1 <strong>', '<strong>'),
                         self.before['markdown_to_html'](md, 1, '项目'))
        self.assertEqual(len(Headings(rendered).rows), 2)

    def test_exact_original_and_patch_digests_are_required(self):
        with self.assertRaises(ValueError):
            recipe.patch_source(self.original + b'\n')
        self.assertEqual(hashlib.sha256(self.runtime).hexdigest(), recipe.RUNTIME_SHA)
        self.assertEqual(hashlib.sha256((RECIPE / 'heading-numbering.patch').read_bytes()).hexdigest(), recipe.PATCH_SHA)
        before, after = ast.parse(self.original), ast.parse(self.runtime)
        # Every function other than the single Markdown converter is byte-independent AST equal.
        functions = lambda tree: {n.name: ast.dump(n) for n in tree.body if isinstance(n, ast.FunctionDef) and n.name != 'markdown_to_html'}
        self.assertEqual(functions(before), functions(after))

    def test_wrong_context_refuses_before_any_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / 'wrong.tar'; source.write_bytes(b'wrong')
            with self.assertRaises(ValueError):
                recipe.prepare(source, root / 'output')
            self.assertFalse((root / 'output').exists())
            source.write_bytes(bytes(recipe.SOURCE_CONTEXT_BYTES))
            with self.assertRaises(ValueError):
                recipe.prepare(source, root / 'output')
            self.assertFalse((root / 'output').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
