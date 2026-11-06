# Interaction and Palette Profiles

Use these profiles only after selecting the correct chart kind and verified
data. They change how a reader inspects a chart; they do not repair evidence or
change the static Artifact.

## Interaction selector

| Profile   | Preview behavior                                                                                                            | Use when                                                            | Avoid when                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| `auto`    | Chooses a restrained profile from the chart kind                                                                            | Normal reports                                                      | A review surface has a specific density constraint         |
| `inspect` | Delayed value readout below the plot, focus ring or axis guide, enlarged invisible hit area, and one-shot pin feedback      | Point-level reading matters in a line, scatter, interval, or matrix | The chart has hundreds of tightly packed interactive marks |
| `quiet`   | Value readout below the plot, hover focus, and click or keyboard pinning without pointer spotlight or focus-guide animation | Dense charts, print review, or formal audit                         | A reader needs help locating one point against both axes   |

The preview may make a thin path easier to hit, but it must never translate,
scale, smooth, or magnify the data geometry. The pin feedback is a short ring on
the overlay, not a particle effect. Reduced-motion and print views omit motion.
The returned SVG is always static and script-free.

The preview preserves a readable natural chart width and exposes horizontal
scrolling on narrower surfaces rather than continually scaling the SVG down.
Primary labels use the larger figure type tier and axes, ticks, legends, and
readouts use the secondary tier. Direct line labels occupy a dedicated right
gutter. Dense scatter plots keep only emphasized and extrema labels visible;
the fixed readout carries the remaining point detail without covering content.

A chart exposes one Tab stop rather than one stop per datum. Arrow keys move
between marks, Home/End jump to the first or last mark, Enter/Space pins, and
Escape clears. This keeps dense charts operable without turning the page into a
keyboard trap. Hover and focus never change the axis domain or mark geometry.

Semantic evidence/status badges use a deterministic icon or symbol plus text
and a traceable rule. Never generate them, chart thumbnails, data marks, or
controls with an image model; render thumbnails from fixed specs through the
real renderer. Image generation is limited to reviewed, non-semantic identity
art or evidence-appropriate explanatory scenes.

## DeepScientist Morandi palette

This is DeepScientist's screen-safe version of its fixed Morandi figure family,
with typography and contrast discipline informed by the open-source Nature
Skills workflow. It is not an official Springer Nature corporate, brand, or UI
palette.

| Role               | Light value | Intended use                                         |
| ------------------ | ----------- | ---------------------------------------------------- |
| Ink                | `#2D2A26`   | Axes, labels, primary mono series                    |
| Muted ink          | `#5D5A55`   | Ticks, captions, secondary mono series               |
| Hairline           | `#DDDAD4`   | Sparse grid or separators                            |
| Fog blue           | `#596F96`   | Primary evidence signal and sequential high values   |
| Mist teal          | `#4A7780`   | Second categorical series                            |
| Lavender ash       | `#716989`   | Third categorical series or explicit mixed evidence  |
| Warm stone         | `#756C64`   | Fourth categorical series                            |
| Against/negative   | `#916565`   | Evidence against a claim or a diverging negative end |
| Positive direction | `#607369`   | Positive delta only                                  |
| Risk               | `#806A3E`   | Risk/warning with light or dark contrast-aware text  |

Use one neutral family, one signal family, and at most one accent in a routine
chart. Do not use red/green as arbitrary series colors. Retain direct labels,
line patterns, shapes, or status symbols so color is never the only carrier of
meaning.

## Heatmaps and uncertainty

- Use `colorScale="sequential"` for increasing magnitude without a meaningful
  center. A light-to-`#596F96` scale communicates low-to-high values.
- Use `colorScale="diverging"` only when a meaningful `center` separates two
  directions. Supply a `valueDomain` that spans the center; the preview uses a
  neutral center with blue and red ends.
- Use `line.uncertainty-band` only when every line point contains computed
  `low` and `high` values satisfying `low <= y <= high`. Put interval level and
  method in the caption or description.
- Never use a decorative line shadow, glow, or blur as a substitute for an
  uncertainty interval.
