---
name: research-power
description: Run a power-engineering research task through method selection, an Airalogy table, real calculation and charts, native conversational review, pinned evidence and a report. Use for electric measurements, calibration, data quality, forecast assessment and other structured engineering studies.
---

# Power research in Harness

Use the installed research tools and the same conversation's right sidebar. Read `research-science` and `research-protocol` for general evidence and record rules.

1. Clarify objective, input availability, units, acceptance criteria and data basis. Call `research_method_catalog` with a short scenario keyword (标定, 数据质量, 负荷预测). These are lexical candidates, not proof of applicability. Read `research_method_get` for exact source. Built-in limits are examples to be checked against this test's requirements, never universal industry limits.
2. Call `research_task_create` with the agreed objective, explicit method ID/version and honest basis (`measured`, `synthetic`, `literature`, `estimated`). The compact workbench opens the task in the same right sidebar. No match: omit both method fields and record missing method/tool in requirements. Unknown scenarios are not already executable. Imported protocol packages use the same catalog; optional `method.json` supplies description, keywords, limitations and boolean `qcField`. Use `research_task_select_method` to choose a method for an unstarted task.
3. Read `research_task_get`. Call `research_task_open` for the native exact-source human question. Decline/skip/stale answers never approve. It prepares the immutable method and binds one record after confirmation. Never obtain human credentials. Repeated calls resume the same experiment. Docker must be ready; diagnose with `research_engine_status`.
4. The user fills the table or imports UTF-8 CSV in the task page. Only user-owned input columns may be imported. Real source attachments are retained. Approved Airalogy auto assigners calculate outputs and charts; inspect errors/pending fields. False QC remains false. Prediction assessment evaluates supplied predictions, not model training. Calibration checks the stated residual criterion, not full equipment certification.
5. Call `research_record_submit` for a native human question when ready. Do not set human checks yourself. The task-page button only drafts the request into the conversation; the user sends it. Data changes invalidate old checks.
6. Call `research_task_evidence` to save the submitted record as pinned, pending evidence. Read `research_task_get`, then call `research_evidence_review` on the returned evidence ID/current revision for native human review. Preserve failed outcomes and true data basis.
7. Call `research_task_report` after current evidence is accepted. It compiles actual inputs, metrics, chart data, source fingerprints, review and limitations. It refuses reopened records/stale evidence. Failed QC is reported as failed. Reports live in Research routes and evidence → Reports and export with `.aira`.

Do not create a second scheduler, login or approval panel. External simulations, device control, unavailable dependencies and arbitrary new scenarios require validated method packages. File existence does not prove a working integration.
