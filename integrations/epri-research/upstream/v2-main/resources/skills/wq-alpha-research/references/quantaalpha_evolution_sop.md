# QuantaAlpha Evolution SOP for WQ BRAIN

Source review date: 2026-06-25.

Primary paper:

- arXiv:2602.07085, `QuantaAlpha: An Evolutionary Framework for LLM-Driven Alpha Mining`
- Repository: https://github.com/QuantaAlpha/QuantaAlpha

Related papers used for context:

- AlphaAgent, arXiv:2502.16789
- RD-Agent-Quant, arXiv:2505.15155
- AlphaEval, arXiv:2508.13174
- AlphaSAGE, arXiv:2509.25055
- AlphaPROBE, arXiv:2602.11917

## Executive Takeaway

QuantaAlpha's most useful lesson for this WQ BRAIN skill is not "copy a best
formula." Its main lesson is to treat alpha mining as an evolving research
trajectory:

```text
hypothesis -> expression -> settings -> simulation -> diagnosis -> mutation/crossover -> validated pool
```

For BRAIN work, this means every alpha should carry a small "factor card" with
its hypothesis, expression, settings, metrics, failure mode, and lineage. The
agent should mutate the weak part of a trajectory instead of randomly generating
more formulas.

## What QuantaAlpha Adds

### 1. Diversified Planning Initialization

QuantaAlpha starts from multiple complementary directions instead of one seed.
The paper uses 10 parallel exploration directions in its main setup and groups
initial seeds by low correlation.

BRAIN translation:

- Start each batch from different families: fundamental, analyst, price-volume,
  gap/overnight, volatility/range, sentiment/news, option.
- Do not generate 20 variants of one EPS or open-close reversal idea.
- Each batch should include semantic diversity and structural diversity.

Local rule:

```text
one batch = 5-20 candidates, at least 3 signal families, no more than 3 variants per family
```

### 2. Trajectory-Level Mutation

QuantaAlpha diagnoses which part of a research trajectory caused low reward,
then rewrites that local segment while keeping the rest intact.

BRAIN translation:

| Failure | Mutate this segment | Keep fixed |
|---|---|---|
| LOW_SHARPE | field, sign, core operator | universe, neutralization, decay |
| LOW_FITNESS | decay, turnover control, signal smoothing | core economic hypothesis |
| HIGH_TURNOVER | decay, `hump`, `trade_when`, longer window | field family and sign |
| CONCENTRATED_WEIGHT | rank/winsorize/backfill/truncation | hypothesis |
| SELF_CORRELATION | data family or economic mechanism | quality thresholds |
| simulation syntax error | operator syntax / field mapping | hypothesis |

Operational rule:

```text
Do not change field + window + neutralization + decay in the same mutation.
```

### 3. Trajectory-Level Crossover

QuantaAlpha recombines validated segments from high-reward parents. The useful
idea is not expression averaging; it is hypothesis synthesis.

BRAIN translation:

- Good crossover: `profitability quality` + `technical reversal` when the
  combined alpha lowers turnover or correlation.
- Bad crossover: two near-identical EPS-yield windows averaged together.
- A child should inherit one clear mechanism from each parent and have a new
  one-sentence hypothesis.

Candidate crossover template:

```fastexpr
0.5 * rank(parent_signal_a) + 0.5 * rank(parent_signal_b)
```

Promotion rule:

- Accept a crossover only if it improves at least one of: Fitness, turnover,
  drawdown, or self-correlation.
- Reject if it only increases Sharpe while making drawdown or turnover worse.

### 4. Semantic Consistency Gate

QuantaAlpha checks alignment among hypothesis, symbolic expression, and code.
AlphaAgent independently emphasizes the same idea: hypothesis-factor alignment.

BRAIN translation:

Before simulation, record:

```text
Hypothesis:
Expected sign:
Fields:
Operator logic:
Settings rationale:
Failure risk:
```

Reject any candidate where the expression does not match the hypothesis. Example:
if the hypothesis says "high profitability should be long," the expression should
not accidentally short high `operating_income / equity`.

### 5. Complexity Gate

QuantaAlpha reports that removing complexity control hurts strategy-level
performance. Its setup constrains factor length and free parameters.

BRAIN translation:

Default limits:

- expression length <= 250-300 characters for routine candidates
- max 4-6 nested operator levels for auto-submit candidates
- no more than 2 independent free windows per expression
- no chained conditionals unless the first simpler version has passed

Rationale:

- Complex expressions are harder to debug.
- They can overfit BRAIN IS checks.
- They make self-correlation and semantic drift harder to diagnose.

### 6. Redundancy Gate

QuantaAlpha uses both structural similarity and output-level correlation. This
aligns with BRAIN's SELF_CORRELATION check.

BRAIN translation:

- Structural redundancy: same fields/operators/windows with minor constants.
- Functional redundancy: high daily PnL correlation.

Local rule:

```text
If two candidates use the same field family and differ only by N=63/126/252,
simulate at most one or two; do not submit all.
```

Use `evolve_skill.py` to track ACTIVE alphas and daily-return correlation.

### 7. Cross-Seed / Cross-Market Robustness

QuantaAlpha tests different seed combinations and zero-shot transfer from CSI300
to CSI500 and S&P500. The paper's point is that a real alpha process should not
depend on a lucky starting seed.

BRAIN translation:

- Do not trust one successful run as a universal rule.
- Run nearby variants from different families and neutralizations.
- Prefer candidates that survive sub-universe tests and do not rely on small-cap
  or one-sector effects.

Useful local checks:

- MARKET vs INDUSTRY vs SUBINDUSTRY neutralization sensitivity.
- TOP3000 vs smaller universe if account permissions allow.
- Delay 1 first; delay 0 only when the idea requires it.

### 8. Transaction-Cost / Turnover Awareness

QuantaAlpha explicitly reports transaction-cost sensitivity and uses portfolio
construction that replaces only a fraction of holdings per rebalance.

BRAIN translation:

- Turnover is not an afterthought; it should be a generation-time objective.
- For WQ auto-submit, keep strict turnover gates even if platform allows up to
  70%.
- Add `decay`, `hump`, `trade_when`, or a slower companion signal before
  submission.

### 9. Market Style Diagnostics

QuantaAlpha's appendix argues that alpha decay can be tied to market style
transitions: large-cap/core-asset regimes, small-cap/thematic rotations,
overnight gaps, intraday noise, volatility clustering, liquidity re-rating, and
trend persistence.

BRAIN translation:

Track which information channel each alpha uses:

- slow fundamental quality
- analyst revisions
- open-close / overnight gap
- range and volatility structure
- price-volume coordination
- reversal / exhaustion
- sentiment/news attention
- liquidity / volume absorption

If a whole family starts failing, do not only mutate windows. Consider a regime
change and shift to a different channel.

## QuantaAlpha-Inspired WQ Candidate Families

### A. Institutional Momentum Proxy

Paper case-study idea: price returns and volume changes moving together can
proxy coordinated trading, while intraday return quality provides an additional
confirmation.

WQ-style starting point:

```fastexpr
rank(ts_corr(ts_delta(close, 1) / close, ts_delta(volume, 1) / volume, 20) * ts_mean((close - open) / close, 5))
```

Risks:

- technical and turnover-heavy
- may need decay 12-24
- can correlate with other price-volume alphas

### B. Overnight Gap Structure

Paper appendix highlights gap/auction information and gap acceptance as robust
under noisy regimes.

WQ-style starting point:

```fastexpr
rank(ts_zscore((open / ts_delay(close, 1) - 1) / (ts_mean((high - low) / close, 20) + 0.01), 10))
```

Interpretation:

- overnight gap normalized by recent range
- positive value means large positive opening gap relative to recent range

Mutation:

- reverse sign to test gap reversal
- multiply by intraday acceptance `(close - open) / open`
- weight by `volume / adv20`

### C. Gap Acceptance / Rejection

WQ-style starting point:

```fastexpr
rank((open / ts_delay(close, 1) - 1) * ((close - open) / open))
```

Interpretation:

- if overnight gap and intraday direction agree, the gap is "accepted"
- if they disagree, the gap is rejected

Use:

- MARKET or INDUSTRY neutralization
- decay 8-20

### D. Range Deviation / Volatility Structure

Paper appendix emphasizes range deviation conditioned on volatility clustering.

WQ-style starting point:

```fastexpr
rank(ts_zscore((high - low) / close, 20))
```

or mean-reversion variant:

```fastexpr
-1 * rank(ts_zscore((high - low) / close, 20))
```

Risk:

- range can proxy volatility/risk rather than return prediction
- test both signs and neutralization settings

### E. Clean Trend With Liquidity Confirmation

Paper appendix suggests raw momentum is fragile, but trend continuation can work
when residual volatility is low and liquidity improves.

WQ-style starting point:

```fastexpr
rank(ts_mean(returns, 10) / (ts_std_dev(returns, 20) + 0.01) * ts_rank(volume / adv20, 20))
```

Risk:

- can become a momentum/volume crowded signal
- needs self-correlation checks

### F. Exhaustion / Climax Reversal

Related AlphaAgent-style factors find value in exhaustion and reversal, but the
QuantaAlpha appendix warns bottom-fishing can fail under non-stationary
liquidity.

WQ-style starting point:

```fastexpr
-1 * rank(ts_rank(close / ts_mean(close, 60), 10) * ts_rank(volume / adv20, 10))
```

Risk:

- crowded short-term reversal
- high turnover
- brittle when liquidity regime changes

## Local Implementation Plan

1. Add QuantaAlpha-inspired candidates only to a separate JSON candidate file.
2. Keep default `submit_batch.py` behavior unchanged.
3. Use strict auto-submit gates:
   - Sharpe >= 1.35
   - Fitness >= 1.10
   - Turnover 1%-25%
   - Drawdown <= 15%
   - no blocking IS checks
4. For every submitted candidate, run `evolve_skill.py` and inspect daily-return
   correlation.
5. Promote only ACTIVE and low-correlation families back into `SKILL.md`.

## Related Literature Lessons

### AlphaAgent

AlphaAgent's core lesson is regularized generation:

- originality enforcement through AST similarity
- semantic consistency between hypothesis and factor
- complexity control

BRAIN action: treat originality, semantic alignment, and simplicity as
pre-simulation gates, not as post-hoc explanations.

### RD-Agent-Quant

RD-Agent-Quant decomposes the workflow into research, development, and feedback
stages, and uses scheduling for direction selection.

BRAIN action: split candidate generation from simulation/submission, and use
previous results to choose the next family rather than sweeping blindly.

### AlphaEval

AlphaEval argues that correlation or backtest alone is not enough. It evaluates:

- predictive power
- temporal stability
- robustness to perturbations
- financial logic
- diversity

BRAIN action: keep the same five dimensions in local reports even if BRAIN only
shows IS checks and PnL metrics.

### AlphaSAGE

AlphaSAGE emphasizes structure-aware generation and diversity, using GFlowNets
to avoid collapsing into one "best" mode.

BRAIN action: maintain a portfolio of different alpha families; do not let the
agent converge to one repeated template.

### AlphaPROBE

AlphaPROBE models factor pools as a DAG rather than a bag of formulas, using
retrieval and graph-aware generation.

BRAIN action: store parent-child lineage in candidate records:

```json
{
  "parent": "profitability_baseline",
  "mutation": "add_vwap_reversal",
  "hypothesis": "quality plus temporary price dislocation"
}
```

This makes later reuse and pruning much easier.

## References

- QuantaAlpha paper: https://arxiv.org/abs/2602.07085
- QuantaAlpha repository: https://github.com/QuantaAlpha/QuantaAlpha
- AlphaAgent: https://arxiv.org/abs/2502.16789
- RD-Agent-Quant: https://arxiv.org/abs/2505.15155
- AlphaEval: https://arxiv.org/abs/2508.13174
- AlphaSAGE: https://arxiv.org/abs/2509.25055
- AlphaPROBE: https://arxiv.org/abs/2602.11917
