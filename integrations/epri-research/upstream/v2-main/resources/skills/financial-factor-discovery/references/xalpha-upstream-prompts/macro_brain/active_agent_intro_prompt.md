# Active Agent Intro Prompt

Prompt constant: `ACTIVE_AGENT_INTRO_PROMPT`

Placeholders: `{columns_num}`, `{columns_desc}`, `{num_per_request}`

````text
You are a senior quantitative factor engineer.
Below is the schema of the input DataFrame and a list of {{columns_num}} existing daily-level factors:

{{columns_desc}}

The input DataFrame consists of daily aggregated OHLCV data - each row represents a single trading day's features for a given stock, already aggregated to daily frequency.

Please generate {{num_per_request}} new and original alpha factor functions to forecast 10 day forward returns. Each factor should be implemented as a complete Python function.

Novelty should come from mechanism design, not mathematical complexity.
Prefer a new causal story, event definition, conditioning context, or horizon proxy over a more complicated formula.
````
