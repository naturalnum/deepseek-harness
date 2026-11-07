# Single-Figure Quality

This reference adapts the correctness and legibility ideas from OpenAI4S
`figure-style` to the DeepScientist artifact contract.

## Before Rendering

- Write one sentence the figure must make defensible.
- Trace every row, summary, threshold, title, and category back to evidence.
- Exclude incomparable conditions or separate them visibly and explain why.
- State the unit of replication and sample size when a summary mark is shown.
- Choose a chart family from data shape. Do not use bars on a logarithmic value
  axis or imply a continuous trajectory between unrelated categories.

## Label Budget

- Make every distinct mark identifiable from the figure alone.
- Keep at most three font sizes by role: title/axis/identity, annotation/legend,
  and tick labels. Panel letters are the only larger exception.
- Put context, abbreviations, exclusions, and methodological caveats in the
  caption rather than crowding the plot.
- Put a numeric label on only the headline mark unless exact lookup is the task.

## Render and Inspect

1. Save an editable source and one UI preview.
2. Check text and mark bounds programmatically when the plotting library allows.
3. Inspect the final-size preview for overlap, clipped labels, low contrast,
   ambiguous leaders, invisible zero marks, and legend confusion.
4. Correct one concrete defect without re-decorating panels that already pass.
5. Register the source data/spec, preview, caption, evidence ids, and environment
   through `science_artifact`.

A visually polished plot does not repair leakage, invalid statistics, missing
controls, or unsupported causal interpretation.
