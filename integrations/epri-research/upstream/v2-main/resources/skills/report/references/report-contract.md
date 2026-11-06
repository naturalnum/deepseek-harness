# Immutable report contract

Generate reports only through `report_generate` after reading the canonical
frontier. The call freezes one exact revision and writes both artifacts under a
Coordinator-owned report directory.

## Operation fields

Call:

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

The action requires `project_root`, `seal_id`, `task_id`, optional `profile`
(default `contest`), `expected_frontier_revision`, and `idempotency_key`. A revision or profile change is a new
request and requires a new key. An exact retry uses the same key and must return
the same report through idempotent replay.

## Result fields

Require:

- `operation: "generate"` and action version 1;
- matching seal/task identity and requested frontier revision;
- matching profile, exact profile contract, and final-evidence eligibility;
- canonical `report_id` matching `report-<8 hex>`;
- SHA-256 `report_manifest_hash` and `rendered_markdown_sha256`;
- normalized project-relative `report_manifest_ref` and `report_ref` ending in
  the canonical report directory;
- non-negative `limitation_count` and `trial_count`;
- replay flag, command receipt hash, and
  `official_submission_enabled: false`.

## Manifest checks

The version 1 manifest must bind:

- report ID, generated time, checkpoint save time/event offset, and frontier
  revision;
- task and validation contracts;
- evaluation profile, profile contract, and final-evidence eligibility;
- full canonical frontier, budget, and event summary;
- separate submission evidence levels and hidden-rerun audits;
- complete limitations and source hashes;
- rendered Markdown hash and manifest hash;
- disabled official submission capability.

Require `trial_count` to match the number of frontier nodes and
`limitation_count` to match the manifest limitations. The rendered Markdown
must hash to `rendered_markdown_sha256`. The manifest's stored hash must match
the returned manifest hash and the Coordinator's canonical JSON hash.

Missing official scored evidence, missing passed hidden-rerun audit, and missing
referenced evidence must remain explicit limitations when applicable. Claim
degraded or enforced network isolation only from a stored audit record; without
one, isolation is unverified. Dry-run receipts must never be presented as
official evidence. External concerns that are absent from the manifest may be
reported separately as unverified inputs, never inserted into canonical facts.
Quick-profile manifests must state that they cannot support final competition
claims. Evidence from another profile must never be inserted or compared.

## Replay and conflict rules

After reading the artifacts, repeat the exact generation request. Require
`replayed: true` and identical ID, revision, refs, hashes, and counts. The
engine replay validates canonical locations and both stored artifacts.

If replay reports an integrity error, stop and preserve the evidence; do not
edit, delete, or replace the report. If generation reports a revision conflict,
read a new frontier snapshot and make a new freeze decision before using a new
revision/key pair.
