# Financial Report Publication Pattern

## What The User Receives

Use one run and one terminal publication to expose two complementary surfaces:

- The shared Science Report is the default, reader-first answer. It contains the conclusion, evidence, interpretation, limitations, and next action.
- The Financial Research Viewer is the drill-down surface for the same versioned financial Artifact. Report card previews and Artifact references open it; it is not a second report system.

Do not substitute a Viewer event, a Markdown file, or final chat prose for the Science Report. A project export under `reports/` is optional and may be created when the user explicitly asks for a file, but the structured report must still be published.

## Required Finish Sequence

After the selected specialist returns reviewable data:

1. Register every source used in a conclusion and retain the finance tool receipts.
2. Create or update the required versioned financial Artifact with `metadata.finance.kind`, `viewer.kind="financial_research"`, evidence ids, `asOf`, timezone, currency when relevant, and freshness/coverage metadata.
3. Create or update 1-3 answer-bearing claims and link non-hypothesis claims to registered Evidence or Artifacts.
4. Compose every report section role and card kind required by the runtime `financeCompletionGuide`. Review the finance envelopes' `reportSuggestions`, choose only the modules that help answer this question, and follow `financeCompletionGuide.cardAuthoring`. Give each card draft a compatible `moduleId`. The service inserts its `card_ref` into the module's default report section; an explicit matching `card_ref` is also allowed and is de-duplicated.
5. For a bound run, checkpoint material project-file changes now. Capture real Project Git and Artifact Git references; never synthesize them. Record `no_material_change` when appropriate.
6. Call `science_artifact(action="status", payload.financeTaskContractId)` once, then build the completion manifest from the returned guide and current receipts/refs.
7. Make exactly one terminal `science_artifact(action="publish", displayIntent="open")` call containing the explicit report, `cardDrafts` or exact `cards`, and `payload.financeCompletion`.
8. Keep the final chat response short. State the status and main limitation, then direct the user to the opened report instead of repeating it.

An early terminal preflight failure with no reviewable data gets one concise blocked response and no empty report. A monitor `no_change` run preserves the previous report. An unbound read-only run may create conversation-scoped Evidence, Artifacts, cards, and a report, but publishes as `partial` and non-reproducible with an `unbound_read_only` gap; it must not claim Project Git or Artifact Git lineage.

For `payload.financeCompletion`, copy whole receipt objects from finance output `.receipt` and platform output `.financeReceipt`; never reconstruct them from prose or copy their hashes character by character. Use the exact field shapes in `financeCompletionGuide.manifestAuthoring`. In particular, `taskContract` has no `specialist` or `sopReference`, `gate` cannot omit its shape-specific id, datetime fields are strings, and `report` is an id reference rather than the report body.

## Illustrative Market-Theme Publish

Use the exact values returned by tools and the status guide. This is a shape example, not a fixed market dashboard: change the sections, cards, visualizations, and count for the current question. Angle-bracket values below are placeholders, not data to copy.

```jsonc
{
  "action": "publish",
  "runId": "<same-run-id>",
  "target": { "kind": "report", "id": "report" },
  "displayIntent": "open",
  "payload": {
    "question": "<the user's market question>",
    "summary": "<one-sentence evidence-backed bottom line>",
    "status": "<completed-or-partial>",
    "report": {
      "title": "<market and as-of date> market theme report",
      "sections": [
        {
          "id": "market-status",
          "role": "market_status",
          "heading": "Market status",
          "blocks": [
            {
              "type": "paragraph",
              "text": "<breadth, session status, time window, and scope>",
              "evidenceIds": ["<market-evidence-id>"],
            },
          ],
        },
        {
          "id": "themes",
          "role": "themes",
          "heading": "Leading themes",
          "blocks": [
            { "type": "card_ref", "cardId": "<ranked-list-card-id>" },
            { "type": "artifact_embed", "artifactId": "<market-theme-artifact-id>" },
          ],
        },
        {
          "id": "evidence",
          "role": "evidence",
          "heading": "Evidence and counterevidence",
          "blocks": [{ "type": "card_ref", "cardId": "<evidence-list-card-id>" }],
        },
        {
          "id": "limitations",
          "role": "limitations",
          "heading": "Limits and next check",
          "blocks": [
            {
              "type": "checklist",
              "items": [
                {
                  "label": "<coverage or freshness limitation>",
                  "status": "<supported-partial-or-missing>",
                  "evidenceIds": ["<relevant-evidence-id>"],
                },
              ],
            },
          ],
        },
      ],
    },
    "cardDrafts": [
      {
        "id": "market-theme-ranking",
        "kind": "ranked_list",
        "moduleId": "market_theme_ranking",
        "title": "<evidence-backed title>",
        "view": "themes",
        "visualization": "ranked_list",
        "pageSize": 20,
        "evidenceIds": ["<registered-market-evidence-id>"],
        "items": [
          {
            "id": "<stable-item-id>",
            "rank": 1,
            "label": "<verified theme name>",
            "value": "<verified comparable value>",
            "detail": "<brief evidence-backed interpretation>",
            "evidenceIds": ["<registered-market-evidence-id>"],
          },
        ],
      },
      {
        "id": "market-evidence-timeline",
        "kind": "evidence_list",
        "moduleId": "provenance_and_limitations",
        "reportSectionRole": "evidence",
        "title": "<evidence and counterevidence title>",
        "view": "evidence",
        "visualization": "timeline",
        "evidenceIds": ["<registered-market-evidence-id>"],
      },
    ],
    "financeCompletion": "<full deepscientist.finance.completion.v1 from financeCompletionGuide>",
  },
}
```

The evidence-list draft may omit `items`; the server derives them from the listed registered Evidence. A table, ranking, or evidence list may contain more candidates when the guide allows it, but `pageSize` cannot exceed 20. Follow the runtime `visualizationDataContracts`: a treemap needs canonical label/change fields and an optional size field, `hbar_rank` needs finite comparable values, `donut` needs non-negative parts, `candlestick` needs date/open/close/low/high rows, `timeline` needs dated Evidence, and a timeseries needs real numeric points. When those fields are unavailable, choose the ordinary table, ranked list, evidence list, or prose block instead of fabricating display data.

For another contract, keep the publication shape but replace section roles, card kinds, Artifact kind, conditional receipts, and partial reasons with the exact values in its runtime guide. Never copy the market-theme roles into company, event, portfolio, holdings, monitoring, or factor reports.
