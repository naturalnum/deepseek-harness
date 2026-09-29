---
name: latex-report-writer
description: Generate, revise, and validate Chinese electric-power technical reports in XeLaTeX. Use when a report must follow a retained Word template or technical-report specification while being produced as .tex and PDF, including checks for fonts, page geometry, cover, approval page, abstracts, contents, headings, figures, tables, equations, appendices, references, and page numbering.
---

# LaTeX Technical Report Writer

Use this skill as the LaTeX backend for formal Chinese technical reports. Keep report content semantic and put reusable typography and page furniture in the bundled class file. Deliver both the source `.tex` project and the compiled PDF when requested.

## Source of truth

1. Read `references/technical-report-format.md` for the governing technical-report requirements.
2. Read `references/latex-layout-rules.md` for the current LaTeX implementation and deliberate deviations from the base specification.
3. Use `assets/template/techreport.cls` as the default class and `assets/template/report-logo.jpeg` as the default cover logo.
4. Treat an explicitly supplied Word/PDF template as the visual authority for local positions. Render the reference before changing the class.
5. Preserve confirmed report content. Do not invent project data, results, conclusions, or references.
6. If the source does not provide a cover date, fill it with the report-generation date in `YYYY年M月D日` form. Do not infer a project completion date or a publication date from surrounding prose.
7. If the source does not provide an English cover title, generate a semantically faithful English translation from the Chinese report title and place it directly below the Chinese title. Never leave the English cover-title field blank.

The current project variant intentionally places the Chinese and English abstracts on separate pages. This overrides the older source specification that places them together.

## Workflow

### 1. Inspect inputs

- Identify the report source: existing `.tex`, structured JSON, `.docx`, `.pdf`, or a mixture.
- For an existing Word/PDF template, inspect both extracted structure and rendered pages. Do not infer layout from text extraction alone.
- Preserve the original source file and create the LaTeX working project separately.
- Prefer structured fields such as `cover_info.json`, `abstract.json`, chapter JSON, and references JSON when they are available.

### 2. Build the LaTeX project

- Copy the class and required assets into the working project, or add the template directory to the project search path.
- Put metadata in `\techreportsetup{...}` in the main `.tex` file.
- Place the Chinese report title in the middle-upper area of the cover and the English report title immediately below it; omit empty optional project-source/project-name lines so they do not create invisible vertical gaps.
- Keep chapters in separate `.tex` files when the report is more than a short example.
- Keep font, page, heading, numbering, cover, approval-page, and page-style rules in `techreport.cls`; do not repeat them in chapters.
- Escape LaTeX special characters in generated content and keep user text separate from formatting commands.
- Enable two-character first-line indentation for every body paragraph, including the first paragraph after a heading. Do not rely only on the default LaTeX paragraph behavior, because the first paragraph after a sectional heading is otherwise often flush left.
- Keep each table caption and table body in one non-breaking layout unit whenever the table fits on a page. If a table is too large for one page, use a deliberate repeated-header continuation layout; never leave a caption orphaned at the bottom of a page.
- Keep one leading of the surrounding body text between the preceding body paragraph and the table; this is an independent vertical gap and must not alter the body's 1.5-line spacing.
- Keep the same one body leading between the table and following body text; consecutive tables must not accumulate duplicate gaps.
- Format the table number and caption as fifth-size Heiti, with no paragraph spacing before or after and 1.5-line spacing.
- Keep one fifth-size 1.5-line leading between the table caption line and the table body; treat it as explicit inter-element spacing, not caption paragraph spacing.
- Use fifth-size Songti for table CJK text and fifth-size Times New Roman for Latin letters and Arabic numerals, both with 1.5-line spacing and no paragraph spacing before or after. Honor explicit Markdown column alignment so numbers in the same column line up vertically; right-align numeric columns unless the source requests another alignment.
- Use the same non-bold table font for the header row and body rows. The table header must not be made heavier or larger solely because it is the first row.
- Place every figure caption below its figure and centered. Use one full-width-character em between the generated figure number and title; captions use fifth-size Heiti, 1.5-line spacing, and zero paragraph spacing before and after.
- Generate figure numbers as `图章号-章内序号`, restarting the Arabic serial number at 1 in each chapter. Permit only one level of subfigure subdivision, such as `(a)`, `(b)`, or `(c)`; do not nest subfigures.
- Use the semantic commands provided by the class for cover, approval page, abstracts, contents, figures, tables, appendices, and references.

### 3. Compile with XeLaTeX

Run the bundled build helper or the equivalent commands from the directory containing the main `.tex` file:

```bash
python scripts/build_latex_report.py report.tex --output-pdf output/report.pdf
```

The build must use XeLaTeX, compile at least twice, stop on fatal errors, and retain the log for diagnosis. Do not silently switch to pdfLaTeX because Chinese font selection depends on XeLaTeX.

### 4. Validate structure and fonts

Run:

```bash
python scripts/validate_latex_report.py output/report.pdf --log report.log
```

The validator must check:

- A4 page size and expected page count when one is specified;
- embedded and subsetted fonts with `pdffonts`;
- absence of fatal errors, `Overfull`, `Underfull`, and unexpected LaTeX warnings;
- absence of unresolved `{{...}}`, `待填写`, and test placeholders in a final report;
- presence of required cover, approval, abstract, contents, body, appendix, and reference text when applicable.

`pdffonts` is authoritative for the fonts actually used in the PDF. On macOS the default class should produce Songti SC / Heiti SC and Times New Roman subsets; a fallback to SimSun, SimHei, Noto, or TeX Gyre Termes must be reported rather than silently accepted.

### 5. Render and inspect

Render every page before delivery:

```bash
python scripts/render_pdf.py output/report.pdf --output-dir /tmp/report-render
```

Inspect all `page-*.png` files at full resolution. Check clipping, overlap, glyphs, spacing, page breaks, headers, footers, page numbers, figure/table placement, equation numbering, and blank pages. If a retained reference exists, compare the corresponding pages visually and iterate.

### 6. Deliver

Deliver only after the latest compile, structural validation, and PNG inspection pass. Report the `.tex` source location, PDF location, compile engine, font result, and any intentional deviation from the base specification.

## Layout guardrails

- A4 portrait; default body geometry is controlled by the class.
- Body text is 12pt Songti, 1.5 line spacing, and a two-character first-line indent, including the first paragraph following a heading.
- The contents title is followed by exactly one fourth-size Heiti leading before the first contents entry; do not inherit the hidden section-heading spacing from `\tableofcontents`.
- Abstract paragraphs and keyword lines use the same two-character first-line indentation for a consistent formal-report appearance.
- Level-1 headings start on a new page; heading sizes and spacing come from the class.
- Calibrate heading before/after skips against visible glyph edges so body-adjacent headings appear equally spaced above and below. When heading levels are consecutive, apply a transition-specific correction so their calibrated skips do not accumulate.
- The approval page uses explicit bold CJK/Latin font series, fixed labels, one `em` after each colon, dynamic alignment of the cooperation-unit line with the work-unit value, and a `3em` indent for `报告审核` and all following review/approval fields relative to the writing-unit line.
- Chinese and English abstracts each occupy one page in the current project variant.
- Front matter uses lower-case Roman numerals; body, appendices, and references use Arabic numerals with the body restarting at 1.
- Figure captions are below figures; table captions are above tables; figure, table, and equation numbering is chapter-aware.
- Figure captions are centered below the figure with one em between number and title, 10.5pt Heiti, 15.75pt baseline, and zero paragraph spacing before and after. Figure numbering resets within each chapter and has only one subfigure level.
- Generated display equations use the class's `reportequation` environment. Calibrate separate above/below skips so the visible formula-to-prose gaps approach the visible gap between adjacent body lines; do not rely on normal/short display skips, whose effective visible gap changes with formula height.
- If a generated equation lacks sentence-ending punctuation and the next paragraph begins with `式中`, suppress that paragraph's first-line indent because it continues the same sentence; otherwise keep the normal two-character indent.
- Table captions and bodies are kept together when feasible; avoid a caption stranded on the preceding page.
- Table numbers and captions use 10.5pt Heiti with 1.5-line spacing and no paragraph spacing before or after.
- Table CJK text uses 10.5pt Songti and Latin letters/Arabic numerals use 10.5pt Times New Roman, both with 1.5-line spacing and no paragraph spacing before or after. Numeric columns are aligned consistently from row to row.
- Do not replace fixed labels with dynamically generated labels when the retained approval template defines the wording.

## Failure handling

- If a required font is unavailable, stop and report the missing font and the actual fallback; do not claim that the template passed font validation.
- If a reference template and the written specification disagree, show the conflict and follow the user's explicit decision.
- If text overflows, fix content width, wrapping, spacing, or layout structure before shrinking the required font.
- If the PDF renders differently from the reference, inspect the source page geometry and paragraph structure before guessing at offsets.
- Do not deliver a PDF that still contains test placeholders or an unverified page.

## Bundled resources

- `assets/template/techreport.cls`: reusable report class.
- `assets/template/report-logo.jpeg`: default cover logo extracted from the retained Word template.
- `assets/template/example-report.tex`: minimal compile fixture.
- `references/technical-report-format.md`: technical-report requirements.
- `references/latex-layout-rules.md`: implementation-specific layout decisions.
- `scripts/build_latex_report.py`: deterministic XeLaTeX build helper.
- `scripts/validate_latex_report.py`: PDF, font, log, and placeholder validator.
- `scripts/render_pdf.py`: Poppler-based page renderer for visual QA.
