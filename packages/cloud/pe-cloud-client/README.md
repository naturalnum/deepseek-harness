---
description: "Validate cloud browser limits and inspect captured native carriers without starting an unbound client."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-client

English | [中文](README.zh.md)

## Summary

Prepare one Cloud page from a bounded canonical bootstrap response before starting the native `AppWebEntry`. The `/client` Loader entry consumes that exact prepared owner and installs the existing native Connection with captured account/generation carriers. Missing or stale preparation fails closed. This package does not implement a login form or prove backend account readiness.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `/schema` export provides browser-safe public configuration validation; `/types` contains its configuration types. The Host entry only declares the browser package.

### When to choose it

Import this public `/client` namespace from the original native module table, then use `PreparedCloudPage.prepare(input, signal)` before Cordis activation. Its `ready` promise yields a decoded page owner after the bootstrap request settles; it does not certify a server account graph. Construct `AppWebEntry(container, { ...page.nativeOptions, modules })` with that same table and await `page.start(entry)`; do not call the bootstrap facade's `create()` twice. Retain the preparation and await `preparation.dispose()` before replacing the page. Only the Cloud `/client` entry installs Connection; the Host declares the original Connection module with `registerClientPackages(..., { activate: false })` so its ordinary plugin is not activated.

### Minimal configuration

The native browser Loader creates entries with `{ name }` and no per-entry configuration, so `/client` accepts empty configuration and rejects overrides. Supply every field below in the preparation input's `config`; `/schema` owns validation and supplies no production defaults. Preparation additionally requires explicit `decodeLimits`, `persistenceLimits`, binding field names, real storage, fetch and WebSocket factories. No native cache read or Connection is admitted before the prepared owner is bound by `prepareContext`.

| Field | Default | Meaning |
|---|---|---|
| `bootstrapPath` | required | Document-relative static bootstrap route, without query or fragment. |
| `bootstrapTimeoutMs` | required | Result deadline; actual request cleanup remains tracked separately. |
| `maxBootstrapResponseBytes` | required | Maximum bootstrap response bytes consumed before decoding. |
| `maxErrorResponseBytes` | required | Maximum inspected HTTP 409 response bytes. |
| `maxPendingFetches` | required | Maximum fetches waiting for headers or owned error-body handling. |
| `maxSockets` | required | Maximum sockets owned by one captured carrier. |
| `closeTimeoutMs` | required | Close-observation deadline; expiry does not confirm cleanup. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The package keeps bootstrap request outcomes and native carrier lifetimes separate from authoritative account and Session state.

`/client` exports `PreparedCloudPage` for the pre-Cordis owner, plus the existing `CloudPageLifetime` and `CloudPagePersistence` components it reuses. Preparation calls access's canonical `decodeCloudBootstrap`, creates exactly one fixed lifetime and cache port, and exposes native options containing the required port, pre-activation owner binding and synchronous pre-disposal storage and carrier admission revocation. The real Loader `apply` verifies that owner before invoking public `installConnection` with captured hooks; it never writes a global current account or global transport.

The cache accepts finite positive safe-integer `maxKeys`, `maxKeyBytes`, `maxValueBytes`, `maxTotalBytes`, and `maxNamespaceBytes`. Byte budgets use UTF-8; total includes the physical namespace key and serialized envelope. Keys are logical and enumeration exposes only that namespace. Account/generation tuples use JSON encoding without delimiter collisions. No legacy unpartitioned cache is restored. Each mutation atomically replaces one bounded envelope; concurrent same-account/same-generation pages use last-writer-wins whole snapshots and may lose independent updates. Revocation is local to the issued port; it makes no cross-tab global-revocation claim.

`dispose()` synchronously revokes the old port, stops the captured carrier and native graph, joins their actual cleanup, then removes and verifies only the old namespace. Automatic 401/stale-generation closure and cache failure enter the same sequence. Late native subscriptions cannot write or delete through a revoked port. A failed stop leaves the namespace uncleared; a failed removal remains unconfirmed. A hung native disposer remains pending. Cleanup errors remain observable through the returned promise, page/cache snapshots and default-enabled console reporting. Same account/generation refresh restores its own cache; a different generation receives another namespace.

<details>
<summary>Implementation internals — click to expand</summary>

The internal bootstrap attempt performs one same-origin, document-relative GET with no automatic retry. Its caller supplies the owner's decoder; this package defines no replacement bootstrap DTO. The result rejects on cancellation or deadline while `settled` tracks actual fetch/body completion and `cleanup` separately records confirmation or uncertainty. Late bytes cannot invoke the decoder. Responses have an explicit byte limit.

The internal native transport captures the access package's `RequestExpectation` and `BindingFieldNames`. It preserves native RPC bodies and correlation, adds dedicated headers to HTTP, and adds dedicated query fields to native WS and navigation URLs. Conflicting expectations, external origins, and requests outside the app mount are rejected before sending. HTTP 401 and `cloud/stale-generation` invalidate the captured lifetime; other 409 responses retain their bytes for native handling. It never replaces a request's expectations or replays a mutation.

Closing rejects new operations immediately, aborts pending fetches, and requests socket closure. Missing acknowledgement produces `unconfirmed`; pending work remains tracked and can later establish actual closure. This is carrier cleanup, not proof of Agent cancellation or account drain. Limits bound pending header fetches, sockets, bootstrap bytes and inspected error bytes; successful response-body and native subscription lifetimes remain with the native application.

A fetch body already errored by the exact captured abort reason is settled without source cancellation. A source cancellation rejection still leaves cleanup unconfirmed, even if it returns that same reason. The distinction uses the original reader’s closed/errored completion and retains actual cancellation work.

| Source | Role |
|---|---|
| [Browser entry](src/client/index.ts) | Consumes the prepared owner and installs original Connection. |
| [Bootstrap attempt](src/client/bootstrap.ts) | Tracks result, settlement, and cleanup separately. |
| [Captured carrier](src/client/transport.ts) | Adds access expectations around native carriers. |
| [Behavior tests](tests/transport.client.spec.ts) | Exercise native Connection envelopes and lifetime rejection. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these owners for the account checks and native browser behavior this package consumes.

- [Cloud access](../pe-cloud-access/README.md) — request expectation and authentication ownership.
- [Native Connection](../../client/connection/README.md) — native HTTP/WS carriers and connection generations.
- [Web Client architecture](../../../docs/subsystems/web-client.md) — native application boot and state ownership.

-----

<a id="model-experience"></a>
## Model Experience

### Browser transport without model context

#### What the model sees

Nothing from this package. `/client` registers no prompt or tool, and `BoundTransport` adds consistency values only to HTTP headers or WS/navigation query fields while leaving the native RPC body unchanged.

#### Token effect

Zero direct tokens. Bootstrap validation, binding capture, and carrier cleanup add no system text, tool declarations, retained Session content, or independent model request.

#### KV Cache effect

The package appends or replaces no model-request tokens and issues no independent model request. It adds no prefix-changing content; model composition and provider cache availability or reuse remain outside this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits remain outside local bootstrap and native-entry wiring.

- The canonical decoder validates metadata, not authentication, generation issuance or actual provider availability. Root must serve bootstrap only after its real authenticated account admission.
- The native Web kernel must await `prepareContext` before `bootClient`. Missing owner, wrong port, duplicate Connection provider and stale page lifetimes reject; lexical plugin order grants no preparation authority.
- Resources, upload Worker and downloads still require coordinated admission through the same binding. This package adds no independent mux or replacement Session UI, and does not publish complete Web acceptance.
- Production browser composition and S1/S2 acceptance require independent integration evidence. Component cleanup and cache tests do not establish full account admission or server drain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The cloud client consumes the existing access binding types through the package's `/types` export. Root source aliases, compiler aggregates, lockfile registration, public bootstrap fields, and build artifacts are coordinated outside this package.

</details>
