/** Fixed native first-screen readers; original registries, DTOs and iteration remain authoritative. */
import { FiberState, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import type { WorkspaceFollowFrame, WorkspaceValue, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types'
import SettingsController from '@deepseek-ai/dsh-api-settings-controller'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceRegistry, { type Workspace } from '@deepseek-ai/dsh-workspace'
import Settings from '@deepseek-ai/dsh-settings'
import type { SettingsDescribeValue } from '@deepseek-ai/dsh-settings/types'
import * as Locale from '@deepseek-ai/dsh-client-locale'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CloudAccountApi } from './account-service.ts'
import { CloudApiError } from './errors.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import type { ExposureInventory } from './types.ts'

/** Original service and its actual registration fiber, not a readiness or authorization certificate. */
export interface FirstScreenNativeOwner { readonly value: object; readonly fiber: Fiber }

/** Trusted graph inputs; the project callback reads the original installed files owner. */
export interface FirstScreenNativeInput {
  readonly api: CloudAccountApi
  readonly binding: AccountBinding
  readonly project: () => { readonly binding: AccountBinding; readonly workspace: Workspace }
  /** Check actual native Session metadata for readonly publication; never issue a ProjectScope from an id or cwd. */
  readonly assertSessionRead: (id: SessionId) => void
  readonly maxInventoryEntries: number
  readonly maxCollectionItems: number
  readonly maxFrameBytes: number
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
 * @param key - one reviewed first-screen service key.
 * @param value - actual class instance already checked by its consumer.
 * @param maximum - required positive visit bound, with no production default.
 * @returns the sole original service registration and fiber.
 * @throws CloudApiError on a foreign, replaced, duplicate, inactive or over-budget registration.
 */
export function firstScreenNativeOwner(
  ctx: Context,
  key: 'workspaceRegistry' | 'settings' | 'remoteAccess' | 'typertGateway' | 'workspaceController' | 'settingsController',
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
  const sessions = (ids: readonly SessionId[]): void => {
    if (ids.length > input.maxCollectionItems || approved === undefined) unavailable()
    for (const id of ids) {
      if (!approved.workspace.sessionIds.includes(id)) unavailable()
      input.assertSessionRead(id)
    }
  }
  const view = (value: WorkspaceView): void => {
    if (approved === undefined || value.workspaceId !== approved.workspace.id || value.path !== approved.workspace.path) unavailable()
    sessions(value.sessionIds)
  }
  const frame = (value: WorkspaceFollowFrame): void => {
    switch (value.type) {
      case 'baseline': case 'replace':
        if (value.value.items.length !== 1 || value.value.items[0] === undefined) unavailable()
        view(value.value.items[0])
        sessions(value.value.archivedSessionIds)
        sessions(value.value.pinnedSessionIds)
        break
      case 'upsert': view(value.workspace); break
      case 'remove': if (value.workspaceId !== approved?.workspace.id) unavailable(); break
      case 'order': if (value.workspaceIds.length !== 1 || value.workspaceIds[0] !== approved?.workspace.id) unavailable(); break
      case 'archived': sessions(value.archivedSessionIds); break
      case 'pinned': sessions(value.pinnedSessionIds); break
    }
    bounded(value)
  }
  const admit = (endpoint: 'workspace/follow' | 'workspace/initializeDefault' | 'settings/describe'): void => {
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
  class AccountSettingsController extends SettingsController {
    static inject = ['typert', 'settings', 'loader', 'peCloudApi', 'peAccount']
    constructor(owner: Context) {
      graph(owner)
      if (settingsOwner !== undefined) unavailable()
      const actualProvider = owner.get('settings')
      if (!(actualProvider instanceof Settings)) unavailable()
      provider = original(actualProvider)
      super(owner)
      settingsOwner = { value: this, fiber: owner.fiber }
      owner.effect(() => () => { input.api.invalidate() })
    }
    override describe(): SettingsDescribeValue {
      admit('settings/describe')
      const result = super.describe()
      if (result.namespaces.length > input.maxCollectionItems) unavailable()
      const rows = result.namespaces.filter(row => row.ns === 'locale')
      const locale = rows[0]
      if (rows.length !== 1 || locale === undefined) unavailable()
      for (const value of [locale.value, locale.base, locale.user]) preference(value)
      // These flags describe this Cloud face's unavailable write/document operations, not physical disk absence.
      const projected: SettingsDescribeValue = { writable: false, hasDocument: false, namespaces: rows }
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
        [workspaceOwner, 'workspaceController', 'workspace', ['follow', 'initializeDefault'], AccountWorkspaceController.prototype],
        [settingsOwner, 'settingsController', 'settings', ['describe'], AccountSettingsController.prototype],
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

function preference(value: JsonValue | undefined): void {
  if (value === undefined) return
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'preference') || (value.preference !== undefined && typeof value.preference !== 'string')) unavailable()
}
