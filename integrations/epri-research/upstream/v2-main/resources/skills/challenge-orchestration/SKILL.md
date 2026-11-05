---
name: challenge-orchestration
description: Coordinate a DeepScientist Challenge run as its Lead Agent, including sealed bootstrap, bounded SOTA reconnaissance, parallel Git-worktree candidate delegation, verified integration, canonical evaluation, lane refill, and finalization. Use only for the Challenge Lead role; candidate Subagents use ioai-candidate-preparation instead.
---

# Challenge Orchestration

Act as the routing layer for the Challenge Lead. Treat the role Prompt as the
exact execution contract: it owns schemas, tool names, permissions, sealed
identity, submission authority, and failure rules. This Skill only selects the
current phase and keeps the Lead's control loop compact.

## Preserve Ownership

- Treat the Competition Coordinator as the sole source of truth for sealed
  task state, budgets, canonical scores, packets, and the frontier.
- Treat Core Team as the sole owner of Agent lifecycle, turns, wakeups, pause,
  cancellation, and deletion.
- Treat Git branches and isolated worktrees as candidate delivery boundaries.
  Subagents prepare and commit; only the Lead validates and integrates.
- Use only `challenge_delegate`, `challenge_wait`, and `challenge_integrate` for
  Challenge coordination. Never create a second Team runtime beside the
  Challenge Coordinator.
- Never let a Subagent dispatch another Agent, run canonical evaluation, merge
  a branch, update the frontier, or submit.
- Never create parallel coordination, evaluation, or score state.

## Select One Phase

### Bootstrap

Use when no adopted Search Startup Snapshot exists.

1. Resolve the runtime-hashed Coordinator tool exactly as required by the role
   Prompt, then run the prescribed lock and bootstrap path.
2. Read `task-contract` only when task material must be normalized or repaired.
3. Read `baseline` only when the baseline adapter fails or its evidence needs
   repair. Do not reopen successful bootstrap stages.
4. Move directly to Search after the first accepted baseline and sealed task
   fingerprint. Do not write optional reports before the first real trial.

### Search

Use after a verified baseline or when an authoritative Search Startup Snapshot
was injected.

1. Read the current Coordinator snapshot once and form two or three distinct,
   evidence-grounded mechanism hypotheses.
2. Perform one bounded SOTA reconnaissance only when the role Prompt permits
   it. Reuse that packet across lanes; never send every Subagent online.
3. Fill available lanes through `challenge_delegate`. Give each lane one atomic
   hypothesis, one attributable change, one candidate path, and one stop rule.
4. If a short observation is useful, call `challenge_wait` at most once with
   `wait_level="1m"`, `"5m"`, or `"10m"`; then end the Lead turn. Core wakes the
   same Lead after verified evidence or an explicit failure. This is not a
   completion loop, and Subagents never call it.
5. For every returned candidate, verify identity, cheap-check evidence, clean
   Git delivery, full commit, and declared dependencies. Integrate with
   `challenge_integrate` before evaluation.
6. Batch independent ready candidates when the resource contract allows it.
   Compare only canonical evidence, reject failed mechanisms, and refill free
   lanes immediately with the highest-value remaining hypotheses.
7. Use `trial` only to repair an evaluator-adapter interaction. Use the native
   idea, optimization, experiment, and decision reasoning already embedded in
   the Prompt; do not preload the general Skill catalog.

### Finish

Use when improvement plateaus, the time reserve is reached, or no legal Search
work remains.

1. Stop new branches and audit the best eligible canonical incumbent.
2. Read `evaluate-submit` only when sealed submission authorization is present
   and the exact submission adapter is needed.
3. Read `report` only to materialize required final artifacts.
4. The Challenge workbench derives its canonical score comparison and, when
   comparable timing exists, its score-versus-evaluation-time view directly
   from the Coordinator snapshot. Do not duplicate either chart in progress
   updates. Read `deepscientist-report-chart` only when the final report needs
   one different decision-bearing verified view.
5. Finalize the Coordinator state and report limitations, receipts, and any
   unverified claims. Never invent a score or submission result.

## Recovery Rules

- On a frontier revision conflict, refresh once and continue from the new
  revision; never retry a stale mutation.
- On model capacity, preserve the exact assignment and let the Core fallback
  flow retry that same lane. Do not create duplicate candidate identities.
- On a dirty or conflicting worker branch, quarantine that delivery and keep
  healthy lanes moving.
- In Coordinator recovery mode, prepare only the minimum valid recovery
  candidate named by the current recovery contract.
- Without explicit submission authorization, stop at a verified final package.

## Routing Examples

- Baseline accepted, three lanes free: create orthogonal model, data, and
  objective hypotheses; delegate all three; wait once; end the turn.
- Worker returns a commit: validate the packet and commit, integrate it, then
  admit it to a canonical trial or batch. Never evaluate the worker path.
- One lane hits capacity: leave its assignment unchanged, refill only other
  free lanes, and wait for Core's fallback wakeup.
- Time reserve reached: stop delegation, select the best canonical incumbent,
  run the authorized finish adapters, and produce the final report.

Do not read manuscript, presentation, office, cron, Skill-authoring, or broad
domain Skills unless the sealed task itself explicitly requires one and the
role Prompt permits it.
