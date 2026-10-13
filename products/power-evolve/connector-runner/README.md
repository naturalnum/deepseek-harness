---
description: "Validate frozen STDIO start packets and execute bounded MCP calls inside an isolated cloud worker."
kind: package-library
---
# Isolated Connector Runner

English | [中文](README.zh.md)

## Summary

Callers can validate frozen STDIO start packets, fingerprint complete catalogs and execute one bounded MCP discovery or call inside an isolated cloud worker. The worker owner supplies approval, current writer authorization, exact execution identity and cleanup evidence. Platform retains credentials and durable operation state. This library does not permit the shared Host to start user programs or turn an uncertain outcome into a retry.

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

The [package exports](package.json) separate the SDK provider, dispatch validation, runtime ownership and digest helpers. The [Sandbox Runner](../sandbox/README.md) loads the cloud library inside its private image. It supplies the configured token, isolated filesystem and process identity; the shared Host must not execute the SDK provider. The library registers no Profile plugin or mount configuration.

Contracts is a matching `workspace:~` peer and development dependency. Host and Platform explicitly provide Contracts, this library and pinned Zod in their production manifests. A standalone worker installation must provide the same complete closure itself, with peer auto-install disabled and observed ESM paths and identities checked. A successful workspace source test does not certify a production image.

`runStdioV2` accepts a literal program, argument array, absolute cwd, complete frozen catalog and JSON arguments. Options supply every budget, an exact `HOME`/`PATH`/`LANG` environment and the synchronous catalog validation/fingerprint callback. No ambient environment is merged; Node on macOS may add its own encoding hint. `current` retains an already isolated UID/GID; `unix` supplies the validated identity to spawn. The cloud runtime requires Unix 1000/1000.

The executor owns approval, immutable program/image pins, directory authorization, prepare/permit and durable request identity. The dispatch and runtime leaves validate original packets, reserve one writer and bound the complete response; they authenticate no HTTP caller and store no Platform state. Starting a program may itself have effects. Calling `start` synchronously reserves the writer before yielding to provider work. An identical repeated start returns the retained view. Cancellation waits for the owned job and its independent cleanup confirmation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Protocol validation and execution ownership</summary>

The [SDK provider](src/stdio-v2.ts) uses the public SDK2 Client and explicit `legacy` negotiation for one initialize handshake. Its Transport starts one child with `shell:false`, reuses public framing and message validators, checks strict UTF-8 JSONRPC and measures raw protocol bytes. Unsupported versions refuse without a second process, reconnect or retry. Discovery reads all pages; a call compares the entire frozen catalog before exactly one `tools/call`.

Raw schemas, metadata, annotations, content, structured content, `isError`, extensions and escaped NUL remain JSON. `readOnlyHint` grants no approval; `isError:true` is a completed RPC whose tool outcome belongs to the outer owner. The [digest leaf](src/stdio-v2-digest.ts) hashes complete original JSON in distinct operation domains through the shared codec and starts no process. The approval HMAC retains the Platform-owned 32-byte key; executors never receive it.

Lost replies, cancellation, directory changes and budget failures retain conservative effect and call facts; they never publish a truncated successful result. Cleanup waits independently for configured stdin, TERM and KILL deadlines and records actual child `exit` and `close` events. Missing close retains `cleanupConfirmed:false`. SDK close or direct-child exit does not retire descendants, a container, the writer or its directory lease; the outer stop protocol must confirm them.

The existing [HTTP helpers](src/server.ts) retain one-call bounded SSH and fixed read-only `whoami` behavior. A changed `instanceId` preserves uncertainty; an execute failure after `exec` begins retains `effectMayHaveOccurred:true`, including missing exit evidence. Request bodies are capped at 256 KiB, SSH output at 128 KiB/60 seconds and fixed STDIO text at 8 KiB/30 seconds. Their [egress readiness](src/egress.ts) needs three denied probes; a refused arbitrary port is inconclusive without an independently healthy control listener. These helpers are separate from the generic STDIO library and do not establish deployment isolation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Wire validation](../contracts/README.md) — shared protocol values and consumer obligations.
- [Sandbox Runner](../sandbox/README.md) — image, writer ownership and cleanup.
- [Trusted application](../application/README.md) — approval and durable state.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the authorized executor and Platform adapters that interpret bounded MCP results. The library adds no model prompt, tool or native Session event; those consumers own presentation and logging.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Callers must satisfy the execution and installation requirements:

- Approval, container/UID cleanup, durable recovery and current writer authorization belong to the executor and Platform.
- Unknown effects must be reconciled; direct-child cleanup cannot authorize replay.
- Contracts/Zod peers and source fixtures do not certify a packed worker dependency graph or browser singleton.
- File transfer, PTY, port forwarding and Host-local execution require separately authorized capabilities.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

Run source behavior tests through the cloud-only entry; source imports and freshly built production artifacts have separate acceptance paths. Current package, worker and installation evidence belongs in migration records.

</details>
