# Financial Publish And Completion Contract

## Preflight

1. Select one contract id from the runtime `FinanceTaskContract` registry. Resolve its current version and `contractHash`; do not invent or cache a hash in prose.
2. Start a bound or write-capable run with a verified `project_workspace(action="status")` receipt. Start an unbound read-only run with an explicit `unbound_read_only` gate. In that mode, conversation-scoped Evidence, Artifacts, cards, and a Science Report are allowed only to render the answer; do not write project files, Git, schedules, portfolios, or provider state.
3. If intent is mixed or a missing choice changes the protocol, ask once with structured `user_input`. Otherwise route deterministically.
4. Stop with `blocked` when the selected plugin, required capability, required permission, or required source is unavailable and no reviewable alternative remains. If an individual provider read fails, record the exact gap and continue independent tools or user/primary-source evidence; do not replace missing financial values with unverified prose.
5. Provider/specialist unavailability is an early terminal preflight only when it leaves no reviewable data. When reviewable data remains, publish one clearly labelled `partial` report with the failed read, retry outcome, and limitation; never create an empty Report merely to record the absence.

## Evidence And Artifacts

- Register every source used by a conclusion through `research_evidence`, retaining `asOf`, `retrievedAt`, timezone, currency, coverage, missing symbols, upstream revision, content hash, and warnings when available.
- Preserve each verified tool receipt. A successful MCP response is not a completion signal.
- Publish the contract's versioned Artifact kind and bounded cards through `science_artifact`. Prefer `payload.cardDrafts` from the runtime `cardAuthoring` guide; the server fills versioned provenance and preview routing from the run. Set the guide's compatible `moduleId` on every draft so the service can insert its `card_ref` into the module's default report section. Use fully materialized `payload.cards` only when every contract field is already known. Never send both. Every card must resolve its Evidence and Artifact references and must be referenced by the published Report to count toward completion.
- Treat finance-tool `reportSuggestions` as non-binding hints. Select card kinds and visualizations from the evidence actually returned; omit a suggested module when it would be empty, misleading, duplicative, or unrelated to the user's question.
- A table, ranked list, or evidence list may retain up to the runtime guide's storage limit, but `pageSize` must be at most 20. Additional candidates stay available through pagination instead of expanding the whole report.
- Treat an Artifact or Viewer event as supporting material, not the final answer. The user-facing delivery is the shared Science Report published from the same run.
- Keep Project Git for editable research files and Artifact Git for immutable evidence/report snapshots. Never commit provider caches, licensed raw payloads, secrets, private screenshots, or unchanged output.

## Completion

Use this terminal order after the core result is reviewable:

1. Register the required Evidence, versioned financial Artifact, claims, report sections, and evidence-backed presentation cards. Draft card content only from verified results; do not use template labels, zeroes, or placeholders as report data.
2. For a bound run, checkpoint any material project-file changes and retain the real Project Git and Artifact Git references. If there was no material project change, record `no_material_change` without creating a commit.
3. Call `science_artifact(action="status", payload={"financeTaskContractId":"<exact runtime contract id>"})` once. Use its canonical `financeCompletionGuide.manifestAuthoring`; do not inspect application source or old sessions for the schema. Copy every complete finance-tool `.receipt` and platform-tool `.financeReceipt` object directly from the returned tool output. Never hand-transcribe, shorten, recompute, or repair `requestHash`, `attestation.value`, ids, or other receipt fields.
4. Build `deepscientist.finance.completion.v1` from the current run. `taskContract` contains only `id`, `version`, `contractHash`, and `routeSource`. An `unbound_read_only` gate also requires a non-empty `gateId`; a `bound_write` gate requires `workspaceStatusReceiptId` and `workspace`. `asOf` and `verifiedAt` are ISO-8601 datetime strings. `report` contains only `panelId`, `sectionIds`, and `cardIds`. Pass the manifest directly as `science_artifact.payload.financeCompletion`; `payload.report.financeCompletion`, `payload.completion`, Markdown, and hand-written receipt summaries are not accepted placements.
5. End every successful or reviewable partial run with exactly one `science_artifact(action="publish", displayIntent="open")`. Include the explicit report, `cardDrafts` or exact `cards`, and completion manifest in that call. Creating an Artifact alone is not terminal delivery. The publish gate rejects a reviewable Finance run when required report roles, result summary, limitations, or presentation card kinds are absent.

Do not publish a placeholder report when an early preflight failure leaves no reviewable data. For a monitor `no_change` run, update only operational state and preserve the last successful report. For an unbound read-only run, publish a reviewable report as `partial`, set `reproducible=false`, include the `unbound_read_only` gap, and never invent Project Git or Artifact Git references.

- `completed`: all always-required receipts and active conditional receipts are attested; required Artifact, Report roles/cards, Evidence, Project Git lineage, and Artifact Git lineage resolve; required result summary and limitations are present.
- `partial`: the result remains reviewable and every gap is one of the contract's allowed partial reasons or another explicitly enumerated missing optional output.
- `blocked`: the contract cannot resolve, a required capability or permission is absent, or the core workflow cannot execute.

The structured Science Report is the in-app report and is the default delivery surface. A Markdown/PDF project export is optional and never substitutes for terminal `science_artifact` publication. Use the exact call shape in `report-publication-example.md`.
