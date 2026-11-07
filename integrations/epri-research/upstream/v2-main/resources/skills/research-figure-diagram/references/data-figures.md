# Data Figures

Use this reference when the request involves scientific plots, manuscript figures, statistical charts, heatmaps, model-performance plots, or multi-panel quantitative figures.

## Contract

Before plotting, record:

- Claim: the sentence the figure supports.
- Role: discovery, mechanism, validation, comparison, robustness, or clinical/biological relevance.
- Data unit: cell, animal, patient, run, seed, sample, timepoint, etc.
- Statistical layer: `n`, error bars, test, multiple-comparison correction, and exact or thresholded p-values.
- Export: target width, SVG/PDF/TIFF/PNG needs, editable text, and source-data traceability.

## Nature-Like Composition

- Prefer narrative hierarchy over dashboards. A dominant panel plus supporting panels often reads better than equal subplots.
- Use small bold lowercase panel labels near the top-left of each panel.
- Use white chart backgrounds. Use black only for imaging plates or genuinely dark image modalities.
- Use direct labels when the plotted geometry is stable; legends are second choice.
- Keep axis-heavy panels visually quieter than schematics, photos, or hero panels.
- Use saturated colors sparingly for true highlights, experimental channels, or directional change.

## Size And Typography

Useful starting widths:

- Single column: `3.35 in` wide.
- One-and-a-half column: `4.6-5.4 in` wide.
- Double column: `7.1-7.3 in` wide.

Use `6.5-8 pt` text for manuscript figures. Avoid huge titles inside panels; captions carry narrative text.

Matplotlib settings:

```python
import matplotlib as mpl

mpl.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
    "font.size": 7,
    "axes.labelsize": 7,
    "xtick.labelsize": 6,
    "ytick.labelsize": 6,
    "legend.fontsize": 6,
    "axes.linewidth": 0.7,
    "xtick.major.width": 0.6,
    "ytick.major.width": 0.6,
    "svg.fonttype": "none",
    "pdf.fonttype": 42,
})
```

## Palette

Default:

```text
neutral: #2F3437, #6B7280, #D1D5DB
blue:    #3B6FB6
teal:    #2A9D8F
orange:  #E9A441
red:     #C95C54
violet:  #8E6BBE
```

Rules:

- Use one neutral family, one signal family, and at most one accent family per figure.
- Use green/red mainly for directionally meaningful gains/drops or positive/negative states.
- Match colors across panels by meaning, not by local convenience.
- For colorblind-safe categorical plots, use Okabe-Ito-like colors.

## Plot Patterns

Distribution:

- Show raw points when sample size allows.
- Use box/violin only as summaries; avoid hiding all observations.
- State whether error bars are SD, SEM, CI, or IQR.

Trend:

- Use shared axes when panels compare the same quantity.
- Put model or condition labels directly near final points when possible.

Relationship:

- Scatter first, fit second.
- Include confidence intervals only when they are statistically meaningful.
- Use density or hexbin for heavy overplotting.

Heatmap:

- Sort rows/columns by a defensible criterion.
- Use centered diverging maps only for signed quantities.
- Keep annotation strips thin and consistently ordered.

Model comparison:

- Prefer dot/interval plots over crowded grouped bars.
- Show variability across seeds, folds, subjects, or sites when available.

## Export

Always save vector formats first:

```python
save_figure(fig, "figure1", formats=("svg", "pdf", "png", "tiff"))
```

Inspect:

- no clipped panel labels
- no microscopic tick labels
- no rasterized text unless intended
- no legend covering data
- all panels aligned and balanced

