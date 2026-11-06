# Challenge Compatibility Stage Profile

This profile adapts one sealed Challenge task from the IOAI compatibility engine to the native
DeepScientist workflow. The native stage owns research reasoning and durable
state. The `ioai_competition` tool is an execution Adapter only.

## Shared Rules

- Reuse the same task identity, evaluator audit, validation contract, and
  environment preflight across all stages.
- `science_artifact` is the only owner of Idea, Optimization Line, Candidate
  Attempt lineage, experiment interpretation, and the optimization frontier.
- `ioai_competition` owns task sealing, evaluator execution, budgets, resource
  leases, immutable result packets, caches, recovery, and submission receipts.
- Register every accepted IOAI packet as Science evidence before using it to
  update an Optimization Line.
- Never replace a canonical evaluator score or compare different evaluation
  profiles. Smoke and sprint results may screen attempts but cannot promote a
  line; contest or audit evidence is required.
- Freeze local validation to the sealed test independence boundary. Fit all
  learned preprocessing, encoding, feature selection, calibration, threshold
  selection, and blend weights inside each fold. Public-leaderboard feedback
  is an external distribution diagnostic only and cannot tune or promote
  candidates.
- Skip broad paper searches, manuscript work, broad environment rediscovery,
  fixed time stages, and repeated task adaptation. One bounded online research
  pass is allowed at the first Search entry after the accepted baseline and
  sealed task fingerprint.
- This profile overrides generic stage text that requires quest `plan.md`,
  `PLAN.md`, `CHECKLIST.md`, candidate-board files, paper contracts, milestone
  messages, or per-attempt Git branches. Do not create those surfaces merely
  to satisfy the research workflow; the Science artifact ledger and immutable
  IOAI packets are the competition control surface.
- Do not load `research_evidence`, the IdeaSpark paper-retrieval/scripts/render
  pipeline, paper references, or domain skill packs unless the sealed task
  itself makes them necessary. `ds-idea` may read only the small set of
  original IdeaSpark ideation-pattern cards selected for the measured
  bottleneck. Do not invoke a generic research `bash_exec` path for evaluator
  work: all preflight, baseline, trial, tuning, and report execution goes
  through `ioai_competition`.
- In generic stage text, `artifact.submit_idea`,
  `artifact.get_optimization_frontier`, and
  `artifact.record_main_experiment` are conceptual aliases. The exact MCP
  calls are `science_artifact(action="submit_idea")`,
  `science_artifact(action="get_optimization_frontier")`, and
  `science_artifact(action="record_main_experiment")`.
- A textual expected-benefit judgment may help explain a choice, but Agent
  priority, expected-value, novelty, and information-gain numbers never rank
  the native frontier. Promotion requires measured evidence, a mechanism,
  falsification, comparability, cost, and a stop condition.
- Do not preload every native stage skill. Keep the native Science, artifact,
  and workflow controllers loaded; on the first Bootstrap wake, load only `ds-intake-audit` and `task-contract` as stage-specific skills. After each
  durable transition, load the matching `ds-*` stage skill and IOAI adapter only when entering that stage. Do not reread completed-stage skills on every turn.
- Bundle artifact and evaluator fixture paths are relative to the directory
  containing `bundle.json`. For example, use `fixtures/valid_scenarios.json`,
  not a project-root path or a path prefixed with the bundle directory name.

## Copyable Idea And Line Contract

Use the logical `idea_id` as the stable mechanism identity. The
`source_candidate_id` on a promoted line must equal the candidate brief's
logical `idea_id`, never the returned Science artifact ID.

```text
science_artifact(
  action="submit_idea",
  mode="create",
  submission_mode="candidate",
  idea_id="idea_REPLACE_WITH_STABLE_MECHANISM_ID",
  title="REPLACE_WITH_TITLE",
  problem="REPLACE_WITH_MEASURED_FAILURE_OR_TASK_STRUCTURE",
  hypothesis="REPLACE_WITH_TESTABLE_EXPECTATION",
  mechanism="REPLACE_WITH_CAUSAL_MECHANISM",
  evidence_paths=["REPLACE_WITH_PROJECT_RELATIVE_EVIDENCE_PATH"],
  falsification_plan="REPLACE_WITH_CHEAPEST_DECISIVE_CHECK",
  decision_reason="REPLACE_WITH_EVIDENCE_COST_AND_STOP_REASON"
)

science_artifact(
  action="submit_idea",
  mode="create",
  submission_mode="line",
  idea_id="idea_REPLACE_WITH_STABLE_LINE_ID",
  line_id="line_REPLACE_WITH_STABLE_LINE_ID",
  source_candidate_id="idea_REPLACE_WITH_STABLE_MECHANISM_ID",
  title="REPLACE_WITH_TITLE",
  problem="REPLACE_WITH_MEASURED_FAILURE_OR_TASK_STRUCTURE",
  hypothesis="REPLACE_WITH_TESTABLE_EXPECTATION",
  mechanism="REPLACE_WITH_CAUSAL_MECHANISM",
  evidence_paths=["REPLACE_WITH_PROJECT_RELATIVE_EVIDENCE_PATH"],
  falsification_plan="REPLACE_WITH_CHEAPEST_DECISIVE_CHECK",
  decision_reason="REPLACE_WITH_PROMOTION_REASON"
)
```

## Intake Audit

Read `system_status`, reuse or create one `environment_preflight`, import the
sealed task, and run `evaluator_audit`. Produce one Competition Task packet and
route directly to `ds-baseline`. Do not inventory unrelated research assets.

## Baseline

Use the simplest legal end-to-end candidate and the strongest conventional
method justified by the task type. Execute baseline work only through
`ioai_competition`. Keep the accepted metric, direction, validation identity,
fold/slice metrics, out-of-fold evidence when available, and packet hash in
Science evidence. Any learned preprocessing, encoding, feature selection,
calibration, threshold, or blend weight must be fitted independently inside
every fold. Do not reproduce papers or search for a publication baseline.

After baseline acceptance, route to `ds-idea`; do not jump directly to a swarm
of parameter candidates.

## Deterministic Simple-Task Fast Path

Use the `deterministic-simple-task.v1` route only when every condition is
supported by the sealed task, audited evaluator, and baseline evidence:

- the task is fully observed and deterministic, with no learned parameter,
  stochastic training, hidden-label inference, or generalization choice;
- a classical exact algorithm follows directly from the task structure and
  output contract, rather than from an unsupported model preference;
- correctness and legality can be checked end to end on the sealed cases with a
  cheap deterministic run;
- the metric has a proved finite optimum or the algorithm has a checkable exact
  correctness criterion.

If any condition is uncertain, use the normal Idea and Optimize profiles. When
all conditions hold, record one minimal mechanism brief and promote it directly
to one Optimization Line with the task/evaluator evidence, contrary failure
case, cheapest end-to-end check, cost, and stop condition. Skip the current
board, IdeaSpark cards, alternative-family generation, candidate ranking,
fusion, and tuning. Refresh the native frontier once, enter `seed` or `loop`,
and dispatch the first executable candidate immediately.

One independent legality, simulator, or reproducibility audit may run in parallel when it can falsify the direct method, but it must not block the first trial. After the canonical result, pass through `ds-decision`. If a proved
optimum is attained, use the proven-optimum finish; otherwise leave this route
and resume the normal evidence-driven search from the observed failure.

## Idea

Use `ds-idea`'s Challenge fast profile. Submit mechanism-level candidate
briefs with `science_artifact(action="submit_idea", ...)`, and promote only
directions that pass its evidence and falsification gate.

Before generating the first normal Search briefs, the Lead may run the single
Initial Research Pass defined by that profile. It writes
`artifacts/idea/competition_research.md`, records exact URLs plus internet and
retrieval disclosure, and stops after supporting one or two actionable
mechanism families. Reuse the packet and send selected findings to Subagents;
do not let each lane browse independently. External findings remain priors and
cannot replace sealed-task, baseline, error-slice, or canonical trial evidence.

## Optimize

Start by calling `science_artifact(action="get_optimization_frontier", ...)`.
Use the native brief, rank, seed, loop, fusion, debug, or tune submode. Search
decisions come from native artifacts and measured evidence, never Agent-authored
expected-value fields in an execution queue.

## Experiment

Materialize one attributable Candidate Attempt from an accepted Optimization
Line. Use `trial_run` for the first ready attempt and `trial_batch` for later
independent attempts. Core Team may prepare candidates concurrently; the IOAI
execution Adapter controls evaluator concurrency and resource admission.

After a run, validate identity, packet hash, profile, metric direction, and
comparability. Register the packet as Science evidence, then call
`science_artifact(action="record_main_experiment", ...)` with a complete lesson
capsule: observed effect, failed or unestablished assumption, reusable
component, do-not-repeat constraint, next search boundary, and canonical
evidence refs. The Lead validates this capsule against the Coordinator packet;
Subagent prose never replaces canonical status or score. Do not let the
execution Adapter choose the research route.

## Decision

Read the native optimization frontier and relevant canonical packets. Choose
one of explore, exploit, fusion, debug, tune, or stop from evidence. Preserve a
low-correlation line only when its predictions or error clusters are actually
different. Repeated comparable non-improvement is a family-shift signal.
Before refilling a slot, cite one applicable `recentLessons` entry in the
assignment evidence or explicitly record `lesson_not_applicable` with a reason.

## Finalize

Use `report_generate` to freeze the competition execution report, then register
it in the existing Science artifact ledger and publish the Science report.
State the incumbent, validation identity, packet references, limitations,
remaining uncertainty, and submission receipt status. Do not create a paper
bundle unless the user separately expands scope.

Use the proven-optimum fast finish only when the audited evaluator or sealed
official metric contract proves a finite optimum and a valid contest-profile
incumbent attains that exact bound. A score of `1.0` alone is not proof. Stop
new ideas, tuning asks, trials, and refills; allow at most two already-running
checks that can still falsify legality or reproducibility, materialize the
submission artifact, rerun it cleanly under the audit profile, validate every
output row and hash, and freeze the audit report. Reopen Search if audit fails.

Science state must already be incremental from Idea and Experiment. During
this fast finish, reuse the existing run and known artifact IDs. Do not probe
generic `create`, `patch`, `snapshot`, or `publish` shapes. Make one
contract-correct closure/publish call after the Coordinator report, repair at
most one cheap explicit graph warning, and leave the presentation partial if
that still fails; immutable Coordinator packets and reports remain the
competition evidence.

Any submission Notebook must also pass one clean internet-disabled execution
from top to bottom in a fresh session with fixed seeds, declared dependency
versions, no hidden memory or local-only artifacts, and final schema, null,
range, ID, order, and hash checks against the audited incumbent.
