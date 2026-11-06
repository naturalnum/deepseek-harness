# Challenge Tune Profile

Use this profile inside a selected native Optimization Line when a bounded
mixed or conditional parameter space and enough affordable evaluations make
sequential model-based optimization more useful than direct ablation.

## Deterministic Fast-Path Exclusion

For an Optimization Line tagged `deterministic-simple-task.v1`, do not open `tune`, `rank`, or `fusion`. Refresh the native frontier once, use `seed` or
`loop` to materialize the direct exact candidate, and send it to evaluation
immediately. A non-attaining, invalid, or non-reproducible result exits the tag
and returns to normal evidence-driven Idea/Optimize routing.

## Ownership

- `ds-idea` selects and justifies the mechanism family.
- `ds-optimize` owns the route, Optimization Line, and attempt interpretation.
- `science_artifact` owns durable Idea/frontier/result state.
- `ioai_competition` owns the Optuna study files and evaluator execution as an
  implementation Adapter. The study is not a second research frontier.

## Open A Study

Pass a mechanism-resolution gate before opening the study:

- the native frontier contains one accepted durable Optimization Line;
- that line has at least one valid, contest-profile parent Candidate Attempt;
- the strongest plausible alternate mechanism has been evaluated or rejected with task evidence, cost, and a stop condition;
- every parameter changes behavior inside the accepted mechanism rather than selecting a different model family;
- the remaining budget can evaluate enough unique assignments to learn more than a direct ablation.

Apply this gate from task evidence rather than a fixed task-type recipe. A
strong control remains a control when it leaves the diagnosed bottleneck
unchanged. Promote it only when canonical evidence supports the claimed
mechanism, not merely because it is cheap or currently leads the scoreboard.

Call `tune_create` with the project root, active `seal_id`, selected `task_id`,
stable study id, `idea_id`, durable line id, metric direction, declared search
space, the canonical `parent_candidate_id` of the evaluated mechanism attempt,
and optional deterministic seed. The parent must carry a valid
`search.lineage` contract whose role is `mechanism`, whose level is
`mechanism` or `implementation`, and whose Idea/Line identities match the
study. The Adapter hashes and freezes that parent lineage. Later `tune_ask`
calls provide only the study, seal, and task identities; the Adapter derives
the immutable parent binding from the study contract. Every
search-space field must have a rationale or prior from the accepted brief. Do
not expose unrestricted code generation as a parameter.

The Adapter uses asynchronous Optuna TPE ask/tell. If Optuna is unavailable it
must return `capability_unavailable`; do not silently fall back to random
sampling.

## Asynchronous Loop

1. Call `tune_ask` with the same `seal_id` and `task_id` only while evaluator
   capacity, task budget, and Competition Control allow another attempt. Bind
   the returned candidate to the sealed task, study, Idea, Optimization Line,
   search-space hash, and frozen parent candidate. Copy the returned
   `materialization_binding` unchanged into the Candidate Attempt's top-level
   `tuning` field. Its `search.lineage` must use `search_level=hyperparameter`,
   `candidate_role=mechanism`, and the same Idea/Line identities. A `tpe-*`
   candidate without both bindings is rejected before evaluator execution.
2. Materialize that parameter assignment as an implementation-level Candidate
   Attempt and evaluate it through `trial_run` or `trial_batch`.
3. Call `tune_tell` exactly once. For `complete`, pass the Candidate Attempt's
   `trial_id` and immutable `packet_hash`; Competition Control validates the
   sealed task, contest profile, candidate identity, direction, comparability,
   and materialization binding, then derives the objective value. Never provide
   a score or `value`. `pruned` and `failed` remain legal without packet fields.
4. Register the result through
   `science_artifact(action="record_main_experiment", ...)` and re-read the
   native frontier before choosing the next route.
5. Use `tune_status` for recovery and capability inspection, not as a source of
   research conclusions.

Pending attempts may run in parallel. A new ask may happen as soon as any prior
attempt finishes; do not wait for a wave barrier.

Every materialized assignment must have a parameter hash not previously
suggested by that study. The Adapter resamples duplicates and fails closed when
the bounded search space cannot produce another unique assignment; callers
must not turn repeated suggestions into repeated evaluator trials.

When the Adapter returns `competition_control_recovery_required`, stop opening
studies and asking for suggestions. Read `contest_snapshot`, run the indicated
`recover_minimum_valid_candidate`, and resume tuning only after the first valid
score is recorded. Existing `tune_create` replays, `tune_status`, and
`tune_tell` for already pending candidates remain available during recovery.

## Do Not Tune

Use direct, evidence-backed ablation instead when:

- the mechanism family is unresolved;
- the search space is undeclared, mostly free text, or dominated by coupled
  code changes;
- only one or two meaningful settings exist;
- the remaining budget cannot produce a useful posterior;
- validation is unstable, leakage-prone, or incomparable;
- a concrete bug must be fixed before performance search.

Successive halving may screen comparable attempts at different resource levels,
but only full contest or audit evidence can promote the Optimization Line.
