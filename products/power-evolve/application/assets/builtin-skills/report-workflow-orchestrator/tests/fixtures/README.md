# Chapter confirmation fixture

English | [中文](README.zh.md)

`chapter-review-passed.json` is the unchanged synthetic QA state captured by the controlled file readback at `2026-10-03T01-38-36-718Z`, before Chapter 1 user confirmation. Its formal v1 review incorrectly accepted citation order; the actual body and original pass remain part of the regression input. The tests operate on temporary copies and never access the running report directory.

The captured chapter CLI case uses the real state, engine, deterministic gates and review-version binding. Generated revision and reviewer responses in the tests are supplied protocol inputs, not evidence of a real model generation or formal report-reviewer acceptance. Other confirmation-point cases construct stage inputs from the QA snapshot to exercise routing and guards; their synthetic final-report/abstract content is not a completed report.

`chapter-revision-limit.json` is the unchanged synthetic QA readback at `2026-10-03T03-06-00-567Z`: Chapter 2 version 3, `AWAITING_USER`, no pending action, three failed revisions and a latest `deterministic_chapter_summary_gate` major revision bound to v3. Tests use temporary copies, synthetic v4 body/figure paths and protocol reviewer inputs to exercise recovery, continued gates and review binding. They neither use an unapplied runtime draft nor assert that its content passed a real formal review.
