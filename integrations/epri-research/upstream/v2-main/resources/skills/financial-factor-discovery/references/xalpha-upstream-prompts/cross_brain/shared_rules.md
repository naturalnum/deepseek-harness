# Shared Rules

Prompt constant: `_SHARED_RULES`

Usage note: internal reusable block embedded inside GOOD/BAD feedback summary prompts; not a standalone LLM call.

Placeholders: None

````text
Rules:
- Preserve factor names exactly.
- Copy each `Name:` value into the JSON `name` field exactly as written.
- Produce mechanism-level memory, not factor implementation explanations.
- Do not restate input Logic, formulas, pseudo-code, windows, thresholds, EWMA spans, rolling expressions, operators, or implementation recipes.
- Do not include exact lookback lengths, decay spans, threshold values, function names, operator names, or parameterized transforms in any output field.
- Use only daily OHLCV and documented primitives; do not mention unavailable external data.
- Do not suggest generic rank, smoothing, scaling, clipping, normalization, or window changes as the main lesson or repair.
- Return ONLY valid JSON. No markdown. No extra text.
````
