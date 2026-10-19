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

The root Loader entry is `/root`; the package entry re-exports its named `name`, `inject`, `Config`, and `apply` without a default export. The named `PeAccountRuntime` class remains available for capacity/participant component composition, using its capacity-only `Config`. `/account` accepts empty configuration only, rejects identity or other JSON fields, and verifies the immutable `peAccount` contribution installed by the private factory. `/types` contains shared data declarations, and `/schema` exposes separate capacity and complete root deployment parsers.

### Configuration

The component requires the three positive safe-integer limits below. The actual Loader entry additionally requires every field in [the Host deployment schema](src/root-config.ts); capacity-only configuration cannot launch root control. No deployment defaults are inferred.

| Field | Default | Meaning |
| --- | --- | --- |
| `maxMountedAccounts` | required | Account slots and the bound on pending/unknown owner-write responsibilities. |
| `maxConcurrentMounts` | required | Actual mount operations that have not settled. |
| `maxConcurrentDrains` | required | Actual drain operations that have not settled. |

Actual root configuration includes `recipeVersion`, `internalAddress`, explicit heartbeat/startup/shutdown/account-observation budgets, secret-resolution time and byte limits, PostgreSQL connection fields and `passwordRef`, finite `pg`/`factory`/`saves` capacities, normalized shared/local paths, and fixed native recipe locations, required-entry and diagnostic bounds. The root requires the formal `credentials` service. It preflights the reference and resolves it again for each actual PG connection; it neither reads `process.env` nor uses an account's credential provider. Abandoned resolution stays counted until actual settlement.

The function entry constructs one existing capacity owner, PG executor, process-registration component, owner store, account factory, and API configuration-save coordinator. It migrates both control tables and registers the generated process identity before exposing active root control. It does not wait for downstream files/execution contributions during initialization; participant checks belong to account acquisition, avoiding a Loader injection cycle. During native preparation the factory issues the coordinator's barrier from the exact installed binding, retaining it through actual saves and the remaining account drain checks.

`locateAccount()` reads actual PG metadata; `acquireAccount()` requires a current recipe seal before any owner claim or native graph creation, then enters the retained factory using root-selected inputs. `borrowAccount(binding)` requires the seal and takes an independent reference to that exact ready generation for a login Peer; it never claims an owner, mounts an account or substitutes a newer graph. `assertMountCurrent()` checks installed preparation/current identity; `assertBusinessCurrent()` additionally requires the seal and the factory's ready state. Neither active root control nor a native mounted result publishes account readiness.

Providers register the mandatory `files` and `execution` participants through the root service. Registration belongs to the calling fiber and rejects duplicates. A missing participant rejects mount capacity reservation; passing this check is not recipe sealing. Configuration saving has a separate API-owned barrier and is not a third participant.

The account factory owns each capacity reservation until the actual work settles. `settleMount()` releases the concurrent mount slot while retaining the account slot. `releaseAccount()` rejects while mounting or draining still holds that account. A request timeout does not authorize either release. Root unload stops new admission and joins actual control cleanup before closing capacity. Observation expiry reports uncertainty and retains the actual shutdown Promise.

### Root recipe admission

`sealRecipe()` audits actual Root Loader entries, original module namespaces, unique service implementations and their owning fibers, the API provider's exact frozen manifest, and files/execution registrations against their actual providers. It checks native configuration snapshots and provider health rather than accepting a readiness flag. Authentication health also requires its actual ingress to remain installed and current; resource-only initialization cannot satisfy Root admission. The eleven-role catalog fixes entry scopes: five roles activate in Root; account, Session and client roles remain declarations for their own graphs and are never activated for this audit.

`inspectRecipe()` returns frozen counts and finite issue identities without paths, credentials or provider objects. Loader changes, provider replacement or closure, participant removal, explicit `revokeRecipe()` and runtime closure invalidate the retained audit. `assertRecipeSealed()` rejects admission unless the complete audit and the original files pool/storage owner remain current. Missing actual storage still rejects with `storage-root-capability-missing`. The existing AppReady callback attempts this full audit after successful native startup; the notification itself grants no admission.

### Account policy

The actual Root request supplies one shared project/model/Preset policy to Controller, AgentLoop and LLM admission. Its required `accountPolicy` fields select exact deployment data; none opens business admission.

| Field | Meaning |
| --- | --- |
| `maxModelRoutes` | Positive finite upper bound on the nonempty `models` list. |
| `models` | Unique exact `{provider, model}` pairs; no implicit provider, model or wildcard matching. |
| `maxPolicyStringBytes` | Positive UTF-8 limit for provider/model, Preset id and both native entry ids. |
| `presetId` | The single approved native CloudPreset and configured default. |
| `presetEntryId` | Actual Loader declaration, implemented by native `agent-preset`. |
| `agentLoopEntryId` | Actual guarded native AgentLoop entry, whose startup agents remain empty. |
| `presetConfigSha256` | Exactly 64 lowercase hex characters for the trusted resolved declaration's canonical JSON digest. |
| `maxPresetConfigBytes` | Positive bound on canonical UTF-8 digest input and its traversal. |

The declaration digest uses SHA-256, sorted object keys and original array order. Functions, JS expressions, non-JSON objects and aliases reject. The bounded encoder rejects excess input during traversal. Approval also requires the original active Loader entries, unchanged native configuration plans, actual Preset inventory and the Agent's retained composition without leaked services.

Business callbacks select an original Workspace from the same native Registry. `project()` remains the bootstrap default; explicit create requests can select another registered Workspace. History, prompt and resume require unique original Workspace membership before private Session observation and retain complete persisted-header, projection, directory and fixed Preset checks. Explicit creation accepts only native notfound for an id absent from that account's Registry membership; member missing-log errors and other query failures propagate. Independent accounts may create the same SessionId in their separate stores. Ordinary cold JSONL restoration preserves its SessionId; imported/forked or subagent identity remains rejected. Exact model routes require the original registered provider and native model resolution with current checks around awaits. Guard construction reads no partial files project.

The single account FS receives a lazy shared selection callback. Original `workspaceFiles` invocations first require the selected RPC/stream category through the original API owner, including its current unique native registration; unselected or withdrawn registrations reject before shared project selection. Native tool calls require the exact published Agent, Session and membership, with any tagged caller's opaque scope key in that Agent's retained native scope chain; shared account services may be untagged, and an inherited causal parent alone grants no tagged child access. Native `workspaceFiles` calls use their original invocation SessionId. Cold file selection reads only the actual persistence header after membership admission, checks fixed Preset/current owners, and never loads full Session messages or treats a target path as project authority. The returned selection rechecks the same original Workspace, owners and membership. There is no mutable active project or default fallback for file calls.

The same policy supplies the API's read-only bootstrap assertion through a lazy closure. If any `workspaceFiles` endpoint is selected, it also requires the original Files owner's `assertContentAvailable()` before and after awaited checks; metadata-only S2 cannot pass file-enabled readiness. Recipes without file endpoints retain the earlier prerequisites. Root passes its existing `native.maxEntries` as the shared bound on selected exposure rows and visited native runtimes/fibers; no additional deployment value or default is introduced. It checks the original Workspace, fixed native Preset/default/composition, current default model metadata and actual native handlers, rechecking providers and selection after awaits. It prepares no directory, creates or resumes no Session/Agent, resolves no credentials and requests no model inference. Construction reads no unfinished files project and captures no request `AccountUse`. The assertion does not replace production storage handoffs or Root sealing.

Optional `native.firstScreen` selects the fixed readonly first-screen slice. When present, `maxHomeBytes`, `maxCollectionItems`, `maxFrameBytes`, `maxQueuedEvents` and `maxQueuedBytes` must all be explicit positive finite safe integers; omission keeps the slice closed and supplies no defaults. Root passes those original budgets through its recipe, derives the expected home from the same account's canonical Profile, and checks home agreement before native boot. The existing `native.maxEntries` still bounds native owner/marker inventory. Metadata and configured entry names cannot satisfy the actual prepared audit.

Private builtins supply only the guarded Workspace/Settings constructors and the retained original event-registration Loader scope. Constructors do not read an unfinished files project. Unpublished bootstrap first obtains the actual files project, requires the original shared readonly Session policy, registers the real Gateway event source, then performs `auditPrepared`; business-ready publication and the later `assertBootstrapCurrent` remain separate. The shared policy accepts the original live Session/Agent metadata before Workspace attachment, checks cold list metadata against the original Workspace relationship, and creates no second Session store, membership cache or ProjectScope from an id/cwd. Stop joins event withdrawal before calling the original `AgentLoop.stop()`, checking native idle and flushing persistence. A source/disposer failure stays unconfirmed and cannot establish clean release. Integration passes the existing `maxQueuedEvents`, `maxQueuedBytes` and `maxFrameBytes` to both the guarded reader and original Gateway registration. The reader captures them for the original protected control-buffer hook; each native control generation and event client uses the original bounded queue. A downstream slow-reader overflow terminates only that stream, while actual source failure retains the existing audit-withdrawal and unconfirmed-cleanup behavior. No new configuration field, budget default or queue is introduced.

Graph preparation also creates an account-local `AccountInstructionSources` service when the original files owner exists. Its callbacks reuse the shared active-Agent project/model/Preset checks and the files owner's independent source readers and complete snapshot reservation. The fixed Preset loads the original `/session` namespace through its prepared builtin. Preparing the adapter starts no source I/O and does not enable instructions without that Preset row.

Optional `native.attachments` supplies explicit surface-node/ref/metadata limits, prompt and upload capacities, intake reservation and native pending-receipt count. Omission keeps the two attachment builtins closed. Preparation selects one native store and one FileUploads service, and delegates the Controller's awaited file hook to the original same-Agent receipts. A prepended pre-step listener collects the bounded native Session surface plus claimed messages inside the files reservation before other listeners price or consume paths. The final native LLM request may use only that prepared set; its original messages and durable refs remain unchanged. Exact current Agent/project/caller checks guard both synchronous path mappings. Results live only through that request, are withdrawn on rejection, idle, disposal or lifetime end, and retain their original resident budget until release. The current host filesystem maps the verified copy to itself; a later sandbox backend requires its own same-file mapping acceptance.

### Account layout

`/types` declares one `AccountLayout` for shared private/Profile/patch, credentials, Sessions, storage, attachment originals, skills, instructions, projects, environments, and the process-local Session index. `AccountMountInput` pairs those addresses with the existing binding, startup InstanceId, and native `LaunchEnvironmentSnapshot`. These are trusted assembly data; paths grant no directory access, readiness, or quota evidence. Credentials go only to their required native consumers.

The private [address helper](src/account-layout.ts) accepts explicit normalized POSIX shared/cache roots and a positive finite UTF-8 byte limit. It bounds characters before scanning UTF-8 and checks every output. A fixed v1 domain and explicit byte length frame the exact authenticated id before SHA-256; no raw id or title becomes a directory segment. Shared paths stay stable across epochs and process restarts. Only the rebuildable local index includes the startup InstanceId.

The default project candidate uses the fixed `default-workspace` basename, preserving native title handling. Native eligibility, history checks, and the default-deletion marker still decide initialization. New project candidates use a server UUID selected once; callers retain that candidate through actual preparation. The helpers create no directories or Workspace records. Real parent protection, FD capabilities, quota, and current-generation checks belong to files/deployment and the runtime lifecycle.

### PostgreSQL owner storage

The private owner store accepts a root-owned PostgreSQL query adapter and a server-generated instance identity. The same-package account factory owns this implementation; it is not an exported account-management SDK. The adapter binds parameters and enforces finite connection, statement, and query budgets. `migrate()` runs atomic DDL for `pe_account_owners`; concurrent migration calls serialize in PostgreSQL, and incompatible existing columns or constraints reject without resetting rows.

The private [pg adapter](src/owner-pg-executor.ts) uses `pg@8.16.3` with one statement per connection and no hidden pool. Explicit constructor limits bound connections, queued submissions, queue/connect/server statement/lock time, observed actual Promises, and concurrent waiting observers; the actual root requires the same values under `pg`. `ClientConfig.query_timeout` is zero; a nonzero shared pg query-timeout default rejects before connection setup. A query retains its slot through actual driver settlement and connection end; no connection is reused. Server `statement_timeout` bounds execution, and a submitted write failure still has an unknown outcome to the store.

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

The [root service](src/root.ts), [PostgreSQL owner store](src/owner-store.ts), [capacity bookkeeping](src/capacity.ts), [private binding handoff](src/binding.ts), and [shared types](src/types.ts) define the implemented behavior. The [component Loader tests](tests/runtime.spec.ts) cover capacity/registration inputs; [actual root tests](tests/root-control-postgres.spec.ts) use a separately assigned PostgreSQL database for function-Loader migration, registration, heartbeat, factory refusal and shutdown; the [PostgreSQL tests](tests/owner-postgres.spec.ts) execute CAS and migration cases against an explicitly assigned test database, with synthetic teardown evidence.

The private [native Profile adapter](src/native-boot.ts) uses public app boot to create an independent root, provide a copied ProfileContext, explicit launch environment and immutable binding in `prepare`, and mount the root Include once. Construct, verify, and inject every save/files/execution port inside `prepare` from the exact installed binding, retaining its graph lifetime. After awaited setup, preparation rechecks the installed lifetime and close request before returning to boot. If the generation ended or closure was requested during setup, no Include entries start, and actual cleanup remains awaited. The runtime still disposes already mounted graphs. It installs no account CLI, signals, proxy, watcher, or code HMR. Its caller must verify the real root capabilities and fixed recipe before invoking it. A mounted result only establishes native assembly. The retained boot/disposal Promises and bounded error observation include partial startup and asynchronous disposer failures; an error or observation overflow prevents confirmed native disposal. This observation does not establish business-work drain or account clean.

The private [mount bridge](src/account-mount.ts) checks Profile directory, patch, home, and default-project candidate against the canonical layout and passes the exact native `LaunchEnvironmentSnapshot` object to boot. The private [factory](src/account-factory.ts) retains one actual operation per account. Calls with new outer request objects still merge when account/instance/recipe values and trusted resource references match; a different binding, recipe, environment, or deployment rejects. Finite removable waiters share one settlement subscription; deadline or observer cancellation neither stops the mount nor releases its capacity.

The factory's [native integration](src/account-native-integration.ts) creates the public `CloudAccountApi` owner and installs the actual Root-issued closed-execution port before Include. The fixed private `ACCOUNT_NATIVE_ENTRIES.workspaceFiles` builtin activates only through an explicit recipe entry. It retains native WorkspaceFiles Config and all native injections, adds `peCloudApi`, and constructs the unchanged service through the original API owner. Recipes must install the real sandbox-policy provider with an explicit deployment mode and fallback root; that fallback supplies no project authorization. Fixed private builtins consume the API's native editor/credentials providers, Controller, AgentLoop and LLM guard. A restricted files lane constructs the original `CloudAccountFiles`; its `/account` entry owns native Registry/default/FS installation. After API business admission, directory preparation derives `projectFor(workspace)` from the original registered Workspace and rechecks binding, owner and Workspace after awaits; fresh capability wrappers need not share object identity. Instruction preparation selects the Agent's Workspace before reserving the complete snapshot and uses synchronous shared checks inside the reservation. Native dependencies can activate while files initialization remains pending; required-entry checks and business admission still prevent incomplete publication. Missing files or shared guards remain closed.

When the selected manifest includes `cloudProjects/create`, preparation requires the original `borrowAccount` callback. The handler checks current Root/business admission, borrows the exact ready account, fully awaits the original files owner's creation, checks the returned native Workspace, and returns its native WorkspaceValue. The original borrow is released in `finally` after creation settles, including abort and error paths. Omitting this endpoint requires no creation borrow.

Factory shutdown closes admission and the graph lifetime, joins the original save barrier, calls the original AgentLoop service’s terminal `stop()` while its fiber and persistence providers remain mounted, verifies the original AgentRegistry is empty and flushes SessionPersistence before withdrawing native hooks and disposing the graph. It joins remaining borrows and the actual execution/files participants before closing the original storage lease. Clean owner release additionally requires confirmed native disposal, save and participant evidence and the actual PG drain/release CAS. Unknown work or metadata outcomes retain capacity and ownership; Root keeps its control resources when account drain remains unknown.

Mount capacity settles with actual startup and any started native cleanup. Account reservations survive native-only disposal because it cannot prove full drain. Factory shutdown closes external admission while retaining internal drain reservations and native disposal ownership; unresolved cleanup retains its drain capacity. Only a definite pre-claim or never-submitted failure with no native resources releases an unstarted account slot. Submitted uncertainty keeps the original slot and prevents blind restart.

The actual root refuses acquisition before PG claims while its recipe is unsealed. Its private request retains the original storage owner and the same coordinator, exposure policy, execution issuer and [concrete account policy](src/account-policy.ts) consumed by native integration. The factory obtains the original storage lease before any Profile/patch or native configuration read, records the canonical installed binding before its single files bind, and audits the actual project, closed execution and native API while unpublished. Root, lease and binding checks surround the actual ready CAS. Only then may the exact live graph issue `AccountUse`; release is idempotent and does not cancel an Agent. The separate native-only path grants no `AccountUse`.

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

Production admission requires the complete actual Root/storage/native composition; component fixtures cannot establish production readiness.

- **Account factory** — the production chain requires the original files storage owner, prepared native audit and actual PostgreSQL ready CAS. Persisted-account recovery, authenticated Web and the complete Linux recipe still require integration acceptance; a component text turn or cold read grants no production `AccountUse`.
- **Root sealing** — the original files owner must directly revalidate protected deployment records, current mounts, writer namespaces and byte/inode/private-reserve bounds. Missing or revoked storage keeps admission closed. Non-Root declarations still require checks in their actual account, Session and client assemblies.
- **Layout integration** — the private native bridge checks layout/Profile agreement, but layout data cannot create files capabilities or validate storage. The environments parent is included; per-Session environment derivation is absent.
- **Database integration and recovery** — actual root owns PG deployment configuration, migrations, registration, and serialized instance heartbeat scheduling. Recovery audit, allocation reconciliation, and trusted RecoveryProof application remain absent; quarantined ownership cannot be reclaimed here.
- **Required evidence** — participant presence does not verify storage quotas, stopped processes or complete account disposal. Private Profile/patch reads and every native configuration/JSONL writer require real all-writer storage authorization before boot; prepare-time directory approval is too late. Capacity reservations perform no participant drain.
- **Account handoff** — only the same-package factory helper installs a binding. The helper requires trusted owner input and does not itself verify PG ownership; tests supply binding fixtures without claiming an account graph is ready.
- **Shutdown** — complete native/save/persistence, execution/files and owner-store settlement is required for clean account release. Unknown account work retains Root control resources. Recovery from retained failures remains closed; native-only disposal cannot release a production owner.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
