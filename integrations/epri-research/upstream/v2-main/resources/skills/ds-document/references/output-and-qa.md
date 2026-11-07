# Document Output and QA

## Contents

1. [Output routing](#output-routing)
2. [Render review](#render-review)
3. [Handoff record](#handoff-record)

## Output routing

| Need | Route |
| --- | --- |
| Fast review or tracked prose | Markdown with clear headings and placeholders |
| Word deliverable | `kdense-docx` or `documents`; validate and render the DOCX |
| Existing Office file inspection | `officecli`; preserve the original and record edits |
| Feishu document | `lark-doc`/`lark-drive` only with explicit authorization |
| PDF or HTML | Render from the verified source; keep source and export together |

Do not create a PDF as the only copy of a document that will continue to be
edited. Do not embed temporary download URLs as permanent references.

## Render review

For each output, record:

```text
artifact_path, source_path, renderer, renderer_version, rendered_at,
pages, checks_passed, checks_failed, reviewer, revision
```

Inspect the first page, the densest page, every table/attachment page, and the
last page. Check Chinese font fallback, line wrapping, headings, numbering,
page breaks, signatures/placeholders, URLs, and accessibility of tables. If a
visual or table carries a decision-bearing claim, confirm it matches the
approved wording and the supplied material after rendering.

## Handoff record

Return a compact handoff:

```text
document_type: 请示 / 报告 / 通知 / ...
writing_stack: ds-document / ds-document + ds-write / ds-document + oral / all three
status: 已核实 / 部分核实 / 待审批 / 待补资料
artifacts: [...]
open_fields: [...]
next_action: owner + action + deadline
```

The handoff is not a substitute for approval. It makes the remaining work
visible and lets a later conversation resume without rereading hidden context.
