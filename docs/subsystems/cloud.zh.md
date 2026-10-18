# 云端账户集成

[English](cloud.md) | 中文

[云端包导航](../../packages/cloud/README.zh.md)列出按需装配的部署组件。本参考说明它们共享的 runtime 输入；激活前提由各包 README 持有。这些组件不增加另一套 Session 实现。

<a id="account-identities"></a>
## 账户身份

runtime 包持有[账户身份及生命周期类型](../../packages/cloud/pe-cloud-runtime/src/types.ts)。`AccountId` 标识经过认证的数据库账户。`OwnerEpoch` 保留 PostgreSQL 十进制值，不转换为 JavaScript number。`InstanceId` 标识一次服务进程启动，`OperationId` 标识其处理责任可能超过请求生命周期的实际工作。

`AccountBinding` 是单个账户图的不可变可信输入。它的 lifetime signal 属于该图；取消调用者的等待不会取消图的生命周期。`AccountUse` 借用原生 Context，在调用原生工作前立即检查当前准入，并且只释放这次借用。两者都不接受浏览器 JSON 输入。

`AccountStorageKey` 是服务端派生的稳定目录键。`AccountLayout` 包含共享账户数据和进程本地可重建索引的不可变绝对地址；地址不证明目录存在，也不授予文件权限或配额。`AccountMountInput` 将该布局与精确图 binding、当前进程身份及原生 `LaunchEnvironmentSnapshot` 组合。runtime 先派生账户与项目候选地址，再由 files 核验或准备；默认项目资格和登记仍由原生 Workspace 负责。

私有原生启动适配在挂载一个原生 root Include 前，安装独立的 `ProfileContext`、启动环境和账户 binding。port 准备使用实际安装的同一个 binding。准备结束后，适配器先复查该生命周期，再将控制权交回原生 boot；调用者停止等待后，boot 与销毁仍持有实际 Promise。原生树挂载完成后，仍须通过工厂的 provider、保存及暴露清单审核，才能服务账户。

<a id="actual-work-and-capacity"></a>
## 实际工作与容量

runtime 根只登记两类必需参与者：`files` 和 `execution`。登记属于调用者的 Cordis effect，在该 effect 销毁时撤销。重复登记和缺少参与者都会使装配容量预留失败。

`ParticipantReceipt` 记录账户、epoch、参与者和证据。confirmed 收据没有待完成 operation id。unknown 收据保留待完成工作及原因；请求到期或等待失败不能证明实际工作已经停止。

本地装配和排空预留限制并发工作。装配工作结算只释放操作槽；账户驻留槽持续预留，直到拥有者在实际清理后释放。这些预留不领取数据库 owner，也不证明账户 ready。

files 根预建固定 worker 池。单账户排空保留共享池；根关闭时，worker 实际退出且持有结果释放后，才撤销服务与参与者。API 配置保存收据另行通过实际 Promise 跟踪已准入的原生写入及必要应用。配置保存不增加第三个排空参与者，失败或未解决的保存不能证明账户图 clean。

<a id="native-adapters"></a>
## 原生适配

云端请求一致性使用 [access 持有的请求类型](../../packages/cloud/pe-cloud-access/src/types.ts)。客户端账户和代际字段表达预期，不是认证凭据。原生 HTTP、流和控制器适配保留原来的传输消息及原生 Session 状态。

Access 持有 `CloudBootstrap` 及其浏览器安全校验器 `decodeCloudBootstrap`。响应包含展示身份、配方、不透明连接代际及脱敏能力。`BootstrapDecodeLimits` 限制紧凑 JSON 字节、UTF-8 字符串字节和列表项总量；载体另在 JSON 解析前限制原始响应字节。解码返回独立且深冻结的元数据，不证明认证、能力批准或账户 ready。禁用能力描述区分未批准功能和临时通道不可用；配置字段只描述允许选择及应用等级，不携带值或提交权限。

`PeAuthService` 由 access/root 安装，拥有一个有界 PostgreSQL 池、官方凭据读取、实际 Better Auth 初始化及 schema 检查。`AuthRootConfig` 在浏览器安全访问配置之外，显式设置数据库、池、凭据和启动预算。观察结果只提供有界资源计数及关闭的请求准入。缺失 schema 或初始化失败时保留清理责任；提供者不执行迁移、不注册路由。共享 HTTP/WS 准入仍须通过 runtime 的实际根配方审核并具备账户提供者。

可信 runtime 在准备阶段，以精确账户 binding、根签发配置保存屏障、部署开放上限及独立挂载/业务准入核验安装 `CloudAccountApi`。固定的原生编辑器和凭据构造函数在初始化前安装保存 hook。Controller、AgentLoop 和 LLM 安装沿用既有原生守卫；`/account` 核验这个准备好的服务。安装和入口激活不发布就绪。每次业务操作要求独立的当前 ready 核验，inventory 审核和终止保存结算各自保留生命周期规则。

原生 Session 适配保留原有派发、DTO 和 Session 状态，并在实际副作用前执行守卫。可等待的目录准备在创建 Agent 前使用账户固定 files 能力。账户发布前仍须完成产品路由、项目/Preset/模型核验、实际原生 inventory 及持久存储授权。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

<a id="ctxpeaccountruntime--accountruntimeservice"></a>

### `ctx.peAccountRuntime` — `AccountRuntimeService`

Shared service definition; providers need no dependency on Host control implementation.

```ts cordis-catalog
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

Types: [AgentLoop](core.zh.md) · [SessionController](session.zh.md)

Source: [`packages/cloud/pe-cloud-api/src/account-service.ts`](../../packages/cloud/pe-cloud-api/src/account-service.ts)

<a id="ctxpecloudfiles--cloudaccountfiles"></a>

### `ctx.peCloudFiles` — `CloudAccountFiles`

One graph's real Registry/FS installation; shared pool drain and directory responsibility stay with their original owners.

```ts cordis-catalog
/**
 * Require this exact prepared owner and current binding without granting business admission.
 * @param owner Native scope in the original account graph; omission checks the calling service scope.
 */
assertInstalled(owner: Context = this.ctx): void

/**
 * Install the sole original native Registry, await its default result, then install its fixed S2 FileSystem.
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
```

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
 * @returns an account-only port; issuance does not establish account readiness.
 */
abstract bindAccount(ctx: Context, binding: AccountBinding, assertCurrent: () => void): AccountExecutionPort

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
