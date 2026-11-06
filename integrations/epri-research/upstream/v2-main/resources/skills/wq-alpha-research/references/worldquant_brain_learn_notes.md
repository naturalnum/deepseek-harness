# WorldQuant BRAIN Learn Notes

Source review date: 2026-06-25.

These notes summarize information observed from the logged-in WorldQuant BRAIN
Learn channel. They are rewritten as operational guidance for this local skill;
they are not a verbatim copy of course content.

## Learn Structure

The Learn landing page organizes material into:

- Courses: Quantcepts, Introduction to Quantitative Finance, Alpha examples by
  data category, Alpha examples by idea type and delay, Combining Alphas and
  Risk Management, Implementing Advanced Ideas on BRAIN, Introduction to
  WorldQuant BRAIN, IQC 2026, Introduction to Alphas, Basic Operators.
- Documentation: Discover BRAIN, Create Alphas, Examples, Interpret Results,
  Understanding Data.
- Operators: an operator list grouped by arithmetic, logical, time series,
  cross-sectional, vector, transformational, and group operators.

Practical takeaway: the official learning path is not "write random formulas";
it is data understanding -> expression language -> simulation settings ->
result interpretation -> submission tests -> risk/diversification.

## Fast Expression

Fast Expression is BRAIN's concise alpha expression language. A valid expression
is composed of:

- data fields, such as `close`, `returns`, `operating_income`
- operators, such as `rank`, `ts_rank`, `group_rank`
- numeric constants and arithmetic

Operational rules:

- Keep expressions readable. A future mutation should preserve the idea, not
  merely change constants.
- Comments and multi-line logic can be used, but the final expression is what
  the simulator uses as the alpha value.
- Do not hide portfolio construction logic inside the expression when BRAIN
  settings already provide decay, neutralization, truncation, and pasteurization.

## Simulation Settings

### Region and Universe

Public user access commonly includes USA and CHN; other regions may depend on
role/permission. A universe such as `USA: TOP3000` represents the most liquid
names in that region by average daily trading value.

Current skill default:

```text
region = USA
universe = TOP3000
delay = 1
```

### Delay

Delay is the time gap between data availability and assumed trading.

- `delay = 0`: trade using same-day data assumptions.
- `delay = 1`: trade the next day using today's data; more conservative.

BRAIN applies delay through settings; do not manually add delay unless the
hypothesis explicitly needs historical values.

### Decay

Decay linearly combines today's value with prior values. It is a primary
turnover-control knob.

Practical rule:

- fundamental/slow analyst signals: decay 0-4
- technical/reversal signals: decay 12-30
- if turnover improves but Sharpe/Fitness collapses, the decay is too large

### Truncation

Truncation limits maximum single-stock weight. Official guidance highlights
0.05-0.10 as common values to avoid overexposure to individual names.

Current skill default:

```text
truncation = 0.08
```

Use lower truncation if concentrated weight fails.

### Neutralization

Neutralization removes market, industry, or subindustry group means from the
alpha vector.

Practical rule:

- `MARKET`: removes net market exposure.
- `INDUSTRY`: good first check for sector dependence.
- `SUBINDUSTRY`: often strong for fundamental comparisons.

If a factor only works with no neutralization, treat it as a suspicious exposure
candidate rather than a robust stock-selection signal.

### Pasteurization

Pasteurization converts values outside the selected universe into NaN before
cross-sectional/group operations. Keep it `ON` by default so ranks and groups
are calculated on the intended alpha universe.

### NaN Handling

NaN handling can increase coverage but may blur "missing data" with true zero or
neutral signals.

Operational rule:

- Use `nanHandling=ON` for sparse fundamental, analyst, news, sentiment fields.
- For high-confidence field replacement logic, explicit handling can be better:

```fastexpr
if_else(is_nan(ts_zscore(field_a, 252)), ts_zscore(field_b, 252), ts_zscore(field_a, 252))
```

### Unit Handling

Unit handling warns when incompatible dimensions are mixed. A price plus volume
is usually conceptually wrong; a ratio such as `operating_income / equity` is
interpretable.

## Results and Quality Thresholds

The Learn material frames a good alpha as one with:

- steadily increasing PnL
- high annual returns
- high Sharpe / information ratio
- high percentage of profitable days
- good margin, or profit per dollar traded
- low drawdown
- reasonable turnover
- low volatility in the cumulative PnL curve

Useful quality heuristics:

- delay-1 Sharpe should be greater than 1.25 for submission.
- delay-0 Sharpe threshold is higher.
- turnover should be above 1% and below 70% for platform submission, but this
  skill uses a stricter auto-submit cap of 25%.
- drawdown below 10% is better; this skill uses 15% as an upper auto-submit cap.

Fitness rating from the Learn result page:

| Rating | Delay-1 Fitness |
|---|---:|
| Spectacular | > 2.5 |
| Excellent | > 2.0 |
| Good | > 1.5 |
| Average | > 1.0 |
| Needs Improvement | <= 1.0 |

Skill interpretation:

- `Average` can submit, but is not necessarily worth auto-submitting.
- `Good` is the preferred promotion threshold for templates.
- `Excellent` or better should be studied for reusable structure and
  correlation risk.

## Submission Tests

BRAIN submission tests include:

| Test | Learn guidance / operational interpretation |
|---|---|
| Fitness | Delay-1 must be > 1.0; delay-0 must be > 1.3. |
| Sharpe | Delay-1 must be > 1.25; delay-0 must be > 2.0. |
| Turnover | 1% < turnover < 70%. |
| Weight test | Maximum stock weight must stay below 10% and sufficient names must be assigned weight. |
| Sub-universe test | Sharpe in a smaller sub-universe must exceed a threshold scaled by universe size. |
| Self-correlation | PnL correlation must be < 0.7, unless the new alpha Sharpe is at least 10% higher than correlated existing alphas. |

Important: the Submit Alpha button starts out-of-sample testing only for alphas
meeting performance and correlation cutoffs. Submitted alphas appear in the
Out-of-Sample tab. A `POST /submit` response is not enough; always confirm
`status == ACTIVE`.

Self-correlation note:

- Official material describes PnL correlation. This skill computes daily PnL
  changes before comparing correlations to avoid cumulative-curve distortion.
- A correlated alpha can qualify if its Sharpe is materially better, but for
  portfolio diversity prefer a different data source or economic logic.

## Understanding Data

Official Learn distinguishes:

- Data Field: a named collection with fixed type and business meaning.
- Dataset: a collection of fields from a data source.
- Matrix field: one value per date and instrument; can be used directly.
- Vector field: multiple values per date/instrument; must be converted to a
  matrix with vector operators such as `vec_avg` or `vec_sum`.

Data exploration tips translated to local workflow:

1. Check field coverage with simple expressions before building a factor.
2. Prefer fields with high coverage and clear business meaning.
3. Use Data Explorer filters such as coverage, type, alpha count, and user
   count to find usable but less crowded fields.
4. Search terms should be short and direct; if terminology is unclear, search
   by plain English idea first, then refine to financial terms.

Local approximation using bundled fields:

```bash
python - <<'PY'
import json
from pathlib import Path
fields = json.loads(Path("references/wq_usa_top3000_delay1_data_fields.json").read_text())
for f in fields:
    if "debt" in f["id"].lower() or "debt" in (f.get("description") or "").lower():
        print(f["id"], f.get("coverage"), f.get("alphaCount"))
PY
```

## Beginner Alpha Examples Observed

The Learn examples page presents beginner alphas with hypothesis,
implementation, hints, expression, and settings. Useful extracted patterns:

### Operating Earnings Yield

Hypothesis: firms whose operating income is currently high relative to their own
history may outperform.

Observed expression pattern:

```fastexpr
ts_rank(operating_income, 252)
```

Skill upgrade:

```fastexpr
group_rank(ts_rank(operating_income / equity, 126), subindustry)
```

### Appreciation of Liabilities

Hypothesis: rising fair value of liabilities may signal deteriorating financial
health or future profitability pressure.

Observed expression pattern:

```fastexpr
-ts_rank(liability_fair_value_field, 252)
```

Skill adaptation:

- Search the local field snapshot for liabilities / fair value fields.
- Validate coverage before use.
- Test 126 vs 252 day windows.

### Power of Leverage

Hypothesis: liability-to-asset ratios may have different meanings across
industries; leverage can be risky, but in some contexts can finance growth.

Observed pattern:

```fastexpr
liabilities / assets
```

Skill adaptation:

```fastexpr
group_rank(ts_rank(liabilities / assets, 126), industry)
```

or test sign explicitly:

```fastexpr
-1 * group_rank(ts_rank(liabilities / assets, 126), industry)
```

### Earnings Yield Momentum

Hypothesis: stocks whose EPS-to-price ratio has been high more often over the
last quarter may be undervalued.

Observed expression:

```fastexpr
group_rank(ts_rank(est_eps / close, 60), industry)
```

This directly supports the existing analyst template in `SKILL.md`.

### Short-Term Sentiment Volume Stability

Hypothesis: unstable attention can be driven by short-lived news or hype and may
lead to noisy, unsustainable price moves.

Observed pattern:

```fastexpr
-ts_std_dev(sentiment_volume_field, 10)
```

Skill adaptation:

- Use `nanHandling=ON`.
- Keep windows short but use decay 4-10.
- Check turnover and coverage carefully.

## Operator Notes

Useful base operators from the Learn operator list:

- Arithmetic: `abs`, `add`, `divide`, `log`, `max`, `min`, `multiply`,
  `power`, `reverse`, `sign`, `signed_power`, `sqrt`, `subtract`.
- Logical: `if_else`, comparisons, `is_nan`, `and`, `or`, `not`.
- Time series: `hump`, `kth_element`, `last_diff_value`, `ts_av_diff`,
  `ts_backfill`, `ts_corr`, `ts_count_nans`, `ts_covariance`,
  `ts_decay_linear`, `ts_delay`, `ts_delta`, `ts_mean`, `ts_product`,
  `ts_quantile`, `ts_rank`, `ts_regression`, `ts_scale`, `ts_std_dev`,
  `ts_step`, `ts_sum`, `ts_zscore`.
- Cross-sectional: `normalize`, `quantile`, `rank`, `scale`, `winsorize`,
  `zscore`.
- Vector: `vec_avg`, `vec_sum`.
- Transformational: `bucket`, `trade_when`.
- Group: `group_backfill`, `group_mean`, `group_neutralize`, `group_rank`,
  `group_scale`, `group_zscore`.

Practical operator upgrades:

- `hump(x)` can reduce turnover by limiting changes.
- `trade_when(condition, alpha, exit)` can reduce turnover by only refreshing
  alpha under specific conditions.
- `ts_av_diff(x, d)` is a concise `x - mean(x)` style dislocation operator and
  is suitable for mean-reversion candidates.
- `group_backfill` is useful for sparse group-comparable fields, but can also
  create crowded group averages if overused.

## Browser-Learn SOP for Future Agents

1. Open `https://platform.worldquantbrain.com/learn`.
2. Use Learn pages in this priority:
   - Documentation -> Create Alphas -> Simulation Settings
   - Documentation -> Interpret Results -> Clear these tests
   - Documentation -> Interpret Results -> Parameters in Simulation Results
   - Documentation -> Understanding Data -> Key Concepts and Tips
   - Documentation -> Examples -> Alpha Examples for Beginners
   - Operators -> Operator list
3. Summarize into operational rules; do not copy long Learn text verbatim.
4. Promote only rules that can be mapped to BRAIN settings, expressions, or
   submit checks.
