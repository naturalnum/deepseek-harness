# Vibe-Trading Adapted Factor Methods

This reference brings the reusable factor-research portions of HKUDS/Vibe-Trading into the existing DeepScientist factor workflow. It does not replace the campaign contract, Portfolio schema, or Lead/Worker permissions.

## 1. Factor evaluation contract

Before generating a candidate, freeze:

- market and investable universe;
- point-in-time feature fields and their publication lag;
- label and forward horizon;
- train/validation/held-out split;
- transaction costs and execution assumptions;
- evaluator, budget, and promotion gates.

Factor values and forward returns must have identical date and instrument axes. A return at date `t` must be observed strictly after the factor at `t`; otherwise mark the candidate invalid for look-ahead bias.

Minimum outputs for an evaluated candidate:

- factor and forward-return metadata;
- IC series, IC mean, IC standard deviation, and IR;
- positive-IC proportion and direction;
- quantile/group returns and turnover/cost assumptions;
- missingness, coverage, and failed checks;
- exact implementation path, Git base, parent factor ids, and evolution operation.

IC/IR thresholds are review heuristics, not universal laws. A high IC can signal leakage, and a negative IC can be useful after a documented direction flip. Never promote a candidate from a single threshold without checking alignment, costs, stability, and an independent confirmation.

## 2. Multi-factor combination

For cross-sectional combinations:

1. calculate each factor on the same observation date;
2. winsorize or otherwise document outlier handling;
3. standardize within the declared cross-section;
4. apply equal or explicitly justified IC-based weights;
5. rank and select Top-N only after missing values and eligibility rules are clear;
6. report factor contribution, turnover, overlap, and sensitivity to weights.

Do not mix factor definitions from different markets or periods without a compatibility note. A combined score is a candidate strategy, not proof that every component is independently valid.

## 3. Alpha libraries and external ideas

An external alpha library may supply hypotheses or implementation candidates. It cannot write directly to the canonical Portfolio. For every imported idea, record:

- source/library and version;
- formula or implementation reference;
- license/provenance;
- applicable market and universe;
- changes made for DeepScientist data schemas;
- leakage and duplication checks.

Use the current XAlpha/generic Worker route for exploration and evaluation. Worker Agents may analyze or implement a bounded proposal, but only the Lead may call `factor_submit` to publish the user-facing handoff.

## 4. Diagnostic loop

When a candidate fails:

1. check data availability and axis alignment;
2. check the label horizon and publication lag;
3. check NaNs, zero variance, and insufficient history;
4. check costs, turnover, and execution delay;
5. rerun one bounded repair;
6. compare against the frozen baseline.

Provider quota, rate-limit, or unavailable-data errors should be recorded as data gaps, not “fixed” by changing the factor. Never install packages or fetch an unrelated dataset as an implicit repair.

## 5. User-facing factor workspace

The factor workspace should show the decision path without forcing users to read the execution log:

- a compact top summary: candidate name, stage, data period, universe, and verdict;
- a metric strip for IC, IR, positive-IC proportion, coverage, and maximum drawdown when available;
- one small chart or ranked table for the current result;
- expandable sections for formula, alignment, costs, lineage, and rejected checks;
- a clear next action: `继续验证`, `修复数据`, `查看证据`, `保留候选`, or `停止`.

Keep the latest material update visible and collapse older iterations. Update existing cards by stable candidate id instead of appending duplicate cards after retries. Lazy-load full CSVs and charts, and never stream raw factor rows into the main conversation.

## 6. Stop, resume, and handoff

Pause on an unmet data contract, held-out access violation, evaluator failure, budget limit, user decision, or unrecoverable Team dependency. Resume using the same campaign revision and job id. A restarted conversation must not create a second canonical search.

Every Worker handoff must include `campaignRevision`, `assignmentId`, inputs used, outputs, evidence refs, failed assumptions, next recommended phase, and exact Git base. Missing fields make the handoff `partial`, not silently accepted.

## Attribution

Adapted from the upstream `factor-research`, `multi-factor`, `alpha-zoo`, and `backtest-diagnose` Skills in HKUDS/Vibe-Trading. DeepScientist's `factor_submit`, Team, Git worktree, and report contracts remain authoritative for new tasks; old search/registry artifacts are read-only compatibility inputs.
