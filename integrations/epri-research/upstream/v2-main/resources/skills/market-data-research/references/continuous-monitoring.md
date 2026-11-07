# Continuous Monitoring

## Contract

- Contract: `finance.monitor.v1`
- Artifact: `monitor`
- Required capabilities: `finance.monitor.read`, `cron`

## Inputs And Workflow

Define market scope, timezone, schedule, thresholds, incremental cursor, content hash, stale threshold, notification target, and the underlying read-only finance contract. Use the existing `cron` tool and the read-only `finance_*` tools required by that contract; do not start another scheduler. Publish or update the stable monitor through `science_artifact`.

Distinguish `market_closed`, `no_change`, stale data, provider failure, retry exhaustion, and a material change. Deduplicate by cursor, content hash, run id, and provider revision. A no-change run updates operational state only: do not publish a new research conclusion, Artifact version, Report, or Git commit.

## Report And Decisions

On material change, publish `policy`, `latest_changes`, `runs`, and `errors` with `metric_strip` and `ranked_list` cards, plus explicit limitations. Keep the stable monitor id, version chain, last success, next run, change count, stale state, retry state, and Report link. Notifications contain only a change summary and DeepScientist Report link.

Require `create_monitor`, `modify_monitor`, `pause_monitor`, or `resume_monitor` with a matching `finance_monitor_schedule` consent grant. Accept `market_closed`, `no_change`, `provider_error`, timeout, or `retry_exhausted` as partial reasons. Preserve the last successful Artifact when blocked.
