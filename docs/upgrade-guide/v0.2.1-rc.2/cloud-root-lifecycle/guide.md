---
kind: upgrade-guide
description: "Cloud Root configuration errors fail application startup and unrecoverable single-instance exclusion failure exits with status 1."
---

# Configure Cloud Root failure handling

English | [中文](guide.zh.md)

## Change

Runtime and authentication Root configuration reject unknown nested fields instead of retaining misspelled or obsolete keys. Invalid types, ranges and conflicting budgets report field paths without supplied values. Both Root plugins declare native `startupRequired`, so configuration and activation failures prevent successful application startup independently of deployment entry ids.

With `singleInstance: true` outside maintenance recovery, confirmed lock contention or five exhausted connection attempts now starts the original Root drain and requests native launcher exit status 1. Temporary reconnection retains Contexts and owner epochs. Unknown account or sandbox closure retains responsibility and quarantine; database lock loss does not itself terminate a sandbox.

## Migration

1. Check Runtime/Auth Root rows in the deployed profile's `cordis.patch.yml` and overlays against their current schemas. Remove unknown keys and correct the reported types, ranges and conflicting budgets. Keep secret values in the formal credentials provider.
2. Start through the native `dsh --profile <name>` launcher. Verify invalid configuration exits nonzero without readiness, and a valid deployment reaches its normal readiness checks.
3. Configure the existing process supervisor to observe failure exit status. After a terminal single-instance failure, inspect retained owner, quarantine and cleanup evidence before restarting; do not clear records to make startup pass. Keep this mode limited to one application Root per metadata database.
