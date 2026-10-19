---
description: "Bounded cloud file-work scheduling and lifecycle diagnostics for maintainers checking account ports, budgets, and production prerequisites."
kind: "package-reference"
---

# @deepseek-ai/dsh-pe-cloud-files

English | [中文](README.zh.md)

## Summary

You can inspect bounded file-work admission, cancellation, and drain outcomes for account generations. Caller cancellation does not erase actual work, and a held result keeps its byte reservation. A trusted runtime can prepare one graph-owned files owner; the account entry installs its real native Workspace Registry and selected FileSystem, defaulting to restricted S2 metadata. Production readiness still requires deployment storage authority and the complete account recipe.

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

The `/root` and `/account` entries are Loader plugins. On Linux, `/root` requires the runtime registration service, a reviewed helper binary (ABI6 for existing S2, independently built ABI7 for text writes), and explicit pool limits. It starts all configured workers before registering the unique files participant. `/account` requires a runtime-prepared `CloudAccountFiles` owner and empty configuration. It preserves the native Registry dependencies, installs that Registry and its selected FileSystem in its own native child fibers, and awaits the actual default project. Root-pool startup and successful files installation do not establish account readiness.

Trusted `AccountFilesPreparation.createFileSystem`, when supplied, selects a native constructor only after the original Registry and actual default Workspace exist, before installing the sole filesystem. Omission keeps the metadata-only S2 constructor; preparation failure neither falls back nor reports readiness. The real `StaticStorageLease` explicitly supplies its bound `port.createTextFileSystem` closure for the new text candidate, whose writes require the separate ABI7 helper. The account entry remains empty-configured, and existing running R8 artifacts are not replaced by this source change.

All [FilesLimits](src/types.ts) fields are required finite positive safe integers. Per-lane concurrency, queue capacity, and resident bytes must fit their global limits; wait time must fit a Node timer. The [root schema](src/root.ts) also requires worker count, minimum healthy count, worker and reply reservations, handshake and drain deadlines, helper location, and read/path/chunk/retry limits. The global resident limit includes the fixed worker reservation and any static-storage root reservation; the remaining capacity bounds account work. Configured reservations must conservatively cover buffers, cloning, decoding, and retained results.

During native account boot preparation, trusted runtime constructs [CloudAccountFiles](src/account-service.ts) with the exact installed binding, an existing bounded lane’s Registry construction port, its fixed default grant, and separate mount/current and unpublished-window checks. This input accepts no shared root pool, caller-selected path, Workspace receipt or plugin. After Loader settlement, `project()` returns the actual native Workspace and its files-owned `projectDirectory` for API/runtime assembly. Missing or foreign owners, nonempty configuration, competing providers and stale generations reject. The package supplies no host-filesystem fallback.


Production factories first obtain the actual storage owner through the original pool’s `requireStorageOwner()`. The optional root `staticStorage` configuration is described by [StaticStorageConfig](src/storage-types.ts); omission supports component callers and grants no owner. Preparation checks one of exactly two preplaced account assignments. The factory retains the actual lease before native Profile reads, checks its Profile/base selectors, then binds the canonical installed runtime generation once to the original projects lane. Another live epoch rejects. Lease shutdown joins that lane’s actual work and held results after runtime joins native/save/execution writers; it never returns persistent capacity or remounts storage. Local indexes and environment execution writes receive no grant.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [work queue](src/work-queue.ts) reserves global and per-lane bytes before admission, bounds concurrent and queued work, cancels queued work without starting it, and keeps running work after its caller aborts or times out. Every operation requires a positive safe-integer reservation that includes its overhead. Zero is refused before backend invocation, so retained records cannot bypass the resident budget. A settled successful result retains its reservation until its consumer releases it. Closing a lane stops new work while preserving unresolved records; closing the queue stops all lanes.

Settlement observers run independently: a failed observer is reported without preventing budget release, later observers, or queued work. A failed reporter falls back to a default-enabled diagnostic without exposing the original exception text. A final abort check immediately before the deferred backend invocation prevents cancelled work from starting.

The [file work owner](src/work-owner.ts) consumes runtime-owned account binding, operation-id, participant, and receipt types. It binds an internal object-capability lane to an exact generation and a trusted current-owner callback, refuses another generation while the first owns work, and reports unknown until actual work and held results settle. Lifetime abort stops admission, and expired drain waits remove their settlement observer while the owner continues tracking work.

The private [directory responsibility](src/directory-responsibility.ts) registers retained ownership and preparation I/O atomically on that same lane. Its [budget calculation](src/directory-budget.ts) reserves bounded intent and identity copies, records, one observer, result frames, and one complete cleanup scratch area before dispatch. Actual preparation settlement returns running capacity and its I/O bytes; created or unknown responsibility keeps a positive reservation and operation id. Observer abort or deadline does not cancel this ownership. Only the original private responsibility may schedule cleanup through the shared running/queued limits, using its retained scratch even after business closure. Exposure is irreversible; exposed or unknown responsibility cannot be declared clean, and unresolved responsibility prevents lane retirement or a new epoch. The base scheduler accepts audited component callbacks, which provide no filesystem authority or kernel evidence. A privileged root-owned isolated tmpfs fixture grant, or a deployment-owned exact independent ext4 mount grant, can derive a fixed single-leaf port; this is not a production grant issuer or an account provider. Server-selected intents admit the fixed default leaf `default-workspace` and a new project’s once-generated UUID; valid spelling and an AccountLayout object do not grant write access. Root shutdown closes ordinary admission first and retains idle slots for explicit cleanup of original responsibilities. Cleanup may use one healthy idle slot below the business health minimum; zero healthy slots remains unavailable. Queue overflow never triggers automatic retry or a hidden waiting queue. Slots close only after actual work, held results and responsibilities settle, and the root effect then waits for actual exits.

This internal work port cannot choose another account or close the shared queue; it is not a native filesystem or an issued storage capability. The queue measures reservations rather than enforcing allocation sizes inside arbitrary callbacks, so only an audited bounded backend may submit production work.

The private [Linux worker](src/file-worker.ts) probes the required kernel operation during startup without retaining an account directory. The [ABI 6 N-API helper](native/fd.c) verifies a fixed root identity and uses `openat2` beneath that anchor, with no magic-link, cross-mount or portable fallback. Metadata uses an `O_PATH` FD and returns native version fields for directories or single-link regular files; absent paths return undefined, while special files and hard links are rejected. Nonstream reads close their FD and anchor before replying; streams retain one FD until actual EOF, cancellation, or worker exit.

The same bound lane also exposes a read-only [directory port](src/directory.ts) with `canonicalPath` and `isDirectory`. Its helper observes bounded physical FD spellings, reopens beneath the same anchor to compare identities, rechecks the anchor, and closes descriptors before success. Target ENOENT/ENOTDIR can be definite missing/non-directory failures; anchor loss, verification failure, capacity, stale generation, cancellation, and transport faults remain unavailable with their causes. The private `DirectoryMetadataFailure` records the reason and failed stage. This port has no `ensureDirectory` and cannot be installed as the complete native Workspace directory dependency. Read-only Linux coverage does not certify creation or cleanup; ABI 6 requires separate published-worker verification.

ABI 6 adds self-contained single-leaf preparation and exact empty-directory removal at mode `0700`, with a real tmpfs backend check. A fixed 64-byte frame records mutation phase, parent/leaf identity, original mkdir errno and actual descriptor closure. ABI 6 separates the tmpfs branch from the ext4 branch, which requires the exact mount id, ext4 type, filesystem-root inode, and same-mount lookup. Persistent prepare synchronizes the leaf and its parent; persistent cleanup synchronizes the parent after removal. Success requires explicit mount and sync facts. A sync failure after mutation keeps unknown responsibility. These kernel observations do not establish deployment ownership, physical capacity reserve or production authority. Confirmed not-created failures reject the business operation and settle its temporary responsibility; cancellation after a fully verified created frame retains identity and responsibility. Failed post-create parent verification permanently disables cleanup even if the path or window assertion later recovers; lost replies, worker faults and ambiguous outcomes remain unknown. Cleanup requires the original private identity and a still-valid complete namespace exclusion window; empty or missing paths alone never prove safe removal. Close errors retire the FD number before fatal worker failure, preventing a finalizer from retrying a possibly reused number. General recursive preparation remains unavailable; actual published ABI 6 syscall validation remains coordinator-owned.

The [Workspace adapter](src/workspace-adapter.ts) fixes all three native directory methods before native initialization, while the registration window is valid. Its constructor and metadata selection require both the Context and its independent root to hold the exact bound `peAccount` generation. Read methods share the existing pool and lane and check the current graph before and after I/O. They remain available after the registration window closes. Directory preparation, exposure and transfer still require that separate window. `ensureDirectory` admits only the pregranted `default-workspace` leaf; the public native default initializer still decides eligibility, history rechecks and durable identity. The thin override supplies the account project address instead of the desktop Documents resolver. After the window closes, native default initialization can still return an existing default or its deleted/ineligible state; an actual request for a new directory rejects before a ticket or mkdir. New projects receive a once-selected server UUID grant, independently of the display title, then use the original native `create` operation.

Temporary directory responsibility transfers only after the actual native registration Promise fulfills with a Workspace. The private adapter verifies the original ticket, current unpublished graph and each candidate’s complete namespace window, matching physical path, and internal FD identity before and after registration. Native cache membership is only a cross-check. Transfer releases the retained reservation without removing the directory or retaining a project-to-ticket map. Undefined results, rejection, late graph closure, identity mismatch and lost preparation waits retain unknown responsibility and prohibit cleanup; a later successful preparation reply cannot reverse that uncertainty. Ordinary prepared-leaf controls remain exposure and cleanup only.

The native Registry’s internal `createS2Project()` obtains the actual default Workspace result and derives a separate project root from private worker metadata on the same lane. The [S2 provider](src/s2-project.ts) implements the complete native FileSystem method table while granting only `resolve`, `stat` and `processPath`. Content reads, listing, preview, watching and mutations reject with native filesystem errors before dispatch. Its fixed graph-owned `projectDirectory.prepare(cwd)` validates that registered directory through the same project reader after registration closes; it never creates a directory from the supplied address. Constructor installation checks the original account root and refuses a duplicate provider. Deleted Workspaces, stale generations, replaced anchors and forged targets reject. The [account owner](src/account-service.ts) installs these native providers through `/account`; this component does not issue a production storage capability.

An owning graph may explicitly request `createTextFileSystem(actualDefaultWorkspace, assertInstalled)` from its existing bound port before installing its sole filesystem. The opt-in [text provider](src/text-project.ts) requires the original Registry Workspace object, exact account binding and current installed graph on every call. It supplies native target resolution, metadata, process paths, file URLs, containment, bounded text reads/streams and `writeText`; other content methods reject. Canonical path keys remain stable across atomic replacement and aliases. The original S2 provider and its default selection remain unchanged.

The default helper build remains ABI6. A separately named asset built with `-DDSH_FD_TEXT_ABI` reports ABI7 and adds bounded text publication; it must not replace a running ABI6 asset. The worker accepts both, but ABI6 text writes reject before dispatch. Existing `maxReadBytes` bounds complete raw text reads, UTF-8 write input and optional prior context; context at the cap or containing binary/invalid UTF-8 returns `before: null`. Result context normalizes newlines while stored and read text retain the supplied bytes. No additional text-limit setting is introduced.

Text mutations enter the original bounded queue before waiting their turn, then serialize all writes on that bound lane, including aliases. The ABI7 transaction requires an existing canonical parent, creates its own exclusive same-directory temporary file at mode `0600`, writes and synchronizes it, rechecks root/parent/target identities and version, publishes by rename and synchronizes the parent. Create-if-absent and replace-if-version use the native intent and error taxonomy. It rechecks publication and closes descriptors before success. Confirmed prepublication failure removes only its exact temporary identity and synchronizes cleanup. Native write cancellation and queue deadlines signal actual I/O without ending the native wait ahead of its reply: cancellation after publication returns the confirmed outcome once received. A queued write can cancel before backend invocation. The original task retains the result reservation until its native consumer releases it. A lost reply, uncertain publication, failed cleanup or ambiguous closure retains the original operation id and full positive reservation, rejects later writes and prevents a clean account drain. No automatic retry or recovery declares such work clean. This slice grants no recursive parent creation, external-writer compare-and-swap, attachment staging or `editText`.

The graph-owned account owner retains one installation Promise through actual settlement. It rechecks the exact binding, original native providers and unpublished window after awaited installation work. Repeated installation from the same entry joins that Promise; another entry rejects. A partial or failed installation never returns a project or certifies cleanup. Native fibers retain provider teardown, the existing lane retains uncertain directory responsibility, and runtime retains graph drain and shared-pool ownership. The returned directory capability rechecks both original providers before and after its real same-lane directory validation, including after registration closes.

The bound port exposes an internal [reader](src/read-only.ts) with the native `resolve`, `stat`, `streamText`, and `processPath` signatures needed by account-instructions. Resolution stays within its previously authorized root and issues opaque targets; every later operation checks the exact issuing reader and current epoch. Absolute paths never select another project. This adapter supplies no complete filesystem service or trusted-root issuer.

`withInstructionReaders` requires the account owner's exact registered Workspace and a storage-owner-issued private parent. The parent grants metadata observation only: an existing `instructions` directory must resolve to its own verified root before any account content reader is issued; only confirmed absence omits that source. Project and account readers share one positive snapshot reservation and one borrowed worker, without nested queue admission. Actual source reads and closure settle before a successful result is returned; its complete reservation remains held until release. The caller still owns exact active Agent/Session admission, and the account owner rechecks its original providers and Workspace around the operation.

The [shared root pool](src/worker-pool.ts) prebuilds a fixed number of workers and reuses them across bound accounts. Binding and reading create no workers; failed workers are not automatically replaced. Each operation obtains one queue reservation for request/result buffers. A text stream holds its slot between pulls, grants one chunk credit, and uses `readChunkBytes` per chunk and `maxReadBytes` for the complete raw content. It reads at most the total cap plus one byte, decodes UTF-8 across chunks, and uses the native fatal-decoding and first-8192-byte NUL-sample rules. Early consumer return cancels the operation without declaring its FD closed. After I/O closes, a paused iterator retains the same reservation for its decoded chunk until it finishes or returns. Consumers must finish or return their iterator. The [transport](src/worker-client.ts) waits for a real reply or actual exit after cancellation; malformed replies and worker errors stop admission, and late replies cannot reverse a transport failure. Account drain closes that generation and signals active I/O while preserving the shared pool.

The [root effect](src/root-lifecycle.ts) retains root reservations and the files participant until root probes actually finish, all workers exit, and all account work and held results settle. A bounded shutdown may report unknown; the effect continues owning cleanup and keeps registration and the root service until actual closure. Pool lifecycle alone grants no project root.


The [static storage owner](src/storage-owner.ts) reads a root-owned, hash-pinned deployment record through the separate read-only [probe ABI1](native/storage-probe.c). Root writes it after allocating and synchronizing the actual retained backing resources. Existing slots measure ext4 identities, finite byte/inode geometry, backing metadata, arena free reserve, protected ancestors and application permissions. Root initialization requires a read-only application root, the recorded nonroot UID/GID, zero capability sets, NoNewPrivs and seccomp. These observations do not identify the seccomp filter or device policy: trusted Root composition must retain that confinement and verify real denied mount/device/loop/execute attempts. Host or whole-VM storage failure is an infrastructure fault; account-approved writes causing another account or control failure remain a deployment failure. Hashes and requirement numbers cannot replace live observations or Root’s resource ownership.

Root probe configuration reserves bounded record/proc/asset copies, native scratch and retained facts globally before account admission. One account verification runs at a time. The two fixed assignments retain at most two preparation/lease records and join verification serially; duplicate generation inputs share the same Promise. A failed verification closes admission, while root closure or an aborted queued lifetime rejects before further I/O. Pending verification remains owned until it actually settles. Observation expiry retains the busy slot, root operation id and reservation until an actual reply or exit. Neither component transports nor macOS can issue a real storage owner. ABI6 and its S2 behavior remain separate; Linux helper compilation, actual confinement, byte/inode exhaustion and continued control/account writes require deployment verification.

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

The entries register no tools, prompts or model context. A prepared `/account` defaults to a native filesystem restricted to S2 metadata methods; a trusted preparation factory can explicitly select the bounded text provider. Ungranted file operations reject. Missing runtime preparation prevents installation, and root-pool startup does not enable model file operations.

#### Token effect

Zero direct token effect.

#### KV Cache effect

The package adds no model request content and changes no reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Production activation of the complete S3 file capability still requires the following integrations.

- The shared root pool provides a complete Workspace metadata adapter inside a trusted isolated graph. Registration transfer requires its unpublished window; metadata reads can continue while the published graph remains current. This lifecycle distinction supplies no production storage authority. Static admission covers exactly two Root-preplaced independent private/projects domains and bounded auxiliary mounts. Dynamic allocation, general recursive preparation and live concurrent registration/deletion remain unavailable. The explicit text and instruction-reader paths do not establish complete S3 acceptance, complete target/write coverage, link-race acceptance or complete allocation accounting. A backend string or statfs result cannot supply actual deployment ownership, privilege exclusion or all-writer byte/inode reserve.
- Runtime binding and receipt types are consumed from the runtime package. Root registers the files participant after worker startup, but the trusted factory must retain the actual storage owner/lease before Profile I/O and connect the complete approved recipe before production use.
- The default S2 FileSystem grants metadata methods only; trusted preparation can select the bounded text provider and fixed-source `withInstructionReaders` described above. Complete stream/directory/write coverage and accounting, attachment intake/staging and skill projection remain unavailable. These explicit additions do not certify a complete S3 or real Web flow. Both helper binaries must be built and pinned by the reviewed Linux deployment recipe; the package does not ship a preverified binary.
- Workspace source tests use real native Loader, JSONL and JSON StorageDomain with a test-only Node-backed worker transport; they establish no kernel or quota facts. Separate published ABI 6 Linux checks verify exact ext4 mount identity, reject a wrong mount id and a same-device nested bind, and restore the same native Workspace and Session JSONL event hash after clean unmount and a new container/Node process. These component checks do not validate the account entry’s complete product recipe. Directory-sync fault injection, native WorkingDirectory/SessionController composition, production all-writer isolation and hard quota, total physical reserve, crash/power-loss recovery and a Web flow remain separate requirements.
- Text source tests also use that test-only Node transport. The opt-in [ABI7 Linux check](tests/linux-text-interop.mjs) requires the separately built helper, published worker entry and an approved test parent. It checks native create/update/version outcomes, bounded context, link rejection, prepublication cancellation, temporary cleanup and descriptor closure. It does not establish deployment isolation, running-cancellation fault coverage, sync-failure recovery or crash/power-loss durability. Published ABI7 verification remains required before using the new candidate; no verified binary is supplied here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
