"""Explicit font profiles at the converter and PDF validation entry points."""

from contextlib import redirect_stdout
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
import markdown_to_latex as converter
import validate_latex_report as validator

HEADER = "name type encoding emb sub uni object ID\n--------------------------------------\n"
TEMPLATE = HEADER + """ABCDEF+STSongti-SC-Regular CID TrueType Identity-H yes yes yes 10 0
GHIJKL+STHeitiSC-Medium CID TrueType Identity-H yes yes yes 11 0
MNOPQR+TimesNewRomanPSMT TrueType WinAnsi yes yes yes 12 0
"""
PORTABLE = HEADER + """ABCDEF+NotoSerifCJKsc-Regular CID Type 0C Identity-H yes yes yes 10 0
GHIJKL+NotoSansCJKsc-Regular CID Type 0C Identity-H yes yes yes 11 0
MNOPQR+TeXGyreTermes-Regular CID Type 0C Identity-H yes yes yes 12 0
STUVWX+CMSY10 Type 1 Builtin yes yes yes 13 0
"""
PORTABLE_LOG = """TR-FONT-PROFILE: portable
TR-FONT-BODY: NotoSerifCJKsc-Regular
TR-FONT-HEADING: NotoSansCJKsc-Regular
TR-FONT-LATIN: TeXGyreTermes-Regular
TR-FONT-CJK-INDEX: 2
"""


class FontProfiles(unittest.TestCase):
    def validate(self, fonts, log="", profile=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pdf, logfile = root / "report.pdf", root / "report.log"
            pdf.write_bytes(b"controlled PDF tool fixture")
            logfile.write_text(log)
            argv = ["validate_latex_report.py", str(pdf), "--log", str(logfile)]
            if profile:
                argv += ["--font-profile", profile]
            output = io.StringIO()
            with patch.object(sys, "argv", argv), patch.object(validator, "run", side_effect=[
                "Pages: 9\nPage size: 595.28 x 841.89 pts\n", fonts, "confirmed report content",
            ]), redirect_stdout(output):
                code = validator.main()
            return code, output.getvalue()

    def test_converter_defaults_to_template_and_portable_is_explicit(self):
        fixture = SKILL / "tests/fixtures/native-three-paragraph-abstracts.md"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            default, portable = root / "default.tex", root / "portable.tex"
            converter.build_tex(fixture, default, "QA Font Profile Report")
            converter.build_tex(fixture, portable, "QA Font Profile Report", font_profile="portable")
            self.assertTrue(default.read_text().startswith(r"\documentclass{techreport}"))
            self.assertEqual(portable.read_text(), default.read_text().replace(
                r"\documentclass{techreport}", r"\documentclass[portablefonts]{techreport}", 1))
            with self.assertRaisesRegex(ValueError, "font profile"):
                converter.build_tex(fixture, root / "invalid.tex", "QA Font Profile Report", font_profile="auto")
            self.assertFalse((root / "invalid.tex").exists())

    def test_template_fallback_is_an_error_not_a_font_validation_pass(self):
        code, output = self.validate(PORTABLE)
        self.assertEqual(code, 1, output)
        self.assertIn("template", output)
        self.assertIn("NotoSerifCJKsc-Regular", output)

    def test_compact_postscript_names_and_explicit_portable_profile_pass(self):
        code, output = self.validate(PORTABLE, PORTABLE_LOG, "portable")
        self.assertEqual(code, 0, output)
        self.assertIn("Font profile: portable", output)
        self.assertIn("TeXGyreTermes-Regular", output)
        self.assertNotIn("no obvious", output)
        self.assertEqual(self.validate(TEMPLATE)[0], 0)
        self.assertEqual(self.validate(PORTABLE.replace("CJKsc", "CJKjp"), PORTABLE_LOG, "portable")[0], 0)

    def test_profile_mismatch_and_wrong_cjk_face_are_rejected(self):
        for fonts, log in [(PORTABLE, PORTABLE_LOG.replace("PROFILE: portable", "PROFILE: template")),
                           (PORTABLE.replace("CJKsc", "CJKkr"), PORTABLE_LOG),
                           (PORTABLE, PORTABLE_LOG.replace("CJK-INDEX: 2", "CJK-INDEX: 0"))]:
            with self.subTest(log=log, fonts=fonts):
                self.assertEqual(self.validate(fonts, log, "portable")[0], 1)

    def test_missing_glyphs_overflow_and_final_log_errors_remain_hard_failures(self):
        for line in ["Missing character: There is no 中 (U+4E2D) in font Test!",
                     "Overfull \\hbox (1.0pt too wide)", "Underfull \\hbox (badness 10001)",
                     "! Undefined control sequence.", "Class techreport Warning: required font unavailable",
                     "Package fontspec Warning: font unavailable", "LaTeX Warning: undefined references"]:
            with self.subTest(line=line):
                self.assertEqual(self.validate(TEMPLATE, line)[0], 1)

    def test_unembedded_unsubsetted_and_malformed_font_rows_fail(self):
        for fonts in [TEMPLATE.replace("yes yes yes", "no yes yes", 1),
                      TEMPLATE.replace("yes yes yes", "yes no yes", 1), TEMPLATE + "malformed font row\n"]:
            with self.subTest(fonts=fonts):
                self.assertEqual(self.validate(fonts)[0], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
