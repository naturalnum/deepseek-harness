# Good Feedback Summary Prompt

Prompt constant: `GOOD_FEEDBACK_SUMMARY_PROMPT`

Placeholders: `{FEEDBACK_RECORDS}`

````text
Analyze GOOD feedback records as positive mechanism memory.

For each GOOD feedback record, extract:
- mechanism_family: concise snake_case mechanism-family label
- positive_evidence: mechanism hypothesis supported by the metrics, stated without formulas, exact windows, thresholds, or parameterized transforms
- reusable_principle: causal mechanism lesson that can guide a different factor design without copying implementation details
- avoid_copying: abstract surface pattern not to copy; describe the wrapper or construction class without exact parameters, spans, thresholds, operators, or function names

Field constraints:
- `reusable_principle` must be the most reusable mechanism-level lesson.
- `positive_evidence` may mention direction of evidence but not implementation details.
- `avoid_copying` should say "the exact decay wrapper", "the specific binary mask", or "the direct inversion pattern" rather than naming exact spans, thresholds, or operators.

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
      "positive_evidence": "one concise sentence",
      "reusable_principle": "one concise sentence",
      "avoid_copying": "one concise sentence"
    }
  ]
}

Factor feedback records:
{FEEDBACK_RECORDS}
````
