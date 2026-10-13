---
kind: upgrade-guide
description: "PowerEvolve cloud Profiles require a private retained-intent key and advance the product database to schema 6."
---
# PowerEvolve retained-intent configuration

English | [中文](guide.zh.md)

## Change

PowerEvolve Platform Profiles now require `nativeIntentKeyFile`. The cloud-native database advances from schema 5 to schema 6 through an adjacent migration that preserves existing data. The key protects original mutation requests, including operation and Writer credentials, in the shared Platform journal. Host needs no copy of this key. Current product defaults preinstall only `builtin.pdf`; other existing Skill assets and history remain preserved.

This change affects the private PowerEvolve product Profiles, not ordinary upstream DSH Profiles. Previous product binaries do not accept schema 6.

Native publication, input and turn mutations now use `/runtime/native-intents/prepare` followed by `/runtime/native-intents/execute`. The eight previous direct mutation routes return HTTP 410 with `native_retained_protocol_required`. Upgrade Host and Platform together. Worker-authenticated reconciliation scans original requests across Host identities; it returns tokenless outcomes and never grants an old operation. A cold worker may clear a committed request only after the original operation cannot return and no Session Writer is live. Host's `nativeIntentReconcileLimit` bounds each maintenance scan, and `nativeIntentMaxLocalReceipts` bounds pending local acknowledgement tracking.

## Migration

1. Back up the stopped previous product deployment with its matching backup tool, retaining PostgreSQL and all configured private storage roots. Stop its Host and Platform Profiles before starting the new version.
2. Create a Platform-private file containing a randomly generated 32-byte key in canonical unpadded base64url encoding. Restrict it to the Platform account. Set the `power-evolve-platform` row's `nativeIntentKeyFile` to that absolute path. The shipped patch uses `PE_NATIVE_INTENT_KEY_FILE`, or `PE_PRIVATE_DIR/native-intent-key`. Preserve its exact bytes in private configuration backups and restores.
3. Render the new [named Profiles](../../../../products/power-evolve/deploy/README.md#profile-lifecycle). Configure `enabledBuiltinSkills` and `preinstalledSkills` as `['builtin.pdf']` for the current migration scope. The `nativeIntentMaxRequestBytes`, `nativeIntentMaxPendingPerSession`, `nativeIntentMaxRecordsPerSession` and `nativeIntentMaxRetainedBytesPerSession` settings define deployment limits; exceeding a limit refuses new retention.
4. Start Platform with its ordinary deployment role, then Host. Check the actual schema version, readiness and original data before new work. Validate retained-request recovery using the same application artifact. Readiness alone does not prove recovery or business acceptance.
5. Use the matching schema 6 backup tool thereafter. Its required `nativeIntentKeyFile` must identify the actual key inside the selected `privateConfig` root; restore verifies the original relative path and exact bytes. To roll back, restore the stopped previous backup into an isolated target and launch its matching version; do not point an old binary at the upgraded database.
