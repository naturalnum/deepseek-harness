---
name: research-literature
description: Search local engineering research materials and configured paper metadata providers, preserve source identifiers, and distinguish search candidates from verified evidence.
---

# Engineering literature and local sources

Use research_local_search for text attachments, records and research saved in the current conversation. This uses literal text matching, without OCR or PDF text extraction. Use research_literature_search for configured external paper metadata providers; these require reachable services. Search results are candidates, not verified findings or full text.

Read the source before relying on its conclusions. Save the available source file with research_attachment_put, and preserve its returned reference and hash through research_evidence_put. Record the query, identifiers, source date, limitations and whether the result was measured, computed, estimated or reported in literature. Request human review with research_evidence_review: the native conversation question requires an explicit authenticated human response for the current evidence revision. Source details remain available in the right-sidebar workbench.

For power engineering and general research, use the installed paper lookup, numerical analysis, materials and statistics skills as needed. Check the current Harness catalog and actual dependencies before invoking an external service or following a legacy skill reference.
