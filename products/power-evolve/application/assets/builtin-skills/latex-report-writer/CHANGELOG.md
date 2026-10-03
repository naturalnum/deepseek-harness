# Changelog

## 1.0.5

- Add an explicitly selected portable font profile using installed open-source Noto CJK SC and TeX Gyre Termes faces; retain template mode as the default and report its unavailable template fonts and actual fallback.
- Validate compact PostScript names and required profile families, report all PDF fonts, and require the final compile log; reject profile mismatches, missing glyphs, unembedded or unsubsetted fonts, malformed font rows and compile/layout warnings.

## 1.0.4

- Separate labeled level-1 appendices from reference entries, including the generator's source-link appendix after the bibliography; emit body, appendices and bibliography in the retained template order.
- Preserve appendix prose and URLs, support multiple uppercase appendix labels and retain numbering gaps, and reject invalid, duplicate or decreasing labels without changing ordinary reports or bilingual keyword parsing.
- Preserve blank-line-separated Chinese and English abstract paragraphs, join continuous lines only within a paragraph, and escape each paragraph before inserting controlled TeX paragraph boundaries; retain single-paragraph inputs, supplied word order and inline math.

## 1.0.3

- Convert standalone local Markdown images into real graphics with the supplied figure number and title, and consume a matching following caption once.
- Validate and copy PNG, JPEG and PDF files relative to the source Markdown directory; reject missing images, unsupported formats, external paths, traversal and symlinks.
- Validate static SVG and convert it to a single-page vector PDF using existing LibreOffice Draw with a private profile, bounded lifetime and no new Runner dependencies.
- Disable TeX shell escape and retain the existing chapter, equation, table and reference behavior.

## 1.0.2

- Read reviewed Arabic-numbered Markdown chapters alongside Chinese chapter forms, retaining numbers, hierarchy and numbering gaps without duplicate numbers.

## 1.0.1

- Require an explicit English cover title and supplied bilingual abstracts and keywords.
