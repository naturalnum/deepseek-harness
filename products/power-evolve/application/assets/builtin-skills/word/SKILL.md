---
name: word-documents
description: Create, inspect, and modify Microsoft Word .docx files with the preinstalled Office tool.
---

# Word documents

Use the `office` tool for Word work in `/workspace`.

1. Before reading or changing a document, call `office` with `load_skill` to check the installed catalog, then `load_skill word` for the detailed guide pinned to that OfficeCLI version.
2. When syntax, properties, or values are uncertain, query `help docx`, then the narrow element or verb help. Do not guess.
3. Work incrementally and inspect the result after structural changes.
4. Before delivery, save the file, run `validate`, inspect `view ... issues` and `view ... text`, and render the document for a visual check. Fix every detected problem and verify the saved file again.
