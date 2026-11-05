---
name: ds-document
description: "Use when drafting, revising, reviewing, or formatting Chinese official documents, internal government-style materials, policy briefs, meeting minutes, work plans, reports, requests, notices, or decision-oriented technical reports. Route the work by document type, write for the intended reader and decision, use placeholders instead of inventing missing official details, and deliver a reader-ready Markdown, DOCX, PDF, or HTML artifact. Combine ds-write when rigorous evidence/citations are needed and oral when the narrative, visual hierarchy, or executive readability needs refinement."
---

# DeepScientist Document

## Purpose and boundaries

Use this skill for Chinese official-document and decision-document work where
文种、行文关系、政策口径、表达质量和交付格式 matter. It covers both:

- **公文/政务材料**: 通知、报告、请示、函、纪要、决定、公告、通报、
  工作方案、汇报材料、简报、专报、讲话稿、调研报告、工作总结等；
- **高级技术报告**: 给管理者、评审者或跨部门团队使用的事实、选项、
  风险、建议和实施责任说明。

This is an optional writing and review layer, not a legal approval system. It
does not invent a policy position, replace an institution's template, or claim
that a draft is officially issued. For a research paper or evidence-heavy
research output, combine `ds-write` and `oral` instead of copying their full
paper workflow into this skill. For Word/XML mechanics, use `kdense-docx` or
`documents` after the content contract is stable.

## Core writing brief

Before substantial prose, create a compact `document_contract` in the project
workspace when one is bound, otherwise in working notes. It is a writing brief,
not a second project database:

```text
document_type, audience, issuing_or_requesting_unit, purpose, decision_needed,
scope, time_range, confidentiality, deadline, output_formats, known_materials,
unresolved_fields, approval_owner
```

Do not create a mandatory fact ledger or source register for ordinary drafting.
Use the material supplied by the user and make uncertainty visible in the
prose. When a claim is sensitive, quantitative, policy-dependent, or likely to
be challenged, invoke `ds-write` for a lightweight claim/evidence check; the
result can remain in working notes or a linked appendix rather than becoming a
new project truth store.

## Writing stack selection

Choose the smallest stack that can produce a good document:

- **ds-document only**: ordinary Chinese official documents, internal notices,
  meeting minutes, plans, summaries, and rewrites;
- **ds-document + ds-write**: claims depend on external literature, datasets,
  experiments, citations, or source comparison;
- **ds-document + oral**: the material is for leadership, cross-team review, or
  executive reading and needs a strong story spine, visual hierarchy, or a
  compact decision summary;
- **ds-document + ds-write + oral**: evidence-heavy decision reports where both
  traceability and persuasive, readable structure matter.

`ds-write` is called for evidence selection, claim strength, citation placement,
and limitations. `oral` is called after the content is sound to improve the
opening, section order, figure/table role, executive summary, and objection
handling. Neither skill is required for every document.

## Standard operating procedure

### 1. Clarify and route

Infer the narrowest document type from the user's goal and intended reader.
Ask at most a few high-value questions; prefer single-choice options such as:

1. `报告` / `请示` / `通知` / `函` / `纪要` / `工作方案` / `其他`;
2. `供领导决策` / `向上级汇报` / `向下部署` / `部门协作` / `对外发布`;
3. `仅 Markdown` / `DOCX` / `PDF` / `DOCX+PDF`.

If the user does not answer and the task is low-risk, choose the most likely
route and state the assumption. Never use a guessed document number, date,
issuer, policy citation, statistics, or approval conclusion as if it were real.

Read only the relevant file from [official-document-routing.md](references/official-document-routing.md).
For a decision-oriented technical report, also read
[technical-report-contract.md](references/technical-report-contract.md). Load
`ds-write` or `oral` only when the writing-stack triggers above are met.

### 2. Read the supplied material

Read the files, notes, links, and user instructions that are actually available;
do not spend time constructing a separate inventory for a straightforward
rewrite. Keep three distinctions visible in the draft:

- **事实**: what the supplied material states;
- **判断**: the writer's interpretation;
- **建议**: a proposed action that still needs an owner to accept it.

For sensitive, political, legal, financial, personnel, or public-release
content, do not broaden a claim beyond the supplied authority. If a detail is
missing or uncertain, use a short placeholder or limitation instead of guessing.

### 3. Build the reader-first outline

Build the outline from the reader's needs, not from the chronology of agent
actions:

```text
purpose -> current situation -> problem/need -> basis/evidence
        -> options or requested action -> risk/conditions
        -> responsibility/timeline -> decision or next step
```

For a formal request, make the requested decision and requested support visible
early. For a notice, make scope, effective time, responsible unit and required
action easy to scan. For minutes, distinguish resolutions, owners and deadlines
from discussion notes. For a technical report, use the report spine in
`technical-report-contract.md`.

### 4. Draft, revise, and polish

1. **开篇先给方向**: state why the document exists and what the reader should
   decide or do;
2. **先搭骨架再填内容**: headings and action blocks come before paragraphs;
3. **每段只解决一个问题**: use short paragraphs, parallel lists, and stable
   terminology;
4. **证据按需嵌入**: add a citation, source note, table, or appendix only
   where it changes confidence or a decision;
5. **把建议写成可执行动作**: make owner, timing, dependency and acceptance
   condition explicit when the task needs them;
6. **做一次读者复核**: read only the title, first paragraph, headings,
   highlighted numbers, conclusion and next action; if the intended reader
   cannot recover the point, revise the structure before polishing sentences.

When `oral` is active, apply its story spine and visual checks without turning
a 公文 into a marketing page. When `ds-write` is active, downgrade claims or
surface limitations when the supplied evidence cannot support the wording.

### 5. Use controlled language

- Use concise, neutral, institutional Chinese. Avoid advertising language,
  emotional exaggeration, empty slogans, and unexplained English acronyms.
- Keep titles, headings, numbering, names, units, dates, amounts and verbs
  consistent throughout the document.
- Preserve quoted policy language exactly and cite its source when one is
  supplied; do not paraphrase a legal or policy requirement into a stronger
  obligation.
- Use `[待补：发文机关]`, `[待核：统计口径]`, or `[待确认：截止时间]` when
  the missing field affects correctness. Never fill it with a plausible guess.
- Keep recommendations visibly separate from facts, and label scenarios and
  assumptions.

### 6. Produce the artifact

Start with Markdown or a structured draft. Choose the output route only after
the content and reader checks:

- `kdense-docx` / `documents`: create or edit DOCX and render it for inspection;
- `officecli`: inspect or adjust an existing Office document;
- `lark-doc` / `lark-drive`: read or write an explicitly authorized Feishu
  document, retaining its token and version metadata rather than a temporary
  download URL;
- PDF/HTML: render from the reviewed source and keep the source alongside the
  export.

Do not claim a file was uploaded, approved, issued, or delivered until the
corresponding tool receipt exists.

### 7. Quality gate and handoff

Run the checks in [official-document-quality.md](references/official-document-quality.md)
and [output-and-qa.md](references/output-and-qa.md). At minimum verify:

1. document type and audience match the brief;
2. every material number, name, date, policy reference and conclusion is either
   supported by supplied material or clearly marked as pending verification;
3. requested action, owner, deadline and decision status are unambiguous;
4. confidential content is not accidentally exposed;
5. headings, numbering, tables, page breaks and exports render correctly;
6. unresolved fields and limitations are visible to the recipient.

Return a short handoff containing artifact path(s), document type, chosen
writing stack, unresolved fields, and the next approval or review action. Do not
expose hidden chain-of-thought; expose only checkable decisions, assumptions,
edits and results.

## Collaboration and incremental updates

When a document is produced by Team/`ds-team`:

- The Lead owns the `document_contract`, outline and final version; Workers may
  propose sections or checks but cannot silently change the contract.
- A Worker should return a compact patch: changed section, wording rationale,
  unresolved fields and recommended next action.
- If a reviewer or user supplies corrections, revise the affected sections and
  terminology together. Do not merely append a correction at the end.
- A paused or offline contributor leaves a durable task and status; do not mark
  its section complete from silence.

## Safety stop conditions

Pause and request confirmation when the requested output would require a
fabricated official fact, an unverified policy basis, an unauthorized
publication, disclosure of restricted information, or a legal/administrative
conclusion outside the supplied authority. A useful draft with visible
placeholders is preferable to a polished but false document.
