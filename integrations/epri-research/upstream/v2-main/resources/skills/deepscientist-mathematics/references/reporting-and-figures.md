# Mathematical Reporting and Figure SOP

Use this reference when the work will become a final Science Report, contest
solution, expository mathematical paper, or research manuscript. The core
mathematics skill governs truth status. This reference governs how checked
results become a readable, auditable artifact.

## 1. Delivery principle

The report is a map from the question to a bounded conclusion. A reader who did
not watch the run must be able to answer:

1. What exactly was claimed?
2. What assumptions and interpretation were selected?
3. Which steps establish the conclusion, and what evidence supports each step?
4. What was tried on the refuting lane?
5. What did the formal verifier and independent reviewer actually check?
6. Which files, commands, data, and revisions reproduce the result?
7. What remains uncertain or out of scope?

Do not expose hidden reasoning. Publish concise mathematical steps,
justifications, evidence ids, artifacts, commands, hashes, and review findings.

## 2. Freeze the delivery contract

Before drafting prose, record in `reports/<problem-id>.manifest.json`:

```text
problemId, statementHash, title, audience, reportClass,
disposition, decisiveLane, sourceCommit, toolchainLockHash,
claimIds, evidenceIds, verificationIds, reviewIds,
figureIds, tableIds, reportArtifactId, createdAt, updatedAt
```

Choose one `reportClass`:

- `proof`: theorem, construction, classification, or formal disproof;
- `modeling`: applied mathematics, simulation, optimization, or data model;
- `contest`: MCM/ICM-style time-bounded solution;
- `exposition`: reader-oriented synthesis of established mathematics;
- `discovery`: candidate result whose terminal status is not yet available.

Also name the intended audience. Define unfamiliar notation before use and
state the main result before its proof. Do not let a formalism aimed at a proof
assistant replace the mathematical explanation needed by a human reader.

## 3. Build the claim-evidence-step matrix

Create this matrix before full prose and keep it in the report or as a linked
table artifact:

| Step | Reader-checkable claim                                  | Justification                             | Evidence ids | Artifact or source  | Scope/status          |
| ---- | ------------------------------------------------------- | ----------------------------------------- | ------------ | ------------------- | --------------------- |
| S0   | Exact statement and interpretation                      | Definition/alignment audit                | ...          | problem/formal file | equivalent/limited    |
| S1.. | Lemma, model choice, transformation, or measured result | Proof, calculation, source, or experiment | ...          | proof/data/output   | supported/partial     |
| SF   | Final disposition under named assumptions               | Decisive lane plus gates                  | ...          | receipt/review      | verified/refuted/etc. |

Rules:

- One row expresses one externally checkable claim, not a paragraph topic.
- Every answer-bearing row has an evidence id or is marked `missing`.
- Literature supports attribution or a premise; it does not replace a proof of
  the current statement.
- A numerical row includes units, denominator/sample size, comparator, and
  uncertainty when available.
- A proof row cites the lemma, equation, witness, or formal receipt that makes
  the inference valid.
- If an implication depends on an unproved assumption, show that dependency in
  the row instead of smoothing it over in prose.

## 4. Reader-first report structure

Assemble the structured Science Report in this order. Small tasks may merge
adjacent sections, but may not omit their information.

1. **Result and scope**: start with one `result_summary` or short paragraph
   giving `Verified`, `Refuted`, `Candidate`, or `Inconclusive`, the exact scope,
   and the decisive reason. Do not use a numeric primary metric for a pure
   theorem unless a real decision-bearing quantity was measured.
2. **Problem and interpretation**: state the original question, definitions,
   assumptions, audience, and any ambiguity resolved by the user or Agent.
3. **Formal statement and alignment**: show the normalized statement,
   `statementHash`, and `equivalent`, `stronger`, `weaker`, or `unknown` relation
   to the informal claim.
4. **Roadmap**: give a short dependency map of the proof, model, or refutation.
   This is the reader's navigation, not a chronology of tool calls.
5. **Step-by-step argument**: present the claim-evidence-step matrix followed by
   enough derivation to check every non-obvious transition. Put evidence ids on
   paragraphs, list items, and checklists rather than writing literal `[E1]`.
6. **Evidence balance**: show the supporting and refuting lanes, their searched
   scope, reproducibility, decisive or bounded result, and missing gates.
7. **Visual results**: interpret each decision-bearing figure or table in text,
   then place its `artifact_embed` immediately after that interpretation.
8. **Verification and reproducibility**: identify commit, statement/proof hashes,
   theorem or witness, toolchain, exact replay entry point, output artifact, and
   trust boundary.
9. **Independent review**: give the frozen revision, verdict, material findings,
   resolved issues, and any stale or disputed condition.
10. **Limitations and next action**: distinguish mathematical scope limits,
    evidence limits, computational bounds, and presentation limits. End with
    one reproducible next action, not a generic promise.
11. **Sources and provenance**: list literature, data, reused/adapted visual
    credits, software/tool versions, and AI-use disclosure when a venue or
    contest requires it.

Prefer `paragraph`, `bullet_list`, `checklist`, `result_summary`, and
`artifact_embed`. Use `figure_ref`, `table_ref`, `artifact_ref`, or `code_ref`
for secondary material. A file appearing in the artifact inventory does not
need a redundant report block.

## 5. Select visuals by mathematical function

Every visual must answer a reader question or expose a verification boundary.
Choose the smallest useful set.

### Proof, geometry, combinatorics, and number theory

Good candidates include:

- a proof-dependency graph connecting definitions, lemmas, and the theorem;
- a geometric construction with assumptions and key equalities labeled;
- a sequence of diagrams showing a transformation or invariant;
- a finite-case map or search-coverage table;
- a minimal counterexample and the exact condition it violates;
- an informal-to-formal statement alignment table;
- a Lean blueprint/declaration dependency view with checked and open nodes.

A diagram may clarify an argument but does not prove it. The text must still
state the inference and link the proof or verifier receipt.

### Applied mathematics and modeling

Usually include two or more of the following when the data exist:

- raw observations or input-domain coverage with units and missingness;
- model schematic with assumptions, inputs, state variables, and outputs;
- main fit/prediction or policy comparison with uncertainty;
- residual, calibration, or error diagnostic;
- sensitivity, robustness, or uncertainty analysis;
- validation against held-out data, a baseline, or a limiting case;
- scenario trade-off or Pareto frontier with infeasible regions marked.

Do not show a fitted curve without the observations and scope that support it.
Do not show a scenario forecast without assumptions and uncertainty.

### MCM/ICM-style contest report

The first page is a stand-alone summary of the problem, model, key assumptions,
main quantitative conclusions, validation/sensitivity findings, strengths, and
limitations. The body should make the thought process inspectable through:

- a model/decision pipeline;
- a concise assumptions table with justification and impact;
- the main decision-bearing result figure or table;
- at least one model test, sensitivity, uncertainty, or error display;
- implementation-ready recommendations and their applicable range.

Follow the active contest rules and page limit. Keep any required AI-use report
or venue declaration separate where the rules say it is outside the solution.

### Expository or broad-impact mathematics

Use one motivating example before abstraction, state the main theorem early,
and give a proof roadmap before long technical detail. A visual should reveal a
structure, obstruction, analogy, or application. It must not oversell novelty.

There is no official "Fields Medal writing skill". The IMU describes the medal
in terms of outstanding existing achievement and promise of future achievement,
not a paper template. After correctness and reproducibility pass, an optional
broad-impact audit may ask about originality, conceptual depth, reach across
areas, and credible future directions. Never label work "Fields-level" or use
this audit as evidence of correctness.

## 6. Figure production contract

Choose one production route before creating files:

- **Native report chart**: for a standard bar, line, interval/forest, scatter,
  or matrix display backed by verified structured data, read
  `deepscientist-report-chart` and call `report_chart(action="render")` once.
  Use `style.palette="mono"` by default for mathematics. Register the returned
  artifact draft and keep its `.chart.json`, script-free SVG, hashes, and
  evidence ids together. Do not recreate the same data with Python, HTML, or a
  second chart library.
- **Bespoke mathematical figure**: use the directory contract below for proof
  diagrams, geometry, custom multi-panel composition, TikZ, or a manuscript
  deliverable not representable by the native chart schema.

Store each durable visual under `figures/<figure-id>/`:

```text
spec.json       question, claimIds, evidenceIds, intended comparison, format
data/           immutable inputs or a manifest of their hashes and locations
source/         plotting script, notebook, TikZ, or diagram source
figure.svg      preferred scalable preview when supported
figure.pdf      publication form for vector mathematics or line art
figure.png      raster fallback when needed
caption.md      self-contained caption, scope, units, and takeaway
qa.json         render checks, reviewer, revision, and pass/fail findings
```

The specification must state:

- the reader question and answer-bearing claim;
- the exact data/evidence and statement hash;
- axes, units, sample/domain, comparator, uncertainty, and encoding;
- expected pattern and what result would contradict it;
- output sizes/formats and accessibility requirements;
- whether the visual is evidentiary, explanatory, or diagnostic.

Generate bespoke plots from saved data with a saved script and deterministic settings.
Prefer vector output for line art, diagrams, and mathematical labels; retain a
readable raster fallback for Preview. Credit reused or adapted content and do
not fabricate a visual from unsourced values.

## 7. Render-inspect-revise QA

Do not approve a figure by inspecting source code alone. Render the final file,
open it at report scale, and record these checks in `qa.json`:

- file is nonblank, uncropped, and uses the intended data revision;
- title/caption, axes, units, legend, sample/domain, and uncertainty agree with
  the report and source data;
- labels and mathematical notation remain readable at embedded size;
- colors remain distinguishable in grayscale or by color-vision-deficient
  readers, using shape/line style as a redundant channel where needed;
- no overlap, clipping, hidden series, misleading axis range, or unsupported
  interpolation is present;
- caption says what is shown, under which assumptions, and why it matters;
- every plotted number can be traced to an evidence id or source artifact;
- the surrounding prose interprets the dominant pattern instead of repeating
  every visual label.

Revise and rerender once for each material failure. If the figure cannot be
made honest and readable, omit it and use a table or explicit limitation.

## 8. Publication sequence

Use this order so the report never gets ahead of its evidence:

```text
freeze statement and source revision
-> complete both evidence lanes
-> write/update canonical result, manifest, figure sources, and QA
-> checkpoint meaningful source changes
-> math_portfolio(action=get), then submit the complete validated portfolio
-> register/update Science Evidence and 1-3 stable answer-bearing Claims
-> create/update figure, table, code, and report artifacts
-> assemble report blocks with evidenceIds and artifact_embed references
-> verify disposition, hashes, references, applicable figure QA, and review
-> science_artifact publish with the report as the default target
-> inspect the returned verification summary and repair one graph gap at most
-> if all gates pass, present the terminal report; otherwise preserve partial
```

The conversation response is only a short handoff to the published report. It
must name unresolved gates, but it must not substitute for publishing.

## 9. Pre-publication gate

All answers must be `yes` before a terminal report is published:

- Does the displayed disposition equal the portfolio disposition?
- Is the informal/formal alignment explicit and bound to one statement hash?
- Does every answer-bearing report step resolve to evidence or show `missing`?
- Are both supporting and refuting lanes visible with bounded scope?
- Does every decision-bearing visual resolve to source/data, caption, QA, and
  evidence ids?
- Do all receipts required or cited by the disposition target the same clean
  committed revision, with unavailable checks shown as limitations?
- Are limitations specific enough to prevent broader interpretation?
- Can another Agent find the replay entry point and reproduce the decisive
  output without relying on chat history?
- Does the structured report render in reading order with no dangling block,
  artifact, claim, or evidence reference?

If any answer is `no`, publish only a clearly marked provisional/partial report
when useful, or remain blocked. Never hide the failed item by removing it from
the checklist.

## 10. Source basis and adopted open-source patterns

These sources inform this SOP; they are guidance, not mathematical evidence for
a task result:

- COMAP MCM/ICM instructions emphasize the team's thought process, analysis,
  modeling approach, mathematical methods, a first-page summary, and a single
  report containing text, figures, charts, and support:
  <https://contest.comap.com/undergraduate/contests/mcm/instructions.php>
- COMAP's submission walkthrough calls the first-page summary essential and
  notes its weight in judging:
  <https://contest.comap.com/undergraduate/contests/mcm/contests/2026/problems/MCM-ICM_SubProcess.pdf>
- The AMS author manual recommends an accessible opening, early statement of
  the main result, theorem-before-proof ordering, and a roadmap for long proofs:
  <https://www.ams.org/journals/bull/1962-68-05/S0002-9904-1962-10764-2/S0002-9904-1962-10764-2.pdf>
- SIAM's author guidance requires figures and tables to be called out and
  explained, captions to be descriptive, and reused material to be credited:
  <https://epubs.siam.org/author-handbook>
- SIAM's life-sciences guidance gives a useful cross-domain reproducibility
  standard: provide parameters and initial conditions and make relevant data,
  software, and recreation scripts accessible when feasible:
  <https://epubs.siam.org/journal/sials/instructions-for-authors>
- The MAA referee guide treats accuracy, originality, readability for a
  mathematician new to the subject, and structured independent review as
  separate questions:
  <https://maa.org/guide-for-referees/>
- The IMU Fields Medal page is used only for the optional broad-impact audit:
  <https://www.mathunion.org/imu-awards/fields-medal>
- LeanProject provides an open-source blueprint-driven separation between
  human-facing mathematical plans, Lean declarations, toolchain, and CI:
  <https://github.com/leanprover-community/LeanProject>
- SNL-UCSB's open-source paper-writing skill contributes useful workflow ideas:
  plan claims and figures before prose, generate from a specification, critique
  claim alignment, and red-team before delivery. Its venue-specific systems
  advice is not imported into this mathematics SOP:
  <https://github.com/SNL-UCSB/paper-writing-skill>

Recheck live venue or contest rules at submission time. Do not install or
execute third-party skill code merely because it appears in this source list.
