# Technical report Word preparation

English | [中文](README.zh.md)

This Skill converts reviewed reports to Word and checks their layout. [SKILL.md](SKILL.md) owns the complete generation and visual inspection workflow.

## Reviewed Markdown input

When `source_report` is supplied, the reviewed Markdown is the only source of abstracts, chapters, references and appendices; unreadable or incomplete input cannot select older artifacts. A leading Chinese and English title pair must match this edition's `word_metadata.title_cn` and `title_en`. Both titles precede the report sections; other extra top-level headings remain unsupported.

The Markdown may contain one nonempty `# 目录` or `## 目录` section before the body and back matter. Its entries do not become abstract text or an extra Word chapter. The Word template generates the paginated contents from the reviewed headings.

Reference-source explanations belong in a consecutive appendix, for example `# 附录 B 参考文献来源与获取链接` after Appendix A. Their text remains separate from the bibliography's continuously numbered `[n]` entries.

## Figure and table captions

Catalog marking, paragraph formatting and validation share the same caption rule: a numbered title requires Caption style, direct centering or the adjacent figure/table. Ordinary body references retain their text and body formatting. True captions must have the matching catalog TC field; TC fields on ordinary body paragraphs are rejected. Continued-table labels retain caption formatting without a second catalog entry.

## Paragraph spacing

Chinese and English abstract text and keywords use 12 pt fonts and 1.5 line spacing with paragraph grid snapping disabled. Body text and references also disable grid snapping. The section grid remains available to other content; these paragraph overrides prevent inherited grid rounding from enlarging the declared spacing.

## Native formula rendering

The source DOCX retains its native OMML formulas. Before LibreOffice pagination and PDF export, the temporary layout copy orders delimiter character properties as beginning, separator and ending for sequential Math importers. Delimiter values, explicit empty endings, formula content and other properties remain unchanged.

## Command failures

Failed validation, creation or formatting commands return `blocked` without a Word artifact. The `error` object records the command phase, `returncode`, actual `data_dir`, and the last 4096 UTF-8 bytes of each captured `stdout` and `stderr`, with total byte counts and truncation flags. A DOCX saved before failure remains an incomplete output until generation and validation pass.

## Verification

[Adapter regressions](tests/test_orchestration_adapter.py) cover deterministic preparation, strict rejection and Word paragraph/table readback. They do not establish LibreOffice pagination or page-by-page visual acceptance; those checks remain part of the actual Word workflow.

[Caption regressions](tests/test_captions.py) exercise synthetic DOCX marking, formatting and structural validation, including missing caption TC fields and TC fields incorrectly attached to body prose.

[Spacing regressions](tests/test_format_layout.py) check synthetic DOCX readback for both abstract languages and keywords, retaining text, fonts, declared spacing and section grid. Actual rendered leading requires page-by-page visual inspection.

[Delimiter regressions](tests/test_layout_math_delimiters.py) check absolute-value bars, open cases, nested delimiters and pagination-copy isolation using synthetic OMML. They substitute the UNO subprocess; actual Math import and PDF symbols require inspection in the Word rendering workflow.
