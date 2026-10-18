---
description: "Runtime participant registration, local capacity limits, and immutable account generation inputs for cloud composition maintainers."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-runtime

English | [中文](README.zh.md)

## Summary

This package stores PostgreSQL account ownership with expected-epoch CAS, records process registration observations, rejects incomplete drain registration, and bounds local mount and drain reservations. It supplies the shared immutable generation and actual-work evidence types used by cloud providers. Its account entry requires a private factory handoff instead of accepting account identity from configuration. An owner claim returns mounting metadata; it does not publish a usable account graph.

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

The root Loader entry is `/root`; the default package entry aliases it. `/account` accepts empty configuration only, rejects identity or other JSON fields, and verifies the immutable `peAccount` contribution installed by the private factory. `/types` contains shared data declarations, and `/schema` exposes the capacity parser.

### Configuration

The root requires all three positive safe-integer limits. It infers no deployment defaults.

| Field | Default | Meaning |
| --- | --- | --- |
| `maxMountedAccounts` | required | Account slots and the bound on pending/unknown owner-write responsibilities. |
| `maxConcurrentMounts` | required | Actual mount operations that have not settled. |
| `maxConcurrentDrains` | required | Actual drain operations that have not settled. |

Providers register the mandatory `files` and `execution` participants through the root service. Registration belongs to the calling fiber and rejects duplicates. A missing participant rejects mount capacity reservation; passing this check is not recipe sealing. Configuration saving has a separate API-owned barrier and is not a third participant.

The account factory owns each capacity reservation until the actual work settles. `settleMount()` releases the concurrent mount slot while retaining the account slot. `releaseAccount()` rejects while mounting or draining still holds that account. A request timeout does not authorize either release. Root unload closes new local reservations without reporting existing work stopped.

### Account layout

`/types` declares one `AccountLayout` for shared private/Profile/patch, credentials, Sessions, storage, attachment originals, skills, instructions, projects, environments, and the process-local Session index. `AccountMountInput` pairs those addresses with the existing binding, startup InstanceId, and native `LaunchEnvironmentSnapshot`. These are trusted assembly data; paths grant no directory access, readiness, or quota evidence. Credentials go only to their required native consumers.

The private [address helper](src/account-layout.ts) accepts explicit normalized POSIX shared/cache roots and a positive finite UTF-8 byte limit. It bounds characters before scanning UTF-8 and checks every output. A fixed v1 domain and explicit byte length frame the exact authenticated id before SHA-256; no raw id or title becomes a directory segment. Shared paths stay stable across epochs and process restarts. Only the rebuildable local index includes the startup InstanceId.

The default project candidate uses the fixed `default-workspace` basename, preserving native title handling. Native eligibility, history checks, and the default-deletion marker still decide initialization. New project candidates use a server UUID selected once; callers retain that candidate through actual preparation. The helpers create no directories or Workspace records. Real parent protection, FD capabilities, quota, and current-generation checks belong to files/deployment and the runtime lifecycle.

### PostgreSQL owner storage

The private owner store accepts a root-owned PostgreSQL query adapter and a server-generated instance identity. The same-package account factory owns this implementation; it is not an exported account-management SDK. The adapter binds parameters and enforces finite connection, statement, and query budgets. `migrate()` runs atomic DDL for `pe_account_owners`; concurrent migration calls serialize in PostgreSQL, and incompatible existing columns or constraints reject without resetting rows.

The private [pg adapter](src/owner-pg-executor.ts) uses `pg@8.16.3` with one statement per connection and no hidden pool. Explicit constructor limits bound connections, queued submissions, queue/connect/server statement/lock time, observed actual Promises, and concurrent waiting observers; these are not additional root Loader configuration fields. `ClientConfig.query_timeout` is zero; a nonzero shared pg query-timeout default rejects before connection setup. A query retains its slot through actual driver settlement and connection end; no connection is reused. Server `statement_timeout` bounds execution, and a submitted write failure still has an unknown outcome to the store.

`observe(actual, deadlineAtMs, signal)` limits only that wait. Timeout/cancellation removes its waiter, retaining one bounded settlement subscription per actual Promise until settlement. It neither rejects the actual SQL nor releases its connection. `close()` stops admission and rejects queued SQL that was never submitted, then retains the same close Promise through every started connection. Only the trusted adapter's definite pre-submission failure permits the store to discard that pending write responsibility; queue exhaustion, expiry, and failed connection setup do not quarantine an account whose SQL was never sent.

`claim()` requires null for a missing row or the exact prior epoch of an unowned row. A parked row is claimable only by its retained instance. Each successful claim increments the retained bigint epoch and returns mounting metadata. Identical local pending claims share one database Promise, bounded by `maxConcurrentMounts`; the account factory must still merge the complete graph mount. Heartbeat only updates observation timestamps and never authorizes takeover.

The private factory calls `ready(expected, recipeVersion)` only after its actual graph, providers, saving and exposure audits succeed. The CAS accepts only mounting metadata with the exact account, process instance, epoch and recipe; stale, repeated or mismatched commits reject. It neither performs those audits nor publishes `AccountUse`. A submitted failure retains unknown write responsibility.

`beginDrain()` accepts a ready graph or known cleanup of a mounting graph; it never publishes ready or clears quarantine. `release()` and `park()` then require complete matching runtime evidence: native idle, confirmed config saving, both confirmed participants, flushed persistence, disposed Context, and no disposal errors. Incomplete matching evidence quarantines the owner instead. Quarantine has no normal release or claim exit. The store retains unowned rows and never deletes or resets their epoch; no epoch passes through Number.

A rejected mutation can have an unknown commit result. The store retains that account and attempted epoch, closes subsequent writes for that account, and allows status reads without replay or automatic clearing. Other accounts continue under normal CAS and capacity rules. Responsibility is reserved before each mutation; unknown records remain within the configured bound, and exhaustion rejects new observations without discarding old ones. Migration failure closes the store globally. The full runtime must reconcile through its trusted lifecycle; constructing a storage adapter is not recovery authorization.

### Process instance metadata

The private [instance component](src/instance-control.ts) stores startup identity, trusted deployment address, recipe version, observational phase, and heartbeat time in `pe_instances`. Its atomic migration rejects incompatible columns or constraints without resetting rows. The component generates and freezes its identity internally; its owner constructs one component per Node startup and shares that exact identity with the owner store. The constructor accepts no supplied instance id. The address is opaque deployment metadata, not a selected network destination.

Registration coalesces identical local calls and rejects an existing durable id without overwriting its metadata. Point reads distinguish an absent row from a failed or invalid result. Heartbeat updates only the component's registered row. Neither `registered`, `closed`, nor stale heartbeat establishes account readiness, process death, or owner-reclamation authority. Instance operations never modify account owners or epochs.

Each component retains at most one actual mutation. Close stops local mutation admission, joins actual schema/registration/heartbeat work, then marks its own registration closed; the root separately owns account drain and shared executor shutdown. Waiting uses the adapter's bounded observation without settling actual SQL. Submitted uncertainty remains typed and retained after reads or observation deadlines, with no automatic replay; another component can continue. Only a definite pre-submission failure permits an explicit retry, and retrying close keeps local admission closed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each root owns its participant map and capacity counters. Each independent account root receives a frozen binding with a lossless epoch string and a graph lifetime. The internal handoff rejects child Contexts, structural lookalikes, and ended lifetimes; no public constructor converts browser JSON into a binding. Native queues, Sessions, settings, and execution state remain with their owning packages.

The [root service](src/root.ts), [PostgreSQL owner store](src/owner-store.ts), [capacity bookkeeping](src/capacity.ts), [private binding handoff](src/binding.ts), and [shared types](src/types.ts) define the implemented behavior. The [Loader tests](tests/runtime.spec.ts) cover runtime inputs; the [PostgreSQL tests](tests/owner-postgres.spec.ts) execute CAS and migration cases against an explicitly assigned test database, with synthetic teardown evidence.

The private [native Profile adapter](src/native-boot.ts) uses public app boot to create an independent root, provide a copied ProfileContext, explicit launch environment and immutable binding in `prepare`, and mount the root Include once. Construct, verify, and inject every save/files/execution port inside `prepare` from the exact installed binding, retaining its graph lifetime. After awaited setup, preparation rechecks the installed lifetime and close request before returning to boot. If the generation ended or closure was requested during setup, no Include entries start, and actual cleanup remains awaited. The runtime still disposes already mounted graphs. It installs no account CLI, signals, proxy, watcher, or code HMR. Its caller must verify the real root capabilities and fixed recipe before invoking it. A mounted result only establishes native assembly. The retained boot/disposal Promises and bounded error observation include partial startup and asynchronous disposer failures; an error or observation overflow prevents confirmed native disposal. This observation does not establish business-work drain or account clean.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Application composition](../../../docs/architecture.md)
- [Native app boot](../../boot/app-boot/README.md)
- [Lifecycle review rules](../../../docs/defensive-patterns/general.md)

-----

<a id="model-experience"></a>
## Model Experience

### Runtime admission

#### What the model sees

This package contributes no prompt text or tool schema. It keeps `AccountBinding` and owner metadata outside model context.

#### Token effect

Zero direct token effect; local registration and capacity errors do not inject model context.

#### KV Cache effect

Local bookkeeping does not alter a model request prefix or retained Session history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This foundation cannot admit production account traffic.

- **Account factory** — shared graph mount promises, `AccountUse`, production recipe/port integration around the private native adapter, sealing, and ready publication are absent. Database claim coalescing does not complete account acquisition.
- **Layout integration** — layout data and private address helpers are not connected to native boot or files capability creation. The environments parent is included; per-Session environment derivation is absent.
- **Database integration and recovery** — the private pg adapter and instance component are not attached to root deployment configuration or startup. Root heartbeat scheduling, recovery audit, allocation reconciliation, and trusted RecoveryProof application are absent; quarantined ownership cannot be reclaimed here.
- **Required evidence** — participant presence does not verify storage quotas, native providers, config-save hooks, manifests, stopped processes, or disposal success. Capacity reservations perform no participant drain.
- **Account handoff** — only the same-package factory helper installs a binding. The helper requires trusted owner input and does not itself verify PG ownership; tests supply binding fixtures without claiming an account graph is ready.
- **Shutdown** — root unload closes local admission only. Ordered graph drain, persistent unknown outcomes, config-save receipts, flush, and shared pool shutdown require the full lifecycle implementation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
