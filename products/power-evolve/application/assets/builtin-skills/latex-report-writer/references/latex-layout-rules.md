# Current LaTeX layout rules

This reference records decisions that are specific to the current XeLaTeX implementation. The governing technical-report requirements remain in `technical-report-format.md`; when the user explicitly chooses a LaTeX variation, record it here and report it at delivery.

## Typography

- Compile with XeLaTeX only.
- Prefer macOS `Songti SC`, `Heiti SC`, and `Times New Roman`; use the fallback chain in `techreport.cls` only when the preferred font is unavailable.
- Body text uses 12pt Songti with 18pt leading and a two-character first-line indent, including the first paragraph after each heading.
- Display equations follow the preceding prose directly, with no empty LaTeX paragraph between prose and the formula block. Generated equations use the semantic `reportequation` environment, which suppresses TeX's height-dependent interline glue and uses calibrated `10.5pt` above and `12.15pt` below skips. With the current body and math fonts, the resulting visible formula-to-prose gaps are close to the approximately `9.7pt` visible gap between adjacent body lines. Legacy `equation` environments retain `0pt` display skips but are not used by the Markdown converter.
- When an equation has no sentence-ending punctuation and the following paragraph begins with `式中`, treat that paragraph as a continuation of the same sentence and suppress its first-line indent. If the equation ends with `。`, `！`, `？`, or the corresponding ASCII punctuation, retain the normal two-character paragraph indent.
- A table following body text receives one independent 18pt leading of vertical space before its caption. This preserves the body paragraph's 1.5-line spacing without changing the table's own fifth-size 15.75pt leading.
- After a table, reserve the same independent 18pt body leading before following body text. Consecutive tables use one effective inter-table gap rather than stacking duplicate leading spaces.
- The class loads `indentfirst` so heading-following paragraphs do not become flush left.
- Figure captions are centered below the figure, use 10.5pt Heiti with a 15.75pt baseline and zero paragraph spacing, and place one em between the generated figure number and title.
- Figure numbers use `图章号-章内序号` and reset to 1 at each chapter. Only one subfigure level is permitted; nested subfigures are not supported.
- Table numbers and captions use 10.5pt Heiti with a 15.75pt baseline (1.5-line spacing) and zero paragraph spacing before and after.
- Keep one 15.75pt fifth-size leading between the caption line and the table body as explicit inter-element spacing; do not implement it through caption `parskip`.
- Table CJK text uses 10.5pt Songti; Latin letters and Arabic numerals use 10.5pt Times New Roman. Both use a 15.75pt baseline and zero paragraph spacing before and after. Header and body rows are non-bold and use the same font treatment.
- Numeric table columns honor source alignment markers and default to right alignment so values in one column line up vertically.
- Level-1, level-2, and level-3 headings use 15pt, 14pt, and 12pt Heiti respectively.
- Heading skips are calibrated against the rendered glyph boxes rather than kept numerically symmetric: level 1 uses `6pt/9.87pt`, level 2 uses `0.31pt/9.65pt`, and level 3 uses `3.08pt/9.23pt` before/after. These values target approximately one 18pt body leading of visible ink-edge clearance on both sides of a body-adjacent heading. When headings are consecutive, apply a transition-specific negative correction so the two headings' skips do not accumulate; this correction does not affect body-adjacent spacing.
- The approval page explicitly forces the bold font series for CJK, Latin, and numeric glyphs at 14pt with 18pt leading.

## Page and numbering

- A4 portrait with the main geometry defined by `techreport.cls`.
- Cover and approval page have no visible page number.
- Front matter uses lower-case Roman numerals; body numbering restarts at Arabic 1.
- The contents title is followed by one fourth-size Heiti leading (21pt) before the first contents entry; the hidden heading spacing normally added by `\tableofcontents` is suppressed.
- Level-1 headings begin on a new page.

## Cover

- Use `report-logo.jpeg` at the measured upper-left position.
- Keep the upper-right report metadata vertically independent from the logo; it is intentionally not top-aligned with the image.
- Place the Chinese report title in the middle-upper area of the cover; place the English report title immediately below it. If the source omits the English title, use a verified semantic translation rather than leaving a blank line.
- Keep the writing unit, cooperation unit, and date as a separate bottom block.

## Approval page

- Do not use a table or horizontal rules for the approval page.
- Use fixed labels from the retained approval template.
- Put one `em` of space after each colon before a value or blank field.
- Put the cooperation-unit line on its own indented line and align its first character with the work-unit value after `工作单位：` and one `em` of space.
- Indent `报告审核` and every following review/approval field by exactly `3em` relative to the left edge of `中国电力科学研究院有限公司`.
- Keep `部    门：` visually spaced as a fixed label.
- Long labels must wrap naturally in the available text width without being split by an artificial value column.

## Abstracts

The current project variant intentionally places the Chinese abstract and keywords on one front-matter page and the English abstract and keywords on the next front-matter page. This is a deliberate deviation from the older source specification that requested one shared abstract page.

## Validation expectations

The portable profile selects SC face index 2 in the Runner's Noto TTC files under `/usr/share/fonts/opentype/noto/`. Those SC faces share a CFF table whose embedded name ends in `CJKjp`; `pdffonts` can therefore report `NotoSerifCJKjp` or `NotoSansCJKjp` even with an explicitly selected SC face. Validation checks the declared SC selection/index and the actual embedded Noto CJK family, retains the observed PDF names, and accepts these verified CFF aliases. Compact `TeXGyreTermes` PostScript names also identify the declared Latin family.

The default template profile requires embedded/subsetted Songti SC or SimSun, Heiti SC or SimHei, and Times New Roman fonts. Explicit portable mode instead requires installed Noto Serif CJK SC, Noto Sans CJK SC and TeX Gyre Termes; it is a typography deviation from the retained template. Both profiles require A4 dimensions, stable page numbering, no missing glyphs or compile/layout warnings in the final log, and no unresolved test placeholders. The validator reports all actual PDF fonts and rejects fallback families for the selected profile. Always render every page to PNG and inspect it before delivery.
