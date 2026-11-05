---
name: evaluate-submit
description: Audit canonical Challenge evidence and, only under a sealed pre-task platform authorization, reserve and record one official submission. Use after audit-profile trial results arrive or when deciding whether to continue local work.
---

# Challenge Evaluate And Submit

Make an evidence-grounded decision without becoming a second evaluator or
frontier writer. Official submission is an optional, separately authorized
Lead-only path; the default remains disabled.

## Keep the boundary explicit

- Treat the Python Competition Coordinator and canonical sealed evaluator as
  the only authorities for scores, lifecycle, ordering, budget, and frontier.
- Do not edit `.deepscientist/competition/`, recalculate a free-form score, or
  overwrite the incumbent selected by the canonical snapshot.
- Do not call trial or report write actions in this workflow. Route research
  direction changes to native `ds-decision` / `ds-idea` / `ds-optimize`,
  execution to `trial`, and freezing to `report`.
- Require normal workflow responses to keep `official_submission_enabled: false`. Only `official_submission` may return true, and only when its returned
  authorization hash matches the pre-task sealed authorization.
- Subagents never call `official_submission` or Kaggle submission tools.
- The Lead performs one platform preflight and owns the only Kaggle CLI/notebook
  operator. Reuse its authentication, network, quota, and authorization receipt;
  never ask multiple Agents to diagnose the same platform state.

## Establish current evidence

Require the absolute `project_root`, active `seal_id`, one `task_id`, passed
evaluator audit, explicitly confirmed baseline, latest trial result refs, and
packet hashes from `trial`. Read
[evaluation-contract.md](references/evaluation-contract.md) before making a
decision.
Require one explicit profile matching the trial handoff. Never read a different
profile's frontier to interpret the current score.

If engine status has not been checked in the current session, call:

```text
ioai_competition(action="system_status")
```

Continue only when the engine is ready, exposes `frontier_snapshot`,
`report_generate`, and the guarded `official_submission` action, while the
default capability remains disabled.

Read the canonical frontier:

```text
ioai_competition(
  action="frontier_snapshot",
  project_root="<absolute-project-root>",
  seal_id="<seal-id>",
  task_id="<task-id>",
  profile="<profile>"
)
```

Do not add an idempotency key. Verify seal/task identity, snapshot and
checkpoint hashes/refs, revision, incumbent, runner-up, candidates, failure
summary, lifecycle, lanes, and budget. Stop while `active_claim_ids` is
non-empty; wait for the Coordinator to settle before evaluating.

## Audit the local decision

1. Match each considered snapshot candidate to the immutable packet hash and
   result ref handed off by `trial`. Reject missing, mismatched, or tampered
   evidence.
2. Require the active seal, evaluator audit, evaluator/validation versions,
   task, metric direction, cases, candidate spec hash, and post-run gate to
   agree across packet and current contract.
3. Require `candidate_execution_mode: "executable"` and a passing, hashed
   Candidate Attempt receipt for any report or submission decision. Treat
   `static-evaluator-fixture` packets as evaluator tests only.
   Require the Coordinator's `candidate_evidence.eligible` and snapshot
   `canonical_evidence_eligible` fields rather than reconstructing this gate
   from Agent prose.
4. Exclude invalid, non-finite, partial, stale, leaked, rule-breaking, or
   incompatible evidence regardless of score. Preserve its failure kind and
   resource cost.
5. Require snapshot, candidate, packet, and validation profiles to match.
   `smoke`/`sprint` evidence can select a candidate for a `contest` rerun but
   cannot support `report`; `audit` and `contest` remain non-comparable.
6. Use the snapshot's canonical incumbent and runner-up ordering. Check it for
   internal consistency, but do not replace it with an Agent-computed ranking.
7. Compare the incumbent with the confirmed baseline and runner-up using
   primary metric, case-level pattern, failure rate, known deviations, token
   and compute cost, and lane diversity. Keep local and official evidence
   visibly separate.
8. Treat an unexplained jump, validation-only gain, leakage concern, unstable
   cases, missing trace, or weak independent evidence as an audit need, not as
   proof of generalization.
9. Treat a public-leaderboard score as external diagnostic evidence only. It
   may motivate one local distribution-shift check, but cannot tune the next
   candidate, select a threshold, promote a line, or override frozen local CV.

## Choose one route

Return exactly one decision with evidence refs and reasons:

- `report`: canonical incumbent is internally valid and evidence is adequate
  to freeze, with limitations stated.
- `trial`: run a specific diagnostic, ablation, repeat, or clean validation
  check before accepting the evidence.
- `idea`: current evidence supports a different mechanism-level hypothesis and
  budget remains; route through `ds-idea`.
- `optimize`: the current Optimization Line remains justified and needs a
  bounded ablation, tuning step, or implementation attempt through
  `ds-optimize`.
- `submit`: only the audit-profile incumbent is valid, the report/Notebook is
  frozen, and a matching unexpired authorization has remaining quota.
- `blocked`: integrity, legality, contract, evidence, or budget prevents a safe
  next action.

For `submit`, the Lead must first call `official_submission prepare`. Continue
only when it returns the expected authorization hash,
`status=send_reserved`, `quota_consumed_before_remote_send=true`, and the exact
Kaggle notebook tool sequence. Require the retained submission-mode result to
say `submissionMode=notebook`, `submissionsDisabled=false`, and
`metadataConflict=false`. Call `save_notebook` once with the authorized source;
that save creates and starts a fresh internet-disabled Kaggle version. Do not
create a separate interactive session. Persist the returned
`notebookVersionId`, then resume from a platform event or bounded exponential
backoff when calling `get_notebook_session_status`; release the reasoning turn
between checks and never create a replacement for an unchanged running job.
Require `versionMatched=true` and terminal `complete`. The saved version must
run cleanly from top to bottom in a fresh session.
The Notebook must use fixed seeds and declared dependency
versions, have no hidden memory or local-only artifacts, and pass final output
schema/null/range/ID/order/hash checks against the audited incumbent.

Then call Kaggle `create_code_competition_submission` exactly once with the same
local `attempt_id`, exact Notebook version, and output filename. Persist the
remote submission id and resume through an event or bounded exponential backoff
until terminal state. If the create response is uncertain, never resend:
call `search_competition_submissions` with `attempt_id`,
`notebook_version_id`, `notebook_ref`, and `file_name`; require `complete=true`,
`exactReconciliation=true`, `ambiguous=false`, and exactly one result before
calling `get_competition_submission` with the same `attempt_id` and
`notebook_version_id`. Save that final exact-reconciliation response as JSON
and call `official_submission record` with the same local attempt. Do not claim
success until the Coordinator returns a hashed receipt.

## Completion gate

Finish with the snapshot revision/hash, incumbent and runner-up identities,
baseline comparison, accepted and rejected packet refs, failure/cost summary,
limitations, one decision, and the exact evidence needed to change it. When a
submission occurs, include the quota-accounted local attempt, remote Notebook
version/submission ID, terminal status, raw receipt hash, and Coordinator
receipt hash.

Route `report` decisions to the `report` Skill. Route local alternatives to
their named workflow. A missing, expired, mismatched, or exhausted submission
authorization always falls back to the default-disabled path.
