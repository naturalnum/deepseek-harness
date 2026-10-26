import { Context, Fiber, FiberState, Inject, resolveConfig, type Plugin } from '@deepseek-ai/cordis'
import { deepEqual, isNullable, isVolatile, updateVolatile, volatileEntries, type Volatile } from '@deepseek-ai/cosmokit'
import { Loader } from '../index.ts'
import { EntryGroup } from './group.ts'
import { EntryTree } from './tree.ts'
import { evaluate, isJsExpr } from './utils.ts'
import { configSchemaSnapshot, deterministicConfigSchema, equalExceptVolatile } from './diff.ts'

/** Native decision for a single config-only update; non-live stop closures are unproven. */
export interface EntryConfigUpdatePlan {
  /** Native mutation counter of this entry, rather than a profile-wide revision. */
  readonly version: number
  /** Entry that prepared this opaque plan. */
  readonly entry: Entry
  /** Running fiber bound to the plan. */
  readonly fiber: Fiber | undefined
  /** Actual native decision, with unsupported dependencies reported conservatively. */
  readonly impact: 'none' | 'live' | 'remount' | 'unknown'
  /** Empty for proven live/no-op changes; undefined when the stop closure is unproven. */
  readonly stopped: readonly Fiber[] | undefined
}

interface ConfigPlanState {
  coldNamespace?: unknown
  kind?: 'options' | 'passive'
  nextOptions?: EntryOptions
  maximum?: number
  topology?: ReturnType<Entry['_optionsTopology']>
  version: number
  options: EntryOptions
  next: unknown
  before: unknown
  candidate: unknown
  effective: unknown
  parent: object | null
  schema: unknown
  runtime: Fiber['runtime'] | undefined
  moduleNamespace: unknown
}

function configSnapshot(value: unknown): unknown {
  if (isVolatile(value)) return configSnapshot(value.get())
  if (typeof value === 'function' || typeof value === 'symbol') throw new Error('Unproven config dependency')
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(configSnapshot)
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('Unproven config object')
  }
  if ('__jsExpr' in value) throw new Error('Unproven config expression')
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, configSnapshot(child)]))
}

function optionChanges(previous: EntryOptions, next: EntryOptions): string[] {
  const keys = Object.keys({ ...next, ...previous }) as Array<keyof EntryOptions>
  return keys.filter(key => !deepEqual(next[key], previous[key], key === 'config'))
}

/** Serialized plugin entry options stored in loader config files. */
export interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string
  /** Module specifier imported by the entry tree. */
  name: string
  /** Config passed to the plugin. */
  config?: any
  /** Marks this entry as a nested group. */
  group?: boolean | null
  /** Prevents this entry and descendants from running. */
  disabled?: boolean | null
  /** Required services or service intercept config for this entry. */
  inject?: Inject | null
}

function takeEntries(object: {}, keys: string[]) {
  const result: [string, any][] = []
  for (const key of keys) {
    if (!(key in object)) continue
    result.push([key, object[key]])
    delete object[key]
  }
  return result
}

function sortKeys<T extends {}>(object: T, prepend = ['id', 'name'], append = ['config']): T {
  const part1 = takeEntries(object, prepend)
  const part2 = takeEntries(object, append)
  const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b))
  return Object.assign(object, Object.fromEntries([...part1, ...rest, ...part2]))
}

/** One configured plugin node inside an `EntryTree`. */
export class Entry {
  static readonly key = Symbol.for('cordis.entry')

  public ctx: Context
  public fiber?: Fiber
  /** Raw import result before export normalization; HMR updates it after a successful reload. */
  public moduleNamespace: unknown
  public parent!: EntryGroup
  // safety: call `entry.update()` immediately after creating an entry
  public options = {} as EntryOptions
  public subgroup?: EntryGroup
  public subtree?: EntryTree

  _initTask?: Promise<void>
  private configVersion = 0
  private readonly configPlans = new WeakMap<EntryConfigUpdatePlan, ConfigPlanState>()
  private optionsDisposal: Fiber | undefined

  /** Identify the exact disposal already owned by a prepared native update.
   * @param fiber Actual disposing fiber from the registry event.
   * @returns Whether its options/persistence are already controlled by this guarded update.
   */
  ownsPreparedDisposal(fiber: Fiber): boolean {
    return this.optionsDisposal === fiber && this.loader.updateGuard !== undefined
  }

  constructor(public loader: Loader) {
    this.ctx = loader.ctx.extend({ [Entry.key]: this })
    this.context.emit('loader/entry-init', this)
  }

  get context(): Context {
    return this.ctx
  }

  get id() {
    let id = this.options.id
    if (this.parent.tree.ctx.fiber.entry) {
      id = this.parent.tree.ctx.fiber.entry.id + EntryTree.sep + id
    }
    return id
  }

  /** True when this entry or any owning parent entry is disabled. */
  get disabled() {
    // group is always enabled
    if (this.options.group) return false
    let entry: Entry | undefined = this
    do {
      if (this.disabledOf(entry.options)) return true
      entry = entry.parent.ctx.fiber.entry
    } while (entry)
    return false
  }

  /**
   * Effective disabled state: a `!!js` expression evaluates against the loader
   * context. The raw node stays in the options, so write-back keeps the form.
   */
  private disabledOf(options: EntryOptions): boolean {
    return isJsExpr(options.disabled)
      ? Boolean(this.evaluate(options.disabled.__jsExpr))
      : Boolean(options.disabled)
  }

  evaluate(expr: string) {
    return evaluate(this.ctx, expr)
  }

  private _patchContext(diff: string[]) {
    this.context.waterfall('loader/patch-context', this, () => {
      Object.setPrototypeOf(this.ctx, this.parent.ctx)

      if (this.fiber?.uid && (diff.includes('config') || this.options.group)) {
        this.fiber.update(this.options.config, true)
      }
    })
  }

  async refresh() {
    if (this.fiber) return
    if (this.disabled) return
    await this.init()
  }

  /**
   * Merge options through the native lifecycle, or commit the active guard's exact live plan.
   * @param options - partial options, or the complete replacement row when create is true.
   * @param create - whether to replace rather than merge the row.
   * @param force - whether an unguarded unchanged row still patches its context.
   * @returns Completion of the native update; guard failures reject before options change.
   */
  async update(options: Partial<EntryOptions>, create = false, force = false) {
    const planned = this.loader.updateGuard?.entry(this, options, create, force)
    if (planned !== undefined) {
      this.assertConfigUpdatePlan(planned)
      const state = this.configPlans.get(planned)!
      const proposed = create ? options : { ...this.options, ...options }
      if (!deepEqual(proposed, state.nextOptions ?? { ...state.options, config: state.next }, true)) {
        throw new Error('Loader config commit differs from its prepared options')
      }
      this.configPlans.delete(planned)
      if (state.kind === 'options' && planned.impact === 'remount') {
        this.configVersion++
        this.optionsDisposal = this.fiber
        try { await this.fiber?.dispose() } finally { this.optionsDisposal = undefined }
        this.options = proposed as EntryOptions
        sortKeys(this.options)
        if (this.disabled) return
        this.fiber = undefined
        await this.init()
        const active = (this as Entry).fiber
        await active?.await()
        if (active?.state !== FiberState.ACTIVE || this.moduleNamespace !== (state.coldNamespace ?? state.moduleNamespace)
          || !deepEqual(configSnapshot(active.config), state.effective, true)) {
          throw new Error('Loader plugin update did not activate its prepared module and config')
        }
        return
      }
      // A checked no-op consumes only this plan; unchanged rows retain other native audit plans.
      if (planned.impact === 'live') this.configVersion++
      if (create) this.options = options as EntryOptions
      else this.options.config = options.config
      sortKeys(this.options)
      if (planned.impact === 'live') {
        this.fiber!._config = this.options.config
        this._applyVolatile(this.fiber!, state.candidate)
      }
      return
    }
    this.configVersion++
    const legacy = { ...this.options }

    // step 1: update options
    if (create) {
      this.options = options as EntryOptions
    } else {
      for (const [key, value] of Object.entries(options)) {
        if (isNullable(value)) {
          delete this.options[key]
        } else {
          this.options[key] = value
        }
      }
    }
    sortKeys(this.options)

    // step 2: execute
    if (this.disabled) {
      this.fiber?.dispose()
      return
    }

    // step 3: check if options are changed
    if (this.fiber?.uid) {
      const changes = optionChanges(legacy, this.options)
      // Only an active fiber in an unchanged context takes volatile-only config changes without a remount.
      const volatileOnly = this._volatileOnly(changes, legacy, this.options)
      if (volatileOnly) this.fiber._config = this.options.config
      const pending = volatileOnly && this._commitVolatile() ? [] : changes
      if (!pending.length && !force) return
      this.context.emit('loader/partial-dispose', this, legacy, true)
      this._patchContext(pending)
    } else {
      await this.init()
    }
  }

  /**
   * Reject unproven schema/resolver dependencies before any candidate parser runs.
   * @throws If this entry cannot use the deterministic config-only planning subset.
   */
  assertConfigUpdateSupported(): void {
    const fiber = this.fiber
    if (!fiber || !deterministicConfigSchema(fiber.runtime?.Config)
      || fiber.ctx.events.dispatch('waterfall', [fiber, 'internal/config', undefined, () => undefined]).length !== 1) {
      throw new Error('Loader config dependencies are unproven')
    }
    configSnapshot(this.options.config)
  }

  /**
   * Prepare the native config-only decision without updating options or references.
   * Only a deterministic schema and the sole native config resolver can prove live.
   * @param next - proposed complete raw plugin config.
   * @returns Opaque identity/version-bound plan; unknown/remount plans cannot commit as live.
   */
  prepareConfigUpdate(next: unknown): EntryConfigUpdatePlan {
    const fiber = this.fiber
    let impact: EntryConfigUpdatePlan['impact'] = 'unknown'
    let state: ConfigPlanState | undefined
    try {
      const options = structuredClone(this.options)
      const proposed = { ...this.options, config: next }
      const changes = optionChanges(this.options, proposed)
      const detachedNext = configSnapshot(next)
      if (changes.length === 0 && this.options.disabled === true && !this.subgroup && !this.subtree) {
        const plan: EntryConfigUpdatePlan = Object.freeze({ entry: this, fiber, version: this.configVersion,
          impact: 'none', stopped: Object.freeze([]) })
        this.configPlans.set(plan, { kind: 'passive', version: this.configVersion, options, next: detachedNext,
          before: undefined, candidate: undefined, effective: undefined, parent: Object.getPrototypeOf(this.ctx),
          schema: undefined, runtime: fiber?.runtime, moduleNamespace: this.moduleNamespace })
        return plan
      }
      if (!fiber?.uid || fiber.state !== FiberState.ACTIVE || this.disabled
        || Object.getPrototypeOf(this.ctx) !== this.parent.ctx || this.subgroup || this.subtree) throw new Error('Unproven entry state')
      const before = configSnapshot(fiber.config)
      let candidate: unknown = fiber.config
      if (changes.length === 0) impact = 'none'
      else {
        this.assertConfigUpdateSupported()
        if (!this._volatileOnly(changes, this.options, proposed)) impact = 'remount'
        else {
          candidate = this._resolveVolatile(fiber, next)
          impact = this._sameOrdinary(fiber, candidate) ? 'live' : 'remount'
        }
      }
      state = {
        version: this.configVersion, options, next: detachedNext, before, candidate,
        effective: configSnapshot(candidate), parent: Object.getPrototypeOf(this.ctx),
        schema: configSchemaSnapshot(fiber.runtime?.Config),
        runtime: fiber.runtime, moduleNamespace: this.moduleNamespace,
      }
    } catch (error) {
      // An unproven snapshot, resolver or schema never grants a live update.
      void error
      impact = 'unknown'
    }
    const plan: EntryConfigUpdatePlan = Object.freeze({
      entry: this, fiber, version: this.configVersion, impact,
      stopped: impact === 'live' || impact === 'none' ? Object.freeze([]) : undefined,
    })
    if (state !== undefined) this.configPlans.set(plan, state)
    return plan
  }

  /**
   * Recheck a prepared live/no-op decision against current identity, options and effective values.
   * @param plan - unconsumed plan prepared by this entry.
   * @throws If the plan is unsupported, stale, consumed or its effective decision drifted.
   */
  assertConfigUpdatePlan(plan: EntryConfigUpdatePlan): void {
    const state = this.configPlans.get(plan)
    if (state === undefined || (plan.impact !== 'live' && plan.impact !== 'none'
      && !(state.kind === 'options' && plan.impact === 'remount'))) throw new Error('Loader config impact is unproven')
    if (state.version !== this.configVersion || plan.fiber !== this.fiber || state.parent !== Object.getPrototypeOf(this.ctx)
      || state.runtime !== this.fiber?.runtime || state.moduleNamespace !== this.moduleNamespace
      || !deepEqual(state.options, this.options, true)
      || (state.kind !== 'passive' && !deepEqual(state.before, configSnapshot(this.fiber?.config), true))) {
      throw new Error('Loader config plan is stale')
    }
    const fresh = state.kind === 'options' ? state.coldNamespace === undefined
      ? this.prepareOptionsUpdate(state.nextOptions!, state.maximum!)
      : this.prepareColdOptionsUpdate(state.nextOptions!, state.maximum!, state.coldNamespace)
      : this.prepareConfigUpdate(state.next)
    const checked = this.configPlans.get(fresh)
    if (fresh.impact !== plan.impact || checked === undefined || !deepEqual(state.effective, checked.effective, true)
      || !deepEqual(state.schema, checked.schema, true) || !deepEqual(plan.stopped, fresh.stopped, true)) {
      throw new Error('Loader config plan effective values drifted')
    }
    if (state.topology !== undefined) {
      const current = this._optionsTopology(state.maximum!)
      if (current.length !== state.topology.length || current.some((row, index) => {
        const prior = state.topology![index]!
        return row.fiber !== prior.fiber || row.parent !== prior.parent || row.runtime !== prior.runtime
          || row.state !== prior.state || row.uid !== prior.uid || row.dependencies.length !== prior.dependencies.length
          || row.dependencies.some((impl, i) => impl !== prior.dependencies[i])
      })) throw new Error('Loader plugin dependency graph is stale')
    }
  }

  /** Snapshot the actual registry and reject a leaf whose stop could affect another fiber.
   * @param maximum Explicit registry visit bound.
   * @returns Original fiber/dependency identities; no caller-supplied stop list is trusted.
   */
  _optionsTopology(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Loader plugin plan requires a finite registry bound')
    const rows: { fiber: Fiber; parent: Fiber; runtime: Fiber['runtime']; state: FiberState;
      uid: Fiber['uid']; dependencies: unknown[] }[] = []
    let visited = 0
    for (const runtime of this.ctx.registry.values()) {
      if (++visited > maximum) throw new Error('Loader plugin registry exceeds its plan bound')
      for (const fiber of runtime.fibers) {
        if (++visited > maximum) throw new Error('Loader plugin registry exceeds its plan bound')
        const dependencies = Object.values(fiber.store ?? {})
        if (fiber !== this.fiber) {
          if (dependencies.some(impl => impl.fiber === this.fiber)) throw new Error('Loader plugin has a dependent service consumer')
          let parent = fiber.parent.fiber
          for (let i = 0; parent !== parent.parent.fiber; i++) {
            if (i >= maximum || parent === this.fiber) throw new Error('Loader plugin has an unproven child stop closure')
            parent = parent.parent.fiber
          }
        }
        rows.push({ fiber, parent: fiber.parent.fiber, runtime: fiber.runtime, state: fiber.state, uid: fiber.uid, dependencies })
      }
    }
    return rows
  }

  /** Prepare a config/enablement change for one already-loaded native leaf module.
   * Other options, descendants, service dependents, unresolved schemas and never-loaded disabled modules reject.
   * @param next Complete proposed row from the native Include composer.
   * @param maximum Explicit bound for the complete original registry snapshot.
   * @returns An opaque native plan with an exact stop list, or an unknown decision.
   */
  prepareOptionsUpdate(next: EntryOptions, maximum: number): EntryConfigUpdatePlan {
    const fiber = this.fiber
    let state: ConfigPlanState | undefined
    let impact: EntryConfigUpdatePlan['impact'] = 'unknown'
    let stopped: readonly Fiber[] | undefined
    try {
      if (!fiber || !this.moduleNamespace || this.subgroup || this.subtree
        || Object.getPrototypeOf(this.ctx) !== this.parent.ctx
        || ![FiberState.ACTIVE, FiberState.DISPOSED].includes(fiber.state)
        || (this.options.disabled !== undefined && typeof this.options.disabled !== 'boolean')
        || (next.disabled !== undefined && typeof next.disabled !== 'boolean')
        || !deepEqual({ ...this.options, config: undefined, disabled: undefined },
          { ...next, config: undefined, disabled: undefined }, true)) throw new Error('Unproven plugin options')
      this.assertConfigUpdateSupported()
      const topology = this._optionsTopology(maximum)
      const candidate = this._resolveVolatile(fiber, next.config)
      const unchanged = optionChanges(this.options, next).length === 0
      impact = unchanged ? 'none' : 'remount'
      stopped = Object.freeze(!unchanged && fiber.state === FiberState.ACTIVE ? [fiber] : [])
      state = { kind: 'options', version: this.configVersion, options: structuredClone(this.options),
        next: configSnapshot(next.config), nextOptions: structuredClone(next), before: configSnapshot(fiber.config),
        candidate, effective: configSnapshot(candidate), parent: Object.getPrototypeOf(this.ctx),
        schema: configSchemaSnapshot(fiber.runtime?.Config), runtime: fiber.runtime, moduleNamespace: this.moduleNamespace,
        maximum, topology }
    } catch (error) { void error }
    const plan: EntryConfigUpdatePlan = Object.freeze({ entry: this, fiber, version: this.configVersion, impact, stopped })
    if (state !== undefined) this.configPlans.set(plan, state)
    return plan
  }

  /** Load only the original entry's preinstalled code for a never-active disabled leaf, without creating a fiber.
   * @param next Native composed row; package names and all structural options remain unchanged.
   * @param maximum Explicit original registry visit bound.
   * @returns Native plan after the original importer settles; caller rechecks its request/window before persistence.
   */
  async prepareModuleOptionsUpdate(next: EntryOptions, maximum: number): Promise<EntryConfigUpdatePlan> {
    if (this.fiber !== undefined || this.moduleNamespace !== undefined) return this.prepareOptionsUpdate(next, maximum)
    const namespace: unknown = await this.parent.tree.import(this.options.name)
    return this.prepareColdOptionsUpdate(next, maximum, namespace)
  }

  private prepareColdOptionsUpdate(next: EntryOptions, maximum: number, namespace: unknown): EntryConfigUpdatePlan {
    let impact: EntryConfigUpdatePlan['impact'] = 'unknown'
    let state: ConfigPlanState | undefined
    let stopped: readonly Fiber[] | undefined
    const numericRaw = (value: unknown): boolean => value === undefined || value === null || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value) || Array.isArray(value) && value.every(numericRaw)
      || typeof value === 'object' && !Array.isArray(value) && value !== null
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
        && Object.values(value).every(numericRaw)
    try {
      if (this.fiber !== undefined || this.moduleNamespace !== undefined || this.options.disabled !== true
        || this.options.inject != null || this.subgroup || this.subtree || Object.getPrototypeOf(this.ctx) !== this.parent.ctx
        || (next.disabled !== undefined && typeof next.disabled !== 'boolean')
        || !deepEqual({ ...this.options, config: undefined, disabled: undefined }, { ...next, config: undefined, disabled: undefined }, true)
        || !numericRaw(next.config)) throw new Error('Unproven cold plugin options')
      const plugin: Plugin = this.loader.unwrapExports(namespace)
      if (this.ctx.registry.resolve(plugin) === undefined || plugin.provide != null
        || Object.keys(Inject.resolve(plugin.inject)).length !== 0 || !deterministicConfigSchema(plugin.Config)
        || this.ctx.events.dispatch('waterfall', [this.ctx.fiber, 'internal/config', undefined, () => undefined]).length !== 1) {
        throw new Error('Unproven cold plugin dependencies or config resolver')
      }
      const topology = this._optionsTopology(maximum), candidate = resolveConfig(plugin, next.config)
      impact = optionChanges(this.options, next).length === 0 ? 'none' : 'remount'
      stopped = Object.freeze([])
      state = { kind: 'options', coldNamespace: namespace, version: this.configVersion, options: structuredClone(this.options),
        next: configSnapshot(next.config), nextOptions: structuredClone(next), before: undefined, candidate,
        effective: configSnapshot(candidate), parent: Object.getPrototypeOf(this.ctx), schema: configSchemaSnapshot(plugin.Config),
        runtime: undefined, moduleNamespace: undefined, maximum, topology }
    } catch (error) { void error }
    const plan: EntryConfigUpdatePlan = Object.freeze({ entry: this, fiber: undefined, version: this.configVersion, impact, stopped })
    if (state !== undefined) this.configPlans.set(plan, state)
    return plan
  }

  private _volatileOnly(changes: string[], previous: EntryOptions, next: EntryOptions): boolean {
    return changes.length === 1 && changes[0] === 'config' && this.fiber?.state === FiberState.ACTIVE
      && Object.getPrototypeOf(this.ctx) === this.parent.ctx && equalExceptVolatile(previous.config, next.config, this.fiber.runtime?.Config)
  }

  private _resolveVolatile(fiber: Fiber, raw: unknown): unknown {
    return resolveConfig(fiber.runtime!, fiber.ctx.waterfall(fiber, 'internal/config', raw, () => raw))
  }

  private _sameOrdinary(fiber: Fiber, candidate: unknown): boolean {
    return deepEqual(fiber.config, candidate, true)
  }

  /**
   * Parse a volatile-only raw config change and commit its values into the running fiber's references.
   * An invalid candidate is logged and leaves the running references unchanged; the raw config stays retained for the next activation.
   * @returns `false` when an ordinary effective value changed, so the caller applies the ordinary update lifecycle.
   */
  private _commitVolatile(): boolean {
    const fiber = this.fiber!
    const refs = volatileEntries(fiber.config)
    if (!refs.length) return true
    const raw = this.options.config
    let candidate: unknown
    try {
      candidate = this._resolveVolatile(fiber, raw)
    } catch (error) {
      this.ctx.logger.warn('volatile config update failed for %C', this.options.id)
      this.ctx.logger.warn(error)
      return true
    }
    if (!this._sameOrdinary(fiber, candidate)) {
      this.ctx.logger.debug('ordinary config values of %C changed with its volatile values; applying the ordinary update', this.options.id)
      return false
    }
    this._applyVolatile(fiber, candidate, refs)
    return true
  }

  private _applyVolatile(fiber: Fiber, candidate: unknown, refs = volatileEntries(fiber.config)): void {
    const paths = refs.flatMap(({ path, ref }) => {
      const source = path.reduce<unknown>((value, key) => Reflect.get(value as object, key), candidate) as Volatile<unknown>
      if (deepEqual(ref.get(), source.get(), true)) return []
      updateVolatile(ref, source)
      return [path]
    })
    if (!paths.length) return
    const self: Context = Object.create(fiber.ctx)
    self[Context.filter] = (owner: Context) => owner.fiber === fiber
    try {
      fiber.ctx.emit(self, 'loader/volatile-update', paths)
    } catch (error) {
      // A listener failure must not fail the entry update; every value is already committed.
      this.ctx.logger.warn(error)
    }
  }

  getOuterStack = () => {
    let entry: Entry | undefined = this
    const result: string[] = []
    do {
      result.push(`    at ${entry.parent.tree.ctx.baseUrl}#${entry.options.id}`)
      entry = entry.parent.ctx.fiber.entry
    } while (entry)
    return result
  }

  /** Import and start the configured plugin if it is not already running. */
  async init() {
    try {
      await (this._initTask ??= this._init())
    } finally {
      this._initTask = undefined
    }
    const notify = () => {
      if (this.loader.getTasks().length) return
      this.ctx.reflect.notify(['loader'])
    }
    this.fiber?.await().then(notify, notify)
  }

  private async _init() {
    let moduleNamespace: unknown
    try {
      moduleNamespace = await this.parent.tree.import(this.options.name, this.getOuterStack)
    } catch (error) {
      this.ctx.logger.error(error)
      return
    } finally {
      this._initTask = undefined
    }
    const plugin = this.loader.unwrapExports(moduleNamespace)
    this._patchContext([])
    this.loader.showLog(this, 'apply')
    this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack).ctx.fiber
    this.moduleNamespace = moduleNamespace
  }
}
