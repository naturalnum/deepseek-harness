# 云端账户集成

[English](cloud.md) | 中文

[云端包导航](../../packages/cloud/README.zh.md)列出按需装配的部署组件。本参考说明它们共享的 runtime 输入；激活前提由各包 README 持有。这些组件不增加另一套 Session 实现。

`ApprovedConfigurationField` 选择有限的原生命名空间／字段对及可选标量取值。获批字段必须存在于原活动 Settings schema；保存仍受原生 revision 与 none/live 更新计划约束。`locale.preference` 保留精确的 `zh`／`en` 策略。写入由原登录 Use 和账户保存 owner 执行；bootstrap 元数据不授予写能力。见 [cloud API](../../packages/cloud/pe-cloud-api/README.zh.md)。

<a id="account-identities"></a>
## 账户身份

runtime 包持有[账户身份及生命周期类型](../../packages/cloud/pe-cloud-runtime/src/types.ts)。`AccountId` 标识经过认证的数据库账户。`OwnerEpoch` 保留 PostgreSQL 十进制值，不转换为 JavaScript number。`InstanceId` 标识一次服务进程启动，`OperationId` 标识其处理责任可能超过请求生命周期的实际工作。

`AccountBinding` 是单个账户图的不可变可信输入。它的 lifetime signal 属于该图；取消调用者的等待不会取消图的生命周期。`AccountUse` 借用原生 Context，在调用原生工作前立即检查当前准入，并且只释放这次借用。两者都不接受浏览器 JSON 输入。

`AccountStorageKey` 是服务端派生的稳定目录键。`AccountLayout` 包含共享账户数据和进程本地可重建索引的不可变绝对地址；地址不证明目录存在，也不授予文件权限或配额。`AccountMountInput` 将该布局与精确图 binding、当前进程身份及原生 `LaunchEnvironmentSnapshot` 组合。runtime 先派生账户与项目候选地址，再由 files 核验或准备；默认项目资格和登记仍由原生 Workspace 负责。

私有原生启动适配在挂载一个原生 root Include 前，安装独立的 `ProfileContext`、启动环境和账户 binding。port 准备使用实际安装的同一个 binding。准备结束后，适配器先复查该生命周期，再将控制权交回原生 boot；调用者停止等待后，boot 与销毁仍持有实际 Promise。原生树挂载完成后，仍须通过工厂的 provider、保存及暴露清单审核，才能服务账户。

<a id="actual-work-and-capacity"></a>
## 实际工作与容量

`SubagentCapacityReservation` 从同一 Root 容量 owner 预留一个实际驻留的子级（[声明](../../packages/cloud/pe-cloud-runtime/src/types.ts)）。首次 `settle('confirmed' | 'unknown')` 即为最终结算：清理 confirmed 释放该子级槽位；unknown 永久保留槽位并阻止账户释放。

runtime 根只登记两类必需参与者：`files` 和 `execution`。登记属于调用者的 Cordis effect，在该 effect 销毁时撤销。重复登记和缺少参与者都会使装配容量预留失败。

`RootMetadataDatabase` 是 runtime 为具备 `closeRoot()` 的原始 Root 参与者签发的参数化查询能力。它共用 runtime 执行器，不暴露凭据、数据库选择或驱动关闭权。撤销登记及 Root 关闭先等待该参与者的实际清理，再撤销借用能力；清理未确认时保留责任。其 `wasNotSubmitted()` 谓词只识别原驱动适配在 SQL 提交前已结束的失败。

`AccountOwnerResolver` 是普通 active Root 的只读 facade。`AccountOwnerResolution` 包含经过复查的 ready owner 和 registered 实例；元数据缺失、停止、不一致或变化时拒绝，原查询失败原样传播。它不授予 `AccountUse` 或网络准入。[runtime 包](../../packages/cloud/pe-cloud-runtime/README.zh.md#process-instance-metadata)定义读取与关闭上限。

`AccountRuntimeService.borrowOwnedAccount` 按精确本机 owner 观察借用既有 ready factory 图，复查 owner 和 Root，失败时释放 borrow。它不进入账户领取；该行为由 [runtime](../../packages/cloud/pe-cloud-runtime/README.zh.md#process-instance-metadata)定义。

`RootIngressCloseOwner` 在调用方 effect 中保留唯一原 Access 关闭操作，直至实际结算。Runtime 在元数据和账户关闭前等待它；登记只建立此关闭顺序。可选的 `activeInstanceId` 是原 Host 内部元数据，不授予业务准入。

`ParticipantReceipt` 记录账户、epoch、参与者和证据。confirmed 收据没有待完成 operation id。unknown 收据保留待完成工作及原因；请求到期或等待失败不能证明实际工作已经停止。

本地装配和排空预留限制并发工作。装配工作结算只释放操作槽；账户驻留槽持续预留，直到拥有者在实际清理后释放。这些预留不领取数据库 owner，也不证明账户 ready。

files 根预建固定 worker 池。单账户排空保留共享池；根关闭时，worker 实际退出且持有结果释放后，才撤销服务与参与者。API 配置保存收据另行通过实际 Promise 跟踪已准入的原生写入及必要应用。配置保存不增加第三个排空参与者，失败或未解决的保存不能证明账户图 clean。

`ConfigSaveBarrier` 是 runtime 拥有的进程内控制器，负责一个 graph 的保存准入、待处理工作、保留的失败及 pause/resume/stop 收敛（[声明](../../packages/cloud/pe-cloud-api/src/save-hooks.ts)）。它携带精确的 `AccountBinding`，并把原生持久化与必需应用一同保留。`CloudAccountApi.inspectConfigurationSaves()` 返回其脱敏 `ConfigSaveSnapshot`，不返回或序列化这个控制对象。

<a id="native-adapters"></a>
## 原生适配

云端请求一致性使用 [access 持有的请求类型](../../packages/cloud/pe-cloud-access/src/types.ts)。客户端账户和代际字段表达预期，不是认证凭据。原生 HTTP、流和控制器适配保留原来的传输消息及原生 Session 状态。

Access 持有 `CloudBootstrap` 及其浏览器安全校验器 `decodeCloudBootstrap`。响应包含展示身份、配方、不透明连接代际及脱敏能力。`BootstrapDecodeLimits` 限制紧凑 JSON 字节、UTF-8 字符串字节和列表项总量；载体另在 JSON 解析前限制原始响应字节。解码返回独立且深冻结的元数据，不证明认证、能力批准或账户 ready。禁用能力描述区分未批准功能和临时通道不可用；配置字段只描述允许选择及应用等级，不携带值或提交权限。

`PeAuthService` 由 access/root 安装，拥有一个有界 PostgreSQL 池、官方凭据读取、实际 Better Auth 初始化及 schema 检查。`AuthRootConfig` 在浏览器安全访问配置之外，显式设置数据库、池、凭据和启动预算。观察结果只提供有界资源计数及关闭的请求准入。缺失 schema 或初始化失败时保留清理责任；提供者不执行迁移、不注册路由。共享 HTTP/WS 准入仍须通过 runtime 的实际根配方审核并具备账户提供者。

可信 runtime 在准备阶段，以精确账户 binding、根签发配置保存屏障、部署开放上限及独立挂载/业务准入核验安装 `CloudAccountApi`。固定的原生编辑器和凭据构造函数在初始化前安装保存 hook。Controller、AgentLoop 和 LLM 安装沿用既有原生守卫；`/account` 核验这个准备好的服务。安装和入口激活不发布就绪。每次业务操作要求独立的当前 ready 核验，inventory 审核和终止保存结算各自保留生命周期规则。

原生 Session 适配保留原有派发、DTO 和 Session 状态，并在实际副作用前执行守卫。可等待的目录准备在创建 Agent 前使用账户固定 files 能力。账户发布前仍须完成产品路由、项目/Preset/模型核验、实际原生 inventory 及持久存储授权。

`CloudProjectCreateRequest` 仅携带可选标题；`CloudProjectsPreparation` 捕获 `CloudProjectsService` 使用的可信分配回调（[声明](../../packages/cloud/pe-cloud-api/src/cloud-projects.ts)、[请求](../../packages/cloud/pe-cloud-api/src/types.ts)）。`NativeUploadPreparation` 提供待处理收据限额和须等待的流式持久化钩子，收据仍由原生上传服务拥有（[声明](../../packages/cloud/pe-cloud-api/src/native-uploads.ts)）。

files 拥有的 `ResidentResult<T>` 将值与其预留释放操作配对（[声明](../../packages/cloud/pe-cloud-files/src/work-queue.ts)）。`StageFileResult` 将原生暂存事实与附件引用、项目内副本相对路径配对（[声明](../../packages/cloud/pe-cloud-files/src/stage-bridge.ts)）；`InstructionReadReaders` 提供受限项目 reader 和可选账户 reader（[声明](../../packages/cloud/pe-cloud-files/src/instruction-read-work.ts)）。`EnvironmentSessionId` 是原生 Workspace 成员关系中的 Session id 类型；`ExecutionMountGrant` 描述原始 binding、Session/项目选择、实测项目/环境身份及额度和只读 `.pe` 策略（[声明](../../packages/cloud/pe-cloud-files/src/environment-bank.ts)）。

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
## 已批准插件控制

`CloudPluginService` 是批准的预安装插件及 bundle 的账户原生 Remote。它的 `current` 与 `change` 方法使用原 Peer、保存 owner 和原生 profile 写入器；服务对象属于 Host 安装，不是浏览器 payload。[cloud API 包](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation)拥有激活、准入与应用要求。

[`PluginCurrentRequest`](../../packages/cloud/pe-cloud-api/src/plugin-types.ts) 携带获批目录中的 `id`。`PluginCurrentState` 包含该 `id`、作为 `plugin` 的原生 `PluginInfo` 或作为 `bundle` 的原生 `BundleInfo`、条目或插件包 `selectionTarget`、允许的 `operations`、`maxImpact`、普通 `configuration.fields`，以及包含账户 `epoch` 与不透明 `editToken` 的 `version`。每个字段携带获批 `path`、原生 JSON `schema`、省略语义、限制、`writable` 权限、可选 `readOnlyReason`、相对秘密存在标记，以及存在且允许披露的原始值。版本不公开 profile 字节或其摘要；[boot 子系统](boot.zh.md)拥有原生 inventory 字段。

没有修改权限的获批条目仍可读取原生 inventory，此时 `operations` 和 `configuration.fields` 为空，不提供 `maxImpact`。读取不授予修改权限，每次修改仍须具有显式目录控制。

`PluginChangeRequest` 在获批 id 之外携带原始 `version`、显式 `mode`（`if-idle` 或 `stop-and-apply`）和一个 `operation`。操作为 `{ kind: 'enabled', enabled: boolean }`、`{ kind: 'selected', selected: boolean }` 或 `{ kind: 'configure', path: string[], value: JsonValue }`，受目录与原生计划约束。配置仅接受一个获批普通路径上的字面 JSON，没有 unset 操作。请求不接受模块 specifier、profile 路径、Peer 或账户授权。

`PluginChangeResult` 区分 `{ kind: 'applied', value: PluginCurrentState, native?: ChangeResult }` 与 `{ kind: 'accepted-rebuild', operationId: OperationId }`。Applied 表示原生应用和原账户复审均已完成。重建接受要求重新连接并读取实际状态，不证明应用已经完成。可选原生 `ChangeResult` 保留其 [boot 所有的语义](boot.zh.md)。

`ConfigurationPeerOperation<T>` 是 [access Peer registry](../../packages/cloud/pe-cloud-access/src/peers.ts) 拥有的可信 Host 回调，API 侧保留[结构相同的声明](../../packages/cloud/pe-cloud-api/src/plugin-types.ts)。它接收原 binding 与 Context、登录复查、observer 关闭回调，以及 `afterRequest`、`closeAll(deadlineAtMs)`、`assertPrincipal` handoff 回调。这些进程内值不是 JSON 请求字段，也不发放替代授权。

`PluginRebuildIntent` 包含获批 `id`、服务器拥有的 patch/manifest `revision` 与已检查的 `operation`。旧保存 owner 核验该 revision 及其不透明 edit 后，原 factory 通过已停止旧图的原 writer 提交，再销毁旧图并装配新 epoch。浏览器提交的是 `PluginChangeRequest`，不是这个内部 intent。

`ApprovedConfigurationBundle` 固定预安装包/版本及完整成员的 entry/module/package/version 标识，仅提供 graph 级选择控制。`PluginCurrentState.selectionTarget.kind` 区分原生条目的 `plugin` 与原生 `bundle`；只读条目 inventory 省略 `maxImpact`。`PluginRebuildPersistence` 保留旧 epoch、原生保存结果及私有磁盘版本，`PluginRebuildVerification` 将其与审核后的新状态配对。Runtime 的 `ConfigurationRebuildReceipt<T, V>` 仅在不同 epoch 通过 intent 核验及原 ready CAS 后完成；这些 Host 值不属于 Remote 返回字段。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [ModelKeyMetadata](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [ModelKeyReference](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [ModelKeySaved](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [ModelKeySet](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [ModelKeyState](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [ModelKeyUnset](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation)

Source: [`packages/cloud/pe-cloud-api/src/cloud-model-key.ts`](../../packages/cloud/pe-cloud-api/src/cloud-model-key.ts)

<a id="ctxcloudnativesettings--cloudnativesettingsservice"></a>

### `ctx.cloudNativeSettings` — `CloudNativeSettingsService`

Original registry readers behind exact account/Peer use and bounded public projections.

```ts cordis-catalog
/** Read the original account Loader and declared preset rows without manager authority.
 * @param signal Caller cancellation.
 * @returns Native DTO with public metadata and account management disabled.
 */
@Remote('inventory') inventory(signal: AbortSignal): Promise<PluginInventorySnapshot>

/** Read actual declared preset display metadata, without selecting or composing a Session.
 * @param signal Caller cancellation.
 * @returns Original roster with private failure diagnostics removed.
 */
@Remote('presets') presets(signal: AbortSignal): Promise<AgentPresetRoster>

/** Read one actual composition as public module/state rows, excluding raw YAML and config values.
 * @param request Exact preset identity from this account's roster.
 * @param signal Caller cancellation.
 * @returns Original preset summary; a missing identity rejects without revealing other resources.
 */
@Remote('readPreset') readPreset(request: CloudPresetReference, signal: AbortSignal): Promise<CloudPresetComposition>

/** Require this service and both original provider registrations in the same account root. */
assertCurrent(): void

/** Inspect exact concrete unary markers and generated strict cancellation descriptors.
 * @returns Only the three authenticated read endpoints.
 */
inspect(): ExposureInventory
```

Types: [CloudPresetComposition](../../packages/cloud/pe-cloud-api/README.zh.md#readonly-native-settings) · [CloudPresetReference](../../packages/cloud/pe-cloud-api/README.zh.md#readonly-native-settings) · [PluginInventorySnapshot](../../packages/host/plugin-inventory/README.zh.md#use-this-package)

Source: [`packages/cloud/pe-cloud-api/src/cloud-native-settings.ts`](../../packages/cloud/pe-cloud-api/src/cloud-native-settings.ts)

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

Types: [PluginChangeRequest](cloud.zh.md#approved-plugin-controls) · [PluginChangeResult](cloud.zh.md#approved-plugin-controls) · [PluginCurrentRequest](cloud.zh.md#approved-plugin-controls) · [PluginCurrentState](cloud.zh.md#approved-plugin-controls)

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

Types: [WorkspaceValue](workspace.zh.md)

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

Types: [ManagedSkillDetails](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [ManagedSkillDetailsRequest](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [ManagedSkillDownload](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [ManagedSkillDownloadRequest](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [ManagedSkillInstallRequest](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [ManagedSkillMutationResult](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [ManagedSkillUninstallRequest](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [ManagedSkillUpdateRequest](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [ManagedSkillsInstalled](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [ManagedSkillsInstalledRequest](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [SkillCurrentRequest](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [SkillCurrentState](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [SkillPublishRequest](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [SkillPublishResult](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication)

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

Types: [Session](session.zh.md)

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

Types: [Config](../../packages/cloud/pe-account-instructions/README.zh.md#minimal-configuration)

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

Types: [RootIngressCloseOwner](cloud.zh.md#actual-work-and-capacity)

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

Types: [ConfigurationPeerOperation](cloud.zh.md#approved-plugin-controls)

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

/** Register the account's readonly native inventory and preset summaries.
 * @param owner Actual account Loader entry after original providers activate.
 * @param input Captured login Peer consumer and existing native read budgets.
 * @returns The sole concrete readonly Remote service.
 */
prepareCloudNativeSettings(owner: Context, input: CloudNativeSettingsPreparation): CloudNativeSettingsService

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

Types: [AgentLoop](core.zh.md) · [CloudModelKeyPreparation](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [CloudModelKeyService](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [CloudNativeSettingsPreparation](../../packages/cloud/pe-cloud-api/README.zh.md#readonly-native-settings) · [CloudNativeSettingsService](../../packages/cloud/pe-cloud-api/README.zh.md#readonly-native-settings) · [CloudPluginService](cloud.zh.md#approved-plugin-controls) · [CloudSkillPreparation](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [CloudSkillService](../../packages/cloud/pe-cloud-api/README.zh.md#controlled-sample-publication) · [ConfigSaveBarrier](cloud.zh.md#actual-work-and-capacity) · [FileUploads](attachment.zh.md) · [ModelKeyAccess](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [NativeCommands](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [NativeGoals](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [NativePermissions](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [NativeUserQuestions](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [PluginRebuildIntent](cloud.zh.md#approved-plugin-controls) · [PluginRebuildPersistence](cloud.zh.md#approved-plugin-controls) · [PluginRebuildVerification](cloud.zh.md#approved-plugin-controls) · [SessionController](session.zh.md) · [SubagentCapacityReservation](cloud.zh.md#actual-work-and-capacity) · [WorkspaceFiles](workspace.zh.md) · [createNativeGoals](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [createNativeMessageFeedback](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [createNativePermissions](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [createNativeSessionExport](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation) · [createNativeSessionFeedback](../../packages/cloud/pe-cloud-api/README.zh.md#understand-the-implementation)

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

Types: [FileAttachmentRef](attachment.zh.md) · [LocalAttachmentStore](../../packages/attachment/attachment-local/README.zh.md) · [SkillBundleInput](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillBundleOperationCopies](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillBundleSource](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillBundleVersion](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillBundleWorkingCopy](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillCatalog](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillCatalogChange](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillCatalogCommit](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillOperationCopies](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillProjectGrant](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillVersion](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [SkillVersionPort](../../packages/cloud/pe-cloud-files/README.zh.md#understand-the-implementation) · [SkillWorkingCopyGrant](../../packages/cloud/pe-cloud-files/README.zh.md#use-this-package) · [Workspace](workspace.zh.md)

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
