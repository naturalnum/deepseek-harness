# Alignment Review Prompt

Prompt constant: `ALIGNMENT_REVIEW_PROMPT`

Placeholders: `{STRIPPED_CODE}`, `{DOCSTRING}`, `{COMMENTS}`

````text
Evaluate whether the factor's explanatory text and executable implementation are aligned and financially sound.

Definitions:
- Explanatory text includes the function docstring and inline comments.
- Stripped code means executable code after removing docstring and comments.

Judge three things:
1. explanatory_text_code_alignment:
   Accept only if the explanatory text accurately describes what the stripped code actually computes.
2. stripped_code_financial_soundness:
   Accept only if the executable code expresses a coherent, causal, daily-OHLCV alpha mechanism and is free of obvious leakage or pseudo-signal construction.
3. explanatory_text_financial_soundness:
   Accept only if the explanatory text describes a financially coherent mechanism without overclaiming or adding mechanisms absent from the code.

### Stripped Code
<<stripped code>>
{STRIPPED_CODE}
<</stripped code>>

### Explanatory Text
<<docstring>>
{DOCSTRING}
<</docstring>>

<<comments>>
{COMMENTS}
<</comments>>

Rules:
- Judge stripped code independently from explanatory text.
- Reject if explanatory text contradicts the stripped code.
- Reject if explanatory text describes mechanisms, inputs, filters, regimes, formulas, or financial interpretations not implemented in the stripped code.
- Reject if stripped code is only a cosmetic transform, arbitrary wrapper, noisy proxy, leakage-prone construction, or financially incoherent signal.
- Reject unsupported market stories, misleading formulas, and over-interpretation.
- Return ONLY valid JSON.
- Do not output markdown fences or extra prose.

Required JSON schema:
{{
  "explanatory_text_code_alignment": "Accept/Reject",
  "stripped_code_financial_soundness": "Accept/Reject",
  "explanatory_text_financial_soundness": "Accept/Reject"
}}
````
