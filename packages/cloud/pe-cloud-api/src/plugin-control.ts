/** Catalog-approved plugin selection/configuration through original native writers and the original account save owner. */
import { ordinaryConfigPolicy } from './ordinary-config-policy.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import { applyConfigPathOp, redactSecrets, type ConfigSchemaNode } from '@deepseek-ai/dsh-settings'
import type { PluginInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import { createConfigProjector, prepareProfileSelectionUpdate, readProfilePatches, isNativeConfigSchema, LOADER_EXPRESSION_SCHEMA, PluginPackages, type ProfileConfigUpdatePlan } from '@deepseek-ai/dsh-app-boot'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { AccountBinding, ConfigurationRebuildReceipt, OperationId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ModelKeyPeerConsumer } from './cloud-model-key.ts'
import type { ConfigSaveBarrier, PluginEditCommit, PluginEditVersion } from './save-hooks.ts'
import { ConfigSaveOutcomeUnknown } from './config-saves.ts'
import { CloudApiError } from './errors.ts'
import { pluginControlLimits, pluginLiteralValue, pluginRequests } from './plugin-json.ts'
import { isDeepStrictEqual } from 'node:util'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import type { ApprovedConfigurationBundle, ApprovedConfigurationCatalog, ApprovedConfigurationPlugin, ApprovedPluginControl } from './types.ts'
import type { ConfigurationPeerConsumer, PluginControlLimits, PluginCurrentState, PluginFactoryControl,
  PluginOperation, PluginPeerHandoff, PluginRebuildIntent, PluginRebuildPersistence, PluginRebuildVerification } from './plugin-types.ts'

/** Trusted original Root callbacks; none can be populated through Loader JSON or a public request. */
export interface CloudPluginPreparation extends ModelKeyPeerConsumer, ConfigurationPeerConsumer, PluginFactoryControl {
  readonly limits: PluginControlLimits
  readonly catalog: Readonly<ApprovedConfigurationCatalog>
  readonly maxNativeInventoryEntries: number
  readonly requiredEntryIds: readonly string[]
  readonly resolvePackages: () => PluginPackages | undefined
  /** Schedule the original complete terminal drain and a new original claim; acceptance never certifies application.
   * @param binding Original verified generation.
 * @param handoff Original request and Peer joins.
   * @param prepare Final old-owner CAS after original save admission pauses.
   * @returns Actual factory operation id, with Root-owned reporting on failure.
   */
  scheduleRebuild(binding: AccountBinding, handoff: PluginPeerHandoff,
    prepare: (ctx: Context, assertCurrent: () => void) => Promise<
      Readonly<{ accepted: true; intent: PluginRebuildIntent }> | Readonly<{ accepted: false; error: Error }>>):
  Readonly<{
    operationId: OperationId
    completion: Promise<ConfigurationRebuildReceipt<PluginRebuildPersistence, PluginRebuildVerification>>
  }>
}
type ControlledPlugin = ApprovedConfigurationPlugin & { readonly control: ApprovedPluginControl }
type ControlledTarget = ControlledPlugin | ApprovedConfigurationBundle
interface UpdateScope {
  readonly approved: ControlledTarget
  readonly terminal?: boolean
  readonly operation: PluginOperation
  readonly revision: string
  readonly check: () => void
}
function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && (typeof target === 'object' || typeof target === 'function') ? target : value
}
function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'The original approved plugin control is unavailable.') }
function conflict(): never { throw new CloudApiError('cloud/config-conflict', 'The approved plugin changed; read its current state.') }

/** One native-writer adapter; all ordering, versions and failure retention remain with the original ConfigSaveBarrier. */
export class AccountPluginControl {
  /** Original manager subclass installs its only save/selection guard before its constructor returns. */
  readonly provider: typeof PluginManager
  /** Original bounded carrier parsing plus catalog authorization before any Peer handoff or idle admission. */
  readonly requests: ReturnType<typeof pluginRequests>
  private readonly scopes = new AsyncLocalStorage<UpdateScope>()
  private readonly limits: Readonly<PluginControlLimits>
  private manager: PluginManager | undefined
  private managerFiber: Context['fiber'] | undefined

  constructor(private readonly owner: Context, private readonly saves: ConfigSaveBarrier,
    readonly input: CloudPluginPreparation, private readonly installed: () => void) {
    this.limits = pluginControlLimits(input.limits)
    const requests = pluginRequests(input.limits)
    this.requests = {
      current: (value) => { const request = requests.current(value); this.catalogItem(request.id); return request },
      change: (value) => {
        const request = requests.change(value)
        this.authorize(this.approved(request.id), request.operation)
        return request
      },
    }
    if (!Number.isSafeInteger(input.maxNativeInventoryEntries) || input.maxNativeInventoryEntries < 1
      || input.catalog.pluginControl === undefined
      || input.catalog.plugins.length + (input.catalog.bundles?.length ?? 0) > input.catalog.maxEntries) unavailable()
    this.provider = ((control: AccountPluginControl) => class AccountPluginManager extends PluginManager {
      constructor(ctx: Context, config: ConstructorParameters<typeof PluginManager>[1]) {
        control.installed()
        if (control.manager !== undefined || ctx.root !== owner.root) unavailable()
        super(ctx, config)
        control.manager = this; control.managerFiber = ctx.fiber
        this.registerSaveHook({ submit(operation, submit) {
          const scope = control.scopes.getStore()
          if (scope === undefined || operation.stage !== 'enable'
            || (scope.operation.kind === 'enabled' ? operation.reason !== 'plugin'
              : scope.operation.kind !== 'selected' || operation.reason !== 'bundle')) {
            throw new CloudApiError('cloud/forbidden', 'This selection operation is not approved for the current plugin.')
          }
          scope.check()
          return saves.admit('plugin-selection', async () => {
            scope.check()
            const result = await submit()
            if (result.application === 'failed') {
              if (control.manager?.changeFailureOutcome(result) !== 'not-published') throw new ConfigSaveOutcomeUnknown()
            } else if (result.application !== 'applied'
              && !(result.application === 'restart-required' && result.restartReason === 'no-hmr')) {
              throw new ConfigSaveOutcomeUnknown()
            }
            return result
          })
        } })
        this.registerSelectionGuard({ maxRegistryEntries: input.maxNativeInventoryEntries,
          application() { return control.checkedScope().terminal ? 'restart' : 'reconcile' },
          assertCurrent() { control.checkedScope() },
          async check(plan, target, enabled) {
            const scope = control.checkedScope(), policy = scope.approved.control
            if ('members' in scope.approved) {
              if (!scope.terminal || scope.operation.kind !== 'selected' || target.kind !== 'bundle'
                || target.name !== scope.approved.packageName || enabled !== scope.operation.selected) unavailable()
              await control.bundleMetadata(scope.approved, scope.check)
              control.checkPlan(plan, scope.approved)
              return
            }
            if (scope.operation.kind === 'enabled'
              ? target.kind !== 'entry' || target.id !== scope.approved.entryId || enabled !== scope.operation.enabled
              : scope.operation.kind !== 'selected' || target.kind !== 'bundle'
                || policy.selectionTarget.kind !== 'bundle' || target.name !== policy.selectionTarget.name
                || enabled !== scope.operation.selected) unavailable()
            control.checkPlan(plan, scope.approved)
          },
        })
      }
    })(this)
  }

  /** Check actual Loader/module/package ownership before bootstrap publication.
   * @returns Original importer settlement; a disabled optional entry is not activated by this audit.
   */
  async restore(): Promise<void> {
    for (const bundle of this.input.catalog.bundles ?? []) await this.observe(this.approved(bundle.id), () => { this.assertCurrent() })
    for (const approved of this.input.catalog.plugins) if (approved.control !== undefined) {
      await this.observe(this.approved(approved.id), () => { this.assertCurrent() })
    }
  }

  /** Read native inventory and issue a version from the original serial save owner.
   * @param id Approved catalog identity.
   * @param check Original installed Peer/Use check.
 * @returns Original PluginInfo and opaque version.
   */
  async current(id: string, check: () => void): Promise<PluginCurrentState> {
    const approved = this.catalogItem(id)
    const result = await this.saves.describePluginEdit(() => 'members' in approved ? this.observeBundle(approved, check)
      : approved.control === undefined ? this.observeReadOnly(approved, check) : this.observe(this.approved(id), check), check)
    return { ...result.value, version: result.version }
  }

  /** Apply under the factory's actual same-epoch window; no failure before publication becomes a retained save failure.
   * @param id Approved catalog identity.
   * @param version Original read version.
 * @param operation Approved generic operation.
 * @param check Actual window/login check.
   * @returns Native applied value or original zero-write refusal; the factory owns the final re-audit.
   */
  change(id: string, version: PluginEditVersion, operation: PluginOperation, check: () => void): Promise<PluginEditCommit<{
    readonly value: PluginCurrentState
    readonly native?: ChangeResult
  }>> {
    const approved = this.approved(id)
    this.authorize(approved, operation)
    return this.saves.commitPluginEdit(version, () => this.revision(), async () => {
      const result = await this.publish(approved, operation, this.revision(), check)
      if (!result.published) return result
      return { published: true, revision: result.revision, value: result.value }
    }, check).then(result => result.published ? { published: true, revision: result.revision,
      value: { value: { ...result.value.value.state, version: result.value.version },
        ...result.value.value.native === undefined ? {} : { native: result.value.value.native } } } : result)
  }

  /** Recheck an existing edit without advancing it, before terminal work is admitted or the old graph stops.
   * @param id Approved catalog identity.
   * @param version Original opaque version.
 * @param operation Approved detached operation.
 * @param check Original ready/window check.
   * @returns Immutable intent containing only the private original disk revision and approved operation.
   */
  async prepareRebuild(id: string, version: PluginEditVersion, operation: PluginOperation, check: () => void): Promise<
    Readonly<{ accepted: true; intent: PluginRebuildIntent }> | Readonly<{ accepted: false; error: CloudApiError }>> {
    const approved = this.approved(id)
    this.authorize(approved, operation)
    const checked = await this.saves.checkPluginEdit(version, () => this.revision(), check)
    if (!checked.accepted) return checked
    const observed = await this.observe(approved, check)
    if ('members' in approved) {
      if (operation.kind !== 'selected' || this.manager === undefined) unavailable()
      const revision = this.revision()
      const plan = await this.manager.previewBundleSelection(approved.packageName, operation.selected, this.input.maxNativeInventoryEntries, 'restart')
      check(); this.assertCurrent()
      if (this.revision() !== revision) conflict()
      this.checkBundlePlan(plan, approved)
    }
    if (operation.kind === 'configure' && !observed.value.configuration.fields.some(field =>
      isDeepStrictEqual(field.path, operation.path) && field.writable)) {
      return { accepted: false, error: new CloudApiError('cloud/forbidden', 'This field requires a native path edit or live Settings.') }
    }
    check(); this.assertCurrent()
    return { accepted: true, intent: Object.freeze({ id: approved.id, revision: this.revision(), operation }) }
  }

  /** Apply an already checked intent through the original native writers in the factory-owned paused turn.
   * @param intent Old native save owner's checked intent.
 * @param check Original factory's quiescent old-owner check.
   * @returns Actual native writer/application; publication uncertainty retains that old save owner.
   */
  async applyRebuild(intent: PluginRebuildIntent, check: () => void): Promise<PluginRebuildPersistence> {
    check(); this.assertCurrent()
    if (this.revision() !== intent.revision) conflict()
    const approved = this.approved(intent.id)
    if ('members' in approved) {
      if (intent.operation.kind !== 'selected' || this.saves.snapshot().admission !== 'stopped') unavailable()
      const manager = this.manager
      if (manager === undefined) unavailable()
      const native = await this.scopes.run({ approved, operation: intent.operation, revision: intent.revision, check, terminal: true },
        () => manager.setBundleEnabled(approved.packageName, intent.operation.kind === 'selected' && intent.operation.selected))
      check(); this.assertCurrent()
      if (native.application === 'failed' && manager.changeFailureOutcome(native) === 'not-published') {
        throw new CloudApiError('cloud/config-conflict', 'The original bundle writer refused the terminal commit before publication.')
      }
      if (native.application !== 'restart-required' || native.restartReason !== 'no-hmr') throw new ConfigSaveOutcomeUnknown({ cause: native })
      return { epoch: this.saves.binding.epoch, id: approved.id, revision: this.revision(), operation: intent.operation, native }
    }
    const result = await this.publish(approved, intent.operation, intent.revision, check)
    if (!result.published) throw result.error
    return { epoch: this.saves.binding.epoch, id: approved.id, revision: result.revision, operation: intent.operation,
      ...result.value.native === undefined ? {} : { native: result.value.native } }
  }

  /** Verify the original intent against a freshly assembled graph, before public ready.
   * @param intent Original checked operation, not a replacement-graph edit request.
   * @param persisted Original native result and disk revision.
   * @param check Original new-generation unpublished/Factory check.
   * @returns Actual new graph state; native restart-required remains in the separate persistence result.
   */
  async verifyRebuild(
    intent: PluginRebuildIntent, persisted: PluginRebuildPersistence, check: () => void,
  ): Promise<PluginRebuildVerification> {
    if (persisted.epoch === this.saves.binding.epoch || persisted.id !== intent.id
      || !isDeepStrictEqual(persisted.operation, intent.operation)
      || this.revision() !== persisted.revision) conflict()
    const state = await this.current(intent.id, check)
    if (intent.operation.kind === 'selected' ? state.bundle?.enabled !== intent.operation.selected
      : intent.operation.kind === 'enabled' ? state.plugin?.enabled !== intent.operation.enabled
        : !state.configuration.fields.some(field => isDeepStrictEqual(field.path, intent.operation.kind === 'configure' ? intent.operation.path : [])
          && isDeepStrictEqual(field.value, intent.operation.kind === 'configure' ? intent.operation.value : undefined))) unavailable()
    check(); this.assertCurrent()
    return { persisted, value: state }
  }

  /** Require the original graph, original manager constructor/fiber and original editor. */
  assertCurrent(): void {
    this.installed(); this.owner.fiber.assertActive()
    const manager = this.owner.get('pluginManager'), editor = this.owner.get('configEditor')
    if (this.owner.get('hmr') !== undefined || this.manager === undefined || manager === undefined || original(manager) !== original(this.manager)
      || this.managerFiber?.state !== FiberState.ACTIVE || this.managerFiber.runtime?.callback !== this.provider
      || editor === undefined || this.owner.get('peAccount') !== this.saves.binding) unavailable()
  }

  private checkedScope(): UpdateScope {
    const scope = this.scopes.getStore()
    if (scope === undefined) unavailable()
    scope.check(); this.installed()
    if (this.revision() !== scope.revision) conflict()
    return scope
  }

  private catalogItem(id: string): ApprovedConfigurationPlugin | ApprovedConfigurationBundle {
    const matches = [...this.input.catalog.plugins, ...this.input.catalog.bundles ?? []].filter(item => item.id === id)
    const item = matches[0]
    if (matches.length !== 1 || item === undefined) throw new CloudApiError('cloud/forbidden', 'This plugin is not in the approved catalog.')
    return item
  }

  private approved(id: string): ControlledTarget {
    const approved = this.catalogItem(id)
    if (approved.control === undefined) throw new CloudApiError('cloud/forbidden', 'This plugin has no approved controls.')
    return approved as ControlledTarget
  }

  private authorize(approved: ControlledTarget, operation: PluginOperation): void {
    if ('members' in approved) {
      if (operation.kind !== 'selected' || !approved.control.operations.includes('selected')) {
        throw new CloudApiError('cloud/forbidden', 'This bundle operation is not approved.')
      }
      return
    }
    if ((operation.kind === 'enabled' && !operation.enabled || operation.kind === 'selected' && !operation.selected)
        && (this.input.requiredEntryIds.includes(approved.entryId)
          || this.input.requiredEntryIds.includes(approved.entryId.replace(/^include:/, '')))
      || !approved.control.operations.includes(operation.kind)
      || operation.kind === 'selected' && approved.control.selectionTarget.kind !== 'bundle'
      || operation.kind === 'configure' && !approved.control.fields.some(path => isDeepStrictEqual(path, operation.path))) {
      throw new CloudApiError('cloud/forbidden', 'This plugin operation or ordinary field is not approved.')
    }
  }

  private checkPlan(plan: ProfileConfigUpdatePlan, approved: ControlledTarget): void {
    if ('members' in approved) {
      if (!this.checkedScope().terminal || this.saves.snapshot().admission !== 'stopped') unavailable()
      this.checkBundlePlan(plan, approved)
      return
    }
    const entry = this.entry(approved)
    if (plan.impact === 'unknown' || plan.impact === 'remount' && approved.control.maxImpact === 'live'
      || plan.entries.some(row => row.impact !== 'none' && row.entry !== entry
        || row.stopped?.some(fiber => fiber !== entry.fiber
          || this.input.requiredEntryIds.includes(row.entry.id)
          || this.input.requiredEntryIds.includes(row.entry.options.id)))) unavailable()
  }

  private catalogEntry(approved: ApprovedConfigurationPlugin): Entry {
    const loader = this.owner.get('loader')
    if (loader === undefined) unavailable()
    let selected: Entry | undefined, count = 0
    for (const entry of loader.entries()) {
      if (++count > this.input.maxNativeInventoryEntries) unavailable()
      if (entry.id !== approved.entryId) continue
      if (selected !== undefined) unavailable()
      selected = entry
    }
    if (selected === undefined || selected.options.name !== approved.moduleName) unavailable()
    return selected
  }

  private entry(approved: ControlledTarget): Entry {
    if ('members' in approved) unavailable()
    const selected = this.catalogEntry(approved)
    if (selected.options.group || selected.subtree !== undefined || selected.options.inject !== undefined
      || selected.parent.tree.ctx.fiber.entry?.id !== 'include'
      || (selected.options.disabled !== undefined && typeof selected.options.disabled !== 'boolean')
      || selected.disabled !== (selected.options.disabled === true)) unavailable()
    return selected
  }

  private revision(): string {
    const editor = this.owner.get('configEditor'), profile = this.owner.get('profileContext')
    if (editor === undefined || profile === undefined) unavailable()
    const hash = createHash('sha256')
    let remaining = this.limits.maxProfileBytes
    for (const path of [editor.documentPath, `${profile.dir}/package.json`]) {
      let fd: number
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
      catch (error) {
        if (error !== null && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') {
          hash.update('absent\0'); continue
        }
        throw error
      }
      try {
        const before = fstatSync(fd)
        if (!before.isFile() || before.size > remaining) unavailable()
        remaining -= before.size
        const bytes = Buffer.alloc(before.size + 1)
        let length = 0
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, null)
          if (count === 0) break
          length += count
        }
        const after = fstatSync(fd), current = lstatSync(path)
        if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino) conflict()
        hash.update(String(length)).update('\0').update(bytes.subarray(0, length))
      } finally { closeSync(fd) }
    }
    return hash.digest('hex')
  }

  private async observeReadOnly(approved: ApprovedConfigurationPlugin, check: () => void): Promise<{
    readonly value: Omit<PluginCurrentState, 'version'>
    readonly revision: string
  }> {
    check(); this.assertCurrent()
    const entry = this.catalogEntry(approved), packages = this.input.resolvePackages(), baseUrl = entry.parent.tree.ctx.baseUrl
    if (!(packages instanceof PluginPackages) || baseUrl === undefined || this.manager === undefined) unavailable()
    const resolution = packages.resolution, metadata = packages.packageOf(entry.options.name, baseUrl)
    if (metadata?.name !== approved.packageName || metadata.version !== approved.packageVersion) unavailable()
    const rows = await this.manager.listPlugins()
    check(); this.assertCurrent()
    if (this.catalogEntry(approved) !== entry || original(this.input.resolvePackages() ?? {}) !== original(packages)
      || packages.resolution !== resolution || packages.packageOf(entry.options.name, baseUrl) !== metadata) unavailable()
    const matches = rows.filter(row => row.entryId === entry.id), plugin = matches[0]
    if (matches.length !== 1 || plugin === undefined || plugin.moduleName !== approved.moduleName
      || plugin.enabled !== !entry.disabled) unavailable()
    const value: Omit<PluginCurrentState, 'version'> = { id: approved.id, plugin,
      selectionTarget: { kind: 'entry', id: approved.entryId }, operations: [], configuration: { fields: [] } }
    firstScreenJsonBytes(value, this.limits.maxReplyBytes)
    return { value, revision: this.revision() }
  }

  private async observe(approved: ControlledTarget, check: () => void): Promise<{
    readonly value: Omit<PluginCurrentState, 'version'>
    readonly revision: string
    readonly schema?: ConfigSchemaNode
  }> {
    check(); this.assertCurrent()
    if ('members' in approved) return this.observeBundle(approved, check)
    const entry = this.entry(approved), packages = this.input.resolvePackages(), baseUrl = entry.parent.tree.ctx.baseUrl
    if (!(packages instanceof PluginPackages) || baseUrl === undefined || this.manager === undefined) unavailable()
    const resolution = packages.resolution, metadata = packages.packageOf(entry.options.name, baseUrl)
    if (metadata?.name !== approved.packageName || metadata.version !== approved.packageVersion) unavailable()
    const checkEntry = (): void => {
      check(); this.assertCurrent()
      if (this.entry(approved) !== entry || original(this.input.resolvePackages() ?? {}) !== original(packages)
        || packages.resolution !== resolution || packages.packageOf(entry.options.name, baseUrl) !== metadata) unavailable()
    }
    const namespace: unknown = await entry.parent.tree.import(entry.options.name)
    checkEntry()
    if (entry.moduleNamespace !== undefined && namespace !== entry.moduleNamespace) unavailable()
    if (entry.disabled ? entry.fiber !== undefined && entry.fiber.state !== FiberState.DISPOSED
      : entry.fiber?.state !== FiberState.ACTIVE || entry.fiber.ctx.root !== this.owner.root) unavailable()
    const rows = await this.manager.listPlugins()
    checkEntry()
    const found: PluginInfo[] = rows.filter(row => row.entryId === entry.id), plugin = found[0]
    if (found.length !== 1 || plugin === undefined || plugin.moduleName !== approved.moduleName
      || plugin.readOnlyReason !== undefined || plugin.meta?.error !== undefined || plugin.enabled !== !entry.disabled) unavailable()
    const fields: PluginCurrentState['configuration']['fields'][number][] = []
    let nativeSchema: ConfigSchemaNode | undefined
    if (approved.control.fields.length > 0) {
      const callback: unknown = this.owner.loader.unwrapExports(namespace)
      const schema: unknown = callback !== null && (typeof callback === 'object' || typeof callback === 'function')
        ? Reflect.get(callback, 'Config') : undefined
      if (!isNativeConfigSchema(schema)) unavailable()
      nativeSchema = schema
      const project = await createConfigProjector()
      checkEntry()
      for (const path of approved.control.fields) {
        let leaf = schema, value: unknown = entry.options.config
        for (const segment of path) {
          if (leaf.type !== 'object' || leaf.dict?.[segment] === undefined) unavailable()
          leaf = leaf.dict[segment]
          value = value !== null && typeof value === 'object' && Object.hasOwn(value, segment) ? Reflect.get(value, segment) : undefined
        }
        const policy = ordinaryConfigPolicy(schema, path)
        // A protected container is incomplete on the wire; do not advertise its native defaults or whole-leaf replacement.
        const projection = policy.writable ? project(leaf, 'approvedField') : undefined
        const json: unknown = projection === undefined ? {} : snapshotJsonValue({ ...projection.schema,
          $defs: { ...projection.definitions, loaderExpression: LOADER_EXPRESSION_SCHEMA } })
        const secrets = policy.secret ? [{ path: [], set: value !== undefined }]
          : policy.readOnlyReason === 'unproven' || policy.volatile ? [] : redactSecrets(leaf, value).secrets
        const detached: unknown = policy.writable && value !== undefined ? pluginLiteralValue(value) : undefined
        if (json === undefined) unavailable()
        fields.push({ path, schema: json as JsonValue, acceptsMissing: projection?.acceptsMissing ?? 'unknown',
          limitations: projection?.limitations ?? [], writable: policy.writable,
          ...policy.readOnlyReason === undefined ? {} : { readOnlyReason: policy.readOnlyReason }, secrets,
          ...detached === undefined ? {} : { value: detached as JsonValue } })
      }
    }
    checkEntry()
    const value = { id: approved.id, plugin, selectionTarget: approved.control.selectionTarget,
      operations: approved.control.operations, maxImpact: approved.control.maxImpact, configuration: { fields } }
    firstScreenJsonBytes(value, this.limits.maxReplyBytes)
    return { value, revision: this.revision(), ...nativeSchema === undefined ? {} : { schema: nativeSchema } }
  }

  private checkBundlePlan(plan: ProfileConfigUpdatePlan, approved: ApprovedConfigurationBundle): void {
    const restart = plan.restart, packages = this.input.resolvePackages()
    if (restart === undefined || plan.impact !== 'graph' || approved.control.maxImpact !== 'graph'
      || !(packages instanceof PluginPackages)) unavailable()
    firstScreenJsonBytes(restart, this.limits.maxProfileBytes)
    const id = (row: { id: string }): string => restart.entryPrefix + row.id
    const before = new Map(restart.before.map(row => [id(row), row]))
    const after = new Map(restart.after.map(row => [id(row), row]))
    const active = new Map(restart.active.map(row => [id(row), row]))
    for (const required of this.input.requiredEntryIds) {
      if (required === restart.entryPrefix.slice(0, -1)) continue // Native carrier identity is checked by assertProfileConfigUpdate.
      const key = before.has(required) ? required : restart.entryPrefix + required
      const previous = active.get(key), next = after.get(key)
      if (previous === undefined || next === undefined || !isDeepStrictEqual(previous, next)) unavailable()
    }
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(key), next = after.get(key)
      if (isDeepStrictEqual(previous, next)) continue
      const member = approved.members.find(member => member.entryId === key)
      if (member === undefined) unavailable()
      for (const row of [previous, next]) if (row !== undefined) {
        if (snapshotJsonValue(row) === undefined) unavailable()
        const metadata = packages.packageOf(row.name, restart.baseUrl, { fresh: true })
        if (row.name !== member.moduleName || row.group || metadata?.name !== member.packageName
          || metadata.version !== member.packageVersion) unavailable()
      }
    }
  }

  private async bundleMetadata(approved: ApprovedConfigurationBundle, check: () => void) {
    if (this.manager === undefined) unavailable()
    const rows = await this.manager.listBundles()
    check(); this.assertCurrent()
    const found = rows.filter(row => row.name === approved.packageName), bundle = found[0]
    if (found.length !== 1 || bundle === undefined || bundle.version !== approved.packageVersion
      || bundle.availability === 'missing' || bundle.error !== undefined || bundle.readOnlyReason !== undefined) unavailable()
    return bundle
  }

  private async observeBundle(approved: ApprovedConfigurationBundle, check: () => void): Promise<{
    readonly value: Omit<PluginCurrentState, 'version'>
    readonly revision: string
  }> {
    const manager = this.manager, packages = this.input.resolvePackages()
    if (manager === undefined || !(packages instanceof PluginPackages)) unavailable()
    const resolution = packages.resolution
    const bundle = await this.bundleMetadata(approved, check)
    const profile = this.owner.get('profileContext')
    if (profile === undefined) unavailable()
    const patches = readProfilePatches('dsh', profile)
    const plan = await prepareProfileSelectionUpdate(this.owner.root, patches, patches, this.input.maxNativeInventoryEntries, 'restart')
    check(); this.assertCurrent()
    const restart = plan.restart
    if (restart === undefined || !isDeepStrictEqual(restart.before, restart.active)) unavailable()
    const declared = [...bundle.rows.map(row => ({ id: restart.entryPrefix + row.rowId, module: row.moduleName })),
      ...bundle.overrides.map(rowId => ({ id: restart.entryPrefix + rowId,
        module: restart.after.find(row => row.id === rowId)?.name }))]
    if (declared.length !== approved.members.length || declared.some(row => !approved.members.some(member =>
      member.entryId === row.id && member.moduleName === row.module))) unavailable()
    const entries = [...this.owner.loader.entries()]
    if (entries.length > this.input.maxNativeInventoryEntries) unavailable()
    const tree = entries.find(entry => entry.id === restart.entryPrefix.slice(0, -1))?.subtree
    if (tree === undefined) unavailable()
    for (const member of approved.members) {
      const metadata = packages.packageOf(member.moduleName, restart.baseUrl, { fresh: true })
      if (metadata?.name !== member.packageName || metadata.version !== member.packageVersion) unavailable()
      const namespace: unknown = await tree.import(member.moduleName)
      check(); this.assertCurrent()
      const expected = restart.after.find(row => restart.entryPrefix + row.id === member.entryId)
      const actual = entries.filter(entry => entry.id === member.entryId), entry = actual[0]
      if (expected === undefined ? actual.length !== 0 : actual.length !== 1 || entry === undefined
        || !isDeepStrictEqual(entry.options, expected) || entry.options.name !== member.moduleName
        || (entry.disabled ? entry.options.disabled !== true || entry.fiber !== undefined && entry.fiber.state !== FiberState.DISPOSED
          : entry.fiber?.state !== FiberState.ACTIVE || entry.moduleNamespace !== namespace
            || entry.fiber.ctx.root !== this.owner.root)) unavailable()
      if (entry?.fiber?.state === FiberState.ACTIVE) for (const impl of Object.values(entry.fiber.store ?? {})) {
        if (impl.fiber.state !== FiberState.ACTIVE || impl.fiber.ctx.root !== this.owner.root) unavailable()
      }
    }
    if (packages.resolution !== resolution || original(this.input.resolvePackages() ?? {}) !== original(packages)) unavailable()
    const value = { id: approved.id, bundle, selectionTarget: approved.control.selectionTarget,
      operations: approved.control.operations, maxImpact: approved.control.maxImpact, configuration: { fields: [] } }
    firstScreenJsonBytes(value, this.limits.maxReplyBytes)
    return { value, revision: this.revision() }
  }

  private async publish(
    approved: ControlledTarget, operation: PluginOperation, revision: string, check: () => void,
  ): Promise<PluginEditCommit<{
    readonly state: Omit<PluginCurrentState, 'version'>
    readonly native?: ChangeResult
  }>> {
    check(); this.assertCurrent()
    if (this.revision() !== revision) return { published: false, error: new CloudApiError('cloud/config-conflict', 'The original plugin profile changed.') }
    this.authorize(approved, operation)
    if ('members' in approved) return { published: false,
      error: new CloudApiError('cloud/config-conflict', 'This bundle selection requires a complete graph rebuild.') }
    const before = await this.observe(approved, check)
    if (operation.kind === 'configure' && !before.value.configuration.fields.some(field =>
      isDeepStrictEqual(field.path, operation.path) && field.writable)) {
      return { published: false, error: new CloudApiError('cloud/forbidden', 'This field requires a native path edit or live Settings.') }
    }
    if (this.revision() !== revision) conflict()
    const entry = this.entry(approved), editor = this.owner.get('configEditor'), manager = this.manager
    if (editor === undefined || manager === undefined) unavailable()
    let native: ChangeResult | undefined
    try {
      await this.scopes.run({ approved, operation, revision, check }, async () => {
        if (operation.kind === 'enabled') {
          const row = (await manager.listPlugins()).find(row => row.entryId === entry.id)
          if (row === undefined) unavailable()
          native = await manager.setPluginEnabled(row.entryId, operation.enabled)
        } else if (operation.kind === 'selected') {
          const selection = approved.control.selectionTarget
          if (selection.kind !== 'bundle') unavailable()
          native = await manager.setBundleEnabled(selection.name, operation.selected)
        } else await editor.edit(entry, (current) => {
          if (before.schema === undefined || !ordinaryConfigPolicy(before.schema, operation.path).writable) unavailable()
          return applyConfigPathOp(entry.options.config == null ? entry.options.config : current,
            { op: 'set', path: operation.path, value: structuredClone(operation.value) }, before.schema)
        }, {
          maxRemountRegistryEntries: this.input.maxNativeInventoryEntries,
          assertCurrent: () => { this.checkedScope() },
          check: (plan) => { this.checkPlan(plan, approved) },
        })
      })
    } catch (error) {
      if (operation.kind === 'configure' && editor.editFailureOutcome(error) === 'not-published') {
        return { published: false, error: new CloudApiError('cloud/config-conflict', 'The native plugin preflight refused this edit; read its current state.') }
      }
      throw new ConfigSaveOutcomeUnknown({ cause: error })
    }
    if (native?.application === 'failed') {
      if (manager.changeFailureOutcome(native) === 'not-published') return { published: false,
        error: new CloudApiError('cloud/config-conflict', 'The native plugin preflight refused this change; read its current state.') }
      throw new ConfigSaveOutcomeUnknown()
    }
    check(); this.assertCurrent()
    await this.owner.loader.await()
    if (operation.kind === 'enabled' && entry.disabled === operation.enabled) throw new ConfigSaveOutcomeUnknown()
    const observed = await this.observe(approved, check)
    if (operation.kind === 'configure' && !observed.value.configuration.fields.some(field =>
      isDeepStrictEqual(field.path, operation.path) && isDeepStrictEqual(field.value, operation.value))) {
      throw new ConfigSaveOutcomeUnknown()
    }
    if (operation.kind === 'selected') {
      const selection = approved.control.selectionTarget
      const selected = selection.kind === 'bundle' && (await manager.listBundles()).find(bundle => bundle.name === selection.name)?.enabled
      if (selected !== operation.selected) throw new ConfigSaveOutcomeUnknown()
    }
    return { published: true, revision: observed.revision, value: { state: observed.value,
      ...native === undefined ? {} : { native } } }
  }
}
