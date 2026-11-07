# Cross-Platform Factor Mining SOP

Source review date: 2026-06-25.

This note converts public, reusable knowledge from WorldQuant BRAIN/Learn2Quant,
QuantConnect, Alphalens, Qlib, Numerai, and factor research papers into a
practical SOP for WorldQuant BRAIN alpha mining.

It is not a copy of private BRAIN Learn course material. Logged-in Learn pages
are served as a web app, so this note uses publicly available official pages,
official docs, and research papers as source material.

## Source Map

| Source | Reusable idea for this skill |
|---|---|
| WorldQuant BRAIN / Learn2Quant | Alpha ideas should be built by data category, idea type, frequency, delay, risk, and diversification. |
| WorldQuant IQC guidelines | Alphas count only when they qualify for out-of-sample testing; quality and quantity both matter; no simple "submit request = score" shortcut. |
| QuantConnect Algorithm Framework | Separate universe, alpha signal, portfolio construction, risk, and execution. In BRAIN, focus the expression on the alpha signal. |
| QuantConnect Research Guide | Research should be hypothesis-driven and time-boxed; avoid endless parameter fishing. |
| Alphalens | A factor is a cross-sectional prediction value, not a full trading algorithm; evaluate returns, IC/information, turnover, and group effects separately. |
| Qlib | Treat quant research as a reproducible workflow: data -> signal/forecast -> decision -> backtest/evaluation -> report. |
| Numerai | Neutralization and exposure control help distinguish residual predictive signal from common feature/sector exposure. |
| Fama-French / AQR / 101 Formulaic Alphas | Use proven factor families and formulaic diversity, but validate in the current BRAIN universe before trusting them. |

## Core Research Loop

1. Define the hypothesis before writing FASTEXPR.
   - One sentence only: "Stocks with improving profitability within the same industry should outperform."
   - Specify sign: higher signal should mean long, or explicitly multiply by `-1`.
   - Specify horizon: short-term reversal, medium-term trend, slow fundamental.
   - Specify data family: fundamental, analyst, pv, news, option, social.

2. Map the hypothesis to fields.
   - Search `wq_usa_top3000_delay1_data_fields.json`.
   - Prefer high coverage and economically interpretable fields.
   - Validate each unfamiliar field with `rank(field)` before building a compound expression.
   - For sparse fundamental fields, consider `ts_backfill` or `group_backfill` only after simple validation.

3. Choose the expression skeleton.
   - Fundamental/analyst: `group_rank(ts_rank(signal, N), industry_or_subindustry)`.
   - Technical reversal: `rank(-ts_decay_linear(dislocation, N))` with higher decay.
   - Event/news/sentiment: `trade_when(event_condition, signal, hold)` or `if_else`.
   - Composite: combine different economic families, not tiny variants of the same family.

4. Run a small controlled batch.
   - Change one dimension per experiment: field, window, neutralization, decay, or transform.
   - Keep batches small enough to inspect, usually 5-20 expressions.
   - Avoid dozens of near-duplicates; they waste simulation budget and raise self-correlation risk.

5. Apply the IS gate.
   - Sharpe >= 1.25 minimum, >= 1.50 preferred.
   - Fitness >= 1.0 minimum, >= 1.10 for auto-submit, >= 1.50 strong.
   - Turnover between 1% and 20% preferred; be cautious above 25%.
   - Drawdown < 15%.
   - No blocking IS checks: LOW_SHARPE, LOW_FITNESS, HIGH_TURNOVER, CONCENTRATED_WEIGHT, LOW_SUB_UNIVERSE_SHARPE.

6. Apply the portfolio/diversity gate.
   - Fetch existing ACTIVE alpha PnL.
   - Convert cumulative PnL to daily PnL changes.
   - Reject or rework candidates with abs(daily-return correlation) >= 0.7 unless the new alpha is clearly better.
   - Prefer a moderate number of genuinely different signal families over many parameter variants.

7. Submit only after both gates pass.
   - `POST /submit` success is not enough.
   - Confirm the alpha detail page/API shows `status == ACTIVE`.
   - Record status, metrics, failed checks, expression family, and top correlations.

8. Update local memory.
   - Put private alpha IDs, expressions, and PnLs in ignored `alpha_db.json`.
   - Put only sanitized general rules into `SKILL.md` or references.
   - Record failures explicitly; they reduce repeated search.

## Cross-Platform Lessons Translated to BRAIN

### WorldQuant BRAIN / Learn2Quant

Use BRAIN as an alpha laboratory, not a backtest toy. Good alpha mining should
balance:

- data category: fundamental, analyst, pv, news, option, social
- idea type: value, profitability, quality, momentum, reversal, event, volatility
- holding frequency/delay: slow fundamental vs faster pv/reversal signals
- risk and diversification: neutralization, truncation, turnover, correlation

Practical BRAIN translation:

- Keep a small number of high-quality ACTIVE alphas from different families.
- Do not mistake "many simulations" for progress.
- For Challenge/IQC-style scoring, qualifying for out-of-sample testing matters more than raw simulated count.

### QuantConnect

QuantConnect's framework separates the research stack:

```
Universe -> Alpha signal -> Portfolio construction -> Risk -> Execution
```

BRAIN hides most later layers. Therefore, in FASTEXPR:

- do not overfit execution logic inside the alpha expression
- express only the predictive ranking signal
- use BRAIN settings for neutralization, decay, truncation, and book construction
- think of `rank(...)` output as an "insight" rather than as final portfolio PnL

### Alphalens

Alphalens makes a useful distinction:

- factor: one value per asset per date, evaluated cross-sectionally
- trading algorithm: uses factor(s), execution, risk, and portfolio constraints

BRAIN alphas are closer to factor expressions than full trading strategies. The
Alphalens-style mental checklist is:

- Returns: do top-ranked stocks outperform bottom-ranked stocks?
- Information: is ranking correlated with future returns?
- Turnover: how often does the ranking change?
- Group effect: does the signal only work in one sector/industry?

BRAIN translation:

- `group_rank` and neutralization are not decoration; they test whether the signal is more than sector exposure.
- Turnover is not automatically bad, but high turnover must earn enough Sharpe/Fitness to justify itself.
- If performance disappears under sub-universe or group-neutral checks, the signal is probably fragile.

### Qlib

Qlib's workflow suggests making experiments reproducible:

```
config -> data/fields -> expression/model -> backtest -> evaluation -> report
```

BRAIN translation:

- Store every candidate batch as JSON with settings.
- Store every result as JSON/Markdown.
- Keep "candidate generation" separate from "submission".
- Use scripts as reproducible workflows rather than one-off browser clicks.

### Numerai

Numerai emphasizes neutralization and feature exposure. The useful idea is not
to import Numerai metrics directly, but to avoid signals that are just exposure
to a common factor.

BRAIN translation:

- Industry/subindustry neutralization is a first-order exposure control.
- Self-correlation is a portfolio-level exposure check across your own alphas.
- A candidate should survive at least one neutralization setting and not depend on a single fragile feature.

## Failure Diagnosis SOP

| Symptom | First diagnosis | First actions |
|---|---|---|
| LOW_SHARPE | signal weak or sign wrong | flip sign, change field, add `group_rank`, lengthen window |
| LOW_FITNESS | usually turnover or return problem | increase decay, blend slower signal, reduce technical noise |
| HIGH_TURNOVER | signal changes too fast | decay 12-30, longer window, `trade_when`, mix fundamental |
| LOW_TURNOVER | signal too static | shorter window, analyst/news/pv field, lower decay |
| CONCENTRATED_WEIGHT | sparse/extreme values | `rank`, `winsorize`, lower truncation, backfill |
| LOW_SUB_UNIVERSE_SHARPE | small-cap/liquidity dependence | avoid size proxy, add group rank, use more robust fields |
| SELF_CORRELATION | same family as existing alpha | change data source/economic logic, not only window/weight |

## Promotion Rules

Promote an experimental rule into the main template library only if:

- at least one candidate becomes ACTIVE
- metrics clear the stricter auto-submit gate
- the candidate is not highly correlated to existing ACTIVE alphas
- the idea is interpretable enough to mutate safely
- at least one nearby variant supports the same conclusion, or the failure set explains why only this version works

## Useful Source Links

- WorldQuant BRAIN: https://www.worldquant.com/brain/
- WorldQuant Learn2Quant: https://www.worldquant.com/learn2quant/
- WorldQuant IQC guidelines: https://www.worldquant.com/brain/iqc-guidelines/
- QuantConnect Alpha key concepts: https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/alpha/key-concepts
- QuantConnect Algorithm Framework overview: https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/overview
- QuantConnect Research Guide: https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide
- Alphalens overview: https://alphalens.ml4trading.io/notebooks/overview.html
- Alphalens docs: https://quantopian.github.io/alphalens/
- Qlib docs: https://qlib.readthedocs.io/
- Qlib paper: https://arxiv.org/abs/2009.11189
- Numerai FNC docs: https://docs.numer.ai/numerai-tournament/scoring/feature-neutral-correlation
- Numerai data docs: https://docs.numer.ai/numerai-tournament/data
- Fama-French 5-factor data description: https://mba.tuck.dartmouth.edu/pages/faculty/Ken.french/Data_Library/f-f_5_factors_2x3.html
- Fama-French five-factor paper: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2287202
- AQR Quality Minus Junk dataset note: https://www.aqr.com/Insights/Datasets/Quality-Minus-Junk-Factors-Daily
- AQR Value and Momentum Everywhere: https://www.aqr.com/Insights/Research/Journal-Article/Value-and-Momentum-Everywhere
- 101 Formulaic Alphas: https://arxiv.org/abs/1601.00991
