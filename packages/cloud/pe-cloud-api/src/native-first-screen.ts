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
  WorkspaceCreateRequest, WorkspaceCreateValue, WorkspaceFollowFrame, WorkspaceValue, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/types'
import SettingsController, { type SettingsControllerInternals } from '@deepseek-ai/dsh-api-settings-controller'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceRegistry, { type Workspace } from '@deepseek-ai/dsh-workspace'
import Settings from '@deepseek-ai/dsh-settings'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import * as Locale from '@deepseek-ai/dsh-client-locale'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CloudAccountApi } from './account-service.ts'
import { CloudApiError } from './errors.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import type { ExposureInventory } from './types.ts'
import type { ModelKeyPeerConsumer } from './cloud-model-key.ts'

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
    | 'permissionPresets' | 'userQuestions' | 'loader' | 'agentPresets',
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
  for (const value of [input.maxInventoryEntries, input.maxCollectionItems, input.maxFrameBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) unavailable()
  }
  const api = original(input.api)
  const follow: unknown = Reflect.get(WorkspaceController.prototype, 'follow')
  const describe: unknown = Reflect.get(SettingsController.prototype, 'describe')
  const remoteFollow: unknown = Reflect.get(RemoteAccess.prototype, 'follow')
  let workspaceOwner: FirstScreenNativeOwner | undefined, settingsOwner: FirstScreenNativeOwner | undefined
  let registryOwner: FirstScreenNativeOwner | undefined, providerOwner: FirstScreenNativeOwner | undefined
  let provider: object | undefined
  let accessOwner: FirstScreenNativeOwner | undefined, localeFiber: Fiber | undefined
  let approved: ReturnType<FirstScreenNativeInput['project']> | undefined

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
      || WorkspaceController.prototype.follow !== follow || SettingsController.prototype.describe !== describe
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
  const admit = (endpoint: 'workspace/follow' | 'workspace/initializeDefault' | 'workspace/create' | 'settings/describe'): void => {
    current()
    const row = endpoint === 'workspace/follow' ? input.api.requireStream(endpoint) : input.api.requireRpc(endpoint)
    if (row.guard !== (endpoint === 'settings/describe' ? 'authenticated-account' : 'account-project')) unavailable()
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
    if (request.mode !== 'mutate' || !Array.isArray(ops) || ops.length === 0 || ops.length > fields.length
      || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision === undefined || request.expectedRevision < 0) {
      throw new CloudApiError('cloud/forbidden', 'Only an approved versioned native settings mutation is permitted.')
    }
    const selected = new Set<string>()
    for (const op of ops) {
      const name = op.path.length === 1 ? op.path[0] : undefined
      const field = fields.find(field => field.field === name)
      if (field === undefined || name === undefined || selected.has(name)
        || !['set', 'unset'].includes(op.op)
        || field.values !== undefined && (op.op !== 'set' || !field.values.some(value => Object.is(value, op.value)))) {
        throw new CloudApiError('cloud/forbidden', 'The native settings field or operation is not approved.')
      }
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
      check()
      // A native description proves that approved paths still resolve to supported schema leaves.
      projectApprovedSettings(thisSettings(), fields, input.maxCollectionItems)
      const value = await apply({ assertCurrent: check })
      check()
      return value
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
      current()
      const fields = input.settingsWrites?.fields.filter(field => field.namespace === ns) ?? []
      const projected = projectApprovedSettingsNamespace(result, fields, input.maxCollectionItems)
      bounded(projected)
      current()
      return projected
    }
    override describe(): SettingsDescribeValue {
      admit('settings/describe')
      const result = super.describe()
      if (result.namespaces.length > input.maxCollectionItems) unavailable()
      const fields = input.settingsWrites?.fields ?? [{ namespace: 'locale', field: 'preference' }]
      const projected = projectApprovedSettings(result, fields, input.maxCollectionItems)
      projected.writable = input.settingsWrites !== undefined && result.writable
      bounded(projected)
      admit('settings/describe')
      return projected
    }
  }
  return Object.freeze({
    binding: input.binding, workspaceController: AccountWorkspaceController, settingsController: AccountSettingsController,
    assertCurrent: current,
    assertSessionRead(id: SessionId): void { current(); input.assertSessionRead(id); current() },
    inspect(): ExposureInventory {
      current()
      const rpc: ExposureInventory['rpcEndpoints'][number][] = [], streams: ExposureInventory['streamEndpoints'][number][] = []
      for (const [expected, key, namespace, selected, prototype] of [
        [workspaceOwner, 'workspaceController', 'workspace', ['follow', 'initializeDefault', 'create'], AccountWorkspaceController.prototype],
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
            guard: key === 'workspaceController' ? 'account-project' as const : 'authenticated-account' as const }
          if (mode === 'stream') streams.push(row)
          else rpc.push(row)
        }
      }
      return Object.freeze({ recipeVersion: input.binding.recipeVersion, rpcEndpoints: Object.freeze(rpc),
        streamEndpoints: Object.freeze(streams), exactFetchRoutes: Object.freeze([]) })
    },
  })
}
