# Cloud account integration

English | [中文](cloud.zh.md)

The [cloud package map](../../packages/cloud/README.md) locates the optional deployment components. This reference describes their shared runtime inputs; package READMEs own activation requirements. These components do not add a Session implementation.

`ApprovedConfigurationField` selects finite native namespace/field pairs and optional scalar choices. Approved leaves must exist in the original active Settings schema; native revisions and none/live update plans still govern saves. `locale.preference` retains its exact `zh`/`en` policy. The original login Use and account-save owner perform writes; bootstrap metadata grants no write capability. See the [cloud API](../../packages/cloud/pe-cloud-api/README.md).

<a id="account-identities"></a>
## Account identities

The runtime package owns [account identity and lifecycle types](../../packages/cloud/pe-cloud-runtime/src/types.ts). `AccountId` identifies an authenticated database account. `OwnerEpoch` preserves the PostgreSQL decimal value without conversion to a JavaScript number. `InstanceId` identifies a server process start, and `OperationId` identifies actual work whose responsibility may outlive a request.

`AccountBinding` is immutable trusted input for one account graph. Its lifetime signal belongs to the graph; cancelling a caller's wait does not cancel that lifetime. `AccountUse` borrows a native Context, checks current admission immediately before native work, and releases only the borrow. Neither value is accepted from browser JSON.

`AccountStorageKey` is a stable, server-derived directory key. `AccountLayout` contains immutable absolute addresses for shared account data and a process-local rebuildable index; addresses establish neither existence, filesystem authority nor quota. `AccountMountInput` combines that layout with the exact graph binding, current process identity and native `LaunchEnvironmentSnapshot`. Runtime derives account and project candidates before files verifies or prepares them; default-project eligibility and registration remain native Workspace responsibilities.

The private native boot adapter installs an independent `ProfileContext`, launch environment and account binding before mounting one native root Include. Port preparation receives the exact installed binding. After preparation, the adapter rechecks that lifetime before returning control to native boot; boot and disposal retain their actual Promises after a caller stops waiting. A mounted native tree still requires the factory's provider, save and exposure audits before it can serve an account.

<a id="actual-work-and-capacity"></a>
## Actual work and capacity

`SubagentCapacityReservation` retains one actual child residency from the same Root capacity owner ([declaration](../../packages/cloud/pe-cloud-runtime/src/types.ts)). Its first `settle('confirmed' | 'unknown')` is final: confirmed cleanup releases that child slot; unknown permanently retains it and prevents account release.

The runtime root registers exactly two required participant categories: `files` and `execution`. Contributions belong to their caller's Cordis effect and disappear when that effect is disposed. Duplicate registration and missing participants reject mount-capacity reservation.

`RootMetadataDatabase` is a runtime-issued parameterized-query capability for an original Root participant with `closeRoot()`. It shares the runtime executor without exposing credentials, database selection or driver closure. Withdrawal and Root shutdown join that participant's actual cleanup before revoking its borrowed capability; unresolved cleanup retains ownership. Its `wasNotSubmitted()` predicate recognizes only the original adapter's settled failures before SQL submission.

`AccountOwnerResolver` is an ordinary active Root’s read-only facade. `AccountOwnerResolution` contains a rechecked ready owner and registered instance; absent, stopped, inconsistent or changed metadata rejects, and original query failures propagate. It grants no `AccountUse` or network admission. The [runtime package](../../packages/cloud/pe-cloud-runtime/README.md#process-instance-metadata) owns read and shutdown bounds.

`AccountRuntimeService.borrowOwnedAccount` uses an exact local owner observation to borrow an existing ready factory graph, with owner and Root rechecks and release on failure. It never enters account acquisition; [runtime](../../packages/cloud/pe-cloud-runtime/README.md#process-instance-metadata) owns this behavior.

`RootIngressCloseOwner` retains the one original Access close operation in the caller effect through actual closure. Runtime joins it before metadata and account teardown; registration grants only this shutdown ordering. The optional `activeInstanceId` is original Host-only metadata and grants no business admission.

`ParticipantReceipt` identifies its account, epoch, participant and evidence. A confirmed receipt has no pending operation ids. An unknown receipt retains pending work and a reason; a request deadline or rejected wait does not establish that actual work stopped.

Local mount and drain reservations bound concurrent work. Settling mount work releases its operation slot; the mounted-account slot remains reserved until its owner releases it after actual cleanup. These reservations do not acquire a database owner or establish account readiness.

The files root prestarts a fixed worker pool. Account drain retains the shared pool; root shutdown retains the service and participant until workers exit and held results are released. API configuration-save receipts separately track admitted native writes and required application through their actual Promises. Configuration saving is not a third drain participant, and failed or unresolved saves cannot establish a clean graph.

`ConfigSaveBarrier` is the runtime-owned, in-process controller for one graph's save admission, pending work, retained failures and pause/resume/stop settlement ([declaration](../../packages/cloud/pe-cloud-api/src/save-hooks.ts)). It carries the exact `AccountBinding` and joins native persistence with required application. `CloudAccountApi.inspectConfigurationSaves()` returns its sanitized `ConfigSaveSnapshot`; it does not return or serialize this control object.

<a id="native-adapters"></a>
## Native adapters

Cloud request consistency uses the [access-owned request types](../../packages/cloud/pe-cloud-access/src/types.ts). Client account and generation fields are expectations, not authentication credentials. Native HTTP, stream and controller adapters retain the original transport messages and native Session state.

Access owns `CloudBootstrap` and its browser-safe `decodeCloudBootstrap` validator. The response contains display identity, recipe, opaque connection generation and redacted capabilities. `BootstrapDecodeLimits` bounds compact JSON bytes, UTF-8 string bytes and combined list entries; the carrier separately bounds raw response bytes before JSON parsing. Decoding returns detached, deeply frozen metadata and establishes neither authentication, feature approval nor account readiness. Disabled capability descriptions distinguish unapproved features from temporarily unavailable channels; configuration fields describe allowed choices and application levels without carrying values or submission authority.

`PeAuthService`, installed by access/root, owns one finite PostgreSQL pool, official credential reads, actual Better Auth initialization and schema inspection. `AuthRootConfig` adds explicit database, pool, secret and startup budgets to browser-safe access settings. Its observation exposes bounded resource counts and closed request admission. Missing schema or initialization failure retains cleanup; the provider executes no migration and registers no route. Shared HTTP/WS admission still requires runtime's actual root recipe audit and account providers.

Trusted runtime preparation installs `CloudAccountApi` with the exact account binding, root-issued configuration-save barrier, deployment exposure ceiling and separate mount/business admission checks. Its fixed native editor and credential constructors install save hooks before initialization. Controller, AgentLoop and LLM installation reuse existing native guards; `/account` checks this prepared service. Installation and entry activation do not publish readiness. Every business operation requires the separate current-ready check, while inventory auditing and terminal save settlement retain their own lifecycle rules.

The native Session adapter preserves original dispatch, DTOs and Session state while guarding actual effects. Its awaited directory preparation uses the account's fixed files capability before Agent creation. Production routing, project/Preset/model checks, actual native inventory and durable storage authority remain required before account publication.

`CloudProjectCreateRequest` carries only an optional title; `CloudProjectsPreparation` captures the trusted allocator used by `CloudProjectsService` ([declarations](../../packages/cloud/pe-cloud-api/src/cloud-projects.ts), [request](../../packages/cloud/pe-cloud-api/src/types.ts)). `NativeUploadPreparation` supplies the pending-receipt limit and awaited stream-persistence hook while the native upload service owns receipts ([declaration](../../packages/cloud/pe-cloud-api/src/native-uploads.ts)).

Files-owned `ResidentResult<T>` pairs a value with its reservation release ([declaration](../../packages/cloud/pe-cloud-files/src/work-queue.ts)). `StageFileResult` pairs native staging facts with the attachment ref and project-relative copy path ([declaration](../../packages/cloud/pe-cloud-files/src/stage-bridge.ts)); `InstructionReadReaders` supplies a restricted project reader and optional account reader ([declaration](../../packages/cloud/pe-cloud-files/src/instruction-read-work.ts)). `EnvironmentSessionId` is the native Workspace membership's Session id type; `ExecutionMountGrant` describes the original binding, Session/project selection, measured project/environment identities and quotas, and read-only `.pe` policy ([declarations](../../packages/cloud/pe-cloud-files/src/environment-bank.ts)).

```ts type-equiv
/** Root-approved native provider identity and its declared credential reference. */
interface ApprovedModelKeyBinding {
  readonly provider: string
  readonly providerEntryId: string
  readonly moduleName: string
  readonly ref: CredentialRef
}
```

```ts type-equiv
/** Explicit finite native provider/reference selection for the existing key Remote. */
interface ApprovedModelKeyConfiguration {
  readonly bindings: readonly ApprovedModelKeyBinding[]
  readonly maxKeyBytes: number
  readonly maxVersionBytes: number
  readonly maxReplyBytes: number
  readonly maxMetadataBytes: number
}
```

<a id="approved-plugin-controls"></a>
## Approved plugin controls

`CloudPluginService` is the account-native Remote for approved preinstalled plugins and bundles. Its `current` and `change` methods use the original Peer, save owner and native profile writers; the service object is a Host installation, not a browser payload. The [cloud API package](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) owns activation, admission and application requirements.

[`PluginCurrentRequest`](../../packages/cloud/pe-cloud-api/src/plugin-types.ts) carries an approved catalog `id`. `PluginCurrentState` contains that `id`, the original native `PluginInfo` as `plugin` or `BundleInfo` as `bundle`, the entry or bundle `selectionTarget`, permitted `operations`, `maxImpact`, ordinary `configuration.fields`, and a `version` with the account `epoch` and opaque `editToken`. Each field carries its approved `path`, native JSON `schema`, omission semantics, limitations, `writable` permission, optional `readOnlyReason`, relative secret-presence markers and a disclosable raw value when present. The version exposes neither profile bytes nor their digest; the [boot subsystem](boot.md) owns native inventory fields.

Approved entries without mutation controls retain native inventory reads with empty `operations` and `configuration.fields`; `maxImpact` is absent. Reading them grants no mutation authority, and each change still requires explicit catalog control.

`PluginChangeRequest` adds the original `version`, explicit `mode` (`if-idle` or `stop-and-apply`) and one `operation` to the approved id. The operation is `{ kind: 'enabled', enabled: boolean }`, `{ kind: 'selected', selected: boolean }` or `{ kind: 'configure', path: string[], value: JsonValue }`, subject to the catalog and original native plan. Configuration accepts literal JSON at one approved ordinary path, without an unset operation. These requests accept no module specifier, profile path, Peer or account authority.

`PluginChangeResult` distinguishes `{ kind: 'applied', value: PluginCurrentState, native?: ChangeResult }` from `{ kind: 'accepted-rebuild', operationId: OperationId }`. Applied follows native application and the original account re-audit. Rebuild acceptance requires reconnecting and reading actual state; it does not certify application. The optional native `ChangeResult` retains its [boot-owned semantics](boot.md).

`ConfigurationPeerOperation<T>` is a trusted Host callback owned by the [access Peer registry](../../packages/cloud/pe-cloud-access/src/peers.ts), with a [structural API declaration](../../packages/cloud/pe-cloud-api/src/plugin-types.ts). It receives the original binding and Context, login recheck, observer-closure callback and handoff callbacks `afterRequest`, `closeAll(deadlineAtMs)` and `assertPrincipal`. These in-process values are not JSON request fields and do not issue replacement authority.

`PluginRebuildIntent` contains the approved `id`, server-owned patch/manifest `revision` and checked `operation`. The old save owner checks that revision and its opaque edit before the original factory commits it through the original stopped graph's writer, then disposes the old graph and assembles a new epoch. A browser submits `PluginChangeRequest`, not this internal intent.

`ApprovedConfigurationBundle` pins the preinstalled package/version and complete member entry/module/package/version identities, with only graph-level selection control. `PluginCurrentState.selectionTarget.kind` distinguishes native entry `plugin` from native `bundle`; readonly entry inventory omits `maxImpact`. `PluginRebuildPersistence` retains the old epoch, native save result and private disk revision. `PluginRebuildVerification` pairs that result with the audited new state. Runtime-owned `ConfigurationRebuildReceipt<T, V>` resolves only after the different epoch passes intent verification and original ready CAS; these Host values are not Remote result fields.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcloudmodelkey--cloudmodelkeyservice"></a>

### `ctx.cloudModelKey` — `CloudModelKeyService`

One independent capability; original native persistence, ordering and failure retention stay with AccountSaves.

```ts cordis-catalog
/**
 * Read actual metadata through the original Peer/Use.
 * @param signal Original observer signal.
 * @returns Bounded readonly native metadata.
 */
@Remote('metadata') metadata(signal: AbortSignal): Promise<ModelKeyMetadata>

/**
 * Audit before bootstrap policy checks.
 * @returns Actual native module import settlement.
 */
auditProvider(): Promise<void>

/**
 * Require the audited configured bootstrap route.
 * @param provider Root provider.
 * @param model Root model.
 */
assertProvisionableModel(provider: string, model: string): void

/**
 * Read redacted state for an explicit edit.
 * @param request Root-approved native reference.
 * @param signal Original observer signal.
 * @returns Redacted state and version.
 */
@Remote('describe') describe(request: ModelKeyReference, signal: AbortSignal): Promise<ModelKeyState>

/**
 * Persist the approved Key in the original save turn.
 * @param request Approved reference, secret and captured version.
 * @param signal Original observer signal.
 * @returns Confirmed persistence.
 */
@Remote('set') set(request: ModelKeySet, signal: AbortSignal): Promise<ModelKeySaved>

/**
 * Remove the approved Key in the original save turn.
 * @param request Approved reference and captured version.
 * @param signal Original observer signal.
 * @returns Confirmed removal.
 */
@Remote('unset') unset(request: ModelKeyUnset, signal: AbortSignal): Promise<ModelKeySaved>

/** Require this same installed service, independently of public readiness. */
assertCurrent(): void

/**
 * Inspect actual installed unary registrations.
 * @returns Actual fixed Remote markers and strict descriptors; never a configured availability claim.
 */
inspect(): ExposureInventory
```

Types: [ModelKeyMetadata](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [ModelKeyReference](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [ModelKeySaved](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [ModelKeySet](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [ModelKeyState](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [ModelKeyUnset](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation)

Source: [`packages/cloud/pe-cloud-api/src/cloud-model-key.ts`](../../packages/cloud/pe-cloud-api/src/cloud-model-key.ts)

<a id="ctxcloudplugins--cloudpluginservice"></a>

### `ctx.cloudPlugins` — `CloudPluginService`

Unary controls for finite approved preinstalled plugins; no installer or raw manager endpoint is granted.

```ts cordis-catalog
/** Read actual approved native inventory and an epoch-bound original save-owner version.
 * @param request Approved catalog id.
 * @param signal Original observer cancellation.
 * @returns Original native PluginInfo, approved native Config fields and opaque version; no profile bytes or digest.
 */
@Remote('current') current(request: PluginCurrentRequest, signal: AbortSignal): Promise<PluginCurrentState>

/** Edit through the original actual idle window, or explicitly schedule its complete terminal drain and new claim.
 * @param request Approved id, exact operation, original edit and explicit application mode.
 * @param signal Observer cancellation before admission; admitted native work retains its actual settlement.
 * @returns Applied only after original native apply/re-audit, or acceptance requiring reconnect and read.
 */
@Remote('change') change(request: PluginChangeRequest, signal: AbortSignal): Promise<PluginChangeResult>

/** Require this same installed Remote and native writer owners, without granting public readiness. */
assertCurrent(): void

/** Inspect exact generated strict Remote descriptors and original method registrations.
 * @returns Only the two actual authenticated unary endpoints.
 */
inspect(): ExposureInventory
```

Types: [PluginChangeRequest](cloud.md#approved-plugin-controls) · [PluginChangeResult](cloud.md#approved-plugin-controls) · [PluginCurrentRequest](cloud.md#approved-plugin-controls) · [PluginCurrentState](cloud.md#approved-plugin-controls)

Source: [`packages/cloud/pe-cloud-api/src/cloud-plugins.ts`](../../packages/cloud/pe-cloud-api/src/cloud-plugins.ts)

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

<a id="ctxcloudskills--cloudskillservice"></a>

### `ctx.cloudSkills` — `CloudSkillService`

One concrete business capability; it registers no additional persistence or lifecycle owner.

```ts cordis-catalog
/** Reconstruct the current catalog during trusted assembly.
 * @returns Actual cold-pointer restore; Root calls before opening business admission.
 */
restore(): Promise<void>

/**
 * Read this account's actual fixed pointer, without activating an Agent or creating a sandbox.
 * @param request Fixed sample slot only.
 * @param signal Original observer cancellation.
 * @returns Actual durable metadata and opaque edit token; no resource path.
 */
@Remote('current') current(request: SkillCurrentRequest, signal: AbortSignal): Promise<SkillCurrentState>

/**
 * Publish exactly two complete files through actual native pointer CAS in the original save turn.
 * @param request Fixed slot, opaque edit and bounded complete file fields.
 * @param signal Cancellation cannot discard a confirmed native pointer handoff.
 * @returns Separate persistence/catalog application and optional per-load resource preparation capability.
 */
@Remote('publish') publish(request: SkillPublishRequest, signal: AbortSignal): Promise<SkillPublishResult>

/**
 * List installed skills with their native selection and precedence metadata.
 * @param request Optional original workspace selector.
 * @param signal Observer cancellation.
 * @returns Complete installed catalog and one catalog edit token.
 */
@Remote('installed') installed(request: ManagedSkillsInstalledRequest, signal: AbortSignal): Promise<ManagedSkillsInstalled>

/**
 * Read one installed skill's native metadata and complete file inventory.
 * @param request Original installation id.
 * @param signal Observer cancellation.
 * @returns Complete native and file metadata.
 */
@Remote('details') details(request: ManagedSkillDetailsRequest, signal: AbortSignal): Promise<ManagedSkillDetails>

/**
 * Install a complete skill package through the original save turn and catalog CAS.
 * @param request Complete package and catalog edit token.
 * @param signal Cancellation cannot discard a confirmed catalog handoff.
 * @returns Persistence and native application facts.
 */
@Remote('install') install(request: ManagedSkillInstallRequest, signal: AbortSignal): Promise<ManagedSkillMutationResult>

/**
 * Replace one installation's complete package through the original catalog CAS.
 * @param request Complete replacement and catalog edit token.
 * @param signal Cancellation cannot discard a confirmed catalog handoff.
 * @returns Persistence and native application facts.
 */
@Remote('update') update(request: ManagedSkillUpdateRequest, signal: AbortSignal): Promise<ManagedSkillMutationResult>

/**
 * Remove one installation from future native discovery and loading.
 * @param request Original installation and catalog edit token.
 * @param signal Cancellation cannot discard a confirmed catalog handoff.
 * @returns Durable removal and native application facts.
 */
@Remote('uninstall') uninstall(request: ManagedSkillUninstallRequest, signal: AbortSignal): Promise<ManagedSkillMutationResult>

/**
 * Export the complete authorized files of one installed skill as a ZIP archive.
 * @param request Exact installed content selectors.
 * @param signal Observer cancellation.
 * @returns Complete authorized ZIP.
 */
@Remote('download') download(request: ManagedSkillDownloadRequest, signal: AbortSignal): Promise<ManagedSkillDownload>

/** Inspect actual native registration rather than a configured availability flag.
 * @returns Exact unary inventory.
 */
inspect(): ExposureInventory

/** Require this exact installed account service and files binding; does not grant public readiness. */
assertCurrent(): void
```

Types: [ManagedSkillDetails](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [ManagedSkillDetailsRequest](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [ManagedSkillDownload](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [ManagedSkillDownloadRequest](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [ManagedSkillInstallRequest](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [ManagedSkillMutationResult](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [ManagedSkillUninstallRequest](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [ManagedSkillUpdateRequest](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [ManagedSkillsInstalled](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [ManagedSkillsInstalledRequest](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [SkillCurrentRequest](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [SkillCurrentState](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [SkillPublishRequest](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [SkillPublishResult](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication)

Source: [`packages/cloud/pe-cloud-api/src/cloud-skills.ts`](../../packages/cloud/pe-cloud-api/src/cloud-skills.ts)

<a id="ctxpeaccount--accountbinding"></a>

### `ctx.peAccount` — `AccountBinding`

Trusted immutable input for one account graph; lifetime is never a request signal.

Source: [`packages/cloud/pe-cloud-runtime/src/types.ts`](../../packages/cloud/pe-cloud-runtime/src/types.ts)

<a id="ctxpeaccountexecution--accountexecutionport"></a>

### `ctx.peAccountExecution` — `AccountExecutionPort`

Internal factory capability; it cannot select an account, backend, or process.

```ts cordis-catalog
/**
 * Synchronously check retained native command/service work before changing a Session policy.
 * @param ctx Original account caller within the exact installed graph.
 * @param session Exact native Session whose policy is about to change.
 */
assertSessionFilePolicyChange?(ctx: Context, session: Session): void

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

Types: [Session](session.md)

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

Root-owned account lifecycle and metadata service; maintenance authority never grants ordinary admission.

```ts cordis-catalog
/**
 * Register the single original Access ingress shutdown owner in the actual caller effect.
 * @param owner Original close owner, registered before it admits authentication or forwarding work.
 * @returns Withdrawal that starts and joins original closure; failed closure retains the registration.
 * Registration grants no seal, database, account, recovery or participant authority.
 */
registerIngressClose(owner: RootIngressCloseOwner): () => void | Promise<void>

/**
 * Borrow only an existing ready graph owned by this process and the exact observed owner tuple.
 * @param expected Original AccountOwner metadata supplied by trusted Host composition, never an AccountBinding.
 * @returns The original AccountUse after owner and Root rechecks; no claim, mount or recreation is attempted.
 * A failed recheck releases any acquired borrow. The consumer releases a successful borrow after its work settles.
 */
borrowOwnedAccount(expected: AccountOwner): Promise<AccountUse>

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

Types: [RootIngressCloseOwner](cloud.md#actual-work-and-capacity)

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
 * Delegate one native model-key invocation through the original login registry.
 * @param peer Exact Gateway invocation Peer, never a client identity.
 * @param consume Actual native work using the original retained Use and current checks.
 * @returns Actual operation settlement; this service issues no additional borrow.
 */
withModelKeyPeerUse<T>(peer: PeerScope, consume: (use: AccountUse, assertCurrent: () => void) => Promise<T>): Promise<T>

/** Delegate a guarded configuration handoff to the same original login/Peer owner.
 * @param peer Exact native invocation Peer.
 * @param consume Factory-owned exclusive update, without another login or state authority.
 * @param mode Explicit local idle operation or terminal acceptance followed by original full closure.
 * @returns Actual update settlement and fresh same-generation borrow restoration.
 */
withConfigurationPeer<T>(peer: PeerScope, consume: ConfigurationPeerOperation<T>, mode: 'if-idle' | 'stop-and-apply' = 'if-idle'): Promise<T>

/**
 * Stop new secret/authentication work and join actual startup, library queries, secret reads and Pool.end.
 * Caller abandonment never ends the pool early. Repeated calls join the same cleanup; failure remains unconfirmed.
 * @returns Actual resource settlement, without a timer that could certify an early release.
 */
close(): Promise<void>
```

Types: [ConfigurationPeerOperation](cloud.md#approved-plugin-controls)

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
 * @returns Original synchronous native/admission recheck for final transfer; no readiness token, catalog or account authority is issued.
 * @throws CloudApiError for absent policy, removed/replaced native installations or closed admission;
 * policy failures and cancellation retain their original identity.
 */
async assertBootstrapCurrent(owner: Context, signal?: AbortSignal): Promise<() => void>

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

/** Re-audit the original inventory under the factory's same-generation exclusive update window.
 * @param owner Same native account root; no replacement graph is accepted.
 * @returns Actual original policy/provider/handler audit; grants no business admission.
 */
auditReconfigured(owner: Context): Promise<void>

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
prepareFirstScreen(owner: Context, input: Omit<FirstScreenNativeInput, 'api' | 'binding' | 'assertSettingsFields'>): NativeFirstScreen

/**
 * Register one key service in its Loader fiber.
 * @param owner Original Loader.
 * @param input Root policy and original login callback.
 * @returns Installed service.
 */
prepareCloudModelKey(owner: Context, input: CloudModelKeyPreparation): CloudModelKeyService

/**
 * Prepare one fixed skill capability; Root still supplies and audits explicit exposure separately.
 * @param owner Original account Loader scope after native skills and verified files activate.
 * @param input Same files owner, original Peer consumer and explicit finite bounds.
 * @returns Concrete native Remote. Restore before business opening; resource loads require original caller/project preparation.
 */
prepareCloudSkills(owner: Context, input: CloudSkillPreparation): CloudSkillService

/** Prepare the fixed plugin Remote after its original guarded manager and editor activate.
 * @param owner Actual original account Loader entry.
 * @returns Exact original two-method Remote.
 */
prepareCloudPlugins(owner: Context): CloudPluginService

/** Audit the actual preinstalled fixed module and original native writer before publication.
 * @returns Original importer/package/native inventory settlement.
 */
restoreApprovedPlugins(): Promise<void>

/** Apply a checked intent in the original stopped graph before its native hooks are withdrawn.
 * @param intent Original save-owner CAS result.
 * @param current Actual factory terminal window check.
 * @returns Actual native writer and application; neither business nor save admission reopens.
 */
applyApprovedPluginIntent(intent: PluginRebuildIntent, current: () => void): Promise<PluginRebuildPersistence>

/** Verify the checked old intent on this unpublished replacement graph.
 * @param intent Original terminal operation.
 * @param persisted Original native persistence result.
 * @param current Original replacement-graph check before ready CAS.
 * @returns Verified new state, with a new save owner version.
 */
verifyApprovedPluginIntent( intent: PluginRebuildIntent, persisted: PluginRebuildPersistence, current: () => void, ): Promise<PluginRebuildVerification>

/**
 * Require the audited configured bootstrap route.
 * @param provider Root provider.
 * @param model Root model.
 */
assertProvisionableModel(provider: string, model: string): void

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
installFirstScreenEvents(owner: Context, input: Omit<FirstScreenEventInput, 'api' | 'native' | 'settingsNamespaces' | 'controls'>): FirstScreenEvents

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
 * Install the original human-command registry in its account Loader fiber.
 * @param owner Actual native Loader entry with its original dependencies.
 * @param guards Shared active-Agent/project admission and bounded native read policy.
 * @returns The native registry; every Remote call retains account admission.
 */
createCommands(owner: Context, guards: NativeSessionGuards): NativeCommands['value']

/**
 * Install the native goal domain shared by the command and its UI controls.
 * @param owner Actual account Loader entry.
 * @param guards Original active-Agent/project checks and native result limits.
 * @param config Native goal round policy.
 * @returns Original goal service with generation-bound Remote admission.
 */
createGoals( owner: Context, guards: NativeSessionGuards, config: Parameters<typeof createNativeGoals>[6], ): NativeGoals['value']

/**
 * Register native command and streaming archive delivery in the account graph.
 * @param owner Actual native Loader entry with archive dependencies ready.
 * @param guards Same Session/project admission used by native history reads.
 * @param config Original archive compression configuration.
 */
createSessionExport( owner: Context, guards: NativeSessionGuards, config: Parameters<typeof createNativeSessionExport>[6], ): void

/**
 * Install native permission controls over the actual enforcing providers.
 * @param owner Actual account Loader entry.
 * @param config Native two-mode preset table.
 * @param maxFrameBytes Existing complete native result limit.
 * @param assertEnforcement Recheck the original issued execution and Files policy enforcement.
 * @param assertCanSwitch Refuse a policy change while original execution work remains.
 * @returns The original native preset service.
 */
createPermissions( owner: Context, config: Parameters<typeof createNativePermissions>[5], maxFrameBytes: number, assertEnforcement: () => void, assertCanSwitch: Parameters<typeof createNativePermissions>[8], ): NativePermissions['value']

/**
 * Install original question replies and timed-wait claims.
 * @param owner Actual account Loader entry.
 * @param guards Shared native active-Agent/project admission.
 * @returns The native question service.
 */
createUserQuestions(owner: Context, guards: NativeSessionGuards): NativeUserQuestions['value']

/**
 * Install the original per-Session feedback recorder.
 * @param owner Actual account Loader entry.
 * @param guards Shared native Session/project admission and read limits.
 * @returns The native feedback service.
 */
createSessionFeedback(owner: Context, guards: NativeSessionGuards): ReturnType<typeof createNativeSessionFeedback>['value']

/**
 * Install the native versioned per-message feedback store.
 * @param owner Actual account Loader entry.
 * @param guards Shared native Session/project admission and read limits.
 * @param config Original note-size policy.
 * @returns The native feedback service with its original mutation queue and persistence handles.
 */
createMessageFeedback( owner: Context, guards: NativeSessionGuards, config: Parameters<typeof createNativeMessageFeedback>[6], ): ReturnType<typeof createNativeMessageFeedback>['value']

/**
 * Supply native command acknowledgements without ambient Host-home I/O.
 * @param owner Actual account command Loader entry.
 * @returns Original-generation checked, account-scoped display identity callback.
 */
createFeedbackIdentity(owner: Context): () => string

/**
 * Install the sole guarded native factory before business admission opens.
 * @param owner Owning native entry inside this independent graph.
 * @param guards Shared pre-write and prepared-Agent checks.
 * @param config Original native configuration, with no startup agents.
 * @param reserveSubagent Original Root capacity/settlement callback; omission keeps child entry closed.
 * @returns The real native AgentLoop provider; every operation still checks business admission.
 */
createAgentLoop( owner: Context, guards: NativeAgentFactoryGuards, config: ConstructorParameters<typeof AgentLoop>[1], reserveSubagent?: (depth: number) => SubagentCapacityReservation, ): AgentLoop

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

/** Observe actual original configuration work without granting an update window.
 * @returns The original save owner's bounded actual work, without native values. */
inspectConfigurationSaves(): ReturnType<ConfigSaveBarrier['snapshot']>

/** Run the factory's exclusive native plugin writer in the original paused save turn.
 * @param submit Original writer and required application, with no observer-cancellation race.
 * @returns Actual settlement under this same barrier; missing exclusive authority rejects before submit.
 */
withPausedPluginChange<T>(submit: () => Promise<T>): Promise<T>

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

/** Bind a trusted request borrow to the existing native credential installation; registers no endpoint.
 * @param use Original runtime-issued AccountUse; its caller retains release ownership through settlement.
 * @param limits Explicit deployment byte bounds, never client input.
 * @param assertRequestCurrent Original request/Peer check; production ingress must supply it.
 * Omission preserves trusted in-process calls without adding login admission.
 * @returns A request-local adapter; every call still requires actual business and exposure admission.
 */
modelKeyAccess(use: AccountUse, limits: ApprovedModelKeyConfiguration, assertRequestCurrent?: () => void): ModelKeyAccess
```

Types: [AgentLoop](core.md) · [CloudModelKeyPreparation](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [CloudModelKeyService](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [CloudPluginService](cloud.md#approved-plugin-controls) · [CloudSkillPreparation](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [CloudSkillService](../../packages/cloud/pe-cloud-api/README.md#controlled-sample-publication) · [ConfigSaveBarrier](cloud.md#actual-work-and-capacity) · [FileUploads](attachment.md) · [ModelKeyAccess](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [NativeCommands](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [NativeGoals](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [NativePermissions](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [NativeUserQuestions](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [PluginRebuildIntent](cloud.md#approved-plugin-controls) · [PluginRebuildPersistence](cloud.md#approved-plugin-controls) · [PluginRebuildVerification](cloud.md#approved-plugin-controls) · [SessionController](session.md) · [SubagentCapacityReservation](cloud.md#actual-work-and-capacity) · [WorkspaceFiles](workspace.md) · [createNativeGoals](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [createNativeMessageFeedback](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [createNativePermissions](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [createNativeSessionExport](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation) · [createNativeSessionFeedback](../../packages/cloud/pe-cloud-api/README.md#understand-the-implementation)

Source: [`packages/cloud/pe-cloud-api/src/account-service.ts`](../../packages/cloud/pe-cloud-api/src/account-service.ts)

<a id="ctxpecloudfiles--cloudaccountfiles"></a>

### `ctx.peCloudFiles` — `CloudAccountFiles`

One graph's real Registry/FS installation; shared pool drain and directory responsibility stay with their original owners.

```ts cordis-catalog
/**
 * Return this installed graph's original fixed private skill port; no model or raw-file entry is exposed.
 * @returns The original bound port, rejecting when static storage or the native capability is absent.
 */
skillVersions(): SkillVersionPort

/**
 * Prepare a complete immutable tree through the original lane and reviewed helper.
 * @param input Complete package files or archive bytes.
 * @param signal Caller observation cancellation; actual work remains owned to settlement.
 * @returns A files-issued version whose result remains retained through release.
 */
prepareBundle(input: SkillBundleInput, signal: AbortSignal): Promise<ResidentResult<SkillBundleVersion>>

/**
 * Observe the complete single catalog; schema1 is projected without migration writes.
 * @param signal Caller observation cancellation.
 * @returns A complete issued observation retained through release.
 */
observeCatalog(signal: AbortSignal): Promise<ResidentResult<SkillCatalog>>

/**
 * CAS one installation in the original current.json, inside the caller's existing save observation.
 * @param expected Exact catalog observation issued by this files generation.
 * @param change One installation change using issued bundle authority.
 * @param signal Caller observation cancellation; confirmed durable outcomes remain observable.
 * @returns The confirmed catalog and affected entry, retained through release; unknown publication rejects without rollback.
 */
commitCatalog(expected: SkillCatalog, change: SkillCatalogChange, signal: AbortSignal): Promise<ResidentResult<SkillCatalogCommit>>

/**
 * Borrow one issued complete source; the callback and its resident result retain the original borrow.
 * @param version Exact issued source selected under the original save ordering.
 * @param consume Consumes source methods while their operation lease remains active.
 * @param signal Caller observation cancellation.
 * @returns The consumed value with actual reservation and source retention held until release.
 */
withBundleSource<T>(version: SkillBundleVersion, consume: (source: SkillBundleSource, control: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<ResidentResult<T>>

/**
 * Export every member of the exact authorized version as a bounded ZIP.
 * @param version Exact issued authorized source version.
 * @param signal Actual export observation cancellation.
 * @returns The complete owned archive, retained through release.
 */
exportBundle(version: SkillBundleVersion, signal: AbortSignal): Promise<ResidentResult<Uint8Array<ArrayBuffer>>>

/**
 * Materialize the complete tree under the original issued project, preserving existing writable copies.
 * @param project Original issued active project grant.
 * @param version The exact operation-scoped source.version lease when called inside source consumption.
 * @param signal Observation cancellation; actual copy work retains its original owner.
 * @returns An issued complete working copy after confirmed publication and protected association CAS.
 */
materializeBundleVersion(project: SkillProjectGrant, version: SkillBundleVersion, signal: AbortSignal): Promise<ResidentResult<SkillBundleWorkingCopy>>

/**
 * Fix the actual skills parent before allocation, without creating any sandbox or binding an environment slot.
 * @param project Exact installed/projectFor object after Root's actual native caller selection.
 * @param signal Cancellation leaves all actual I/O with the original files lane.
 * @returns Parent facts retained until the original allocation/export actual joins release the result.
 */
async prepareSkillProject(project: AccountFilesProject, signal: AbortSignal): Promise<ResidentResult<SkillProjectGrant>>

/**
 * Fully publish a fixed two-file version or reuse its protected association while preserving user edits.
 * @param project Exact actively borrowed parent grant from this owner.
 * @param version Exact original immutable version capability.
 * @param signal Observer cancellation cannot settle running native work or ambiguous publication.
 * @returns A complete current-project resource base and persistent issued copy handle; release ends this I/O result, not the copy.
 */
materializeSkillVersion(project: SkillProjectGrant, version: SkillVersion, signal: AbortSignal) : Promise<ResidentResult<SkillWorkingCopyGrant>>

/**
 * Borrow complete issued full-tree copies through actual operation settlement, independently of the parent lease.
 * @param project Original active project grant.
 * @param copies Exact issued same-project copies.
 * @param signal Preparation observation cancellation.
 * @returns The complete operation borrow retained through actual remote, local and physical settlement.
 */
borrowBundleWorkingCopies(project: SkillProjectGrant, copies: readonly (SkillWorkingCopyGrant | SkillBundleWorkingCopy)[], signal: AbortSignal): Promise<ResidentResult<SkillBundleOperationCopies>>

/**
 * Derive the complete bounded persisted copy set, including legacy copies, and retain it for one operation.
 * @param project Original active project grant.
 * @param signal Preparation observation cancellation.
 * @returns The complete confirmed operation set retained through release.
 */
borrowAllBundleWorkingCopies(project: SkillProjectGrant, signal: AbortSignal): Promise<ResidentResult<SkillBundleOperationCopies>>

/**
 * Require the original unreleased full-tree operation result before granting execution access.
 * @param value Exact original operation borrow.
 */
assertBundleOperationCopies(value: SkillBundleOperationCopies): void

/**
 * Revalidate protected associations and actual directories for each original operation before role issuance.
 * @param project Original allocation parent grant still retained by its export/allocation.
 * @param copies Exact issued same-project handles selected by the original trusted caller.
 * @param signal Actual preparation cancellation; the result must survive any subsequent observer cancellation.
 * @returns Bounded facts held through original whenEmpty+localSettled or joined physical-stop completion.
 */
borrowSkillWorkingCopies(project: SkillProjectGrant, copies: readonly SkillWorkingCopyGrant[], signal: AbortSignal) : Promise<ResidentResult<SkillOperationCopies>>

/**
 * Derive and borrow every confirmed copy for this project without an API/execution-owned membership cache.
 * @param project Original active allocation parent capability.
 * @param signal Preparation cancellation; actual work and the returned result retain original ownership.
 * @returns The complete bounded set after actual association/source/directory checks; any unqualified version or excess rejects
 * the whole set.
 */
borrowAllSkillWorkingCopies(project: SkillProjectGrant, signal: AbortSignal): Promise<ResidentResult<SkillOperationCopies>>

/**
 * Require an exact active parent result before Root captures export/allocation facts.
 * @param grant Original issued capability from this owner.
 */
assertSkillProjectGrant(grant: SkillProjectGrant): void

/**
 * Require an exact current persistent copy handle; execution additionally needs a live operation borrow.
 * @param grant Original issued capability from this owner.
 */
assertSkillWorkingCopy(grant: SkillWorkingCopyGrant): void

/**
 * Require the original unreleased operation result before signing/using its fixed facts.
 * @param grant Original issued capability from this owner.
 */
assertSkillOperationCopies(grant: SkillOperationCopies): void

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

Types: [FileAttachmentRef](attachment.md) · [LocalAttachmentStore](../../packages/attachment/attachment-local/README.md) · [SkillBundleInput](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillBundleOperationCopies](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillBundleSource](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillBundleVersion](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillBundleWorkingCopy](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillCatalog](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillCatalogChange](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillCatalogCommit](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillOperationCopies](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillProjectGrant](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillVersion](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [SkillVersionPort](../../packages/cloud/pe-cloud-files/README.md#understand-the-implementation) · [SkillWorkingCopyGrant](../../packages/cloud/pe-cloud-files/README.md#use-this-package) · [Workspace](workspace.md)

Source: [`packages/cloud/pe-cloud-files/src/account-service.ts`](../../packages/cloud/pe-cloud-files/src/account-service.ts)

<a id="ctxpeexposure--exposureservice"></a>

### `ctx.peExposure` — `ExposureService`

Root policy provider; registering it does not publish account readiness.

Source: [`packages/cloud/pe-cloud-api/src/root.ts`](../../packages/cloud/pe-cloud-api/src/root.ts)

<a id="ctxpesandboxcoordinator--sandboxcoordinator-abstract-seam"></a>

### `ctx.peSandboxCoordinator` — `SandboxCoordinator` (abstract seam)

A concrete implementation must register as runtime's mandatory execution participant and verify its own required execution capabilities or explicit closed mode before readiness. This definition supplies neither an implementation nor an empty-work stopping receipt.

```ts cordis-catalog
/** Closed/unqualified coordinators cannot certify account idleness.
 * @param _binding Original account generation.
 * @returns False until an actual coordinator implements its own work observation.
 */
isEpochIdle(_binding: AccountBinding): boolean

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
