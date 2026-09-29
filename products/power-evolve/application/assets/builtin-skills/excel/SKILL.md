---
name: excel-spreadsheets
description: Create, inspect, and modify Microsoft Excel .xlsx files with the preinstalled Office tool.
---

# Excel spreadsheets

Use the `office` tool for Excel work in `/workspace`.

1. Before reading or changing a workbook, call `office` with `load_skill` to check the installed catalog, then `load_skill excel` for the detailed guide pinned to that OfficeCLI version.
2. When syntax, properties, or values are uncertain, query `help xlsx`, then the narrow element or verb help. Do not guess.
3. Keep calculated results as formulas. Read formulas and values back after changing inputs.
4. Before delivery, save the file, run `validate`, inspect `view ... issues` and `view ... text`, and render the workbook for a visual check. Fix every detected problem and verify the saved file again.
