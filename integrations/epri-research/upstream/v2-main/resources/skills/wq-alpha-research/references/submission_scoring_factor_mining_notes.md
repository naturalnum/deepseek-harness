# WQ BRAIN Submit, Scoring, and Factor-Mining Notes

Updated: 2026-06-26.

Use this reference when a user asks whether a submitted alpha counts as a factor,
how BRAIN points are likely calculated, how long scoring takes after submission,
or how to mine factors from a dataset.

## 17 Operational Lessons

1. A successful submit is not the same as proving a factor.
   Treat it as a platform-qualified alpha candidate. It becomes closer to a
   real factor only after robustness, low correlation, and economic rationale
   checks.

2. `POST /alphas/{id}/submit` success is not enough.
   Re-fetch the alpha and confirm `status == ACTIVE`. A 200/201 response can
   still leave the alpha `UNSUBMITTED` while self-correlation or other checks
   remain pending.

3. Distinguish three layers: expression, alpha, factor.
   An expression is the formula. An alpha is the simulated/submitted model. A
   factor is a repeatable return driver with explanation, persistence, and
   incremental portfolio value.

4. BRAIN submission checks are only platform gates.
   Passing Sharpe, Fitness, turnover, weight, sub-universe, and self-correlation
   checks says the alpha meets BRAIN criteria. It does not prove causality or
   future live performance.

5. Fitness is a quality metric, not the platform points balance.
   Common BRAIN documentation describes Fitness as approximately:
   `Sharpe * sqrt(abs(Returns) / max(Turnover, 0.125))`. It is one input into
   alpha quality, not the same as daily challenge points.

6. Points are relative and daily, not a fixed reward per alpha.
   Public and community-facing descriptions suggest points depend on quantity,
   quality, and relative performance versus other participants on that day.
   Exact formulas can change and should be treated as non-public.

7. Quantity helps only when quality and diversity survive.
   Submitting many near-duplicates is weaker than submitting fewer alphas with
   strong Fitness, acceptable turnover, low drawdown, and low self-correlation.

8. Quality is multi-dimensional.
   Track Sharpe, Fitness, Returns, Turnover, Drawdown, Margin, sub-universe
   Sharpe, weight concentration, and self-correlation together. A single strong
   headline number can hide a fragile alpha.

9. Self-correlation is a portfolio constraint, not a nuisance.
   If a new alpha is highly correlated with an existing ACTIVE alpha, it adds
   little new information. Use daily PnL changes for local correlation checks,
   not cumulative PnL curves.

10. Delay and universe affect scoring and credibility.
    Delay-1 is usually more conservative than delay-0. Smaller or harder
    universes can receive different treatment, but should not be used to hide
    fragility.

11. Scoring usually requires a daily refresh.
    For ordinary challenge-style points, expect the score to update at the next
    platform daily calculation rather than immediately after submit. Around
    competition phase changes or leaderboard freeze periods, allow extra time.

12. Start factor mining from a hypothesis, not random formulas.
    Examples: profitability persistence, valuation re-rating, earnings
    revision drift, short-term reversal, liquidity pressure, sentiment
    underreaction, buyback/shareholder yield, accounting quality, or event
    uncertainty.

13. Understand the dataset before building expressions.
    Check field meaning, category, coverage, update lag, units, matrix vs vector
    type, missingness, and whether the data is plausibly point-in-time. A good
    formula cannot rescue a misunderstood field.

14. Validate fields with simple probes first.
    Simulate `rank(field)` or a minimal normalized variant before building a
    complex expression. This catches unavailable fields, sparse coverage, unit
    issues, and unexpected sign behavior early.

15. Convert raw data into comparable signals.
    Prefer ratios, ranks, group ranks, time-series ranks, z-scores, deltas, and
    rolling averages over raw levels. Combine cross-sectional and time-series
    normalization deliberately.

16. Use ablations to separate signal from parameter luck.
    Change one axis at a time: window, sign, decay, neutralization, group,
    truncation, NaN handling, or mix weight. Keep notes on failures, not only
    submissions, because failures define the search boundary.

17. Promote only reusable mechanisms into the skill.
    After an alpha becomes ACTIVE, record the mechanism, settings, metrics,
    correlation profile, and failure modes. Do not promote a template merely
    because one expression submitted successfully.

## Practical Dataset-to-Factor Workflow

1. Select a dataset family and write a one-sentence economic hypothesis.
2. Search local field metadata for high-coverage, interpretable fields.
3. Probe each field with `rank(field)` or `group_rank(rank(field), group)`.
4. Build one simple expression per hypothesis.
5. Simulate with conservative defaults: `USA`, `TOP3000`, `delay=1`,
   `pasteurization=ON`, `unitHandling=VERIFY`, and suitable neutralization.
6. Diagnose failures with the IS checks.
7. Run ablations across window, sign, group, decay, and truncation.
8. Pre-check correlation against ACTIVE alphas using daily PnL changes.
9. Submit only when metrics, checks, and correlation are all acceptable.
10. Re-fetch after submit until `ACTIVE`, `FAIL`, or a clear pending state.
11. Record the result in `references/auto_submit_memory.md` or the relevant
    candidate-run JSON.

## Scoring and Timing Notes

- Do not promise an exact point formula. Treat it as platform-controlled.
- Explain Fitness separately from points.
- Tell users to wait for the next daily scoring refresh after a successful
  ACTIVE submission.
- If leaderboard or competition-phase timing matters, rely on the current
  official BRAIN/IQC page and the user's platform dashboard.
- If an alpha remains `UNSUBMITTED`, pending, or self-correlation failed, do not
  expect it to contribute points.

## Recommended Answer Framing

When a user asks "submit 了是不是挖到因子了", answer:

> 成功 submit 说明这是一个通过平台门槛的 alpha 候选；还不能直接等同于
> 已经证明一个因子。要看 ACTIVE 状态、样本外稳定性、低相关、机制解释和
> 是否能给已有组合带来增量。

When a user asks "积分怎么算", answer:

> Fitness 是 alpha 质量指标，不是积分本身。积分更像每日相对结算，受提交
> 数量、alpha 质量、相关性/多样性、universe、delay、以及当天其他参与者
> 表现影响；精确公式通常不公开。

When a user asks "多久算分", answer:

> 通常不是提交瞬间算分，而是等下一次平台日刷新；比赛阶段切换、冻结或审核
> 期间可能更久。先确认 alpha 已经 `ACTIVE`，否则通常不会贡献分数。
