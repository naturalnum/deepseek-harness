---
description: "Validate cloud request bindings and use database-backed Better Auth authentication without opening incomplete root admission."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-access

English | [中文](README.zh.md)

## Summary

Validate fixed-origin deployment inputs and reject stale account/generation expectations before native business work. `BetterAuthAccess` delegates authentication to pinned Better Auth and PostgreSQL, returning identity only from verified user/session rows. The `/root` Loader entry rejects assembly while runtime, lifecycle and transport admission are incomplete.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use `/schema` for pure configuration and request-expectation checks. The package entry and `/root` expose the root Loader plugin and `AuthAccessError`. `BetterAuthAccess` is an internal implementation for same-package root assembly, without an additional SDK subpath. `AuthenticatedPrincipal.accountId` directly uses runtime's `AccountId` type.

### Configuration

All configuration is explicit; examples do not supply production defaults. The complete schema lives in [config.ts](src/config.ts). The root currently rejects even valid configuration, so this package provides no successful mount example.

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

### Request bindings

Preserve every carrier-field occurrence for `parseRequestExpectation`; missing, repeated, empty, padded or control-character values fail with HTTP 409. After real authentication, compare the expected account before owner lookup, then compare the generation after acquiring the current graph. Pure comparison success grants no Peer, project scope or business permission; `AccountUse.assertCurrent()` remains required before dispatch and every WS logical stream.

### Authentication adapter

`BetterAuthAccess.create` requires Better Auth 1.7.10, a caller-owned finite PostgreSQL pool and a resolved secret. It checks the loaded library version, disables cookie identity caching and pins the base URL/path to the approved origin and `/cloud/auth`. Raw cookies enter the library; client account fields cannot create a principal.

`authenticate` forces a database lookup with `disableCookieCache` and `disableRefresh`. `recheckLogin` uses the exact original cookie snapshot and invokes the supplied login invalidator on admitted verification failure. `assertLoginCurrent` rejects due rechecks before dispatch. A Peer watcher must schedule rechecks and close its exact Peer on every rejection, including capacity denial; this adapter does not install that watcher.

`handleNodeRequest` delegates the untouched body to Better Auth's Node bridge after Host/Origin/TLS/proxy checks. Forwarded headers never determine identity or a dynamic auth origin. Production uses Secure cookies; all cookies are HttpOnly with SameSite=Lax. Only explicitly trusted proxies may assert the fixed forwarded host/protocol; client IP tracking uses the actual socket address.

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
| [auth.ts](src/auth.ts) | Real library calls, fixed-login rechecks and actual-work retention. |
| [peers.ts](src/peers.ts) | Internal login Peer, independent borrow, native carriers and retained cleanup. |
| [auth-trust.ts](src/auth-trust.ts) | Fixed-origin transport checks. |
| [binding.ts](src/binding.ts) | Client expectation parsing and comparison. |
| [root.ts](src/root.ts) | Loader entry and explicit incomplete-assembly rejection. |

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

`BetterAuthAccess` and binding checks add no model-visible content or tool schema; they do not dispatch an Agent request.

#### Token effect

This package adds zero model input or output tokens.

#### KV Cache effect

Request authentication and binding checks change no prompt prefix or model cache input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Root still rejects assembly: the real runtime borrow factory, manifest/native routing and finite root request admission are not integrated; the internal Peer component is not wired into root. A library authentication check does not establish S1/S2 or the full F01 browser/WS flow.
- Proxy forwarding remains restricted to the configured fixed origin; forwarded client-IP chains and cross-instance service identity/routing require separate deployment integration.
- Generated authentication SQL requires deployment migration review and packaging. Migrations are never run by root activation. The caller must supply bounded pool settings and retain cleanup responsibility for unknown operations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Focused tests use real PostgreSQL, native Connection/Gateway and memory socket pairs to verify shared HTTP/WS Peer, revocation, expiry and retained cleanup. Account borrows are fixtures rather than the product factory; Loader account boot and running Agent task isolation remain unverified.

</details>
