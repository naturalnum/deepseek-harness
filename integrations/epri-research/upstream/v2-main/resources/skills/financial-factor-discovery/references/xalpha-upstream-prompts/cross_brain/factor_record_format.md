# Factor Record Format

Prompt constant: `_FACTOR_RECORD_FORMAT`

Usage note: internal reusable block embedded inside GOOD/BAD feedback summary prompts; not a standalone LLM call.

Placeholders: None

````text
Input factor records:

<<factor N>>
Name: factor name
Hypothesis Idea: implemented mechanism idea
Sub-Mechanism Tags: mechanism-family tags
Logic: implemented mechanism explanation
Metrics: IC / RankIC / ICIR / RankICIR / final_score
Reason: why this feedback record was marked GOOD or BAD
<</factor N>>
````
