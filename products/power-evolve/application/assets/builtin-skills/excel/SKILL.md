---
name: excel-spreadsheets
description: Create, inspect, and modify Microsoft Excel .xlsx files with the Office tool preinstalled in the authorized execution image.
---

# Excel spreadsheets

Use the `office` tool for Excel work in `/workspace`.

Each `office` call uses direct file mode. Name the actual file in every command; do not submit shell variables such as `$FILE` to `office`. Skip the upstream guide’s resident `open`/`save`/`close` workflow. Direct edits persist before the command completes. Wait for the trusted execution result before issuing the next dependent command.

1. Before reading or changing a workbook, call `office` with `load_skill` to check the installed catalog, then `load_skill excel` for the detailed guide pinned to that OfficeCLI version.
2. When syntax, properties, or values are uncertain, query `help xlsx`, then the narrow element or verb help. Do not guess.
3. Keep calculated results as formulas. Read formulas and values back after changing inputs.
4. Before delivery, run `validate`, inspect `view ... issues` and `view ... text`, then render the saved file as described below. Fix detected problems and verify the saved file again.

## Render and inspect the saved file

Use the current execution target’s command tool for LibreOffice and Poppler: `cloud_exec` for cloud work or `desktop_exec` for the selected, locally authorized Device. Keep rendering in the same target as the editable file; cloud and local project files are separate. The authorized execution image supplies Writer, Calc, Impress, and PDF rendering tools; OfficeCLI’s optional PDF/screenshot exporters are not required. Render a copy to a fresh directory, preserving the original editable file. In the following shell example, replace the input path with the actual file:

```bash
set -euo pipefail
FILE=/workspace/workbook.xlsx
RENDER_DIR="$(mktemp -d /workspace/excel-preview.XXXXXX)"
PROFILE_DIR="$(mktemp -d /tmp/power-evolve-lo.XXXXXX)"
libreoffice -env:UserInstallation="file://$PROFILE_DIR" --headless --convert-to pdf --outdir "$RENDER_DIR" "$FILE"
PDF="$RENDER_DIR/$(basename "$FILE" .xlsx).pdf"
test -s "$PDF"
pdfinfo "$PDF"
pdftotext -layout "$PDF" "$RENDER_DIR/text.txt"
pdftoppm -png -r 110 "$PDF" "$RENDER_DIR/page"
printf 'Preview directory: %s\n' "$RENDER_DIR"
```

Check extracted text against the intended content and inspect every rendered page or slide for clipping, missing glyphs, layout, and contrast. For large documents, render page ranges in separate bounded commands. For spreadsheets, check print areas, page breaks, and formula results. If your model cannot inspect images, provide the previews and explicitly state that visual inspection remains pending; rendering or schema validation alone does not prove visual quality. Deliver the editable original and identify any unresolved issue.
