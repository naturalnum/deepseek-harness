---
name: report
description: Freeze, verify, and present an immutable Challenge report from one canonical frontier revision through the DeepScientist ioai_competition compatibility MCP. Use after evaluate-submit selects the report route, during the protected report window, or when a prior report must be replay-verified after suspected tampering.
---

# Challenge Report

Generate one evidence-bound local report package without reopening research direction
search or editing canonical competition state by hand.

## Preserve canonical ownership

- Treat the Python Competition Coordinator behind `ioai_competition` as the
  only writer of report manifests and rendered reports.
- Do not edit `.deepscientist/competition/` or patch a generated report. Create
  a new report at a new frontier revision when evidence changes.
- Do not add claims, scores, costs, receipts, or compliance conclusions that
  are absent from immutable evidence.
- Keep dry-run, local sealed, hidden-rerun, and official evidence distinct.
  Require `official_submission_enabled: false` in every MCP response.

## Verify the freeze point

Require an absolute `project_root`, active `seal_id`, one `task_id`, and a
`report` decision from `evaluate-submit`, all under one unchanged profile. Read
[report-contract.md](references/report-contract.md) before generating or
re-verifying a report.

If engine status has not been checked in the current session, call:

```text
ioai_competition(action="system_status")
```

Continue only when the engine is ready, lists `frontier_snapshot` and
`report_generate`, and keeps official submission disabled.

Immediately before generation, read:

```text
ioai_competition(
  action="frontier_snapshot",
  project_root="<absolute-project-root>",
  seal_id="<seal-id>",
  task_id="<task-id>",
  profile="<profile>"
)
```

Require a matching identity, valid snapshot/checkpoint hashes and refs, a
canonical incumbent when valid results exist, and no active claims. Record the
exact `frontier_revision` and snapshot hash.
Require `canonical_evidence_eligible: true` before presenting the report as
final. The incumbent `candidate_evidence` assessment must be `eligible` with a
passing Attempt status, source manifest hash, and receipt hash. A false value
permits only a limitation-bearing non-final report.

## Freeze the report

Call with a key bound to the seal, task, and revision:

```text
ioai_competition(
  action="report_generate",
  project_root="<absolute-project-root>",
  seal_id="<seal-id>",
  task_id="<task-id>",
  profile="<profile>",
  expected_frontier_revision=<current-revision>,
  idempotency_key="report-generate-<seal-id>-<task-id>-r<revision>"
)
```

Reuse that key only for the exact same request. On `revision_conflict`, read a
fresh snapshot and decide whether to freeze the new evidence; if so, use its
revision and a new key. Never substitute the returned revision blindly.

## Verify immutable output

Accept the first result only when operation, seal/task identity, frozen
revision, canonical report ID, manifest/report refs, both SHA-256 hashes,
trial/limitation counts, command receipt, and disabled submission capability
are valid.
Require the returned profile and profile contract to match the request. A
`smoke` or `sprint` report must remain explicitly ineligible for final claims;
route its candidate to a contest rerun instead of presenting it as final.

Read the referenced manifest and Markdown without modifying them. Verify the
manifest identity and hash, rendered Markdown hash, task and validation
contracts, frontier/incumbent, budget, event counts, source hashes,
submission/audit evidence levels, limitations, and count consistency.

Then repeat the exact `report_generate` call with the same idempotency key.
Require `replayed: true`, the same report ID, refs, hashes, revision, and counts.
This replay invokes the Coordinator's stored-artifact integrity checks; a
tampered manifest or Markdown must fail closed rather than create a replacement.

## Present without rewriting history

Summarize the canonical report with:

- task, rule, validation, evaluator, seal, and frozen revision;
- baseline, incumbent, runner-up, trial outcomes, failure classes, and cost;
- leakage, isolation, reproducibility, and compliance evidence actually stored;
- dry-run and any historical official receipts in separate sections;
- all limitations, missing evidence, and facts that remain unverified;
- manifest/report refs and hashes needed for reproduction.

Absence of an official scored receipt or passed hidden rerun is a limitation,
not a reason to invent one or suppress the report. Do not claim that generating
the report submitted anything. State a network-isolation outcome only when the
manifest contains the supporting audit; without one, say isolation is
unverified, not that it passed or failed.

## Completion gate

Finish only when the exact replay passes, both artifacts match their hashes,
quantitative claims trace to immutable evidence, all limitations remain
visible, and official submission is still disabled. Return the report ID,
revision, refs, hashes, counts, limitations, and verification status.
