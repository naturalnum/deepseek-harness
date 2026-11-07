# QuantGPT Strategy Notes for WQ Alpha Research

This note distills portable ideas from `Miasyster/QuantGPT` into the narrower
WorldQuant BRAIN workflow used by this skill. Treat these ideas as an
exploration branch, not as replacements for the current fundamental and analyst
baselines that have already produced ACTIVE alphas.

## What to Reuse

- Research loop discipline: generate a small batch, change one dimension at a
  time, record failed directions, and only promote rules after repeated evidence.
- Candidate families: VWAP reversion, returns-volume interaction, and
  debt/value mixed with price action.
- Mutation discipline: prefer targeted changes such as window, operator,
  neutralization, or decay; avoid changing all of them at once.
- Robustness mindset: favor simple expressions, low correlation to existing
  ACTIVE alphas, and stable performance over a single high-return backtest.

## What Not to Reuse Directly

- QuantGPT is a larger local/cloud research system. Do not copy its local IC,
  anti-overfit, or cloud validation assumptions into BRAIN without data support.
- Some operator names differ across platforms. The logged-in BRAIN operator
  list confirms `ts_av_diff`, `hump`, and `trade_when` are available as base
  operators, but still validate syntax in the target account before submitting.
- Published QuantGPT examples include technical factors with high turnover.
  Keep the current stricter auto-submit gate unless real BRAIN simulations show
  that a candidate can control turnover.

## Candidate Families

### 1. VWAP Reversion

Hypothesis: intraday or recent price dislocation from VWAP may mean-revert after
decay smoothing.

Starting expression:

```fastexpr
-1 * rank(ts_decay_linear(close / vwap, 10))
```

Recommended first settings:

- neutralization: `MARKET` or `INDUSTRY`
- decay: `12` to `24`
- nanHandling: `ON`
- risk: turnover can be high; do not lower the turnover gate for this family.

### 2. Returns-Volume Interaction

Hypothesis: recent returns combined with relative volume captures crowded short
term moves that can reverse after smoothing.

Starting expression:

```fastexpr
-1 * rank(ts_decay_linear(returns * volume / adv20, 5))
```

Recommended first settings:

- neutralization: `MARKET` or `INDUSTRY`
- decay: `12` to `30`
- risk: usually technical and turnover-heavy; require strong Fitness before
  submission.

### 3. Debt/Value Plus Price Action

Hypothesis: valuation or leverage information can diversify a pure price-action
signal and lower correlation to technical-only alphas.

Field mapping notes from the bundled USA TOP3000 delay=1 field snapshot:

- `enterprise_value` exists as a fundamental field.
- Debt-related alternatives include `debt_st` and analyst net-debt fields such
  as `anl4_fs_actuals_advanced_af_nd_netdebt_value`.
- Validate each debt field with `rank(field)` before using it in a compound
  expression.

Brain-style starting expression:

```fastexpr
0.5 * rank(-ts_av_diff(close, 10)) + 0.5 * rank(debt_st / enterprise_value)
```

Recommended first settings:

- neutralization: `INDUSTRY`
- decay: `8` to `16`
- risk: debt field coverage can be sparse; watch concentrated weight and
  sub-universe checks.

## Promotion Rules

Promote a QuantGPT-derived family into `SKILL.md` templates only after at least
one local BRAIN run satisfies all of the following:

- status becomes `ACTIVE`
- Sharpe >= 1.35
- Fitness >= 1.10
- Turnover is between 1% and 25%
- Drawdown <= 15%
- no blocking IS checks fail
- daily-return correlation to existing ACTIVE alphas is below 0.7

Until then, keep QuantGPT-derived candidates in `references/` or generated
candidate files rather than the high-confidence template section.
