# Cloud account integration

English | [中文](cloud.zh.md)

The [cloud package map](../../packages/cloud/README.md) locates the optional deployment components. This reference describes their shared runtime inputs; package READMEs own activation requirements. These components do not add a Session implementation.

<a id="account-identities"></a>
## Account identities

The runtime package owns [account identity and lifecycle types](../../packages/cloud/pe-cloud-runtime/src/types.ts). `AccountId` identifies an authenticated database account. `OwnerEpoch` preserves the PostgreSQL decimal value without conversion to a JavaScript number. `InstanceId` identifies a server process start, and `OperationId` identifies actual work whose responsibility may outlive a request.

`AccountBinding` is immutable trusted input for one account graph. Its lifetime signal belongs to the graph; cancelling a caller's wait does not cancel that lifetime. `AccountUse` borrows a native Context, checks current admission immediately before native work, and releases only the borrow. Neither value is accepted from browser JSON.

`AccountStorageKey` is a stable, server-derived directory key. `AccountLayout` contains immutable absolute addresses for shared account data and a process-local rebuildable index; addresses establish neither existence, filesystem authority nor quota. `AccountMountInput` combines that layout with the exact graph binding, current process identity and native `LaunchEnvironmentSnapshot`. Runtime derives account and project candidates before files verifies or prepares them; default-project eligibility and registration remain native Workspace responsibilities.

The private native boot adapter installs an independent `ProfileContext`, launch environment and account binding before mounting one native root Include. Port preparation receives the exact installed binding. After preparation, the adapter rechecks that lifetime before returning control to native boot; boot and disposal retain their actual Promises after a caller stops waiting. A mounted native tree still requires the factory's provider, save and exposure audits before it can serve an account.

<a id="actual-work-and-capacity"></a>
## Actual work and capacity

The runtime root registers exactly two required participant categories: `files` and `execution`. Contributions belong to their caller's Cordis effect and disappear when that effect is disposed. Duplicate registration and missing participants reject mount-capacity reservation.

`RootMetadataDatabase` is a runtime-issued parameterized-query capability for an original Root participant with `closeRoot()`. It shares the runtime executor without exposing credentials, database selection or driver closure. Withdrawal and Root shutdown join that participant's actual cleanup before revoking its borrowed capability; unresolved cleanup retains ownership. Its `wasNotSubmitted()` predicate recognizes only the original adapter's settled failures before SQL submission.

`ParticipantReceipt` identifies its account, epoch, participant and evidence. A confirmed receipt has no pending operation ids. An unknown receipt retains pending work and a reason; a request deadline or rejected wait does not establish that actual work stopped.

Local mount and drain reservations bound concurrent work. Settling mount work releases its operation slot; the mounted-account slot remains reserved until its owner releases it after actual cleanup. These reservations do not acquire a database owner or establish account readiness.

The files root prestarts a fixed worker pool. Account drain retains the shared pool; root shutdown retains the service and participant until workers exit and held results are released. API configuration-save receipts separately track admitted native writes and required application through their actual Promises. Configuration saving is not a third drain participant, and failed or unresolved saves cannot establish a clean graph.

<a id="native-adapters"></a>
## Native adapters

Cloud request consistency uses the [access-owned request types](../../packages/cloud/pe-cloud-access/src/types.ts). Client account and generation fields are expectations, not authentication credentials. Native HTTP, stream and controller adapters retain the original transport messages and native Session state.

Access owns `CloudBootstrap` and its browser-safe `decodeCloudBootstrap` validator. The response contains display identity, recipe, opaque connection generation and redacted capabilities. `BootstrapDecodeLimits` bounds compact JSON bytes, UTF-8 string bytes and combined list entries; the carrier separately bounds raw response bytes before JSON parsing. Decoding returns detached, deeply frozen metadata and establishes neither authentication, feature approval nor account readiness. Disabled capability descriptions distinguish unapproved features from temporarily unavailable channels; configuration fields describe allowed choices and application levels without carrying values or submission authority.

`PeAuthService`, installed by access/root, owns one finite PostgreSQL pool, official credential reads, actual Better Auth initialization and schema inspection. `AuthRootConfig` adds explicit database, pool, secret and startup budgets to browser-safe access settings. Its observation exposes bounded resource counts and closed request admission. Missing schema or initialization failure retains cleanup; the provider executes no migration and registers no route. Shared HTTP/WS admission still requires runtime's actual root recipe audit and account providers.

Trusted runtime preparation installs `CloudAccountApi` with the exact account binding, root-issued configuration-save barrier, deployment exposure ceiling and separate mount/business admission checks. Its fixed native editor and credential constructors install save hooks before initialization. Controller, AgentLoop and LLM installation reuse existing native guards; `/account` checks this prepared service. Installation and entry activation do not publish readiness. Every business operation requires the separate current-ready check, while inventory auditing and terminal save settlement retain their own lifecycle rules.

The native Session adapter preserves original dispatch, DTOs and Session state while guarding actual effects. Its awaited directory preparation uses the account's fixed files capability before Agent creation. Production routing, project/Preset/model checks, actual native inventory and durable storage authority remain required before account publication.

`CloudProjectCreateRequest` carries only an optional title; `CloudProjectsPreparation` captures the trusted allocator used by `CloudProjectsService` ([declarations](../../packages/cloud/pe-cloud-api/src/cloud-projects.ts), [request](../../packages/cloud/pe-cloud-api/src/types.ts)). `NativeUploadPreparation` supplies the pending-receipt limit and awaited stream-persistence hook while the native upload service owns receipts ([declaration](../../packages/cloud/pe-cloud-api/src/native-uploads.ts)).

Files-owned `ResidentResult<T>` pairs a value with its reservation release ([declaration](../../packages/cloud/pe-cloud-files/src/work-queue.ts)). `StageFileResult` pairs native staging facts with the attachment ref and project-relative copy path ([declaration](../../packages/cloud/pe-cloud-files/src/stage-bridge.ts)); `InstructionReadReaders` supplies a restricted project reader and optional account reader ([declaration](../../packages/cloud/pe-cloud-files/src/instruction-read-work.ts)). `EnvironmentSessionId` is the native Workspace membership's Session id type; `ExecutionMountGrant` describes the original binding, Session/project selection, measured project/environment identities and quotas, and read-only `.pe` policy ([declarations](../../packages/cloud/pe-cloud-files/src/environment-bank.ts)).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcloudprojects--cloudprojectsservice"></a>

### `ctx.cloudProjects` — `CloudProjectsService`

One additive Remote capability; directory allocation and native persistence stay with their owners.

```ts cordis-catalog
/**
 * Allocate one project with an optional display title; paths and identities are server-owned.
 * @param request Optional title, trimmed and limited to 256 UTF-8 bytes; explicit blank titles reject before allocation.
 * @param signal Caller cancellation, combined with the captured graph lifetime.
 * @returns The original durable Workspace projection after the allocator settles and admission is rechecked.
 * @throws CloudApiError before allocation for invalid title or unavailable admission; original allocation failures remain unchanged.
 * Cancellation after allocation does not promise rollback. The callback is always awaited; callers must not replay unknown results.
 */
@Remote('create') async create(request: CloudProjectCreateRequest, signal: AbortSignal): Promise<WorkspaceValue>

/** Require the exact original service in both local and root lookups; replacement cannot inherit this callback. */
assertCurrent(): void

/**
 * Inspect the actual Remote marker and installed service for the API's bounded native inventory.
 * @returns Exactly the guarded project-creation endpoint; does not publish readiness.
 */
inspect(): ExposureInventory
```

Types: [WorkspaceValue](workspace.md)

Source: [`packages/cloud/pe-cloud-api/src/cloud-projects.ts`](../../packages/cloud/pe-cloud-api/src/cloud-projects.ts)

<a id="ctxpeaccount--accountbinding"></a>

### `ctx.peAccount` — `AccountBinding`

Trusted immutable input for one account graph; lifetime is never a request signal.

Source: [`packages/cloud/pe-cloud-runtime/src/types.ts`](../../packages/cloud/pe-cloud-runtime/src/types.ts)

<a id="ctxpeaccountexecution--accountexecutionport"></a>

### `ctx.peAccountExecution` — `AccountExecutionPort`

Internal factory capability; it cannot select an account, backend, or process.

```ts cordis-catalog
/**
 * Check the exact issued object, current graph and permanent admission state.
 * @param ctx - actual installation or native caller context.
 */
assertCurrent(ctx: Context): void

/**
 * Refuse user execution before preparation; a pre-aborted caller retains its reason.
 * @param ctx - actual native caller context with its installed port.
 * @param signal - optional caller cancellation; omission adds no caller cancellation.
 * @returns never; no handle or execution-world resource is created.
 */
deny(ctx: Context, signal?: AbortSignal): never

/**
 * Reserve the sole native provider pair for this generation.
 * @param ctx - account Loader effect scope; unloading permanently closes this port.
 */
claim(ctx: Context): void

/** Permanently close only this generation; internal stop observation remains available. */
close(): void
```

Source: [`packages/cloud/pe-opensandbox/src/account-port.ts`](../../packages/cloud/pe-opensandbox/src/account-port.ts)

<a id="ctxpeaccountinstructions--accountinstructionsources"></a>

### `ctx.peAccountInstructions` — `AccountInstructionSources`

Account-owned adapter between trusted source reservations and native Session instruction injection.

```ts cordis-catalog
/**
 * Install scoped turn injection using this graph's original source adapter.
 * @param owner Actual Session plugin scope in the prepared account graph.
 * @param config Validated finite snapshot limits.
 * @returns No value; source I/O starts only when a real turn enters.
 */
install(owner: Context, config: Config): void
```

Types: [Config](../../packages/cloud/pe-account-instructions/README.md#minimal-configuration)

Source: [`packages/cloud/pe-account-instructions/src/session.ts`](../../packages/cloud/pe-account-instructions/src/session.ts)

<a id="ctxpeaccountruntime--accountruntimeservice"></a>

### `ctx.peAccountRuntime` — `AccountRuntimeService`

Shared service definition; providers need no dependency on Host control implementation.

```ts cordis-catalog
/**
 * Borrow the active Root's bounded database for an exactly registered Root shutdown owner.
 * Account graphs receive no such capability; borrowing grants no account or execution authority.
 * @param participant Original registered object with an actual idempotent closeRoot implementation.
 * @returns The immutable Root-only query capability; it cannot close or retarget the driver.
 */
controlDatabase(participant: DrainParticipant): RootMetadataDatabase

/**
 * Audit actual Root facts; missing real storage keeps sealing rejected.
 * @param input Fixed requirements and original object identities, never caller readiness assertions.
 * @throws AccountRuntimeError while any actual Root or storage requirement is incomplete, revoked or closed.
 */
sealRecipe(input: RootRecipeInput): void

/**
 * Require the current complete seal before external admission.
 * @param recipeVersion Exact deployment recipe required by the caller.
 * @throws AccountRuntimeError without a current complete seal.
 */
assertRecipeSealed(recipeVersion: string): void

/** Revoke current audit authority before a recipe change. */
revokeRecipe(): void

/**
 * Inspect current identities and invalidate changed audit facts without issuing admission authority.
 * @returns Frozen bounded counts and finite safe issue identities.
 */
inspectRecipe(): RootRecipeObservation

/**
 * Register the caller-owned files or execution contribution; duplicates and closed admission reject.
 * @param participant Actual files/root or execution/root owner of the tracked work.
 * @returns Idempotent disposer owned by the caller's effect scope; withdrawal also revokes the recipe seal.
 */
registerDrainParticipant(participant: DrainParticipant): () => void | Promise<void>

/** Reject missing mandatory participants; success is not recipe sealing. */
assertRequiredParticipants(): void

/**
 * Reserve bounded actual mount work after participant registration; no owner is claimed.
 * @param accountId Trusted account whose factory owns the local reservation.
 * @returns Reservation retaining mount capacity until actual mounting settles and account capacity through graph disposal.
 */
reserveMountCapacity(accountId: AccountId): MountCapacityReservation

/**
 * Retain a finite drain slot until actual settlement.
 * @param accountId Account already holding this root's local account reservation.
 * @returns Drain reservation released by its owner only after actual drain settlement.
 */
reserveDrainCapacity(accountId: AccountId): DrainCapacityReservation

/**
 * Read actual PG metadata without creating or reclaiming an owner.
 * @param accountId Authenticated account identity selected by trusted access.
 * @returns Current PostgreSQL owner metadata, or undefined for confirmed absence.
 */
locateAccount(accountId: AccountId): Promise<AccountOwner | undefined>

/**
 * Enter actual root acquisition; optional signal abandons only this observer.
 * @param accountId Authenticated account selected by trusted access, never a browser expectation.
 * @param signal Optional observer cancellation; with or without it, the configured account wait deadline applies.
 * @returns Fresh borrow of the ready graph after actual storage/native audits and ready CAS rechecks.
 */
acquireAccount(accountId: AccountId, signal?: AbortSignal): Promise<AccountUse>

/**
 * Borrow only the exact ready generation; never claim, mount or select a replacement graph.
 * @param binding Exact runtime-installed ready generation retained by the trusted caller.
 * @returns Fresh independently released borrow; stale, unpublished and closed graphs reject.
 */
borrowAccount(binding: AccountBinding): Promise<AccountUse>

/**
 * Check installed mounting/current identity independently of business readiness.
 * @param binding Original installed graph binding to check, never a request borrow.
 */
assertMountCurrent(binding: AccountBinding): void

/**
 * Require exact live ready publication without capturing a request borrow.
 * @param binding Original installed graph binding whose ready publication and current recipe seal must hold.
 */
assertBusinessCurrent(binding: AccountBinding): void

/**
 * Return safe retained control counts without credentials or paths.
 * @returns Frozen control phase, bounded counts and failure presence; these observations do not grant readiness.
 */
inspectControl(): RuntimeControlObservation

/** Close new admission and join actual retained root control work. */
close(): Promise<void>
```

Source: [`packages/cloud/pe-cloud-runtime/src/types.ts`](../../packages/cloud/pe-cloud-runtime/src/types.ts)

<a id="ctxpeauth--peauthservice"></a>

### `ctx.peAuth` — `PeAuthService`

Owns one finite authentication pool and its actual secret/library work, without publishing raw resources.

```ts cordis-catalog
/**
 * Inspect bounded resource counts without exposing secrets, SQL, raw pools or a readiness certificate.
 * @returns A frozen snapshot; request admission stays closed independently of authentication initialization.
 */
observe(): AuthRootObservation

/**
 * Inspect the original shared ingress's registered Root Fetch entries for trusted account preparation.
 * @returns Actual current registrations; this creates neither a route nor business admission.
 */
inspectRootFetch(): readonly ExactFetchExposure[]

/**
 * Stop new secret/authentication work and join actual startup, library queries, secret reads and Pool.end.
 * Caller abandonment never ends the pool early. Repeated calls join the same cleanup; failure remains unconfirmed.
 * @returns Actual resource settlement, without a timer that could certify an early release.
 */
close(): Promise<void>
```

Source: [`packages/cloud/pe-cloud-access/src/auth-root.ts`](../../packages/cloud/pe-cloud-access/src/auth-root.ts)

<a id="ctxpecloudapi--cloudaccountapi"></a>

### `ctx.peCloudApi` — `CloudAccountApi`

One account's API providers and save controls; runtime retains assembly and drain ownership.

```ts cordis-catalog
/**
 * Require this exact service and binding without granting business admission.
 * @param owner Native Loader scope; omitted checks the API owner's own scope.
 */
assertInstalled(owner: Context = this.ctx): void

/**
 * Check original native installations and the shared policy without creating or writing business resources.
 * Mount/business admission and native ownership are checked around the awaited policy metadata read.
 * Selected exposure rows and visited runtimes/fibers share the explicit preparation budget; missing or exceeded budgets reject.
 * @param owner Actual consumer scope in this account graph.
 * @param signal Optional observer cancellation, combined with the original graph lifetime.
 * @returns Settlement of the current checks; no readiness token, catalog or account authority is issued.
 * @throws CloudApiError for absent policy, removed/replaced native installations or closed admission;
 * policy failures and cancellation retain their original identity.
 */
async assertBootstrapCurrent(owner: Context, signal?: AbortSignal): Promise<void>

/**
 * Audit actual native handlers while the original factory still owns unpublished assembly.
 * This requires mounting authority rather than business-ready admission and publishes no account.
 * @param owner Actual consumer scope in this original graph.
 * @param signal Optional observer cancellation, combined with the graph lifetime.
 * @returns Settlement after original policy/provider checks and the actual handler inventory audit.
 * @throws CloudApiError without the original unpublished callback, native owners or bounded policy;
 * original policy/cancellation failures retain identity.
 */
async auditPrepared(owner: Context, signal?: AbortSignal): Promise<void>

/**
 * Audit this view against actual native inventory supplied by trusted assembly.
 * @param inventory Mounted handlers and reviewed guards, never configuration availability flags.
 */
audit(inventory: ExposureInventory): void

/** Revoke only this graph's inventory during replacement or drain. */
invalidate(): void

/**
 * Require a reviewed native unary endpoint after business admission.
 * @param endpoint Native unary URL endpoint.
 * @returns The audited declaration after business admission.
 */
requireRpc(endpoint: string): EndpointExposure

/**
 * Require a reviewed native logical-stream endpoint after business admission.
 * @param endpoint Native logical-stream endpoint.
 * @returns Its audited declaration after business admission.
 */
requireStream(endpoint: string): EndpointExposure

/**
 * Require an exact reviewed Fetch route after business admission.
 * @param method Original HTTP method.
 * @param pathname Original canonical pathname.
 * @returns Its exact audited declaration after business admission.
 */
requireFetch(method: string, pathname: string): ExactFetchExposure

/**
 * Prepare fixed readonly native constructors; original Loader activation and complete auditing still follow.
 * @param owner Independent graph's prepare scope.
 * @param input Actual files-owned project, shared Session metadata check and explicit native limits.
 * @returns Original constructor installation, with no readiness publication or directory creation.
 */
prepareFirstScreen(owner: Context, input: Omit<FirstScreenNativeInput, 'api' | 'binding'>): NativeFirstScreen

/**
 * Install the account's sole project allocator before native auditing and business publication.
 * @param owner Original independent account preparation scope.
 * @param input Trusted files/Registry callback; receives no client-selected path or authority.
 * @returns The additive Remote owner, registered on the original graph.
 */
prepareCloudProjects(owner: Context, input: CloudProjectsPreparation): CloudProjectsService

/**
 * Register the sole unchanged native WorkspaceFiles in its actual Loader fiber.
 * @param owner Original Loader scope with the complete native inject list ready.
 * @param nativeConfig Original WorkspaceFiles page/list caps, resolved by its native Config.
 * @returns The original native service; existing filesystem provider and native Gateway retain authorization and I/O ownership.
 */
createWorkspaceFiles(owner: Context, nativeConfig: ConstructorParameters<typeof WorkspaceFiles>[1]): WorkspaceFiles

/**
 * Register the actual bounded native event subset on the original Gateway.
 * @param owner Original registration Loader fiber after readonly native providers activate.
 * @param input Exact graph profile home and all required event bounds.
 * @returns Actual registration/disposer; native Gateway owns ready and wire framing.
 */
installFirstScreenEvents(owner: Context, input: Omit<FirstScreenEventInput, 'api' | 'native'>): FirstScreenEvents

/**
 * Join the original cached event-source withdrawal before native teardown.
 * @returns Actual registration/disposer settlement; absent registration has no work.
 */
async stopFirstScreenEvents(): Promise<void>

/**
 * Construct the sole native Controller in its actual Loader fiber.
 * @param owner Owning native entry inside this independent graph.
 * @param guards Shared files/project/Preset and enabled-handler checks, including the fixed directory capability.
 * @param config Original native Controller configuration.
 * @returns The registered native subclass; this does not audit or publish the graph.
 */
createController( owner: Context, guards: NativeSessionGuards, config: ConstructorParameters<typeof SessionController>[1], ): SessionController

/**
 * Construct the sole original native upload owner with controlled streamed persistence.
 * @param owner Actual Loader entry, with native dependencies ready.
 * @param input Same-Agent storage admission and finite native receipt capacity.
 * @returns Native service; its streamed route remains subject to the audited exposure policy.
 */
createFileUploads(owner: Context, input: NativeUploadPreparation): FileUploads

/**
 * Install the sole guarded native factory before business admission opens.
 * @param owner Owning native entry inside this independent graph.
 * @param guards Shared pre-write and prepared-Agent checks.
 * @param config Original native configuration, with no startup agents.
 * @returns The real native AgentLoop provider; every operation still checks business admission.
 */
createAgentLoop(owner: Context, guards: NativeAgentFactoryGuards, config: ConstructorParameters<typeof AgentLoop>[1]): AgentLoop

/**
 * Install actual model dispatch admission in the native LLM scope.
 * @param owner Native LLM scope in this graph.
 * @param allowed Same approved provider/model set as selection and catalog projection.
 * @returns The native effect disposer; no model request is made here.
 */
installLlmGuard(owner: Context, allowed: (provider: string, model: string) => boolean): () => void

/**
 * Pause new top-level configuration submissions while retaining admitted native work.
 * @param deadlineAtMs Finite observation deadline; actual submitted writes remain owned.
 * @param signal Optional observer cancellation; absence waits to the deadline.
 * @returns The existing save barrier's pause evidence.
 */
pauseAccountChanges(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt>

/** Reopen only after runtime's actual re-audit and the barrier's quiescence check. */
resumeAccountChanges(): void

/**
 * Close configuration submissions and retain actual native save settlement.
 * @param deadlineAtMs Finite observation deadline; timeout does not stop actual native writes.
 * @param signal Optional observer cancellation; absence waits to the deadline.
 * @returns Existing terminal save evidence, available after business admission closes.
 */
stopConfigSaves(deadlineAtMs: number, signal?: AbortSignal): Promise<ConfigSaveReceipt>

/** Withdraw only after confirmed terminal save settlement, before disposing native providers. */
async withdraw(): Promise<void>
```

Types: [AgentLoop](core.md) · [FileUploads](attachment.md) · [SessionController](session.md) · [WorkspaceFiles](workspace.md)

Source: [`packages/cloud/pe-cloud-api/src/account-service.ts`](../../packages/cloud/pe-cloud-api/src/account-service.ts)

<a id="ctxpecloudfiles--cloudaccountfiles"></a>

### `ctx.peCloudFiles` — `CloudAccountFiles`

One graph's real Registry/FS installation; shared pool drain and directory responsibility stay with their original owners.

```ts cordis-catalog
/**
 * Select the single native provider constructor prepared for this graph.
 * @returns Native class with unchanged Config and persistence, after the staging capability check.
 */
attachmentStore(): typeof LocalAttachmentStore

/**
 * Copy approved native refs using the original store and this account's existing mutation lane.
 * @param workspace Actual registered project selected by the native Agent owner.
 * @param buildRefs Collect native receipts or accepted Session refs inside the positive batch reservation.
 * @param assertAuthorized Exact Agent/Session/provider checks, repeated before source I/O.
 * @param signal Actual caller cancellation, combined with the original account lifetime by the pool.
 * @returns Closed publications whose retained reservation must be released after handoff.
 */
async stageAttachments( workspace: Workspace, buildRefs: () => readonly FileAttachmentRef[], assertAuthorized: () => void, signal?: AbortSignal, ): Promise<ResidentResult<readonly StageFileResult[]>>

/**
 * Admit native upload persistence on the same files mutation owner before any stream is pulled.
 * @param reservationBytes Complete finite intake/cleanup/result reservation.
 * @param assertAuthorized Original Agent and provider checks; no path-derived authority.
 * @param execute Native persistence operation whose actual settlement remains owned by the pool.
 * @param signal Observation cancellation; an unconfirmed failure retains the original positive reservation.
 * @returns The native result retained until release.
 */
runAttachmentIntake<T>( reservationBytes: number, assertAuthorized: () => void, execute: (control: AbortSignal) => Promise<T>, signal?: AbortSignal, ): Promise<ResidentResult<T>>

/**
 * Require this exact prepared owner and current binding without granting business admission.
 * @param owner Native scope in the original account graph; omission checks the calling service scope.
 */
assertInstalled(owner: Context = this.ctx): void

/**
 * Install the sole original native Registry, await its default result, then prepare and install its selected native FileSystem.
 * Without a trusted provider factory, retain the metadata-only S2 implementation.
 * One Promise retains actual settlement; failure is terminal for this owner and does not certify cleanup.
 * @param owner Actual files/account Loader scope, which owns both native child fibers.
 * @returns The actual project after provider activation and directory verification; no ready or clean claim.
 */
install(owner: Context): Promise<AccountFilesProject>

/**
 * Read the installed actual project for trusted API/runtime assembly.
 * @returns The original Workspace object and files-owned directory capability, while both native providers remain current.
 * @throws FilesFailure before successful installation, after provider disposal or for a foreign/stale graph.
 */
project(): AccountFilesProject

/**
 * Require the settled original Registry/FS installation and its trusted actual content-capability check.
 * @throws FilesFailure for partial installation, replaced providers, S2 omission or unavailable ABI8 pool capability.
 */
assertContentAvailable(): void

/**
 * Derive metadata for the actual registered object without selecting or replacing the bootstrap default.
 * @param workspace Native Registry object already selected by trusted account admission.
 * @param signal Cancellation of bounded metadata observation.
 * @returns A fixed directory capability on the original lane; it grants no new service or registration window.
 */
async projectFor(workspace: Workspace, signal?: AbortSignal): Promise<AccountFilesProject>

/**
 * Bind a persistent environment only after Root approved the exact live native Agent/Session and project relationship.
 * Session strings, copied project results and path-selected inputs cannot establish that approval.
 * @param project Original object obtained from this owner's install/project/projectFor method.
 * @param sessionId Real native Session already checked by Root's account-native guards.
 * @param environmentVersion Approved image/architecture/Python/init identity, never command environment input.
 * @param signal Observer cancellation; confirmed late metadata remains bound and unknown retains actual work.
 * @returns An opaque original grant with its resident reservation; release revokes it without freeing or deleting a slot.
 */
async prepareExecutionMounts( project: AccountFilesProject, sessionId: EnvironmentSessionId, environmentVersion: string, signal?: AbortSignal, ): Promise<ResidentResult<ExecutionMountGrant>>

/**
 * Recheck the original opaque object before allocation or user execution; Root also repeats its native Session guard.
 * @param grant Exact unreleased object issued by this files owner.
 * @throws FilesFailure after release, graph/provider replacement, lost membership or a foreign/copied object.
 */
assertExecutionMountGrant(grant: ExecutionMountGrant): void

/**
 * Create one server-selected project while retaining the actual ready borrow through native settlement.
 * @param use Original runtime borrow; request JSON cannot supply it.
 * @param title Native display title; it never chooses a path or leaf.
 * @param signal Admission cancellation; started registration keeps its actual responsibility.
 * @returns The actual fulfilled native Workspace, after responsibility transfer.
 */
async createProject(use: AccountUse, title: string | undefined, signal: AbortSignal): Promise<Workspace>

/**
 * Consume source readers only for this owner's exact registered native project.
 * The trusted caller owns exact active Agent/Session admission; no path or id grants authority here.
 * @param workspace Exact Registry object after shared native admission.
 * @param reservedBytes Complete snapshot storage held through native message handoff.
 * @param build Consumes independent source readers without another lane reservation.
 * @param signal Cancellation leaves actual work with the same files participant.
 * @returns Complete retained result after source I/O settles; stale results are released and rejected.
 */
async withInstructionReaders<T>( workspace: Workspace, reservedBytes: number, build: (readers: InstructionReadReaders, control: AbortSignal) => Promise<T>, signal: AbortSignal, ): Promise<ResidentResult<T>>
```

Types: [FileAttachmentRef](attachment.md) · [LocalAttachmentStore](../../packages/attachment/attachment-local/README.md) · [Workspace](workspace.md)

Source: [`packages/cloud/pe-cloud-files/src/account-service.ts`](../../packages/cloud/pe-cloud-files/src/account-service.ts)

<a id="ctxpeexposure--exposureservice"></a>

### `ctx.peExposure` — `ExposureService`

Root policy provider; registering it does not publish account readiness.

Source: [`packages/cloud/pe-cloud-api/src/root.ts`](../../packages/cloud/pe-cloud-api/src/root.ts)

<a id="ctxpesandboxcoordinator--sandboxcoordinator-abstract-seam"></a>

### `ctx.peSandboxCoordinator` — `SandboxCoordinator` (abstract seam)

A concrete implementation must register as runtime's mandatory execution participant and verify its own required execution capabilities or explicit closed mode before readiness. This definition supplies neither an implementation nor an empty-work stopping receipt.

```ts cordis-catalog
/** Check actual registration and declared requirements; closed mode authorizes no execution. */
abstract assertReady(): void

/**
 * Issue one restricted port from runtime's trusted native prepare scope.
 * @param ctx - independent account graph with its actual installed binding.
 * @param binding - exact installed runtime generation, never serialized identity.
 * @param assertCurrent - runtime-owned graph-current check, valid during mounting.
 * @param authority - optional lazy native authority, not consumed during binding; closed coordinators ignore it.
 * @returns an account-only port; issuance does not establish account readiness.
 */
abstract bindAccount( ctx: Context, binding: AccountBinding, assertCurrent: () => void, authority?: NativeAccountExecutionAuthority, ): AccountExecutionPort

/**
 * Stop all actual work and nonterminal allocations for this exact generation.
 * @param binding - runtime-owned account and epoch; includes idle and uncertain allocations.
 * @param deadlineAtMs - caller's finite waiting deadline, which does not release cleanup ownership.
 * @returns confirmed only after all ranges, I/O and late starts have stopped; otherwise unknown.
 */
abstract stopEpoch(binding: AccountBinding, deadlineAtMs: number): Promise<ParticipantReceipt>
```

Source: [`packages/cloud/pe-opensandbox/src/coordinator.ts`](../../packages/cloud/pe-opensandbox/src/coordinator.ts)
<!-- END GENERATED cordis-surface -->
