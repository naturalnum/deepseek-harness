# Complexity Constraints Prompt Template

Prompt constant: `COMPLEXITY_CONSTRAINTS_PROMPT_TEMPLATE`

Placeholders: `{EXTRA_LINES_BLOCK}`

````text
### Complexity Control

Keep the factor simple, inspectable, and mechanism-driven.

Rules:
- Use one coherent mechanism only.
- As concise as possible while fully expressing the mechanism.
- Use 1-5 logical steps in total from raw inputs to final factor; each step must have a clear mechanism role.
- No more than 5 logical steps.
- Prefer 1-4 meaningful transformations.
- Avoid more than 4 core intermediate signal concepts.
- Avoid more than 2 rolling windows unless necessary.
- Use at most one smoothing / decay / ranking / normalization layer.
- Avoid nested transforms, arbitrary nonlinear ornamentation, stacked ratios, and unrelated theme mixtures.
- Every component must have a clear mechanism role.
{EXTRA_LINES_BLOCK}

Soft target:
- Usually fit within 8-18 executable lines excluding docstring/comments.
- Use the simplest implementation that fully expresses the mechanism.
````
