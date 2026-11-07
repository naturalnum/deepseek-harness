# Provenance, Permissions, And Compliance

## Permission Boundary

- Read-only market, company, event, and existing Artifact views require no research-write consent.
- Portfolio and watchlist writes require `finance_research_write`.
- Creating, modifying, pausing, or resuming a monitor requires `finance_monitor_schedule`.
- Cloud image processing requires `finance_cloud_image`; local structured rows and local parsing remain preferred.

Obtain consent only through structured `user_input`. Pass the runtime-issued `consentId`, `decisionToken`, `consentScope`, `confirmedAt`, `expiresAt`, and `confirmationHash` unchanged. The grant is short-lived and single-use. Missing, expired, mismatched, or replayed grants must return `permission_denied`.

## Provenance Boundary

Keep `asOf`, `retrievedAt`, timezone, currency, coverage, missing symbols, stale/partial state, upstream revision, content hash, source license reference, Evidence ids, Artifact refs, and attested tool receipts. Prefer primary filings and exchange data. Label derived relationships and simulated calculations as inference.

Project Git stores editable requests, policies, manifests, and reports. Artifact Git stores immutable evidence and structured snapshots. Keep raw licensed payloads, provider caches, credentials, logs containing secrets, and `private/` screenshots out of both. Reject symlink escape and oversized inline results.

## Communication Boundary

Use “research simulation”, never “account”, “holding execution”, “real return”, or “trade” for simulated portfolios. Do not present correlation as causality or output as investment advice. Real trading, broker access, shell, arbitrary code execution, provider-owned agent loops, memory, dashboards, gateways, and schedulers are outside this skill.
