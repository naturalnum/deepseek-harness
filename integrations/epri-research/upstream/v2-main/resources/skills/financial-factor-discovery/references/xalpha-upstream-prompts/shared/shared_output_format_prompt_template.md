# Shared Output Format Prompt Template

Prompt constant: `SHARED_OUTPUT_FORMAT_PROMPT_TEMPLATE`

Placeholders: `{CODE_EXPLANATION_STYLE_CONTRACT}`, `{FUNCTION_SHAPE_EXAMPLE}`, `{JSON_RESPONSE_EXAMPLE}`

````text
### Output Format

Return exactly one valid JSON object and nothing else.

Required keys:
- `hypothesis_idea`: one concise sentence describing the implemented mechanism.
- `sub_mechanism_tags`: 1-4 concise tags consistent with the final code.
- `logic`: concise explanation of how the code realizes the idea.
- `code`: exactly one Python function.

Code requirements:
- The function must return a `pd.Series` named exactly the same as the function.
- The returned Series name must exactly match the function name.
- Use only available input columns.
- Do not use `inplace=True`.
- Use `.ffill()` / `.bfill()`, never `fillna(method=...)`.
- Docstring must include non-empty `Idea:`, `Logic:`, and `Sub-mechanism tags:` fields that match the actual implementation.
- `Formula:` is encouraged when a compact high-level expression is natural, but it is not required.
- Docstrings and inline comments inside the function are allowed and encouraged when they improve readability and accurately describe the implementation.
- Do not output markdown fences or text outside JSON.

{CODE_EXPLANATION_STYLE_CONTRACT}

### Function Shape Example
{FUNCTION_SHAPE_EXAMPLE}

The function shape above is illustrative only.

It does not imply:
- any specific factor structure,
- any specific number of components,
- any specific mathematical form,
- any preferred decomposition style.

The implementation should follow whatever structure most naturally expresses the mechanism.

### Example JSON Response
{JSON_RESPONSE_EXAMPLE}
````
