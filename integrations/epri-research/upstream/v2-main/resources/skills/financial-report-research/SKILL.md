---
name: financial-report-research
description: Produce evidence-grounded financial reports for company, market, industry, event, portfolio, holdings, news, and simulation questions. Use in Financial Report Mode when the requested outcome is an explanatory report rather than factor discovery, factor evolution, or external trading.
---

# Financial Report Research

Treat the runtime Finance Task Contract as authoritative. Use `ds-financial` for contract, provider, project, and completion rules; use `market-data-research` only when the selected contract requires managed market data.

Read `../report-authoring/SKILL.md` first for the shared reader-first writing and visual defaults. For a comprehensive or multi-turn note, also read `../report-authoring/references/deep-research-sop.md`. Then read [references/vibe-trading-research-sop.md](references/vibe-trading-research-sop.md) progressively. Use sections 1-3 for routing, evidence, progress, and rendering performance; section 4 for multi-step goals; section 5 for failed calculations or backtests; sections 6-7 for report, valuation, and risk modules; and section 8 for the research-only boundary. Treat all listed methods as recommendations constrained by the selected Finance Task Contract and available runtime tools.

## Workflow

1. Freeze the question, market, timezone, currency, `asOf`, reporting window, and permitted data sources.
2. Separate reported facts, calculations, inference, scenarios, counterevidence, stale data, missing data, and market closure.
3. Retrieve the smallest sufficient evidence set. Prefer filings, exchange or regulator data, official company material, and primary market data over commentary.
4. Reconcile units, dates, corporate actions, symbol identity, and field semantics before calculating or comparing values.
5. Analyze the requested company, theme, event, portfolio, or market question. Do not silently convert it into factor mining.
6. Author the report as a financial research note, not a tool transcript: answer the user's question first, then scope/asOf, key numbers and lead visual, drivers, scenarios/risks, next actions, and sources/method. Do not lead with a source list, raw JSON, or a generic “evidence” heading when the user asked for an explanation.
   For Chinese readers, use the optional Chinese broker-note path in `../report-authoring/references/report-templates.md`: a concise front-page answer and investment points, followed by industry/company drivers, supported forecasts or valuation, scenarios/sensitivity, risks, disclaimer, and sources. Omit sections that lack material evidence; this is a communication convention, not a requirement to invent a rating or target price.
7. Before publication, make one explicit visual delivery decision. If verified structured values support comparison, trend, distribution, interval, exposure, or scenarios, create one lead chart and use two to four total chart/card views only when they answer distinct reader questions. Put visuals before long evidence and risk detail, and add a one-sentence interpretation below each. If no meaningful visual data exists, pass the concrete reason only as `payload.internalVisualWaiverReason`. This is private validation metadata: never put it in report prose, cards, limitations, data gaps, evidence, or the final reply. Never manufacture points.
8. Treat the structured Science Report as the default terminal deliverable. Whenever any reviewable answer, evidence, calculation, or visual exists, publish exactly one report after the evidence and visual decision are stable. An allowed provider failure changes it to a clearly labelled Partial Report; it does not remove the report. Only a terminal preflight with no reviewable output may finish without publication. Reuse the standard report and chart viewers.
9. Open the published report as the primary preview. Keep files, Git history, and supporting evidence as secondary inspection paths.
10. Keep the first viewport decision-oriented: show the current conclusion or blocker, the lead visual or one compact metric strip, and the newest material update. Update stable cards in place, collapse old progress, and lazy-load large tables, charts, and provenance so long-running reports remain responsive.
11. If publish returns `publicationGap.code="finance_publication_gap"` with `repairable=true`, repair the listed report/card/receipt gap once and republish. If it remains partial or is not repairable, keep the useful Partial Report and stop; never enter a publication retry loop.

## Report Contract

Read [references/report-sop.md](references/report-sop.md) before publication. Also follow the publication and module references in `../ds-financial/references/` when the selected contract requests those modules.

## Boundaries

- Never place orders, change holdings, or claim that a simulation is executable advice.
- Never invent missing market values, citations, identifiers, or report receipts.
- Do not load `financial-factor-discovery`, `factor_search`, or `factor_registry` in this mode.
- If Team Mode is manually enabled, the injected Team role contract owns dispatch and integration. This Skill does not define a second Team protocol.
