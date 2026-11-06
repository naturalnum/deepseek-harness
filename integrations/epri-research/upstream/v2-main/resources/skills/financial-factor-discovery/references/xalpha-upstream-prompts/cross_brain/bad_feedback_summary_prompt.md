# Bad Feedback Summary Prompt

Prompt constant: `BAD_FEEDBACK_SUMMARY_PROMPT`

Placeholders: `{FEEDBACK_RECORDS}`

````text
Analyze BAD feedback records as negative mechanism memory.

For each BAD feedback record, extract:
- mechanism_family: concise snake_case mechanism-family label
- failure_type: one of weak_standalone_proxy, noisy_binary_event, horizon_mismatch, over_complex_stack, redundant_duplicate, unstable_regime, bad_transform
- failed_assumption: mechanism assumption that likely failed, stated without formulas, exact windows, thresholds, or parameterized transforms
- avoidance_rule: mechanism class or design assumption future generation should avoid, not a parameter-tuning instruction
- repair_condition: mechanism-level evidence or structure required before retrying; otherwise exactly "not worth retrying without a clear repair"

Field constraints:
- `avoidance_rule` must target the failed design assumption, not just a formula detail.
- `repair_condition` must describe what causal confirmation, conditioning signal, or simplification would make retrying meaningful.
- Do not use repair conditions like changing a window, retuning a threshold, applying rank, smoothing, scaling, clipping, or normalization.

Input factor records:

<<factor N>>
Name: factor name
Hypothesis Idea: implemented mechanism idea
Sub-Mechanism Tags: mechanism-family tags
Logic: implemented mechanism explanation
Metrics: IC / RankIC / ICIR / RankICIR / final_score
Reason: why this feedback record was marked GOOD or BAD
<</factor N>>

Rules:
- Preserve factor names exactly.
- Copy each `Name:` value into the JSON `name` field exactly as written.
- Produce mechanism-level memory, not factor implementation explanations.
- Do not restate input Logic, formulas, pseudo-code, windows, thresholds, EWMA spans, rolling expressions, operators, or implementation recipes.
- Do not include exact lookback lengths, decay spans, threshold values, function names, operator names, or parameterized transforms in any output field.
- Use only daily OHLCV and documented primitives; do not mention unavailable external data.
- Do not suggest generic rank, smoothing, scaling, clipping, normalization, or window changes as the main lesson or repair.
- Return ONLY valid JSON. No markdown. No extra text.

Required JSON:
{
  "feedback": [
    {
      "name": "factor name",
      "mechanism_family": "concise_snake_case_family",
      "failure_type": "weak_standalone_proxy | noisy_binary_event | horizon_mismatch | over_complex_stack | redundant_duplicate | unstable_regime | bad_transform",
      "failed_assumption": "one concise sentence",
      "avoidance_rule": "one concise sentence",
      "repair_condition": "one concise sentence"
    }
  ]
}

Factor feedback records:
{FEEDBACK_RECORDS}
````
