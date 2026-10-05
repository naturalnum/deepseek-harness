# Changelog

## 1.1.29

- Bind new search_references requests to reference_evidence_contract=2 and top-level internet_access/items; persist the checked contract on the accepted artifact.
- Check explicitly scoped local file bytes during both apply and confirm, rejecting unsafe paths, links, nonregular files and changed hashes without saving failed state.
- Retain the captured legacy external-only reference shape without inventing missing verification metadata; reject local fields in that branch and placeholder HTTP in citation/verification text.
- Forward the same reference plan to chapter materials/plans/writing and formal chapter/report review; keep final reviewed Markdown authoritative for Word.

## 1.1.28

- Save workflow JSON through a same-directory private temporary file, file synchronization, atomic replacement and directory synchronization; report an unconfirmed commit after a directory-sync failure without restoring old state or replaying actions.
- Require integer inspection records to cover exactly every rendered page of the current Word version; reject missing, repeated, out-of-range and boolean page numbers.
- Publish the report workflow for both Cloud and Desktop execution targets.

## 1.1.27

- Pair the chapter confirmation fixture README in English and Chinese with a consistency record.
- Retain captured QA inputs, historical versions and workflow behavior; publish the added package documentation under a new release version.

## 1.1.26

- Preserve the delimiter between figure/table numbers and titles, including image alt captions, in final report assembly and the public normalization CLI.
- Retain heading numbering prefixes, code preservation and normal cleanup within titles and prose; do not change workflow control, confirmed content or Word caption classification.

## 1.1.25

- Permit explicit user feedback to authorize one revision of the current unconfirmed chapter stopped by an exact deterministic-gate or formal-review revision-limit reason and its matching latest failed review.
- Preserve failure counters, historical versions/reviews and file paths; failed revisions wait for fresh version-bound feedback, and passing revisions still require current-version formal review and user confirmation.
- Retain workflow state 1.1.3 and all existing rejection rules for blocked/failed, stale, confirmed or pending work.

## 1.1.24

- Add explicit user revision requests for current unconfirmed profile, architecture, outline, reference plan, chapter plan/body, abstract and report versions.
- Keep user feedback separate from formal reviews, preserve history, reject conflicting or stale requests, and require new version output paths and current-version validation/review.
- Preserve optional-field compatibility with workflow state 1.1.3. User revision of Word output remains unsupported; formatter validation repair remains unchanged.

Earlier product releases 1.1.22–1.1.23 remain recorded in `SOURCE.json`.
