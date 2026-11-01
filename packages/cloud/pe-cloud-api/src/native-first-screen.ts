import { projectApprovedSettings, projectApprovedSettingsNamespace } from './approved-settings.ts'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-command-feedback'
import type {} from '@deepseek-ai/dsh-message-feedback'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { ApprovedConfigurationField } from './types.ts'
/** Fixed native first-screen readers; original registries, DTOs and iteration remain authoritative. */
import { isDeepStrictEqual } from 'node:util'
import { FiberState, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import type {
  WorkspaceCreateRequest, WorkspaceCreateValue, WorkspaceFollowFrame, WorkspaceRenameRequest, WorkspaceValue, WorkspaceView,
  WorkspaceArchiveSessionRequest, WorkspaceUnarchiveSessionRequest, WorkspaceArchiveValue,
  WorkspacePinSessionRequest, WorkspaceUnpinSessionRequest, WorkspacePinValue,
} from '@deepseek-ai/dsh-api-workspace-controller/types'
import SettingsController, { type SettingsControllerInternals } from '@deepseek-ai/dsh-api-settings-controller'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceRegistry, { type Workspace } from '@deepseek-ai/dsh-workspace'
import Settings from '@deepseek-ai/dsh-settings'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import * as Locale from '@deepseek-ai/dsh-client-locale'
import { RemoteError, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CloudAccountApi } from './account-service.ts'
import { CloudApiError } from './errors.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import type { ExposureInventory } from './types.ts'
import type { ModelKeyPeerConsumer } from './cloud-model-key.ts'
import type { NativeConfigSaveHook } from './save-hooks.ts'
import { ConfigSaveOutcomeUnknown } from './config-saves.ts'
import type { ProfileConfigUpdatePlan } from '@deepseek-ai/dsh-app-boot'

/** Original service and its actual registration fiber, not a readiness or authorization certificate. */
export interface FirstScreenNativeOwner { readonly value: object; readonly fiber: Fiber }

/** The original login consumer and its finite native field approvals. */
export interface NativeSettingsWritePolicy extends ModelKeyPeerConsumer {
  readonly fields: readonly ApprovedConfigurationField[]
}

/** Trusted graph inputs; the project callback reads the original installed files owner. */
export interface FirstScreenNativeInput {
  readonly api: CloudAccountApi
  readonly binding: AccountBinding
  readonly project: () => { readonly binding: AccountBinding; readonly workspace: Workspace }
  /** Validate one exact current Registry object without choosing a project from its display path. */
  readonly assertWorkspace: (workspace: Workspace) => void
  /** Check actual native Session metadata for readonly publication; never issue a ProjectScope from an id or cwd. */
  readonly assertSessionRead: (id: SessionId) => void
  readonly maxInventoryEntries: number
  readonly maxCollectionItems: number
  readonly maxFrameBytes: number
  /** Optional original login Peer consumer; omission keeps native settings writes closed. */
  readonly settingsWrites?: NativeSettingsWritePolicy
  /** Account-owned C04 field check captured by the API preparation. */
  readonly assertSettingsFields: (namespace: string, fields: readonly string[]) => void
  /** Bind an approved write to the existing model-provider audit, if one is installed. */
  readonly beginModelSettingsUpdate: (namespace: string, ops: readonly SettingsPathOpView[]) => {
    check(): void
    approve(plan: ProfileConfigUpdatePlan): void
    finish(): void
  }
  /** Original account policy transaction for a reviewed native setting, if supplied by Runtime. */
  readonly beginAccountSettingsUpdate?: (namespace: string, ops: readonly SettingsPathOpView[],
    fields: readonly ApprovedConfigurationField[]) => {
    check(): void
    approve(plan: ProfileConfigUpdatePlan): void
    finish(): void
    publish(audit: () => void): void
    abort(uncertain?: boolean): void
    run<T>(operation: () => Promise<T>): Promise<T>
  }
  /** Permit only an account-policy-validated reset to an already approved inherited value. */
  readonly allowAccountSettingsUnset?: (namespace: string, field: string,
    values: readonly (string | number | boolean | null)[]) => boolean
  /** Own the original Settings write and its mandatory post-apply audit in the same serial turn. */
  readonly settingsSave: NativeConfigSaveHook
}

/** Fixed constructors and actual facts for later assembly into the API owner's complete inventory. */
export interface NativeFirstScreen {
  readonly binding: AccountBinding
  readonly workspaceController: typeof WorkspaceController
  readonly settingsController: typeof SettingsController
  /** Check original graph, project, providers and locale fiber; grants no business admission. */
  assertCurrent(): void
  /** Read original guarded methods and the stock RemoteAccess method; API owns outer C04 admission. */
  inspect(): ExposureInventory
  /** Check real Session metadata through the original shared policy. */
  assertSessionRead(id: SessionId): void
  /** Hold event delivery while the current settings save still owns uncommitted native state. */
  pendingSettingsSave(): Promise<void> | undefined
}

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original first-screen native installation is unavailable.')
}

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}

/**
 * Find a fixed native service's actual owner through bounded public Cordis registration metadata.
 * @param ctx - original account scope.
 * @param key - one reviewed account native service key.
 * @param value - actual class instance already checked by its consumer.
 * @param maximum - required positive visit bound, with no production default.
 * @returns the sole original service registration and fiber.
 * @throws CloudApiError on a foreign, replaced, duplicate, inactive or over-budget registration.
 */
export function firstScreenNativeOwner(
  ctx: Context,
  key: 'workspaceRegistry' | 'settings' | 'remoteAccess' | 'typertGateway' | 'workspaceController' | 'settingsController'
    | 'sessionSkillCatalog' | 'commands' | 'goals' | 'connection' | 'sessionFeedback' | 'messageFeedback'
    | 'permissionPresets' | 'userQuestions' | 'pluginInventory' | 'schedule',
  value: object, maximum: number,
): FirstScreenNativeOwner {
  if (!Number.isSafeInteger(maximum) || maximum < 1) unavailable()
  const target = original(value)
  const local = ctx.get(key), root = ctx.root.get(key)
  if (local === undefined || root === undefined || original(local) !== target || original(root) !== target) unavailable()
  let visited = 0, found: Fiber | undefined
  for (const runtime of ctx.registry.values()) {
    if (++visited > maximum) unavailable()
    for (const fiber of runtime.fibers) {
      if (++visited > maximum) unavailable()
      if (fiber.ctx.root !== ctx.root || fiber.state !== FiberState.ACTIVE) continue
      const installed = fiber.store?.[key], registered: unknown = installed?.value
      if (installed?.fiber !== fiber) continue
      if (registered === null || typeof registered !== 'object' || original(registered) !== target || found !== undefined) unavailable()
      found = fiber
    }
  }
  if (found === undefined) unavailable()
  return { value: target, fiber: found }
}

/**
 * Prepare two fixed native subclasses before their Loader entries activate.
 * Root supplies actual files/policy facts and later joins these facts into its full prepared audit.
 * @param ctx - independent graph's prepare scope with its original API owner installed.
 * @param input - fixed trusted graph owners and explicit finite bounds.
 * @returns native constructors and live installation checks; no ready flag or complete account inventory.
 */
export function prepareNativeFirstScreen(ctx: Context, input: FirstScreenNativeInput): NativeFirstScreen {
  if (input.allowAccountSettingsUnset !== undefined && input.beginAccountSettingsUpdate === undefined) unavailable()
  for (const value of [input.maxInventoryEntries, input.maxCollectionItems, input.maxFrameBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) unavailable()
  }
  const api = original(input.api)
  const follow: unknown = Reflect.get(WorkspaceController.prototype, 'follow')
  const rename: unknown = Reflect.get(WorkspaceController.prototype, 'rename')
  const describe: unknown = Reflect.get(SettingsController.prototype, 'describe')
  const remoteFollow: unknown = Reflect.get(RemoteAccess.prototype, 'follow')
  let workspaceOwner: FirstScreenNativeOwner | undefined, settingsOwner: FirstScreenNativeOwner | undefined
  let registryOwner: FirstScreenNativeOwner | undefined, providerOwner: FirstScreenNativeOwner | undefined
  let provider: object | undefined
  let accessOwner: FirstScreenNativeOwner | undefined, localeFiber: Fiber | undefined
  let approved: ReturnType<FirstScreenNativeInput['project']> | undefined
  let pendingSettingsSave: Promise<void> | undefined
  const settingsResponses = new WeakMap<object, SettingsNamespaceView>()

  const graph = (owner: Context): void => {
    input.api.assertInstalled(owner)
    if (owner.root !== ctx.root || input.api.binding !== input.binding || input.binding.lifetime.aborted
      || owner.get('peAccount') !== input.binding || owner.root.get('peAccount') !== input.binding
      || original(owner.get('peCloudApi') ?? {}) !== api || original(owner.root.get('peCloudApi') ?? {}) !== api) unavailable()
  }
  graph(ctx)
  const capture = (owner: Context): void => {
    graph(owner)
    const registry = owner.get('workspaceRegistry'), access = owner.get('remoteAccess')
    if (!(registry instanceof WorkspaceRegistry) || !(access instanceof RemoteAccess)) unavailable()
    const project = input.project()
    if (project.binding !== input.binding || registry.get(project.workspace.id) !== project.workspace) unavailable()
    input.assertWorkspace(project.workspace)
    const registryFact = firstScreenNativeOwner(owner, 'workspaceRegistry', registry, input.maxInventoryEntries)
    const accessFact = firstScreenNativeOwner(owner, 'remoteAccess', access, input.maxInventoryEntries)
    if (approved !== undefined && (approved.workspace !== project.workspace || registryOwner?.value !== registryFact.value
      || registryOwner.fiber !== registryFact.fiber || accessOwner?.value !== accessFact.value
      || accessOwner.fiber !== accessFact.fiber)) unavailable()
    approved = project
    registryOwner = registryFact
    accessOwner = accessFact
    graph(owner)
  }
  const current = (): void => {
    capture(ctx)
    if (provider === undefined) unavailable()
    const providerFact = firstScreenNativeOwner(ctx, 'settings', provider, input.maxInventoryEntries)
    if (providerOwner !== undefined
      && (providerOwner.value !== providerFact.value || providerOwner.fiber !== providerFact.fiber)) unavailable()
    providerOwner = providerFact
    if (workspaceOwner === undefined || settingsOwner === undefined
      || WorkspaceController.prototype.follow !== follow || WorkspaceController.prototype.rename !== rename
      || SettingsController.prototype.describe !== describe
      || RemoteAccess.prototype.follow !== remoteFollow) unavailable()
    for (const [key, expected] of [['workspaceController', workspaceOwner], ['settingsController', settingsOwner],
      ['settings', providerOwner]] as const) {
      const fact = firstScreenNativeOwner(ctx, key, expected.value, input.maxInventoryEntries)
      if (fact.fiber !== expected.fiber) unavailable()
    }
    let visited = 0, found: Fiber | undefined
    for (const entry of ctx.loader.entries()) {
      if (++visited > input.maxInventoryEntries) unavailable()
      if (entry.moduleNamespace !== Locale) continue
      if (found !== undefined || entry.options.id !== 'locale' || entry.fiber?.state !== FiberState.ACTIVE) unavailable()
      found = entry.fiber
    }
    if (found === undefined || (localeFiber !== undefined && localeFiber !== found)) unavailable()
    localeFiber = found
  }
  const bounded = (value: unknown): void => {
    firstScreenJsonBytes(value, input.maxFrameBytes)
  }
  const sessions = (ids: readonly SessionId[], workspace?: Workspace): void => {
    if (ids.length > input.maxCollectionItems || approved === undefined) unavailable()
    const registry = ctx.get('workspaceRegistry')
    if (!(registry instanceof WorkspaceRegistry)) unavailable()
    const projects = workspace === undefined ? registry.list() : [workspace]
    if (projects.length > input.maxCollectionItems) unavailable()
    for (const id of ids) {
      const owners = projects.filter(candidate => candidate.sessionIds.includes(id))
      if (owners.length !== 1 || owners[0] === undefined) unavailable()
      input.assertWorkspace(owners[0])
      input.assertSessionRead(id)
    }
  }
  const view = (value: WorkspaceView): void => {
    const workspace = ctx.get('workspaceRegistry')?.get(value.workspaceId)
    if (workspace === undefined || value.path !== workspace.path) unavailable()
    input.assertWorkspace(workspace)
    sessions(value.sessionIds, workspace)
  }
  const frame = (value: WorkspaceFollowFrame): void => {
    switch (value.type) {
      case 'baseline': case 'replace':
        if (value.value.items.length > input.maxCollectionItems) unavailable()
        for (const item of value.value.items) view(item)
        sessions(value.value.archivedSessionIds)
        sessions(value.value.pinnedSessionIds)
        break
      case 'upsert': view(value.workspace); break
      // Removal carries no content capability; its original account Registry owns the emitted identity.
      case 'remove': break
      case 'order':
        if (value.workspaceIds.length > input.maxCollectionItems
          || new Set(value.workspaceIds).size !== value.workspaceIds.length) unavailable()
        for (const id of value.workspaceIds) {
          const workspace = ctx.get('workspaceRegistry')?.get(id)
          if (workspace === undefined) unavailable()
          input.assertWorkspace(workspace)
        }
        break
      case 'archived': sessions(value.archivedSessionIds); break
      case 'pinned': sessions(value.pinnedSessionIds); break
    }
    bounded(value)
  }
  const admit = (endpoint: 'workspace/follow' | 'workspace/initializeDefault' | 'workspace/create' | 'workspace/rename' | 'settings/describe'
    | 'workspace/pinSession' | 'workspace/unpinSession' | 'workspace/archiveSession' | 'workspace/unarchiveSession'): void => {
    current()
    const row = endpoint === 'workspace/follow' ? input.api.requireStream(endpoint) : input.api.requireRpc(endpoint)
    const guard = endpoint === 'settings/describe' ? 'authenticated-account'
      : endpoint === 'workspace/follow' || endpoint === 'workspace/initializeDefault' || endpoint === 'workspace/create' || endpoint === 'workspace/rename'
        ? 'account-project' : 'account-session'
    if (row.guard !== guard) unavailable()
    current()
  }

  class AccountWorkspaceController extends WorkspaceController {
    static override inject = [...WorkspaceController.inject, 'peCloudApi', 'peAccount']
    constructor(owner: Context, config: ConstructorParameters<typeof WorkspaceController>[1]) {
      graph(owner)
      if (workspaceOwner !== undefined) unavailable()
      super(owner, config)
      workspaceOwner = { value: this, fiber: owner.fiber }
      owner.effect(() => () => { input.api.invalidate() })
    }
    private async sessionMetadata<T extends WorkspacePinValue | WorkspaceArchiveValue>(
      endpoint: 'workspace/pinSession' | 'workspace/unpinSession' | 'workspace/archiveSession' | 'workspace/unarchiveSession',
      sessionId: SessionId, operation: () => Promise<T>,
    ): Promise<T> {
      admit(endpoint)
      sessions([sessionId])
      admit(endpoint)
      const value = await operation()
      admit(endpoint)
      sessions([sessionId])
      sessions('pinnedSessionIds' in value ? value.pinnedSessionIds : value.archivedSessionIds)
      bounded(value)
      return value
    }
    override pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
      return this.sessionMetadata('workspace/pinSession', request.sessionId, () => super.pinSession(request))
    }
    override unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
      return this.sessionMetadata('workspace/unpinSession', request.sessionId, () => super.unpinSession(request))
    }
    override archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
      return this.sessionMetadata('workspace/archiveSession', request.sessionId, () => super.archiveSession(request))
    }
    override unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
      return this.sessionMetadata('workspace/unarchiveSession', request.sessionId, () => super.unarchiveSession(request))
    }
    override async create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
      admit('workspace/create')
      const registry = this.ctx.workspaceRegistry
      const workspace = await registry.resolveByPath(request.path)
      if (workspace === undefined || registry.get(workspace.id) !== workspace) {
        throw new CloudApiError('cloud/forbidden', 'Choose an existing approved project or create a Cloud project.')
      }
      input.assertWorkspace(workspace)
      admit('workspace/create')
      const value = await super.create(request)
      admit('workspace/create')
      if (registry.get(workspace.id) !== workspace || value.workspace.workspaceId !== workspace.id) unavailable()
      view(value.workspace)
      bounded(value)
      return value
    }
    override async rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
      admit('workspace/rename')
      const registry = this.ctx.workspaceRegistry
      const id = request.workspaceId
      const workspace = registry.get(id)
      if (workspace === undefined) throw new CloudApiError('cloud/forbidden', 'The account Workspace is unavailable.')
      bounded({ workspaceId: id, title: request.title })
      const check = (): void => {
        admit('workspace/rename')
        if (registry.get(id) !== workspace) unavailable()
        input.assertWorkspace(workspace)
      }
      check()
      if (typeof request.title === 'string') {
        const projected: WorkspaceView = { workspaceId: workspace.id, path: workspace.path, title: request.title.trim(),
          sessionIds: [...workspace.sessionIds], createdAt: workspace.createdAt, updatedAt: workspace.updatedAt }
        view(projected)
        bounded({ workspace: projected })
      }
      // Native reads workspaceId in its own command queue. Retain the accepted
      // original object and refuse a Registry replacement at that queue slot;
      // a previously accepted write is still joined through its actual result.
      const owner = this.ctx
      const guarded: WorkspaceRenameRequest = { title: request.title, get workspaceId() {
        const actual = owner.get('workspaceRegistry')
        if (actual === undefined || original(actual) !== original(registry) || registry.get(id) !== workspace) unavailable()
        return id
      } }
      const value = await super.rename(guarded)
      check()
      if (value.workspace.workspaceId !== id) unavailable()
      view(value.workspace)
      bounded(value)
      return value
    }
    override async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
      const control = AbortSignal.any([signal, input.binding.lifetime])
      signal.throwIfAborted()
      control.throwIfAborted()
      admit('workspace/follow')
      const source = super.follow(control)[Symbol.asyncIterator]()
      try {
        while (true) {
          signal.throwIfAborted()
          admit('workspace/follow')
          const next = await source.next()
          signal.throwIfAborted()
          control.throwIfAborted()
          admit('workspace/follow')
          if (next.done) return
          frame(next.value)
          yield next.value
        }
      } finally { await source.return?.() }
    }
    override async initializeDefault(signal: AbortSignal): Promise<WorkspaceValue | undefined> {
      const control = AbortSignal.any([signal, input.binding.lifetime])
      control.throwIfAborted()
      admit('workspace/initializeDefault')
      const registry = this.ctx.workspaceRegistry
      const workspace = await registry.initializeDefault(() => Promise.reject(new CloudApiError('cloud/account-unavailable', 'Default initialization may only reuse the original Workspace.')))
      control.throwIfAborted()
      admit('workspace/initializeDefault')
      if (workspace === undefined) return undefined
      if (workspace !== approved?.workspace) unavailable()
      const result: WorkspaceValue = { workspace: { workspaceId: workspace.id, path: workspace.path, title: workspace.title,
        sessionIds: [...workspace.sessionIds], createdAt: workspace.createdAt, updatedAt: workspace.updatedAt } }
      frame({ type: 'upsert', workspace: result.workspace })
      return result
    }
  }
  const thisSettings = (): SettingsDescribeValue => {
    const actual = ctx.get('settingsController')
    if (actual === undefined || original(actual) !== settingsOwner?.value) unavailable()
    return actual.describe()
  }
  const withSettingsWrite: NonNullable<SettingsControllerInternals['withWrite']> = (request, apply) => {
    const consumer = input.settingsWrites
    const invocation = request.invocation
    if (consumer === undefined || invocation === undefined) unavailable()
    const ops = request.input, raw = invocation.request
    if (invocation.service !== 'settingsController' || raw.namespace !== 'settings' || raw.method !== 'mutate'
      || Object.keys(raw.args).length !== 3 || Object.keys(raw.args).some(key => !['ns', 'ops', 'expectedRevision'].includes(key))
      || raw.args.ns !== request.namespace || raw.args.expectedRevision !== request.expectedRevision
      || !isDeepStrictEqual(raw.args.ops, ops)) {
      throw new CloudApiError('cloud/forbidden', 'The original settings mutation request is not approved.')
    }
    const fields = consumer.fields.filter(field => field.namespace === request.namespace)
    firstScreenJsonBytes(ops, input.maxFrameBytes)
    if (request.mode !== 'mutate' || !Array.isArray(ops) || ops.length === 0 || ops.length > fields.length
      || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision === undefined || request.expectedRevision < 0) {
      throw new CloudApiError('cloud/forbidden', 'Only an approved versioned native settings mutation is permitted.')
    }
    const selected = new Set<string>()
    const resets: Array<{ field: string; values: readonly (string | number | boolean | null)[] }> = []
    for (const op of ops) {
      const name = op.path.length === 1 ? op.path[0] : undefined
      const field = fields.find(field => field.field === name)
      if (field === undefined || name === undefined || selected.has(name)
        || !['set', 'unset'].includes(op.op)
        || field.values !== undefined && (op.op === 'set' ? !field.values.some(value => Object.is(value, op.value))
          : input.allowAccountSettingsUnset === undefined)) {
        throw new CloudApiError('cloud/forbidden', 'The native settings field or operation is not approved.')
      }
      if (op.op === 'unset' && field.values !== undefined) resets.push({ field: name, values: field.values })
      selected.add(name)
    }
    return consumer.withModelKeyPeerUse(invocation.peer, async (use, peerCurrent) => {
      const check = (): void => {
        peerCurrent(); use.assertCurrent()
        if (use.binding !== input.binding || use.context.root !== ctx.root) unavailable()
        input.api.assertInstalled(use.context)
        input.api.requireRpc('settings/mutate')
        input.assertSettingsFields(request.namespace, [...selected])
        current()
      }
      let accountUpdate: ReturnType<NonNullable<FirstScreenNativeInput['beginAccountSettingsUpdate']>> | undefined
      let modelUpdate: ReturnType<FirstScreenNativeInput['beginModelSettingsUpdate']> | undefined
      let settled: PromiseWithResolvers<void> | undefined
      let confirmedRefusal = false
      try {
        const result = await input.settingsSave.admit('settings', async () => {
          let model: ReturnType<FirstScreenNativeInput['beginModelSettingsUpdate']>
          let transaction: ReturnType<NonNullable<FirstScreenNativeInput['beginAccountSettingsUpdate']>>
          try {
            check()
            projectApprovedSettings(thisSettings(), fields, input.maxCollectionItems, input.maxInventoryEntries)
            for (const reset of resets) if (input.allowAccountSettingsUnset?.(request.namespace, reset.field, reset.values) !== true) {
              throw new CloudApiError('cloud/forbidden', 'The native settings reset is not approved.')
            }
            model = input.beginModelSettingsUpdate(request.namespace, ops)
            transaction = input.beginAccountSettingsUpdate?.(request.namespace, ops, fields)
              ?? { check() {}, approve() {}, finish() {}, publish: (audit) => { audit() }, abort() {}, run: operation => operation() }
          } catch (error) { return { ok: false as const, error } }
          if (pendingSettingsSave !== undefined) unavailable()
          accountUpdate = transaction; modelUpdate = model
          settled = Promise.withResolvers<void>()
          void settled.promise.catch(() => {})
          pendingSettingsSave = settled.promise
          let prepared = false
          let responseKey: object | undefined, approvedResponse: SettingsNamespaceView | undefined
          const auditResponse = (projected: SettingsNamespaceView): void => {
            const matches = thisSettings().namespaces.filter(view => view.ns === request.namespace)
            const actual = matches[0]
            if (matches.length !== 1 || actual === undefined) unavailable()
            const { schema: _responseSchema, ...response } = projected
            const { schema: _currentSchema, ...currentView } = actual
            if (!isDeepStrictEqual(response, currentView)) unavailable()
            bounded(projected)
          }
          input.settingsSave.commitSettingsPolicy(() => {
            if (prepared) {
              if (responseKey === undefined || approvedResponse === undefined) unavailable()
              const key = responseKey, response = approvedResponse
              settingsResponses.set(key, response)
              try { transaction.publish(() => { check(); model.check(); auditResponse(response) }) }
              catch (error) { settingsResponses.delete(key); throw error }
            } else transaction.abort()
            if (pendingSettingsSave === settled?.promise) pendingSettingsSave = undefined
          })
          return transaction.run(async () => {
            let value: Awaited<ReturnType<typeof apply>>
            try {
              value = await apply({ assertCurrent: () => { check(); model.check(); transaction.check() },
                check: (plan) => { check(); model.approve(plan); transaction.approve(plan) } })
            } catch (error) {
              if (error instanceof RemoteError && (error.code === 'settings/conflict' || error.code === 'settings/rejected')) {
                return { ok: false as const, error }
              }
              throw new ConfigSaveOutcomeUnknown({ cause: error })
            }
            try {
              transaction.finish(); check(); model.check(); model.finish(); check()
              // This hook is installed only on SettingsController.mutate; its generic apply returns that native DTO.
              const projected = projectApprovedSettingsNamespace(value as SettingsNamespaceView, fields,
                input.maxCollectionItems, input.maxInventoryEntries)
              if (value === null || typeof value !== 'object') unavailable()
              auditResponse(projected); check()
              responseKey = value; approvedResponse = structuredClone(projected); prepared = true
            } catch (error) { throw new ConfigSaveOutcomeUnknown({ cause: error }) }
            return { ok: true as const, value }
          })
        })
        if (!result.ok) {
          confirmedRefusal = true
          accountUpdate?.abort(); settled?.resolve()
          throw result.error
        }
        if (accountUpdate === undefined || modelUpdate === undefined || settled === undefined) unavailable()
        settled.resolve()
        return result.value
      } catch (error) {
        accountUpdate?.abort(!confirmedRefusal); settled?.reject(error)
        throw error
      } finally {
        if (settled !== undefined && pendingSettingsSave === settled.promise) pendingSettingsSave = undefined
      }
    })
  }
  class AccountSettingsController extends SettingsController {
    static inject = ['typert', 'settings', 'loader', 'peCloudApi', 'peAccount']
    constructor(owner: Context) {
      graph(owner)
      if (settingsOwner !== undefined) unavailable()
      const actualProvider = owner.get('settings')
      if (!(actualProvider instanceof Settings)) unavailable()
      provider = original(actualProvider)
      super(owner, { withWrite: withSettingsWrite })
      settingsOwner = { value: this, fiber: owner.fiber }
      owner.effect(() => () => { input.api.invalidate() })
    }
    override async mutate(ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined): Promise<SettingsNamespaceView> {
      const result = await super.mutate(ns, ops, expectedRevision)
      const response = settingsResponses.get(result)
      if (response === undefined) unavailable()
      settingsResponses.delete(result)
      return response
    }
    override describe(): SettingsDescribeValue {
      admit('settings/describe')
      const result = super.describe()
      if (result.namespaces.length > input.maxCollectionItems) unavailable()
      const fields = input.settingsWrites?.fields ?? [{ namespace: 'locale', field: 'preference' }]
      const projected = projectApprovedSettings(result, fields, input.maxCollectionItems, input.maxInventoryEntries)
      projected.writable = input.settingsWrites !== undefined && result.writable
      bounded(projected)
      admit('settings/describe')
      return projected
    }
  }
  return Object.freeze({
    binding: input.binding, workspaceController: AccountWorkspaceController, settingsController: AccountSettingsController,
    pendingSettingsSave: () => pendingSettingsSave,
    assertCurrent: current,
    assertSessionRead(id: SessionId): void { current(); input.assertSessionRead(id); current() },
    inspect(): ExposureInventory {
      current()
      const rpc: ExposureInventory['rpcEndpoints'][number][] = [], streams: ExposureInventory['streamEndpoints'][number][] = []
      for (const [expected, key, namespace, selected, prototype] of [
        [workspaceOwner, 'workspaceController', 'workspace', ['follow', 'initializeDefault', 'create', 'rename', 'pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession'], AccountWorkspaceController.prototype],
        [settingsOwner, 'settingsController', 'settings', input.settingsWrites === undefined ? ['describe'] : ['describe', 'mutate'], AccountSettingsController.prototype],
        [accessOwner, 'remoteAccess', 'remoteAccess', ['follow'], RemoteAccess.prototype],
      ] as const) {
        if (expected === undefined) unavailable()
        const instance = ctx.get(key)
        if (instance === undefined) unavailable()
        const binding = instance.typertRemote
        if (binding.service !== expected.value || binding.serviceKey !== key || binding.namespace !== namespace) unavailable()
        const markers = remoteMethods(instance)
        if (markers.length > input.maxInventoryEntries) unavailable()
        for (const method of selected) {
          const matches = markers.filter(marker => marker.method === method)
          const marker = matches[0], mode = method === 'follow' ? 'stream' : 'rpc'
          if (matches.length !== 1 || marker === undefined || (marker.exportName ?? method) !== method
            || (marker.mode ?? 'rpc') !== mode || Reflect.get(expected.value, method) !== Reflect.get(prototype, method)) unavailable()
          const row = { endpoint: `${namespace}/${method}`, handlerId: `native:${key}`,
            guard: key === 'workspaceController'
              ? ['pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession'].includes(method)
                ? 'account-session' as const : 'account-project' as const
              : 'authenticated-account' as const }
          if (mode === 'stream') streams.push(row)
          else rpc.push(row)
        }
      }
      return Object.freeze({ recipeVersion: input.binding.recipeVersion, rpcEndpoints: Object.freeze(rpc),
        streamEndpoints: Object.freeze(streams), exactFetchRoutes: Object.freeze([]) })
    },
  })
}
