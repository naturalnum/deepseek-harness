# Official-Document Quality Gate

## Contents

1. [Correctness and policy audit](#correctness-and-policy-audit)
2. [Structure and language audit](#structure-and-language-audit)
3. [Confidentiality and release audit](#confidentiality-and-release-audit)
4. [Formatting baseline](#formatting-baseline)

## Correctness and policy audit

Before finalizing, review the following items against the supplied material and
the selected document type. A separate ledger is optional, not required:

| Item | Check |
| --- | --- |
| People and units | Full names, titles, spelling and responsibility match the source |
| Dates and periods | Calendar, time zone, reporting period and effective date are consistent |
| Numbers | Numerator, denominator, unit, rounding and comparison baseline are visible |
| Policy basis | Exact title, issuer, version/date and quoted scope are not overstated |
| Status | Proposed, in progress, completed, approved and issued are not conflated |
| Attachments | Every named attachment exists, is authorized and has the stated version |
| Conclusions | The strength of wording does not exceed the evidence or authority |

If a check cannot be completed, retain a visible `[待核：...]` field or a short
limitation note. Do not hide uncertainty in a footnote.

## Structure and language audit

- The title and opening paragraph tell the reader what the document is for.
- The main requested decision or required action is easy to find.
- Each action has an owner, time limit, dependency and acceptance condition when
  the task needs one.
- Paragraphs contain one main point; lists use parallel grammar and stable
  numbering.
- The language is formal, direct and respectful without overstatement or empty
  slogans.
- Recommendations are labelled as recommendations. Alternatives and trade-offs
  are not presented as settled facts.
- The closing states the next decision, review or implementation step.

## Confidentiality and release audit

Classify the draft before sharing: internal working draft, restricted internal,
approved for circulation, or public-release candidate. Check names, personal
data, credentials, unpublished results, attachments, and external links. An
agent must not upload or publish a draft merely because the user asked for a
formatted file.

## Formatting baseline

Use the issuing institution's template whenever one exists. When no template is
provided, treat `GB/T 9704-2012《党政机关公文格式》` as a baseline reference
to verify locally, not as permission to invent an official document. Confirm
paper size, margins, fonts, line spacing, page numbers, headers/footers,
signature/issue blocks and attachment rules with the owner before final output.

For a DOCX/PDF export, render the result and inspect at page scale. At minimum
check title hierarchy, Chinese line wrapping, tables, page breaks, orphaned
headings, blank pages, footer/page numbers, and whether placeholders remain
visible. Keep the editable source and the rendered artifact together.

## Evidence statement

The final handoff should say one of:

- `已核实`: all material facts and references passed the available checks;
- `部分核实`: named fields remain open and are listed;
- `待审批`: content is ready for owner review but not issued;
- `待补资料`: drafting is blocked by missing source material.
