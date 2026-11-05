# Holdings Screenshot Diagnosis

## Contract

- Contract: `finance.holdings-diagnosis.v1`
- Artifact: `holdings_diagnosis`
- Required capabilities: `finance.holdings.parse`, `finance.security.read`

## Inputs And Workflow

Ask the user to redact names, account identifiers, total assets, and other identity data. Use `user_input` once to select local or cloud processing and resolve low-confidence rows. Prefer structured rows or local processing. Cloud processing requires separate `finance_cloud_image` consent.

After consent, call `finance_holdings_parse`, then `finance_security_snapshot`; call `finance_price_series` only when making a price-based claim, and finish with `science_artifact`. Preserve per-row confidence, unrecognized rows, redaction status, ticker, market, instrument type, currency, and provided quantity, cost, or weight.

## Report And Decisions

Treat `provider_error`, timeout, and `retry_exhausted` as explicit partial reasons after the adapter retry budget. Continue independent evidence paths and publish a clearly limited partial report when reviewable evidence remains; block only when no reviewable route remains.

Publish `holdings`, `exposure`, `risks`, `data_gaps`, and `limitations` with `data_table`, `metric_strip`, `ranked_list`, and `evidence_list` cards. Show concentration, duplicate exposure, market/currency/theme exposure, risk scenarios, and unresolved data.

Use gates `image_processing_scope` and `low_confidence_rows`. Accept `low_confidence_rows`, `unresolved_symbols`, or `price_series_unavailable` as partial reasons. Never place the original image or sensitive content in Git, reports, logs, telemetry, or exports. Stop as `blocked` when safe parsing is not authorized.
