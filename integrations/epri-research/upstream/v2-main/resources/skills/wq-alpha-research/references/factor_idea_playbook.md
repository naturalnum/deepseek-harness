# Factor Idea Playbook for WorldQuant BRAIN

This playbook converts common quant factor knowledge into WQ BRAIN-friendly
idea families. Treat every expression as a starting point for simulation, not
as a guaranteed alpha.

## General Expression Principles

- Use ratios when the denominator has economic meaning: `operating_income / equity`.
- Use cross-sectional normalization before combining unlike signals: `rank(a) + rank(b)`.
- Prefer `group_rank(..., subindustry)` for slow fundamental signals.
- Prefer higher `decay` for fast price/volume signals.
- Keep expression depth modest; if the idea cannot be explained in one sentence, it is probably hard to debug.
- For new fields, test `rank(field)` first, then add time-series and group structure.

## Factor Families

### 1. Profitability / Quality

Academic anchor: Fama-French profitability and AQR quality. Quality commonly
combines profitability, growth, safety, and payout; BRAIN fields determine which
subcomponent is available.

Hypotheses:

- More profitable firms outperform less profitable firms within comparable industries.
- Improving profitability is better than stale high profitability.
- Profitability mixed with balance-sheet safety may diversify pure earnings signals.

WQ starting patterns:

```fastexpr
group_rank(ts_rank(operating_income / equity, 126), subindustry)
group_rank(ts_rank(operating_income / assets, 126), subindustry)
group_rank(ts_rank(operating_income / sales, 126), subindustry)
```

Mutation axes:

- denominator: `equity`, `assets`, `sales`
- window: 63, 126, 252
- group: `industry`, `subindustry`
- transform: `ts_rank`, `ts_delta`, `ts_zscore`

Risks:

- Sparse or lagged fundamental fields.
- Too similar to existing profitability alphas.

### 2. Value / Yield

Academic anchor: Fama-French value and value-momentum research.

Hypotheses:

- Cheap firms relative to fundamentals can outperform expensive firms.
- Value works better when combined with quality or momentum filters.

WQ starting patterns:

```fastexpr
group_rank(ts_rank(book_value / market_cap, 126), industry)
group_rank(ts_rank(free_cash_flow_reported_value / enterprise_value, 126), industry)
group_rank(ts_rank(operating_income / enterprise_value, 126), industry)
```

Field notes:

- Validate exact field names first. In the current USA TOP3000 delay=1 snapshot,
  `enterprise_value` exists, while `market_cap` may need `cap` or another
  mapped field depending on BRAIN syntax.

Risks:

- Value signals can be slow and crowded.
- Pure value may correlate with distressed balance-sheet exposure.

### 3. Analyst Revisions / Expectations

Hypotheses:

- Upward revisions in analyst expectations predict near-to-medium-term returns.
- Analyst fields often need modest decay and industry/subindustry control.

WQ starting patterns:

```fastexpr
group_rank(ts_rank(est_eps / close, 126), industry)
group_rank(ts_delta(est_eps, 63), industry)
group_rank(ts_rank(est_eps / close, 252), subindustry)
```

Mutation axes:

- estimate field: EPS, revenue, EBITDA, FCF, net debt
- transform: level/yield, delta, rank of delta
- decay: 0, 2, 4, 8

Risks:

- Turnover can rise when revisions cluster.
- Different analyst fields can still be highly correlated.

### 4. Investment / Asset Growth

Academic anchor: Fama-French investment factor.

Hypothesis:

- Firms with aggressive asset growth or investment may underperform, especially
  when profitability is weak.

WQ starting patterns:

```fastexpr
-1 * group_rank(ts_delta(assets, 252) / assets, industry)
0.5 * group_rank(ts_rank(operating_income / equity, 126), subindustry)
- 0.5 * group_rank(ts_rank(ts_delta(assets, 252) / assets, 126), subindustry)
```

Risks:

- Field names for assets and related items vary; validate before use.
- Signals can become size or sector proxies without neutralization.

### 5. Short-Term Reversal / Price Dislocation

Academic/practitioner anchor: formulaic alpha literature and QuantGPT examples.

Hypotheses:

- Short-term overreaction mean-reverts.
- VWAP or open-close dislocation captures temporary pressure.

WQ starting patterns:

```fastexpr
rank(-(close / open - 1))
-1 * rank(ts_decay_linear(close / vwap, 10))
-1 * rank(ts_decay_linear(returns, 5))
```

Recommended settings:

- decay: 12-30
- neutralization: `MARKET` or `INDUSTRY`
- truncation: 0.05-0.08

Risks:

- High turnover.
- High correlation with other technical reversal alphas.
- Good IS can decay in OS if it is only microstructure noise.

### 6. Returns-Volume Interaction

Hypothesis:

- Large returns on unusual volume may indicate crowding or temporary liquidity
  pressure; the direction may need empirical sign testing.

WQ starting patterns:

```fastexpr
-1 * rank(ts_decay_linear(returns * volume / adv20, 5))
rank(ts_corr(rank(close), rank(volume), 10))
rank(ts_rank(volume / adv20, 20) * ts_rank(-returns, 5))
```

Recommended settings:

- decay: 12-30
- neutralization: `MARKET` or `INDUSTRY`

Risks:

- Turnover-heavy.
- Volume effects can be regime dependent.

### 7. Debt / Safety / Leverage

Academic anchor: quality/safety component of QMJ.

Hypotheses:

- Lower leverage or better balance-sheet safety can earn a quality premium.
- Debt/value mixed with price action can diversify pure technical alphas.

WQ starting patterns:

```fastexpr
-1 * group_rank(ts_rank(debt_st / assets, 126), industry)
rank(-ts_delta(close, 10)) + rank(debt_st / enterprise_value)
```

Recommended first action:

- Validate debt fields and coverage: `debt_st`, net-debt analyst fields,
  liabilities fields.

Risks:

- Sparse coverage and concentrated weights.
- Debt can be sector-specific; group neutralization is usually necessary.

### 8. Event / News / Sentiment

Hypotheses:

- Earnings/news events produce delayed reactions or reversals.
- Sentiment and buzz fields need NaN handling and robust smoothing.

WQ starting patterns:

```fastexpr
trade_when(volume > ts_mean(volume, 20), rank(-returns), 5)
group_rank(ts_rank(news_or_sentiment_field, 20), industry)
```

Risks:

- Field coverage and event timing.
- High turnover around events.
- Many event fields are sparse; use `nanHandling=ON`.

### 9. Option-Implied Signals

Hypotheses:

- Option-implied volatility, skew, or put/call activity may proxy for informed
  demand or risk compensation.

WQ starting pattern:

```fastexpr
group_rank(ts_rank(option_field, 20), industry)
```

Recommended first action:

- Search category `option` in the field snapshot.
- Validate `rank(field)`.
- Compare MARKET vs INDUSTRY neutralization.

Risks:

- Coverage may be lower for smaller names.
- Signals can overlap with volatility/risk factors.

## Batch Design Templates

### Controlled Field Sweep

Use one expression skeleton and swap fields only:

```fastexpr
group_rank(ts_rank(FIELD / assets, 126), subindustry)
```

Use when searching fundamental fields.

### Window Sweep

Use one field and transform, then test:

```text
N = 63, 126, 252
```

Do not change neutralization and decay in the same sweep.

### Neutralization Sweep

Use the same expression and settings except:

```text
MARKET, INDUSTRY, SUBINDUSTRY
```

Use when deciding whether performance is sector exposure.

### Decay Sweep

Use mostly for technical or analyst signals:

```text
decay = 0, 4, 8, 12, 20, 30
```

Stop increasing decay when turnover improves but Sharpe/Fitness decays.

## Submission SOP

1. Validate fields.
2. Simulate small batch.
3. Filter by IS metrics.
4. Check failed tests.
5. Check daily-return correlation to ACTIVE alphas.
6. Submit.
7. Confirm `status == ACTIVE`.
8. Run `evolve_skill.py` dry-run.
9. Apply only if the generated records are private/local or sanitized.

## Candidate Kill Rules

Kill or postpone a candidate if:

- it only passes after relaxing turnover beyond 25%
- it fails sub-universe Sharpe repeatedly
- it differs from an ACTIVE alpha only by a small window or weight change
- it needs an unverified sparse field plus a complex expression
- it has no clear economic sign and only worked after sign/window fishing

## Source Anchors

- Fama-French: size, value, profitability, investment.
- AQR QMJ: profitability, growth, safety, payout.
- Value and Momentum Everywhere: value and momentum are useful but not the same family.
- 101 Formulaic Alphas: formulaic alphas are often short-horizon and diverse; use as structure inspiration, not direct copy.
- Alphalens: evaluate factor returns, information, turnover, and group effects separately.
- Numerai: neutralize common exposure to reveal residual signal.
