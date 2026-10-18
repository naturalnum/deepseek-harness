---
description: "Bounded cloud file-work scheduling and lifecycle diagnostics for maintainers checking account ports, budgets, and production prerequisites."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-files

English | [中文](README.zh.md)

## Summary

You can inspect bounded file-work admission, cancellation, and drain outcomes for account generations. Caller cancellation does not erase actual work, and a held result keeps its byte reservation. You can prebuild one bounded Linux worker pool, inspect metadata, and stream bounded text through a fixed-root internal reader. Account filesystem activation remains unavailable until the trusted runtime ports, complete native filesystem, and storage proofs are connected.

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

The `/root` and `/account` entries are Loader plugins. On Linux, `/root` requires the runtime registration service, a reviewed ABI 5 helper binary, and explicit pool limits. It starts all configured workers before registering the unique files participant. `/account` still rejects activation because its trusted filesystem integration is incomplete; root-pool startup does not establish account readiness.

All [FilesLimits](src/types.ts) fields are required finite positive safe integers. Per-lane concurrency, queue capacity, and resident bytes must fit their global limits; wait time must fit a Node timer. The [root schema](src/root.ts) also requires worker count, minimum healthy count, worker and reply reservations, handshake and drain deadlines, helper location, and read/path/chunk/retry limits. The global resident limit includes the fixed worker reservation; the remaining capacity bounds account work. Configured reservations must conservatively cover buffers, cloning, decoding, and retained results.

Trusted account/root port issuance, complete directory-anchor ownership, native `FsTarget` source validation, and quota proofs must be connected before account filesystem activation. The account entry accepts no client-selectable identity or path. The package reuses the native `FileSystem` type and supplies no host-filesystem fallback.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [work queue](src/work-queue.ts) reserves global and per-lane bytes before admission, bounds concurrent and queued work, cancels queued work without starting it, and keeps running work after its caller aborts or times out. Every operation requires a positive safe-integer reservation that includes its overhead. Zero is refused before backend invocation, so retained records cannot bypass the resident budget. A settled successful result retains its reservation until its consumer releases it. Closing a lane stops new work while preserving unresolved records; closing the queue stops all lanes.

Settlement observers run independently: a failed observer is reported without preventing budget release, later observers, or queued work. A failed reporter falls back to a default-enabled diagnostic without exposing the original exception text. A final abort check immediately before the deferred backend invocation prevents cancelled work from starting.

The [file work owner](src/work-owner.ts) consumes runtime-owned account binding, operation-id, participant, and receipt types. It binds an internal object-capability lane to an exact generation and a trusted current-owner callback, refuses another generation while the first owns work, and reports unknown until actual work and held results settle. Lifetime abort stops admission, and expired drain waits remove their settlement observer while the owner continues tracking work.

The private [directory responsibility](src/directory-responsibility.ts) registers retained ownership and preparation I/O atomically on that same lane. Its [budget calculation](src/directory-budget.ts) reserves bounded intent and identity copies, records, one observer, result frames, and one complete cleanup scratch area before dispatch. Actual preparation settlement returns running capacity and its I/O bytes; created or unknown responsibility keeps a positive reservation and operation id. Observer abort or deadline does not cancel this ownership. Only the original private responsibility may schedule cleanup through the shared running/queued limits, using its retained scratch even after business closure. Exposure is irreversible; exposed or unknown responsibility cannot be declared clean, and unresolved responsibility prevents lane retirement or a new epoch. The base scheduler accepts audited component callbacks, which provide no filesystem authority or kernel evidence. A privileged root-owned isolated tmpfs fixture grant can derive a fixed single-leaf port; this is not a production grant issuer or an account provider. Server-selected intents admit the fixed default leaf `default-workspace` and a new project’s once-generated UUID; valid spelling and an AccountLayout object do not grant write access. Root shutdown closes ordinary admission first and retains idle slots for explicit cleanup of original responsibilities. Cleanup may use one healthy idle slot below the business health minimum; zero healthy slots remains unavailable. Queue overflow never triggers automatic retry or a hidden waiting queue. Slots close only after actual work, held results and responsibilities settle, and the root effect then waits for actual exits.

This internal work port cannot choose another account or close the shared queue; it is not a native filesystem or an issued storage capability. The queue measures reservations rather than enforcing allocation sizes inside arbitrary callbacks, so only an audited bounded backend may submit production work.

The private [Linux worker](src/file-worker.ts) probes the required kernel operation during startup without retaining an account directory. The [ABI 5 N-API helper](native/fd.c) verifies a fixed root identity and uses `openat2` beneath that anchor, with no magic-link or portable fallback. Metadata uses an `O_PATH` FD and returns native version fields for directories or single-link regular files; absent paths return undefined, while special files and hard links are rejected. Nonstream reads close their FD and anchor before replying; streams retain one FD until actual EOF, cancellation, or worker exit.

The same bound lane also exposes a read-only [directory port](src/directory.ts) with `canonicalPath` and `isDirectory`. Its helper observes bounded physical FD spellings, reopens beneath the same anchor to compare identities, rechecks the anchor, and closes descriptors before success. Target ENOENT/ENOTDIR can be definite missing/non-directory failures; anchor loss, verification failure, capacity, stale generation, cancellation, and transport faults remain unavailable with their causes. The private `DirectoryMetadataFailure` records the reason and failed stage. This port has no `ensureDirectory` and cannot be installed as the complete native Workspace directory dependency. Read-only Linux coverage does not certify creation or cleanup; ABI 5 requires separate published-worker verification.

ABI 5 adds self-contained single-leaf preparation and exact empty-directory removal at mode `0700`, with a real tmpfs backend check. A fixed 64-byte frame records mutation phase, parent/leaf identity, original mkdir errno and actual descriptor closure. Confirmed not-created failures reject the business operation and settle its temporary responsibility; cancellation after a fully verified created frame retains identity and responsibility. Failed post-create parent verification permanently disables cleanup even if the path or window assertion later recovers; lost replies, worker faults and ambiguous outcomes remain unknown. Cleanup requires the original private identity and a still-valid complete namespace exclusion window; empty or missing paths alone never prove safe removal. Close errors retire the FD number before fatal worker failure, preventing a finalizer from retrying a possibly reused number. General recursive preparation remains unavailable; actual published ABI 5 syscall validation remains coordinator-owned.

The [Workspace adapter](src/workspace-adapter.ts) fixes all three native directory methods before native initialization, while the registration window is valid. Its constructor and metadata selection require both the Context and its independent root to hold the exact bound `peAccount` generation. Read methods share the existing pool and lane and check the current graph before and after I/O. They remain available after the registration window closes. Directory preparation, exposure and transfer still require that separate window. `ensureDirectory` admits only the pregranted `default-workspace` leaf; the public native default initializer still decides eligibility, history rechecks and durable identity. The thin override supplies the account project address instead of the desktop Documents resolver. After the window closes, native default initialization can still return an existing default or its deleted/ineligible state; an actual request for a new directory rejects before a ticket or mkdir. New projects receive a once-selected server UUID grant, independently of the display title, then use the original native `create` operation.

Temporary directory responsibility transfers only after the actual native registration Promise fulfills with a Workspace. The private adapter verifies the original ticket, current unpublished graph and each candidate’s complete namespace window, matching physical path, and internal FD identity before and after registration. Native cache membership is only a cross-check. Transfer releases the retained reservation without removing the directory or retaining a project-to-ticket map. Undefined results, rejection, late graph closure, identity mismatch and lost preparation waits retain unknown responsibility and prohibit cleanup; a later successful preparation reply cannot reverse that uncertainty. Ordinary prepared-leaf controls remain exposure and cleanup only.

The bound port exposes an internal [reader](src/read-only.ts) with the native `resolve`, `stat`, `streamText`, and `processPath` signatures needed by account-instructions. Resolution stays within its previously authorized root and issues opaque targets; every later operation checks the exact issuing reader and current epoch. Absolute paths never select another project. This adapter supplies no complete filesystem service or trusted-root issuer.

The [shared root pool](src/worker-pool.ts) prebuilds a fixed number of workers and reuses them across bound accounts. Binding and reading create no workers; failed workers are not automatically replaced. Each operation obtains one queue reservation for request/result buffers. A text stream holds its slot between pulls, grants one chunk credit, and uses `readChunkBytes` per chunk and `maxReadBytes` for the complete raw content. It reads at most the total cap plus one byte, decodes UTF-8 across chunks, and uses the native fatal-decoding and first-8192-byte NUL-sample rules. Early consumer return cancels the operation without declaring its FD closed. After I/O closes, a paused iterator retains the same reservation for its decoded chunk until it finishes or returns. Consumers must finish or return their iterator. The [transport](src/worker-client.ts) waits for a real reply or actual exit after cancellation; malformed replies and worker errors stop admission, and late replies cannot reverse a transport failure. Account drain closes that generation and signals active I/O while preserving the shared pool.

The [root effect](src/root-lifecycle.ts) retains the fixed worker reservation and files participant until all workers actually exit and all account work and held results settle. A bounded shutdown may report unknown; the effect continues owning cleanup and keeps registration and the root service until actual closure. This lifecycle behavior does not verify storage quotas or authorize a project root.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Native filesystem](../../fs/fs/README.md): provider behavior and original file types.
- [Account runtime](../pe-cloud-runtime/README.md): account identities and required participant ownership.
- [Architecture](../../../docs/architecture.md): plugin composition and capability ownership.

-----

<a id="model-experience"></a>
## Model Experience

### File operations

#### What the model sees

The `/root` and `/account` entries register no tools, prompts, model context, or filesystem provider. Root-pool startup does not enable model file operations; the account entry rejects activation while the required production integration is absent.

#### Token effect

Zero direct token effect.

#### KV Cache effect

The package adds no model request content and changes no reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Production activation remains closed while the following integrations are absent.

- The shared root pool provides a complete Workspace metadata adapter inside a trusted isolated graph. Registration transfer requires its unpublished window; metadata reads can continue while the published graph remains current. This lifecycle distinction supplies no production storage authority. General recursive preparation, live concurrent registration/deletion, production grant issuance, the remaining native filesystem methods, full target/write semantics, link-race acceptance, complete allocation accounting, and byte/inode hard quota remain incomplete.
- Runtime binding and receipt types are consumed from the runtime package. Root registers the files participant after worker startup, but the trusted factory must still issue approved storage/root capabilities and connect the complete backend before production use.
- Native FileSystem adaptation, full stream/directory/write accounting, attachment intake/staging, instructions, skill projection, and deployment storage proofs remain unavailable. The helper binary must be built and pinned by the reviewed Linux deployment recipe; the package does not ship a preverified binary.
- Workspace source tests use real native Loader, JSONL and JSON StorageDomain with a test-only Node-backed worker transport; they establish no Linux FD, tmpfs, namespace or quota facts. Published Linux validation remains a separate requirement. Real Loader lifecycle checks and Linux tmpfs syscall tests cover metadata/version observations, single-FD text reads across rename, file-growth bounds, UTF-8 validation, pool reuse, actual worker faults, and deadline unknown results. They do not establish ext4/NFS confinement, blocked NFS syscalls, hard quota, F02, F03, F05, account readiness, or a Web flow. Complete production composition and published-consumer checks remain required before activation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
