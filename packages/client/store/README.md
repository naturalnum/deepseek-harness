---
description: "Observable browser state stores with explicit snapshots, subscriptions, and lifecycle ownership."
kind: "package-library"
---
# @deepseek-ai/dsh-client-store

English | [中文](README.zh.md)

## Summary

React-free observable and snapshot-store primitives shared by Client controllers and renderer adapters. The package owns synchronous and animation-frame publication, Immer-backed updates, shallow equality, and optional browser persistence; React hook construction remains in `@deepseek-ai/dsh-client-ui-renderer`. Use it when Client state must publish stable snapshots without depending on React.

## Table of Contents

- [Page persistence](#page-persistence)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="page-persistence"></a>
## Page persistence

`ClientPersistence` owns logical `getItem`, `setItem`, `removeItem`, and `keys` operations. Pass the captured page port as `createSnapshotStore(init, { persist: { name, storage: port } })` or `handle.create(scopeKey, port)`. Custom handle wrappers forward the second argument. The renderer captures `ctx.get('clientPersistence')` before creating stores; direct readers and inventory discovery use the same dependency. Ports never change logical keys or Session identities.

Omitting the dependency retains ordinary browser-local storage; absent storage is empty and ordinary I/O failures are logged without failing stores. Explicit port failures propagate, except that observer dispatchers contain and log subscriber exceptions. A persisted write may fail after its in-memory snapshot changes; the explicit port's owner must seal and stop dependent UI. Clearing a value does not unsubscribe a store or revoke its authority to write again.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package provides browser-side state primitives and registers nothing model-facing.

#### KV Cache effect

None; the stores neither assemble nor send model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Persistence is browser-local** — persisted stores use JSON through their captured port; ordinary callers use `localStorage` and non-browser callers have no default persistence. The package provides no cross-device synchronization.
- **Web-shell build input** — the static ESM retains third-party imports for Vite; independent consumers supply its development dependencies ([dependency rules](../AGENTS.md#dependency-declaration)).


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
