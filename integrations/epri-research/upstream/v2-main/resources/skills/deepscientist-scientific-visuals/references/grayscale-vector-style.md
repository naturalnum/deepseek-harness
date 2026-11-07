# Grayscale-First Vector Style

## Palette

Use these defaults as recommendations:

| Role | Light | Dark |
| --- | --- | --- |
| Primary ink | `#111111` | `#F2F2F2` |
| Secondary ink | `#4B4B4B` | `#C8C8C8` |
| Muted ink | `#858585` | `#969696` |
| Grid and rule | `#D8D8D8` | `#4A4A4A` |
| Quiet surface | `#F3F3F3` | `#242424` |
| Background | `#FFFFFF` or transparent | transparent or `#151515` |

Prefer one muted accent only when it carries meaning that line style, marker,
shape, hatching, or annotation cannot communicate efficiently. Never encode an
opposition only as red versus green.

## SVG Contract

- Set a stable `viewBox`; do not depend only on fixed width and height.
- Include `<title>` and `<desc>` under the root SVG.
- Keep text selectable when the target renderer supports it.
- Use strokes of at least 1 px at final display scale; make the decisive series
  heavier rather than brighter.
- Use direct labels where practical. Keep a frameless legend only when direct
  labels would collide.
- Avoid gradients, filters, glow, drop shadows, texture backgrounds, and
  unnecessary rounded containers.
- Keep labels inside the view box and verify both light and dark surfaces.

## Distinguish Without Color

Apply distinctions in this order:

1. position or spatial grouping;
2. direct text label;
3. marker shape or glyph;
4. solid, dashed, or dotted stroke;
5. stroke weight or fill lightness;
6. hatch or texture for print;
7. one semantic accent when still necessary.

The final exported SVG, PDF, or PNG must remain interpretable after grayscale
conversion. A color exception is acceptable when it is documented in the
caption and remains accessible by a second visual channel.
