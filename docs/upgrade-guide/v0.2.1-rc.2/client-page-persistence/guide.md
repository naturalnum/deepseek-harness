---
kind: upgrade-guide
description: "Custom Client store wrappers and injected Conversation or schedule props must forward page persistence."
---

# Forward Client page persistence

English | [中文](guide.zh.md)

## Change

Native stores and direct cache helpers accept a captured `ClientPersistence` from `@deepseek-ai/dsh-client-store`. `StoreHandle.create` receives an optional second argument. Custom wrappers that drop it can access ordinary origin storage instead of their page's namespace. Conversation Factory injections now include transcript-width callbacks; schedule detail injections include recent-time-zone callbacks. Ordinary application callers can continue without options.

## Migration

1. Forward `create(scopeKey, persistence)` to the wrapped handle and use the same port for custom reads, writes, deletion and enumeration. See the [store reference](../../../../packages/client/store/README.md#page-persistence).
2. Update custom Conversation injection implementations with `readContentWidth` and `writeContentWidth`, and schedule detail injections with `loadRecentTimeZones` and `rememberTimeZone`. Factory local components receive their inherited injection fields through the renderer.
3. For an isolated cloud page, construct `AppWebEntry` with `{ persistence: port, requirePersistence: true }`. Capture account/generation once, revoke before stopping and joining the native graph, then clear only the retired namespace. Do not import old unpartitioned origin cache.
4. Verify an absent required port rejects before module activation, a same-account/same-generation refresh restores its cache, another account/generation restores none of it, and callbacks released after revocation cannot write or delete persisted state. The [Cloud page owner](../../../../packages/cloud/pe-cloud-client/README.md#understand-the-implementation) documents limits and cleanup failures.
