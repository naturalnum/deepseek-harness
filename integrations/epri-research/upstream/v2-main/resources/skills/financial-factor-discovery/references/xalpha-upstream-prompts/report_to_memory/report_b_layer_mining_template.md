# Report B Layer Mining Template

Prompt constant: `REPORT_B_LAYER_MINING_TEMPLATE`

Placeholders: `{layer_a_data_scope}`, `{b_layer_catalog}`

````text
Mine daily-OHLCV research paths from ONE report chunk, then assign each path to one Layer-B family.

Input assumptions:
- The chunk already passed Layer A.
- Available data is daily open/high/low/close/volume only.
- Do not output formulas, indicators, backtests, portfolios, risk rules, C-layer ids, or agent names.

Layer A data scope:
{layer_a_data_scope}

Layer B catalog:
{b_layer_catalog}

Return ONLY valid JSON:
{{
  "research_paths": [
    {{
      "status": "accepted",
      "research_path": "one concise daily-OHLCV research direction",
      "b_id": "one valid b_id",
      "b_layer_reason": "one short reason",
      "rejected_reason": "",
      "keywords": ["keyword_1", "keyword_2"],
      "supporting_logic": ["one chunk-grounded support statement"],
      "evidence_quote": "one short verbatim supporting snippet",
      "failure_type": "none"
    }}
  ]
}}

Rules:
- Extract 0..N distinct research paths. Keep separate paths separate.
- Each accepted path must have one valid b_id from the catalog.
- For accepted items, research_path should be one concise English factor-mining direction expressible with daily OHLCV.
- research_path should usually be fewer than 40 words, but it must contain enough mechanism detail to be useful.
- research_path must not be overly short, generic, or information-poor.
- For accepted items, b_layer_reason explains why that b_id fits this path.
- For accepted items, keywords support the path; use 3-7 short mechanism phrases.
- For accepted items, supporting_logic supports the path itself; use 1-3 chunk-grounded statements.
- evidence_quote is one verbatim supporting snippet, <= 200 chars.
- For accepted items, b_layer_reason is required, rejected_reason must be "", and failure_type must be "none".
- For rejected items, rejected_reason explains why no B-layer can be assigned, b_layer_reason must be "", and failure_type must be "no_matching_b_layer".
- If the chunk contains no usable path candidates, return one rejected item explaining why.
````
