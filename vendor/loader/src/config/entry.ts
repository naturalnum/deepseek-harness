import { Context, Fiber, FiberState, Inject, resolveConfig } from '@deepseek-ai/cordis'
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
  version: number
  options: EntryOptions
  next: unknown
  before: unknown
  candidate: unknown
  effective: unknown
  parent: object | null
  schema: unknown
  runtime: Fiber['runtime']
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
      if (!deepEqual(proposed, { ...state.options, config: state.next }, true)) {
        throw new Error('Loader config commit differs from its prepared options')
      }
      this.configPlans.delete(planned)
      this.configVersion++
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
    if (state === undefined || (plan.impact !== 'live' && plan.impact !== 'none')) throw new Error('Loader config impact is unproven')
    if (state.version !== this.configVersion || plan.fiber !== this.fiber || state.parent !== Object.getPrototypeOf(this.ctx)
      || state.runtime !== this.fiber?.runtime || state.moduleNamespace !== this.moduleNamespace
      || !deepEqual(state.options, this.options, true) || !deepEqual(state.before, configSnapshot(this.fiber!.config), true)) {
      throw new Error('Loader config plan is stale')
    }
    const fresh = this.prepareConfigUpdate(state.next)
    const checked = this.configPlans.get(fresh)
    if (fresh.impact !== plan.impact || checked === undefined || !deepEqual(state.effective, checked.effective, true)
      || !deepEqual(state.schema, checked.schema, true) || !deepEqual(plan.stopped, fresh.stopped, true)) {
      throw new Error('Loader config plan effective values drifted')
    }
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
