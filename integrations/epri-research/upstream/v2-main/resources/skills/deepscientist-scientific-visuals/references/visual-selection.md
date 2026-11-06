# Visual Selection

Choose the medium by the reader's task, not by what is easiest to generate.

| Reader task | Prefer | Avoid |
| --- | --- | --- |
| Read one or two exact facts | Sentence or compact table | A chart with only one useful mark |
| Compare categories or estimates | Typed bar, interval, pair, or matrix chart | Decorative infographic |
| Follow change over an ordered axis | Line or sequence chart | Connecting unrelated categories |
| Inspect morphology or spatial arrangement | Verified source image or domain viewer | AI recreation of observed evidence |
| Understand a mechanism or workflow | Editable SVG/Graphviz/draw.io diagram | Dense bitmap text |
| Inspect a protein or complex | PDB/mmCIF viewer plus confidence/QC | Screenshot as the only artifact |
| Inspect single-cell structure | UMAP/spatial image plus underlying H5AD/table | UMAP without QC or sample context |
| Defend one paper claim with several panels | Multi-panel figure | Dashboard of equal-weight panels |

Ask four questions before drawing:

1. What would the reader understand faster or more accurately?
2. Which registered evidence supplies every visible mark or claim?
3. Is this information already visible in a table, card, viewer, or another plot?
4. Can the visual remain legible in grayscale, at its final physical size, and
   without a long legend?

If the first two answers are weak, do not draw. If the third is yes, reuse the
existing visual or keep the duplicate collapsed. If the fourth is no, simplify
the data question or use a table.

For a report, normally suggest one decisive lead visual only when it materially
improves the reading path. Add supporting visuals only when each answers a
different reader question. These are suggestions, not quotas.
