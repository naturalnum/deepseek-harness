# Multi-Panel Composition

This reference adapts the OpenAI4S `figure-composer` workflow without depending
on its `host.delegate` runtime.

## Outline

Define one claim and a small panel outline before rendering:

```json
{
  "claim": "one defensible sentence",
  "widthMm": 180,
  "panels": [
    {"id": "a", "role": "orientation", "message": "what is measured", "evidenceIds": []},
    {"id": "b", "role": "primary", "message": "decisive result", "evidenceIds": ["..."]},
    {"id": "c", "role": "supporting", "message": "robustness or boundary", "evidenceIds": ["..."]}
  ]
}
```

- Let the orientation panel establish what is measured only when the reader
  needs it; do not force a schematic into every figure.
- Give the decisive result the largest or clearest panel.
- Keep each supporting panel only if it strengthens, bounds, or explains the
  same claim.
- Use a 12-column planning grid, stable gutters, and a small number of row
  heights. Do not make every panel the same size by default.

## Compose and Review

Render panels independently only when this simplifies tooling or parallel work.
Keep their physical font sizes and semantic labels consistent. Compose once,
then inspect the full figure and each panel crop. Revise only panels with a
specific defect; stop after three review rounds or earlier when remaining
changes are subjective.

Use `ds-team` only when actual parallel panel work saves time and every Worker
receives the common claim, outline, dimensions, evidence boundary, and output
contract. A multi-panel figure does not require subagents.
