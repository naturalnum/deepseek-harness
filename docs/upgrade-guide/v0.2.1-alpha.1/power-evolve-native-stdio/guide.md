---
kind: upgrade-guide
description: "PowerEvolve Cloud STDIO requires the native physical provider and its SDK worker image."
---

# PowerEvolve STDIO uses native execution

English | [中文](guide.zh.md)

## Change

Cloud STDIO no longer starts through the account-wide writable mount slot. A configured Cloud execution or STDIO deployment requires `nativeExecutionConfigFile`; missing native execution configuration rejects Platform startup. Each approved action runs once in an independently owned native Pod. The adjacent cloud database migration retains existing records and adds independent service and preparation identities.

## Migration

1. Stop the original Profiles normally, reconcile every active or uncertain old execution, and retain a matching backup with that release's backup tool.
2. Build the native payload from the matching release so it contains `native-stdio-worker.mjs`, and pin that image's registry digest in both native execution and STDIO deployment settings. Keep the runtime image identity mapping exact.
3. Supply the private `nativeExecutionConfigFile`, preserving owned storage, namespace, resource limits and native permissions. Let Platform apply the adjacent database migration; do not edit version markers or overwrite earlier SQL assets.
4. Start the matching Profiles and perform a new explicit STDIO check and approval. Verify two same-account Sessions use different Pods and cancelling one retains the other's UID. Existing approvals or uncertain effects never authorize a replacement invocation. See the [application reference](../../../../products/power-evolve/application/README.md).
