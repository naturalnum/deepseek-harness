---
name: deepscientist-mathematics
description: Evidence-first mathematics research for conjecture discovery, formalization, proof search, counterexample construction, Lean verification, independent review, and Git-backed recovery. Use as the mathematics extension inside Science Mode when a result must be supported or refuted with reproducible evidence before it is reported as proved.
---

# DeepScientist Mathematics

This skill is an optional extension of Science Mode. It keeps the existing
Science Artifact, Science Report, project Git workspace, `math_portfolio`, and
Lean verification contracts. It does not introduce a second chat, memory
database, project repository, or MCP protocol.

The runtime id is `deepscientist-mathematics`; `deepscientist_math` is only the
human-facing shorthand.

## Non-negotiable contract

Treat a mathematical result as a scoped claim, not as a piece of persuasive
text. A conjecture is not proved or refuted because a model says so, because a
Lean file happens to compile, or because a search did not find a counterexample.

Keep these layers separate:

1. **Informal claim**: the user's question and intended meaning.
2. **Formal statement**: definitions, domains, quantifiers, assumptions, and
   the exact proposition checked by a proof assistant.
3. **Supporting evidence**: reproducible examples, calculations, literature,
   retrieved lemmas, experiments, or independent human/agent arguments.
4. **Refuting evidence**: a reproducible counterexample, failed obligation,
   inconsistent assumption, or a negation checked by the formal verifier within
   a declared scope.
5. **Kernel result**: a proof or refutation replayed from a frozen project
   revision with the declared toolchain.

Only a result whose scope, evidence, and verification boundary are explicit may
advance. Never silently turn bounded evidence into a universal claim.

## Canonical memory: Git first

Git is the only durable memory for mathematics work. Resume from the bound
project's committed tree, commit graph, and replay files, not from chat text,
an MCP process, a UI cache, or an Artifact projection alone.

- **Canonical**: committed project files, commit SHA, branch, checkpoint
  metadata, and replay manifests.
- **Projection**: `math_portfolio`, Science Artifact, Preview state, and
  conversation status rows. These must be rebuildable from canonical files.
- **Ephemeral**: model context, in-memory runs, uncommitted files, temporary
  stdout, and interrupted streams. Treat them as provisional or lost after a
  restart.

An uncommitted fact cannot support `Verified`, `Refuted`, or a final report.
The hidden Artifact Git ledger is provenance for Artifact state; it is not a
replacement for the source-project Git memory.

## Existing tool boundary

Use these tools only; do not invent another memory or orchestration tool.

- `project_workspace`: inspect status/frontier, manage approved branches, and
  create explicit checkpoints.
- `math_portfolio`: read its schema/starter template, validate without writing,
  and maintain the typed problem, attempt, example, verification, and review
  projection.
- `lean_workspace`: preferred Lean interface. Use one `execute` pipeline for
  public formula/Goal events plus certification, or one `certify` call with all
  independent theorem items. It is the only source of Lean kernel facts.
- `formal_verifier`: one-item compatibility facade only; do not use it for new
  multi-theorem work.
- `research_evidence`: retrieve external literature and source records.
- `science_artifact`: persist evidence, files, reports, and presentation;
  `research_roadmap`: validate and persist the typed goal/stage projection.
- `science_artifact(query_many|transact)`: read two or more independent records
  in one snapshot or atomically create/patch/replace a related batch. Reuse its
  receipts; do not follow it with status/get unless a conflict occurs.
- `user_input`: ask only a small, material scope or route question. In Codex,
  call `mcp__deepscientist_user_input__user_input` through the deferred tool
  namespace; never call native `request_user_input`.
- `report_chart`: validate and render a runtime-listed, evidence-bound native
  chart for the Science Report. Read `deepscientist-report-chart` first, use
  `describe` as the authority for available grammars, and normally call render
  once.
- Existing bounded command/file capabilities: run calculations, finite searches, or
  finite checks; save their command, scope, result, and Artifact links.

If a required capability is unavailable, return `blocked` or `unavailable`;
do not emulate it with prose.

## Runtime and routing preflight

Before intake:

1. Confirm the runtime prompt contains `Mathematical Research Extension` and
   the active skills contain `deepscientist-mathematics` and
   `deepscientist-report-chart`.
2. Confirm `project_workspace`, `math_portfolio`, `lean_workspace`, and
   `report_chart` are discoverable before attempting portfolio, proof, or
   report-chart work. `formal_verifier` alone indicates an older compatible
   runtime, not the preferred batch surface.
3. Treat the authorized project as already created and bound by the runtime.
   Call `project_workspace` directly and normally omit identity arguments. A
   missing or mismatched binding is a runtime fault; do not create, initialize,
   reopen, migrate, guess, or replace a project, path, or id to bypass it.
4. Classify the entry state from actual project results. A retry envelope, Git
   repository, or initializer commit alone does not mean the task is a resume.
   Use `intake-audit` only when meaningful prior baselines, results, drafts,
   reviews, portfolio entries, or research checkpoints exist; otherwise begin
   fresh mathematical intake.
5. If Discovery Mode is active, treat it as the sole continuation controller.
   Do not call Codex `create_goal`, `get_goal`, or `update_goal`, and do not
   create a second Goal. If it is absent, do not infer one merely because the
   conjecture is difficult; only the user or runtime may enable it.

If preflight fails, name the missing mode, skill, or tool; do not silently route
mathematics into generic intake or baseline work.

## Canonical project layout

Preserve the existing compatibility paths and use this layout when the bound
project supports it:

```text
mathematics/
  README.md, portfolio.json, verification-trace.json, branches.json, toolchain.lock
  corpora/<name>.json, problems/<problem-id>.md, formal/<problem-id>.lean
  examples/<problem-id>.jsonl
  attempts/<attempt-id>/{plan.md,result.json,replay.json,proof.lean,stdout.txt,stderr.txt}
  verifications/<verification-id>.json, reviews/<problem-id>/<review-id>.md, events/<run-id>.jsonl
  reports/<problem-id>.md, reports/<problem-id>.manifest.json
  figures/<figure-id>/{spec.json,caption.md,qa.json}
  figures/<figure-id>/{data,source,figure.svg,figure.pdf,figure.png}
```

Do not require every optional file for a small task, but every restart fact needs
a canonical path. Never overwrite an attempt or silently replace a benchmark statement.

## Evidence model

Every supporting or refuting item must be bound to the exact problem and, when
formalized, to a `statementHash`. Record at least:

```text
evidenceId, problemId, statementHash, kind, scope, method,
inputRefs, outputRefs, command, cwd, seed, observed,
reproducibility, sourceRevision, commit, createdAt
```

Use the existing `MathematicsExample.kind` values where applicable:
`positive`, `negative`, `boundary`, and `counterexample`.

Classify evidence by strength:

- `observed`: one execution or one source; useful for exploration only.
- `reproduced`: independently repeated with the same declared scope.
- `supporting`: multiple reproducible observations or a reviewed argument;
  supports a scope but does not establish a universal theorem.
- `refuting`: a minimal, reproducible witness that violates the exact
  statement under its assumptions.
- `formal`: a proof or negation checked by the declared formal verifier.

Evidence must answer what was tested, under which assumptions, what was observed,
and how to reproduce it. A failed search covers its region only; “no
counterexample found” is never a proof.

### Evidence balance and decision record

Treat every conjecture as two explicit evidence lanes:

| Lane       | What it can establish                                                                         | What it cannot establish by itself                                                       |
| ---------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Supporting | The exact statement survives the declared checks and may justify a proof attempt              | A finite sample, literature citation, or successful compilation is not a universal proof |
| Refuting   | A witness violates the exact statement under its assumptions, or a formal negation is checked | An unsuccessful search or timeout is not a refutation                                    |

Before a terminal decision, the report must show the current state of both lanes,
even when one lane has no decisive result. For each lane record the searched
scope, result (`qualified`, `reproducible`, `not_found`, `blocked`, or
`inconclusive`), and linked Science Evidence ids. A lane with no result must be
shown as a limitation, not silently omitted.

If both lanes contain decisive evidence for the same `statementHash`, stop and
mark the result `inconclusive` until the statement, assumptions, or evidence
provenance is reconciled. Never choose the more convenient lane. The final
Science Report should include an **Evidence balance** subsection with:

1. the exact statement and hash;
2. supporting evidence count, strength, reproducibility, and sources;
3. refuting evidence count, witness/negation status, and sources;
4. the machine-readable decision basis and missing gates;
5. limitations and the next reproducible action.

This is an evidence ledger, not hidden reasoning. Store concise observations,
commands, hashes, and conclusions; do not store chain-of-thought.

### Terminal decision gate

Before a portfolio or problem is marked terminal, build the following small
evidence matrix for the exact `statementHash`:

| Decision                     | Required basis                                    | Minimum reproducibility                  | Additional gate                                                                            |
| ---------------------------- | ------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `verified`                   | supporting evidence with a durable Science source | `reproduced`, `independent`, or `formal` | matching `claim=statement` kernel receipt and passed review on the same committed revision |
| `refuted`                    | refuting evidence with a durable Science source   | `reproduced`, `independent`, or `formal` | a linked minimal counterexample, or a matching `claim=negation` kernel receipt             |
| `candidate` / `inconclusive` | any scoped observations                           | any                                      | explicitly list what is still missing                                                      |

The server rejects a terminal record with a missing statement hash, a
`WORKTREE` evidence commit, command-only evidence without a durable output or
hash, a single-run observation, or a verification/review bound to another
commit. Keep older evidence for history, but do not count it if its statement
hash is stale. The Preview gate should show both lanes and their missing
requirements so that a reader can distinguish “not tested”, “not yet proved”,
and “refuted”.

Do not use an external solver, random test, symbolic calculation, or retrieved
paper as `kernel_verified`. If an SMT or native computation is used, record
its trust boundary and keep the result as bounded evidence until it is
reconstructed or checked by the formal verifier.

## Two-lane model

Discovery and proof use the same project Git workspace but have different
acceptance rules.

### Discovery lane

`intake -> exploration -> candidate -> falsification -> promotion | discarded`

- Write the problem brief, objects, domain, quantifiers, budget, and source
  provenance before generating candidates.
- Keep generated conjectures, numerical experiments, program candidates, and
  literature observations under `discovery/`, `examples/`, or an attempt
  directory. They are not proofs.
- Give every candidate a stable `candidateId` and normalized `candidateHash`.
- Run boundary, adversarial, finite, randomized, and negation checks before
  promoting a candidate.
- A reproducible witness immediately refutes that candidate. An unsuccessful
  search records `not_refuted_within_scope` and remains inconclusive.
- Promote only an explicitly selected candidate, retaining its assumptions and
  hash. Start a new proof attempt; never mutate the discovery record into a
  proof record.

### Proof lane

`formalization -> proving -> verification -> review -> report`

- Compare informal and formal statements side by side.
- Mark their relation `equivalent`, `stronger`, `weaker`, or `unknown`.
- If the relation is not `equivalent`, ask a choice-based user question or
  explicitly report the narrower scope; do not silently proceed.
- Keep each proof strategy, premise set, and model route in a separate
  attempt with a parent commit and a reproducible result.
- Only a matching named-theorem
  `claim + targetCommit + statementHash + proofHash + theoremDeclarationHash`
  receipt generated by `lean_workspace` certification can support kernel
  verification. `statementHash` is the portfolio's caller-supplied statement
  identity; the declaration hash comes from the committed Lean source. The
  independent review must confirm that the named declaration formalizes that
  statement or its normalized negation.
  Use `claim=statement` for proof and `claim=negation` for formal disproof.
- Reviewers work from a frozen commit. Any changed assumption, import,
  statement, or toolchain invalidates downstream verification and review.

## Read-before-think SOP

At kickoff, resume, or after a process restart:

1. Use the runtime-injected project summary when it is current. Otherwise call
   `project_workspace(action="status")` once and confirm the bound project,
   branch, HEAD, latest checkpoint, dirty files, and checkpoint contract. Do
   not poll status during ordinary proof work.
2. For a real resume, read the committed `mathematics/README.md`,
   `portfolio.json`, active problem, latest attempt result, relevant examples,
   review, and `toolchain.lock`. For a fresh task, do not perform a recovery
   inventory merely because an initializer commit exists.
3. Validate JSON, paths, hashes, and parent references. Use `frontier` only
   when route or branch state matters.
4. If the tree is dirty, report it as provisional. Do not overwrite, switch,
   reset, clean, or force-checkout it.
5. Continue only the `nextActions` lane whose inputs and hashes still match.
   Reuse completed results instead of repeating an identical call.
6. On a fresh portfolio, read `math_portfolio(action="schema")` or the starter
   template from an empty `get`, validate once, then submit. On later writes,
   reuse the returned `currentRevision` as `baseRevision`; call `get` again only
   after a conflict or when current contents are needed.

The conversation is an interface to the Git record, not the record itself.

## Write-ahead and checkpoint SOP

1. Write the factual problem, evidence, attempt, result, or review file first.
2. Use `math_portfolio` to validate and project the structured state.
3. Use `lean_workspace(action="execute")` when formula/Goal events and final
   checks belong to one deterministic pipeline. Put all independent theorem
   checks in its trailing `certify` operation. Use `action="certify"` directly
   when no public Goal trace is needed. Never copy a model message into a
   verification entry.
4. Use `science_artifact` for report/evidence presentation.
5. Create `project_workspace(action="checkpoint")` only after a meaningful
   stage change and verification. Supply an explicit stage, domain,
   `includePaths`, run/conversation identifiers, concrete verification, and the
   route that produced the work (`routeMode`: `explore`, `deepen`, `fuse`,
   `repair`, or `stop`). Project initialization and presentation-only
   checkpoints are exempt. Under Discovery Mode, also supply the matching
   `goalId` plus `researchStage` receipt.
6. Refresh the UI only after the checkpoint succeeds. A failed checkpoint
   keeps the state provisional.

Do not checkpoint every token or transient progress line. Checkpoint when a
problem, candidate, evidence result, proof attempt, verification, review,
recovery, or budget decision changes the resumable state.

## Long-horizon stage loop

Use one `research_roadmap` with a global evidence-backed `completionContract`,
and one node per active stage, not one Goal per stage. Before work, record the
objective/why next, prior work/do-not-repeat refs, acceptance/failure criteria,
authoritative checks, expected artifacts, and a bounded reflection budget.

Close each stage as `supported`, `refuted`, `exhausted`, `inconclusive`, or
`runtime_failed`. Record supporting/refuting evidence ids, the changed belief,
reflection, and the next objective in both the route outcome and checkpoint
receipt. A rigorous negative result is progress; tool/runtime failure is not
mathematical refutation and does not require a fabricated source checkpoint. If
no evidence changed, change the premise, region, strategy, tool, or verification
condition before retrying.

Before ending the overall task, audit every requirement of the persistent
objective against current authoritative evidence. A stage budget is a
checkpoint and reflection boundary, never proof, completion, or a reason to
stop a multi-hour investigation whose next stage still has information gain.

## Stage gates

| Gate          | Required evidence                                                       | Allowed outcome                                             |
| ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| Intake        | Problem brief, scope, budget, source provenance                         | `draft`                                                     |
| Formalization | Statement hash, assumptions, domains, alignment decision                | `formalized` or `blocked`                                   |
| Evidence      | Positive, boundary, and relevant negative checks with scope             | `candidate`, `refuted`, or `inconclusive`                   |
| Proving       | Separate attempt, plan, premises, parent commit, proof path             | `candidate`, `failed`, or `stale`                           |
| Verification  | Exact hashes, locked toolchain, clean replay, no open goals/sorry/admit | `kernel_verified`, `failed`, `blocked`, or `unavailable`    |
| Review        | Frozen commit, independent replay, issue list, verdict                  | `passed`, `changes_requested`, `refuted`, or `inconclusive` |
| Report        | Evidence, formal result, review, limitations, and next action linked    | final report or provisional report                          |

`Verified` requires both a successful verifier result and a passed independent
review. `Refuted` requires a reproducible witness for the exact statement. A
candidate with mixed evidence is `Inconclusive`, not false and not true.

## Formalization SOP

Extract and record:

- objects, types, finite/infinite domains, quantifiers, and dependencies;
- strict/non-strict relations and existence/uniqueness;
- positivity, non-zero, continuity, measurability, or boundedness assumptions;
- empty, zero, one, repeated, symmetric, and degenerate cases;
- whether the task is proof, construction, classification, value, or disproof.

Generate at least one conservative formalization. If multiple readings are
plausible, preserve all candidates and ask the user to choose. Compute a stable
hash from the normalized formal statement, not from a model paragraph.

## Supporting and refuting evidence SOP

Before expensive proof search:

1. Test the smallest legal values and all boundary cases that can change the
   truth value.
2. Test equality, zero/one/negative, repeated, extremal, limiting, symmetric,
   and degenerate cases where meaningful.
3. Run bounded exhaustive checks for finite domains with explicit bounds, then
   seeded random or adversarial generation with a saved seed and generator revision.
4. Preserve both positive observations and failed tests; the latter help
   future Agents avoid repeating the same search.

When a witness is found, minimize it, rerun it independently, record the exact
assumptions and command, and stop searching for a proof of the same statement.
If the witness violates a hidden assumption, update the statement hash and
start a new candidate rather than silently deleting the witness.

## Proof search SOP

Generate short plans for multiple lanes before expanding one:

- direct library lemma or simplification;
- induction or strong induction;
- contradiction or contrapositive;
- invariant, monovariant, or extremal principle;
- algebraic normalization, arithmetic automation, or finite decision;
- construction plus uniqueness, or a domain-specific geometry/combinatorics route.

Search cheap tactics before model expansion. Retrieve existing declarations and
record names, namespaces, imports, query, and source revision in the attempt.
Use compiler errors as structured feedback. Retry only after a concrete change
in strategy, premise set, code, budget, or environment.

Literature search is supporting evidence, not an intake prerequisite. Run at
most two targeted searches per worker batch, inspect results, then narrow the query.
For PaperClip full text, search the relevant source first and read the returned
`virtualPath` or an explicit `cat` command. Do not pass an external URL to the
PaperClip read action; keep that URL only as citation metadata.
Multi-Agent work may parallelize intake and literature search when tasks are
partitioned by source set, theorem family, or audit question. Assign one
coordinator to deduplicate claims, reconcile assumptions, and write canonical
portfolio state. Require source refs and scope; do not launch duplicate broad queries.
Use an independent reviewer at the verification gate when available. Every
handoff includes problem and attempt ids, hashes, commit, paths, evidence refs,
and the requested action.

## Verification and replay SOP

The final verification runs from a clean, fixed boundary. Its replay manifest
must include:

```text
baseCommit, targetCommit, proofPath, theoremName, theoremDeclarationHash,
claim, statementHash, proofHash, toolchain.lock hash,
exact command, cwd, timeout, resource budget,
expected exit code, output hash, network policy
```

Replay in this order:

```text
preflight repository and require a clean committed checkout
-> activate approved commit/branch without moving it
-> verify file and toolchain hashes
-> call lean_workspace(preflight) only if capability is still unknown
-> call lean_workspace(certify) once with every independent theorem item
-> compare each receipt's named theorem, declaration/statement/proof hashes,
   goals, and sorry/admit/axiom counts
-> independently review the theorem declaration against the normalized statement
-> append replay result
-> checkpoint the result
```

For an interactive proof trace, submit only public, reader-checkable
`submit_formula`, `open_goal`, `rewrite_goal`, `branch_goal`, `close_goal`, and
`diagnostic` operations. These are Agent-authority observations, not proof.
Only verifier-generated events may close a node as `Kernel verified`. Use the
returned events, metrics, receipts, and `nextContext`; call `events` only when
the user asks for the trace or projection recovery is necessary. Display exact
counts and elapsed time, never a fabricated percentage or idle animation.

If a clean boundary, command, dependency, or toolchain cannot be established,
the result is `blocked` or `unavailable`, never `kernel_verified`.

## Independent review SOP

The reviewer must:

1. Re-read the informal and formal statements without trusting the proposer.
2. Check assumptions, quantifier order, vacuity, coercions, and definitions.
3. Try to refute using the saved examples and new boundary cases; require either
   a replayable witness checker or a `claim=negation` kernel receipt.
4. Re-run verification from the frozen commit.
5. Check imports, generated files, axioms, stale paths, and replay metadata.
6. Return one verdict: `passed`, `changes_requested`, `refuted`, or
   `inconclusive`.

Record concise findings, evidence ids, commands, and file/line anchors. Do not
record hidden chain-of-thought. If any formal input changes, mark the review
stale and return to formalization.

The reviewer must also reconcile the evidence balance: confirm that supporting
and refuting records refer to the same normalized statement, distinguish “not
found” from “false”, and ensure the terminal disposition names the decisive
lane. A review that checks only the proof file but not the counterexample search
is incomplete.

## Failure codes and recovery

Use these codes consistently:

```text
SEMANTIC_AMBIGUITY, ALIGNMENT_MISMATCH, COUNTEREXAMPLE_FOUND,
SEARCH_EXHAUSTED, COMPILE_ERROR, TOOLCHAIN_UNAVAILABLE, TIMEOUT,
RESOURCE_LIMIT, STALE_COMMIT, STALE_ASSUMPTION, REVIEW_STALE,
GIT_DIRTY, CHECKPOINT_CONFLICT, REVIEW_CHANGES_REQUESTED
```

Recovery is always:

```text
read last canonical checkpoint
-> validate portfolio/event/replay references
-> reuse results whose hashes still match
-> create a new attempt with parentAttemptId and retry reason
-> run one new strategy or one environment repair
-> record evidence/result
-> checkpoint
```

Do not repeat identical input, strategy, commit, and budget. Do not repair a
stale result in place. A changed statement, assumption, import, or toolchain
invalidates downstream attempts, verification, and review.

## Report assembly and publication gate

Read [references/reporting-and-figures.md](references/reporting-and-figures.md)
before drafting a final report, a contest solution, or a mathematical paper.
It defines the report matrix, task-specific visuals, figure QA, manifest, and
publication sequence.

The final result is a structured Science Report, not a chat recap. It must lead
with the exact disposition and scope, then link every reader-checkable step to
Science Evidence ids. Show both evidence lanes, verification/review boundaries,
limitations, and one reproducible next action. Use `artifact_embed` with
evidence ids for every decision-bearing visual.

Use at least one evidence-bearing visual when a diagram, plot, or table makes a
material relationship easier to inspect. Never create decorative mathematics
or imply that a figure is a proof. A pure proof with no useful visual must use
an evidence matrix or proof-step table and record why a figure was omitted.
For a standard data chart, use `report_chart(action="render")` and register its
returned artifact draft. Use the bespoke figure workflow only for a proof
diagram, geometry construction, custom multi-panel composition, or manuscript
deliverable that the native chart contract cannot express.

Do not publish a terminal `Verified` or `Refuted` report until the manifest,
applicable figure QA or documented no-visual decision, portfolio,
claim/evidence graph, required formal receipt, review, and checkpoint agree on
the same statement hash and commit. A missing gate may be published only as an
explicit provisional or partial report. Keep logs collapsed, and never show
`Verified` for `candidate`, `compiled`, `not_refuted_within_scope`, or
`unavailable`.

## Budgets and renewable epochs

Bound each stage by a declared time, attempt, search-region, or verifier limit.
Choose that bound from expected information gain and tool cost; do not impose a
small global deadline on an explicitly multi-hour investigation. At every
boundary, checkpoint the evidence delta and reflection, then continue only with
a changed premise set, search lane, counterexample region, proof strategy, or
verification condition. Never implement identical endless retries.

## Final status contract

Use exactly one final disposition:

- **Verified**: formal statement, supporting proof, exact hashes, replay, and
  passed review are present.
- **Refuted**: a minimal reproducible counterexample for the exact statement or
  a matching formal-negation kernel receipt is present.
- **Candidate**: a scoped supporting result or incomplete proof exists.
- **Inconclusive**: evidence is mixed, bounded, unavailable, or review disagrees.

Never call an informal argument proved without matching verifier and evidence gates.
