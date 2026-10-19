---
description: "Validate cloud request bindings and use database-backed Better Auth authentication without opening incomplete root admission."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-access

English | [中文](README.zh.md)

## Summary

Validate fixed-origin deployment inputs and reject stale account/generation expectations before native business work. `BetterAuthAccess` delegates authentication to pinned Better Auth and PostgreSQL, returning identity only from verified user/session rows. The `/root` Loader entry owns authentication resources through `peAuth`; optional ingress registers on the existing shared Web service. The actual Root seal and current account publication gate every request independently of authentication initialization.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use the browser-safe `/schema` for structural `AccessConfigSchema`, request-expectation checks and the unique `decodeCloudBootstrap` decoder; C-11 wire types live at `/types`. Full Host configuration parsing remains internal to authentication/root. The package entry and `/root` expose the root Loader plugin, `PeAuthService` and `AuthAccessError`. `BetterAuthAccess` is an internal implementation for same-package root assembly, without an additional SDK subpath. `AuthenticatedPrincipal.accountId` directly uses runtime's `AccountId` type.

### Configuration

All configuration is explicit; examples do not supply production defaults. Browser structural inputs live in [config-schema.ts](src/config-schema.ts); [config.ts](src/config.ts) retains full Host policy with unchanged Node IP semantics. Root requires [root-config.ts](src/root-config.ts), official `credentials` and an already deployed Better Auth schema. Omitting `ingress` retains resource-only initialization; configuring it requires the Loader entry's `inject` to include `webServer`, `peAccountRuntime` and `peExposure`, so these actual providers are active at schema inspection. Missing providers fail initialization. Configuration alone grants no business admission.

| Fields | Requirement |
| --- | --- |
| `publicOrigin`, `deploymentMode` | Canonical HTTPS origin; HTTP only for development loopback. |
| `trustedProxyAddresses`, `authSecretRef` | Exact proxy IPs, with an empty list trusting none; a secret reference resolved by root. |
| `sessionRecheckMs`, `authCheckTimeoutMs` | Positive finite timer delays. |
| `maxPeers`, `maxPeersPerAccount` | Positive finite limits; per-account limit cannot exceed global limit. |
| `maxPeerWaiters`, `maxPeerWaitersPerAccount` | Global/account creation waiters; abandonment removes each waiting record immediately. |
| `maxPeerCarriers`, `maxPeerCarriersPerAccount`, `maxPeerCarriersPerLogin` | Finite actual HTTP/upgrade operations and live WS sockets; child limits cannot exceed parent limits. |
| `peerCloseTimeoutMs` | Native cleanup wait/diagnostic deadline; timeout retains actual cleanup and reservations. |
| `maxAuthOperations` | Maximum actual auth operations; excess work is rejected, with no waiting queue. |
| `maxTrackedLogins`, `maxTrackedLoginsPerAccount` | Finite verified-login state limits, including invalidation state retained for older reads. |
| `maxAuthInvalidations` | Finite invalidation records for uncached login ids; reserve before database deletion. |
| `bindingFields` | Distinct dedicated account/generation header and query names, pending product transport review. |
| `database` | Explicit `host`, `port`, `user`, `database`, `passwordRef`, `ssl`; SSL verifies the server certificate with system trust. |
| `pool` | Explicit positive `maxConnections`, `connectionTimeoutMs`, `statementTimeoutMs`, `lockTimeoutMs`, `idleTimeoutMs`, `idleTransactionTimeoutMs`, `maxLifetimeSeconds`; lock timeout cannot exceed statement timeout. |
| `startupTimeoutMs`, `secretResolveTimeoutMs`, `maxSecretOperations`, `maxSecretBytes` | Finite startup/secret waits and actual-read capacity; byte cap is at least 32 and applies to each secret, including UTF-8. |
| Optional `disableSignUp` | Delegates to pinned Better Auth; omission preserves sign-up compatibility, while the first trial explicitly sets `true`. |
| Optional `ingress` | Requires positive finite `maxOperations`, `maxOperationsPerAccount`, `requestTimeoutMs`, `maxAuthRequestBodyBytes`, `maxRequestBodyBytes`, `maxBootstrapResponseBytes`, `maxGenerationBindings`, `maxFrameBytes`, `maxLogicalStreams`, `maxLogicalStreamsPerAccount`, `maxLogicalStreamsPerPeer`; child capacities cannot exceed parents. Presence grants no readiness. |

`peAuth` resolves the authentication secret through `ctx.credentials` and resolves the password again for each physical pool connection. References use the official credential-reference grammar; root reads no environment variables or default connection. The pool pins its schema to `public`; server statement/lock/idle-transaction limits stop SQL work, while no client query timer claims early completion. Startup checks all library migration categories, including indexes, unsafe changes and schema problems, without compiling or running DDL. Apply migrations explicitly during deployment.

`PeAuthService.observe()` exposes resource phase/counts and `requestAdmission: 'closed'`. With ingress configured, nested state records actual retained registrations, owner/Web identity and pending work; it never recursively calls the seal. `close()` stops and withdraws ingress, joins actual handlers, body cancellation and native Peer cleanup, then authentication/secret work before `Pool.end()`. Timeout retains work; unknown cleanup retains ownership and reports `cloud/stop-unconfirmed`. Resource-only mode registers no routes; neither mode creates a listener or establishes account readiness.

Root `apply` is an async Loader effect returning `Promise<void>`; Loader activation waits for authentication initialization and observes its rejection. Obtain the provider through `ctx.get('peAuth')`, or use `PeAuthService.mountRoot` from trusted same-process assembly. A missing secret fails the actual Loader entry and withdraws its provider; native boot's required-entry policy decides whether that entry failure rejects application startup.

### Request bindings

Preserve every carrier-field occurrence for `parseRequestExpectation`; missing, repeated, empty, padded or control-character values fail with HTTP 409. After real authentication, compare the expected account before owner lookup, then compare the generation after acquiring the current graph. Pure comparison success grants no Peer, project scope or business permission; `AccountUse.assertCurrent()` remains required before dispatch and every WS logical stream.

Private ingress owns `/cloud/auth`, `/cloud/bootstrap`, `/cloud/settings`, `/api` and native `/api/remote.mux` upgrade registrations. Every handler/continuation checks the actual seal; registration does not wait for sealing or create a Loader cycle. Raw header and WS query occurrences are preserved without fallback. Bounded opaque generation tokens require actual runtime business-current checks. Request borrows last through HTTP response/error settlement; upgraded sockets use the independent Peer borrow. Full root capacity closes the carrier without queuing.

The native final-dispatch callback rechecks the original request, login, Use, generation and graph-local `CloudAccountApi` after actual route/envelope selection. Every logical stream checks its original Peer and per-graph policy. Native frame limits and acquire/actual-settle callbacks enforce global/account/Peer stream capacity; unknown cleanup retains slots and schedules closure without awaiting its own transport. Bootstrap additionally requires original catalog, native policy and installed-package evidence; C06 settings remains closed.

HTTP and upgrade admission reserve finite carrier capacity before joining an ongoing or due database recheck of the Peer’s original Cookie. Dispatch still requires confirmed freshness and the original request/account checks; logical WS opens retain their synchronous guards.

### Bootstrap metadata

`decodeCloudBootstrap(input, limits)` validates the strict C-11 account, version, generation and capability descriptions and returns detached, deeply frozen data. Supply explicit `maxBodyBytes`, `maxStringBytes` and combined `maxListItems`; no limits are defaulted. The body budget includes keys, delimiters and escaped UTF-8 strings in the complete compact result. The caller still bounds raw HTTP bytes before `JSON.parse`; all three limits may be derived from its `maxBootstrapResponseBytes`.

Unknown fields, invalid availability/reason pairs, non-false restricted capabilities and invalid budgets fail without echoing input. Decoding does not authenticate, issue a generation or verify providers/readiness. Configuration application levels describe the server response; they do not submit changes or select the server's actual decision. The private producer joins original `CloudAccountApi.assertBootstrapCurrent`, files/project membership, closed execution and bounded Loader/package checks. It rechecks the original login, Root, Use, generation and installations before sending bounded JSON with `no-store`. Approval rows alone never establish installation; missing facts reject the entire bootstrap.

The producer admits the exact `cloudProjects/create` RPC and native `workspaceFiles/read`, `stat`, `list`, `readBytes` RPCs plus the `workspaceFiles/changes` stream. Other methods in those namespaces and wrong RPC/stream modes reject. Each selected row passes the original API owner's current registration audit. `filePreview` is available only when that complete file group is selected and the original Files owner passes `assertContentAvailable()`, including its settled ABI8/content/provider prerequisites. A partial group keeps preview disabled; any selected file endpoint still requires the content assertion. Runtime applies the same prerequisite before readiness. The first-trial recipe without file endpoints retains disabled preview. Project metadata keeps its existing fields; execution, configuration and other unapproved features remain closed.

### Authentication adapter

`BetterAuthAccess.create` requires Better Auth 1.7.10, a caller-owned finite PostgreSQL pool and a resolved secret. It checks the loaded library version, disables cookie identity caching and pins the base URL/path to the approved origin and `/cloud/auth`. Raw cookies enter the library; client account fields cannot create a principal.

`authenticate` forces a database lookup with `disableCookieCache` and `disableRefresh`. `recheckLogin` uses the exact original cookie snapshot and invokes the supplied login invalidator on admitted verification failure. `assertLoginCurrent` rejects due rechecks before dispatch. A Peer watcher must schedule rechecks and close its exact Peer on every rejection, including capacity denial; this adapter does not install that watcher.

Internal `authenticateForBootstrap(request, requestId, maxDisplayNameBytes)` shares the same authentication operation and library lookup as `authenticate`, returning its normal principal and a frozen account projection from that verified user's name. The explicit positive byte limit is checked first against character length, then UTF-8 bytes. The principal and its login records gain no name field; later authentication can observe a changed name while prior projections stay immutable. Oversized names return `cloud/capacity`; an invalid limit returns `cloud/account-unavailable` before DB work. Neither failure exposes the name or account id.

`handleNodeRequest` delegates untouched bytes to Better Auth's Node bridge after Host/Origin/TLS/proxy checks. Ingress supplies byte limits and observer cancellation; standard streams count raw chunks before parsing and join actual request/response cancellation. The library bridge's early Promise does not release response ownership. Forwarded headers determine neither identity nor auth origin. Production cookies are Secure, HttpOnly and SameSite=Lax. WS requires exactly one matching original Origin before auth DB work; HTTP may omit it, with mutating authentication CSRF checks still library-owned.

`sign-in/email` and `sign-up/email` first query the original Cookie through the library with identity caching/refresh disabled. A valid login or a stale presented session Cookie returns typed `cloud/login-active`/409 with `retry: never`, requiring actual sign-out; lookup failure never means anonymous. A late lookup after timeout or cancellation cannot enter the mutation. Initially anonymous requests have no shared server transition identifier, so cross-tab/node ordering of newly issued cookies is not certified.

`revokeLogin` deletes through the library before its session-deletion hook notifies the login invalidator. `planMigrations` returns the library-generated plan without applying it. Auth operations reserve one finite slot covering the real query and invalidation cleanup; nested hooks do not reserve another slot. A timed-out wait retains that slot in `pendingOperations` until actual work settles. `close` stops admission and waits without ending the caller-owned pool. No Agent task is cancelled by authentication failure.

### Failure and recovery

Missing, revoked or expired login returns `cloud/unauthenticated`/401; trust rejection returns `cloud/forbidden`/403; unavailable or timed-out verification returns `cloud/account-unavailable`/503. Full auth-operation, login-state or invalidation capacity returns `cloud/capacity`/429 without unbounded queuing. Wire errors omit raw library errors, cookies and database credentials. Unknown mutation outcomes require status inspection; neither reconnect nor bootstrap authorizes automatic replay.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The adapter owns authentication consistency, while runtime retains owner/epoch and API retains endpoint/resource rules. Verified principals have adapter-local origin tracking; forged JSON principals fail rechecks. Invalidation applies to the exact authentication session id and retains a bounded record until older actual reads settle. A revoked login cannot be restored by a delayed read, and another login's certificate remains valid. Operation-local hook failures and library error-level signals prevent contained deletion failures from becoming successful logout responses; diagnostic text is not recorded. Native Session, queue and event implementations remain outside this package.

Internal `LoginPeerRegistry` merges creation by verified login, account and epoch, borrows an independent lifecycle `AccountUse`, and pins the first principal/cookie. Preparing and uncertain cleanup retain Peer capacity; caller timeout or abandonment only ends its own wait. The native HTTP bridge and WS mux share one real `Peer`; socket disconnect retains that Peer and borrow. A configured watcher rechecks the original login and closes its exact entry on every rejection. Each dispatch and logical stream synchronously checks the original login, account Use and supplied endpoint guard.

Revocation or lifetime end closes admission and destroys carriers, then awaits native mux/Peer cleanup and actual HTTP operations before releasing the borrow. M1 invalidation awaits native carrier/Peer closure, excluding preparation, recheck and carrier authentication that may have invoked the deletion hook. Full closure separately awaits actual carrier settlement and late borrows before releasing Use. `cloud/stop-unconfirmed` reports cleanup failure or an expired cleanup wait; failure retains capacity and Use and invokes the mandatory diagnostic callback; timeout never proves release. A bounded severity flag observes public Cordis error records from Peer descendants; a fulfilled native disposer alone cannot establish clean closure. The class and borrow callback stay internal, adding no SDK, client authority fields or listener.

| Source | Responsibility |
| --- | --- |
| [bootstrap.ts](src/bootstrap.ts) | Strict bounded C-11 decoder and detached read-only metadata. |
| [bootstrap-producer.ts](src/bootstrap-producer.ts), [bootstrap-inventory.ts](src/bootstrap-inventory.ts) | Original graph assertions, actual Loader/package inventory and bounded C11 projection. |
| [config-schema.ts](src/config-schema.ts) | Browser-safe structural configuration schema. |
| [auth.ts](src/auth.ts) | Real library calls, fixed-login rechecks and actual-work retention. |
| [peers.ts](src/peers.ts) | Internal login Peer, independent borrow, native carriers and retained cleanup. |
| [auth-trust.ts](src/auth-trust.ts) | Fixed-origin transport checks. |
| [binding.ts](src/binding.ts) | Client expectation parsing and comparison. |
| [root.ts](src/root.ts) | Loader entry for root-owned authentication resources. |
| [root-config.ts](src/root-config.ts) | Host database and secret budgets. |
| [auth-root.ts](src/auth-root.ts) | Real pool/library initialization, schema inspection and actual cleanup. |
| [ingress.ts](src/ingress.ts) | Private shared-Web ownership, real seal checks and retained requests. |
| [expectation.ts](src/expectation.ts), [generations.ts](src/generations.ts) | Original occurrences and bounded runtime-bound tokens. |
| [body-stream.ts](src/body-stream.ts), [stream-capacity.ts](src/stream-capacity.ts) | Actual cancellation and native stream reservations. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Better Auth sessions](https://better-auth.com/docs/concepts/session-management) — authoritative session lookup and revocation.
- [Better Auth PostgreSQL](https://better-auth.com/docs/adapters/postgresql) — database integration and migrations.
- [Web server](../../host/webserver/README.md) — the shared root listener.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

Authentication, binding checks and `decodeCloudBootstrap` add no model-visible content or tool schema; they do not dispatch an Agent request.

#### Token effect

This package adds zero model input or output tokens.

#### KV Cache effect

Request authentication and binding checks change no prompt prefix or model cache input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Production admission requires actual storage authority, recipe audit and account publication; these remain separate from metadata projection. `CloudAccountApi` and native dispatch/stream hooks are wired without substituting root policy. Unsealed ingress refuses business work. Library initialization and refusal tests do not establish S1/S2 or full F01 browser/WS success.
- Proxy forwarding remains restricted to the configured fixed origin; forwarded client-IP chains and cross-instance service identity/routing require separate deployment integration.
- Root rejects a nonempty library migration plan and never runs migrations. Root must supply the actual approved public control catalog; infrastructure omitted from it still requires original API/files/execution assertions. C06 control and approved navigation-download carrier selection remain pending; native HTTP currently requires binding headers, while WS uses query fields. Formal producer/consumer builds and real PG/Web integration are required before opening the complete chain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Focused tests use real PostgreSQL, native Connection/Gateway and memory socket pairs to verify shared HTTP/WS Peer, revocation, expiry and retained cleanup. Account borrows are fixtures rather than the product factory; Loader account boot and running Agent task isolation remain unverified.

</details>
