---
description: "Validate cloud browser limits and inspect captured native carriers without starting an unbound client."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-client

English | [中文](README.zh.md)

## Summary

You can validate public bootstrap limits and use package-local tests to check fixed account bindings across HTTP, WebSocket, and navigation requests. Cancellation and late responses remain distinguishable from confirmed cleanup. The browser entry rejects activation while bootstrap decoding, native startup, and account cache partitioning are disconnected, so this package does not yet provide a working login or conversation.

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

Use the configuration validator and package-local tests to inspect carrier behavior during cloud integration. The `/client` Loader entry validates its limits, then rejects activation because the canonical access bootstrap decoder, pre-Cordis application startup, and account cache partitioning are not connected. It opens no socket, mounts no session page, and publishes no ready service.

### Minimal configuration

No working browser mount is available: even valid configuration reaches the explicit assembly rejection. Keep this entry out of a ready browser recipe until those adapters are connected. Every field below is required, with no production default; the [configuration schema](src/config.ts) owns the accepted limits.

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

<details>
<summary>Implementation internals — click to expand</summary>

The internal bootstrap attempt performs one same-origin, document-relative GET with no automatic retry. Its caller supplies the owner's decoder; this package defines no replacement bootstrap DTO. The result rejects on cancellation or deadline while `settled` tracks actual fetch/body completion and `cleanup` separately records confirmation or uncertainty. Late bytes cannot invoke the decoder. Responses have an explicit byte limit.

The internal native transport captures the access package's `RequestExpectation` and `BindingFieldNames`. It preserves native RPC bodies and correlation, adds dedicated headers to HTTP, and adds dedicated query fields to native WS and navigation URLs. Conflicting expectations, external origins, and requests outside the app mount are rejected before sending. HTTP 401 and `cloud/stale-generation` invalidate the captured lifetime; other 409 responses retain their bytes for native handling. It never replaces a request's expectations or replays a mutation.

Closing rejects new operations immediately, aborts pending fetches, and requests socket closure. Missing acknowledgement produces `unconfirmed`; pending work remains tracked and can later establish actual closure. This is carrier cleanup, not proof of Agent cancellation or account drain. Limits bound pending header fetches, sockets, bootstrap bytes and inspected error bytes; successful response-body and native subscription lifetimes remain with the native application.

| Source | Role |
|---|---|
| [Browser entry](src/client/index.ts) | Rejects incomplete client assembly. |
| [Bootstrap attempt](src/client/bootstrap.ts) | Tracks result, settlement, and cleanup separately. |
| [Captured carrier](src/client/transport.ts) | Adds access expectations around native carriers. |
| [Behavior tests](tests/transport.spec.ts) | Exercise native Connection envelopes and lifetime rejection. |

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

These gaps prevent the internal carriers from providing a ready browser application.

- Access has no canonical bootstrap DTO/decoder or generation issuer yet. The internal decoder callback is a local test/composition input, not a public wire protocol or production integration.
- Native startup must install captured carriers before Gateway construction. No global fetch/Storage patch, new mux, session UI, login form, or account-ready state is implemented.
- Account/generation partitioning of native drafts, selection, direct localStorage helpers, resources, upload Worker, and downloads requires coordinated public adapters. Those capabilities remain unopened.
- A native application must dispose its effects and response consumers after carrier invalidation. This increment does not assert complete native application shutdown, browser composition coverage, or S1/S2 acceptance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The cloud client consumes the existing access binding types through the package's `/types` export. Root source aliases, compiler aggregates, lockfile registration, public bootstrap fields, and build artifacts are coordinated outside this package.

</details>
